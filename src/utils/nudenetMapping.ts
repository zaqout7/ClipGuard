import type { DetectionCategory } from '../types';

/**
 * Human-readable labels for every NudeNet class that we surface to the
 * reviewer.  Classes that are not in this map are silently ignored.
 */
export const NUDENET_CLASS_LABELS: Record<string, string> = {
  ANUS_EXPOSED:                'Exposed Genitalia / Anus',
  BELLY_EXPOSED:               'Exposed Belly / Midriff',
  BUTTOCKS_EXPOSED:            'Exposed Buttocks / Rear',
  FEMALE_BREAST_COVERED:       'Covered Breast / Cleavage',
  FEMALE_BREAST_EXPOSED:       'Exposed Breast / Chest',
  FEMALE_GENITALIA_COVERED:    'Covered Pelvic Region',
  FEMALE_GENITALIA_EXPOSED:    'Exposed Female Genitalia',
  MALE_BREAST_EXPOSED:         'Exposed Male Chest',
  MALE_GENITALIA_EXPOSED:      'Exposed Male Genitalia',
};

/**
 * Map each NudeNet class name to the ClipGuard DetectionCategory it best fits.
 * Returns null for classes that should not produce a separate detection event
 * (they may still appear in visualEvidence of a related event).
 *
 * Normal clothed anatomy (such as FEMALE_GENITALIA_COVERED, representing pants/skirts)
 * maps to null so everyday clothing is never flagged as a malfunction or slip.
 */
export function nudenetClassToCategory(className: string): DetectionCategory | null {
  switch (className) {
    // Explicit anatomical exposure
    case 'FEMALE_BREAST_EXPOSED':
    case 'MALE_BREAST_EXPOSED':
      return 'possible_chest_exposure';

    case 'BUTTOCKS_EXPOSED':
      return 'possible_rear_exposure';

    case 'FEMALE_GENITALIA_EXPOSED':
    case 'MALE_GENITALIA_EXPOSED':
    case 'ANUS_EXPOSED':
    case 'VIT_NSFW':
      return 'nsfw_image_classification';

    // Optional broad anatomical review (disabled by default in review settings)
    case 'FEMALE_BREAST_COVERED':
      return 'clothing_shift_revealing'; // Mapped to covered breast / cleavage review category

    case 'BELLY_EXPOSED':
      return 'other_wardrobe_anomaly'; // Mapped to exposed midriff review category

    // Benign clothed anatomy: pants, skirts, shorts, covered midriff, faces, feet
    case 'FEMALE_GENITALIA_COVERED':
    default:
      return null;
  }
}

export interface NudeNetDetection {
  className: string;
  score: number;
  box?: [number, number, number, number];
}

/**
 * Build a concise, reviewer-facing explanation string from a list of detections
 * for a single frame.
 */
export function buildDetectionExplanation(detections: NudeNetDetection[]): string {
  if (!detections.length) return '';

  const parts = detections
    .map((d) => {
      const label = NUDENET_CLASS_LABELS[d.className] ?? d.className;
      const pct = (d.score * 100).toFixed(0);
      return `${label} (${pct}%)`;
    })
    .join(', ');

  return `Detected: ${parts}. This is a potential match requiring human review, not a definitive content judgment.`;
}

/**
 * Build a brief visual-evidence string listing body-part detections.
 */
export function buildVisualEvidence(detections: NudeNetDetection[]): string {
  if (!detections.length) return '';

  const counts = new Map<string, number>();
  for (const d of detections) {
    const label = NUDENET_CLASS_LABELS[d.className] ?? d.className;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([label, n]) => (n > 1 ? `${n}× ${label}` : label))
    .join('; ');
}

/**
 * Derive a scoreSemantics string appropriate for the detector backend.
 */
export function buildScoreSemantics(backend: 'nudenet' | 'vit', topScore: number): string {
  if (backend === 'nudenet') {
    return `NudeNet YOLOv8n object-detection confidence (top: ${(topScore * 100).toFixed(1)}%). `
      + 'Not a calibrated probability; review each flagged segment before editorial action.';
  }
  return `ViT softmax score for the broad NSFW image class (${(topScore * 100).toFixed(1)}%). `
    + 'Not a calibrated probability; human review is required.';
}

// ---------------------------------------------------------------------------
// NudeNet class definitions (exact 18-class model metadata order)
// ---------------------------------------------------------------------------

