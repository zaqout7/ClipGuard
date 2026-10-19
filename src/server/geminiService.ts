import fs from 'node:fs';
import path from 'node:path';
import type { DetectionCategory, DetectionEvent, AnalysisOptions } from '../types.js';
import { formatSecondsToTimestamp, mergeDetections } from '../utils/formatters.js';

export const GEMINI_API_V1BETA_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_UPLOAD_V1BETA_BASE = 'https://generativelanguage.googleapis.com/upload/v1beta';

export const DEFAULT_GEMINI_FPS = 4;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export interface GeminiModelDescriptor {
  id: string;
  name: string;
  supportsVideo: boolean;
  supportsVideoMetadataFps: boolean;
  contextWindowTokens: number;
  description: string;
}

export const GEMINI_MODELS: Record<string, GeminiModelDescriptor> = {
  'gemini-3.8-flash': {
    id: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    supportsVideo: true,
    supportsVideoMetadataFps: true,
    contextWindowTokens: 1048576,
    description: 'Current standard lightweight multimodal model recommended by Google. Suitable for Free Tier usage if your Google project has no billing account attached.',
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    supportsVideo: true,
    supportsVideoMetadataFps: true,
    contextWindowTokens: 1048576,
    description: 'Legacy multimodal model (deprecated by Google for new users/projects).',
  },
  'gemini-2.0-flash': {
    id: 'gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    supportsVideo: true,
    supportsVideoMetadataFps: true,
    contextWindowTokens: 1048576,
    description: 'Next-gen multimodal model. Subject to your Google project billing configuration.',
  },
  'gemini-1.5-flash': {
    id: 'gemini-1.5-flash',
    name: 'Gemini 1.5 Flash',
    supportsVideo: true,
    supportsVideoMetadataFps: true,
    contextWindowTokens: 1048576,
    description: 'Standard lightweight multimodal model. Subject to your Google project billing configuration.',
  },
  'gemini-1.5-pro': {
    id: 'gemini-1.5-pro',
    name: 'Gemini 1.5 Pro',
    supportsVideo: true,
    supportsVideoMetadataFps: true,
    contextWindowTokens: 2097152,
    description: 'Higher intelligence multimodal model. May consume higher token quotas or incur billing if enabled on your project.',
  },
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    supportsVideo: true,
    supportsVideoMetadataFps: true,
    contextWindowTokens: 2097152,
    description: 'Flagship multimodal reasoning model. Subject to your project quota and billing configuration.',
  },
};

export class GeminiQuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiQuotaExceededError';
  }
}

export class GeminiCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiCapabilityError';
  }
}

/**
 * Validates that the requested model and sampling frame rate are officially supported.
 * Note: Billing depends on the user's Google Cloud / Google AI Studio project settings,
 * NOT on a model allowlist.
 */
export function validateGeminiModelAndFps(
  model: string,
  fps: number = DEFAULT_GEMINI_FPS
): GeminiModelDescriptor {
  const descriptor = GEMINI_MODELS[model];

  if (!descriptor) {
    throw new GeminiCapabilityError(
      `Unsupported model "${model}". Model must be one of: ${Object.keys(GEMINI_MODELS).join(', ')}.`
    );
  }

  if (!descriptor.supportsVideo || !descriptor.supportsVideoMetadataFps) {
    throw new GeminiCapabilityError(
      `Model "${model}" does not support video frame rate configuration (videoMetadata.fps). Supported models: ${Object.keys(
        GEMINI_MODELS
      )
        .filter((m) => GEMINI_MODELS[m].supportsVideoMetadataFps)
        .join(', ')}.`
    );
  }

  if (typeof fps !== 'number' || Number.isNaN(fps) || fps <= 0 || fps > 24) {
    throw new GeminiCapabilityError(
      `Invalid fps value "${fps}". The Gemini API requires videoMetadata.fps to be a positive number in the range (0.0, 24.0].`
    );
  }

  return descriptor;
}

