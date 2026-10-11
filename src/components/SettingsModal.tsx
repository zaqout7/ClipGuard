import { X } from 'lucide-react';
import type { AnalysisOptions } from '../types';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  options: AnalysisOptions;
  onOptionsChange: React.Dispatch<React.SetStateAction<AnalysisOptions>>;
}

export function SettingsModal({ isOpen, onClose, options, onOptionsChange }: SettingsModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Configuration</p>
            <h3 className="mt-1 text-lg font-semibold text-white">Analysis settings</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-[11px] text-slate-300">
            NSFW model-score threshold
            <input
              type="range"
              min={0}
              max={100}
              value={options.sensitivity}
              onChange={(e) => onOptionsChange((prev) => ({ ...prev, sensitivity: Number(e.target.value) }))}
              className="mt-2 w-full"
            />
            <span className="mt-1 block text-slate-400">{options.sensitivity}% softmax score; not calibrated probability</span>
          </label>

          <label className="text-[11px] text-slate-300">
            Frame sampling interval (seconds)
            <input
              type="number"
              min={0.5}
              max={30}
              step={0.5}
              value={options.sampleIntervalSec}
              onChange={(e) => onOptionsChange((prev) => ({ ...prev, sampleIntervalSec: Number(e.target.value) }))}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-slate-100"
            />
          </label>

          <label className="text-[11px] text-slate-300">
            Segment merge tolerance (seconds)
            <input
              type="number"
              min={0}
              max={60}
              step={0.5}
              value={options.mergeToleranceSec}
              onChange={(e) => onOptionsChange((prev) => ({ ...prev, mergeToleranceSec: Number(e.target.value) }))}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-slate-100"
            />
          </label>
          <label className="text-[11px] text-slate-300">
            Segment padding (seconds)
            <input
              type="number"
              min={0}
              max={10}
              step={0.5}
              value={options.bufferSec}
              onChange={(e) => onOptionsChange((prev) => ({ ...prev, bufferSec: Number(e.target.value) }))}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 py-2 text-slate-100"
            />
          </label>
        </div>

        <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-[11px] text-slate-300">
          Sampling classifies one decoded frame at each interval. Short events between sampled frames can be missed; reducing the interval increases processing time.
        </div>

        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="rounded-lg bg-rose-500 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-400">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
