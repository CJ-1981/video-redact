# Product: Video Redact (SPEC-VID-001 + SPEC-VID-002 amendments)

## Vision

A 100% client-side web app that automatically detects faces and vehicle license plates in user-supplied videos, lets the user review and adjust the detected tracks on a timeline, and exports a re-encoded video with pixelation **burned into the pixels** while the original audio is preserved bit-for-bit. No server exists; raw video never leaves the user's machine. The shipped artifact is one self-contained `index.html` that loads pinned libraries and model weights from CDNs at runtime.

Detection only — no recognition, no OCR, no identity matching (GDPR-aligned privacy redaction).

## Users

- Anyone who must share footage that contains bystanders' faces (journalists, researchers, citizens releasing dashcam/body-cam/doorbell clips).
- Dashcam/vehicle owners redacting license plates before publishing clips.
- iPhone users (HEVC `.mov`, including ProRes) who need redaction without uploading 4K footage to a cloud service.

## Core flows

1. **Intake & capability check** — drop a file; the app reports container/codec/resolution/fps/duration/audio/rotation and probes decode + export-encode capability *before* Analyze is offered. Undecodable files (e.g. HEVC without hardware decode) are blocked with actionable guidance; `file://` contexts get serve-over-localhost instructions and no processing.
2. **Analyze** — YuNet faces (every frame) + YOLOv9-t plates (every 2nd frame; optional tiled "Dashcam mode" pass that splits frames along the dominant axis — portrait frames tile vertically into stacked rows) run via onnxruntime-web (WebGPU → WASM ladder). Face/plate confidence thresholds are user-configurable (sensitivity sliders, defaults 0.60/0.25) with a single-frame threshold comparison preview before a full analysis. Detections become persistent labeled tracks (IoU + Kalman CV) with dense interpolated keyframes, ±5-frame-period padded spans, and 15%-dilated boxes. Live progress with clean cancellation (partial tracks stay usable).
3. **Review** — pixel-truthful preview (the exact export redaction), colored timeline chips with draggable edge handles, per-track redact/keep-visible toggles and per-track style (pixelate or solid black, plus bulk "All solid"/"All pixelate" restyle), manual drawn regions (`B`) spanning the whole video with start/end trim (chip edges or clock-format inputs), ✂ trim regions marked on the timeline for deletion at export (multiple regions, draggable edges; analysis skips trimmed frames), pixelation strength (Fine/Normal/Coarse/Max block multiplier), transport bar (jump/frame-step/play-pause, 0.25×–4× speed, timecode), keyboard shortcuts (`←`/`→` jump ±5 s, `Shift+←/→` frame-step, `F` fullscreen, `M` mute, `Space` play/pause, `B` draw box), fullscreen/enlarge preview with auto-hiding overlay controls, resizable preview stage / rail / intake panels, light theme toggle, project save/load (`.vrproj`), distinct categorical colors for manual tracks.
4. **Export** — burn-in re-encode (H.264/MP4 → software H.264 → VP9/WebM ladder), audio packets copied bit-for-bit (AAC → MP4, Opus/Vorbis → WebM) or dropped entirely via the "Include audio" checkbox, export resolution Full/1080p/720p/480p (480p caps the long edge at 854; scales the burn-in canvas, redaction boxes and encoder hints together; choices persist across repeated exports and reset on file load/Clear), trimmed regions excluded (kept segments concatenated with continuous timestamps), streamed to OPFS/File System Access with progress, cancellation, temp cleanup; save picker (Chromium) or Blob download.
5. **Clear** — the header "✕ Clear" button aborts any in-flight pass, unloads the video (blob URL, decoder, mediabunny Input, leftover OPFS temps) and resets every panel to the landing view; the model cache, preview-stage height and version badge survive.

## Exclusions (v1 scope boundaries)

1. No server, upload, account, or cloud processing of any kind.
2. No face recognition, identity matching, OCR, or plate character reading — detection + redaction only.
3. No partial audio redaction or audio editing — the audio track is copied as-is or dropped whole (v1.16.0 "Include audio" checkbox).
4. No redaction styles other than pixelate and solid black (no gaussian blur); pixelation strength varies the block size, not the style.
5. No general video editing beyond redaction-span exclusion (the v1.15.0 ✂ trim feature deletes marked regions from the export; there is no arbitrary cut/merge/reorder, filters, or subtitles).
6. No batch processing — one source file per session.
7. No native/mobile packaging — browser only.
8. No HDR/Dolby Vision preservation — iPhone HDR footage exports tone-mapped to SDR (warned in the UI).

## Status

v1.18.1 implemented and verified (765 unit tests across 15 files, 6 E2E tests in 5 specs, gate exit 0). SPEC-VID-001 delivered the base app (v1.0.0); SPEC-VID-002 amendments added the review UX & manual redaction enhancements (v1.1.0–v1.5.0: per-track styles, full-span manual regions with trim, transport/fullscreen, portrait-aware tiling, mobile layout, configurable thresholds + single-frame compare); v1.6.0 added the Clear button (full unload & reset); v1.6.1–v1.10.0 fixed field-reported review-workspace defects (timeline seek accuracy + keyboard focus + footer overlap; iOS touch tap-to-seek; visible draggable scrub thumb with desktop-mouse reliability, playback-following via a `timeupdate` fallback and a time-boxed release pin; audio mute on both control bars; `?debug=1` runtime self-diagnostics with error/gesture counters; editor mount/tick exception isolation) and made the timeline/scrub/keyboard live at READY — before any analysis — with manual regions preserved through the analyze pass; v1.11.0–v1.14.1 added the workspace/ergonomics wave (keyboard transport REQ-122, light theme, file-info block, analysis downscale, bulk restyle, collapsible panels, Models panel under the footer, below-timeline compare/track layout, rail + intake resize handles, preview-redraw-on-resize fix); v1.15.0–v1.15.2 added the ✂ trim feature (multi-region timeline trims, kept-segment concat export, trims skipped in analysis); v1.16.0 added export resolution + audio removal; v1.17.0 added pixelation strength, project save/load (`.vrproj`), settings-honoring threshold compare and fixed the v1.16.0 export-settings regression; v1.17.1 fixed the export choices being reset before read (resolution/audio now reset only on file load and Clear, not on export click); v1.18.0 added the 480p export resolution (long edge 854) and aligned the Tracks + Compare-thresholds panels to the preview-column width; v1.18.1 moved the below-timeline section (Tracks + Compare thresholds) inside the preview column directly after the timeline — no longer a workspace-grid child, a constant 28px gap regardless of the right rail's height. See `.moai/specs/` for the SPECs and `CHANGELOG.md` for release history.