/**
 * Builds the exact Gemini API Part object containing video data and videoMetadata.fps.
 * Sets the actual Gemini API videoMetadata.fps parameter directly (not relying on prompt wording).
 */
export function buildGeminiVideoPart(
  videoSource: { fileUri?: string; inlineBase64?: string; mimeType?: string },
  fps: number = DEFAULT_GEMINI_FPS
) {
  if (typeof fps !== 'number' || Number.isNaN(fps) || fps <= 0 || fps > 24) {
    throw new GeminiCapabilityError(
      `Invalid fps value "${fps}". Gemini API videoMetadata.fps must be within (0.0, 24.0].`
    );
  }

  const mimeType = videoSource.mimeType || 'video/mp4';
  const part: any = {
    videoMetadata: {
      fps: fps, // Explicitly configure 4 FPS (one frame every 0.25s)
    },
  };

  if (videoSource.fileUri) {
    part.fileData = {
      fileUri: videoSource.fileUri,
      mimeType,
    };
  } else if (videoSource.inlineBase64) {
    part.inlineData = {
      data: videoSource.inlineBase64,
      mimeType,
    };
  } else {
    throw new Error('Either fileUri or inlineBase64 must be provided to construct Gemini video Part.');
  }

  return part;
}

export const GEMINI_ANALYSIS_SYSTEM_INSTRUCTION = `
You are a precise video safety and content moderation specialist.
Your task is to analyze the video and report timestamps where sensitive content, intimate exposure, or wardrobe review moments occur.

CRITICAL ANATOMICAL DISTINCTIONS:
1. EXPOSED ANATOMY: Uncovered, bare skin of intimate regions:
   - Bare female breasts or areolae
   - Bare buttocks
   - Bare genitalia or anus
2. COVERED ANATOMY: Body regions covered by clothing, undergarments, swimwear, bikini tops, cleavage within normal clothing, or exposed belly/midriff.

STRICT CLASSIFICATION RULES:
- NEVER describe covered body regions, swimwear, cleavage, tight clothing, or normal skin as "confirmed nudity", "clothing slip", or "wardrobe malfunction".
- If cleavage or covered breast is visible, classify it strictly as covered anatomy under "clothing_shift_revealing" only for broad review.
- If normal exposed belly or midriff is visible, classify it strictly as "other_wardrobe_anomaly" only for broad review.
- If the buttock region is clothed but prominently outlined by tight-fitting fabric (e.g. leggings, bodycon skirts), classify it strictly as "covered_buttocks_outline" for optional broad review:
  * NEUTRAL CRITERION: The buttock region is clearly visible in the composition and its contour is distinctly outlined by the clothing.
  * DO NOT flag every person seen from behind or ordinary loose/casual trousers, jeans, or skirts.
  * DO NOT infer sexual intent, a clothing slip, or a wardrobe malfunction.
  * AGE SAFEGUARD: For people who appear underage or whose adulthood is uncertain, do NOT apply body-prominence assessments. Omit this category entirely rather than guessing age.
- Do NOT flag normal casual attire, trousers, skirts, or modest dresses as wardrobe violations or undergarment slips.
- Only report genuine bare intimate exposure under "possible_chest_exposure", "possible_rear_exposure", or "nsfw_image_classification".

TIMESTAMPS:
- Report precise startSeconds and endSeconds relative to video start (00:00).
- Preserve the exact video timestamps without rounding away short intervals.
`;

export const GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          startSeconds: { type: 'NUMBER' },
          endSeconds: { type: 'NUMBER' },
          category: {
            type: 'STRING',
            enum: [
              'possible_chest_exposure',
              'possible_rear_exposure',
              'clothing_shift_revealing',
              'undergarment_slip',
              'other_wardrobe_anomaly',
              'nsfw_image_classification',
              'covered_buttocks_outline',
            ],
          },
          anatomicalState: {
            type: 'STRING',
            enum: ['exposed', 'covered', 'unclear'],
          },
          isExposed: { type: 'BOOLEAN' },
          confidence: { type: 'INTEGER' },
          explanation: { type: 'STRING' },
          visualEvidence: { type: 'STRING' },
        },
        required: [
          'startSeconds',
          'endSeconds',
          'category',
          'anatomicalState',
          'isExposed',
          'confidence',
          'explanation',
        ],
      },
    },
  },
  required: ['findings'],
};

