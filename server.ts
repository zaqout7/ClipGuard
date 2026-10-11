import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import type { Server } from 'node:http';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const HOST = '127.0.0.1';
let applicationRoot = __dirname;
let serverProductionMode = process.env.NODE_ENV === 'production';

function modelAssetsAvailable(): boolean {
  const modelRoot = path.resolve(
    applicationRoot,
    serverProductionMode ? 'dist' : 'public',
    'models'
  );
  const modelFiles = [
    path.join(modelRoot, 'adamcodd-nsfw', 'model_quantized.onnx'),
    path.join(modelRoot, 'adamcodd-nsfw', 'config.json'),
    path.join(modelRoot, 'adamcodd-nsfw', 'preprocessor_config.json'),
    path.join(modelRoot, 'onnxruntime', 'ort-wasm-simd-threaded.wasm'),
    path.join(modelRoot, 'onnxruntime', 'ort-wasm-simd-threaded.mjs'),
  ];
  return modelFiles.every((file) => fs.existsSync(file));
}

app.use(
  [
    '/api/analyze-frames',
    '/api/verify-sequence',
    '/api/analyze-youtube',
    '/api/video-info',
  ],
  (_req, res) => res.status(503).json({
    success: false,
    error: 'Local inference runs in the browser. This legacy server endpoint is disabled and does not invoke a remote service.',
  })
);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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
      modelName: 'AdamCodd/vit-base-nsfw-detector',
      modelRevision: '8587de998f441aac03fdd57a85d2e4cb808c7d64',
      modelLabels: ['sfw', 'nsfw'],
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

// Vite Middleware for Development / Static file serving for Production
async function setupVite(production: boolean) {
  if (!production) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(applicationRoot, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(applicationRoot, 'dist', 'index.html'));
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