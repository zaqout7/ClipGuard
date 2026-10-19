import assert from 'node:assert/strict';
import test from 'node:test';
import type { DetectionCategory, DetectionEvent } from '../src/types';
import { mergeDetections, mergeEventExplanations } from '../src/utils/formatters';
import {
  nudenetClassToCategory,
  buildDetectionExplanation,
  buildVisualEvidence,
  buildScoreSemantics,
} from '../src/utils/nudenetMapping';

test('nudenetClassToCategory maps exposure classes to appropriate detection categories', () => {
  assert.equal(nudenetClassToCategory('FEMALE_BREAST_EXPOSED'), 'possible_chest_exposure');
  assert.equal(nudenetClassToCategory('MALE_BREAST_EXPOSED'), 'possible_chest_exposure');
  assert.equal(nudenetClassToCategory('BUTTOCKS_EXPOSED'), 'possible_rear_exposure');
  assert.equal(nudenetClassToCategory('BELLY_EXPOSED'), 'other_wardrobe_anomaly');
  assert.equal(nudenetClassToCategory('FEMALE_GENITALIA_EXPOSED'), 'nsfw_image_classification');
  assert.equal(nudenetClassToCategory('MALE_GENITALIA_EXPOSED'), 'nsfw_image_classification');
  assert.equal(nudenetClassToCategory('ANUS_EXPOSED'), 'nsfw_image_classification');
  assert.equal(nudenetClassToCategory('FEMALE_BREAST_COVERED'), 'clothing_shift_revealing');
  // FEMALE_GENITALIA_COVERED is normal clothed pelvic anatomy (pants/shorts/skirts) and must map to null
  assert.equal(nudenetClassToCategory('FEMALE_GENITALIA_COVERED'), null);
});

test('nudenetClassToCategory suppresses benign classes from creating exposure events', () => {
  // Faces, feet, covered armpits, covered belly, covered pelvic area, covered buttocks, and covered anus must never trigger exposure events
  const benignClasses = [
    'FACE_FEMALE',
    'FACE_MALE',
    'FEET_EXPOSED',
    'FEET_COVERED',
    'ARMPITS_COVERED',
    'ARMPITS_EXPOSED',
    'BELLY_COVERED',
    'ANUS_COVERED',
    'BUTTOCKS_COVERED',
    'FEMALE_GENITALIA_COVERED',
    'UNKNOWN_CLASS',
  ];

  for (const cls of benignClasses) {
    assert.equal(
      nudenetClassToCategory(cls),
      null,
      `Benign class "${cls}" must map to null to prevent false positive exposure events`
    );
  }
});

test('scoreSemantics explicitly disclaims calibrated probability across backends', () => {
  const nudenetSemantics = buildScoreSemantics('nudenet', 0.88);
  assert.match(nudenetSemantics, /Not a calibrated probability/i);
  assert.match(nudenetSemantics, /88\.0%/);

  const vitSemantics = buildScoreSemantics('vit', 0.75);
  assert.match(vitSemantics, /Not a calibrated probability/i);
  assert.match(vitSemantics, /75\.0%/);
});

test('buildDetectionExplanation and buildVisualEvidence format multi-part detections', () => {
  const detections = [
    { className: 'FEMALE_BREAST_EXPOSED', score: 0.85 },
    { className: 'BELLY_EXPOSED', score: 0.72 },
  ];

  const explanation = buildDetectionExplanation(detections);
  assert.match(explanation, /Exposed Breast \/ Chest \(85%\)/);
  assert.match(explanation, /Exposed Belly \/ Midriff \(72%\)/);
  assert.match(explanation, /potential match requiring human review/);

  const visual = buildVisualEvidence(detections);
  assert.match(visual, /Exposed Breast \/ Chest/);
  assert.match(visual, /Exposed Belly \/ Midriff/);
});