export interface RawGeminiFinding {
  startSeconds: number;
  endSeconds: number;
  category: DetectionCategory;
  anatomicalState: 'exposed' | 'covered' | 'unclear';
  isExposed: boolean;
  confidence: number;
  explanation: string;
  visualEvidence?: string;
}

export interface GeminiProcessOptions {
  sensitivity: number;
  mergeToleranceSec: number;
  bufferSec: number;
  categories: Record<DetectionCategory, boolean>;
}

/**
 * Normalizes raw findings from Gemini, sanitizes anatomical descriptions,
 * suppresses benign/covered clothing from generating exposure alerts,
 * and merges repeated 4 FPS findings into continuous review segments.
 */
export function processGeminiFindings(
  rawFindings: RawGeminiFinding[],
  options: GeminiProcessOptions,
  videoDurationSeconds?: number
): DetectionEvent[] {
  const candidateEvents: DetectionEvent[] = [];

  for (let i = 0; i < rawFindings.length; i++) {
    const raw = rawFindings[i];
    let cat = raw.category;
    let confidence = Math.max(0, Math.min(100, Math.round(raw.confidence || 50)));

    // Distinguish exposed from covered anatomy:
    // If anatomicalState is covered or isExposed is false, ensure it is NOT described
    // as confirmed nudity, clothing slip, or wardrobe malfunction.
    const isCovered = raw.anatomicalState === 'covered' || !raw.isExposed || cat === 'covered_buttocks_outline';
    if (isCovered) {
      if (
        cat === 'possible_chest_exposure' ||
        cat === 'nsfw_image_classification'
      ) {
        // Demote to broad review
        cat = 'clothing_shift_revealing';
      } else if (cat === 'possible_rear_exposure') {
        // Route covered rear to covered_buttocks_outline so it is not labeled as exposure or breast cleavage
        cat = 'covered_buttocks_outline';
      }
    }

    // Check if the resulting category is enabled in user settings
    if (!options.categories[cat]) {
      continue;
    }

    // Check sensitivity threshold
    if (confidence < options.sensitivity) {
      continue;
    }

    const startSec = Math.max(0, Number(raw.startSeconds) || 0);
    const endSec = Math.max(startSec + 0.1, Number(raw.endSeconds) || startSec + 0.25);

    let explanation = raw.explanation || '';
    let visualEvidence = raw.visualEvidence || (isCovered ? 'Covered body region' : 'Exposed anatomy detected in video stream');

    if (cat === 'covered_buttocks_outline') {
      // Requirement 7: Accurate result wording for covered buttocks outline
      explanation = 'Covered region; visible clothing contour; optional human review.';
      visualEvidence = 'Covered region; visible clothing contour; optional human review.';
    } else if (isCovered) {
      // Sanitize explanation: replace misleading defect/malfunction claims on covered anatomy
      explanation = explanation
        .replace(/wardrobe malfunction/gi, 'clothing observation')
        .replace(/clothing slip/gi, 'covered clothing line')
        .replace(/confirmed nudity/gi, 'covered anatomy')
        .replace(/accidental slip/gi, 'clothing boundary');
      if (!explanation.toLowerCase().includes('covered')) {
        explanation = `Covered anatomy observed: ${explanation}`;
      }
    }

    let categoryLabel = 'Detected Content';
    if (cat === 'possible_chest_exposure') categoryLabel = 'Possible chest exposure';
    else if (cat === 'possible_rear_exposure') categoryLabel = 'Possible rear exposure';
    else if (cat === 'clothing_shift_revealing') categoryLabel = 'Covered breast / cleavage (broad review)';
    else if (cat === 'other_wardrobe_anomaly') categoryLabel = 'Exposed midriff / belly (broad review)';
    else if (cat === 'nsfw_image_classification') categoryLabel = 'Explicit nudity / NSFW content';
    else if (cat === 'undergarment_slip') categoryLabel = 'Undergarment boundary (broad review)';
    else if (cat === 'covered_buttocks_outline') categoryLabel = 'Visible buttock outline through clothing';

    candidateEvents.push({
      id: `gemini-${i + 1}-${startSec.toFixed(2)}`,
      startSeconds: startSec,
      endSeconds: endSec,
      startTimestamp: formatSecondsToTimestamp(startSec),
      endTimestamp: formatSecondsToTimestamp(endSec),
      category: cat,
      categoryLabel,
      confidence,
      modelScore: confidence / 100,
      scoreSemantics: 'Gemini Multimodal 4 FPS Video Analysis (uncalibrated detector score; not a calibrated probability)',
      explanation,
      visualEvidence,
      reviewStatus: 'needs_review',
      editorNotes: '',
      severity: isCovered ? 'low' : confidence > 70 ? 'high' : 'medium',
      verifiedFrameCount: undefined,
      frameCoverageNotice: 'Coverage unverified (Gemini multimodal attention; individual frame-by-frame verification is unavailable)',
    });
  }

  // Merge repeated findings into continuous review segments
  return mergeDetections(
    candidateEvents,
    options.mergeToleranceSec,
    options.bufferSec,
    videoDurationSeconds
  );
}