export const NUDENET_CLASSES: readonly string[] = [
  'FEMALE_GENITALIA_COVERED', // 0
  'FACE_FEMALE',              // 1
  'BUTTOCKS_EXPOSED',         // 2
  'FEMALE_BREAST_EXPOSED',    // 3
  'FEMALE_GENITALIA_EXPOSED', // 4
  'MALE_BREAST_EXPOSED',      // 5
  'ANUS_EXPOSED',             // 6
  'FEET_EXPOSED',             // 7
  'BELLY_COVERED',            // 8
  'FEET_COVERED',             // 9
  'ARMPITS_COVERED',          // 10
  'ARMPITS_EXPOSED',          // 11
  'FACE_MALE',                // 12
  'BELLY_EXPOSED',            // 13
  'MALE_GENITALIA_EXPOSED',   // 14
  'ANUS_COVERED',             // 15
  'FEMALE_BREAST_COVERED',    // 16
  'BUTTOCKS_COVERED',         // 17
] as const;

export const NUDENET_RELEVANT_CLASSES = new Set([
  'ANUS_EXPOSED',
  'BELLY_EXPOSED',
  'BUTTOCKS_EXPOSED',
  'FEMALE_BREAST_COVERED',
  'FEMALE_BREAST_EXPOSED',
  'FEMALE_GENITALIA_EXPOSED',
  'MALE_BREAST_EXPOSED',
  'MALE_GENITALIA_EXPOSED',
]);

export const NUDENET_INPUT_SIZE = 320;
export const NUDENET_CONF_THRESHOLD = 0.25; // 0.25 matching official NudeNet reference contract
export const NUDENET_IOU_THRESHOLD = 0.45;  // 0.45 matching official NudeNet NMS IoU

/**
 * Computes draw dimensions that preserve the aspect ratio of the source video
 * within the square model canvas (letterboxing at top-left with black padding).
 */
export function computeLetterboxDimensions(
  videoWidth: number,
  videoHeight: number,
  canvasSize: number = NUDENET_INPUT_SIZE,
): { drawWidth: number; drawHeight: number } {
  const safeW = Number.isFinite(videoWidth) && videoWidth > 0 ? videoWidth : canvasSize;
  const safeH = Number.isFinite(videoHeight) && videoHeight > 0 ? videoHeight : canvasSize;
  const scale = canvasSize / Math.max(safeW, safeH);
  const drawWidth = Math.min(canvasSize, Math.max(1, Math.round(safeW * scale)));
  const drawHeight = Math.min(canvasSize, Math.max(1, Math.round(safeH * scale)));
  return { drawWidth, drawHeight };
}

/**
 * Converts a flat RGBA pixel buffer into an NCHW planar Float32Array
 * normalized to [0.0, 1.0] for NudeNet YOLOv8 inference.
 * Matches model contract: channel order RGB, values in [0.0, 1.0].
 */
export function preprocessRgbaToNudeNetPlanar(
  pixels: Uint8ClampedArray | Uint8Array,
  width: number = NUDENET_INPUT_SIZE,
  height: number = NUDENET_INPUT_SIZE,
): Float32Array {
  const planeLength = width * height;
  const expectedBytes = planeLength * 4;
  if (pixels.length !== expectedBytes) {
    throw new Error(`Expected ${width}×${height} RGBA image (${expectedBytes} bytes), got ${pixels.length}.`);
  }
  const inputData = new Float32Array(3 * planeLength);
  for (let i = 0; i < planeLength; i++) {
    const off = i * 4;
    inputData[i]                   = pixels[off]     / 255.0; // R
    inputData[planeLength + i]     = pixels[off + 1] / 255.0; // G
    inputData[planeLength * 2 + i] = pixels[off + 2] / 255.0; // B
  }
  return inputData;
}

