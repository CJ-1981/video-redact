# SPEC-VID-001 — Compact (run-phase load artifact)

Source: spec.md v1.0.1. Requirements GEARS-notation, condensed. Full text: `spec.md`.

## Requirements (21, in 5 modules)

**M1 Media Ingest & Capability**
- REQ-001: System shall open local video files without uploading and report container/codec/resolution/fps/duration/audio/rotation metadata before processing. ProRes `.mov` decodes via `@mediabunny/prores`.
- REQ-002: When a file is opened, system shall probe decode (per-track) and export-encode capability and display a capability report before Analyze is offered.
- REQ-003: When a video track is undecodable, system shall block processing and give actionable guidance (HEVC: browser or "Most Compatible" re-record), no partial processing.
- REQ-004: Where context is insecure (`file://`), system shall show serve-over-localhost instructions and disable processing.

**M2 Detection & Tracking**
- REQ-005: System shall detect faces (YuNet 640² letterboxed) and plates (YOLOv9-t-640 end2end) via onnxruntime-web on decoded frames.
- REQ-006: System shall link detections into persistent labeled tracks (IoU + Kalman CV) and interpolate boxes across detection dropouts.
- REQ-007: System shall pad tracks ±5 frame periods and dilate boxes exactly 15% (7.5% per side, clamped) before redaction — no unredacted frame of a detected object.
- REQ-008: When Dashcam mode is on, system shall run a second tiled 640² pass and merge results into full-frame tracks.
- REQ-009: When analyzing, system shall show progress (frames, fps, ETA, track count) and support clean cancellation (tracks so far kept).
- REQ-010: Where WebGPU is available off WebKit, system shall run WebGPU EP with WASM fallback; WebKit gets WASM directly.
- REQ-011: When models are first needed, system shall download from pinned CDNs with progress and cache bytes in IndexedDB (`model@version`); later runs work offline from cache.

**M3 Review Editor**
- REQ-012: System shall render preview with box/label/color overlay synced to the displayed frame.
- REQ-013: System shall display a timeline with a colored chip per track over its redacted span; click chip = seek to track.
- REQ-014: When a track is toggled, system shall flip redact/keep-visible immediately in preview; export honors final states.
- REQ-015: When the user draws a manual box, system shall create a time-bounded manual track redacted like detected tracks.
- REQ-016: While reviewing, system shall render pixelation in the preview (pixel-truthful with export).

**M4 Export**
- REQ-017: On export, system shall burn active redactions into pixels, re-encode H.264/MP4 (VP9/WebM automatic fallback), and copy original audio packets without re-encoding (container hosts the source audio codec: AAC→MP4, Opus/Vorbis→WebM).
- REQ-018: System shall stream export output to OPFS/File-System-Access (streaming mux target), with progress and cancellation.
- REQ-019: On export completion, system shall deliver via save picker (Chromium) or Blob download and clean up temp storage after delivery/cancellation.

**M5 App Shell & Runtime**
- REQ-020: System shall ship as a single self-contained `index.html` (pinned CDN importmap, no runtime build; dev modules merged by dev-time inliner).
- REQ-021: When a runtime decode/encode/inference error occurs, system shall show a readable stage-specific error with recovery (retry / software encode / WebM fallback) and never emit silently corrupt output.

## Acceptance Criteria (19 + 5 perf gates; detail + full REQ→AC matrix in acceptance.md)

- AC-01 secure-context gate · AC-02 capability report · AC-03 analyze progress+cancel
- **AC-04 [PRIVACY-BLOCKING]** face pixelated and burned into encoded output pixels
- **AC-05 [PRIVACY-BLOCKING]** temporal padding/interpolation: zero unredacted leak frames across track span ± pad
- AC-06 toggle keep-visible honored in export · AC-07 manual region · AC-08 audio packet-copied + A/V sync · AC-09 dashcam tiled detection · AC-10 offline model cache
- AC-11 undecodable codec blocked w/ guidance · AC-12 export fallback ladder, no corrupt output · AC-13 corrupt/zero-detection inputs · AC-14 export cancel cleanup + stale-temp recovery
- AC-15 portrait rotation correctness · AC-16 WebM/VP9 source · AC-17 EP selection + WebGPU→WASM fallback · AC-18 overlay/timeline sync + chip seek · AC-19 single-file dist artifact E2E-verified
- P-1 1080p analyze ≥24 fps · P-2 1080p export ≥0.25× realtime · P-3 4K full run, bounded memory, monotonic progress · P-4 first load ≤ 40 MB then cached · P-5 UI stays responsive during passes

## Files (create; greenfield)

`index.html` · `src/{main,capability,ingest,models,detector,tracker,redact,editor,exporter}.js` · `tools/inline.mjs` · `tests/unit/*` · `tests/e2e/*` · `package.json` (+ vitest, Playwright, fake-indexeddb devDeps)

## Exclusions (What NOT to Build)

1. No server/upload/accounts/cloud processing. 2. No recognition/OCR/identity matching (detection-only). 3. No audio redaction. 4. No redaction styles beyond pixelate in v1. 5. No general video editing (trim/cut/filters/subtitles). 6. No multi-file batch. 7. No native/mobile packaging. 8. No HDR/Dolby Vision preservation (tone-mapped SDR export, UI-warned).
