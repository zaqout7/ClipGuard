import type { AnalysisOptions, AnalysisProgress, DetectionEvent } from '../types';
import { formatSecondsToTimestamp, getCategoryLabel, mergeDetections } from './formatters';
import {
  nudenetClassToCategory,
  buildDetectionExplanation,
  buildVisualEvidence,
  buildScoreSemantics,
  computeLetterboxDimensions,
  type NudeNetDetection,
} from './nudenetMapping';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const NUDENET_MODEL_PATH = 'models/nudenet/320n.onnx';
const VIT_MODEL_PATH = 'models/adamcodd-nsfw/';
const FRAME_TIMEOUT_MS = 15000;

// NudeNet expects 320×320; ViT expects 384×384.
// We always draw at 320×320 so NudeNet can run without extra resize.
// The worker is told the actual dimensions so it can validate.
const NUDENET_CANVAS_SIZE = 320;
const VIT_CANVAS_SIZE = 384;

// ---------------------------------------------------------------------------
// Worker message types (must mirror classifier.worker.ts)
// ---------------------------------------------------------------------------

interface DetectedRegion {
  className: string;
  score: number;
  box?: [number, number, number, number];
}

interface WorkerResponse {
  type: 'ready' | 'result' | 'error';
  requestId?: number;
  provider?: string;
  detectorBackend?: 'nudenet' | 'vit';
  fallbackWarning?: string;
  detections?: DetectedRegion[];
  score?: number;
  error?: string;
  diagnostic?: {
    rawTopPredictions: Array<{ className: string; score: number }>;
  };
}

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

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
  detectorBackend: 'nudenet' | 'vit';
  fallbackWarning?: string;
  usedSeekTimeFallback: boolean;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

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
    statusText: 'Loading the local anatomical content detector',
    details: 'Model execution remains entirely in this browser; video and frames are never uploaded.',
    progressPercent: null,
  });

  // -------------------------------------------------------------------------
  // Worker setup
  // -------------------------------------------------------------------------
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
    // -----------------------------------------------------------------------
    // Build model URLs and send init message
    // -----------------------------------------------------------------------
    const baseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
    const nudenetModelUrl = new URL(NUDENET_MODEL_PATH, baseUrl).toString();
    const vitModelUrl = new URL(`${VIT_MODEL_PATH}model_quantized.onnx`, baseUrl).toString();
    const vitConfigUrl = new URL(`${VIT_MODEL_PATH}config.json`, baseUrl).toString();

    worker.postMessage({
      type: 'init',
      nudenetModelUrl,
      vitModelUrl,
      vitConfigUrl,
      wasmUrl: new URL('models/onnxruntime/ort-wasm-simd-threaded.wasm', baseUrl).toString(),
      wasmMjsUrl: new URL('models/onnxruntime/ort-wasm-simd-threaded.mjs', baseUrl).toString(),
    });

    const ready = await waitForWorker(worker, signal, (listener) => {
      readyListener = listener;
    });

    const provider = ready.provider ?? 'ONNX Runtime WebAssembly CPU';
    const detectorBackend = ready.detectorBackend ?? 'vit';
    const fallbackWarning = ready.fallbackWarning;
    const canvasSize = detectorBackend === 'nudenet' ? NUDENET_CANVAS_SIZE : VIT_CANVAS_SIZE;

    if (detectorBackend === 'vit') {
      const details = fallbackWarning
        ? `[EXPLICIT FALLBACK]: ${fallbackWarning} Using: ${provider}`
        : `Using fallback: ${provider}`;
      onProgress({
        phase: 'loading_model',
        statusText: 'Model ready — ViT NSFW classifier (FALLBACK ACTIVE: NudeNet not loaded)',
        details,
        progressPercent: null,
      });
    } else {
      onProgress({
        phase: 'loading_model',
        statusText: 'Model ready — NudeNet v3 detector',
        details: `Using: ${provider}`,
        progressPercent: null,
      });
    }

    // -----------------------------------------------------------------------
    // Video metadata
    // -----------------------------------------------------------------------
    onProgress({
      phase: 'preparing_video',
      statusText: 'Opening the selected local video',
      details: 'Sampling uses browser-decoded frame presentation times; interpolation may vary by browser.',
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

    // -----------------------------------------------------------------------
    // Single reused canvas for the whole analysis
    // -----------------------------------------------------------------------
    const canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to create the local frame-processing canvas.');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'medium';

    // -----------------------------------------------------------------------
    // Frame sampling loop
    // -----------------------------------------------------------------------
    const candidateFrames: DetectionEvent[] = [];
    let resultId = 0;
    let lastProgressAt = 0;
    let usedSeekTimeFallback = false;

    for (let index = 0; index < sampleCount; index += 1) {
      throwIfAborted(signal);
      const targetSeconds = index * interval;
      if (targetSeconds >= durationSeconds) break;

      const frame = await capturePresentedFrame(video, context, canvasSize, targetSeconds, signal, detectorBackend);
      usedSeekTimeFallback ||= frame.timestampSource === 'seek-time fallback';
      throwIfAborted(signal);

      // Send pixels to the worker
      const classification = await classifyFrame(
        worker,
        frame.pixels,
        canvasSize,
        canvasSize,
        frame.drawWidth,
        frame.drawHeight,
        index + 1,
        signal,
      );
      throwIfAborted(signal);

      // Map detections → DetectionEvent candidates
      const newCandidates = buildCandidateEvents(
        classification.detections,
        detectorBackend,
        sourceId,
        frame.presentationSeconds,
        index + 1,
        resultId,
        options,
        classification.diagnostic?.rawTopPredictions,
      );
      resultId += newCandidates.length;
      candidateFrames.push(...newCandidates);

      if (options.debugLogging || (typeof window !== 'undefined' && (window as any).__CLIPGUARD_DEBUG__)) {
        console.debug('[ClipGuard Diagnostic]', {
          frameIndex: index + 1,
          presentationSeconds: frame.presentationSeconds,
          timestamp: formatSecondsToTimestamp(frame.presentationSeconds),
          rawTopPredictions: classification.diagnostic?.rawTopPredictions,
          candidateEventsCreated: newCandidates.length,
        });
      }

      const now = performance.now();
      if (now - lastProgressAt >= 125 || index + 1 === sampleCount) {
        lastProgressAt = now;
        onProgress({
          phase: 'sampling_frames',
          statusText: `Analyzed ${index + 1} of ${sampleCount} sampled frames`,
          details: `${frame.timestampSource} @ ${frame.presentationSeconds.toFixed(3)}s — ${candidateFrames.length} potential match${candidateFrames.length !== 1 ? 'es' : ''} so far.`,
          progressPercent: Math.floor(((index + 1) / sampleCount) * 100),
          processedFrames: index + 1,
          totalFrames: sampleCount,
          currentCandidateCount: candidateFrames.length,
        });
      }
    }

    throwIfAborted(signal);

    const merged = mergeDetections(
      candidateFrames,
      options.mergeToleranceSec,
      options.bufferSec,
      durationSeconds,
    );

    return {
      detections: merged,
      durationSeconds,
      sampledFrames: sampleCount,
      provider,
      detectorBackend,
      fallbackWarning,
      usedSeekTimeFallback,
    };

  } finally {
    signal.removeEventListener('abort', onAbort);
    if (readyListener) worker.removeEventListener('message', readyListener);
    terminate();
  }
}

