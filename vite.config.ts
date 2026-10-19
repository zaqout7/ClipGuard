import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    conditions: ['onnxruntime-web-use-extern-wasm', '...'],
  },
  server: {
    host: '127.0.0.1',
    port: 3000,
    headers: {
      // Required for SharedArrayBuffer (used by ort-wasm-simd-threaded even with
      // numThreads=1 during feature detection). Without these headers Chromium and
      // Electron silently block SharedArrayBuffer and the ONNX runtime hangs at init.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
