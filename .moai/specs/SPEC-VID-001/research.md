# Research: SPEC-VID-001 — Client-Side Video Redaction Web App

> Greenfield project. No existing codebase — all research is external (browser APIs, models, libraries), verified against live sources on 2026-10-28 via three parallel research lenses. Every claim carries a source URL in the section it supports.

## 1. Product Constraints (from user)

- 100% client-side: no server, no upload; raw video never leaves the machine.
- **Single-file app**: one `index.html` (inline CSS/JS), heavy deps + model weights loaded from CDN at runtime.
- Inputs: "any modern video formats" — explicitly iPhone `.mov` 4K (HEVC "High Efficiency" and H.264 "Most Compatible", ProRes on Pro models), MP4, WebM.
- Detect (not recognize) faces + vehicle license plates → blur/pixelate/solid redaction → export video.

## 2. Architecture Verdict: Recommended Stack

### 2.1 Media pipeline — Mediabunny (not mp4box.js + mp4-muxer)

**Choice: `mediabunny@1.63.0` (MPL-2.0)** — single ESM library covering demux (MP4 **and QuickTime .mov**), WebCodecs decode/encode orchestration, mux (MP4/WebM/MOV), per-frame video processing, and audio packet-copy.

Rationale:
- Its `Conversion` API takes a per-frame `video.process` callback (where redaction is drawn) while **audio is transmuxed bit-for-bit without re-encoding** — exactly the required pipeline.
- Reads `.mov` + HEVC (`hvc1`/`hev1`) + `avc` + `aac` + `prores` (via `@mediabunny/prores` extension) natively; compatibility table shows hevc/avc readable+writable in both .mp4 and .mov.
- Files are read lazily from disk (`BlobSource` over `<input type="file">` File objects) — multi-GB safe.
- Actively maintained successor to mp4-muxer/webm-muxer (both formally deprecated, READMEs point to Mediabunny).

**Rejected alternatives**:
| Alternative | Rejection reason |
|---|---|
| mp4box.js 0.5.2 | Demux-only; QuickTime-specific boxes/codecs frequently fail; MSE-oriented API, not WebCodecs-pipeline-oriented |
| mp4-muxer 5.2.1 / webm-muxer 5.1.4 | Mux-only; officially deprecated in favor of Mediabunny |
| ffmpeg.wasm | No HW acceleration; 25-30 MB wasm; 2 GB memory ceiling; 10-50x slower than real time at 4K |
| MediaRecorder/captureStream | Realtime-only, lossy, no frame accuracy, no audio copy |

Sources: https://github.com/Vanilagy/mediabunny · https://mediabunny.dev/guide/quick-start · https://raw.githubusercontent.com/Vanilagy/mediabunny/main/docs/guide/supported-formats-and-codecs.md · https://github.com/Vanilagy/mp4-muxer (deprecation) · https://github.com/gpac/mp4box.js

### 2.2 Inference runtime — onnxruntime-web 1.31.1

- npm `latest` = **1.31.1** (MIT). WebGPU EP official since 1.17.
- **WebGPU EP on Chromium + Firefox; plain WASM (SIMD, single-thread) on Safari** — ort-web's WebGPU EP has an unfixed WebKit 26 perf/memory blowup (issue #26827, closed stale 2026-07-18). Feature-detect: enable WebGPU only off WebKit.
- CDN loading: import `ort.all.bundle.min.mjs` from jsDelivr (pinned version), set `ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/'`. JS bundle and wasm assets **must be the same version**.
- Asset sizes (verified HTTP headers): `ort-wasm-simd-threaded.jsep.wasm` ≈ 28.1 MiB (WebGPU path), `ort-wasm-simd-threaded.wasm` ≈ 14.2 MiB (CPU-only path). Load the WASM-only build on WebKit to avoid the useless 28 MB JSEP download.
- Threading (`numThreads>1`) needs SharedArrayBuffer → crossOriginIsolated (COOP/COEP). **Single-threaded SIMD wasm and the WebGPU EP do NOT require COI** — recommended default: no special headers, `numThreads=1` + WebGPU.
- Session-creation fallback chain: `['webgpu','wasm']` (some ops unsupported on WebGPU; device loss possible).