// ---------------------------------------------------------------------------
// Detection → DetectionEvent mapping
// ---------------------------------------------------------------------------

export function buildCandidateEvents(
  detections: DetectedRegion[],
  backend: 'nudenet' | 'vit',
  sourceId: string,
  presentationSeconds: number,
  frameIndex: number,
  resultIdStart: number,
  options: AnalysisOptions,
  rawTopPredictions?: Array<{ className: string; score: number }>,
): DetectionEvent[] {
  if (!detections.length) return [];

  const timestamp = formatSecondsToTimestamp(presentationSeconds);
  const topScore = detections.reduce((m, d) => Math.max(m, d.score), 0);
  const scoreSemantics = buildScoreSemantics(backend, topScore);
  const detectorId = backend === 'nudenet' ? 'NudeNet YOLOv8n (320n.onnx)' : 'ViT NSFW (model_quantized.onnx)';

  if (backend === 'vit') {
    // ViT: single binary score; use legacy nsfw_image_classification path
    // Enforce minimum 0.65 threshold floor for ViT binary classifier to reject low-confidence noise
    const vitThreshold = Math.max(0.65, options.sensitivity / 100);
    const vitScore = detections[0]?.score ?? 0;
    if (!options.categories.nsfw_image_classification || vitScore < vitThreshold) {
      return [];
    }
    return [{
      id: `${sourceId}-${resultIdStart}`,
      startSeconds: presentationSeconds,
      endSeconds: presentationSeconds,
      startTimestamp: timestamp,
      endTimestamp: timestamp,
      category: 'nsfw_image_classification',
      categoryLabel: getCategoryLabel('nsfw_image_classification'),
      confidence: Math.round(vitScore * 100),
      modelScore: vitScore,
      scoreSemantics,
      explanation: `The whole sampled frame received a score of ${(vitScore * 100).toFixed(1)}% from the ViT NSFW classifier. ` +
        'This is a potential match requiring human review, not a definitive content judgment.',
      visualEvidence: '',
      reviewStatus: 'needs_review',
      editorNotes: '',
      verifiedFrameCount: 1,
      diagnostic: {
        detectorId,
        thresholdApplied: vitThreshold,
        positiveFrameCount: 1,
        scoreCalculation: `Single-frame ViT softmax score: ${(vitScore * 100).toFixed(1)}%`,
        frames: [{
          frameIndex,
          presentationSeconds,
          timestamp,
          detectorId,
          rawPredictions: rawTopPredictions || [{ className: 'nsfw', score: vitScore }],
          thresholdApplied: vitThreshold,
          ruleTriggered: `vit_score (${(vitScore * 100).toFixed(1)}%) >= threshold (${(vitThreshold * 100).toFixed(0)}%)`,
        }],
      },
    }];
  }

  // NudeNet: group detections by their mapped category
  const byCategory = new Map<string, NudeNetDetection[]>();
  for (const d of detections) {
    const category = nudenetClassToCategory(d.className);
    if (!category) continue;
    if (!options.categories[category]) continue;
    const threshold = options.sensitivity / 100;
    if (d.score < threshold) continue;

    const list = byCategory.get(category) ?? [];
    list.push(d as NudeNetDetection);
    byCategory.set(category, list);
  }

  const events: DetectionEvent[] = [];
  let idOffset = resultIdStart;

  for (const [category, dets] of byCategory) {
    const catTopScore = dets.reduce((m, d) => Math.max(m, d.score), 0);
    events.push({
      id: `${sourceId}-${idOffset++}`,
      startSeconds: presentationSeconds,
      endSeconds: presentationSeconds,
      startTimestamp: timestamp,
      endTimestamp: timestamp,
      category: category as import('../types').DetectionCategory,
      categoryLabel: getCategoryLabel(category),
      confidence: Math.round(catTopScore * 100),
      modelScore: catTopScore,
      scoreSemantics: buildScoreSemantics('nudenet', catTopScore),
      explanation: buildDetectionExplanation(dets),
      visualEvidence: buildVisualEvidence(dets),
      reviewStatus: 'needs_review',
      editorNotes: '',
      verifiedFrameCount: 1,
      diagnostic: {
        detectorId,
        thresholdApplied: options.sensitivity / 100,
        positiveFrameCount: 1,
        scoreCalculation: `Peak box confidence for category ${category}: ${(catTopScore * 100).toFixed(1)}%`,
        frames: [{
          frameIndex,
          presentationSeconds,
          timestamp,
          detectorId,
          rawPredictions: rawTopPredictions || dets.map((d) => ({ className: d.className, score: d.score })),
          thresholdApplied: options.sensitivity / 100,
          ruleTriggered: `${dets.map(d => `${d.className}(${(d.score*100).toFixed(0)}%)`).join(', ')} >= threshold (${options.sensitivity}%)`,
        }],
      },
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Option validation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Worker readiness promise
// ---------------------------------------------------------------------------

function waitForWorker(
  worker: Worker,
  signal: AbortSignal,
  captureListener: (listener: (event: MessageEvent<WorkerResponse>) => void) => void,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error(
        'Local model worker timed out during initialization (60 s). ' +
        'This usually means the ONNX WASM runtime cannot access SharedArrayBuffer. ' +
        'Ensure the server sends Cross-Origin-Opener-Policy: same-origin and ' +
        'Cross-Origin-Embedder-Policy: require-corp headers, and that the model ' +
        'files are present at /models/nudenet/ and /models/onnxruntime/.'
      )),
      60000,
    );
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      worker.removeEventListener('messageerror', handleMessageError);
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
    const handleError = (event: ErrorEvent) =>
      finish(new Error(event.message || 'The local model worker stopped unexpectedly.'));
    const handleMessageError = () =>
      finish(new Error(
        'Worker message deserialization failed. SharedArrayBuffer may be unavailable ' +
        '(missing COOP/COEP headers) or the model URL is unreachable.',
      ));
    const handleAbort = () => finish(new DOMException('Analysis cancelled.', 'AbortError'));
    captureListener(handleMessage);
    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.addEventListener('messageerror', handleMessageError);
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Video metadata load
// ---------------------------------------------------------------------------

function loadVideoMetadata(video: HTMLVideoElement, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error('Timed out while opening the selected video.')),
      FRAME_TIMEOUT_MS,
    );
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

// ---------------------------------------------------------------------------
// Frame capture  (reuses the caller-provided canvas / context)
// ---------------------------------------------------------------------------

interface CapturedFrame {
  pixels: Uint8ClampedArray;
  presentationSeconds: number;
  timestampSource: 'decoded-frame mediaTime' | 'seek-time fallback';
  drawWidth: number;
  drawHeight: number;
}

function capturePresentedFrame(
  video: HTMLVideoElement,
  context: CanvasRenderingContext2D,
  canvasSize: number,
  targetSeconds: number,
  signal: AbortSignal,
  backend: 'nudenet' | 'vit' = 'nudenet',
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
      FRAME_TIMEOUT_MS,
    );

    const drawAt = (presentationSeconds: number, timestampSource: CapturedFrame['timestampSource']) => {
      const { drawWidth, drawHeight } = backend === 'nudenet'
        ? computeLetterboxDimensions(video.videoWidth, video.videoHeight, canvasSize)
        : { drawWidth: canvasSize, drawHeight: canvasSize };

      context.fillStyle = '#000000';
      context.fillRect(0, 0, canvasSize, canvasSize);
      context.drawImage(video, 0, 0, drawWidth, drawHeight);

      finish(undefined, {
        pixels: context.getImageData(0, 0, canvasSize, canvasSize).data,
        presentationSeconds,
        timestampSource,
        drawWidth,
        drawHeight,
      });
    };

    const handleSeeked = () => {
      if (video.requestVideoFrameCallback) {
        // requestVideoFrameCallback gives us the precise decoded-frame mediaTime.
        // The 250 ms fallback is kept tight (was 250 ms before) — no unnecessary
        // artificial delay is added; we simply wait for the next decoded frame.
        frameCallbackId = video.requestVideoFrameCallback((_now, metadata) => {
          // Cancel the fallback timer the moment we get a real decoded frame.
          if (fallbackTimeout !== undefined) {
            window.clearTimeout(fallbackTimeout);
            fallbackTimeout = undefined;
          }
          drawAt(metadata.mediaTime, 'decoded-frame mediaTime');
        });
        // Safety fallback: if no frame callback fires within 200 ms, draw immediately.
        fallbackTimeout = window.setTimeout(
          () => drawAt(video.currentTime, 'seek-time fallback'),
          200,
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

// ---------------------------------------------------------------------------
// Frame classification promise
// ---------------------------------------------------------------------------

interface FrameClassification {
  detections: DetectedRegion[];
  diagnostic?: {
    rawTopPredictions: Array<{ className: string; score: number }>;
  };
}

function classifyFrame(
  worker: Worker,
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  drawWidth: number,
  drawHeight: number,
  requestId: number,
  signal: AbortSignal,
): Promise<FrameClassification> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => finish(new Error('Local model inference timed out.')),
      30000,
    );
    const cleanup = () => {
      window.clearTimeout(timeout);
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      signal.removeEventListener('abort', handleAbort);
    };
    const finish = (error?: Error, result?: FrameClassification) => {
      cleanup();
      if (error) reject(error);
      else resolve(result!);
    };
    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.requestId !== requestId) return;
      if (event.data.type === 'result') {
        finish(undefined, {
          detections: event.data.detections ?? [],
          diagnostic: event.data.diagnostic,
        });
      } else if (event.data.type === 'error') {
        finish(new Error(event.data.error || 'Local model inference failed.'));
      }
    };
    const handleError = (event: ErrorEvent) =>
      finish(new Error(event.message || 'The local model worker stopped unexpectedly.'));
    const handleAbort = () => finish(new DOMException('Analysis cancelled.', 'AbortError'));

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    signal.addEventListener('abort', handleAbort, { once: true });

    // Transfer the pixel buffer so we avoid a copy across the worker boundary.
    // The worker must NOT hold a reference to pixels after postMessage returns.
    worker.postMessage({ type: 'classify', requestId, pixels, width, height, drawWidth, drawHeight }, [pixels.buffer]);
  });
}
