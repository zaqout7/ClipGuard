import type { AnalysisProgress } from '../types';

interface AnalysisProgressBarProps {
  progress: AnalysisProgress;
  isAnalyzing: boolean;
  onCancel: () => void;
}

export function AnalysisProgressBar({ progress, isAnalyzing, onCancel }: AnalysisProgressBarProps) {
  const pct = progress.progressPercent === null
    ? null
    : Math.min(100, Math.max(0, progress.progressPercent));

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg shadow-slate-950/20">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Status</p>
          <h3 className="mt-1 text-sm font-semibold text-white">{progress.statusText || 'Ready'}</h3>
        </div>
        <div className="flex items-center gap-2">
          {isAnalyzing && (
            <button type="button" onClick={onCancel} className="text-[10px] font-medium text-rose-300 hover:text-rose-200">
              Cancel
            </button>
          )}
          <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-1 text-[10px] font-medium text-slate-300">
            {pct === null
              ? isAnalyzing
                ? 'Working'
                : progress.phase === 'cancelled'
                  ? 'Cancelled'
                  : progress.phase === 'error'
                    ? 'Failed'
                    : '—'
              : `${pct}%`}
          </span>
        </div>
      </div>

      <div className="h-2.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-gradient-to-r from-rose-500 via-amber-400 to-emerald-400 transition-all duration-300"
          style={pct === null
            ? { width: isAnalyzing ? '35%' : '0%', animation: isAnalyzing ? 'clipguard-indeterminate 1.4s ease-in-out infinite alternate' : undefined }
            : { width: `${pct}%` }}
        />
      </div>
      <style>{'@keyframes clipguard-indeterminate { from { transform: translateX(-30%); } to { transform: translateX(220%); } }'}</style>

      {progress.details && (
        <p className="mt-2 text-[11px] text-slate-400">{progress.details}</p>
      )}
    </div>
  );
}
