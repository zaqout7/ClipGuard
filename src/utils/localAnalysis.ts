import type { AnalysisOptions, AnalysisProgress, DetectionEvent } from '../types';
import { formatSecondsToTimestamp, getCategoryLabel, mergeDetections } from './formatters';

const MODEL_PATH = 'models/adamcodd-nsfw/';
const FRAME_TIMEOUT_MS = 15000;

interface WorkerResponse {
  type: 'ready' | 'result' | 'error';
  requestId?: number;
  provider?: string;
  score?: number;
  error?: string;
}

interface AnalyzeLocalVideoArgs {
  file: File;
  sourceId: string;
  options: AnalysisOptions;
  signal: AbortSignal;
  onProgress: (progress: AnalysisProgress) => void;
}

export interface LocalAnalysisResult {
  detections: DetectionEvent[];
  durationSeconds: number;
  sampledFrames: number;
  provider: string;
  usedSeekTimeFallback: boolean;
}

export async function analyzeLocalVideo({
  file,
  sourceId,
  options,
  signal,
  onProgress,
}: AnalyzeLocalVideoArgs): Promise<LocalAnalysisResult> {
  validateAnalysisOptions(options);
  throwIfAborted(signal);

  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(file.name)) {
    throw new Error('Select a video file with a supported browser video decoder.');
  }

  onProgress({
    phase: 'loading_model',
    statusText: 'Loading the local NSFW image classifier',
    details: 'Model execution remains in this browser; video and frames are not uploaded.',
    progressPercent: null,
  });

  const worker = new Worker(new URL('../workers/classifier.worker.ts', import.meta.url), {
    type: 'module',
    name: 'clipguard-local-classifier',
  });
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;

  let readyListener: ((event: MessageEvent<WorkerResponse>) => void) | undefined;
  const terminate = () => {
    worker.terminate();
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  };
  const onAbort = () => terminate();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
    const modelBase = new URL(MODEL_PATH, baseUrl);
    worker.postMessage({
      type: 'init',
      modelUrl: new URL('model_quantized.onnx', modelBase).toString(),
      configUrl: new URL('config.json', modelBase).toString(),
      wasmUrl: new URL('models/onnxruntime/ort-wasm-simd-threaded.wasm', baseUrl).toString(),
      wasmMjsUrl: new URL('models/onnxruntime/ort-wasm-simd-threaded.mjs', baseUrl).toString(),
    });
    const ready = await waitForWorker(worker, signal, (listener) => {
      readyListener = listener;
    });
    const provider = ready.provider ?? 'ONNX Runtime WebAssembly CPU (single thread)';

    onProgress({
      phase: 'preparing_video',
      statusText: 'Opening the selected local video',
      details: 'Sampling uses browser-decoded frame presentation times and browser canvas resizing; interpolation may vary by browser.',
      progressPercent: null,
    });
    const durationSeconds = await loadVideoMetadata(video, signal);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error('The selected video has no valid duration or could not be decoded.');
    }

    const interval = options.sampleIntervalSec;
    const sampleCount = Math.ceil(durationSeconds / interval);
    if (!Number.isSafeInteger(sampleCount) || sampleCount > 250000) {
      throw new Error('This video and sampling interval exceed the 250,000-frame safety limit. Increase the interval or use a shorter video.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 384;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to create the local frame-processing canvas.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'medium';

    const candidateFrames: DetectionEvent[] = [];
    let resultId = 0;
    let lastProgressAt = 0;
    let usedSeekTimeFallback = false;
    for (let index = 0; index < sampleCount; index += 1) {
      throwIfAborted(signal);
      const targetSeconds = index * interval;
      if (targetSeconds >= durationSeconds) break;
      const frame = await capturePresentedFrame(video, context, targetSeconds, signal);
      usedSeekTimeFallback ||= frame.timestampSource === 'seek-time fallback';
      throwIfAborted(signal);
      const score = await classifyFrame(worker, frame.pixels, index + 1, signal);
      throwIfAborted(signal);

      if (options.categories.nsfw_image_classification && score >= options.sensitivity / 100) {
        candidateFrames.push({
          id: `${sourceId}-${resultId++}`,
          startSeconds: frame.presentationSeconds,
          endSeconds: frame.presentationSeconds,
          startTimestamp: formatSecondsToTimestamp(frame.presentationSeconds),
          endTimestamp: formatSecondsToTimestamp(frame.presentationSeconds),
          category: 'nsfw_image_classification',
          categoryLabel: getCategoryLabel('nsfw_image_classification'),
          modelScore: score,
          scoreSemantics: 'Softmax score for the model’s broad NSFW image class; not a calibrated probability.',
          explanation: 'The whole sampled frame received a score above the selected threshold. This is a potential match requiring human review, not a definitive content judgment.',
          visualEvidence: '',
          reviewStatus: 'needs_review',
          editorNotes: '',
        });
      }

      const now = performance.now();
      if (now - lastProgressAt >= 125 || index + 1 === sampleCount) {
        lastProgressAt = now;
        onProgress({
          phase: 'sampling_frames',
          statusText: `Analyzed ${index + 1} of ${sampleCount} sampled frames`,
          details: `Latest ${frame.timestampSource} ${frame.presentationSeconds.toFixed(3)}s; ${candidateFrames.length} potential matches so far. Sparse sampling can miss brief content.`,
          progressPercent: Math.floor(((index + 1) / sampleCount) * 100),
          processedFrames: index + 1,
          totalFrames: sampleCount,
          currentCandidateCount: candidateFrames.length,
        });
      }
    }

    throwIfAborted(signal);
    const detections = mergeDetections(
      candidateFrames,
      options.mergeToleranceSec,
      options.bufferSec,
      durationSeconds
    );
    return {
      detections,
      durationSeconds,
      sampledFrames: sampleCount,
      provider,
      usedSeekTimeFallback,
    };
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (readyListener) worker.removeEventListener('message', readyListener);
    terminate();
  }
}

