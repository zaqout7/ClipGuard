import { app, BrowserWindow, dialog } from 'electron';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.setName('ClipGuard');
app.setPath('userData', path.join(app.getPath('appData'), 'ClipGuard'));
let serviceServer: Server | null = null;
let serviceUrl: string | null = null;
let shutdownStarted = false;
let allowQuit = false;

async function createWindow(): Promise<void> {
  if (!serviceUrl) throw new Error('The local ClipGuard service has not started.');
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    },
  });
  const expectedOrigin = new URL(serviceUrl).origin;

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event: any, targetUrl: string) => {
    if (new URL(targetUrl).origin !== expectedOrigin) event.preventDefault();
  });
  await window.loadURL(serviceUrl);
}

async function startDesktop(): Promise<void> {
  const applicationRoot = app.getAppPath();
  serviceServer = await startServer({
    port: 0,
    production: app.isPackaged,
    applicationRoot,
  });
  const address = serviceServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('The local ClipGuard service did not bind to a TCP loopback port.');
  }
  serviceUrl = `http://127.0.0.1:${address.port}/`;
  await createWindow();
}

function closeServiceBounded(): void {
  if (!serviceServer || allowQuit || shutdownStarted) return;
  shutdownStarted = true;
  const server = serviceServer;
  serviceServer = null;

  let finished = false;
  const finish = (error?: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(closeConnectionsTimer);
    clearTimeout(forceQuitTimer);
    if (error) console.error('[ClipGuard] Error while closing the local service:', error);
    allowQuit = true;
    app.quit();
  };

  const closeConnectionsTimer = setTimeout(() => {
    console.warn('[ClipGuard] Closing remaining local service connections.');
    server.closeAllConnections();
  }, 3000);
  const forceQuitTimer = setTimeout(() => {
    console.error('[ClipGuard] Local service shutdown exceeded the five-second limit.');
    server.closeAllConnections();
    finish();
  }, 5000);
  server.close((error) => finish(error));
  server.closeIdleConnections();
}

void app.whenReady().then(startDesktop).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown startup failure.';
  console.error('[ClipGuard] Desktop startup failed:', error);
  dialog.showErrorBox('ClipGuard could not start', message);
  app.quit();
});

app.on('before-quit', (event: any) => {
  if (!serviceServer || allowQuit) return;
  event.preventDefault();
  closeServiceBounded();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serviceServer) {
    void createWindow().catch((error: unknown) => {
      console.error('[ClipGuard] Could not reopen the application window:', error);
      app.quit();
    });
  }
});
