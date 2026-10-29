---
id: SPEC-VID-001
title: "Client-Side Video Redaction Web App: Face & License Plate Detection"
version: "1.0.1"
status: implemented
created: 2026-10-28
updated: 2026-10-28
author: MoAI
priority: P1
phase: "v1.0.0"
module: "index.html"
lifecycle: spec-anchored
tags: "video, redaction, privacy, webcodecs, onnx-runtime-web, face-detection, license-plate-detection, single-file, client-side"
---

# SPEC-VID-001: Client-Side Video Redaction Web App: Face & License Plate Detection

## HISTORY

- v1.0.1 (2026-10-28): Post-audit revisions (review-1 FAIL → fixes → review-2 PASS 0.875): added AC-17/18/19 (EP fallback, overlay/timeline sync, single-file artifact), ProRes via `@mediabunny/prores`, exact 15% dilation wording, audio container-follows-codec (no re-encode path), deterministic AC-09, P-4 ≤ 40 MB.
- v1.0.0 (2026-10-28): Initial SPEC. Created via `/moai plan` after 3-lens parallel research (research.md) and user gate approval (Proceed / Tier L / pixelate-only / dashcam-mode included).

## 1. Overview

A 100% client-side, single-file web application that automatically detects faces and vehicle license plates in user-supplied videos (including iPhone `.mov` 4K HEVC/H.264/ProRes, MP4, WebM), lets the user review and adjust the detected tracks on a timeline, and exports a re-encoded MP4 with pixelation **burned into the pixels** while the original audio is preserved bit-for-bit. No server exists; raw video never leaves the user's machine. The shipped artifact is one self-contained `index.html` that loads pinned libraries and model weights from CDNs at runtime.

Detection only — no recognition, no OCR, no identity matching (GDPR-aligned privacy redaction).

## 2. Requirements (GEARS)

Requirement modules (5): M1 Media Ingest & Capability · M2 Detection & Tracking · M3 Review Editor · M4 Export · M5 App Shell & Runtime.

### M1 — Media Ingest & Capability

- **REQ-001** — The system shall open local video files via a file picker without uploading any bytes, and shall report container and codec metadata (container, video codec, resolution, frame rate, duration, audio codec, rotation) before any processing begins. iPhone ProRes `.mov` input shall decode via the official `@mediabunny/prores` extension.
- **REQ-002** — When the user opens a video file, the system shall probe decode capability for every video/audio track (via Mediabunny `track.canDecode()` / WebCodecs `isConfigSupported`) and encode capability for the export target, and shall display a capability report before the analyze step is offered.
- **REQ-003** — When a video track that cannot be decoded in the current browser is detected, the system shall block processing of that file and present actionable guidance (use a browser with hardware HEVC decode, or re-record with iPhone Camera → Formats → "Most Compatible") without partial processing.
- **REQ-004** — Where the page is not in a secure context (`file://`), the system shall display serve-over-localhost instructions (e.g. `python3 -m http.server`, `npx serve`) and disable all processing until served over `http://localhost` or HTTPS.

### M2 — Detection & Tracking

- **REQ-005** — The system shall detect faces with the YuNet ONNX model (`face_detection_yunet_2023mar.onnx`, 640×640 letterboxed input) and license plates with the YOLOv9-t-640 end-to-end ONNX model, running inference via onnxruntime-web on decoded frames.
- **REQ-006** — The system shall link per-frame detections into persistent tracks with stable human-readable identities (e.g. "Face #1", "Plate #4") using IoU association with a constant-velocity Kalman filter, and shall linearly interpolate bounding boxes across frames where detection drops out.
- **REQ-007** — The system shall extend every track temporally by a padding interval (default 5 frame periods on each side of the detected span) and dilate every redaction box by exactly 15% of the box dimensions (7.5% per side, clamped to frame bounds) before redaction is applied, so that no single unredacted frame of a detected object is exportable.
- **REQ-008** — When "Dashcam mode" is enabled by the user, the system shall run a second tiled detection pass (the frame split into horizontal tiles, each independently letterboxed to 640×640 and inferred) and merge tile results back into full-frame display coordinates and the same track set.
- **REQ-009** — When an analyze pass is running, the system shall display live progress (processed frame count, detected track count, processing fps, elapsed and estimated remaining time) and shall support user cancellation that leaves the app in a consistent state with tracks found so far.
- **REQ-010** — Where the WebGPU execution provider is available and the browser engine is not WebKit, the system shall run inference on WebGPU with automatic fallback to WASM (SIMD) on session-creation failure; on WebKit browsers the system shall use the WASM execution provider directly.
- **REQ-011** — When model weights are first required, the system shall download them from pinned CDN URLs with visible download progress and shall store the raw bytes in IndexedDB keyed by `model@version`; on subsequent runs the system shall load weights from the local cache without network access.

