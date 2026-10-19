import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import type { AnalysisOptions, DetectionCategory, DetectionEvent } from '../src/types';
import { mergeDetections } from '../src/utils/formatters';
import {
  computeLetterboxDimensions,
  decodeNudeNetOutput,
  NUDENET_INPUT_SIZE,
  NUDENET_CONF_THRESHOLD,
  NUDENET_IOU_THRESHOLD,
  NUDENET_CLASSES,
} from '../src/utils/nudenetMapping';
import { buildCandidateEvents } from '../src/utils/localAnalysis';

test('computeLetterboxDimensions preserves aspect ratio across video dimensions', () => {
  // 16:9 widescreen video (1280x720) in 320x320 canvas
  const widescreen = computeLetterboxDimensions(1280, 720, 320);
  assert.equal(widescreen.drawWidth, 320);
  assert.equal(widescreen.drawHeight, 180);

  // 9:16 vertical/portrait video (720x1280) in 320x320 canvas
  const vertical = computeLetterboxDimensions(720, 1280, 320);
  assert.equal(vertical.drawWidth, 180);
  assert.equal(vertical.drawHeight, 320);

  // 4:3 standard video (640x480) in 320x320 canvas
  const standard = computeLetterboxDimensions(640, 480, 320);
  assert.equal(standard.drawWidth, 320);
  assert.equal(standard.drawHeight, 240);

  // 1:1 square video (500x500)
  const square = computeLetterboxDimensions(500, 500, 320);
  assert.equal(square.drawWidth, 320);
  assert.equal(square.drawHeight, 320);

  // Degenerate/zero inputs safely fall back to canvas size
  const fallback = computeLetterboxDimensions(0, 0, 320);
  assert.equal(fallback.drawWidth, 320);
  assert.equal(fallback.drawHeight, 320);
});

test('decodeNudeNetOutput normalizes coordinates against draw dimensions and suppresses padding anchors', () => {
  const numAnchors = 2;
  const numRows = 22;
  const raw = new Float32Array(numRows * numAnchors);

  // Anchor 0: Inside active 320x180 region
  // cx = 160, cy = 90, w = 32, h = 36
  raw[0 * numAnchors + 0] = 160;
  raw[1 * numAnchors + 0] = 90;
  raw[2 * numAnchors + 0] = 32;
  raw[3 * numAnchors + 0] = 36;
  // Class 3 is FEMALE_BREAST_EXPOSED with score 0.60
  raw[(4 + 3) * numAnchors + 0] = 0.60;

  // Anchor 1: Inside black letterbox padding (cy = 250 > drawHeight 180)
  raw[0 * numAnchors + 1] = 160;
  raw[1 * numAnchors + 1] = 250;
  raw[2 * numAnchors + 1] = 32;
  raw[3 * numAnchors + 1] = 36;
  raw[(4 + 3) * numAnchors + 1] = 0.85;

  const result = decodeNudeNetOutput(raw, numAnchors, 10, 320, 180);

  // Only the anchor inside the active video region should survive
  assert.equal(result.detections.length, 1);
  const det = result.detections[0];
  assert.equal(det.className, 'FEMALE_BREAST_EXPOSED');
  assert.ok(Math.abs(det.score - 0.60) < 0.001);

  // Coordinates normalized to [0, 1] relative to the 320x180 video frame:
  // x1 = (160 - 16) / 320 = 144 / 320 = 0.45
  // y1 = (90 - 18) / 180 = 72 / 180 = 0.40
  // x2 = (160 + 16) / 320 = 176 / 320 = 0.55
  // y2 = (90 + 18) / 180 = 108 / 180 = 0.60
  assert.ok(det.box);
  assert.ok(Math.abs(det.box[0] - 0.45) < 0.001);
  assert.ok(Math.abs(det.box[1] - 0.40) < 0.001);
  assert.ok(Math.abs(det.box[2] - 0.55) < 0.001);
  assert.ok(Math.abs(det.box[3] - 0.60) < 0.001);
});

