import * as ort from 'onnxruntime-web/wasm';
import { rgbaToNormalizedNchw, softmaxClassScore } from '../utils/modelPreprocessing';
import {
  NUDENET_CLASSES,
  NUDENET_RELEVANT_CLASSES,
  NUDENET_INPUT_SIZE,
  decodeNudeNetOutput,
  preprocessRgbaToNudeNetPlanar,
} from '../utils/nudenetMapping';

// ---------------------------------------------------------------------------
// Message types shared with localAnalysis.ts
// ---------------------------------------------------------------------------

interface InitMessage {
  type: 'init';
  /** URL to the NudeNet 320n.onnx model (primary). */
  nudenetModelUrl: string;
  /** URL to the ViT fallback model_quantized.onnx. */
  vitModelUrl: string;
  vitConfigUrl: string;
  wasmUrl: string;
  wasmMjsUrl: string;
}

interface ClassifyMessage {
  type: 'classify';
  requestId: number;
  /** Raw RGBA pixels from a 320×320 canvas (NudeNet) or 384×384 (ViT fallback). */
  pixels: Uint8ClampedArray;
  /** Width of the pixel buffer (320 for NudeNet, 384 for ViT). */
  width: number;
  height: number;
  /** Active draw dimensions within the canvas (for letterboxing aspect-ratio preservation). */
  drawWidth?: number;
  drawHeight?: number;
}

type WorkerRequest = InitMessage | ClassifyMessage;

// A single detected region from NudeNet or ViT
export interface DetectedRegion {
  /** NudeNet class name, e.g. "FEMALE_BREAST_EXPOSED" */
  className: string;
  score: number;
  /** x1,y1,x2,y2 in 0-1 normalised coords (absent for ViT) */
  box?: [number, number, number, number];
}

interface WorkerResponse {
  type: 'ready' | 'result' | 'error';
  requestId?: number;
  provider?: string;
  /** Active detection backend label reported on init */
  detectorBackend?: 'nudenet' | 'vit';
  /** Explicit warning when falling back to legacy ViT */
  fallbackWarning?: string;
  /** Per-frame result: list of detections above threshold */
  detections?: DetectedRegion[];
  /** Legacy ViT: single probability for nsfw class */
  score?: number;
  error?: string;
  diagnostic?: {
    rawTopPredictions: Array<{ className: string; score: number }>;
  };
}


// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

const scope = self as unknown as {
  crossOriginIsolated: boolean;
  navigator?: { hardwareConcurrency?: number };
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void;
  postMessage(message: WorkerResponse): void;
};

type DetectorBackend = 'nudenet' | 'vit';

let session: ort.InferenceSession | null = null;
let detectorBackend: DetectorBackend = 'nudenet';
let vitLabels: string[] = [];
let initializing = false;
let classifying = false;
let activeProvider = '';

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

scope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === 'init') {
    if (initializing || session) {
      scope.postMessage({ type: 'error', error: 'The local model worker was initialized more than once.' });
      return;
    }
    initializing = true;
    void initialize(event.data);
    return;
  }

  if (event.data.type === 'classify') {
    if (classifying) {
      scope.postMessage({
        type: 'error',
        requestId: event.data.requestId,
        error: 'Only one frame can be classified at a time.',
      });
      return;
    }
    classifying = true;
    void classify(event.data);
  }
});

// Surface MessageDeserializationError so the caller never waits indefinitely.
(self as unknown as { addEventListener(type: 'messageerror', listener: (event: MessageEvent) => void): void })
  .addEventListener('messageerror', (_event: MessageEvent) => {
    scope.postMessage({
      type: 'error',
      error: 'Worker received a message that could not be deserialized (possible SharedArrayBuffer / COOP-COEP issue).',
    } satisfies WorkerResponse);
  });

// ---------------------------------------------------------------------------
// ONNX Runtime env setup
// ---------------------------------------------------------------------------