function validateAnalysisOptions(options: AnalysisOptions): void {
  const requireRange = (label: string, value: number, minimum: number, maximum: number) => {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`);
    }
  };
  requireRange('NSFW score threshold', options.sensitivity, 0, 100);
  requireRange('Frame sampling interval in seconds', options.sampleIntervalSec, 0.5, 30);
  requireRange('Segment merge tolerance in seconds', options.mergeToleranceSec, 0, 60);
  requireRange('Segment padding in seconds', options.bufferSec, 0, 10);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Analysis cancelled.', 'AbortError');
}

function waitForWorker(
  worker: Worker,
  signal: AbortSignal,
  captureListener: (listener: (event: MessageEvent<WorkerResponse>) => void) => void
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error('Timed out while loading the local model.')),
      120000
    );
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      signal.removeEventListener('abort', handleAbort);
    };
    const finish = (error?: Error, response?: WorkerResponse) => {
      cleanup();
      if (error) reject(error);
      else resolve(response!);
    };
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'ready') finish(undefined, event.data);
      else if (event.data.type === 'error') finish(new Error(event.data.error || 'Local model initialization failed.'));
    };
    const handleError = (event: ErrorEvent) => finish(new Error(event.message || 'The local model worker stopped unexpectedly.'));
    const handleAbort = () => finish(new DOMException('Analysis cancelled.', 'AbortError'));
    captureListener(handleMessage);
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function loadVideoMetadata(video: HTMLVideoElement, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('Timed out while opening the selected video.')), FRAME_TIMEOUT_MS);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', handleMetadata);
      video.removeEventListener('error', handleError);
      signal.removeEventListener('abort', handleAbort);
    };
    const finish = (error?: Error, duration?: number) => {
      cleanup();
      if (error) reject(error);
      else resolve(duration!);
    };
    const handleMetadata = () => finish(undefined, video.duration);
    const handleError = () => finish(new Error('The browser could not decode this video file.'));
    const handleAbort = () => finish(new DOMException('Analysis cancelled.', 'AbortError'));
    video.addEventListener('loadedmetadata', handleMetadata, { once: true });
    video.addEventListener('error', handleError, { once: true });
    signal.addEventListener('abort', handleAbort, { once: true });
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) handleMetadata();
  });
}

interface CapturedFrame {
  pixels: Uint8ClampedArray;
  presentationSeconds: number;
  timestampSource: 'decoded-frame mediaTime' | 'seek-time fallback';
}

function capturePresentedFrame(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  targetSeconds: number,
  signal: AbortSignal
): Promise<CapturedFrame> {
  return new Promise((resolve, reject) => {
    let fallbackTimeout: number | undefined;
    let frameCallbackId: number | undefined;
    const cleanup = () => {
      window.clearTimeout(timeout);
      if (fallbackTimeout !== undefined) window.clearTimeout(fallbackTimeout);
      video.removeEventListener('seeked', handleSeeked);
      video.removeEventListener('loadeddata', handleLoadedData);
      video.removeEventListener('error', handleError);
      signal.removeEventListener('abort', handleAbort);
      if (frameCallbackId !== undefined && video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(frameCallbackId);
      }
    };
    const finish = (error?: Error, frame?: CapturedFrame) => {
      cleanup();
      if (error) reject(error);
      else resolve(frame!);
    };
    const timeout = window.setTimeout(
      () => finish(new Error(`Timed out while decoding a frame near ${targetSeconds.toFixed(3)}s.`)),
      FRAME_TIMEOUT_MS
    );
    const drawAt = (presentationSeconds: number, timestampSource: CapturedFrame['timestampSource']) => {
      context.drawImage(video, 0, 0, 384, 384);
      finish(undefined, {
        pixels: context.getImageData(0, 0, 384, 384).data,
        presentationSeconds,
        timestampSource,
      });
    };
    const handleSeeked = () => {
      if (video.requestVideoFrameCallback) {
        frameCallbackId = video.requestVideoFrameCallback((_now, metadata) => {
          drawAt(metadata.mediaTime, 'decoded-frame mediaTime');
        });
        fallbackTimeout = window.setTimeout(
          () => drawAt(video.currentTime, 'seek-time fallback'),
          250
        );
      } else {
        drawAt(video.currentTime, 'seek-time fallback');
      }
    };
    const handleLoadedData = () => handleSeeked();
    const handleError = () => finish(new Error('Video decoding failed while seeking to a sampled frame.'));
    const handleAbort = () => finish(new DOMException('Analysis cancelled.', 'AbortError'));
    const sameTimestamp = Math.abs(video.currentTime - targetSeconds) < 0.001;
    if (sameTimestamp && video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      video.addEventListener('loadeddata', handleLoadedData, { once: true });
    } else if (!sameTimestamp) {
      video.addEventListener('seeked', handleSeeked, { once: true });
    }
    video.addEventListener('error', handleError, { once: true });
    signal.addEventListener('abort', handleAbort, { once: true });
    if (sameTimestamp && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      drawAt(video.currentTime, 'seek-time fallback');
    } else if (!sameTimestamp) {
      video.currentTime = targetSeconds;
    }
  });
}

function classifyFrame(
  worker: Worker,
  pixels: Uint8ClampedArray,
  requestId: number,
  signal: AbortSignal
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('Local model inference timed out.')), 30000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      signal.removeEventListener('abort', handleAbort);
    };
    const finish = (error?: Error, score?: number) => {
      cleanup();
      if (error) reject(error);
      else resolve(score!);
    };
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.requestId !== requestId) return;
      if (event.data.type === 'result' && typeof event.data.score === 'number' && Number.isFinite(event.data.score)) {
        finish(undefined, event.data.score);
      } else if (event.data.type === 'error') {
        finish(new Error(event.data.error || 'Local model inference failed.'));
      }
    };
    const handleError = (event: ErrorEvent) => finish(new Error(event.message || 'The local model worker stopped unexpectedly.'));
    const handleAbort = () => finish(new DOMException('Analysis cancelled.', 'AbortError'));
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    signal.addEventListener('abort', handleAbort, { once: true });
    worker.postMessage({ type: 'classify', requestId, pixels }, [pixels.buffer]);
  });
}
