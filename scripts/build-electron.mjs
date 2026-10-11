import { build } from 'esbuild';
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