function configureOrtEnv(message: InitMessage): void {
  // WASM paths must be set before any session is created.
  ort.env.wasm.wasmPaths = {
    wasm: message.wasmUrl,
    mjs: message.wasmMjsUrl,
  };

  // Multi-threading: only when crossOriginIsolated (COOP+COEP headers in place).
  if (scope.crossOriginIsolated) {
    const cores = scope.navigator?.hardwareConcurrency ?? 4;
    // Leave at least 2 cores for the main thread / video decode.
    const threads = Math.min(8, Math.max(2, cores - 2));
    ort.env.wasm.numThreads = threads;
  } else {
    ort.env.wasm.numThreads = 1;
  }

  // Enable SIMD regardless of isolation (SIMD does not require SAB).
  ort.env.wasm.simd = true;
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function initialize(message: InitMessage): Promise<void> {
  try {
    configureOrtEnv(message);

    // -----------------------------------------------------------------------
    // Try NudeNet 320n.onnx first (primary path)
    // -----------------------------------------------------------------------
    const nudenetAvailable = await checkUrlReachable(message.nudenetModelUrl);

    if (nudenetAvailable) {
      session = await createSessionWithProviderFallback(message.nudenetModelUrl);
      detectorBackend = 'nudenet';

      // Validate NudeNet tensor shapes: input [1,3,320,320], output [1,22,2100]
      if (
        session.inputNames.length !== 1 ||
        session.outputNames.length !== 1
      ) {
        throw new Error('NudeNet model does not expose the expected single-input/single-output layout.');
      }

      const inp = session.inputMetadata[0];
      const out = session.outputMetadata[0];

      if (!inp.isTensor || inp.type !== 'float32') {
        throw new Error(`NudeNet model input must be float32 tensor, got: ${((inp as any).type || JSON.stringify(inp))}.`);
      }
      // Shape can be [1,3,320,320] or dynamic – just ensure at least 4 dims
      if (inp.shape.length !== 4) {
        throw new Error(`NudeNet model input must have 4 dimensions, got: ${inp.shape.length}.`);
      }
      if (!out.isTensor || out.type !== 'float32') {
        throw new Error(`NudeNet model output must be float32 tensor, got: ${((out as any).type || JSON.stringify(out))}.`);
      }
      // Output shape should be [1, 22, 2100] — 22 = 4 box coords + 18 classes
      if (out.shape.length !== 3) {
        throw new Error(`NudeNet output must have 3 dimensions [batch, 22, anchors], got: ${out.shape.length}.`);
      }

      const numRows = Number(out.shape[1]);
      if (numRows !== 22) {
        throw new Error(`NudeNet output dim[1] must be 22 (4 box + 18 class), got: ${numRows}.`);
      }

      scope.postMessage({
        type: 'ready',
        provider: activeProvider,
        detectorBackend: 'nudenet',
      } satisfies WorkerResponse);
      return;
    }

    // -----------------------------------------------------------------------
    // Fallback: ViT NSFW binary classifier
    // -----------------------------------------------------------------------
    const fallbackWarning = `Primary anatomical model (NudeNet) not found or unreachable at ${message.nudenetModelUrl}. Active detector is the fallback ViT NSFW binary classifier.`;
    console.warn(`[ClipGuard worker] ${fallbackWarning}`);

    await initializeVit(message, fallbackWarning);

  } catch (error) {
    initializing = false;
    scope.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : 'Unable to initialize the local image model.',
    } satisfies WorkerResponse);
  }
}

