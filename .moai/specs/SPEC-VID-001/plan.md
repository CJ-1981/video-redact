# Implementation Plan: SPEC-VID-001 — Client-Side Video Redaction Web App

Methodology: **TDD** (quality.yaml `constitution.development_mode: tdd`, RED-GREEN-REFACTOR). Tier **L**.

## A. Context

Greenfield project; standalone SPEC (no Epic). Deliverable: one self-contained `index.html` (single-file app per user directive), developed as local ES modules merged by a dev-time inliner (see §D1). Product intent and UI direction: `design-direction.md`. Verified technical facts: `research.md`.

## B. Technology Stack (pinned)

| Concern | Choice | Version | License | Source (runtime CDN) |
|---|---|---|---|---|
| Demux/decode/encode/mux orchestration | mediabunny | **1.63.0** | MPL-2.0 | `https://cdn.jsdelivr.net/npm/mediabunny@1.63.0/dist/bundles/mediabunny.min.mjs` |
| ProRes decode extension (iPhone Pro `.mov`) | @mediabunny/prores | exact pin locked in M1 task 1 alongside mediabunny | MPL-2.0 | jsDelivr `/+esm` (URL pinned with the version) |
| ML inference runtime | onnxruntime-web | **1.31.1** | MIT | `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.all.bundle.min.mjs` + `ort.env.wasm.wasmPaths` pointing at the same-version `/dist/` |
| Face detection model | YuNet `face_detection_yunet_2023mar.onnx` | 2023mar (232,589 B) | MIT | `https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx` |
| Plate detection model | `yolo-v9-t-640-license-plates-end2end.onnx` | current release asset (7,835,770 B) | MIT (repo) | `https://github.com/ankandrew/open-image-models/releases/download/assets/yolo-v9-t-640-license-plates-end2end.onnx` |
| Tracker | hand-rolled IoU + Kalman (~200 LOC) | — | — | no maintained ByteTrack npm port exists |
| Unit test | vitest (+ fake-indexeddb) | latest stable | MIT | devDependency |
| E2E test | Playwright (Chromium) | latest stable | Apache-2.0 | devDependency |
| App UI | vanilla DOM + CSS, no framework | — | — | keeps the inliner trivial (no transpile) |
| Language | plain ES modules + JSDoc types | — | — | no transpile step; inliner only inlines |

Model attribution (names, licenses, source URLs) is displayed in the UI per license notice requirements.

## C. Source Layout (dev) → Single-File Distribution

```
index.html            # importmap + app shell markup; dev mode loads src/*.js
src/
  main.js             # app state machine (Check → Analyze → Review → Export), wiring
  capability.js       # REQ-002/003/004: secure-context, decode/encode probes, report model
  ingest.js           # REQ-001: file open, mediabunny Input, metadata + rotation
  models.js           # REQ-011: model registry (URLs, versions, licenses), fetch + IndexedDB cache
  detector.js         # REQ-005/008/010: ORT sessions, letterbox preprocess, YuNet decode+NMS, plate postprocess, tiled pass, EP fallback
  tracker.js          # REQ-006/007: IoU+Kalman tracking, interpolation, ±padding, track IDs/colors
  redact.js           # REQ-016: pixelate region rendering, box dilation, overlay drawing
  editor.js           # REQ-012/013/014/015: preview canvas, overlay, timeline chips, toggle, manual boxes
  exporter.js         # REQ-017/018/019/021: burn-in conversion, StreamTarget→OPFS, progress/cancel, WebM fallback, cleanup
tools/inline.mjs      # dev-time inliner: index.html + src/*.js → dist/index.html (single file)
tests/unit/*.test.js  # vitest, node environment
tests/e2e/*.spec.js   # Playwright smoke + synthetic-clip journey
dist/index.html       # build artifact (the shipped single file)
```

## D. Key Technical Decisions (full rationale in design.md ADRs)

