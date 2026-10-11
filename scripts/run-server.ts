import { startServer } from '../server.js';

void startServer().catch((error: unknown) => {
  console.error('[ClipGuard] Failed to start server:', error);
  process.exitCode = 1;
});
