import { CheckCircle2, Clock3, SkipForward } from 'lucide-react';
import type { AnalysisProgress, DetectionEvent, ReviewStatus } from '../types';

interface DetectionListProps {
  detections: DetectionEvent[];
  progress: AnalysisProgress;
  demoOnly: boolean;
  activeDetection: DetectionEvent | null;
  onSelectDetection: (detection: DetectionEvent) => void;
  onUpdateStatus: (id: string, status: ReviewStatus) => void;
  onUpdateNotes: (id: string, notes: string) => void;
  onJumpToTimestamp: (seconds: number) => void;
  onOpenExport: () => void;
  videoTitle: string;
}

export function DetectionList({ detections, progress, demoOnly, activeDetection, onSelectDetection, onUpdateStatus, onUpdateNotes, onJumpToTimestamp, onOpenExport, videoTitle }: DetectionListProps) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-3 shadow-lg shadow-slate-950/20">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Review queue</p>
          <h3 className="mt-1 text-sm font-semibold text-white">{videoTitle}</h3>
        </div>
        <button type="button" onClick={onOpenExport} className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[10px] font-medium text-slate-200 hover:bg-slate-700">
          Export
        </button>
      </div>

      <div className="space-y-2">
        {detections.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/70 p-3 text-[11px] text-slate-400">
            {demoOnly
              ? 'No illustrative demo items match the selected filters; demo data is not an analysis.'
              : progress.phase === 'complete'
                ? 'Analysis completed with no sampled frames above the selected threshold. This is not evidence that the video is safe.'
                : progress.phase === 'cancelled'
                  ? 'Analysis was cancelled. No completed results are available.'
                  : progress.phase === 'error'
                    ? 'Analysis failed. No completed results are available.'
                    : 'This video has not been analyzed; an empty list is not evidence that it is safe.'}
          </div>
        ) : (
          detections.filter((detection) => detection.reviewStatus !== 'dismissed').map((detection) => (
            <div
              key={detection.id}
              className={`w-full rounded-xl border p-3 text-left transition ${activeDetection?.id === detection.id ? 'border-rose-500/50 bg-rose-500/10' : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'}`}
            >
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => onSelectDetection(detection)} className="text-left text-xs font-semibold text-white">
                  {detection.categoryLabel}
                </button>
                {demoOnly && detection.confidence !== undefined ? (
                  <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-200">
                    Sample {detection.confidence}%
                  </span>
                ) : detection.modelScore !== undefined ? (
                  <span
                    className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-200"
                    title={detection.scoreSemantics}
                  >
                    Model score {(detection.modelScore * 100).toFixed(1)}%
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-400">
                <Clock3 className="h-3.5 w-3.5" />
                {detection.startTimestamp} → {detection.endTimestamp}
              </div>
              <p className="mt-2 line-clamp-3 text-[11px] text-slate-300">{detection.explanation}</p>
              {!demoOnly && detection.scoreSemantics && (
                <p className="mt-1 text-[10px] text-amber-200">{detection.scoreSemantics}</p>
              )}
              {demoOnly && <p className="mt-1 text-[10px] text-amber-300">Synthetic example only — not a model score.</p>}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => onUpdateStatus(detection.id, 'accepted')} className="inline-flex items-center gap-1 rounded-md border border-emerald-700 bg-emerald-600/10 px-2 py-1 text-[10px] font-medium text-emerald-200">
                  <CheckCircle2 className="h-3 w-3" /> Accept
                </button>
                <button type="button" onClick={() => onUpdateStatus(detection.id, 'dismissed')} className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-200">
                  Dismiss
                </button>
                <button type="button" onClick={() => onJumpToTimestamp(detection.startSeconds)} className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-200">
                  <SkipForward className="h-3 w-3" /> Jump
                </button>
              </div>
              <label className="mt-3 block text-[10px] text-slate-400">
                Review notes
                <textarea
                  value={detection.editorNotes}
                  onChange={(event) => onUpdateNotes(detection.id, event.target.value)}
                  rows={2}
                  className="mt-1 w-full resize-y rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
                />
              </label>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
