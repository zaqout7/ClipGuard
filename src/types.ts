export type ReviewStatus = 'needs_review' | 'accepted' | 'dismissed';
export type Severity = 'low' | 'medium' | 'high';
export type FalsePositiveRisk = 'low' | 'medium' | 'high';
export type AnalysisMode = 'preset_demo' | 'real_video_analysis';
export type DetectionCategory =
  | 'possible_chest_exposure'
  | 'possible_rear_exposure'
  | 'clothing_shift_revealing'
  | 'undergarment_slip'
  | 'other_wardrobe_anomaly'
  | 'nsfw_image_classification'
  | 'covered_buttocks_outline';

export interface VideoMetadata {
  id: string;
  url: string;
  title: string;
  author: string;
  durationSeconds: number;
  durationFormatted: string;
  thumbnailUrl: string;
  sourceType: 'youtube' | 'upload' | 'preset';
}

export interface DetectionEvent {
  id: string;
  startSeconds: number;
  endSeconds: number;
  startTimestamp: string;
  endTimestamp: string;
  category: DetectionCategory;
  categoryLabel: string;
  confidence?: number;
  modelScore?: number;
  scoreSemantics?: string;
  explanation: string;
  visualEvidence: string;
  falsePositiveRisk?: FalsePositiveRisk;
  reviewStatus: ReviewStatus;
  editorNotes: string;
  severity?: Severity;
  verifiedFrameCount?: number;
  frameCoverageNotice?: string;
  diagnostic?: DetectionDiagnostic;
}

export interface DiagnosticFrameRecord {
  frameIndex: number;
  presentationSeconds: number;
  timestamp: string;
  detectorId: string;
  rawPredictions: Array<{ className: string; score: number }>;
  thresholdApplied: number;
  ruleTriggered: string;
}

export interface DetectionDiagnostic {
  detectorId: string;
  thresholdApplied: number;
  positiveFrameCount: number;
  totalEvaluatedFrames?: number;
  scoreCalculation: string;
  frames: DiagnosticFrameRecord[];
}

export type AnalysisEngine = 'local_onnx' | 'gemini_video';

export interface GeminiConfig {
  apiKey?: string;
  model: string;
  fps: number;
  userConfirmedProjectBillingIntent: boolean;
  userConsentedVideoUpload: boolean;
}

export interface GeminiAnalysisReport {
  requestedFps: number;
  samplingIntervalSec: number;
  samplingRateDescription: string;
  apiCallSucceeded: boolean;
  effectiveFpsConfirmedByApi: boolean;
  coverageVerification: 'unverified' | 'verified';
  model: string;
  frameCoverageNotice: string;
  interFrameWarning: string;
  billingNotice: string;
}

export interface AnalysisOptions {
  sensitivity: number;
  mergeToleranceSec: number;
  bufferSec: number;
  sampleIntervalSec: number;
  categories: Record<DetectionCategory, boolean>;
  debugLogging?: boolean;
  engine?: AnalysisEngine;
  geminiConfig?: GeminiConfig;
}

export interface AnalysisProgress {
  phase: 'idle' | 'preparing_video' | 'loading_model' | 'sampling_frames' | 'analyzing_candidates' | 'verifying_events' | 'generating_timestamps' | 'complete' | 'cancelled' | 'error';
  progressPercent: number | null;
  statusText: string;
  details?: string;
  currentCandidateCount?: number;
  processedFrames?: number;
  totalFrames?: number;
  incomplete?: boolean;
}

export interface SystemSpecs {
  success: boolean;
  platform: string;
  cpuCores: number;
  cpuModel: string;
  totalMemGb: number;
  freeMemGb: number;
  localAnalysisAvailable: boolean;
  localAnalysisReason: string;
  modelName?: string;
  modelRevision?: string;
  modelLabels?: string[];
  inferenceProvider?: string;
}

export interface PresetScenario {
  name: string;
  summary: string;
  metadata: VideoMetadata;
  detections: DetectionEvent[];
}
