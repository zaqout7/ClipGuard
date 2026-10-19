import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, '..');
const outputDirectory = path.join(projectRoot, 'electron-dist');

await build({
  absWorkingDir: projectRoot,
  entryPoints: ['electron/main.ts'],
  outfile: path.join(outputDirectory, 'main.js'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'node22',
});

await build({
  absWorkingDir: projectRoot,
  entryPoints: ['electron/preload.ts'],
  outfile: path.join(outputDirectory, 'preload.cjs'),
  bundle: true,
  packages: 'external',
  platform: 'node',
  format: 'cjs',
  target: 'node22',
});

// Verify and ensure NudeNet and other model assets exist in dist/models if dist exists
const publicModelsDir = path.join(projectRoot, 'public', 'models');
const distModelsDir = path.join(projectRoot, 'dist', 'models');
const nudenetPublicFile = path.join(publicModelsDir, 'nudenet', '320n.onnx');
if (!fs.existsSync(nudenetPublicFile)) {
  console.warn('[build-electron] Warning: NudeNet model file missing at', nudenetPublicFile);
} else if (fs.existsSync(path.join(projectRoot, 'dist'))) {
  fs.mkdirSync(path.join(distModelsDir, 'nudenet'), { recursive: true });
  const nudenetDistFile = path.join(distModelsDir, 'nudenet', '320n.onnx');
  fs.copyFileSync(nudenetPublicFile, nudenetDistFile);
  console.log('[build-electron] Verified NudeNet model asset at:', nudenetDistFile);
}
