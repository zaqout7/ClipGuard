import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import type { Server } from 'node:http';
import {
  fetchYouTubeMetadata,
  startYouTubeDownload,
  getDownloadJob,
  cancelYouTubeDownload,
  cleanupYouTubeFile,
} from './src/server/youtubeService.js';
import {
  executeGeminiVideoAnalysis,
  GEMINI_MODELS,
  validateGeminiModelAndFps,
  GeminiQuotaExceededError,
  GeminiCapabilityError,
  DEFAULT_GEMINI_FPS,
  DEFAULT_GEMINI_MODEL,
} from './src/server/geminiService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvironment(): void {
  dotenv.config();
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) return;

  const candidateDirs: string[] = [
    __dirname,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'ClipGuard') : '',
    process.execPath ? path.dirname(process.execPath) : '',
  ].filter(Boolean);

  for (const dir of candidateDirs) {
    const candidateEnv = path.join(dir, '.env');
    if (fs.existsSync(candidateEnv)) {
      dotenv.config({ path: candidateEnv });
      if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) break;
    }
  }
}
loadEnvironment();

const app = express();
const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const HOST = process.env.HOST || '0.0.0.0';
let applicationRoot = __dirname;
let serverProductionMode = process.env.NODE_ENV === 'production';

function modelAssetsAvailable(): boolean {
  const isAsar = applicationRoot.endsWith('.asar');
  const candidateRoots = [
    path.resolve(applicationRoot, serverProductionMode ? 'dist' : 'public', 'models'),
  ];
  if (isAsar) {
    candidateRoots.unshift(
      path.resolve(applicationRoot.replace(/\.asar$/, '.asar.unpacked'), serverProductionMode ? 'dist' : 'public', 'models')
    );
  }

  // Check for the primary NudeNet model and runtime assets
  for (const modelRoot of candidateRoots) {
    const nudenetModel = path.join(modelRoot, 'nudenet', '320n.onnx');
    const wasmFile = path.join(modelRoot, 'onnxruntime', 'ort-wasm-simd-threaded.wasm');
    const wasmMjs = path.join(modelRoot, 'onnxruntime', 'ort-wasm-simd-threaded.mjs');
    if (fs.existsSync(nudenetModel) && fs.existsSync(wasmFile) && fs.existsSync(wasmMjs)) {
      return true;
    }
  }

  // Fallback check: ViT model assets
  for (const modelRoot of candidateRoots) {
    const vitModel = path.join(modelRoot, 'adamcodd-nsfw', 'model_quantized.onnx');
    const vitConfig = path.join(modelRoot, 'adamcodd-nsfw', 'config.json');
    const wasmFile = path.join(modelRoot, 'onnxruntime', 'ort-wasm-simd-threaded.wasm');
    const wasmMjs = path.join(modelRoot, 'onnxruntime', 'ort-wasm-simd-threaded.mjs');
    if (fs.existsSync(vitModel) && fs.existsSync(vitConfig) && fs.existsSync(wasmFile) && fs.existsSync(wasmMjs)) {
      return true;
    }
  }

  return false;
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Cross-Origin isolation headers required by ort-wasm-simd-threaded.wasm.
// SharedArrayBuffer (used internally by the ONNX runtime even with numThreads=1
// during feature-detection) is blocked by Chromium/Electron unless both
// Cross-Origin-Opener-Policy: same-origin  AND
// Cross-Origin-Embedder-Policy: require-corp  are present on every response.
// Without these the local analysis worker silently hangs at 0%.
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// YouTube Info & Local Download Endpoints
app.post('/api/youtube/info', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'YouTube URL is required.' });
    }
    const metadata = await fetchYouTubeMetadata(url);
    res.json({ success: true, metadata });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to fetch YouTube info.' });
  }
});

app.post('/api/youtube/prepare', async (req, res) => {
  try {
    const { url, jobId: requestedJobId, metadata } = req.body;
    if (!url) {
      return res.status(400).json({ success: false, error: 'YouTube URL is required.' });
    }
    const jobId = requestedJobId || crypto.randomUUID();
    const job = await startYouTubeDownload(url, jobId, metadata);
    res.json({ success: true, jobId, status: job.status });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to start YouTube download.' });
  }
});

app.get('/api/youtube/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = getDownloadJob(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Download job not found.' });
  }
  res.json({
    success: true,
    status: job.status,
    progressPercent: job.progressPercent,
    error: job.error,
    metadata: job.metadata,
  });
});

app.get('/api/youtube/file/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = getDownloadJob(jobId);
  if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
    return res.status(404).json({ success: false, error: 'Downloaded file not found.' });
  }
  res.sendFile(job.filePath, { acceptRanges: true });
});