1. **Dev modules + dev-time inliner** (ADR-1): logic lives in importable `src/*.js` so vitest can unit-test it (TDD requirement); `tools/inline.mjs` merges everything into `dist/index.html`. The *shipped app* is a single file with no build step at runtime.
2. **Mediabunny over mp4box.js + muxer glue** (ADR-2): one library covers .mov/QuickTime + HEVC demux, WebCodecs orchestration, MP4 mux, per-frame `video.process` for burn-in, audio packet-copy.
3. **Analysis reads frames via `VideoSampleSink`, keyframed by seconds** (ADR-3): robust to variable frame rate; tracks store timestamp-seconds, not frame indices.
4. **Review playback uses a `<video>` element + overlay canvas** (ADR-4): smooth scrubbing; boxes resolved per current time from the track map.
5. **WebGPU only off WebKit** (ADR-5): ort-web WebGPU EP is broken on WebKit 26 (ort#26827); engine-sniff → WASM EP on Safari.
6. **Pixelate is the only style** (ADR-6, user decision): deterministic, portable, strongest safety story; burned into pixels before encode.
7. **Export H.264/MP4 primary, VP9/WebM automatic fallback** (ADR-7); audio always packet-copied — output container selected to host the source audio codec (AAC→MP4, Opus/Vorbis→WebM); no audio re-encode path exists.
8. **Model cache in IndexedDB, bytes → `InferenceSession.create(ArrayBuffer)`** (ADR-8); `navigator.storage.persist()` requested; first-load ≈ 8 MB models + ~28 MB (WebGPU path) / ~15 MB (WASM path) runtime.
9. **Coordinates in display-oriented native pixels** (ADR-9): Mediabunny applies rotation; all boxes stored in rotated display space; letterbox transform maps to/from 640×640 model space.

## E. Milestones & Task Decomposition

### M1 — Shell, Capability Gate, Ingest (REQ-001…004, REQ-020)
1. Project scaffold: `index.html`, importmap, `tools/inline.mjs`, vitest + Playwright config, `npm` scripts (`dev`, `test`, `test:e2e`, `build`).
2. `capability.js` TDD: secure-context detection; decode/encode probe wrappers (mockable WebCodecs/Mediabunny seams); capability report model.
3. `ingest.js` TDD: metadata extraction (codec, resolution, fps, duration, rotation) from a fixture media file; ProRes `.mov` decode path via `@mediabunny/prores`; unsupported-codec error taxonomy.
4. UI: drop zone, capability report panel, serve-over-localhost gate screen.

### M2 — Model Runtime & Detection (REQ-005, REQ-008, REQ-010, REQ-011)
5. `models.js` TDD: registry (URL/version/license), fetch-with-progress, IndexedDB cache round-trip (fake-indexeddb), offline hit path.
6. `detector.js` TDD (pure parts): letterbox/un-letterbox transforms; YuNet raw-tensor decode (anchor grid, `sigmoid(cls·obj)`, distance2bbox) against recorded fixture tensors; NMS; plate end-to-end row parsing; tile grid geometry + merge-back.
7. Session management: EP selection (engine sniff + `['webgpu','wasm']` fallback), creation failure retry — integration-tested in Playwright (real ORT in Chromium).

### M3 — Tracking (REQ-006, REQ-007)
8. `tracker.js` TDD: IoU; Kalman predict/update; association (gated matching); track lifecycle (tentative → confirmed → closed); ID/label/color assignment; linear interpolation over gaps; ±padding extension; per-class tracks (face/plate/manual).

### M4 — Analyze Pass (REQ-009, ties M2+M3)
9. Frame iteration via `VideoSampleSink` (seconds-keyed), stride scheduling (faces every frame, plates every 2nd; adaptive stride on slow EPs), dashcam tiled second pass, progress model (count/fps/ETA), cancellation token, memory discipline (`sample.close()`).

### M5 — Review Editor (REQ-012…016)
10. `redact.js` TDD: dilation math (15%, clamp); pixelate renderer (downscale/upside-down factor policy, minimum block size) as pure geometry + canvas impl.
11. `editor.js`: `<video>` playback + overlay canvas (boxes, labels, colors), timeline chips model (TDD: ranges, hit-testing, toggling), manual box drawing (pointer events), keyboard controls, pixel-truthful preview.

### M6 — Export (REQ-017…019, REQ-021)
12. `exporter.js`: Mediabunny `Conversion` with `video.process` burn-in (active tracks by time), `StreamTarget` → OPFS (chunked), save-picker/download delivery, progress + cancel + temp cleanup; codec fallback ladder (avc → vp9/WebM; software-encode retry); error taxonomy → REQ-021 messages.

### M7 — Hardening & Gates
13. Playwright journeys: synthetic-clip end-to-end (fixture generated in-test or committed tiny MP4/WebM with synthetic face/plate patches), toggle journey, export journey asserting pixelated output + audio presence.
14. `/moai gate` quality gate: lint, format, type-check (tsc JSDoc mode), tests; coverage ≥ 85% on `src/` logic modules (quality.yaml target).
15. `tools/inline.mjs` output verification: `dist/index.html` boots over `python3 -m http.server` and passes the E2E smoke (single-file artifact is what ships).

## F. Test Strategy

- **Unit (vitest, node)**: all pure logic — transforms, tensor decode, NMS, IoU/Kalman, interpolation/padding, timeline model, dilation/pixelate geometry, capability report model, model-cache (fake-indexeddb). No GPU/browser needed.
- **Integration (Playwright, Chromium)**: real mediabunny + ORT against committed tiny fixtures (H.264 MP4 with synthetic face patch, WebM variant); capability panel; analyze → tracks appear; export → output decoded again in-test and asserted: redacted region pixel variance ≈ 0 at block granularity, audio track present, duration ≈ source.
- **Manual/perf (acceptance.md gates)**: 4K HEVC on reference hardware; memory bounded during 1 GB+ export.
- **Coverage**: ≥ 85% lines on `src/*.js` excluding `main.js` UI wiring (vitest coverage provider v8).

## G. Risk Register & Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | HEVC decode unavailable (Chrome HW-only) on user machines | High | Blocked files | REQ-002/003 capability gate + guidance; test matrix includes H.264 path |
| R2 | Safari: WASM-only EP slow; no `showSaveFilePicker`; `ctx.filter` gap | Medium | Degraded UX | WASM-first on WebKit; OPFS staging; pixelate-only style (user decision) removes filter hazard |
| R3 | ORT CDN init fragility (wasmPaths/version mismatch) | Medium | Boot failure | Pin 1.31.1 everywhere; same-version wasmPaths; E2E boots real CDN pair; documented local-mirror fallback |
| R4 | Missed detections → unblurred leak frame | Medium | Privacy failure | REQ-007 padding+dilation is AC-05 (blocking); dashcam mode for small objects; manual boxes |
| R5 | 4K memory pressure / frame leak | Medium | Tab crash | Sequential frames, `close()` discipline, StreamTarget export; perf gate AC-14 |
| R6 | open-image-models per-weights license unverified | Low | License exposure | Repo MIT; attribution shown; swap-in alternative identified; revisit before public distribution |
| R7 | Mediabunny youth (single maintainer) | Low-Med | Pipeline rework | Pin 1.63.0; pipeline isolated behind `ingest/exporter` seams; fallback documented (deprecated mp4-muxer/webm-muxer pair) |
| R8 | HDR/DV tone shift on export | High (for HDR input) | Quality complaint | Documented exclusion + UI warning at capability step |
| R9 | `isConfigSupported` true but runtime encode fails | Medium | Export failure | REQ-021 fallback ladder (software retry → WebM) + readable errors |
| R10 | `file://` usage attempt | High | Broken storage | REQ-004 secure-context gate with copy-paste serve commands |

## H. MX Tag Plan (Phase 14 — greenfield, lightweight)

- `@MX:ANCHOR` — `tracker.js` (track association, highest fan-in), `detector.js` tensor decode functions (correctness-critical, fixture-tested), `redact.js` apply path (privacy invariant).
- `@MX:WARN` — `exporter.js` frame loop (`VideoFrame`/`VideoSample.close()` leak hazard), `detector.js` EP fallback ordering, `models.js` cache-key versioning (stale-model hazard).
- `@MX:NOTE` — pinned-version coupling (ort bundle ↔ wasmPaths), `hvc1` codec-string requirement, 640 letterbox constants, model URLs + licenses, pixelate minimum-block-size rule.

## I. Verification Commands

```
npm run test        # vitest unit
npm run test:e2e    # playwright integration/smoke
npm run gate        # lint + format + type-check + tests (pre-commit gate)
npm run build       # tools/inline.mjs → dist/index.html, then smoke it
```