Sources: https://www.npmjs.com/package/onnxruntime-web · https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html · https://github.com/microsoft/onnxruntime/issues/26827 · https://github.com/microsoft/onnxruntime/issues/24325 · https://iot-robotics.github.io/ONNXRuntime/docs/reference/build-web-app.html

### 2.3 Detection models (detection only — no recognition, GDPR-aligned)

| Component | Model | Size | License | Input | Output |
|---|---|---|---|---|---|
| Face (primary) | YuNet `face_detection_yunet_2023mar.onnx` | 232,589 B (int8: 100,416 B) | MIT | **fixed [1,3,640,640]** float32 (verified by parsing ONNX bytes; docs mentioning 320×320 refer to older variants) | Raw head: cls/obj/bbox/kps at strides 8/16/32 → JS decode (anchor grid, sigmoid(cls×obj)) + NMS ~0.3 |
| Plate (primary) | `yolo-v9-t-640-license-plates-end2end.onnx` (ankandrew/open-image-models) | 7,835,770 B | MIT (repo; per-weights file unverified — residual item) | fixed 640×640 letterboxed RGB, conf 0.25 | **End2end: NMS inside graph** — rows `[x1,y1,x2,y2,class_id,score]` in letterboxed coords; un-letterbox `(v-pad)/ratio` |
| Face (fallback) | SCRFD 500M-10G (InsightFace) | 2.3-39 MB | **Non-commercial research-only** (upstream; HF mirrors relabeling as Apache are legally dubious) — avoid unless retrained | 640×640 | raw strides |
| Reference | Meta EgoBlur (Apache-2.0) | ~400 MB/model | Apache-2.0 but click-through gated | — | Not browser-viable; use as algorithmic reference (face every frame, plate every 2nd frame, track-linked) |

- YuNet download (CORS `*` verified): `https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx`
  - ⚠️ jsDelivr GH mirror of opencv_zoo returns a **131-byte Git LFS pointer, not the model** — never use that URL.
- Plate model download (GitHub release assets, verified): `https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-640-license-plates-end2end.onnx` (also 512/384/256 variants, ~7.8 MB each; t-640 mAP50 = 0.958).
- Rejected: `joker5914/yolov8n-license-plate` (AGPL-3.0 + nonstandard Hailo-targeted export); Ultralytics-family models generally (AGPL claims); BlazeFace (TFLite, not ONNX; short-range 128×128 tuning wrong for dashcam distances).
- Small-face range: YuNet effective ≈ 10-300 px face size at input scale; a 4K frame squeezed to 640 loses faces under ~35 px → **optional tiled second pass** (horizontal tiles of the 4K frame, each to 640) for dashcam mode. WIDERFace-val Hard AP: YuNet ≈ 70.8-75.0 vs SCRFD-500M 68.5 at 1/10 the size.

Sources: https://huggingface.co/opencv/face_detection_yunet · https://github.com/ankandrew/open-image-models · https://raw.githubusercontent.com/ankandrew/open-image-models/main/open_image_models/detection/core/hub.py · https://github.com/deepinsight/insightface/wiki/Model-Zoo · https://github.com/facebookresearch/EgoBlur · https://www.projectaria.com/tools/egoblur/ · https://arxiv.org/abs/2308.13093

### 2.4 Tracking — hand-rolled IoU + constant-velocity Kalman (~150-250 LOC)

- No maintained npm ByteTrack port exists (npm `bytetrack` is name-squatted). ByteTrack's two-stage association is simple to implement over an IoU matcher; `kalmanjs` (MIT) exists but a minimal in-file implementation avoids a dependency.
- Production pattern (EgoBlur, shipped since 2020): face detector every frame, plate detector every 2nd frame; link detections into tracks; merge track boxes; linear interpolation between detected frames.
- Temporal safety: bidirectional padding — hold/extend each track ±N frames beyond first/last detection; interpolate boxes across detector dropouts so blur never flickers off.

