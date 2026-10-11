import { Download, X } from 'lucide-react';
import type { AnalysisOptions, AnalysisProgress, DetectionEvent, VideoMetadata } from '../types';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  video: VideoMetadata;
  detections: DetectionEvent[];
  progress: AnalysisProgress;
  options: AnalysisOptions;
}

export function ExportModal({ isOpen, onClose, video, detections, progress, options }: ExportModalProps) {
  if (!isOpen) return null;

  const demoOnly = video.sourceType === 'preset';
  const completed = progress.phase === 'complete';
  const reportNotice = demoOnly
    ? 'DEMO ONLY: Illustrative sample data. No footage was analyzed; scores are not model outputs.'
    : completed
      ? 'ANALYSIS COMPLETE: Potential matches only; human review is required. No matches above threshold is not proof that the video is safe.'
      : `${progress.statusText || 'ANALYSIS NOT COMPLETED'}: No completed results are available.`;
  const exportText = [
    `ClipGuard review report — ${video.title}`,
    reportNotice,
    `Status: ${progress.statusText || 'Not analyzed'}`,
    ...(progress.details ? [`Analysis details: ${progress.details}`] : []),
    ...(demoOnly ? [] : [
      'Model: AdamCodd/vit-base-nsfw-detector (Apache-2.0; pinned revision 8587de998f441aac03fdd57a85d2e4cb808c7d64)',
      'Supported labels: sfw, nsfw (broad image classification only; not nudity localization)',
      'Runtime: ONNX Runtime WebAssembly CPU, single thread',
      `Threshold: ${options.sensitivity}% softmax score (not a calibrated probability)`,
      `Sampling interval: ${options.sampleIntervalSec}s`,
      `Merge tolerance: ${options.mergeToleranceSec}s; segment padding: ${options.bufferSec}s`,
      `Frames processed: ${progress.processedFrames ?? 'unknown'}${progress.totalFrames === undefined ? '' : ` of ${progress.totalFrames}`}`,
      'Preprocessing limitation: browser canvas resizes frames to 384x384; interpolation may vary by browser.',
      'Timestamp limitation: decoded-frame mediaTime where available, otherwise seek-time fallback; not guaranteed frame-accurate, especially for variable-frame-rate media.',
      `Result completeness: ${completed ? 'complete for the sampled frames' : 'incomplete or not run'}`,
    ]),
    detections.length === 0 && completed
      ? 'Result: No sampled frame exceeded the selected threshold. This is not proof that the video is safe.'
      : '',
    ...detections.map((detection) =>
      `${detection.startTimestamp} - ${detection.endTimestamp} | ${detection.categoryLabel}${demoOnly ? ` (illustrative sample score: ${detection.confidence}%)` : detection.modelScore === undefined ? '' : ` (model softmax score: ${(detection.modelScore * 100).toFixed(1)}%; not a calibrated probability)`} | ${detection.reviewStatus}${detection.editorNotes ? ` | Note: ${detection.editorNotes}` : ''}`
    ),
  ].join('\n');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Export</p>
            <h3 className="mt-1 text-lg font-semibold text-white">{video.title}</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-3 rounded-lg border border-amber-800/70 bg-amber-950/30 p-2 text-[11px] text-amber-200">
          {reportNotice}
        </p>
        <pre className="max-h-64 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-200 whitespace-pre-wrap">
{exportText}
        </pre>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([exportText], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement('a');
              anchor.href = url;
              anchor.download = `${video.title.toLowerCase().replace(/\s+/g, '-')}-detections.txt`;
              anchor.click();
              URL.revokeObjectURL(url);
              onClose();
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-400"
          >
            <Download className="h-4 w-4" />
            Download report
          </button>
        </div>
      </div>
    </div>
  );
}
