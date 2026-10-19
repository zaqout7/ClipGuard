import { Film, Play, Upload } from 'lucide-react';
import type { VideoMetadata } from '../types';

interface VideoInputBarProps {
  url: string;
  setUrl: (value: string) => void;
  isAnalyzing: boolean;
  onAnalyze: (customUrl?: string) => void;
  onLoadDemo: () => void;
  onFileUpload: (file: File) => void;
  currentVideo: VideoMetadata | null;
}

export function VideoInputBar({ url, setUrl, isAnalyzing, onAnalyze, onLoadDemo, onFileUpload, currentVideo }: VideoInputBarProps) {
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      onFileUpload(file);
    }
    event.target.value = '';
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-3 shadow-lg shadow-slate-950/20">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex flex-1 items-center gap-2 rounded-xl border border-slate-700 bg-slate-950/80 px-3 py-2.5">
          <Film className="h-4 w-4 text-slate-400" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isAnalyzing && url.trim()) {
                e.preventDefault();
                onAnalyze(url);
              }
            }}
            placeholder="Enter YouTube URL (e.g., https://www.youtube.com/watch?v=...)"
            className="flex-1 bg-transparent text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onAnalyze(url)}
            disabled={isAnalyzing}
            className="inline-flex items-center gap-2 rounded-xl bg-rose-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-rose-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Play className="h-4 w-4" />
            {isAnalyzing ? 'Analyzing…' : 'Analyze'}
          </button>

          <label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-700">
            <Upload className="h-4 w-4" />
            Local video
            <input type="file" accept="video/*" className="hidden" onChange={handleFileChange} />
          </label>

          <button
            type="button"
            onClick={onLoadDemo}
            disabled={isAnalyzing}
            className="rounded-xl border border-amber-700/60 bg-amber-950/40 px-3 py-2.5 text-[11px] font-medium text-amber-200 hover:bg-amber-900/50 disabled:opacity-60"
          >
            Load demo data
          </button>
        </div>
      </div>

      {currentVideo && (
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-[11px] text-slate-300">
          <span className="font-medium text-slate-200">Current source</span>
          <span className="truncate max-w-[50%] text-slate-400">{currentVideo.title}</span>
        </div>
      )}
    </div>
  );
}