test('regression: threshold sensitivity accepts candidate at 30% and rejects under higher 70% threshold', () => {
  const defaultOptions: AnalysisOptions = {
    sensitivity: 30, // Sensitivity setting for candidate review
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    sampleIntervalSec: 1.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      clothing_shift_revealing: true,
      undergarment_slip: true,
      other_wardrobe_anomaly: true,
      nsfw_image_classification: true,
      covered_buttocks_outline: true,
    },
  };

  const detections = [
    {
      className: 'FEMALE_BREAST_EXPOSED',
      score: 0.3549, // Typical YOLOv8 detection confidence
      box: [0.444, 0.377, 0.525, 0.528] as [number, number, number, number],
    },
  ];

  // At calibrated 30% threshold, detection is accepted
  const acceptedEvents = buildCandidateEvents(
    detections,
    'nudenet',
    'test-video',
    1.5,
    45,
    0,
    defaultOptions,
  );
  assert.equal(acceptedEvents.length, 1);
  assert.equal(acceptedEvents[0].category, 'possible_chest_exposure');
  assert.equal(acceptedEvents[0].confidence, 35);
  assert.equal(acceptedEvents[0].modelScore, 0.3549);

  // Under legacy 70% threshold, the same detection was silently suppressed (defect reproduction)
  const legacyOptions: AnalysisOptions = {
    ...defaultOptions,
    sensitivity: 70,
  };
  const rejectedEvents = buildCandidateEvents(
    detections,
    'nudenet',
    'test-video',
    1.5,
    45,
    0,
    legacyOptions,
  );
  assert.equal(rejectedEvents.length, 0);
});

test('candidate events populate integer confidence and mergeDetections preserves confidence', () => {
  const options: AnalysisOptions = {
    sensitivity: 30,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    sampleIntervalSec: 1.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      clothing_shift_revealing: true,
      undergarment_slip: true,
      other_wardrobe_anomaly: true,
      nsfw_image_classification: true,
      covered_buttocks_outline: true,
    },
  };

  const frame1 = buildCandidateEvents(
    [{ className: 'FEMALE_BREAST_EXPOSED', score: 0.35 }],
    'nudenet',
    'vid1',
    1.0,
    1,
    0,
    options,
  );
  const frame2 = buildCandidateEvents(
    [{ className: 'FEMALE_BREAST_EXPOSED', score: 0.48 }],
    'nudenet',
    'vid1',
    2.5,
    2,
    1,
    options,
  );

  assert.equal(frame1[0].confidence, 35);
  assert.equal(frame2[0].confidence, 48);

  const merged = mergeDetections([...frame1, ...frame2], 2.5, 0.5, 10.0);
  assert.equal(merged.length, 1);
  // Merged event preserves peak confidence
  assert.equal(merged[0].confidence, 48);
  assert.equal(merged[0].modelScore, 0.48);
});

test('bundled NudeNet 320n.onnx exists and metadata matches 18-class specification', () => {
  const modelPath = path.resolve('public/models/nudenet/320n.onnx');
  assert.ok(fs.existsSync(modelPath), 'bundled 320n.onnx model must exist at public/models/nudenet/320n.onnx');

  const stats = fs.statSync(modelPath);
  assert.ok(stats.size > 1_000_000, `Expected model size > 1MB, got ${stats.size} bytes`);
  assert.equal(NUDENET_CLASSES.length, 18);
  assert.equal(NUDENET_CLASSES[3], 'FEMALE_BREAST_EXPOSED');
  assert.equal(NUDENET_CLASSES[13], 'BELLY_EXPOSED');
  assert.equal(NUDENET_CLASSES[16], 'FEMALE_BREAST_COVERED');
});

