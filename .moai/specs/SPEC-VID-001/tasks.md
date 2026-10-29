# Task Decomposition — SPEC-VID-001

Method: TDD (RED-GREEN-REFACTOR), serial milestones, one writer agent per milestone. Planned files per plan.md §C.

| Task ID | Description | Requirement | Dependencies | Planned Files | Status |
|---------|-------------|-------------|--------------|---------------|--------|
| T-101 | Scaffold: package.json (pinned devDeps: vitest, playwright, fake-indexeddb, esbuild), vitest config, npm scripts (dev/test/test:e2e/build/gate), dev index.html shell (importmap + markup per design-direction), tools/inline.mjs (esbuild-bundle src → dist/index.html), stub src modules | REQ-020, AC-19 | — | package.json, vitest.config.js, playwright.config.js, index.html, tools/inline.mjs, src/*.js (stubs) | done |
| T-102 | capability.js TDD: secure-context info, decode/encode capability probe model (seamed WebCodecs/mediabunny), guidance taxonomy (HEVC path) | REQ-002/003/004, AC-01/02/11 | T-101 | src/capability.js, tests/unit/capability.test.js | done |
| T-103 | ingest.js TDD: openInput via mediabunny (codec/res/fps/duration/rotation/audio metadata), ProRes registration, error taxonomy | REQ-001, AC-02/15 | T-101 | src/ingest.js, tests/unit/ingest.test.js | done |
| T-201 | models.js TDD: MODELS registry (url/version/license/bytes), fetch-with-progress, IndexedDB cache round-trip, offline hit | REQ-011, AC-10 | T-101 | src/models.js, tests/unit/models.test.js | done |
| T-202 | detector.js TDD (pure): letterbox/un-letterbox; YuNet tensor decode (sigmoid(cls·obj), distance2bbox, strides 8/16/32) vs synthetic fixture tensors; NMS; plate end2end row parse; tile grid + merge-back | REQ-005/008, AC-09 | T-101 | src/detector.js, tests/unit/detector.test.js | done |
| T-203 | detector.js ORT session management: engine sniff (WebKit→WASM), ['webgpu','wasm'] fallback ladder, EP failure retry | REQ-010, AC-17 | T-201, T-202 | src/detector.js | done |
| T-301 | tracker.js TDD: IoU, Kalman CV, gated association, track lifecycle/IDs/colors, linear interpolation, ±padding (5 frame periods), per-class tracks | REQ-006/007, AC-05 | T-101 | src/tracker.js, tests/unit/tracker.test.js | done |
| T-401 | analyze.js: frame iteration (VideoSampleSink, seconds-keyed), stride schedule (faces 1:1, plates 1:2), dashcam tiled pass, progress model, AbortSignal cancellation, sample.close() discipline | REQ-005/008/009, AC-03/09 | T-202, T-203, T-301 | src/analyze.js, tests/unit/analyze.test.js | done |
| T-501 | redact.js TDD: dilation (15%, clamp), tracksAt(t), pixelate renderer (block = max(12, min(w,h)/10)), overlay drawing | REQ-007/016, AC-04/05 | T-301 | src/redact.js, tests/unit/redact.test.js | done |
| T-502 | editor.js: <video> playback + overlay canvas sync, timeline chips (model TDD: ranges, hit-test, toggle), manual box drawing, keyboard | REQ-012/013/014/015, AC-18/06/07 | T-501, T-401 | src/editor.js, tests/unit/timeline.test.js | done |
| T-601 | exporter.js TDD (seamed): Conversion burn-in process(), codec ladder (avc→software retry→vp9/WebM), audio packet-copy container-follows-codec, StreamTarget→OPFS staging, progress/cancel/cleanup, save-picker/download delivery | REQ-017/018/019/021, AC-04/08/12/14/16 | T-501 | src/exporter.js, tests/unit/exporter.test.js | done |
| T-602 | main.js wiring: stepper state machine (gate→ready→analyzing→review→exporting→done), secure-context screen, capability panel, model attribution panel, CSP meta | REQ-004/020, AC-01 | T-102, T-103, T-401, T-502, T-601 | src/main.js, index.html | done |
| T-701 | E2E (Playwright/Chromium): smoke on dist/index.html; synthetic-clip analyze→tracks; toggle journey; export journey (re-decode output, assert pixelated region + audio); offline model-cache journey | AC-02..AC-19 (E2E-covered) | T-602 | tests/e2e/*.spec.js, tests/fixtures/* | done |
| T-702 | Quality band: coverage ≥85% src logic, lint/format/typecheck gate, dist build verified, MX tag update | gate / P-1..P-5 | T-701 | — | done |

Coverage note: REQ-021 (error taxonomy) is verified via AC-12 export-fallback unit tests (T-601) and E2E forced-failure journey (T-701). REQ-019 via AC-14 (T-601/T-701).
