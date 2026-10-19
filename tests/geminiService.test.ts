import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEMINI_FPS,
  DEFAULT_GEMINI_MODEL,
  GEMINI_MODELS,
  validateGeminiModelAndFps,
  buildGeminiVideoPart,
  buildGeminiGenerateContentPayload,
  processGeminiFindings,
  executeGeminiVideoAnalysis,
  GeminiQuotaExceededError,
  GeminiCapabilityError,
  type RawGeminiFinding,
} from '../src/server/geminiService.js';

test('Gemini Video Analysis: Requirement 1 - Sets actual Gemini API videoMetadata.fps to 4', () => {
  // 1. Using fileData
  const filePart = buildGeminiVideoPart(
    { fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/test-123', mimeType: 'video/mp4' },
    4
  );

  assert.equal(typeof filePart.videoMetadata, 'object', 'videoMetadata must be an object');
  assert.equal(filePart.videoMetadata.fps, 4, 'videoMetadata.fps must be exactly 4');
  assert.equal(filePart.fileData.fileUri, 'https://generativelanguage.googleapis.com/v1beta/files/test-123');

  // 2. Using inlineData
  const inlinePart = buildGeminiVideoPart(
    { inlineBase64: 'AAAA', mimeType: 'video/mp4' },
    4
  );
  assert.equal(inlinePart.videoMetadata.fps, 4, 'videoMetadata.fps must be exactly 4');
  assert.equal(inlinePart.inlineData.data, 'AAAA');

  // 3. In the full payload sent to Gemini API
  const payload = buildGeminiGenerateContentPayload(filePart);
  const partInPayload = payload.contents[0].parts[0];
  assert.equal(partInPayload.videoMetadata.fps, 4, 'Payload must set videoMetadata.fps to 4');
});

test('Gemini Video Analysis: Requirement 2 - Confirms model and API support for videoMetadata.fps', () => {
  // Supported models (default gemini-3.8-flash and gemini-2.5-flash)
  const defaultDescriptor = validateGeminiModelAndFps('gemini-3.8-flash', 4);
  assert.equal(defaultDescriptor.supportsVideoMetadataFps, true);
  assert.equal(defaultDescriptor.supportsVideo, true);

  const supportedDescriptor = validateGeminiModelAndFps('gemini-2.5-flash', 4);
  assert.equal(supportedDescriptor.supportsVideoMetadataFps, true);
  assert.equal(supportedDescriptor.supportsVideo, true);

  // Unsupported model names
  assert.throws(
    () => validateGeminiModelAndFps('unsupported-model-v1', 4),
    (err: any) => err instanceof GeminiCapabilityError && err.message.includes('Unsupported model')
  );

  // Invalid FPS values
  assert.throws(
    () => validateGeminiModelAndFps('gemini-2.5-flash', 0),
    (err: any) => err instanceof GeminiCapabilityError && err.message.includes('Invalid fps')
  );
  assert.throws(
    () => validateGeminiModelAndFps('gemini-2.5-flash', 30),
    (err: any) => err instanceof GeminiCapabilityError && err.message.includes('Invalid fps')
  );
});

test('Gemini Video Analysis: Requirement 1 & 5 - Requires explicit billing intent and upload consent', async () => {
  // Rejected if userConfirmedProjectBillingIntent is false
  await assert.rejects(
    async () => {
      await executeGeminiVideoAnalysis({
        apiKey: 'dummy-test-key',
        model: 'gemini-2.5-flash',
        fps: 4,
        userConfirmedProjectBillingIntent: false,
        userConsentedVideoUpload: true,
        videoSource: { inlineBase64: 'AAAA', mimeType: 'video/mp4' },
        options: {
          sensitivity: 40,
          mergeToleranceSec: 2.5,
          bufferSec: 0.5,
          categories: {
            possible_chest_exposure: true,
            possible_rear_exposure: true,
            nsfw_image_classification: true,
            clothing_shift_revealing: false,
            undergarment_slip: false,
            other_wardrobe_anomaly: false,
            covered_buttocks_outline: false,
          },
        },
      });
    },
    (err: any) => err.message.includes('Explicit billing confirmation required') || err.message.includes('billing depends on your Google Cloud/AI Studio project')
  );

  // Rejected if userConsentedVideoUpload is false
  await assert.rejects(
    async () => {
      await executeGeminiVideoAnalysis({
        apiKey: 'dummy-test-key',
        model: 'gemini-2.5-flash',
        fps: 4,
        userConfirmedProjectBillingIntent: true,
        userConsentedVideoUpload: false,
        videoSource: { inlineBase64: 'AAAA', mimeType: 'video/mp4' },
        options: {
          sensitivity: 40,
          mergeToleranceSec: 2.5,
          bufferSec: 0.5,
          categories: {
            possible_chest_exposure: true,
            possible_rear_exposure: true,
            nsfw_image_classification: true,
            clothing_shift_revealing: false,
            undergarment_slip: false,
            other_wardrobe_anomaly: false,
            covered_buttocks_outline: false,
          },
        },
      });
    },
    (err: any) => err.message.includes('Explicit consent required') || err.message.includes('consent to transmit video data')
  );
});

test('Gemini Video Analysis: Requirement 2 & 8 - Quota limit reached stops without hardcoded limits', async () => {
  const mockFetchQuotaExceeded: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
      { status: 429, statusText: 'Too Many Requests' }
    );
  };

  await assert.rejects(
    async () => {
      await executeGeminiVideoAnalysis({
        apiKey: 'dummy-test-key',
        model: 'gemini-2.5-flash',
        fps: 4,
        userConfirmedProjectBillingIntent: true,
        userConsentedVideoUpload: true,
        videoSource: { inlineBase64: 'AAAA', mimeType: 'video/mp4' },
        options: {
          sensitivity: 40,
          mergeToleranceSec: 2.5,
          bufferSec: 0.5,
          categories: {
            possible_chest_exposure: true,
            possible_rear_exposure: true,
            nsfw_image_classification: true,
            clothing_shift_revealing: false,
            undergarment_slip: false,
            other_wardrobe_anomaly: false,
            covered_buttocks_outline: false,
          },
        },
        fetchFn: mockFetchQuotaExceeded,
      });
    },
    (err: any) => {
      assert(err instanceof GeminiQuotaExceededError, 'Must throw GeminiQuotaExceededError');
      assert(err.message.includes('429'), 'Must mention HTTP 429');
      assert(err.message.includes('RESOURCE_EXHAUSTED'), 'Must mention RESOURCE_EXHAUSTED');
      assert(err.message.includes('AI Studio') || err.message.includes('Console'), 'Must direct to AI Studio/Console');
      // Must NOT contain hard-coded quota claims
      assert(!err.message.includes('15 requests/minute'), 'Must not claim hardcoded 15 RPM');
      assert(!err.message.includes('1,000,000 tokens/minute'), 'Must not claim hardcoded 1M TPM');
      return true;
    }
  );
});