export interface RawBox {
  className: string;
  score: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DecodedNudeNet {
  detections: NudeNetDetection[];
  rawTopPredictions: Array<{ className: string; score: number }>;
}

/**
 * Decodes the raw output tensor from NudeNet 320n.onnx (shape [1, 22, 2100]).
 * Coordinates are de-normalized against drawWidth and drawHeight to correctly
 * map onto the original video frame [0, 1] without aspect ratio distortion.
 * Anchors whose center falls in the letterbox padding region are discarded.
 */
export function decodeNudeNetOutput(
  raw: Float32Array,
  numAnchors: number,
  _inferenceMs?: number,
  drawWidth: number = NUDENET_INPUT_SIZE,
  drawHeight: number = NUDENET_INPUT_SIZE,
  confThreshold: number = NUDENET_CONF_THRESHOLD,
  iouThreshold: number = NUDENET_IOU_THRESHOLD,
): DecodedNudeNet {
  const numClasses = 18;
  const boxes: RawBox[] = [];
  const maxScorePerClass = new Float32Array(numClasses);

  for (let a = 0; a < numAnchors; a++) {
    const cx = raw[0 * numAnchors + a];
    const cy = raw[1 * numAnchors + a];
    const w  = raw[2 * numAnchors + a];
    const h  = raw[3 * numAnchors + a];

    // Suppress any anchor whose center falls in the black letterbox padding
    if (cx < 0 || cy < 0 || cx > drawWidth || cy > drawHeight) continue;

    let bestScore = -1;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c++) {
      const score = raw[(4 + c) * numAnchors + a];
      if (score > maxScorePerClass[c]) {
        maxScorePerClass[c] = score;
      }
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    if (bestScore < confThreshold) continue;
    const className = NUDENET_CLASSES[bestClass] ?? 'UNKNOWN';
    if (!NUDENET_RELEVANT_CLASSES.has(className)) continue;

    // Convert centre -> corner coords, normalized to [0,1] of the original video frame
    const x1 = Math.max(0, Math.min(1, (cx - w / 2) / drawWidth));
    const y1 = Math.max(0, Math.min(1, (cy - h / 2) / drawHeight));
    const x2 = Math.max(0, Math.min(1, (cx + w / 2) / drawWidth));
    const y2 = Math.max(0, Math.min(1, (cy + h / 2) / drawHeight));
    if (x2 <= x1 || y2 <= y1) continue;

    boxes.push({
      className,
      score: bestScore,
      x1,
      y1,
      x2,
      y2,
    });
  }

  // Top predictions across all 18 classes for diagnostic logging
  const rawTopPredictions: Array<{ className: string; score: number }> = [];
  for (let c = 0; c < numClasses; c++) {
    if (maxScorePerClass[c] >= 0.15) {
      rawTopPredictions.push({
        className: NUDENET_CLASSES[c] ?? `CLASS_${c}`,
        score: Math.round(maxScorePerClass[c] * 1000) / 1000,
      });
    }
  }
  rawTopPredictions.sort((a, b) => b.score - a.score);

  if (!boxes.length) {
    return { detections: [], rawTopPredictions };
  }

  const kept = nmsPerClass(boxes, iouThreshold);

  return {
    detections: kept.map((b) => ({
      className: b.className,
      score: b.score,
      box: [b.x1, b.y1, b.x2, b.y2] as [number, number, number, number],
    })),
    rawTopPredictions,
  };
}

export function nmsPerClass(boxes: RawBox[], iouThreshold: number): RawBox[] {
  const byClass = new Map<string, RawBox[]>();
  for (const b of boxes) {
    const arr = byClass.get(b.className) ?? [];
    arr.push(b);
    byClass.set(b.className, arr);
  }

  const result: RawBox[] = [];
  for (const classBoxes of byClass.values()) {
    classBoxes.sort((a, b) => b.score - a.score);
    const suppressed = new Uint8Array(classBoxes.length);
    for (let i = 0; i < classBoxes.length; i++) {
      if (suppressed[i]) continue;
      result.push(classBoxes[i]);
      for (let j = i + 1; j < classBoxes.length; j++) {
        if (suppressed[j]) continue;
        if (iou(classBoxes[i], classBoxes[j]) > iouThreshold) {
          suppressed[j] = 1;
        }
      }
    }
  }
  return result;
}

export function iou(a: RawBox, b: RawBox): number {
  const interX1 = Math.max(a.x1, b.x1);
  const interY1 = Math.max(a.y1, b.y1);
  const interX2 = Math.min(a.x2, b.x2);
  const interY2 = Math.min(a.y2, b.y2);
  const interArea = Math.max(0, interX2 - interX1) * Math.max(0, interY2 - interY1);
  if (interArea === 0) return 0;
  const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
  const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
  return interArea / (areaA + areaB - interArea);
}