/**
 * Builds the complete request payload sent to Gemini API with videoMetadata.fps = 4.
 */
export function buildGeminiGenerateContentPayload(
  videoPart: any,
  systemInstruction: string = GEMINI_ANALYSIS_SYSTEM_INSTRUCTION
) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          videoPart,
          {
            text: 'Analyze this video stream for sensitive content, exposed anatomy, and wardrobe review moments according to the system instructions. Return all detected moments in the required structured JSON format.',
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: GEMINI_RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  };
}

export interface GeminiAnalysisExecutionParams {
  apiKey: string;
  model?: string;
  fps?: number;
  userConfirmedProjectBillingIntent: boolean;
  userConsentedVideoUpload: boolean;
  videoSource: {
    fileUri?: string;
    inlineBase64?: string;
    filePath?: string;
    mimeType?: string;
  };
  options: GeminiProcessOptions;
  videoDurationSeconds?: number;
  fetchFn?: typeof fetch;
  pollOptions?: GeminiFilePollOptions;
  deleteOptions?: GeminiDeleteOptions;
}

export interface GeminiAnalysisExecutionResult {
  success: boolean;
  detections: DetectionEvent[];
  requestedFps: number;
  samplingIntervalSec: number;
  samplingRateDescription: string;
  apiCallSucceeded: boolean;
  effectiveFpsConfirmedByApi: boolean;
  coverageVerification: 'unverified' | 'verified';
  model: string;
  finishReason?: string;
  rawFindingsCount?: number;
  usageMetadata?: any;
  safetyRatings?: any;
  frameCoverageNotice: string;
  interFrameWarning: string;
  billingNotice: string;
}

/**
 * Executes video analysis against the official Gemini v1beta REST API.
 */
