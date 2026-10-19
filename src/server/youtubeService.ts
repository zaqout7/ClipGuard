import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VideoMetadata } from '../types';
import { formatSecondsToTimestamp } from '../utils/formatters';

export interface YouTubeUrlInfo {
  valid: boolean;
  videoId?: string;
  normalizedUrl?: string;
}

export interface DownloadJobState {
  jobId: string;
  url: string;
  status: 'downloading' | 'ready' | 'error' | 'cancelled';
  progressPercent: number;
  metadata?: VideoMetadata;
  filePath?: string;
  error?: string;
  createdAt: number;
}

export const PINNED_YTDLP_RELEASE = '2026.08.19';
export const PINNED_CHECKSUMS = {
  'yt-dlp.exe': '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a',
  'yt-dlp_linux': '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a',
  'yt-dlp': '1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6',
};

// Format selector: prefer progressive MP4 (format 18), fall back to browser-playable
// H.264 video-only DASH MP4 streams up to 480p. No FFmpeg merge needed for visual-only analysis.
export const YTDLP_FORMAT_SELECTOR =
  '18/best[ext=mp4][vcodec^=avc1][height<=480]/best[ext=mp4][height<=480]/bestvideo[ext=mp4][vcodec^=avc1][height<=480]/bestvideo[ext=mp4][height<=480]';

export function validateDownloadedMedia(filePath: string): { valid: boolean; error?: string } {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'Downloaded file does not exist.' };
    }
    const stat = fs.statSync(filePath);
    if (stat.size < 100) {
      return { valid: false, error: 'Downloaded file is empty or corrupted.' };
    }

    // 1. Container validation: verify MP4 ftyp box at byte offset 4..7
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    fs.closeSync(fd);

    const ftyp = header.subarray(4, 8).toString('ascii');
    if (ftyp !== 'ftyp') {
      return { valid: false, error: 'Downloaded media is not an MP4 container (missing ftyp box).' };
    }

    // 2. Codec validation if ffprobe is present on host system
    try {
      const probeCmd = `ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,height -of default=noprint_wrappers=1:nokey=0 "${filePath}"`;
      const probeOut = execSync(probeCmd, { encoding: 'utf-8', timeout: 4000 });
      const codecMatch = probeOut.match(/codec_name=([^\r\n]+)/);
      const heightMatch = probeOut.match(/height=([0-9]+)/);

      if (codecMatch && codecMatch[1]) {
        const codec = codecMatch[1].trim().toLowerCase();
        if (codec !== 'h264' && codec !== 'avc1') {
          return { valid: false, error: `Downloaded stream codec is "${codec}", not browser-supported H.264.` };
        }
      }
      if (heightMatch && heightMatch[1]) {
        const height = parseInt(heightMatch[1], 10);
        if (height > 480) {
          return { valid: false, error: `Downloaded video resolution (${height}p) exceeds the 480p maximum limit.` };
        }
      }
    } catch {
      // ffprobe is optional; ftyp container check serves as fundamental boundary if ffprobe is absent
    }

    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err.message || 'Media validation failed.' };
  }
}

export function buildDownloadArgs(runtimePath: string, targetFilePath: string, rawUrl: string): string[] {
  return [
    '--no-config',
    '--no-plugin-dirs',
    '--socket-timeout', '15',
    '--retries', '3',
    '--no-playlist',
    '--js-runtimes', `node:${runtimePath}`,
    '--max-filesize', MAX_FILE_SIZE_ARG,
    '-f', YTDLP_FORMAT_SELECTOR,
    '--newline',
    '--progress-template', '%(progress._percent_str)s',
    '-o', targetFilePath,
    rawUrl,
  ];
}

const YOUTUBE_URL_REGEX =
  /^(?:https?:\/\/)?(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})(?:[?&].*)?$/;

