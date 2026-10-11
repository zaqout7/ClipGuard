/**
 * Client-Side Video Frame Extraction Engine
 * Uses HTML5 Video + Off-Screen Canvas to decode exact video frames at target timestamps.
 * Features chunked batch streaming and explicit memory cleanup for long videos (10-20+ minutes).
 */

export interface SampledFrame {
    timestampSeconds: number;
    imageBase64: string; // JPEG format data URL
  }
  
  export interface FrameBatch {
    batchIndex: number;
    totalBatches: number;
    frames: SampledFrame[];
    startSec: number;
    endSec: number;
  }
  
  /**
   * Seeks an HTML5 video element to a specific timestamp and resolves when seeking completes.
   */
  function seekVideoTo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve(); // Proceed anyway after 3s to prevent hanging
      }, 3000);
  
      const onSeeked = () => {
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        resolve();
      };
  
      const onError = (e: any) => {
        clearTimeout(timeout);
        video.removeEventListener('seeked', onSeeked);
        video.removeEventListener('error', onError);
        reject(e);
      };
  
      video.addEventListener('seeked', onSeeked);
      video.addEventListener('error', onError);
      video.currentTime = Math.max(0, Math.min(timeSeconds, video.duration || timeSeconds));
    });
  }
  
  /**
   * Captures current video frame onto an HTML canvas and returns compressed JPEG data URL.
   * Automatically clears the canvas buffer after encoding to avoid memory leaks.
   */
  function captureCanvasFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement, targetWidth = 640): string {
    const aspect = video.videoWidth > 0 && video.videoHeight > 0
      ? video.videoHeight / video.videoWidth
      : 9 / 16;
  
    canvas.width = targetWidth;
    canvas.height = Math.round(targetWidth * aspect);
  
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) return '';
  
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.75);
  
    // Explicitly clear canvas drawing buffer immediately
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  
    return dataUrl;
  }
  
  /**
   * Extracts and streams video frames in memory-safe batches across the entire timeline.
   * Does not clamp maximum frames; handles long videos by processing small chunks at a time.
   */
  export async function streamVideoBatches(
    videoSource: File | string,
    sampleIntervalSec: number = 1.5,
    batchSize: number = 15,
    onBatch: (batch: FrameBatch) => Promise<void>,
    onProgress?: (overallPercent: number, currentSec: number, currentBatch: number, totalBatches: number) => void
  ): Promise<{ totalFramesAnalyzed: number; durationSeconds: number }> {
    return new Promise(async (resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
  
      let objectUrl = '';
      if (typeof videoSource === 'string') {
        video.src = videoSource;
      } else {
        objectUrl = URL.createObjectURL(videoSource);
        video.src = objectUrl;
      }
  
      const cleanup = () => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = '';
        }
        video.removeAttribute('src');
        video.load();
      };
  
      video.onloadedmetadata = async () => {
        try {
          const duration = video.duration || 60;
  
          // Generate full array of sample timestamps across entire video duration
          const allTimestamps: number[] = [];
          for (let t = 0.5; t < duration; t += sampleIntervalSec) {
            allTimestamps.push(parseFloat(t.toFixed(2)));
          }
  
          const totalBatches = Math.max(1, Math.ceil(allTimestamps.length / batchSize));
          const reusableCanvas = document.createElement('canvas');
          let totalFramesAnalyzed = 0;
  
          for (let b = 0; b < totalBatches; b++) {
            const sliceStart = b * batchSize;
            const sliceEnd = Math.min(allTimestamps.length, sliceStart + batchSize);
            const batchTimestamps = allTimestamps.slice(sliceStart, sliceEnd);
  
            const currentBatchFrames: SampledFrame[] = [];
  
            for (let i = 0; i < batchTimestamps.length; i++) {
              const t = batchTimestamps[i];
              await seekVideoTo(video, t);
              const imageBase64 = captureCanvasFrame(video, reusableCanvas);
              if (imageBase64) {
                currentBatchFrames.push({
                  timestampSeconds: t,
                  imageBase64,
                });
              }
  
              const frameIndex = sliceStart + i + 1;
              const overallPct = Math.round((frameIndex / allTimestamps.length) * 100);
              if (onProgress) {
                onProgress(overallPct, t, b + 1, totalBatches);
              }
            }
  
            if (currentBatchFrames.length > 0) {
              const startSec = batchTimestamps[0];
              const endSec = batchTimestamps[batchTimestamps.length - 1];
  
              // Send batch to consumer (caller sends to API)
              await onBatch({
                batchIndex: b + 1,
                totalBatches,
                frames: currentBatchFrames,
                startSec,
                endSec,
              });
  
              totalFramesAnalyzed += currentBatchFrames.length;
  
              // Clear batch array references so browser garbage collector can reclaim memory
              currentBatchFrames.length = 0;
            }
          }
  
          // Cleanup reusable canvas
          reusableCanvas.width = 1;
          reusableCanvas.height = 1;
  
          cleanup();
          resolve({ totalFramesAnalyzed, durationSeconds: duration });
        } catch (err) {
          cleanup();
          reject(err);
        }
      };
  
      video.onerror = () => {
        cleanup();
        reject(new Error('Failed to load video file for frame extraction.'));
      };
    });
  }
  
  /**
   * Extracts dense frames around candidate timestamps (e.g. ±1.5s at 0.5s intervals) for temporal verification.
   */
  export async function extractDenseFramesAround(
    videoSource: File | string,
    candidateSeconds: number,
    denseIntervalSec: number = 0.5,
    windowRadiusSec: number = 1.5
  ): Promise<SampledFrame[]> {
    return new Promise(async (resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
  
      let objectUrl = '';
      if (typeof videoSource === 'string') {
        video.src = videoSource;
      } else {
        objectUrl = URL.createObjectURL(videoSource);
        video.src = objectUrl;
      }
  
      const cleanup = () => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = '';
        }
        video.removeAttribute('src');
        video.load();
      };
  
      video.onloadedmetadata = async () => {
        try {
          const duration = video.duration || 60;
          const frames: SampledFrame[] = [];
          const canvas = document.createElement('canvas');
  
          const startT = Math.max(0, candidateSeconds - windowRadiusSec);
          const endT = Math.min(duration, candidateSeconds + windowRadiusSec);
  
          const timestamps: number[] = [];
          for (let t = startT; t <= endT; t += denseIntervalSec) {
            timestamps.push(parseFloat(t.toFixed(2)));
          }
  
          for (const t of timestamps) {
            await seekVideoTo(video, t);
            const imageBase64 = captureCanvasFrame(video, canvas);
            if (imageBase64) {
              frames.push({
                timestampSeconds: t,
                imageBase64,
              });
            }
          }
  
          // Free canvas
          canvas.width = 1;
          canvas.height = 1;
  
          cleanup();
          resolve(frames);
        } catch (err) {
          cleanup();
          reject(err);
        }
      };
  
      video.onerror = () => {
        cleanup();
        reject(new Error('Failed to load video for dense sequence verification.'));
      };
    });
  }