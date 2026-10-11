// electron/main.ts
import { app as app2, BrowserWindow, dialog } from "electron";
import path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// server.ts
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
var app = express();
var PORT = process.env.PORT === void 0 ? 3e3 : Number(process.env.PORT);
var HOST = "127.0.0.1";
var applicationRoot = __dirname;
var serverProductionMode = process.env.NODE_ENV === "production";
function modelAssetsAvailable() {
  const modelRoot = path.resolve(
    applicationRoot,
    serverProductionMode ? "dist" : "public",
    "models"
  );
  const modelFiles = [
    path.join(modelRoot, "adamcodd-nsfw", "model_quantized.onnx"),
    path.join(modelRoot, "adamcodd-nsfw", "config.json"),
    path.join(modelRoot, "adamcodd-nsfw", "preprocessor_config.json"),
    path.join(modelRoot, "onnxruntime", "ort-wasm-simd-threaded.wasm"),
    path.join(modelRoot, "onnxruntime", "ort-wasm-simd-threaded.mjs")
  ];
  return modelFiles.every((file) => fs.existsSync(file));
}
app.use(
  [
    "/api/analyze-frames",
    "/api/verify-sequence",
    "/api/analyze-youtube",
    "/api/video-info"
  ],
  (_req, res) => res.status(503).json({
    success: false,
    error: "Local inference runs in the browser. This legacy server endpoint is disabled and does not invoke a remote service."
  })
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
var MISSING_MODEL_REASON = "The local classifier/runtime assets are missing. Restore the bundled model and ONNX Runtime WebAssembly files; no remote inference fallback is used.";
app.get("/api/system-status", (req, res) => {
  try {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    res.json({
      success: true,
      platform: `${os.type()} ${os.arch()} (${os.release()})`,
      cpuCores: cpus.length,
      cpuModel: cpus[0]?.model || "Standard Multi-Core CPU",
      totalMemGb: parseFloat((totalMem / (1024 * 1024 * 1024)).toFixed(1)),
      freeMemGb: parseFloat((freeMem / (1024 * 1024 * 1024)).toFixed(1)),
      localAnalysisAvailable: modelAssetsAvailable(),
      localAnalysisReason: modelAssetsAvailable() ? "Bundled browser model and ONNX Runtime WebAssembly CPU assets are present. They are loaded on demand in the browser; actual initialization is checked when a local video is analyzed." : MISSING_MODEL_REASON,
      modelName: "AdamCodd/vit-base-nsfw-detector",
      modelRevision: "8587de998f441aac03fdd57a85d2e4cb808c7d64",
      modelLabels: ["sfw", "nsfw"],
      inferenceProvider: "ONNX Runtime WebAssembly CPU (single thread)"
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
app.post("/api/export", (req, res) => {
  try {
    const { format, videoMetadata, detections } = req.body;
    if (!detections || !Array.isArray(detections)) {
      return res.status(400).json({ success: false, error: "Detections array is required" });
    }
    const safeTitle = (videoMetadata?.title || "video_analysis").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    if (format === "csv") {
      const headers = [
        "Index",
        "Start Timecode",
        "End Timecode",
        "Start (Seconds)",
        "End (Seconds)",
        "Category",
        "Confidence (%)",
        "Review Status",
        "Severity",
        "False Positive Risk",
        "Explanation",
        "Visual Evidence",
        "Editor Notes"
      ];
      const rows = detections.map((d, index) => [
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
        `"${(d.explanation || "").replace(/"/g, '""')}"`,
        `"${(d.visualEvidence || "").replace(/"/g, '""')}"`,
        `"${(d.editorNotes || "").replace(/"/g, '""')}"`
      ]);
      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_review_timestamps.csv"`);
      return res.send(csvContent);
    }
    if (format === "json") {
      const jsonContent = JSON.stringify(
        {
          video: videoMetadata,
          exportDate: (/* @__PURE__ */ new Date()).toISOString(),
          totalDetections: detections.length,
          detections
        },
        null,
        2
      );
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_review_timestamps.json"`);
      return res.send(jsonContent);
    }
    if (format === "edl") {
      let edl = `TITLE: ${safeTitle}
FCM: NON-DROP FRAME

`;
      detections.forEach((d, idx) => {
        const num = (idx + 1).toString().padStart(3, "0");
        const toEdlTime = (sec) => {
          const s = Math.max(0, Math.floor(sec));
          const h = Math.floor(s / 3600);
          const m = Math.floor(s % 3600 / 60);
          const remS = s % 60;
          return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${remS.toString().padStart(2, "0")}:00`;
        };
        const inTc = toEdlTime(d.startSeconds);
        const outTc = toEdlTime(d.endSeconds);
        edl += `${num}  AX       V     C        ${inTc} ${outTc} ${inTc} ${outTc}
`;
        edl += `* FROM CLIP NAME: ${videoMetadata?.title || "Clip"}
`;
        edl += `* COMMENT: [${d.categoryLabel || d.category}] Confidence ${d.confidence}% - ${d.explanation}

`;
      });
      res.setHeader("Content-Type", "text/plain");
      res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_markers.edl"`);
      return res.send(edl);
    }
    let txt = `==================================================
`;
    txt += `VIDEO MODERATION & WARDROBE REVIEW REPORT
`;
    txt += `==================================================

`;
    txt += `Video Title:   ${videoMetadata?.title || "Unknown"}
`;
    txt += `Video URL:     ${videoMetadata?.url || "N/A"}
`;
    txt += `Channel/Owner: ${videoMetadata?.author || "N/A"}
`;
    txt += `Duration:      ${videoMetadata?.durationFormatted || "N/A"}
`;
    txt += `Generated At:  ${(/* @__PURE__ */ new Date()).toLocaleString()}
`;
    txt += `Candidate Moments for Human Review: ${detections.length}
`;
    txt += `Notice: AI detection is probabilistic. Human review is required before editorial action.

`;
    txt += `==================================================
`;
    txt += `DETECTED TIMESTAMPS FOR REVIEW
`;
    txt += `==================================================

`;
    detections.forEach((d, index) => {
      txt += `${index + 1}. ${d.startTimestamp} - ${d.endTimestamp}
`;
      txt += `   Category:    ${d.categoryLabel || d.category}
`;
      txt += `   Confidence:  ${d.confidence}%
`;
      txt += `   Status:      ${d.reviewStatus.toUpperCase().replace("_", " ")}
`;
      txt += `   Severity:    ${d.severity?.toUpperCase() || "MEDIUM"}
`;
      txt += `   False Pos.:  ${d.falsePositiveRisk?.toUpperCase() || "LOW"}
`;
      txt += `   Reason:      ${d.explanation}
`;
      if (d.visualEvidence) {
        txt += `   Visual Cues: ${d.visualEvidence}
`;
      }
      if (d.editorNotes) {
        txt += `   Editor Note: ${d.editorNotes}
`;
      }
      txt += `
`;
    });
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Content-Disposition", `attachment; filename="${safeTitle}_review_timestamps.txt"`);
    res.send(txt);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
app.get("/api/download-archive", (req, res) => {
  const archivePath = path.resolve(applicationRoot, "clipguard-project.tar.gz");
  if (fs.existsSync(archivePath)) {
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", 'attachment; filename="clipguard-project.tar.gz"');
    fs.createReadStream(archivePath).pipe(res);
  } else {
    res.status(404).send("Project archive not found. Run tar command to generate.");
  }
});
async function setupVite(production) {
  if (!production) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(applicationRoot, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(applicationRoot, "dist", "index.html"));
    });
  }
}
async function startServer({
  port = PORT,
  production = process.env.NODE_ENV === "production",
  applicationRoot: root = __dirname
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError("The local service port must be an integer between 0 and 65535.");
  }
  applicationRoot = root;
  serverProductionMode = production;
  await setupVite(production);
  return new Promise((resolve, reject) => {
    const server = app.listen(port, HOST);
    server.once("error", reject);
    server.once("listening", () => {
      server.removeListener("error", reject);
      const address = server.address();
      const actualPort = address && typeof address !== "string" ? address.port : port;
      console.log(`[ClipGuard] Video Review Server running on http://${HOST}:${actualPort}`);
      resolve(server);
    });
  });
}

// electron/main.ts
var __dirname2 = path2.dirname(fileURLToPath2(import.meta.url));
app2.setName("ClipGuard");
app2.setPath("userData", path2.join(app2.getPath("appData"), "ClipGuard"));
var serviceServer = null;
var serviceUrl = null;
var shutdownStarted = false;
var allowQuit = false;
async function createWindow() {
  if (!serviceUrl) throw new Error("The local ClipGuard service has not started.");
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path2.join(__dirname2, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false
    }
  });
  const expectedOrigin = new URL(serviceUrl).origin;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (new URL(targetUrl).origin !== expectedOrigin) event.preventDefault();
  });
  await window.loadURL(serviceUrl);
}
async function startDesktop() {
  const applicationRoot2 = app2.getAppPath();
  serviceServer = await startServer({
    port: 0,
    production: app2.isPackaged,
    applicationRoot: applicationRoot2
  });
  const address = serviceServer.address();
  if (!address || typeof address === "string") {
    throw new Error("The local ClipGuard service did not bind to a TCP loopback port.");
  }
  serviceUrl = `http://127.0.0.1:${address.port}/`;
  await createWindow();
}
function closeServiceBounded() {
  if (!serviceServer || allowQuit || shutdownStarted) return;
  shutdownStarted = true;
  const server = serviceServer;
  serviceServer = null;
  let finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(closeConnectionsTimer);
    clearTimeout(forceQuitTimer);
    if (error) console.error("[ClipGuard] Error while closing the local service:", error);
    allowQuit = true;
    app2.quit();
  };
  const closeConnectionsTimer = setTimeout(() => {
    console.warn("[ClipGuard] Closing remaining local service connections.");
    server.closeAllConnections();
  }, 3e3);
  const forceQuitTimer = setTimeout(() => {
    console.error("[ClipGuard] Local service shutdown exceeded the five-second limit.");
    server.closeAllConnections();
    finish();
  }, 5e3);
  server.close((error) => finish(error));
  server.closeIdleConnections();
}
void app2.whenReady().then(startDesktop).catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown startup failure.";
  console.error("[ClipGuard] Desktop startup failed:", error);
  dialog.showErrorBox("ClipGuard could not start", message);
  app2.quit();
});
app2.on("before-quit", (event) => {
  if (!serviceServer || allowQuit) return;
  event.preventDefault();
  closeServiceBounded();
});
app2.on("window-all-closed", () => {
  app2.quit();
});
app2.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serviceServer) {
    void createWindow().catch((error) => {
      console.error("[ClipGuard] Could not reopen the application window:", error);
      app2.quit();
    });
  }
});
