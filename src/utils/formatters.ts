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
    nsfw_image_classification: 'Potential NSFW / explicit content',
    clothing_shift_revealing: 'Covered breast / cleavage (broad review)',
    undergarment_slip: 'Covered pelvic region (broad review)',
    other_wardrobe_anomaly: 'Exposed midriff / belly (broad review)',
    covered_buttocks_outline: 'Visible buttock outline through clothing',
  };

  return labels[category] ?? 'Review candidate';
}

export function mergeEventExplanations(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  if (a === b) return a;

  const disclaimer = 'This is a potential match requiring human review, not a definitive content judgment.';
  const hasDisclaimer = a.includes(disclaimer) || b.includes(disclaimer);

  const cleanA = a.replaceAll(disclaimer, '').replace(/\.\s*$/, '').trim();
  const cleanB = b.replaceAll(disclaimer, '').replace(/\.\s*$/, '').trim();

  if (cleanA.startsWith('Detected: ') && cleanB.startsWith('Detected: ')) {
    const partsA = cleanA.replace('Detected: ', '').split(', ');
    const partsB = cleanB.replace('Detected: ', '').split(', ');
    const combinedParts = [...new Set([...partsA, ...partsB].filter(Boolean))].join(', ');
    const base = `Detected: ${combinedParts}.`;
    return hasDisclaimer ? `${base} ${disclaimer}` : base;
  }

  const segments = [...new Set([cleanA, cleanB].filter(Boolean))];
  const joined = segments.join(' ');
  if (hasDisclaimer) {
    return joined.endsWith('.') ? `${joined} ${disclaimer}` : `${joined}. ${disclaimer}`;
  }
  return joined;
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
        explanation: mergeEventExplanations(last.explanation, item.explanation),
        visualEvidence: [...new Set([last.visualEvidence, item.visualEvidence].filter(Boolean))].join(' '),
        falsePositiveRisk,
        severity: last.severity ?? item.severity,
        frameCoverageNotice: last.frameCoverageNotice ?? item.frameCoverageNotice,
        verifiedFrameCount:
          last.verifiedFrameCount === undefined && item.verifiedFrameCount === undefined
            ? undefined
            : (last.verifiedFrameCount ?? 0) + (item.verifiedFrameCount ?? 0),
        diagnostic:
          last.diagnostic && item.diagnostic
            ? {
                ...last.diagnostic,
                positiveFrameCount: (last.diagnostic.positiveFrameCount || 0) + (item.diagnostic.positiveFrameCount || 0),
                frames: [...last.diagnostic.frames, ...item.diagnostic.frames],
              }
            : last.diagnostic || item.diagnostic,
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
