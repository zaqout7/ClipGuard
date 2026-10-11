import assert from 'node:assert/strict';
import test from 'node:test';
import type { DetectionCategory, DetectionEvent } from '../src/types';
import { formatSecondsToTimestamp, mergeDetections } from '../src/utils/formatters';

function detection(
  id: string,
  category: DetectionCategory,
  startSeconds: number,
  endSeconds: number
): DetectionEvent {
  return {
    id,
    startSeconds,
    endSeconds,
    startTimestamp: '',
    endTimestamp: '',
    category,
    categoryLabel: category,
    confidence: 70,
    explanation: `evidence ${id}`,
    visualEvidence: `frame ${id}`,
    falsePositiveRisk: 'low',
    reviewStatus: 'needs_review',
    editorNotes: '',
    severity: 'medium',
  };
}

test('formats seconds consistently as video timestamps', () => {
  assert.equal(formatSecondsToTimestamp(65), '01:05');
  assert.equal(formatSecondsToTimestamp(3665), '01:01:05');
  assert.equal(formatSecondsToTimestamp(Number.NaN), '00:00');
});

test('merges same-category frames, preserves category overlap, and clamps padded intervals', () => {
  const merged = mergeDetections(
    [
      detection('later', 'possible_chest_exposure', 4, 5),
      detection('single-frame', 'possible_chest_exposure', 2, 2),
      detection('overlap', 'possible_rear_exposure', 3, 4),
    ],
    2,
    1,
    5
  );

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map(({ category, startSeconds, endSeconds }) => ({ category, startSeconds, endSeconds })),
    [
      { category: 'possible_chest_exposure', startSeconds: 1, endSeconds: 5 },
      { category: 'possible_rear_exposure', startSeconds: 2, endSeconds: 5 },
    ]
  );
  assert.equal(merged[0].verifiedFrameCount, undefined);
  assert.equal(merged[0].explanation, 'evidence single-frame evidence later');
});

test('combines explicit verified-frame counts without inventing verification', () => {
  const first = { ...detection('first', 'other_wardrobe_anomaly', 0, 0), verifiedFrameCount: 2 };
  const second = { ...detection('second', 'other_wardrobe_anomaly', 1, 1), verifiedFrameCount: 3 };
  const [merged] = mergeDetections([first, second], 1, 0);

  assert.equal(merged.verifiedFrameCount, 5);
});

test('retains single-frame matches and clamps zero-duration media boundaries', () => {
  const [single] = mergeDetections(
    [detection('single', 'other_wardrobe_anomaly', 0, 0)],
    0,
    0,
    0
  );

  assert.equal(single.startSeconds, 0);
  assert.equal(single.endSeconds, 0);
});

test('rejects invalid merge tolerances, padding, and detection intervals', () => {
  const valid = detection('valid', 'other_wardrobe_anomaly', 0, 1);
  const reversed = detection('reversed', 'other_wardrobe_anomaly', 2, 1);

  assert.throws(() => mergeDetections([valid], -1, 0), RangeError);
  assert.throws(() => mergeDetections([valid], 0, Number.NaN), RangeError);
  assert.throws(() => mergeDetections([reversed], 0, 0), RangeError);
});