### M3 — Review Editor

- **REQ-012** — The system shall render a video preview with a canvas overlay showing each active track's bounding box, identity label, and track color, synchronized to the displayed frame during scrubbing and playback.
- **REQ-013** — The system shall display a timeline where every track renders as a color-coded chip spanning its redacted time range, with a playhead, and clicking a chip seeks to that track.
- **REQ-014** — When the user toggles a track (via timeline chip or preview box), the system shall flip that track between "redact" and "keep visible" states and shall immediately reflect the change in the preview, and the final state at export shall be the user's chosen state.
- **REQ-015** — When the user draws a manual box on the current preview frame, the system shall create a manual region track (time-bounded, editable span) that is redacted exactly like detected tracks.
- **REQ-016** — While the review editor is open, the system shall render pixelation redaction for all active tracks in the preview itself, so the preview is pixel-truthful with the exported file.

### M4 — Export

- **REQ-017** — When the user starts an export, the system shall decode every frame, burn all active redactions into the frame pixels, re-encode the video (H.264 in MP4 as primary target; VP9/WebM as automatic fallback where H.264 encoding at the source resolution is unsupported), and copy the original audio packets without re-encoding — selecting the output container that hosts the source audio codec (AAC → MP4; Opus/Vorbis → WebM).
- **REQ-018** — The system shall stream export output to disk-backed storage (OPFS or File System Access) via a streaming mux target rather than buffering the whole output in memory, and shall expose export progress and cancellation.
- **REQ-019** — When an export completes, the system shall deliver the output file via save-file picker where available (Chromium) or a Blob download otherwise, and shall clean up temporary output storage after delivery or cancellation.

### M5 — App Shell & Runtime

- **REQ-020** — The system shall be delivered as a single self-contained `index.html` file with pinned exact-version CDN ESM imports (importmap), no runtime build step, and no server-side component; local `src/` modules are permitted during development and merged into the single file by a dev-time inliner script.
- **REQ-021** — When a runtime decode, encode, or inference error is detected, the system shall present a readable error message with the failed stage and a recovery action (retry, software-encode retry, WebM fallback), and shall never produce a silently corrupted output file.

## 3. Acceptance Criteria

All ACs are Given/When/Then scenarios in `acceptance.md` (AC-01 … AC-19), including the privacy-critical no-leak criterion AC-05 (temporal padding) and burn-in criterion AC-04. Performance gates for reference hardware are defined in `acceptance.md` § Performance Gates.

## 4. What NOT to Build (Exclusions)

1. No server, upload, account, or cloud processing of any kind.
2. No face recognition, identity matching, OCR, or license-plate character reading (detection + redaction only).
3. No audio redaction or audio editing.
4. No redaction styles other than pixelate in v1 (no gaussian blur, no solid fill — user decision at plan gate).
5. No general video editing (trim, cut, merge, filters, subtitles).
6. No batch processing of multiple files in one session (v1 = one source at a time).
7. No native/mobile packaging; browser-only.
8. No HDR/Dolby Vision preservation — iPhone HDR footage exports tone-mapped SDR (documented limitation, warned in UI).

## 5. References

- `research.md` — verified stack, model specs, licenses, CDN URLs, performance expectations, risk register.
- `design-direction.md` — UI intent, color world, signature element (track timeline).
- `design.md` — technical architecture, data model, algorithms, ADRs.
- `plan.md` — milestones, task decomposition, test strategy, MX plan.
