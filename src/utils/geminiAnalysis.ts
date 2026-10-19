import type {
  DetectionEvent,
  AnalysisOptions,
  AnalysisProgress,
  GeminiAnalysisReport,
} from '../types.js';

export interface GeminiAnalysisFrontendParams {
  file?: File;
  youtubeJobId?: string;
  sourceId: string;
  options: AnalysisOptions;
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
  videoDurationSeconds?: number;
}

export interface GeminiAnalysisFrontendResult {
  detections: DetectionEvent[];
  report: GeminiAnalysisReport;
  durationSeconds: number;
}

/**
 * Executes Gemini video analysis by calling the local server proxy endpoint,
 * which passes videoMetadata.fps: 4 directly to the official Gemini v1beta API.
 */
export async function analyzeVideoWithGemini(
  params: GeminiAnalysisFrontendParams
): Promise<GeminiAnalysisFrontendResult> {
  const { file, youtubeJobId, options, signal, onProgress, videoDurationSeconds } = params;

  onProgress?.({
    phase: 'preparing_video',
    progressPercent: 10,
    statusText: 'Preparing video for Gemini multimodal analysis…',
    details: 'Configuring 4 FPS video sampling rate (videoMetadata.fps: 4, 1 frame every 0.25s).',
  });

  let inlineBase64: string | undefined;

  if (file) {
    if (file.size <= 15 * 1024 * 1024) {
      onProgress?.({
        phase: 'preparing_video',
        progressPercent: 25,
        statusText: 'Encoding video for transmission…',
        details: `Encoding "${file.name}" (${(file.size / (1024 * 1024)).toFixed(1)} MB) as base64 payload.`,
      });

      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      const len = bytes.byteLength;
      for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      inlineBase64 = btoa(binary);
    } else {
      throw new Error(
        `Video size (${(file.size / (1024 * 1024)).toFixed(1)} MB) exceeds 15 MB direct upload limit. Please use a smaller clip or provide via YouTube download.`
      );
    }
  }

  if (!options.geminiConfig?.userConfirmedProjectBillingIntent) {
    throw new Error(
      'Explicit project confirmation required: Please open Settings and confirm that you understand billing depends on your Google Cloud/AI Studio project settings (whether a billing account is attached) and intend to use this project.'
    );
  }

  if (!options.geminiConfig?.userConsentedVideoUpload) {
    throw new Error(
      'Explicit consent required: Please open Settings and confirm consent to transmit video data to Google\'s Gemini API (generativelanguage.googleapis.com).'
    );
  }

  onProgress?.({
    phase: 'analyzing_candidates',
    progressPercent: 50,
    statusText: 'Submitting to Gemini API at 4 FPS…',
    details: `Model: ${options.geminiConfig?.model || 'gemini-2.5-flash'}. Setting videoMetadata.fps = 4.`,
  });

  const response = await fetch('/api/gemini/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey: options.geminiConfig?.apiKey,
      model: options.geminiConfig?.model || 'gemini-2.5-flash',
      fps: 4, // Exactly 4 FPS
      userConfirmedProjectBillingIntent: Boolean(options.geminiConfig?.userConfirmedProjectBillingIntent),
      userConsentedVideoUpload: Boolean(options.geminiConfig?.userConsentedVideoUpload),
      youtubeJobId,
      inlineBase64,
      options: {
        sensitivity: options.sensitivity,
        mergeToleranceSec: options.mergeToleranceSec,
        bufferSec: options.bufferSec,
        categories: options.categories,
      },
      videoDurationSeconds,
    }),
    signal,
  });

  const data = await response.json();

  if (!response.ok || !data.success) {
    if (data.quotaExceeded) {
      throw new Error(
        data.error ||
          'Google Gemini API quota limit reached (HTTP 429). Please check your Google AI Studio project limits.'
      );
    }
    if (data.capabilityError) {
      throw new Error(
        data.error ||
          'Selected model does not support videoMetadata.fps configuration. Please select a supported multimodal model.'
      );
    }
    throw new Error(data.error || 'Gemini video analysis failed.');
  }

  onProgress?.({
    phase: 'complete',
    progressPercent: 100,
    statusText: 'Gemini analysis complete — review potential matches',
    details: `${data.detections.length} candidate moments found at 4 FPS sampling rate. Frame coverage unverified by API.`,
  });

  const report: GeminiAnalysisReport = {
    requestedFps: data.requestedFps,
    samplingIntervalSec: data.samplingIntervalSec,
    samplingRateDescription: data.samplingRateDescription,
    apiCallSucceeded: data.apiCallSucceeded,
    effectiveFpsConfirmedByApi: data.effectiveFpsConfirmedByApi,
    coverageVerification: data.coverageVerification,
    model: data.model,
    frameCoverageNotice: data.frameCoverageNotice,
    interFrameWarning: data.interFrameWarning,
    billingNotice: data.billingNotice,
  };

  return {
    detections: data.detections,
    report,
    durationSeconds: videoDurationSeconds || 0,
  };
}
