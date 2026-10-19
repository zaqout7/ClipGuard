import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  waitForFileActive,
  deleteVideoFromFileApi,
  uploadVideoToFileApi,
  executeGeminiVideoAnalysis,
  GeminiQuotaExceededError,
} from '../src/server/geminiService.js';

test('Gemini File Lifecycle: waitForFileActive transitions from PROCESSING to ACTIVE', async () => {
  let pollCount = 0;
  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    pollCount++;
    const urlStr = String(url);
    assert(urlStr.includes('/files/test-video-1'), 'Url must include fileName');
    assert(urlStr.includes('key=mock-key'), 'Url must include API key');

    if (pollCount === 1) {
      return new Response(JSON.stringify({ name: 'files/test-video-1', state: 'PROCESSING' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        name: 'files/test-video-1',
        state: 'ACTIVE',
        uri: 'https://generativelanguage.googleapis.com/v1beta/files/test-video-1',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  };

  const result = await waitForFileActive('files/test-video-1', 'mock-key', mockFetch as any, {
    maxAttempts: 5,
    pollIntervalMs: 1,
    totalTimeoutMs: 5000,
    requestTimeoutMs: 1000,
    sleepFn: async () => {},
  });

  assert.equal(result.state, 'ACTIVE');
  assert.equal(result.uri, 'https://generativelanguage.googleapis.com/v1beta/files/test-video-1');
  assert.equal(pollCount, 2, 'Must poll twice before reaching ACTIVE');
});

test('Gemini File Lifecycle: waitForFileActive throws with clear message on FAILED state', async () => {
  let pollCount = 0;
  const mockFetch = async () => {
    pollCount++;
    if (pollCount === 1) {
      return new Response(JSON.stringify({ name: 'files/corrupt-video', state: 'PROCESSING' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        name: 'files/corrupt-video',
        state: 'FAILED',
        error: { message: 'Video stream contains invalid container syntax.' },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  };

  await assert.rejects(
    async () => {
      await waitForFileActive('files/corrupt-video', 'mock-key', mockFetch as any, {
        maxAttempts: 5,
        pollIntervalMs: 1,
        totalTimeoutMs: 5000,
        requestTimeoutMs: 1000,
        sleepFn: async () => {},
      });
    },
    (err: any) => {
      assert(err instanceof Error);
      assert(err.message.includes('FAILED'), 'Error message must mention FAILED state');
      assert(err.message.includes('invalid container syntax'), 'Error message must preserve Google error details');
      return true;
    }
  );

  assert.equal(pollCount, 2);
});

test('Gemini File Lifecycle: waitForFileActive aborts hanging GET request before headers arrive via AbortController signal', async () => {
  let abortSignalObserved = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert(signal, 'Fetch must be invoked with an AbortSignal');

    // Simulate hanging request before headers arrive until aborted
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        abortSignalObserved = true;
        reject(new Error('AbortError'));
      });
    });
  };

  await assert.rejects(
    async () => {
      await waitForFileActive('files/hanging-video', 'mock-key', mockFetch as any, {
        maxAttempts: 2,
        pollIntervalMs: 1,
        totalTimeoutMs: 5000,
        requestTimeoutMs: 25, // Short 25ms timeout
        sleepFn: async () => {},
      });
    },
    (err: any) => {
      assert(err instanceof Error);
      assert(err.message.includes('timed out after 25ms'), 'Error must specify request timeout');
      return true;
    }
  );

  assert.equal(abortSignalObserved, true, 'AbortSignal must have been triggered');
});

test('Gemini File Lifecycle: waitForFileActive aborts when headers arrive immediately but JSON body reading hangs', async () => {
  let bodyReaderAborted = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert(signal, 'Fetch must be invoked with an AbortSignal');

    // Headers arrive immediately (HTTP 200 OK)
    // but reading the body hangs until the signal is aborted
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: () =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            bodyReaderAborted = true;
            reject(new Error('AbortError'));
          });
        }),
    } as unknown as Response;
  };

  await assert.rejects(
    async () => {
      await waitForFileActive('files/hanging-body-video', 'mock-key', mockFetch as any, {
        maxAttempts: 2,
        pollIntervalMs: 1,
        totalTimeoutMs: 5000,
        requestTimeoutMs: 30, // 30ms timeout for body read
        sleepFn: async () => {},
      });
    },
    (err: any) => {
      assert(err instanceof Error);
      assert(
        err.message.includes('reading JSON response body after 30ms') ||
          err.message.includes('timed out after 30ms'),
        'Must abort and catch timeout during body reading'
      );
      return true;
    }
  );

  assert.equal(bodyReaderAborted, true, 'AbortSignal must have aborted the in-flight body read');
});