export async function executeGeminiVideoAnalysis(
  params: GeminiAnalysisExecutionParams
): Promise<GeminiAnalysisExecutionResult> {
  const model = params.model || DEFAULT_GEMINI_MODEL;
  const fps = params.fps ?? DEFAULT_GEMINI_FPS;
  const fetchClient = params.fetchFn || fetch;

  if (!params.apiKey || !params.apiKey.trim()) {
    throw new Error('A valid Gemini API key is required. Configure GEMINI_API_KEY on the server or provide it in Settings.');
  }

  // Enforce explicit user confirmation of project billing intent
  if (!params.userConfirmedProjectBillingIntent) {
    throw new Error(
      'Explicit project confirmation required: You must confirm that you understand billing depends on your Google Cloud/AI Studio project settings (whether a billing account is attached) and that you intend to use this project.'
    );
  }

  // Enforce explicit user consent for video upload
  if (!params.userConsentedVideoUpload) {
    throw new Error(
      'Explicit consent required: You must explicitly confirm consent to transmit video data to Google\'s Gemini API (generativelanguage.googleapis.com).'
    );
  }

  // 1. Confirm model and API support for videoMetadata.fps
  const descriptor = validateGeminiModelAndFps(model, fps);

  // 2. Prepare video Part with videoMetadata.fps = 4
  let fileUri = params.videoSource.fileUri;
  let inlineBase64 = params.videoSource.inlineBase64;
  const detectedMime = params.videoSource.filePath?.toLowerCase().endsWith('.webm') ? 'video/webm' : 'video/mp4';
  const mimeType = params.videoSource.mimeType || detectedMime;
  let uploadedFileName: string | null = null;

  try {
    // If local file path provided and no fileUri or base64, handle file
    if (!fileUri && !inlineBase64 && params.videoSource.filePath) {
      const stats = fs.statSync(params.videoSource.filePath);
      if (stats.size <= 15 * 1024 * 1024) {
        // Small enough for inline base64
        const fileBuffer = fs.readFileSync(params.videoSource.filePath);
        inlineBase64 = fileBuffer.toString('base64');
      } else {
        // Upload via Files API and wait for ACTIVE state
        const uploadResult = await uploadVideoToFileApi(
          params.videoSource.filePath,
          mimeType,
          params.apiKey,
          fetchClient,
          params.pollOptions
        );
        fileUri = uploadResult.fileUri;
        uploadedFileName = uploadResult.fileName;
      }
    }

    const videoPart = buildGeminiVideoPart({ fileUri, inlineBase64, mimeType }, fps);
    const payload = buildGeminiGenerateContentPayload(videoPart);

    // 3. Make API call to official v1beta endpoint (never log the API key)
    const url = `${GEMINI_API_V1BETA_BASE}/models/${model}:generateContent?key=${encodeURIComponent(params.apiKey.trim())}`;
    const response = await fetchClient(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    // 4. Handle HTTP responses, specifically 429 / quota limits
    if (!response.ok) {
      let errorDetails = '';
      try {
        const errJson = await response.json();
        errorDetails = errJson?.error?.message || JSON.stringify(errJson);
      } catch {
        errorDetails = await response.text();
      }

      if (
        response.status === 429 ||
        errorDetails.includes('RESOURCE_EXHAUSTED') ||
        errorDetails.toLowerCase().includes('quota') ||
        errorDetails.toLowerCase().includes('rate limit')
      ) {
        throw new GeminiQuotaExceededError(
          'Google Gemini API quota or rate limit reached (HTTP 429 / RESOURCE_EXHAUSTED). The request or token quota for your Google project has been exceeded. Please check your project\'s active quota and rate limits in Google AI Studio (https://aistudio.google.com/app/plan_information) or the Google Cloud Console.'
        );
      }

      // Sanitize any key leakage in error text
      const sanitizedError = errorDetails.replace(/key=[a-zA-Z0-9_\-]+/g, 'key=[REDACTED]');
      throw new Error(`Gemini API request failed (${response.status} ${response.statusText}): ${sanitizedError}`);
    }

    const data = await response.json();
    const candidate = data?.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const blockReason = data?.promptFeedback?.blockReason;
    const safetyRatings = candidate?.safetyRatings || data?.promptFeedback?.safetyRatings;
    const rawText = candidate?.content?.parts?.[0]?.text;

    if (!rawText) {
      if (blockReason) {
        throw new Error(`Gemini API blocked the request (Prompt block reason: ${blockReason}). Safety ratings: ${JSON.stringify(safetyRatings)}`);
      }
      if (finishReason && finishReason !== 'STOP') {
        throw new Error(`Gemini generation stopped with reason "${finishReason}". Safety ratings: ${JSON.stringify(safetyRatings)}`);
      }
      throw new Error(`Gemini API returned an empty or invalid response: ${JSON.stringify(data)}`);
    }

    let parsedResponse: { findings: RawGeminiFinding[] };
    try {
      parsedResponse = JSON.parse(rawText);
    } catch (err: any) {
      throw new Error(`Failed to parse Gemini structured JSON response: ${err.message}. Raw text: ${rawText}`);
    }

    const rawFindings = Array.isArray(parsedResponse?.findings) ? parsedResponse.findings : [];

    // 5. Process findings, preserve original timestamps, merge findings, distinguish anatomy
    const detections = processGeminiFindings(rawFindings, params.options, params.videoDurationSeconds);

    return {
      success: true,
      detections,
      requestedFps: fps,
      samplingIntervalSec: 1 / fps,
      samplingRateDescription: `${fps} FPS (one frame every ${(1 / fps).toFixed(2)} seconds requested via videoMetadata.fps: ${fps})`,
      apiCallSucceeded: true, // HTTP 200 OK from Gemini API
      effectiveFpsConfirmedByApi: false, // The Gemini API returns model predictions but does not confirm effective sampling rate
      coverageVerification: 'unverified',
      model,
      finishReason: finishReason || 'STOP',
      rawFindingsCount: rawFindings.length,
      usageMetadata: data.usageMetadata,
      safetyRatings,
      frameCoverageNotice: `Requested ${fps} FPS via videoMetadata.fps parameter. The API returned HTTP 200 OK without explicit confirmation of effective sampling rate. Per-frame sampling rate execution and frame-by-frame coverage cannot be independently confirmed from the API response alone.`,
      interFrameWarning: `Video was requested at ${fps} FPS (one frame every ${(1 / fps).toFixed(2)} seconds). Brief transient events or subtle movements occurring between sampled frames (< ${(1 / fps).toFixed(2)}s) may still be missed.`,
      billingNotice: `Billing status depends entirely on your Google Cloud / Google AI Studio project settings (whether a billing account is attached to your project), not on the model name. Check your project's billing and plan status in Google AI Studio or Google Cloud Console.`,
    };
  } finally {
    if (uploadedFileName) {
      try {
        await deleteVideoFromFileApi(uploadedFileName, params.apiKey, fetchClient, params.deleteOptions);
      } catch {
        // Silent catch: deletion failure must not mask original analysis result or error
      }
    }
  }
}

export interface GeminiUploadResult {
  fileUri: string;
  fileName: string;
  state: string;
}

export interface GeminiFilePollOptions {
  maxAttempts?: number;
  pollIntervalMs?: number;
  totalTimeoutMs?: number;
  requestTimeoutMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface GeminiDeleteOptions {
  timeoutMs?: number;
}

/**
 * Polls the Google Gemini File API until the uploaded file transitions to 'ACTIVE' state.
 * Enforces a real wall-clock total timeout across all attempts and uses AbortController
 * on each individual GET request to prevent network hangs.
 * Throws if the file enters 'FAILED' state, times out, or fails with an API error.
 */
export async function waitForFileActive(
  fileName: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  options?: GeminiFilePollOptions
): Promise<{ state: string; uri?: string }> {
  const maxAttempts = options?.maxAttempts ?? 60;
  const pollIntervalMs = options?.pollIntervalMs ?? 2000;
  const totalTimeoutMs = options?.totalTimeoutMs ?? 120_000;
  const requestTimeoutMs = options?.requestTimeoutMs ?? 10_000;
  const sleep = options?.sleepFn ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const normalizedName = fileName.startsWith('files/') ? fileName : `files/${fileName}`;
  const checkUrl = `${GEMINI_API_V1BETA_BASE}/${normalizedName}?key=${encodeURIComponent(apiKey.trim())}`;

  const startTime = Date.now();
  let attempts = 0;

  while (attempts < maxAttempts) {
    const elapsedMs = Date.now() - startTime;
    const remainingTotalMs = totalTimeoutMs - elapsedMs;
    if (remainingTotalMs <= 0) {
      throw new Error(
        `Video file processing timed out after ${elapsedMs}ms (total timeout ${totalTimeoutMs}ms exceeded, attempts: ${attempts}). File is not ready for analysis.`
      );
    }

    attempts++;
    const thisRequestTimeoutMs = Math.min(requestTimeoutMs, remainingTotalMs);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`GET request timed out after ${thisRequestTimeoutMs}ms`));
    }, thisRequestTimeoutMs);

    let checkData: any;
    try {
      let checkRes: Response;
      try {
        checkRes = await fetchFn(checkUrl, { signal: controller.signal });
      } catch (netErr: any) {
        const isAbort = controller.signal.aborted || netErr?.name === 'AbortError';
        if (isAbort) {
          throw new Error(`GET request to check video status timed out after ${thisRequestTimeoutMs}ms`);
        }
        const sanitized = (netErr?.message || String(netErr)).replace(/key=[a-zA-Z0-9_\-]+/g, 'key=[REDACTED]');
        throw new Error(`Network error while polling Gemini File API status for ${normalizedName}: ${sanitized}`);
      }

      if (!checkRes.ok) {
        let errText = '';
        try {
          errText = await checkRes.text();
        } catch (textErr: any) {
          const isAbort = controller.signal.aborted || textErr?.name === 'AbortError';
          if (isAbort) {
            throw new Error(`GET request timed out while reading error response body after ${thisRequestTimeoutMs}ms`);
          }
        }
        const sanitized = errText.replace(/key=[a-zA-Z0-9_\-]+/g, 'key=[REDACTED]');
        throw new Error(`Failed to check video processing status from Google File API (${checkRes.status} ${checkRes.statusText}): ${sanitized}`);
      }

      try {
        checkData = await checkRes.json();
      } catch (parseErr: any) {
        const isAbort = controller.signal.aborted || parseErr?.name === 'AbortError';
        if (isAbort) {
          throw new Error(`GET request timed out while reading JSON response body after ${thisRequestTimeoutMs}ms`);
        }
        throw new Error(`Failed to parse Google File API status response: ${parseErr.message}`);
      }
    } finally {
      clearTimeout(timer);
    }

    const state = checkData?.state || 'PROCESSING';
    if (state === 'ACTIVE') {
      const elapsedAtActive = Date.now() - startTime;
      if (elapsedAtActive > totalTimeoutMs) {
        throw new Error(
          `Video file processing timed out after ${elapsedAtActive}ms (total timeout ${totalTimeoutMs}ms exceeded). File is not ready for analysis.`
        );
      }
      return { state: 'ACTIVE', uri: checkData?.uri };
    }

    if (state === 'FAILED') {
      const errorMsg = checkData?.error?.message || JSON.stringify(checkData?.error || checkData);
      throw new Error(`Google File API video processing failed (state: FAILED): ${errorMsg}`);
    }

    // State is still PROCESSING. Check remaining wall-clock time before sleeping.
    const elapsedAfterAttempt = Date.now() - startTime;
    const remainingAfterAttempt = totalTimeoutMs - elapsedAfterAttempt;
    if (remainingAfterAttempt <= 0) {
      throw new Error(
        `Video file processing timed out after ${elapsedAfterAttempt}ms (total timeout ${totalTimeoutMs}ms exceeded, attempts: ${attempts}). File is not ready for analysis.`
      );
    }

    if (attempts < maxAttempts) {
      const sleepDuration = Math.min(pollIntervalMs, remainingAfterAttempt);
      await sleep(sleepDuration);
    }
  }

  throw new Error(`Video file processing reached maximum attempts (${maxAttempts}) after ${Date.now() - startTime}ms. File is not ready for analysis.`);
}