export function validateYouTubeUrl(input: string): YouTubeUrlInfo {
  if (!input || typeof input !== 'string') {
    return { valid: false };
  }
  const trimmed = input.trim();
  const match = trimmed.match(YOUTUBE_URL_REGEX);
  if (!match || !match[1]) {
    return { valid: false };
  }
  const videoId = match[1];
  return {
    valid: true,
    videoId,
    normalizedUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

const activeJobs = new Map<string, DownloadJobState>();
const activeProcesses = new Map<string, ReturnType<typeof spawn>>();
const protectedFilePaths = new Set<string>();

const MAX_VIDEO_DURATION_SECONDS = 7200; // 2 hours
const MAX_FILE_SIZE_ARG = '500M'; // 500 MB max download size

export function cleanOldDownloadCache(maxAgeMs = 30 * 60 * 1000): void {
  try {
    const dir = getDownloadDirectory();
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    const now = Date.now();
    for (const file of files) {
      const fullPath = path.join(dir, file);
      // Exclude files that belong to active downloads, previews, or running jobs
      if (protectedFilePaths.has(fullPath)) {
        continue;
      }
      try {
        const stat = fs.statSync(fullPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fullPath);
        }
      } catch {}
    }
  } catch {}
}

export function cleanupYouTubeFile(jobId: string): boolean {
  const job = activeJobs.get(jobId);
  let removed = false;
  if (job?.filePath) {
    protectedFilePaths.delete(job.filePath);
    if (fs.existsSync(job.filePath)) {
      try {
        fs.unlinkSync(job.filePath);
        removed = true;
      } catch {}
    }
  }
  activeJobs.delete(jobId);
  return removed;
}

export function getYtDlpPath(): string {
  if (process.env.YT_DLP_PATH && fs.existsSync(process.env.YT_DLP_PATH)) {
    return process.env.YT_DLP_PATH;
  }

  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'yt-dlp.exe' : 'yt-dlp';

  // 1. Packaged Electron resources (extraFiles: installRoot/bin/yt-dlp.exe)
  const resourcesPath = (process as any).resourcesPath as string | undefined;
  if (resourcesPath) {
    const candidateExtraFiles = path.join(resourcesPath, '..', 'bin', exeName);
    if (fs.existsSync(candidateExtraFiles)) return candidateExtraFiles;

    const candidateExtraResources = path.join(resourcesPath, 'bin', exeName);
    if (fs.existsSync(candidateExtraResources)) return candidateExtraResources;
  }

  // 2. Project local bin folder
  const localBin = path.resolve(process.cwd(), 'bin', exeName);
  if (fs.existsSync(localBin)) {
    return localBin;
  }

  // 3. Standard unix system locations
  if (!isWin) {
    const unixPaths = ['/usr/local/bin/yt-dlp', '/usr/bin/yt-dlp', '/opt/homebrew/bin/yt-dlp'];
    for (const p of unixPaths) {
      if (fs.existsSync(p)) return p;
    }
  }

  // 4. Search in PATH
  try {
    const checkCmd = isWin ? `where ${exeName}` : `which ${exeName}`;
    const out = execSync(checkCmd, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0].trim();
    if (out && fs.existsSync(out)) {
      return out;
    }
  } catch {}

  return exeName;
}

export interface JsRuntimeConfig {
  runtimePath: string;
  env: NodeJS.ProcessEnv;
}

export function resolveJsRuntimeConfig(): JsRuntimeConfig {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // 1. Check if system Node executable exists in PATH
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? 'where node.exe' : 'which node';
    const out = execSync(checkCmd, { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0].trim();
    if (out && fs.existsSync(out)) {
      return { runtimePath: out, env };
    }
  } catch {}

  // 2. If running under Electron, use process.execPath with ELECTRON_RUN_AS_NODE=1
  if ((process.versions as any).electron) {
    env.ELECTRON_RUN_AS_NODE = '1';
    return { runtimePath: process.execPath, env };
  }

  // 3. Fallback to process.execPath (Node in server/dev mode)
  return { runtimePath: process.execPath || 'node', env };
}

export function getDownloadDirectory(): string {
  const dir = path.join(os.tmpdir(), 'clipguard_yt_cache');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export async function fetchYouTubeMetadata(rawUrl: string): Promise<VideoMetadata> {
  const urlCheck = validateYouTubeUrl(rawUrl);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    throw new Error('Please enter a valid YouTube video URL (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...).');
  }

  const ytDlp = getYtDlpPath();
  const { runtimePath, env } = resolveJsRuntimeConfig();

  const args = [
    '--no-config',
    '--no-plugin-dirs',
    '--socket-timeout', '15',
    '--retries', '3',
    '--no-playlist',
    '--js-runtimes', `node:${runtimePath}`,
    '--dump-single-json',
    '--no-warnings',
    urlCheck.normalizedUrl,
  ];

  return new Promise<VideoMetadata>((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    const proc = spawn(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'], env });

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start yt-dlp: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const errorMsg = stderr.trim() || `yt-dlp exited with code ${code}`;
        reject(new Error(`Unable to fetch YouTube video details: ${errorMsg}`));
        return;
      }

      try {
        const info = JSON.parse(stdout);
        const durationSec = Math.max(0, Math.round(Number(info.duration) || 0));

        if (durationSec > MAX_VIDEO_DURATION_SECONDS) {
          reject(new Error(`Video duration (${formatSecondsToTimestamp(durationSec)}) exceeds the 2-hour maximum limit for local CPU processing.`));
          return;
        }

        const metadata: VideoMetadata = {
          id: `yt-${info.id || urlCheck.videoId || crypto.randomUUID()}`,
          url: urlCheck.normalizedUrl!,
          title: info.title || 'YouTube Video',
          author: info.uploader || info.channel || 'YouTube Creator',
          durationSeconds: durationSec,
          durationFormatted: formatSecondsToTimestamp(durationSec),
          thumbnailUrl: info.thumbnail || '',
          sourceType: 'youtube',
        };
        resolve(metadata);
      } catch (parseErr: any) {
        reject(new Error(`Failed to parse YouTube video metadata: ${parseErr.message}`));
      }
    });
  });
}

