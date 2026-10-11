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
  | 'nsfw_image_classification';

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
}

export interface AnalysisOptions {
  sensitivity: number;
  mergeToleranceSec: number;
  bufferSec: number;
  sampleIntervalSec: number;
  categories: Record<DetectionCategory, boolean>;
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