Sources: https://github.com/opendatacam/node-moving-things-tracker · https://arxiv.org/abs/2308.13093

### 2.5 Redaction rendering

- **Pixelate (drawImage down/up-scale, `imageSmoothingEnabled=false`) and solid box are the guaranteed-portable defaults.** `ctx.filter='blur(...)'` is GPU-accelerated in Chromium but **Safari only supports canvas 2D `filter` since Safari 18** — older Safari silently no-ops it, unacceptable for a redaction tool. Gaussian blur = progressive downscale fallback or feature-detected enhancement.
- Apply redaction only to the clipped region (never full-frame filters at 4K); dilate boxes ~15% (±7.5% per side), clamp to frame bounds.
- Destructive by construction: pixels are burned in before encode → no overlay metadata to strip; video track always re-encodes (remux-only impossible once pixels change).

Sources: https://caniuse.com/mdn-api_canvasrenderingcontext2d_filter · https://webkit.org/blog/15406/release-notes-for-safari-technology-preview-194 · https://issues.chromium.org/40314054

### 2.6 Export

- Video re-encode to **H.264 'avc'** (widest encoder support; HEVC encode unreliable outside WebKit). H.264 level string must match resolution — 4K needs level 5.1+ (e.g. probe with `VideoEncoder.isConfigSupported` per level). WebM/VP9 fallback when AVC encode unsupported.
- Audio: packet-copy original AAC (Mediabunny transmux) — no re-encode, perfect sync (original timestamps preserved).
- Large outputs: `StreamTarget` (chunked) → OPFS `FileSystemWritableFileStream` or File System Access `showSaveFilePicker` (Chromium); `BufferTarget` only < ~100 MB. Constant memory; progress via `onProgress`.
- `isConfigSupported() === true` is not a runtime guarantee — wrap encoder errors; retry `prefer-software`, then WebM fallback.

Sources: https://mediabunny.dev/guide/writing-media-files · https://github.com/w3c/webcodecs/issues/899 · https://webcodecsfundamentals.org/codecs/avc1.640433.html

## 3. Single-File Architecture & Hosting Constraints

- Pattern: inline `<script type="importmap">` pinning exact versions (mediabunny, onnxruntime-web) + one inline `<script type="module">`.
- **`file://` is NOT a supported runtime**: Cache API, OPFS, IndexedDB, File System Access are all unavailable/broken on `null` origin. The app must detect `!window.isSecureContext` and instruct: `python3 -m http.server` / `npx serve`. CDN ESM imports (ACAO `*`) do load from file:// in Chrome but storage breaks → model caching and streaming export die.
- Model caching: fetch once with progress → store bytes (IndexedDB, keyed `model@version`) → `InferenceSession.create(ArrayBuffer)` on later runs. `navigator.storage.persist()` to prevent eviction. Cache API without a service worker also works for URL-addressable files.
- First-load budget: ~28.3 MB (WebGPU path incl. JSEP wasm) or ~14.9 MB (WASM-only) + ~8 MB models ≈ **23-37 MB one-time download**, then cached.

Sources: https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system · https://github.com/jsdelivr/jsdelivr/issues/18561 · https://patrickbrosset.com/articles/2023-01-17-almost-everything-about-storing-data-on-the-web/

## 4. Performance Expectations

- WebGPU: ~10-20 ms per 640² frame (YOLOv8n-class); community range 15-60 ms on M-series/Chrome.
- WASM CPU: ~100-220 ms per 640² frame (measured 220 ms full pipeline on M3 Pro, PyImageSearch 2025); plan detection stride for WASM-only machines.
- Decode→canvas→re-encode at 4K: roughly real-time to a few× real-time (HW encode ~96 fps 4K60 on Apple Silicon; ~33 ms/frame just for 4K 10-bit canvas processing measured by Mozilla).
- Stride plan: faces every frame (fast motion), plates every 2nd frame; adaptive stride up to 3-10 with track interpolation on slow machines; "High accuracy" mode = tiled pass at full resolution.

