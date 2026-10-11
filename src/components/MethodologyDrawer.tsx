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
          <p>
            Local video files are sampled and classified in a browser worker using the bundled AdamCodd/vit-base-nsfw-detector ONNX model and ONNX Runtime WebAssembly CPU. The original file and extracted frames stay in the browser; this application does not send them to the Express service or a cloud inference API. YouTube/URL analysis is unavailable.
          </p>
          <ul className="space-y-2 list-disc pl-5 text-slate-300">
            <li>The model outputs only broad SFW and NSFW image classes. It does not localize nudity or identify wardrobe events.</li>
            <li>The displayed score is a softmax model score, not a calibrated probability. Matches are potential candidates requiring human review.</li>
            <li>The model may flag cleavage or exposed skin as NSFW and can produce false positives and false negatives. The model card reports weaker results for generated images.</li>
            <li>Frames are resized to 384×384 with browser canvas interpolation, which can vary by browser. Frames are sampled at the configured interval; brief events between samples may be missed. Timestamps use decoded-frame mediaTime where available and seek-time fallback otherwise; they are not guaranteed frame-accurate, especially across variable-frame-rate sources.</li>
            <li>Demo results are synthetic and never represent model output. Review notes and exports apply to the displayed results.</li>
            <li>Inference currently uses CPU WebAssembly only. NVIDIA GPU execution and Windows desktop packaging are not implemented.</li>
          </ul>
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-slate-400">
            No sampled frames above the selected threshold is not proof that a video is safe. Browser decoder codec support and model availability can vary by browser and installation.
          </div>
        </div>
      </aside>
    </div>
  );
}
