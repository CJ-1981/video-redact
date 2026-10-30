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
3. **Review** — pixel-truthful preview (the exact export redaction), colored timeline chips with draggable edge handles, per-track redact/keep-visible toggles and per-track style (pixelate or solid black), manual drawn regions (`B`) spanning the whole video with start/end trim (chip edges or clock-format inputs), transport bar (jump/frame-step/play-pause, 0.25×–4× speed, timecode), fullscreen/enlarge preview with auto-hiding overlay controls, resizable preview stage, distinct categorical colors for manual tracks.
4. **Export** — burn-in re-encode (H.264/MP4 → software H.264 → VP9/WebM ladder), audio packets copied bit-for-bit (AAC → MP4, Opus/Vorbis → WebM), streamed to OPFS/File System Access with progress, cancellation, temp cleanup; save picker (Chromium) or Blob download.
5. **Clear** — the header "✕ Clear" button aborts any in-flight pass, unloads the video (blob URL, decoder, mediabunny Input, leftover OPFS temps) and resets every panel to the landing view; the model cache, preview-stage height and version badge survive.

## Exclusions (v1 scope boundaries)

1. No server, upload, account, or cloud processing of any kind.
2. No face recognition, identity matching, OCR, or plate character reading — detection + redaction only.
3. No audio redaction or audio editing.
4. No redaction styles other than pixelate and solid black (no gaussian blur).
5. No general video editing (trim, cut, merge, filters, subtitles).
6. No batch processing — one source file per session.
7. No native/mobile packaging — browser only.
8. No HDR/Dolby Vision preservation — iPhone HDR footage exports tone-mapped to SDR (warned in the UI).

## Status

v1.10.0 implemented and verified (553 unit tests across 14 files, 6/6 E2E, gate exit 0). SPEC-VID-001 delivered the base app (v1.0.0); SPEC-VID-002 amendments added the review UX & manual redaction enhancements (v1.1.0–v1.5.0: per-track styles, full-span manual regions with trim, transport/fullscreen, portrait-aware tiling, mobile layout, configurable thresholds + single-frame compare); v1.6.0 added the Clear button (full unload & reset); v1.6.1–v1.10.0 fixed field-reported review-workspace defects (timeline seek accuracy + keyboard focus + footer overlap; iOS touch tap-to-seek; visible draggable scrub thumb with desktop-mouse reliability, playback-following via a `timeupdate` fallback and a time-boxed release pin; audio mute on both control bars; `?debug=1` runtime self-diagnostics with error/gesture counters; editor mount/tick exception isolation) and made the timeline/scrub/keyboard live at READY — before any analysis — with manual regions preserved through the analyze pass. See `.moai/specs/` for the SPECs and `CHANGELOG.md` for release history.
