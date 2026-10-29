# Product: Video Redact (SPEC-VID-001)

## Vision

A 100% client-side web app that automatically detects faces and vehicle license plates in user-supplied videos, lets the user review and adjust the detected tracks on a timeline, and exports a re-encoded video with pixelation **burned into the pixels** while the original audio is preserved bit-for-bit. No server exists; raw video never leaves the user's machine. The shipped artifact is one self-contained `index.html` that loads pinned libraries and model weights from CDNs at runtime.

Detection only — no recognition, no OCR, no identity matching (GDPR-aligned privacy redaction).

## Users

- Anyone who must share footage that contains bystanders' faces (journalists, researchers, citizens releasing dashcam/body-cam/doorbell clips).
- Dashcam/vehicle owners redacting license plates before publishing clips.
- iPhone users (HEVC `.mov`, including ProRes) who need redaction without uploading 4K footage to a cloud service.

## Core flows

1. **Intake & capability check** — drop a file; the app reports container/codec/resolution/fps/duration/audio/rotation and probes decode + export-encode capability *before* Analyze is offered. Undecodable files (e.g. HEVC without hardware decode) are blocked with actionable guidance; `file://` contexts get serve-over-localhost instructions and no processing.
2. **Analyze** — YuNet faces (every frame) + YOLOv9-t plates (every 2nd frame; optional tiled "Dashcam mode" pass) run via onnxruntime-web (WebGPU → WASM ladder). Detections become persistent labeled tracks (IoU + Kalman CV) with dense interpolated keyframes, ±5-frame-period padded spans, and 15%-dilated boxes. Live progress with clean cancellation (partial tracks stay usable).
3. **Review** — pixel-truthful preview (the exact export pixelation), colored timeline chips over each redacted span, per-track redact/keep-visible toggles, manual drawn regions (`B` key), scrub/frame-step.
4. **Export** — burn-in re-encode (H.264/MP4 → software H.264 → VP9/WebM ladder), audio packets copied bit-for-bit (AAC → MP4, Opus/Vorbis → WebM), streamed to OPFS/File System Access with progress, cancellation, temp cleanup; save picker (Chromium) or Blob download.

## Exclusions (v1 scope boundaries)

1. No server, upload, account, or cloud processing of any kind.
2. No face recognition, identity matching, OCR, or plate character reading — detection + redaction only.
3. No audio redaction or audio editing.
4. No redaction styles other than pixelate (no gaussian blur, no solid fill — user decision at the plan gate).
5. No general video editing (trim, cut, merge, filters, subtitles).
6. No batch processing — one source file per session.
7. No native/mobile packaging — browser only.
8. No HDR/Dolby Vision preservation — iPhone HDR footage exports tone-mapped to SDR (warned in the UI).

## Status

v1.0.0 implemented and verified (310 unit tests, 6/6 E2E, coverage gate green). See `.moai/specs/SPEC-VID-001/` for the SPEC, design, and acceptance criteria, and `CHANGELOG.md` for release history.
