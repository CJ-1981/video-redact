# Changelog

All notable changes to this project are documented in this file.

The format is based on the Keep a Changelog convention, and this project adheres to Semantic Versioning.

## [Unreleased]

## [1.0.0] — 2026-10-29

Initial release — SPEC-VID-001: client-side video redaction web app (faces & license plates, pixelate burn-in, nothing uploaded).

### Added

- Local file intake (`.mov` / MP4 / WebM, including iPhone HEVC and ProRes via `@mediabunny/prores` 1.63.0) with a pre-analyze capability report: container/codec/resolution/fps/duration/audio/rotation plus per-track decode and export-encode probes; undecodable input is blocked with actionable guidance (REQ-001…003).
- Serve-over-localhost gate: under `file://` all processing is disabled with copy-paste serve instructions (REQ-004).
- Detection: YuNet 2023mar faces (640×640 letterboxed) + YOLOv9-t-640 end-to-end license plates via onnxruntime-web 1.31.1; WebGPU → WASM execution-provider ladder, WASM directly on WebKit; optional "Dashcam mode" tiled second pass (REQ-005, 008, 010).
- Tracking: IoU-gated association with a constant-velocity Kalman filter, stable labels ("Face #1", "Plate #4"), gap interpolation on a dense 1/30 s grid, ±5-frame-period span padding and 15% box dilation before redaction — no unredacted frame of a detected object is exportable (REQ-006, 007).
- Model delivery: pinned CDN URLs with download progress, IndexedDB byte cache (`model@version`), fully offline after first run (REQ-011).
- Review editor: box/label/color overlay synced to the displayed frame, timeline chips spanning each redacted range (click = seek), per-track redact/keep-visible toggles, manual drawn regions, pixel-truthful preview sharing the export burn-in code path (REQ-012…016).
- Export: burn-in re-encode with a codec fallback ladder (H.264/MP4 hardware → H.264 software → VP9/WebM), audio packets copied bit-for-bit (AAC → MP4, Opus/Vorbis → WebM), streaming output to OPFS/File System Access with progress, cancellation, temp cleanup and crash-recovery sweep (REQ-017…019, 021).
- Single-file artifact: `dist/index.html` (~122 KiB) with pinned exact-version CDN importmap, built by `tools/inline.mjs` (build fails on any leaked dev-module reference) and stamped with the version + build date (REQ-020).
- Readable, stage-specific errors with recovery actions for decode/encode/inference failures; no silently corrupted output (REQ-021).
- Test suites: 310 unit tests (12 files, vitest) and 6 Playwright E2E tests across 5 specs — smoke (2), full journey (in-page re-decode burn-in assertion + AAC preservation), auto-detect with real YuNet inference, offline model cache, corrupt-input handling.

### Verification

- Unit: 303 → 310 tests, all passing (12 files).
- E2E: 6/6 passing in Chromium.
- Coverage: v8 gate ≥ 85% lines on all 8 logic modules (analyze 85.5, capability 96.9, detector 99.4, exporter 100, ingest 95.7, models 94.2, redact 92, tracker 100).
- Gate: `npm run gate` (eslint 0 errors · tsc --noEmit 0 errors · unit suite · build) exits 0.

### Fixed

- YuNet inference produced zero detections on real photos: the 2023mar graph requires raw 0–255 BGR input (not normalized RGB) and its cls/obj heads are already sigmoid'ed in-graph, so the previous extra JS sigmoid squashed a 0.96 face below the 0.6 threshold — fixed to 0–255 BGR with geometric-mean scoring per the OpenCV `FaceDetectorYN` reference; regression-pinned and live-verified (confidence 0.936 through the production path).
- Plate model URL: the canonical GitHub release asset sends no CORS headers on any redirect hop, making it unfetchable from a browser — switched to a Hugging Face mirror serving the same bytes (size-pinned) with CORS `*`.
- Export delivery race: the Blob download could be canceled by premature deletion of the OPFS staging temp — temp cleanup now happens strictly after delivery or cancellation.
- Preview dilation parity: the editor preview did not dilate redaction boxes exactly like the export burn-in — both paths now share the same `redact.pixelateFrame` seam, keeping the preview pixel-truthful.
