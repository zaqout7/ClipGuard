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

        {/* Engine Selection */}
        <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950/70 p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Analysis Engine</p>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => onOptionsChange((prev) => ({ ...prev, engine: 'local_onnx' }))}
              className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition ${
                (options.engine || 'local_onnx') === 'local_onnx'
                  ? 'border-rose-500/80 bg-rose-500/10 text-white'
                  : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:border-slate-700'
              }`}
            >
              <div className="font-semibold text-slate-200">Local ONNX (On-Device)</div>
              <div className="mt-0.5 text-[10px] text-slate-400">NudeNet YOLOv8 (320n) / ViT WebGPU</div>
            </button>

            <button
              type="button"
              onClick={() =>
                onOptionsChange((prev) => ({
                  ...prev,
                  engine: 'gemini_video',
                  geminiConfig: prev.geminiConfig || {
                    apiKey: '',
                    model: 'gemini-3.8-flash',
                    fps: 4,
                    userConfirmedProjectBillingIntent: false,
                    userConsentedVideoUpload: false,
                  },
                }))
              }
              className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition ${
                options.engine === 'gemini_video'
                  ? 'border-rose-500/80 bg-rose-500/10 text-white'
                  : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center gap-1.5 font-semibold text-slate-200">
                <span>Google Gemini API</span>
                <span className="rounded bg-emerald-500/20 px-1 py-0.2 text-[9px] font-bold text-emerald-300">4 FPS</span>
              </div>
              <div className="mt-0.5 text-[10px] text-slate-400">Multimodal video at 0.25s interval via videoMetadata.fps</div>
            </button>
          </div>

          {/* Gemini Dedicated Configuration */}
          {options.engine === 'gemini_video' && (
            <div className="mt-3 space-y-3 border-t border-slate-800/80 pt-3 text-[11px]">
              <div>
                <label className="block text-slate-300 font-medium">
                  Gemini API Key
                  <input
                    type="password"
                    placeholder="Enter Gemini API key (or set GEMINI_API_KEY in server .env)"
                    value={options.geminiConfig?.apiKey || ''}
                    onChange={(e) =>
                      onOptionsChange((prev) => ({
                        ...prev,
                        geminiConfig: {
                          ...(prev.geminiConfig || {
                            model: 'gemini-3.8-flash',
                            fps: 4,
                            userConfirmedProjectBillingIntent: false,
                            userConsentedVideoUpload: false,
                          }),
                          apiKey: e.target.value,
                        },
                      }))
                    }
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100 placeholder:text-slate-600 focus:border-rose-500 focus:outline-none"
                  />
                </label>
                <p className="mt-1 text-[10px] text-slate-500">
                  Key is kept server-side, never logged, and never shared in chat. You can also place <code className="text-slate-400">GEMINI_API_KEY=your_key</code> in a local <code className="text-slate-400">.env</code> file.
                </p>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-slate-300 font-medium">Model Selection</label>
                  <select
                    value={options.geminiConfig?.model || 'gemini-3.8-flash'}
                    onChange={(e) => {
                      const newModel = e.target.value;
                      onOptionsChange((prev) => ({
                        ...prev,
                        geminiConfig: {
                          ...(prev.geminiConfig || {
                            apiKey: '',
                            fps: 4,
                            userConfirmedProjectBillingIntent: false,
                            userConsentedVideoUpload: false,
                          }),
                          model: newModel,
                        },
                      }));
                    }}
                    className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-100 focus:border-rose-500 focus:outline-none"
                  >
                    <option value="gemini-3.8-flash">gemini-3.8-flash (Standard multimodal model - recommended)</option>
                    <option value="gemini-2.5-flash">gemini-2.5-flash (Legacy multimodal model)</option>
                    <option value="gemini-2.0-flash">gemini-2.0-flash (Next-gen multimodal model)</option>
                    <option value="gemini-1.5-flash">gemini-1.5-flash (Lightweight multimodal model)</option>
                    <option value="gemini-1.5-pro">gemini-1.5-pro (High intelligence model)</option>
                    <option value="gemini-2.5-pro">gemini-2.5-pro (Flagship reasoning model)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-slate-300 font-medium">Sampling Rate (Fixed Parameter)</label>
                  <div className="mt-1 flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-slate-200">
                    <span className="font-mono text-emerald-400">4.0 FPS</span>
                    <span className="text-[10px] text-slate-400">videoMetadata.fps: 4 (0.25s)</span>
                  </div>
                </div>
              </div>

              {/* Explicit Billing & Consent Controls */}
              <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/90 p-2.5">
                <div className="text-[10px] text-slate-400 leading-relaxed">
                  <strong className="text-amber-300">Billing Notice: </strong>
                  Whether API calls are free or billed depends entirely on your Google Cloud / Google AI Studio project settings (i.e. whether a billing account is attached). Model selection alone does not guarantee zero cost. To ensure Free Tier usage, verify your project has no billing account attached at <a href="https://aistudio.google.com/" target="_blank" rel="noreferrer" className="text-rose-400 underline">aistudio.google.com</a>.
                </div>

                <label className="flex items-start gap-2 text-[10px] text-slate-300 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={Boolean(options.geminiConfig?.userConfirmedProjectBillingIntent)}
                    onChange={(e) =>
                      onOptionsChange((prev) => ({
                        ...prev,
                        geminiConfig: {
                          ...(prev.geminiConfig || {
                            apiKey: '',
                            model: 'gemini-3.8-flash',
                            fps: 4,
                            userConsentedVideoUpload: false,
                          }),
                          userConfirmedProjectBillingIntent: e.target.checked,
                        },
                      }))
                    }
                    className="mt-0.5 rounded border-slate-700 bg-slate-900 text-rose-500"
                  />
                  <span>
                    I confirm that I understand billing depends on my Google project settings, and I intend to use this project for analysis.
                  </span>
                </label>

                <label className="flex items-start gap-2 text-[10px] text-slate-300 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={Boolean(options.geminiConfig?.userConsentedVideoUpload)}
                    onChange={(e) =>
                      onOptionsChange((prev) => ({
                        ...prev,
                        geminiConfig: {
                          ...(prev.geminiConfig || {
                            apiKey: '',
                            model: 'gemini-3.8-flash',
                            fps: 4,
                            userConfirmedProjectBillingIntent: false,
                          }),
                          userConsentedVideoUpload: e.target.checked,
                        },
                      }))
                    }
                    className="mt-0.5 rounded border-slate-700 bg-slate-900 text-rose-500"
                  />
                  <span>
                    I consent to transmitting video data to Google's Gemini API (generativelanguage.googleapis.com) for content moderation review.
                  </span>
                </label>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2.5 text-[10px] text-slate-400">
                <span className="font-semibold text-slate-300">Sampling & Quota Note: </span>
                Video is requested at 4 FPS (one frame every 0.25 seconds). Brief transient events (&lt; 250ms) between sampled frames may still be missed. Effective frame coverage is handled internally by Gemini multimodal attention and cannot be independently confirmed. Check your project's active rate limits and quotas at <a href="https://aistudio.google.com/app/plan_information" target="_blank" rel="noreferrer" className="text-rose-400 underline">AI Studio Plan Information</a>.
              </div>
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-[11px] text-slate-300">
            Detection confidence threshold
            <input
              type="range"
              min={0}
              max={100}
              value={options.sensitivity}
              onChange={(e) => onOptionsChange((prev) => ({ ...prev, sensitivity: Number(e.target.value) }))}
              className="mt-2 w-full"
            />
            <span className="mt-1 block text-slate-400">{options.sensitivity}% detector confidence (NudeNet threshold; default 40%)</span>
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

        {/* Review Category Filters */}
        <div className="mt-5 space-y-3 rounded-xl border border-slate-800 bg-slate-950/70 p-3.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-400">Detection categories</p>

          <div className="space-y-1.5">
            <p className="text-[11px] font-medium text-emerald-400">Core Explicit Exposure (Default enabled)</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  checked={options.categories.possible_chest_exposure}
                  onChange={(e) => onOptionsChange((prev) => ({
                    ...prev,
                    categories: { ...prev.categories, possible_chest_exposure: e.target.checked }
                  }))}
                  className="rounded border-slate-700 bg-slate-900 text-rose-500"
                />
                Possible chest exposure
              </label>

              <label className="flex items-center gap-2 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  checked={options.categories.possible_rear_exposure}
                  onChange={(e) => onOptionsChange((prev) => ({
                    ...prev,
                    categories: { ...prev.categories, possible_rear_exposure: e.target.checked }
                  }))}
                  className="rounded border-slate-700 bg-slate-900 text-rose-500"
                />
                Possible rear exposure
              </label>

              <label className="flex items-center gap-2 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  checked={options.categories.nsfw_image_classification}
                  onChange={(e) => onOptionsChange((prev) => ({
                    ...prev,
                    categories: { ...prev.categories, nsfw_image_classification: e.target.checked }
                  }))}
                  className="rounded border-slate-700 bg-slate-900 text-rose-500"
                />
                Explicit nudity / NSFW content
              </label>
            </div>
          </div>

          <div className="space-y-1.5 pt-2 border-t border-slate-800">
            <p className="text-[11px] font-medium text-amber-400">Broad Anatomical Review (Default disabled — higher false alert burden)</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  checked={options.categories.clothing_shift_revealing}
                  onChange={(e) => onOptionsChange((prev) => ({
                    ...prev,
                    categories: { ...prev.categories, clothing_shift_revealing: e.target.checked }
                  }))}
                  className="rounded border-slate-700 bg-slate-900 text-rose-500"
                />
                Covered breast / cleavage
              </label>

              <label className="flex items-center gap-2 text-[11px] text-slate-400">
                <input
                  type="checkbox"
                  checked={options.categories.other_wardrobe_anomaly}
                  onChange={(e) => onOptionsChange((prev) => ({
                    ...prev,
                    categories: { ...prev.categories, other_wardrobe_anomaly: e.target.checked }
                  }))}
                  className="rounded border-slate-700 bg-slate-900 text-rose-500"
                />
                Exposed midriff / belly
              </label>

              <label className="flex items-start gap-2 text-[11px] text-slate-400 sm:col-span-2 pt-1.5 border-t border-slate-900">
                <input
                  type="checkbox"
                  checked={Boolean(options.categories.covered_buttocks_outline)}
                  onChange={(e) => onOptionsChange((prev) => ({
                    ...prev,
                    categories: { ...prev.categories, covered_buttocks_outline: e.target.checked }
                  }))}
                  className="mt-0.5 rounded border-slate-700 bg-slate-900 text-rose-500"
                />
                <div>
                  <div className="text-slate-300 font-medium">
                    Visible buttock outline through clothing
                    <span className="ml-2 text-slate-400 text-[10px]">(بروز شكل المؤخرة تحت الملابس)</span>
                  </div>
                  <div className="text-[10px] text-slate-500">
                    Covered region; visible clothing contour; optional human review. Kept strictly independent from exposed buttocks and other broad categories.
                  </div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 p-3 text-[11px] text-slate-300">
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
