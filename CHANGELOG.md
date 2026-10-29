# Changelog

All notable changes to this project are documented in this file.

The format is based on the Keep a Changelog convention, and this project adheres to Semantic Versioning.

## [Unreleased]

## [1.3.0] — 2026-10-29

Track-time editing, distinct manual colors, and the trim-gesture fix (SPEC-VID-002 amendments REQ-108/109/110).

### Added

- Per-track start/end time inputs in the track list (REQ-108): each row exposes editable clock-format (`m:ss.s`) bounds committed on change/blur/Enter (Escape reverts); invalid input reverts to the current span. Editing routes through the same trim path as chip dragging (`onTrimTrack` → `trimTrack`), so the preview, timeline chips, row readout and export span update together. Rows reconcile in place on refresh, and the value of a focused input is never overwritten mid-edit.
- Distinct manual-region colors (REQ-109): manual tracks now take the same categorical 8-slot palette as auto tracks (`TRACK_COLORS[(id − 1) % 8]` — the exact tracker.js slot rule, so manual/auto never collide within a session) instead of a shared fixed alert red. Manual identity stays visible via the "Manual #N" label and a dashed chip outline.

### Fixed

- Chip-edge trim drags now start reliably, so the chip's rendered length updates live during the drag with the row span readout following it (REQ-110). Root cause (verified with a live pointer-event probe): the edge-grab hit test only matched INSIDE the chip span, and the trim gesture was wired to the chips layer — so on the most common chips (every manual region and any auto track spanning the whole video) the end edge sits exactly on the strip boundary, the pointerdown there hit-tests to the timeline strip instead of the chips layer, the drag never started, and the follow-up click seeked instead of trimming. Edge hit zones now extend ±6 px around each chip edge (grabbable from outside too) and the gesture is bound to the whole timeline strip; each pointermove re-renders the chip live (probe-measured: chip width changes ≥ 20 px mid-drag).

## [1.2.0] — 2026-10-29

Preview ergonomics follow-up to SPEC-VID-002: the preview stage is resizable.

### Added

- Draggable preview-height handle between the preview stage and the transport bar: drag it up/down to resize the preview (clamped to 220 px – 75% of the viewport height, recomputed while dragging), double-click to reset to the default height, and ArrowUp/ArrowDown on the focused handle steps ±24 px (`role="separator"` semantics with a live `aria-valuenow`). The stage height is driven by the `--stage-h` custom property and every change re-scales the pixel-truthful overlay through the editor's existing `redraw()` path — the same seam as fullscreen/zoom.

## [1.1.0] — 2026-10-29

SPEC-VID-002 — review UX & manual redaction enhancements from real-world field feedback.

### Added

- Solid redaction style: per-track `pixelate` / `solid` (opaque black) choice in the track list, defaulted to solid for manual regions and pixelate for auto-detected tracks; both styles burn through the same shared preview/export seam (`track.style` + per-track dispatch in `redact.pixelateFrame`) (REQ-101, AC-102/103).
- Manual regions now span the entire video by default, with draggable timeline-chip edge handles (≤ 6 px hit zones) to trim the start/end and a 0.1 s minimum span — manual regions are fixed boxes, no motion tracking (REQ-103, AC-101).
- Transport bar under the preview: jump-to-start, frame-step back/forward (±1 source frame, matching the keyboard shortcuts), play/pause with a live glyph swap, playback speed selector (0.25×–4×) and a current/total timecode readout; all keyboard shortcuts keep working (REQ-105, AC-104).
- Fullscreen / enlarge preview control: native Fullscreen API where available, with an in-page viewport-covering fallback (`.preview-zoom`) and an always-visible exit control where it is not (iOS Safari); the preview overlay re-sizes to the enlarged display on enter/exit (REQ-106, AC-105).
- Portrait-aware dashcam tiling: portrait frames tile vertically into stacked rows so small faces/plates reach ≥ ~2× the model-input scale (detector change; landscape tiling and single-coordinate merge unchanged) (REQ-107, AC-106).
- Discoverability hint next to the timeline: pause and drag a box on the video to cover anything detection missed.

### Fixed

- Portrait video dashcam tiling was a no-op: the horizontal-only tile split produced a single tile (k=1) for portrait frames, so dashcam mode did nothing exactly where it was needed most — small faces in portrait phone footage now get real tile-scale magnification (miss analysis 2026-10-29).

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
