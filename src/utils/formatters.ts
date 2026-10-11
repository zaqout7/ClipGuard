import type { DetectionCategory, DetectionEvent } from '../types';

export function formatSecondsToTimestamp(totalSeconds: number): string {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, totalSeconds) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = Math.floor(safeSeconds % 60);

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function getCategoryLabel(category: DetectionCategory | string): string {
  const labels: Record<string, string> = {
    possible_chest_exposure: 'Possible chest exposure',
    possible_rear_exposure: 'Possible rear exposure',
    clothing_shift_revealing: 'Clothing shift revealing',
    undergarment_slip: 'Undergarment slip',
    other_wardrobe_anomaly: 'Other wardrobe anomaly',
    nsfw_image_classification: 'Potential NSFW content',
  };

  return labels[category] ?? 'Wardrobe anomaly';
}

export function mergeDetections(
  detections: DetectionEvent[],
  toleranceSec: number,
  bufferSec: number,
  durationSeconds?: number
): DetectionEvent[] {
  if (!detections.length) return [];
  if (!Number.isFinite(toleranceSec) || toleranceSec < 0) {
    throw new RangeError('Detection merge tolerance must be a finite non-negative number.');
  }
  if (!Number.isFinite(bufferSec) || bufferSec < 0) {
    throw new RangeError('Detection padding must be a finite non-negative number.');
  }
  if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds < 0)) {
    throw new RangeError('Video duration must be a finite non-negative number when provided.');
  }

  const byCategory = new Map<DetectionCategory, DetectionEvent[]>();
  for (const detection of detections) {
    if (!Number.isFinite(detection.startSeconds) || !Number.isFinite(detection.endSeconds)) {
      throw new RangeError(`Detection "${detection.id}" has a non-finite timestamp.`);
    }
    if (detection.endSeconds < detection.startSeconds) {
      throw new RangeError(`Detection "${detection.id}" ends before it starts.`);
    }

    const categoryItems = byCategory.get(detection.category) ?? [];
    categoryItems.push(detection);
    byCategory.set(detection.category, categoryItems);
  }

  const merged: DetectionEvent[] = [];

  for (const categoryItems of byCategory.values()) {
    const sorted = [...categoryItems].sort(
      (a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds || a.id.localeCompare(b.id)
    );

    for (const item of sorted) {
      const last = merged.length > 0 && merged[merged.length - 1].category === item.category
        ? merged[merged.length - 1]
        : undefined;
      if (!last || item.startSeconds - last.endSeconds > toleranceSec) {
        merged.push({ ...item });
        continue;
      }

      const startSeconds = Math.min(last.startSeconds, item.startSeconds);
      const endSeconds = Math.max(last.endSeconds, item.endSeconds);
      const riskRank = { low: 0, medium: 1, high: 2 };
      const falsePositiveRisk = last.falsePositiveRisk === undefined
        ? item.falsePositiveRisk
        : item.falsePositiveRisk === undefined
          ? last.falsePositiveRisk
          : riskRank[last.falsePositiveRisk] >= riskRank[item.falsePositiveRisk]
            ? last.falsePositiveRisk
            : item.falsePositiveRisk;
      merged[merged.length - 1] = {
        ...last,
        startSeconds,
        endSeconds,
        startTimestamp: formatSecondsToTimestamp(startSeconds),
        endTimestamp: formatSecondsToTimestamp(endSeconds),
        confidence:
          last.confidence === undefined || item.confidence === undefined
            ? undefined
            : Math.max(last.confidence, item.confidence),
        modelScore:
          last.modelScore === undefined || item.modelScore === undefined
            ? undefined
            : Math.max(last.modelScore, item.modelScore),
        scoreSemantics: last.scoreSemantics ?? item.scoreSemantics,
        explanation: [...new Set([last.explanation, item.explanation].filter(Boolean))].join(' '),
        visualEvidence: [...new Set([last.visualEvidence, item.visualEvidence].filter(Boolean))].join(' '),
        falsePositiveRisk,
        severity: last.severity ?? item.severity,
        verifiedFrameCount:
          last.verifiedFrameCount === undefined && item.verifiedFrameCount === undefined
            ? undefined
            : (last.verifiedFrameCount ?? 0) + (item.verifiedFrameCount ?? 0),
      };
    }
  }

  return merged
    .map((item) => {
      const startSeconds = Math.max(0, item.startSeconds - bufferSec);
      const paddedEnd = item.endSeconds + bufferSec;
      const clampedEnd =
        durationSeconds === undefined ? paddedEnd : Math.min(durationSeconds, paddedEnd);
      const endSeconds = Math.max(startSeconds, clampedEnd);
      return {
        ...item,
        startSeconds,
        endSeconds,
        startTimestamp: formatSecondsToTimestamp(startSeconds),
        endTimestamp: formatSecondsToTimestamp(endSeconds),
        categoryLabel: getCategoryLabel(item.category),
      };
    })
    .sort((a, b) => a.startSeconds - b.startSeconds || a.category.localeCompare(b.category));
}
