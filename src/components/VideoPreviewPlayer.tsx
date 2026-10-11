import { useEffect, useRef } from 'react';
import { PlayCircle } from 'lucide-react';
import type { DetectionEvent, VideoMetadata } from '../types';

interface VideoPreviewPlayerProps {
  video: VideoMetadata;
  detections: DetectionEvent[];
  activeDetection: DetectionEvent | null;
  onSelectDetection: (detection: DetectionEvent) => void;
  onVideoMetadata: (durationSeconds: number) => void;
  seekTargetSeconds: number | null;
  onSeekComplete: () => void;
}

export function VideoPreviewPlayer({ video, detections, activeDetection, onSelectDetection, onVideoMetadata, seekTargetSeconds, onSeekComplete }: VideoPreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const visibleDetections = detections.filter((detection) => detection.reviewStatus !== 'dismissed');

  useEffect(() => {
    if (seekTargetSeconds === null || !videoRef.current) return;

    const player = videoRef.current;
    const seek = () => {
      const duration = Number.isFinite(player.duration)
        ? player.duration
        : Number(video.durationSeconds || 0);
      let target = Math.min(Math.max(seekTargetSeconds, 0), duration || seekTargetSeconds);

      if (player.seekable.length > 0) {
        let inSeekableRange = false;
        for (let index = 0; index < player.seekable.length; index += 1) {
          const start = player.seekable.start(index);
          const end = player.seekable.end(index);
          if (target >= start && target <= end) {
            inSeekableRange = true;
            break;
          }
          if (target < start) target = start;
          if (target > end) target = end;
        }
        if (!inSeekableRange) target = Math.max(0, target);
      }

      player.currentTime = target;
      onSeekComplete();
    };

    if (player.readyState >= 1) {
      seek();
      return;
    }

    player.addEventListener('loadedmetadata', seek, { once: true });
    return () => player.removeEventListener('loadedmetadata', seek);
  }, [seekTargetSeconds, video.url, video.durationSeconds, onSeekComplete]);

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl shadow-slate-950/25">
      <div className="relative aspect-video bg-slate-950">
        {video.url ? (
          <video
            ref={videoRef}
            src={video.url}
            controls
            className="h-full w-full object-cover"
            preload="metadata"
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration;
              if (Number.isFinite(duration) && duration >= 0) onVideoMetadata(duration);
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-500">No preview available</div>
        )}

        {visibleDetections.length > 0 && (
          <div className="absolute inset-x-3 bottom-3 flex flex-wrap gap-2">
            {visibleDetections.map((detection) => (
              <button
                key={detection.id}
                type="button"
                onClick={() => onSelectDetection(detection)}
                className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${activeDetection?.id === detection.id ? 'border-rose-300 bg-rose-500/20 text-rose-100' : 'border-slate-600 bg-slate-900/80 text-slate-200'}`}
              >
                {detection.categoryLabel}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-slate-800 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[11px] text-slate-400">
            <PlayCircle className="h-4 w-4 text-emerald-400" />
            <span>{visibleDetections.length} candidate moments</span>
          </div>
          <span className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Preview</span>
        </div>
      </div>
    </div>
  );
}