Sources: https://pyimagesearch.com/2025/07/28/run-yolo-model-in-the-browser-with-onnx-webassembly-and-next-js · https://www.w3.org/2021/03/media-production-workshop/talks/paul-adenot-webcodecs-performance.pdf · https://gpuweb.github.io/gpuweb/discussions/4918

## 5. iPhone .mov / Codec Specifics

- iPhone defaults: "High Efficiency" = HEVC (`hvc1`) + AAC; "Most Compatible" = H.264 + AAC; Pro models add ProRes; HDR = 10-bit HEVC + Dolby Vision (HLG) metadata.
- HEVC **decode is hardware-gated** in Chrome (107+, no software fallback) — old GPUs/Intel Macs report `canDecode()===false`. Safari 17.4+ decodes HEVC via WebCodecs. Firefox least reliable.
- Apple stack requires `hvc1`-tagged HEVC (iPhone files are `hvc1`).
- Rotation metadata: portrait iPhone video stores a transformation matrix — Mediabunny exposes rotation and applies it in CanvasSink/Conversion (boxes must be in **display-oriented** coordinates).
- HDR gotcha: drawing 10-bit HDR frames to 8-bit SDR canvas shifts colors; DV metadata dropped on re-encode (accept + document, or tone-map later).

Sources: https://github.com/StaZhu/enable-chromium-hevc-hardware-decoding · https://issues.chromium.org/issues/40850900 · https://raw.githubusercontent.com/Vanilagy/mediabunny/main/docs/guide/reading-media-files.md · https://github.com/WebKit/standards-positions/issues/618

## 6. Risks (ranked)

1. **HEVC decode coverage gap** (Chrome HW-only) → mandatory capability pre-check + clear user messaging (use Chrome/Edge on modern GPU, or re-record "Most Compatible").
2. **Safari**: WebGPU EP broken on WebKit 26 → WASM path (slow); canvas `ctx.filter` <18 no-ops → pixelate/solid defaults; partial WebCodecs encode → browser gate for export.
3. **ORT CDN init fragility** (wasmPaths/version mismatch, esm.sh import rewriting) → pin versions, wasmPaths to same-version jsDelivr dist, smoke-test the pair.
4. **file:// not viable** → secure-context gate + serve instructions in-UI.
5. **4K memory pressure**: GPU-backed VideoFrames leak if not `close()`d → strictly sequential processing, 1-2 frames alive, one reused OffscreenCanvas.
6. **License residuals**: open-image-models per-weights license file unverified (repo MIT, no contradicting claim); SCRFD mirrors' mislabeling — avoided by choosing YuNet.
7. **Missed-detection safety**: single unblurred frame defeats the purpose → track padding + interpolation + minimum box dilation are acceptance-criteria items, not nice-to-haves.
8. **Mediabunny single-maintainer youth** → pin 1.63.0; documented fallback to deprecated-but-usable mp4-muxer/webm-muxer pair.

## 7. Open Items — RESOLVED at Decision Point 1 (2026-10-28)

- ~~[NEEDS CLARIFICATION: Blur default style]~~ — **RESOLVED: pixelate only.** v1 ships a single redaction style (pixelate); gaussian/solid styles are excluded from scope. Removes the Safari `ctx.filter` correctness hazard entirely.
- ~~[NEEDS CLARIFICATION: Dashcam tiled pass]~~ — **RESOLVED: included in v1** as an opt-in Analyze toggle ("Dashcam mode"); detector interface designed for multi-pass from day one.
- Residual license verification of open-image-models weight files — carried into plan.md risk register (repo is MIT; no contradicting claim found; mitigation: runtime model fetch + visible attribution).