app.post('/api/youtube/cancel/:jobId', (req, res) => {
  const { jobId } = req.params;
  const cancelled = cancelYouTubeDownload(jobId);
  res.json({ success: true, cancelled });
});

app.post('/api/youtube/cleanup/:jobId', (req, res) => {
  const { jobId } = req.params;
  const cleaned = cleanupYouTubeFile(jobId);
  res.json({ success: true, cleaned });
});

// Gemini Video Analysis Endpoints
app.get('/api/gemini/status', (_req, res) => {
  const hasEnvKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim());
  res.json({
    success: true,
    hasEnvKey,
    defaultFps: DEFAULT_GEMINI_FPS,
    defaultModel: DEFAULT_GEMINI_MODEL,
    models: Object.values(GEMINI_MODELS),
    samplingNotice: 'Configured to request 4 FPS (one frame every 0.25 seconds) via videoMetadata.fps: 4.',
    interFrameNotice: 'Events shorter than 0.25 seconds occurring entirely between sampled frames may still be missed.',
    billingNotice: 'Billing depends entirely on your Google Cloud / Google AI Studio project settings (whether a billing account is attached). Verify your project\'s billing status at https://aistudio.google.com/.',
    quotaNotice: 'Check your project\'s active quota and rate limits in Google AI Studio (https://aistudio.google.com/app/plan_information) or the Google Cloud Console.',
  });
});

app.get('/api/gemini/models', (_req, res) => {
  res.json({
    success: true,
    models: Object.values(GEMINI_MODELS),
  });
});

app.post('/api/gemini/analyze', async (req, res) => {
  try {
    const {
      apiKey: clientKey,
      model = DEFAULT_GEMINI_MODEL,
      fps = DEFAULT_GEMINI_FPS,
      userConfirmedProjectBillingIntent = false,
      userConsentedVideoUpload = false,
      videoPath,
      youtubeJobId,
      inlineBase64,
      fileUri,
      mimeType = 'video/mp4',
      options,
      videoDurationSeconds,
    } = req.body;

    if (!userConfirmedProjectBillingIntent) {
      return res.status(400).json({
        success: false,
        error: 'Explicit project confirmation required: You must confirm that you understand billing depends on your Google project configuration and that you intend to use this project.',
      });
    }

    if (!userConsentedVideoUpload) {
      return res.status(400).json({
        success: false,
        error: 'Explicit consent required: You must explicitly confirm consent to transmit video data to Google\'s Gemini API (generativelanguage.googleapis.com).',
      });
    }

    const apiKey = (clientKey && clientKey.trim()) || process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      return res.status(400).json({
        success: false,
        error: 'A Gemini API key is required. Please configure GEMINI_API_KEY in .env on the server or enter your key in Settings.',
      });
    }

    let resolvedVideoPath = videoPath;
    if (youtubeJobId) {
      const job = getDownloadJob(youtubeJobId);
      if (!job || !job.filePath || !fs.existsSync(job.filePath)) {
        return res.status(404).json({
          success: false,
          error: `Downloaded YouTube file for job ${youtubeJobId} not found.`,
        });
      }
      resolvedVideoPath = job.filePath;
    }

    const result = await executeGeminiVideoAnalysis({
      apiKey,
      model,
      fps: Number(fps) || DEFAULT_GEMINI_FPS,
      userConfirmedProjectBillingIntent: Boolean(userConfirmedProjectBillingIntent),
      userConsentedVideoUpload: Boolean(userConsentedVideoUpload),
      videoSource: {
        fileUri,
        inlineBase64,
        filePath: resolvedVideoPath,
        mimeType,
      },
      options: options || {
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
        },
      },
      videoDurationSeconds,
    });

    res.json(result);
  } catch (err: any) {
    if (err instanceof GeminiQuotaExceededError) {
      return res.status(429).json({
        success: false,
        quotaExceeded: true,
        error: err.message,
      });
    }
    if (err instanceof GeminiCapabilityError) {
      return res.status(400).json({
        success: false,
        capabilityError: true,
        error: err.message,
      });
    }
    res.status(500).json({
      success: false,
      error: err.message || 'Gemini video analysis failed.',
    });
  }
});

const MISSING_MODEL_REASON =
  'The local classifier/runtime assets are missing. Restore the bundled model and ONNX Runtime WebAssembly files; no remote inference fallback is used.';