test('Gemini Video Analysis: Requirement 3 & 4 - Preserves timestamps, merges findings, leaves verifiedFrameCount unverified', () => {
  const rawFindings: RawGeminiFinding[] = [
    {
      startSeconds: 4.0,
      endSeconds: 4.25,
      category: 'possible_chest_exposure',
      anatomicalState: 'exposed',
      isExposed: true,
      confidence: 85,
      explanation: 'Exposed upper chest area detected at frame 16.',
    },
    {
      startSeconds: 4.25,
      endSeconds: 4.5,
      category: 'possible_chest_exposure',
      anatomicalState: 'exposed',
      isExposed: true,
      confidence: 88,
      explanation: 'Exposed upper chest area detected at frame 17.',
    },
    {
      startSeconds: 4.5,
      endSeconds: 4.75,
      category: 'possible_chest_exposure',
      anatomicalState: 'exposed',
      isExposed: true,
      confidence: 90,
      explanation: 'Exposed upper chest area detected at frame 18.',
    },
  ];

  const mergedEvents = processGeminiFindings(rawFindings, {
    sensitivity: 40,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      nsfw_image_classification: true,
      clothing_shift_revealing: false,
      undergarment_slip: false,
      other_wardrobe_anomaly: false,
      covered_buttocks_outline: false,
    },
  });

  // Repeated 4 FPS frames must be merged into 1 review segment, not 3 separate alerts
  assert.equal(mergedEvents.length, 1, '3 consecutive 4 FPS findings must merge into 1 review segment');
  const event = mergedEvents[0];

  // Preserves original video timestamp range
  assert.equal(event.startSeconds, 3.5, 'Start seconds clamped with buffer');
  assert.equal(event.startTimestamp, '00:03');
  assert.equal(event.endSeconds, 5.25, 'End seconds clamped with buffer');
  assert.equal(event.endTimestamp, '00:05');
  assert.equal(event.category, 'possible_chest_exposure');

  // Per Requirement 4: verifiedFrameCount must NOT be populated from findings count
  assert.equal(event.verifiedFrameCount, undefined, 'verifiedFrameCount must remain undefined for Gemini findings');
  assert(event.frameCoverageNotice?.includes('unverified'), 'frameCoverageNotice must explicitly state unverified coverage');
});