async function initializeVit(message: InitMessage, fallbackWarning?: string): Promise<void> {
  const [configResponse, preprocessorResponse] = await Promise.all([
    fetch(message.vitConfigUrl),
    fetch(message.vitConfigUrl.replace(/config\.json$/, 'preprocessor_config.json')),
  ]);
  if (!configResponse.ok || !preprocessorResponse.ok) {
    throw new Error('The local model configuration files are missing. Reinstall the approved model files.');
  }

  const config = await configResponse.json() as {
    id2label?: Record<string, string>;
    image_size?: number;
  };
  const preprocessor = await preprocessorResponse.json() as {
    size?: { height?: number; width?: number };
    image_mean?: number[];
    image_std?: number[];
    rescale_factor?: number;
    resample?: number;
    do_resize?: boolean;
    do_rescale?: boolean;
    do_normalize?: boolean;
  };

  vitLabels = Object.keys(config.id2label ?? {})
    .sort((l, r) => Number(l) - Number(r))
    .map((i) => String(config.id2label?.[i]).toLowerCase());

  const size = preprocessor.size;
  if (
    vitLabels.length !== 2 ||
    vitLabels[0] !== 'sfw' ||
    vitLabels[1] !== 'nsfw' ||
    size?.height !== 384 ||
    size.width !== 384 ||
    config.image_size !== 384 ||
    preprocessor.do_resize !== true ||
    preprocessor.do_rescale !== true ||
    preprocessor.do_normalize !== true ||
    preprocessor.resample !== 2 ||
    Math.abs((preprocessor.rescale_factor ?? 0) - (1 / 255)) > 1e-8 ||
    preprocessor.image_mean?.length !== 3 ||
    preprocessor.image_mean.some((v) => v !== 0.5) ||
    preprocessor.image_std?.length !== 3 ||
    preprocessor.image_std.some((v) => v !== 0.5)
  ) {
    throw new Error('The installed ViT model labels or preprocessing do not match the supported contract.');
  }

  session = await createSessionWithProviderFallback(message.vitModelUrl);
  detectorBackend = 'vit';

  const inp = session.inputMetadata[0];
  const out = session.outputMetadata[0];
  if (
    session.inputNames.length !== 1 || session.outputNames.length !== 1 ||
    !inp.isTensor || inp.type !== 'float32' ||
    inp.shape.length !== 4 || !isSupportedBatch(inp.shape[0]) ||
    !compatDim(inp.shape[2], 384) || !compatDim(inp.shape[3], 384) ||
    !out.isTensor || out.type !== 'float32' ||
    out.shape.length !== 2 || !isSupportedBatch(out.shape[0]) || out.shape[1] !== 2
  ) {
    throw new Error('The installed ViT model does not expose the expected single-image classifier shape.');
  }

  scope.postMessage({
    type: 'ready',
    provider: activeProvider,
    detectorBackend: 'vit',
    fallbackWarning,
  } satisfies WorkerResponse);
}

function isSupportedBatch(d: number | string): boolean {
  return d === 1 || typeof d === 'string';
}
function compatDim(d: number | string, expected: number): boolean {
  return d === expected || typeof d === 'string';
}

// ---------------------------------------------------------------------------
// Session creation with WebGPU → WASM fallback
// ---------------------------------------------------------------------------

async function createSessionWithProviderFallback(modelUrl: string): Promise<ort.InferenceSession> {
  // Try WebGPU first if available
  const gpuAvailable = typeof (self as unknown as { navigator?: { gpu?: unknown } })
    .navigator?.gpu !== 'undefined';

  if (gpuAvailable) {
    try {
      const s = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['webgpu', 'wasm'],
        graphOptimizationLevel: 'all',
      });
      activeProvider = buildProviderLabel('webgpu');
      return s;
    } catch {
      // WebGPU failed — fall through to WASM
    }
  }

  const s = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  activeProvider = buildProviderLabel('wasm');
  return s;
}

function buildProviderLabel(ep: 'webgpu' | 'wasm'): string {
  if (ep === 'webgpu') {
    return 'ONNX Runtime WebGPU (GPU accelerated)';
  }
  const threads = ort.env.wasm.numThreads ?? 1;
  const iso = scope.crossOriginIsolated;
  return `ONNX Runtime WebAssembly SIMD CPU (${threads} thread${threads !== 1 ? 's' : ''}${iso ? ', isolated' : ''})`;
}

// ---------------------------------------------------------------------------
// URL reachability probe (HEAD with fallback to GET range)
// ---------------------------------------------------------------------------

async function checkUrlReachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('text/html')) return false;
    return r.ok;
  } catch {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-3' }, cache: 'no-store' });
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('text/html')) return false;
      return r.ok || r.status === 206;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Classify dispatcher
// ---------------------------------------------------------------------------