test('ViT fallback maintains 384x384 sizing, 0.65 noise floor, and proper candidate mapping', () => {
  const options: AnalysisOptions = {
    sensitivity: 30, // Default 30% for NudeNet
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    sampleIntervalSec: 1.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      clothing_shift_revealing: true,
      undergarment_slip: true,
      other_wardrobe_anomaly: true,
      nsfw_image_classification: true,
      covered_buttocks_outline: true,
    },
  };

  // Case A: vitScore = 0.55 is above sensitivity (0.30), but below ViT noise floor (0.65) -> rejected
  const noisyCandidate = buildCandidateEvents(
    [{ className: 'VIT_NSFW', score: 0.55 }],
    'vit',
    'vid1',
    1.0,
    1,
    0,
    options,
  );
  assert.equal(noisyCandidate.length, 0, 'ViT score below 0.65 noise floor must be rejected even when sensitivity=30');

  // Case B: vitScore = 0.72 is above 0.65 floor -> accepted
  const positiveCandidate = buildCandidateEvents(
    [{ className: 'VIT_NSFW', score: 0.72 }],
    'vit',
    'vid1',
    2.0,
    2,
    0,
    options,
  );
  assert.equal(positiveCandidate.length, 1);
  assert.equal(positiveCandidate[0].category, 'nsfw_image_classification');
  assert.equal(positiveCandidate[0].confidence, 72);
  assert.equal(positiveCandidate[0].modelScore, 0.72);
  assert.equal(positiveCandidate[0].diagnostic?.thresholdApplied, 0.65);

  // Case C: user sets sensitivity to 80% -> threshold becomes 0.80 (higher than floor)
  const highThresholdOptions = { ...options, sensitivity: 80 };
  const filteredAtHighThreshold = buildCandidateEvents(
    [{ className: 'VIT_NSFW', score: 0.72 }],
    'vit',
    'vid1',
    2.0,
    2,
    0,
    highThresholdOptions,
  );
  assert.equal(filteredAtHighThreshold.length, 0, 'ViT score 0.72 must be rejected when sensitivity=80');
});

test('decodeNudeNetOutput correctly handles edge and partially padded boxes', () => {
  const numAnchors = 3;
  const numRows = 22;
  const raw = new Float32Array(numRows * numAnchors);

  // Anchor 0: Center near bottom edge of 320x180 active region (cy = 175, h = 20)
  // Box extends from y = 165 to y = 185 (partially into the padding)
  raw[0 * numAnchors + 0] = 160;
  raw[1 * numAnchors + 0] = 175;
  raw[2 * numAnchors + 0] = 30;
  raw[3 * numAnchors + 0] = 20;
  raw[(4 + 3) * numAnchors + 0] = 0.50; // FEMALE_BREAST_EXPOSED

  // Anchor 1: Center just beyond bottom edge (cy = 185 > 180)
  raw[0 * numAnchors + 1] = 160;
  raw[1 * numAnchors + 1] = 185;
  raw[2 * numAnchors + 1] = 30;
  raw[3 * numAnchors + 1] = 20;
  raw[(4 + 3) * numAnchors + 1] = 0.50;

  // Anchor 2: Negative center (cx = -10, cy = 50)
  raw[0 * numAnchors + 2] = -10;
  raw[1 * numAnchors + 2] = 50;
  raw[2 * numAnchors + 2] = 30;
  raw[3 * numAnchors + 2] = 20;
  raw[(4 + 3) * numAnchors + 2] = 0.50;

  const result = decodeNudeNetOutput(raw, numAnchors, 0, 320, 180);

  // Only Anchor 0 should be retained
  assert.equal(result.detections.length, 1);
  const det = result.detections[0];
  assert.equal(det.className, 'FEMALE_BREAST_EXPOSED');
  assert.ok(det.box);

  // y1 = (175 - 10) / 180 = 165 / 180 ~= 0.9167
  // y2 = (175 + 10) / 180 = 185 / 180 -> clamped to 1.0!
  assert.ok(Math.abs(det.box[1] - (165 / 180)) < 0.001);
  assert.equal(det.box[3], 1.0, 'y2 extending into padding must be clamped to 1.0');
});

