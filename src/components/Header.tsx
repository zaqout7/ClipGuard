import { Cpu, ShieldCheck, Sparkles } from 'lucide-react';
import type { SystemSpecs } from '../types';

interface HeaderProps {
  systemSpecs: SystemSpecs | null;
  onOpenSettings: () => void;
  onOpenMethodology: () => void;
}

export function Header({ systemSpecs, onOpenSettings, onOpenMethodology }: HeaderProps) {
  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm">
      <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/15 ring-1 ring-rose-400/30">
            <ShieldCheck className="h-5 w-5 text-rose-300" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-white">ClipGuard</h1>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-300">
                review
              </span>
            </div>
            <p className="truncate text-[11px] text-slate-400">Sensitive-content review workspace</p>
          </div>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <div
            role="status"
            className={`rounded-lg border px-3 py-2 text-[11px] font-medium ${
              systemSpecs?.localAnalysisAvailable
                ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
                : 'border-rose-800 bg-rose-950/50 text-rose-200'
            }`}
            title={systemSpecs?.localAnalysisReason ?? 'Checking for a configured local analysis engine'}
          >
            {systemSpecs?.localAnalysisAvailable ? 'Local model bundle present' : 'Analysis model unavailable'}
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/80 px-3 py-2 text-[11px] text-slate-300">
            <div className="flex items-center gap-2 font-medium text-slate-100">
              <Cpu className="h-3.5 w-3.5 text-sky-400" />
              {systemSpecs?.cpuModel ?? 'Local workstation'}
            </div>
            <div className="mt-1 text-slate-400">{systemSpecs?.cpuCores ?? 0} cores • {systemSpecs?.totalMemGb ?? 0} GB RAM</div>
          </div>
          <button
            type="button"
            onClick={onOpenMethodology}
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[11px] font-medium text-slate-200 hover:border-slate-500 hover:bg-slate-800"
          >
            Methodology
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-2 rounded-lg bg-rose-500 px-3 py-2 text-[11px] font-semibold text-white shadow-lg shadow-rose-500/20 hover:bg-rose-400"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Settings
          </button>
        </div>
      </div>
    </header>
  );
}