async function classify(message: ClassifyMessage): Promise<void> {
  try {
    if (!session) throw new Error('The local model is not ready.');
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0) {
      throw new Error('Invalid local classifier request ID.');
    }

    if (detectorBackend === 'nudenet') {
      await classifyNudeNet(message);
    } else {
      await classifyViT(message);
    }
  } catch (error) {
    scope.postMessage({
      type: 'error',
      requestId: message.requestId,
      error: error instanceof Error ? error.message : 'Local model inference failed.',
    } satisfies WorkerResponse);
  } finally {
    classifying = false;
  }
}

// ---------------------------------------------------------------------------
// NudeNet inference  (320×320 input expected)
// ---------------------------------------------------------------------------

async function classifyNudeNet(message: ClassifyMessage): Promise<void> {
  const { width, height } = message;
  const drawWidth = message.drawWidth ?? NUDENET_INPUT_SIZE;
  const drawHeight = message.drawHeight ?? NUDENET_INPUT_SIZE;
  const expectedPixels = width * height * 4;
  if (message.pixels.length !== expectedPixels) {
    throw new Error(`Expected ${width}×${height} RGBA image (${expectedPixels} bytes), got ${message.pixels.length}.`);
  }
  if (width !== NUDENET_INPUT_SIZE || height !== NUDENET_INPUT_SIZE) {
    throw new Error(`NudeNet requires ${NUDENET_INPUT_SIZE}×${NUDENET_INPUT_SIZE} pixels, got ${width}×${height}.`);
  }

  // Preprocess: RGBA → [1, 3, 320, 320] float32 normalised to [0, 1] using shared production helper
  const inputData = preprocessRgbaToNudeNetPlanar(message.pixels, NUDENET_INPUT_SIZE, NUDENET_INPUT_SIZE);

  const inputName = session!.inputNames[0];
  const outputName = session!.outputNames[0];
  const tensor = new ort.Tensor('float32', inputData, [1, 3, NUDENET_INPUT_SIZE, NUDENET_INPUT_SIZE]);

  const t0 = performance.now();
  const result = await session!.run({ [inputName]: tensor });
  const inferenceMs = performance.now() - t0;

  const raw = result[outputName]?.data as Float32Array | undefined;
  if (!raw) throw new Error('NudeNet model returned no output tensor.');

  // raw shape [1, 22, 2100]:  dim[1]=22 (4 coords + 18 classes), dim[2]=anchors
  const numAnchors = raw.length / 22; // e.g. 2100
  const { detections, rawTopPredictions } = decodeNudeNetOutput(
    raw,
    numAnchors,
    inferenceMs,
    drawWidth,
    drawHeight,
  );

  scope.postMessage({
    type: 'result',
    requestId: message.requestId,
    detections,
    diagnostic: {
      rawTopPredictions,
    },
  } satisfies WorkerResponse);
}

// ---------------------------------------------------------------------------
// ViT fallback inference  (384×384 input expected)
// ---------------------------------------------------------------------------

async function classifyViT(message: ClassifyMessage): Promise<void> {
  const expectedPixels = 384 * 384 * 4;
  if (message.pixels.length !== expectedPixels) {
    throw new Error(`ViT expects a 384×384 RGBA image (${expectedPixels} bytes), got ${message.pixels.length}.`);
  }

  const planar = rgbaToNormalizedNchw(message.pixels, 384, 384);
  const tensor = new ort.Tensor('float32', planar, [1, 3, 384, 384]);
  const inputName = session!.inputNames[0];
  const outputName = session!.outputNames[0];

  const result = await session!.run({ [inputName]: tensor });
  const values = result[outputName]?.data;
  if (!values || values.length !== vitLabels.length) {
    throw new Error('ViT model returned an unexpected number of class scores.');
  }

  const nsfwIndex = vitLabels.indexOf('nsfw');
  const score = softmaxClassScore(Array.from(values, Number), nsfwIndex);

  // Express as a synthetic DetectedRegion so localAnalysis.ts can use a uniform path
  const detections: DetectedRegion[] = score > 0
    ? [{ className: 'VIT_NSFW', score }]
    : [];

  scope.postMessage({
    type: 'result',
    requestId: message.requestId,
    detections,
    score, // keep legacy field for backward-compat
    diagnostic: {
      rawTopPredictions: [{ className: 'nsfw', score: Math.round(score * 1000) / 1000 }],
    },
  } satisfies WorkerResponse);
}