export async function startYouTubeDownload(
  rawUrl: string,
  jobId: string,
  metadata?: VideoMetadata
): Promise<DownloadJobState> {
  const urlCheck = validateYouTubeUrl(rawUrl);
  if (!urlCheck.valid || !urlCheck.normalizedUrl) {
    throw new Error('Invalid YouTube URL for download.');
  }

  if (metadata && metadata.durationSeconds > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error(`Video duration (${metadata.durationFormatted}) exceeds the 2-hour maximum limit for local CPU processing.`);
  }

  // Purge expired cached files (excludes actively protected files)
  cleanOldDownloadCache();

  const ytDlp = getYtDlpPath();
  const { runtimePath, env } = resolveJsRuntimeConfig();
  const downloadDir = getDownloadDirectory();
  const targetFilePath = path.join(downloadDir, `${jobId}.mp4`);

  const jobState: DownloadJobState = {
    jobId,
    url: urlCheck.normalizedUrl,
    status: 'downloading',
    progressPercent: 0,
    metadata,
    filePath: targetFilePath,
    createdAt: Date.now(),
  };

  activeJobs.set(jobId, jobState);
  protectedFilePaths.add(targetFilePath);

  const args = buildDownloadArgs(runtimePath, targetFilePath, urlCheck.normalizedUrl);

  const proc = spawn(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  activeProcesses.set(jobId, proc);

  proc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n');
    for (const line of lines) {
      const match = line.match(/([0-9.]+)%/);
      if (match && match[1]) {
        const pct = Math.min(100, Math.max(0, parseFloat(match[1])));
        jobState.progressPercent = Math.round(pct);
      }
    }
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  proc.on('error', (err) => {
    activeProcesses.delete(jobId);
    protectedFilePaths.delete(targetFilePath);
    jobState.status = 'error';
    jobState.error = err.message;
  });

  proc.on('close', (code) => {
    activeProcesses.delete(jobId);
    // CANCELLATION CHECK FIRST: if the job was cancelled while the process was
    // still running and the process finished (code 0) before the kill signal
    // propagated, we must NOT mark the job as ready. The cancelled-cleanup handler
    // attached by cancelYouTubeDownload() will remove the file via its own once('close').
    if (jobState.status === 'cancelled') {
      protectedFilePaths.delete(targetFilePath);
      if (fs.existsSync(targetFilePath)) {
        try { fs.unlinkSync(targetFilePath); } catch {}
      }
      return;
    }
    if (code === 0 && fs.existsSync(targetFilePath)) {
      const validation = validateDownloadedMedia(targetFilePath);
      if (!validation.valid) {
        protectedFilePaths.delete(targetFilePath);
        jobState.status = 'error';
        jobState.error = validation.error || 'Downloaded media failed container/codec validation.';
        try { fs.unlinkSync(targetFilePath); } catch {}
      } else {
        jobState.status = 'ready';
        jobState.progressPercent = 100;
      }
    } else {
      protectedFilePaths.delete(targetFilePath);
      jobState.status = 'error';
      const rawError = stderr.trim();
      if (rawError.includes('Requested format is not available')) {
        jobState.error = 'No supported MP4 H.264 format (maximum 480p) is available for this video.';
      } else {
        jobState.error = rawError || `Download process exited with code ${code}`;
      }
      // Clean partial file after process termination
      if (fs.existsSync(targetFilePath)) {
        try { fs.unlinkSync(targetFilePath); } catch {}
      }
    }
  });

  return jobState;
}

export function getDownloadJob(jobId: string): DownloadJobState | null {
  return activeJobs.get(jobId) || null;
}

export function terminateProcessTree(proc: ReturnType<typeof spawn>): void {
  if (!proc || !proc.pid) return;

  if (process.platform === 'win32') {
    // Windows process tree termination
    try {
      execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } catch {
      try { proc.kill('SIGKILL'); } catch {}
    }
  } else {
    // POSIX signal termination
    try {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 1000);
    } catch {}
  }
}

export function cancelYouTubeDownload(jobId: string): boolean {
  const proc = activeProcesses.get(jobId);
  const job = activeJobs.get(jobId);

  if (job) {
    job.status = 'cancelled';
    if (job.filePath) {
      protectedFilePaths.delete(job.filePath);
    }
  }

  if (proc) {
    // Attach exit cleanup handler to delete partial file ONLY after process terminates
    const filePath = job?.filePath;
    proc.once('close', () => {
      activeProcesses.delete(jobId);
      if (filePath && fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    });

    terminateProcessTree(proc);
    return true;
  }

  // If no process is running, delete file immediately
  if (job?.filePath && fs.existsSync(job.filePath)) {
    try { fs.unlinkSync(job.filePath); } catch {}
  }

  return Boolean(job);
}