test('Gemini File Lifecycle: waitForFileActive enforces real wall-clock totalTimeoutMs across attempts and waits', async () => {
  let attemptCount = 0;

  const mockFetch = async () => {
    attemptCount++;
    return new Response(JSON.stringify({ name: 'files/slow-video', state: 'PROCESSING' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await assert.rejects(
    async () => {
      await waitForFileActive('files/slow-video', 'mock-key', mockFetch as any, {
        maxAttempts: 100, // Large attempt count
        pollIntervalMs: 20,
        totalTimeoutMs: 35, // Strict wall-clock deadline
        requestTimeoutMs: 100,
        sleepFn: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
    },
    (err: any) => {
      assert(err instanceof Error);
      assert(err.message.includes('total timeout 35ms exceeded'), 'Must report totalTimeoutMs exceeded');
      return true;
    }
  );

  assert(attemptCount < 100, 'Must not continue to maxAttempts when wall-clock deadline is reached');
});

test('Gemini File Lifecycle: waitForFileActive checks timeout and throws before returning ACTIVE if deadline passed', async () => {
  const originalDateNow = Date.now;
  let simulatedTime = 1_000_000;
  Date.now = () => simulatedTime;

  let fetchCalled = false;

  const mockFetch = async () => {
    fetchCalled = true;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => {
        // Advance clock past totalTimeoutMs (50ms) during response-body reading
        simulatedTime += 60;
        return { name: 'files/late-active', state: 'ACTIVE' };
      },
    } as unknown as Response;
  };

  try {
    await assert.rejects(
      async () => {
        await waitForFileActive('files/late-active', 'mock-key', mockFetch as any, {
          maxAttempts: 5,
          pollIntervalMs: 1,
          totalTimeoutMs: 50, // Positive 50ms timeout
          requestTimeoutMs: 1000,
          sleepFn: async () => {},
        });
      },
      (err: any) => {
        assert(err instanceof Error);
        assert(
          err.message.includes('total timeout 50ms exceeded'),
          `Error message must indicate totalTimeoutMs exceeded after ACTIVE read: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(fetchCalled, true, 'Confirm that fetch was called before deadline expired');
  } finally {
    Date.now = originalDateNow;
  }
});

test('Gemini File Lifecycle: deleteVideoFromFileApi sends DELETE and handles HTTP 200 success without throwing', async () => {
  let deleteMethod = '';
  let deleteUrl = '';

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    deleteUrl = String(url);
    deleteMethod = init?.method || 'GET';
    return new Response('', { status: 200 });
  };

  const res = await deleteVideoFromFileApi('files/test-delete-1', 'mock-key', mockFetch as any);

  assert.equal(res.success, true);
  assert.equal(res.status, 200);
  assert.equal(deleteMethod, 'DELETE');
  assert(deleteUrl.includes('/files/test-delete-1'));
  assert(deleteUrl.includes('key=mock-key'));
});

test('Gemini File Lifecycle: deleteVideoFromFileApi handles HTTP 404 Not Found gracefully without throwing', async () => {
  const mockFetch = async () => {
    return new Response(JSON.stringify({ error: { message: 'File not found' } }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const res = await deleteVideoFromFileApi('files/missing-file', 'mock-key', mockFetch as any);

  assert.equal(res.success, false);
  assert.equal(res.status, 404);
  assert(res.error?.includes('404'), 'Must record 404 in error');
});

test('Gemini File Lifecycle: deleteVideoFromFileApi handles HTTP 500 Server Error gracefully without throwing', async () => {
  const mockFetch = async () => {
    return new Response(JSON.stringify({ error: { message: 'Internal storage error' } }), {
      status: 500,
      statusText: 'Internal Server Error',
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const res = await deleteVideoFromFileApi('files/server-error-file', 'mock-key', mockFetch as any);

  assert.equal(res.success, false);
  assert.equal(res.status, 500);
  assert(res.error?.includes('500'), 'Must record 500 in error');
});

test('Gemini File Lifecycle: deleteVideoFromFileApi aborts hanging DELETE request before headers arrive via AbortController', async () => {
  let abortSignalTriggered = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert(signal, 'DELETE fetch must be called with an AbortSignal');

    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        abortSignalTriggered = true;
        reject(new Error('AbortError'));
      });
    });
  };

  const res = await deleteVideoFromFileApi('files/hanging-delete', 'mock-key', mockFetch as any, {
    timeoutMs: 25, // Short 25ms timeout
  });

  assert.equal(res.success, false);
  assert(res.error?.includes('DELETE timed out after 25ms'), 'Error must report DELETE timeout');
  assert.equal(abortSignalTriggered, true, 'AbortSignal must have been aborted');
});

test('Gemini File Lifecycle: deleteVideoFromFileApi aborts when headers arrive immediately but error text body reading hangs', async () => {
  let textBodyAborted = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert(signal, 'DELETE fetch must be called with an AbortSignal');

    return {
      ok: false,
      status: 500,
      statusText: 'Server Error',
      text: () =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            textBodyAborted = true;
            reject(new Error('AbortError'));
          });
        }),
      json: async () => ({}),
    } as unknown as Response;
  };

  const res = await deleteVideoFromFileApi('files/hanging-delete-body', 'mock-key', mockFetch as any, {
    timeoutMs: 30,
  });

  assert.equal(res.success, false);
  assert(res.error?.includes('reading error body after 30ms') || res.error?.includes('DELETE timed out after 30ms'));
  assert.equal(textBodyAborted, true, 'AbortSignal must have aborted the hanging error text reader');
});

test('Gemini File Lifecycle: uploadVideoToFileApi initiates upload, finalizes, and polls for ACTIVE', async () => {
  const tmpFile = path.join(os.tmpdir(), `clipguard_test_upload_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.alloc(1024, 0));

  const calls: string[] = [];

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    calls.push(`${init?.method || 'GET'} ${urlStr}`);

    if (urlStr.includes('/upload/v1beta/files') && init?.method === 'POST') {
      return new Response('', {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://upload.example.com/session-123' },
      });
    }

    if (urlStr === 'https://upload.example.com/session-123') {
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/uploaded-vid-99',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/uploaded-vid-99',
            state: 'PROCESSING',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes('/files/uploaded-vid-99')) {
      return new Response(
        JSON.stringify({
          name: 'files/uploaded-vid-99',
          state: 'ACTIVE',
          uri: 'https://generativelanguage.googleapis.com/v1beta/files/uploaded-vid-99',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unexpected mock call: ${urlStr}`);
  };

  try {
    const result = await uploadVideoToFileApi(tmpFile, 'video/mp4', 'mock-key', mockFetch as any, {
      maxAttempts: 5,
      pollIntervalMs: 1,
      totalTimeoutMs: 5000,
      sleepFn: async () => {},
    });

    assert.equal(result.fileName, 'files/uploaded-vid-99');
    assert.equal(result.fileUri, 'https://generativelanguage.googleapis.com/v1beta/files/uploaded-vid-99');
    assert.equal(result.state, 'ACTIVE');
    assert.equal(calls.length, 3, 'Must execute initiation, upload, and polling check');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('Gemini File Lifecycle: uploadVideoToFileApi attempts best-effort deletion if file processing enters FAILED', async () => {
  const tmpFile = path.join(os.tmpdir(), `clipguard_test_fail_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.alloc(1024, 0));

  let deleteCalled = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);

    if (init?.method === 'DELETE' && urlStr.includes('/files/corrupted-upload')) {
      deleteCalled = true;
      return new Response('', { status: 200 });
    }

    if (urlStr.includes('/upload/v1beta/files')) {
      return new Response('', {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://upload.example.com/session-fail' },
      });
    }

    if (urlStr === 'https://upload.example.com/session-fail') {
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/corrupted-upload',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/corrupted-upload',
            state: 'PROCESSING',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes('/files/corrupted-upload')) {
      return new Response(
        JSON.stringify({
          name: 'files/corrupted-upload',
          state: 'FAILED',
          error: { message: 'Corrupt video bitstream' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unexpected mock call: ${urlStr}`);
  };

  try {
    await assert.rejects(
      async () => {
        await uploadVideoToFileApi(tmpFile, 'video/mp4', 'mock-key', mockFetch as any, {
          maxAttempts: 5,
          pollIntervalMs: 1,
          totalTimeoutMs: 5000,
          sleepFn: async () => {},
        });
      },
      (err: any) => {
        assert(err instanceof Error);
        assert(err.message.includes('FAILED'), 'Must reject with FAILED error');
        assert(err.message.includes('Corrupt video bitstream'));
        return true;
      }
    );

    assert.equal(deleteCalled, true, 'Must attempt cleanup of failed file');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('Gemini File Lifecycle: uploadVideoToFileApi attempts best-effort deletion if waiting for ACTIVE times out', async () => {
  const tmpFile = path.join(os.tmpdir(), `clipguard_test_timeout_del_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.alloc(1024, 0));

  let deleteCalled = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);

    if (init?.method === 'DELETE' && urlStr.includes('/files/timed-out-upload')) {
      deleteCalled = true;
      return new Response('', { status: 200 });
    }

    if (urlStr.includes('/upload/v1beta/files')) {
      return new Response('', {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://upload.example.com/session-to' },
      });
    }

    if (urlStr === 'https://upload.example.com/session-to') {
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/timed-out-upload',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/timed-out-upload',
            state: 'PROCESSING',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes('/files/timed-out-upload')) {
      return new Response(
        JSON.stringify({
          name: 'files/timed-out-upload',
          state: 'PROCESSING',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unexpected mock call: ${urlStr}`);
  };

  try {
    await assert.rejects(
      async () => {
        await uploadVideoToFileApi(tmpFile, 'video/mp4', 'mock-key', mockFetch as any, {
          maxAttempts: 2,
          pollIntervalMs: 1,
          totalTimeoutMs: 5000,
          sleepFn: async () => {},
        });
      },
      (err: any) => {
        assert(err instanceof Error);
        assert(err.message.includes('reached maximum attempts') || err.message.includes('timed out'));
        return true;
      }
    );

    assert.equal(deleteCalled, true, 'Must attempt cleanup when polling times out');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('Gemini File Lifecycle: executeGeminiVideoAnalysis calls DELETE in finally after successful analysis', async () => {
  const tmpFile = path.join(os.tmpdir(), `clipguard_test_large_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.alloc(16 * 1024 * 1024, 0)); // 16 MB

  let deleteCalled = false;
  let generateContentCalled = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method || 'GET';

    if (method === 'DELETE' && urlStr.includes('/files/large-vid-123')) {
      deleteCalled = true;
      return new Response('', { status: 200 });
    }

    if (urlStr.includes('/upload/v1beta/files')) {
      return new Response('', {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://upload.example.com/session-large' },
      });
    }

    if (urlStr === 'https://upload.example.com/session-large') {
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/large-vid-123',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/large-vid-123',
            state: 'ACTIVE',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes(':generateContent')) {
      generateContentCalled = true;
      const responsePayload = {
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    findings: [
                      {
                        startSeconds: 10,
                        endSeconds: 12,
                        category: 'possible_chest_exposure',
                        anatomicalState: 'exposed',
                        isExposed: true,
                        confidence: 90,
                        explanation: 'Confirmed exposed chest',
                      },
                    ],
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
      };
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected mock call: ${method} ${urlStr}`);
  };

  try {
    const result = await executeGeminiVideoAnalysis({
      apiKey: 'test-key',
      userConfirmedProjectBillingIntent: true,
      userConsentedVideoUpload: true,
      videoSource: { filePath: tmpFile },
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
      fetchFn: mockFetch as any,
      pollOptions: {
        maxAttempts: 5,
        pollIntervalMs: 1,
        totalTimeoutMs: 5000,
        sleepFn: async () => {},
      },
    });

    assert.equal(generateContentCalled, true, 'generateContent must be called');
    assert.equal(deleteCalled, true, 'File must be deleted in finally block');
    assert.equal(result.success, true);
    assert.equal(result.detections.length, 1);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('Gemini File Lifecycle: executeGeminiVideoAnalysis preserves original analysis error when DELETE also fails', async () => {
  const tmpFile = path.join(os.tmpdir(), `clipguard_test_quota_delfail_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.alloc(16 * 1024 * 1024, 0)); // 16 MB

  let deleteAttempted = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method || 'GET';

    if (method === 'DELETE' && urlStr.includes('/files/quota-vid-bothfail')) {
      deleteAttempted = true;
      return new Response(JSON.stringify({ error: 'Storage cluster unreachable' }), { status: 500 });
    }

    if (urlStr.includes('/upload/v1beta/files')) {
      return new Response('', {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://upload.example.com/session-bothfail' },
      });
    }

    if (urlStr === 'https://upload.example.com/session-bothfail') {
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/quota-vid-bothfail',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/quota-vid-bothfail',
            state: 'ACTIVE',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes(':generateContent')) {
      return new Response(
        JSON.stringify({
          error: {
            code: 429,
            message: 'RESOURCE_EXHAUSTED: quota limit exceeded for project',
          },
        }),
        { status: 429, statusText: 'Too Many Requests' }
      );
    }

    throw new Error(`Unexpected mock call: ${method} ${urlStr}`);
  };

  try {
    await assert.rejects(
      async () => {
        await executeGeminiVideoAnalysis({
          apiKey: 'test-key',
          userConfirmedProjectBillingIntent: true,
          userConsentedVideoUpload: true,
          videoSource: { filePath: tmpFile },
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
          fetchFn: mockFetch as any,
          pollOptions: {
            maxAttempts: 5,
            pollIntervalMs: 1,
            totalTimeoutMs: 5000,
            sleepFn: async () => {},
          },
        });
      },
      (err: any) => {
        assert(err instanceof GeminiQuotaExceededError, 'Must propagate GeminiQuotaExceededError');
        assert(err.message.includes('RESOURCE_EXHAUSTED'));
        return true;
      }
    );

    assert.equal(deleteAttempted, true, 'DELETE must be attempted in finally');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

test('Gemini File Lifecycle: executeGeminiVideoAnalysis returns success even when delayed DELETE times out via AbortController', async () => {
  const tmpFile = path.join(os.tmpdir(), `clipguard_test_del_hang_${Date.now()}.mp4`);
  fs.writeFileSync(tmpFile, Buffer.alloc(16 * 1024 * 1024, 0)); // 16 MB

  let deleteAborted = false;

  const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method || 'GET';

    if (method === 'DELETE' && urlStr.includes('/files/delhang-vid')) {
      const signal = init?.signal;
      assert(signal, 'DELETE must provide an AbortSignal');
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          deleteAborted = true;
          reject(new Error('AbortError'));
        });
      });
    }

    if (urlStr.includes('/upload/v1beta/files')) {
      return new Response('', {
        status: 200,
        headers: { 'x-goog-upload-url': 'https://upload.example.com/session-delhang' },
      });
    }

    if (urlStr === 'https://upload.example.com/session-delhang') {
      return new Response(
        JSON.stringify({
          file: {
            name: 'files/delhang-vid',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/delhang-vid',
            state: 'ACTIVE',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (urlStr.includes(':generateContent')) {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [{ text: JSON.stringify({ findings: [] }) }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unexpected mock call: ${method} ${urlStr}`);
  };

  try {
    const result = await executeGeminiVideoAnalysis({
      apiKey: 'test-key',
      userConfirmedProjectBillingIntent: true,
      userConsentedVideoUpload: true,
      videoSource: { filePath: tmpFile },
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
      fetchFn: mockFetch as any,
      pollOptions: {
        maxAttempts: 5,
        pollIntervalMs: 1,
        totalTimeoutMs: 5000,
        sleepFn: async () => {},
      },
      deleteOptions: {
        timeoutMs: 35,
      },
    });

    assert.equal(result.success, true, 'Analysis result must succeed promptly without hanging');
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});