/**
 * Deletes an uploaded file from the Gemini File API with an independent short timeout.
 * Uses real cancellation via AbortController so it never hangs analysis or error reporting.
 * Keeps timeout active through body reading.
 * Never throws, ensuring cleanup failures do not mask original analysis results or errors.
 */
export async function deleteVideoFromFileApi(
  fileName: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  options?: GeminiDeleteOptions
): Promise<{ success: boolean; status?: number; error?: string }> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`DELETE request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const normalizedName = fileName.startsWith('files/') ? fileName : `files/${fileName}`;
    const deleteUrl = `${GEMINI_API_V1BETA_BASE}/${normalizedName}?key=${encodeURIComponent(apiKey.trim())}`;
    const res = await fetchFn(deleteUrl, { method: 'DELETE', signal: controller.signal });
    if (!res.ok) {
      let errText = '';
      try {
        errText = await res.text();
      } catch (readErr: any) {
        const isAbort = controller.signal.aborted || readErr?.name === 'AbortError';
        if (isAbort) {
          return { success: false, status: res.status, error: `DELETE timed out while reading error body after ${timeoutMs}ms` };
        }
      }
      const sanitized = errText.replace(/key=[a-zA-Z0-9_\-]+/g, 'key=[REDACTED]');
      return { success: false, status: res.status, error: `DELETE returned ${res.status}: ${sanitized}` };
    }
    return { success: true, status: res.status };
  } catch (err: any) {
    const isAbort = controller.signal.aborted || err?.name === 'AbortError';
    const msg = isAbort ? `DELETE timed out after ${timeoutMs}ms` : (err?.message || String(err));
    const sanitized = msg.replace(/key=[a-zA-Z0-9_\-]+/g, 'key=[REDACTED]');
    return { success: false, error: sanitized };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Uploads a local file to the Google Gemini File API via resumable upload protocol,
 * then polls until the file state is 'ACTIVE' and ready for generateContent.
 */
export async function uploadVideoToFileApi(
  filePath: string,
  mimeType: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
  pollOptions?: GeminiFilePollOptions
): Promise<GeminiUploadResult> {
  const fileBytes = fs.readFileSync(filePath);
  const fileSize = fileBytes.length;
  const displayName = path.basename(filePath);

  // 1. Initiate resumable upload session
  const initUrl = `${GEMINI_UPLOAD_V1BETA_BASE}/files?key=${apiKey.trim()}`;
  const initRes = await fetchFn(initUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(fileSize),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      file: {
        display_name: displayName,
      },
    }),
  });

  if (!initRes.ok) {
    const errText = await initRes.text();
    const sanitized = errText.replace(/key=[a-zA-Z0-9_\-]+/g, 'key=[REDACTED]');
    throw new Error(`Failed to initiate Gemini File API upload: ${initRes.status} ${sanitized}`);
  }

  const uploadUrl = initRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Gemini File API did not return an upload URL (missing x-goog-upload-url header).');
  }

  // 2. Upload file content
  const uploadRes = await fetchFn(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(fileSize),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: fileBytes,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    const sanitized = errText.replace(/key=[a-zA-Z0-9_\-]+/g, 'key=[REDACTED]');
    throw new Error(`Failed to upload video content to Gemini File API: ${uploadRes.status} ${sanitized}`);
  }

  let uploadData: any;
  try {
    uploadData = await uploadRes.json();
  } catch (parseErr: any) {
    throw new Error(`Failed to parse Gemini File API upload response: ${parseErr.message}`);
  }

  const fileUri = uploadData?.file?.uri;
  const fileName = uploadData?.file?.name;
  let state = uploadData?.file?.state || 'PROCESSING';

  if (!fileUri || !fileName) {
    throw new Error('Gemini File API upload succeeded but no file URI or name was returned.');
  }

  // 3. Wait for ACTIVE state before returning
  if (state !== 'ACTIVE') {
    try {
      const activeInfo = await waitForFileActive(fileName, apiKey, fetchFn, pollOptions);
      state = activeInfo.state;
    } catch (pollErr) {
      // Best-effort cleanup of the remote file if processing failed or timed out
      try {
        await deleteVideoFromFileApi(fileName, apiKey, fetchFn);
      } catch {}
      throw pollErr;
    }
  }

  return { fileUri, fileName, state };
}