// System Status Endpoint
app.get('/api/system-status', (req, res) => {
  try {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    res.json({
      success: true,
      platform: `${os.type()} ${os.arch()} (${os.release()})`,
      cpuCores: cpus.length,
      cpuModel: cpus[0]?.model || 'Standard Multi-Core CPU',
      totalMemGb: parseFloat((totalMem / (1024 * 1024 * 1024)).toFixed(1)),
      freeMemGb: parseFloat((freeMem / (1024 * 1024 * 1024)).toFixed(1)),
      localAnalysisAvailable: modelAssetsAvailable(),
      localAnalysisReason: modelAssetsAvailable()
        ? 'Bundled browser model and ONNX Runtime WebAssembly CPU assets are present. They are loaded on demand in the browser; actual initialization is checked when a local video is analyzed.'
        : MISSING_MODEL_REASON,
      modelName: 'NudeNet YOLOv8n (320n.onnx) / AdamCodd ViT fallback',
      modelRevision: 'NudeNet v3 320n / AdamCodd 8587de9',
      modelLabels: [
        'FEMALE_GENITALIA_COVERED',
        'FACE_FEMALE',
        'BUTTOCKS_EXPOSED',
        'FEMALE_BREAST_EXPOSED',
        'FEMALE_GENITALIA_EXPOSED',
        'MALE_BREAST_EXPOSED',
        'ANUS_EXPOSED',
        'FEET_EXPOSED',
        'BELLY_COVERED',
        'FEET_COVERED',
        'ARMPITS_COVERED',
        'ARMPITS_EXPOSED',
        'FACE_MALE',
        'BELLY_EXPOSED',
        'MALE_GENITALIA_EXPOSED',
        'ANUS_COVERED',
        'FEMALE_BREAST_COVERED',
        'BUTTOCKS_COVERED',
      ],
      inferenceProvider: 'ONNX Runtime WebAssembly CPU (single thread)',
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Export Formatter Endpoint (TXT, CSV, JSON, EDL)
app.post('/api/export', (req, res) => {
  try {
    const { format, videoMetadata, detections } = req.body;

    if (!detections || !Array.isArray(detections)) {
      return res.status(400).json({ success: false, error: 'Detections array is required' });
    }

    const safeTitle = (videoMetadata?.title || 'video_analysis')
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);

    if (format === 'csv') {
      const headers = [
        'Index',
        'Start Timecode',
        'End Timecode',
        'Start (Seconds)',
        'End (Seconds)',
        'Category',
        'Confidence (%)',
        'Review Status',
        'Severity',
        'False Positive Risk',
        'Explanation',
        'Visual Evidence',
        'Editor Notes',
      ];

      const rows = detections.map((d: any, index: number) => [
        index + 1,
        `"${d.startTimestamp}"`,
        `"${d.endTimestamp}"`,
        d.startSeconds,
        d.endSeconds,
        `"${d.categoryLabel || d.category}"`,
        d.confidence,
        `"${d.reviewStatus}"`,
        `"${d.severity}"`,
        `"${d.falsePositiveRisk}"`,
        `"${(d.explanation || '').replace(/"/g, '""')}"`,
        `"${(d.visualEvidence || '').replace(/"/g, '""')}"`,
        `"${(d.editorNotes || '').replace(/"/g, '""')}"`,
      ]);

      const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_review_timestamps.csv"`);
      return res.send(csvContent);
    }

    if (format === 'json') {
      const jsonContent = JSON.stringify(
        {
          video: videoMetadata,
          exportDate: new Date().toISOString(),
          totalDetections: detections.length,
          detections,
        },
        null,
        2
      );

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_review_timestamps.json"`);
      return res.send(jsonContent);
    }

    if (format === 'edl') {
      let edl = `TITLE: ${safeTitle}\nFCM: NON-DROP FRAME\n\n`;
      detections.forEach((d: any, idx: number) => {
        const num = (idx + 1).toString().padStart(3, '0');
        const toEdlTime = (sec: number) => {
          const s = Math.max(0, Math.floor(sec));
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const remS = s % 60;
          return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${remS.toString().padStart(2, '0')}:00`;
        };
        const inTc = toEdlTime(d.startSeconds);
        const outTc = toEdlTime(d.endSeconds);
        edl += `${num}  AX       V     C        ${inTc} ${outTc} ${inTc} ${outTc}\n`;
        edl += `* FROM CLIP NAME: ${videoMetadata?.title || 'Clip'}\n`;
        edl += `* COMMENT: [${d.categoryLabel || d.category}] Confidence ${d.confidence}% - ${d.explanation}\n\n`;
      });

      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_markers.edl"`);
      return res.send(edl);
    }

    let txt = `==================================================\n`;
    txt += `VIDEO MODERATION & WARDROBE REVIEW REPORT\n`;
    txt += `==================================================\n\n`;
    txt += `Video Title:   ${videoMetadata?.title || 'Unknown'}\n`;
    txt += `Video URL:     ${videoMetadata?.url || 'N/A'}\n`;
    txt += `Channel/Owner: ${videoMetadata?.author || 'N/A'}\n`;
    txt += `Duration:      ${videoMetadata?.durationFormatted || 'N/A'}\n`;
    txt += `Generated At:  ${new Date().toLocaleString()}\n`;
    txt += `Candidate Moments for Human Review: ${detections.length}\n`;
    txt += `Notice: AI detection is probabilistic. Human review is required before editorial action.\n\n`;
    txt += `==================================================\n`;
    txt += `DETECTED TIMESTAMPS FOR REVIEW\n`;
    txt += `==================================================\n\n`;

    detections.forEach((d: any, index: number) => {
      txt += `${index + 1}. ${d.startTimestamp} - ${d.endTimestamp}\n`;
      txt += `   Category:    ${d.categoryLabel || d.category}\n`;
      txt += `   Confidence:  ${d.confidence}%\n`;
      txt += `   Status:      ${d.reviewStatus.toUpperCase().replace('_', ' ')}\n`;
      txt += `   Severity:    ${d.severity?.toUpperCase() || 'MEDIUM'}\n`;
      txt += `   False Pos.:  ${d.falsePositiveRisk?.toUpperCase() || 'LOW'}\n`;
      txt += `   Reason:      ${d.explanation}\n`;
      if (d.visualEvidence) {
        txt += `   Visual Cues: ${d.visualEvidence}\n`;
      }
      if (d.editorNotes) {
        txt += `   Editor Note: ${d.editorNotes}\n`;
      }
      txt += `\n`;
    });

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_review_timestamps.txt"`);
    res.send(txt);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Download Complete Project Archive (.tar.gz)
app.get('/api/download-archive', (req, res) => {
  const archivePath = path.resolve(applicationRoot, 'clipguard-project.tar.gz');
  if (fs.existsSync(archivePath)) {
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="clipguard-project.tar.gz"');
    fs.createReadStream(archivePath).pipe(res);
  } else {
    res.status(404).send('Project archive not found. Run tar command to generate.');
  }
});

// Download Focused Update Archive (.zip) containing only modified/new files
app.get('/api/download-update', (req, res) => {
  const updateZipPath = path.resolve(applicationRoot, 'clipguard-update.zip');
  if (fs.existsSync(updateZipPath)) {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="clipguard-update.zip"');
    fs.createReadStream(updateZipPath).pipe(res);
  } else {
    res.status(404).send('Update archive not found.');
  }
});

// Vite Middleware for Development / Static file serving for Production
async function setupVite(production: boolean) {
  if (!production) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      // Load vite.config.ts so COOP/COEP server.headers are applied even in
      // middleware mode (desktop:dev uses Express + Vite middlewares together;
      // the headers middleware above handles it, but configFile ensures Vite
      // resolves the correct base config including resolve.conditions).
      configFile: path.resolve(applicationRoot, 'vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    // Ensure correct MIME types for WASM and ESM module files so the browser
    // loads them without network errors (some Windows Express versions default
    // to application/octet-stream for .wasm and .mjs).
    express.static.mime.define({ 'application/wasm': ['wasm'] });
    express.static.mime.define({ 'text/javascript': ['mjs'] });

    // When packaged in Electron with asarUnpack, unpacked models live in app.asar.unpacked
    const isAsar = applicationRoot.endsWith('.asar');
    let distPath = path.resolve(applicationRoot, 'dist');
    if (isAsar) {
      const unpackedDist = path.resolve(applicationRoot.replace(/\.asar$/, '.asar.unpacked'), 'dist');
      if (fs.existsSync(unpackedDist)) {
        app.use(express.static(unpackedDist));
      }
      // If fs cannot read inside asar (e.g. running under non-Electron Node test), fall back to unpacked or project dist
      if (!fs.existsSync(path.join(distPath, 'index.html'))) {
        if (fs.existsSync(path.join(unpackedDist, 'index.html'))) {
          distPath = unpackedDist;
        } else if (fs.existsSync(path.resolve(__dirname, 'dist', 'index.html'))) {
          distPath = path.resolve(__dirname, 'dist');
        }
      }
    }

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      // Return 404 for missing static files (models, wasm, json, etc.) rather than serving index.html
      if (req.path.includes('.') && !req.path.endsWith('.html')) {
        return res.status(404).send('Not Found');
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}


interface StartServerOptions {
  port?: number;
  production?: boolean;
  applicationRoot?: string;
}

export async function startServer({
  port = PORT,
  production = process.env.NODE_ENV === 'production',
  applicationRoot: root = __dirname,
}: StartServerOptions = {}): Promise<Server> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError('The local service port must be an integer between 0 and 65535.');
  }
  applicationRoot = root;
  serverProductionMode = production;
  await setupVite(production);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      const address = server.address();
      const actualPort = address && typeof address !== 'string' ? address.port : port;
      console.log(`[ClipGuard] Video Review Server running on http://${HOST}:${actualPort}`);
      resolve(server);
    });
  });
}

export { app };