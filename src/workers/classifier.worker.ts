import * as ort from 'onnxruntime-web/wasm';
import { rgbaToNormalizedNchw, softmaxClassScore } from '../utils/modelPreprocessing';

interface InitMessage {
  type: 'init';
  modelUrl: string;
  configUrl: string;
  wasmUrl: string;
  wasmMjsUrl: string;
}

interface ClassifyMessage {
  type: 'classify';
  requestId: number;
  pixels: Uint8ClampedArray;
}

type WorkerRequest = InitMessage | ClassifyMessage;

interface WorkerResponse {
  type: 'ready' | 'result' | 'error';
  requestId?: number;
  provider?: string;
  labels?: string[];
  score?: number;
  error?: string;
}

const scope = self as unknown as {
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
  postMessage(message: WorkerResponse): void;
};
let session: ort.InferenceSession | null = null;
let inputName = '';
let outputName = '';
let labels: string[] = [];
let initializing = false;
let classifying = false;

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

async function initialize(message: InitMessage): Promise<void> {
  try {
    const [configResponse, preprocessorResponse] = await Promise.all([
      fetch(message.configUrl),
      fetch(message.configUrl.replace(/config\.json$/, 'preprocessor_config.json')),
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

    labels = Object.keys(config.id2label ?? {})
      .sort((left, right) => Number(left) - Number(right))
      .map((index) => String(config.id2label?.[index]).toLowerCase());
    const size = preprocessor.size;
    if (
      labels.length !== 2 ||
      labels[0] !== 'sfw' ||
      labels[1] !== 'nsfw' ||
      size?.height !== 384 ||
      size.width !== 384 ||
      config.image_size !== 384 ||
      preprocessor.do_resize !== true ||
      preprocessor.do_rescale !== true ||
      preprocessor.do_normalize !== true ||
      preprocessor.resample !== 2 ||
      Math.abs((preprocessor.rescale_factor ?? 0) - (1 / 255)) > 1e-8 ||
      preprocessor.image_mean?.length !== 3 ||
      preprocessor.image_mean.some((value) => value !== 0.5) ||
      preprocessor.image_std?.length !== 3 ||
      preprocessor.image_std.some((value) => value !== 0.5)
    ) {
      throw new Error('The installed model labels or image preprocessing do not match the supported model contract.');
    }

    ort.env.wasm.wasmPaths = {
      wasm: message.wasmUrl,
      mjs: message.wasmMjsUrl,
    };
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(message.modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    if (
      session.inputNames.length !== 1 ||
      session.outputNames.length !== 1 ||
      session.inputMetadata.length !== 1 ||
      session.outputMetadata.length !== 1
    ) {
      throw new Error('The installed model does not expose the expected single-image classifier inputs and outputs.');
    }
    inputName = session.inputNames[0];
    outputName = session.outputNames[0];
    const input = session.inputMetadata[0];
    const output = session.outputMetadata[0];
    if (!input.isTensor || input.type !== 'float32' ||
        input.shape.length !== 4 || !isSupportedBatchDimension(input.shape[0]) ||
        !isCompatibleDimension(input.shape[1], 3) ||
        !isCompatibleDimension(input.shape[2], 384) ||
        !isCompatibleDimension(input.shape[3], 384)) {
      throw new Error(`Unsupported model input tensor: ${JSON.stringify(input)}.`);
    }
    if (!output.isTensor || output.type !== 'float32' ||
        output.shape.length !== 2 || !isSupportedBatchDimension(output.shape[0]) || output.shape[1] !== 2) {
      throw new Error(`Unsupported model output tensor: ${JSON.stringify(output)}.`);
    }

    function isSupportedBatchDimension(dimension: number | string): boolean {
      return dimension === 1 || typeof dimension === 'string';
    }
    function isCompatibleDimension(dimension: number | string, expected: number): boolean {
      return dimension === expected || typeof dimension === 'string';
    }

    scope.postMessage({
      type: 'ready',
      provider: 'ONNX Runtime WebAssembly CPU (single thread)',
      labels,
    } satisfies WorkerResponse);
  } catch (error) {
    initializing = false;
    scope.postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : 'Unable to initialize the local image model.',
    } satisfies WorkerResponse);
  }
}

async function classify(message: ClassifyMessage): Promise<void> {
  try {
    if (!session) throw new Error('The local model is not ready.');
    if (!Number.isSafeInteger(message.requestId) || message.requestId <= 0) {
      throw new Error('Invalid local classifier request ID.');
    }
    const expectedPixels = 384 * 384 * 4;
    if (message.pixels.length !== expectedPixels) {
      throw new Error(`Expected a 384×384 RGBA image (${expectedPixels} bytes).`);
    }

    const planar = rgbaToNormalizedNchw(message.pixels, 384, 384);
    const tensor = new ort.Tensor('float32', planar, [1, 3, 384, 384]);
    const result = await session.run({ [inputName]: tensor });
    const values = result[outputName]?.data;
    if (!values || values.length !== labels.length) {
      throw new Error('The local model returned an unexpected number of class scores.');
    }

    const nsfwIndex = labels.indexOf('nsfw');
    const score = softmaxClassScore(Array.from(values, Number), nsfwIndex);

    scope.postMessage({
      type: 'result',
      requestId: message.requestId,
      score,
    } satisfies WorkerResponse);
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