test('temporal aggregation merges verifiedFrameCount and diagnostic records', () => {
  const event1: DetectionEvent = {
    id: 'test-1',
    startSeconds: 1.0,
    endSeconds: 1.0,
    startTimestamp: '00:01',
    endTimestamp: '00:01',
    category: 'possible_chest_exposure',
    categoryLabel: 'Exposed Breast / Chest',
    modelScore: 0.82,
    scoreSemantics: 'test',
    explanation: 'frame 1',
    visualEvidence: 'visual 1',
    reviewStatus: 'needs_review',
    editorNotes: '',
    verifiedFrameCount: 1,
    diagnostic: {
      detectorId: 'NudeNet YOLOv8n (320n.onnx)',
      thresholdApplied: 0.7,
      positiveFrameCount: 1,
      scoreCalculation: 'Peak box confidence: 82.0%',
      frames: [{
        frameIndex: 1,
        presentationSeconds: 1.0,
        timestamp: '00:01',
        detectorId: 'NudeNet YOLOv8n (320n.onnx)',
        rawPredictions: [{ className: 'FEMALE_BREAST_EXPOSED', score: 0.82 }],
        thresholdApplied: 0.7,
        ruleTriggered: 'FEMALE_BREAST_EXPOSED(82%) >= threshold (70%)',
      }],
    },
  };

  const event2: DetectionEvent = {
    id: 'test-2',
    startSeconds: 2.0,
    endSeconds: 2.0,
    startTimestamp: '00:02',
    endTimestamp: '00:02',
    category: 'possible_chest_exposure',
    categoryLabel: 'Exposed Breast / Chest',
    modelScore: 0.91,
    scoreSemantics: 'test',
    explanation: 'frame 2',
    visualEvidence: 'visual 2',
    reviewStatus: 'needs_review',
    editorNotes: '',
    verifiedFrameCount: 1,
    diagnostic: {
      detectorId: 'NudeNet YOLOv8n (320n.onnx)',
      thresholdApplied: 0.7,
      positiveFrameCount: 1,
      scoreCalculation: 'Peak box confidence: 91.0%',
      frames: [{
        frameIndex: 2,
        presentationSeconds: 2.0,
        timestamp: '00:02',
        detectorId: 'NudeNet YOLOv8n (320n.onnx)',
        rawPredictions: [{ className: 'FEMALE_BREAST_EXPOSED', score: 0.91 }],
        thresholdApplied: 0.7,
        ruleTriggered: 'FEMALE_BREAST_EXPOSED(91%) >= threshold (70%)',
      }],
    },
  };

  // Merge with 2s tolerance and 0.5s padding
  const merged = mergeDetections([event1, event2], 2.0, 0.5, 10.0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].verifiedFrameCount, 2);
  assert.equal(merged[0].modelScore, 0.91); // Peak score retained
  assert.equal(merged[0].diagnostic?.positiveFrameCount, 2);
  assert.equal(merged[0].diagnostic?.frames.length, 2);
});

test('handles empty detections gracefully without division-by-zero or crash', () => {
  assert.equal(buildDetectionExplanation([]), '');
  assert.equal(buildVisualEvidence([]), '');
  assert.deepEqual(mergeDetections([], 2.0, 0.5), []);
});

test('regression: mergeEventExplanations deduplicates disclaimers and merges detected items cleanly', () => {
  const disclaimer = 'This is a potential match requiring human review, not a definitive content judgment.';
  const exp1 = `Detected: Covered Breast / Cleavage (39%). ${disclaimer}`;
  const exp2 = `Detected: Covered Breast / Cleavage (69%), Covered Breast / Cleavage (45%). ${disclaimer}`;

  const merged = mergeEventExplanations(exp1, exp2);

  // The disclaimer must only appear ONCE at the end
  const disclaimerCount = (merged.match(/potential match requiring human review/g) || []).length;
  assert.equal(disclaimerCount, 1, 'Disclaimer must appear exactly once in merged explanation');
  assert.ok(merged.startsWith('Detected: Covered Breast / Cleavage (39%), Covered Breast / Cleavage (69%), Covered Breast / Cleavage (45%).'));
});