test('Gemini Video Analysis: Requirement 5 - Distinguishes exposed anatomy from covered anatomy', () => {
  const rawFindings: RawGeminiFinding[] = [
    {
      startSeconds: 1.0,
      endSeconds: 1.5,
      category: 'possible_chest_exposure', // Incorrectly claimed exposure by model
      anatomicalState: 'covered',          // But anatomy is covered (cleavage / dress)
      isExposed: false,
      confidence: 75,
      explanation: 'Wardrobe malfunction with cleavage visible.',
    },
    {
      startSeconds: 6.0,
      endSeconds: 6.5,
      category: 'other_wardrobe_anomaly',
      anatomicalState: 'covered',
      isExposed: false,
      confidence: 60,
      explanation: 'Exposed midriff and covered belly button in crop top.',
    },
  ];

  // Under default options (broad review disabled)
  const defaultEvents = processGeminiFindings(rawFindings, {
    sensitivity: 40,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      nsfw_image_classification: true,
      clothing_shift_revealing: false,
      undergarment_slip: false,
      other_wardrobe_anomaly: false,
      covered_buttocks_outline: false,
    },
  });

  // Covered anatomy must NOT generate alerts under default options
  assert.equal(defaultEvents.length, 0, 'Covered anatomy must be suppressed under default explicit-only options');

  // When broad review is enabled
  const broadReviewEvents = processGeminiFindings(rawFindings, {
    sensitivity: 40,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      nsfw_image_classification: true,
      clothing_shift_revealing: true,
      undergarment_slip: false,
      other_wardrobe_anomaly: true,
      covered_buttocks_outline: false,
    },
  });

  assert.equal(broadReviewEvents.length, 2);
  // Verify that "wardrobe malfunction" was sanitized and not described as confirmed nudity
  assert(!broadReviewEvents[0].explanation.includes('wardrobe malfunction'), 'Must not describe covered breast as wardrobe malfunction');
  assert.equal(broadReviewEvents[0].categoryLabel, 'Covered breast / cleavage (broad review)');
});

test('Gemini Video Analysis: Requirement 3, 6 & 9 - Reports requested FPS, unverified coverage, and billing notice', async () => {
  const mockValidFetch: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    findings: [],
                  }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 }
    );
  };

  const result = await executeGeminiVideoAnalysis({
    apiKey: 'dummy-valid-key',
    model: 'gemini-2.5-flash',
    fps: 4,
    userConfirmedProjectBillingIntent: true,
    userConsentedVideoUpload: true,
    videoSource: { inlineBase64: 'AAAA', mimeType: 'video/mp4' },
    options: {
      sensitivity: 40,
      mergeToleranceSec: 2.5,
      bufferSec: 0.5,
      categories: {
        possible_chest_exposure: true,
        possible_rear_exposure: true,
        nsfw_image_classification: true,
        clothing_shift_revealing: false,
        undergarment_slip: false,
        other_wardrobe_anomaly: false,
        covered_buttocks_outline: false,
      },
    },
    fetchFn: mockValidFetch,
  });

  assert.equal(result.requestedFps, 4, 'Must report requested FPS = 4');
  assert.equal(result.samplingIntervalSec, 0.25, 'Must report 0.25s sampling interval');
  assert.equal(result.apiCallSucceeded, true, 'Must report HTTP 200 call succeeded');
  assert.equal(result.effectiveFpsConfirmedByApi, false, 'Must acknowledge API does not confirm effective FPS');
  assert.equal(result.coverageVerification, 'unverified', 'Must mark coverageVerification as unverified');
  assert(result.billingNotice.includes('project settings'), 'Must explain billing depends on project settings');
  assert(result.frameCoverageNotice.includes('videoMetadata.fps'), 'Must mention videoMetadata.fps');
  assert(result.interFrameWarning.includes('0.25 seconds'), 'Must explain events between 0.25s frames may be missed');
});

