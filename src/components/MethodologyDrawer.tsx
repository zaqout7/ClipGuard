import { X } from 'lucide-react';

interface MethodologyDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function MethodologyDrawer({ isOpen, onClose }: MethodologyDrawerProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm">
      <aside className="h-full w-full max-w-lg border-l border-slate-800 bg-slate-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">Workflow</p>
            <h3 className="mt-1 text-lg font-semibold text-white">Review methodology</h3>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-700 p-2 text-slate-300 hover:bg-slate-800">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 text-[12px] leading-6 text-slate-300">
          <div>
            <h4 className="font-semibold text-slate-200">Local ONNX Analysis Engine</h4>
            <p className="mt-1">
              Local video files and YouTube video URLs (acquired locally via bundled yt-dlp) can be sampled and classified on-device using the bundled NudeNet YOLOv8 (320n.onnx) detector or AdamCodd/vit-base-nsfw-detector fallback. Frames are extracted on-device via HTML5 Video and WebCodecs without transmitting data to external servers.
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <h4 className="font-semibold text-emerald-400">Google Gemini 4 FPS Video Analysis</h4>
            <p className="mt-1 text-slate-300">
              When the Gemini Video engine is selected, video streams are analyzed via the official Google Gemini v1beta API:
            </p>
            <ul className="mt-2 space-y-1.5 list-disc pl-4 text-slate-400">
              <li><strong className="text-slate-200">Exact 4 FPS Requested:</strong> The API parameter <code className="text-emerald-400 font-mono">videoMetadata.fps</code> is explicitly set to 4 (one frame every 0.25 seconds). Frame extraction is configured at the model ingestion layer, not through prompt instructions alone.</li>
              <li><strong className="text-slate-200">Anatomical Distinction:</strong> Exposed intimate anatomy (bare breasts, buttocks, genitalia) is strictly distinguished from covered anatomy (clothing, swimwear, cleavage, midriff). Covered regions are never described as confirmed nudity, clothing slips, or wardrobe malfunctions.</li>
              <li><strong className="text-slate-200">Segment Aggregation:</strong> Consecutive findings across 4 FPS sampled frames are merged into contiguous review segments with deduplicated explanations and original video timestamps preserved.</li>
              <li><strong className="text-slate-200">Project-Based Billing:</strong> Billing depends entirely on whether a billing account is attached to your Google Cloud / Google AI Studio project, not on model selection alone. Users must explicitly confirm project billing intent before requests are initiated.</li>
              <li><strong className="text-slate-200">Rate & Quota Limits:</strong> Quota limits are governed by your Google AI Studio project plan. If a project quota or rate limit is reached (HTTP 429 / RESOURCE_EXHAUSTED), analysis halts immediately without retrying or activating paid tiers.</li>
              <li><strong className="text-slate-200">Inter-Frame Events:</strong> Because sampling occurs at 4 FPS (every 250ms), rapid transient events occurring entirely between sampled frames may still be missed.</li>
              <li><strong className="text-slate-200">Coverage Transparency:</strong> Frame sampling is processed internally by Gemini multimodal attention; individual frame-by-frame review cannot be independently verified externally, and verified frame counts are not fabricated.</li>
            </ul>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-slate-400">
            No sampled frames above the selected threshold is not proof that a video is safe. Human editorial review is always required.
          </div>
        </div>
      </aside>
    </div>
  );
}