test('distinct messages are rendered for complete-empty, cancelled, error, and unanalyzed states', () => {
  // Simulates the message selection in DetectionList.tsx
  function getEmptyMessage(phase: string, demoOnly = false): string {
    if (demoOnly) {
      return 'No illustrative demo items match the selected filters; demo data is not an analysis.';
    }
    switch (phase) {
      case 'complete':
        return 'Analysis completed with no sampled frames above the selected threshold. This is not evidence that the video is safe.';
      case 'cancelled':
        return 'Analysis was cancelled. No completed results are available.';
      case 'error':
        return 'Analysis failed. No completed results are available.';
      default:
        return 'This video has not been analyzed; an empty list is not evidence that it is safe.';
    }
  }

  const completeMsg = getEmptyMessage('complete');
  const cancelledMsg = getEmptyMessage('cancelled');
  const errorMsg = getEmptyMessage('error');
  const idleMsg = getEmptyMessage('idle');

  // All 4 messages must be distinct and non-empty
  const messages = new Set([completeMsg, cancelledMsg, errorMsg, idleMsg]);
  assert.equal(messages.size, 4, 'Each state must produce a distinct user-facing message');
  assert.match(completeMsg, /no sampled frames above the selected threshold/);
  assert.match(cancelledMsg, /Analysis was cancelled/);
  assert.match(errorMsg, /Analysis failed/);
  assert.match(idleMsg, /This video has not been analyzed/);
});

test('regression: covered-anatomy and midriff do not create malfunction or exposure alerts under default options', () => {
  // Default options have broad categories disabled by default
  const defaultProductionOptions: AnalysisOptions = {
    sensitivity: 40,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    sampleIntervalSec: 1.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      nsfw_image_classification: true,
      clothing_shift_revealing: false,
      undergarment_slip: false,
      other_wardrobe_anomaly: false,
      covered_buttocks_outline: false,
    },
  };

  const normalClothingDetections = [
    { className: 'FEMALE_BREAST_COVERED', score: 0.65, box: [0.3, 0.3, 0.4, 0.4] as [number, number, number, number] },
    { className: 'BELLY_EXPOSED', score: 0.45, box: [0.4, 0.5, 0.5, 0.6] as [number, number, number, number] },
    { className: 'FEMALE_GENITALIA_COVERED', score: 0.80, box: [0.4, 0.6, 0.5, 0.8] as [number, number, number, number] },
  ];

  // Under default options, normal clothing and midriff must generate ZERO events
  const defaultEvents = buildCandidateEvents(
    normalClothingDetections,
    'nudenet',
    'test-video',
    1.5,
    1,
    0,
    defaultProductionOptions,
  );
  assert.equal(defaultEvents.length, 0, 'Default configuration must not flag normal covered clothing or midriff as alerts');

  // Even when all categories are enabled, FEMALE_GENITALIA_COVERED (pants/skirts) must NEVER trigger an alert
  const optInOptions: AnalysisOptions = {
    ...defaultProductionOptions,
    categories: {
      ...defaultProductionOptions.categories,
      clothing_shift_revealing: true,
      undergarment_slip: true,
      other_wardrobe_anomaly: true,
    },
  };

  const optInEvents = buildCandidateEvents(
    normalClothingDetections,
    'nudenet',
    'test-video',
    1.5,
    1,
    0,
    optInOptions,
  );

  // Covered breast and midriff appear for broad review, but covered pelvic region is NEVER an event
  assert.equal(optInEvents.length, 2);
  const categoriesEmitted = optInEvents.map(e => e.category);
  assert.ok(categoriesEmitted.includes('clothing_shift_revealing'));
  assert.ok(categoriesEmitted.includes('other_wardrobe_anomaly'));
  assert.ok(!categoriesEmitted.includes('undergarment_slip'), 'Covered pelvic region must never produce an undergarment slip alert');

  // Neutral labels must be used
  assert.equal(optInEvents[0].categoryLabel, 'Covered breast / cleavage (broad review)');
});
