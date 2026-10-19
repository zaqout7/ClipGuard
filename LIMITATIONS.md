# ClipGuard CPU Prototype: Limitations

ClipGuard is a local CPU prototype for generating potential image-classification matches for human review. It is not a safety certification or an accuracy-validated moderation system.

## Analysis and performance

- Inference uses ONNX Runtime WebAssembly CPU, single-threaded, with the pinned `AdamCodd/vit-base-nsfw-detector` model. The model has only `sfw` and `nsfw` image classes; it does not locate content or detect specific wardrobe events.
- The displayed NSFW value is a softmax model score, not a calibrated probability. A match is a candidate for human review.
- Video is sampled at the configured interval (default 1.5 seconds, allowed range 0.5–30 seconds). Short events between samples can be missed. “No matches” is not evidence that a video is safe.
- On Windows 11 with an Intel Core i7-12700H, the packaged prototype completed a generated 120-second, 640×360, 24 fps CFR clip at a 3-second interval: 40 samples in 309 seconds (about 7.7 seconds per sample including startup and other work).
- In measured packaged runs, ONNX inference averaged 6.77 seconds per sample, frame preprocessing/normalization 13 ms, and requested-seek-to-canvas-draw wait 0.87 seconds. The seek wait includes browser seek/presentation waiting, not decoder-only time. A separate 1080p run took 56–60 seconds for 8 samples; inference averaged 6.49–6.61 seconds per sample. Resolution alone was not isolated as a cause of timing differences.
- An earlier report stated roughly 2 seconds per sample at 360p, but its retained record does not include the exact fixture, runtime/process, cache or warm-up state, sample interval, or timer boundaries. It cannot be reconciled reliably with the later per-stage measurements; neither figure is a general speed guarantee.

## Frames, timestamps, and preprocessing

- CFR and VFR synthetic clips with visible PTS timecode markers were checked at 4.5 seconds. For each, the captured classifier input visibly showed `00:00:04.500`; the reported seek-time fallback and player `currentTime` were 4.500 seconds, and Jump placed the preview at 4.500 seconds. The CFR fixture had a packet PTS at 4.500 seconds. The VFR fixture had neighboring packet PTS values 4.375 and 4.500 seconds.
- These checks cover those generated fixtures and one seek position, not general frame-accurate playback or all codecs. The app may use seek-time fallback rather than decoded-frame presentation time, especially for paused seeks and VFR media.
- The model configuration specifies 384×384 input and a PIL bilinear resampling convention. ClipGuard uses browser canvas resizing to a square with a `medium` smoothing hint; interpolation is browser-dependent. No pixel-level numerical comparison against the reference PIL preprocessor was performed, so preprocessing parity is unverified.

## Other limitations

- YouTube video URLs are acquired locally via bundled yt-dlp, loaded directly into the browser decoding pipeline as an on-device stream, and evaluated using the identical local CPU ONNX classifier. No video bytes, frames, or metadata are transmitted to external inference services or cloud models.
- No authorized representative evaluation set or documented accuracy evaluation was available. Synthetic marker/blue clips test execution and timestamp behavior only; real-world detection quality remains unverified.
- GPU inference, broad codec compatibility, multi-hour resource stability, and clean-profile installer behavior remain unverified.
- The Windows installer is unsigned. Its SHA-256 is `77B5340D2F873666797B356106D326722EC7996BD12C31EFB8705E94E02A8176`; this checksum was recomputed locally and is not an authenticated publisher checksum.
- Installation and uninstallation were not tested. No managed disposable Windows VM or Windows Sandbox was available in the test environment. Do not install the package on a normal host as a substitute for isolated testing.