test('Gemini Video Analysis: Requirement 9 - covered_buttocks_outline enable/disable, separation from exposure, and isolation', () => {
  const coveredButtockFindings: RawGeminiFinding[] = [
    {
      startSeconds: 2.0,
      endSeconds: 2.25,
      category: 'covered_buttocks_outline',
      anatomicalState: 'covered',
      isExposed: false,
      confidence: 70,
      explanation: 'Tight clothing showing buttock contour.',
    },
    {
      startSeconds: 2.25,
      endSeconds: 2.5,
      category: 'covered_buttocks_outline',
      anatomicalState: 'covered',
      isExposed: false,
      confidence: 72,
      explanation: 'Tight clothing showing buttock contour.',
    },
    {
      startSeconds: 5.0,
      endSeconds: 5.25,
      category: 'clothing_shift_revealing',
      anatomicalState: 'covered',
      isExposed: false,
      confidence: 65,
      explanation: 'Covered cleavage in neckline.',
    },
    {
      startSeconds: 8.0,
      endSeconds: 8.25,
      category: 'possible_rear_exposure',
      anatomicalState: 'covered', // Misclassified as exposure but actually covered
      isExposed: false,
      confidence: 75,
      explanation: 'Accidental slip of rear clothing.',
    },
  ];

  // 1. When covered_buttocks_outline is disabled (default)
  const disabledEvents = processGeminiFindings(coveredButtockFindings, {
    sensitivity: 40,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    categories: {
      possible_chest_exposure: true,
      possible_rear_exposure: true,
      nsfw_image_classification: true,
      clothing_shift_revealing: false,
      undergarment_slip: false,
      other_wardrobe_anomaly: false,
      covered_buttocks_outline: false,
    },
  });

  // Both the direct covered_buttocks_outline findings and the covered rear finding must be suppressed!
  assert.equal(disabledEvents.length, 0, 'Must suppress covered_buttocks_outline when category is disabled');

  // 2. When covered_buttocks_outline is enabled, but other broad review categories remain disabled
  const enabledEvents = processGeminiFindings(coveredButtockFindings, {
    sensitivity: 40,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    categories: {
      possible_chest_exposure: false,
      possible_rear_exposure: false,
      nsfw_image_classification: false,
      clothing_shift_revealing: false,
      undergarment_slip: false,
      other_wardrobe_anomaly: false,
      covered_buttocks_outline: true,
    },
  });

  // Should have 2 events: one merged segment for frames at 2.0-2.5s, and one for the covered rear at 8.0s
  // The clothing_shift_revealing finding at 5.0s MUST NOT be emitted!
  assert.equal(enabledEvents.length, 2, 'Must emit only covered_buttocks_outline findings; clothing_shift_revealing must remain suppressed');

  // Event 1: Verify 4 FPS frames merged into review segment
  const event1 = enabledEvents[0];
  assert.equal(event1.category, 'covered_buttocks_outline');
  assert.equal(event1.categoryLabel, 'Visible buttock outline through clothing');
  assert.equal(event1.explanation, 'Covered region; visible clothing contour; optional human review.');
  assert.equal(event1.visualEvidence, 'Covered region; visible clothing contour; optional human review.');
  assert.equal(event1.severity, 'low');
  assert(event1.scoreSemantics?.includes('uncalibrated detector score; not a calibrated probability'), 'Must explicitly disclaim calibrated probability');
  assert.equal(event1.startSeconds, 1.5, 'Start seconds clamped with buffer');
  assert.equal(event1.endSeconds, 3.0, 'End seconds merged and clamped with buffer');

  // Event 2: Verify covered rear was routed to covered_buttocks_outline and not labeled as exposure or malfunction
  const event2 = enabledEvents[1];
  assert.equal(event2.category, 'covered_buttocks_outline');
  assert.equal(event2.categoryLabel, 'Visible buttock outline through clothing');
  assert.equal(event2.explanation, 'Covered region; visible clothing contour; optional human review.');
  assert(!event2.explanation.includes('slip'), 'Must not describe as accidental slip');
  assert(!event2.explanation.includes('malfunction'), 'Must not describe as wardrobe malfunction');

  // 3. When only clothing_shift_revealing is enabled and covered_buttocks_outline is disabled
  const onlyCleavageEvents = processGeminiFindings(coveredButtockFindings, {
    sensitivity: 40,
    mergeToleranceSec: 2.5,
    bufferSec: 0.5,
    categories: {
      possible_chest_exposure: false,
      possible_rear_exposure: false,
      nsfw_image_classification: false,
      clothing_shift_revealing: true,
      undergarment_slip: false,
      other_wardrobe_anomaly: false,
      covered_buttocks_outline: false,
    },
  });

  assert.equal(onlyCleavageEvents.length, 1, 'Only clothing_shift_revealing must be emitted; covered buttocks must NOT be admitted');
  assert.equal(onlyCleavageEvents[0].category, 'clothing_shift_revealing');
});
