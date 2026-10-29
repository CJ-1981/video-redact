# Tech Stack: Video Redact (SPEC-VID-001)

## Runtime (pinned)

| Dependency | Version | Source of pin | Role |
| --- | --- | --- | --- |
| mediabunny | 1.63.0 | index.html importmap → `cdn.jsdelivr.net/npm/mediabunny@1.63.0` | Demux/mux/convert: `Input`, `VideoSampleSink`, `Conversion`, `Mp4OutputFormat`, `WebMOutputFormat`, `StreamTarget`, `canEncodeVideo` |
| @mediabunny/prores | 1.63.0 | package.json dependency + `PRORES_MODULE_URL` (raw jsDelivr dist bundle) | Apple ProRes `.mov` decode (`registerProresDecoder`) |
| onnxruntime-web | 1.31.1 | index.html importmap → `ort.all.bundle.min.mjs`; WASM assets from the same-version jsDelivr root (`ORT_WASM_PATHS`) | ONNX inference (WebGPU → WASM EP ladder; `numThreads = 1`, no COOP/COEP needed) |
| WebCodecs | browser API | — | Capability probes (`isConfigSupported`) and the actual decode/encode |

Importmap pin coupling: the onnxruntime-web importmap pin and `ort.env.wasm.wasmPaths` must stay the same version — bundle/WASM mismatch is a boot failure (plan R3).

## Dev toolchain (package.json, pinned)

vitest 4.1.12 (+ @vitest/coverage-v8 4.1.12) · @playwright/test 1.64.1 · fake-indexeddb 6.2.6 · esbuild 0.28.2 · eslint ^9.39.2 (+ @eslint/js ^9.39.5) · typescript ^5.9.3 (checkJs over JSDoc — no TS source, ADR-1) · Node >= 20.

## Why (ADR summaries — full register in design.md §6)

- **ADR-1** Dev ES modules + `tools/inline.mjs` → single `dist/index.html`, instead of pure inline-only source (untestable by vitest) or a full bundler (heavier than needed).
- **ADR-2** mediabunny for all container work, instead of mp4box.js + muxer glue (demux-only, .mov flaky) or ffmpeg.wasm (no HW accel, memory ceiling).
- **ADR-3** Track keyframes keyed in seconds, not frame indices (frame keys break under VFR; sink timestamps are authoritative).
- **ADR-4** `<video>`-element playback for review, instead of CanvasSink re-decode (CPU cost, scrubbing complexity).
- **ADR-5** WebGPU EP only off WebKit (ort#26827 blowup on WebKit); WASM directly on Safari; WebGL EP rejected (deprecated).
- **ADR-6** Pixelate-only redaction: gaussian silently no-ops on Safari < 18 (a redaction failure), solid destroys context — user decision, safety-aligned.
- **ADR-7** Export avc/MP4 primary → avc software → vp9/WebM ladder; audio always packet-copied (no re-encode path: quality loss + AAC-encode gaps, e.g. Linux Chrome).
- **ADR-8** IndexedDB byte cache for models with `name@version` keys (30 MB re-download per session is unacceptable; Cache API gives less byte-level control).
- **ADR-9** Display-oriented (rotation-applied) coordinates everywhere after ingest — eliminates the portrait bug class at the boundary.

## Model registry (src/models.js `MODELS`)

| Key | Model file | Size (bytes, pinned integrity gate) | License | Source / mirror |
| --- | --- | --- | --- | --- |
| `yunet` | `face_detection_yunet_2023mar.onnx` | 232,589 | MIT | `huggingface.co/opencv/face_detection_yunet` (canonical) |
| `plate-yolov9t` | `yolo-v9-t-640-license-plates-end2end.onnx` | 7,835,770 | MIT (repo; per-weights license unverified — plan R6) | Upstream `github.com/ankandrew/open-image-models`; served from the HF mirror `huggingface.co/wide-video/open-image-models-v0.5.1` because GitHub release assets send no `access-control-allow-origin` on any redirect hop, so a browser `fetch()` can never read the canonical asset. The mirror serves the same bytes with CORS `*`. |

No upstream sha256 is published for either model — the pinned byte size is the only integrity gate (mismatch warns; ORT session creation rejects truly corrupt bytes). Cache: IndexedDB db `video-redact-models`, store `models`, key `${name}@${version}`; cache-first with deduped in-flight downloads.

## Build & versioning

`npm run build` → `tools/inline.mjs`: esbuild bundles `src/main.js` (ESM, no minify; `mediabunny`/`onnxruntime-web` stay external and resolve via the dist importmap), the dev `<script src>` tag is replaced with the inline bundle, `__APP_VERSION__` (from package.json) and `__BUILD_DATE__` (UTC date of build) are injected as literals, esbuild's per-module path comments are stripped, `</script>` is escaped, and the build FAILS if any `src/` reference leaks (single-file guarantee). Output: `dist/index.html` (~174 KiB). At runtime the version shows in the footer badge (`v1.6.0 · built 2026-10-29`) and console at boot; unbuilt dev mode shows `dev build (unbuilt)`.

## Design notes added since v1.0.0 (SPEC-VID-002 amendments, v1.1.0–v1.6.0)

- **Detection threshold config (REQ-113)** — face/plate confidence gates are user-configurable (`settings.confFace`/`confPlate`, Analyze-panel sliders, defaults `DEFAULT_CONF_FACE` 0.60 / `DEFAULT_CONF_PLATE` 0.25). The values ride every `detectFace`/`detectPlate` call of the analyze loop (full-frame AND tile passes) via per-call `opts.confThreshold`; detector decode functions take the threshold as an option, so no baked constants remain in the loop.
- **Single-frame threshold compare (REQ-114)** — one decode + ONE inference per model: `analyze.sampleFrameAt()` decodes a single frame through the analyze loop's seam; `createDetectors()` additionally returns raw accessors `detectFaceRaw`/`detectPlateRaw` that skip decoding and hand back the undecoded model outputs; `decodeYunetOutputs`/`parsePlateRows` re-decode that single inference at each of the five fixed levels (0.15–0.75). `main.buildThresholdPanels` turns counts into panels; clicking a panel applies the level to both sliders (`applyThresholdLevel`). N inferences for N levels would be ~5× the cost — this design keeps it at one.
- **Manual region model (REQ-103/108/109)** — a manual track is a sparse-keyframe Track (single box) spanning the FULL video duration by default, source `'manual'`, style `'solid'`, colored from the same `TRACK_COLORS[(id − 1) % 8]` palette as auto tracks (distinct per track; identity signalled by the "Manual #N" label + dashed chip outline, not color). Trimming goes through one path: chip-edge drag (±6 px zones, ±14 px on coarse pointers) or per-row clock inputs (`parseClockInput`) both call `editor.trimTrack` (min span 0.1 s), so preview, chips, row readout and export span move together.
- **CLEAR transition (v1.6.0)** — `STEP_TRANSITIONS` gains `CLEAR: 'gate'` legal from EVERY step; DOM-side `clearAll()` aborts in-flight analyze/export (generation counter drops stale callbacks), destroys the editor (cancels preview frame loops), revokes the preview blob URL, unloads the `<video>` (`src` removed + `load()`), disposes the mediabunny `Input`, sweeps leftover OPFS export temps (`exports/redact-export-*` — the REQ-019 hygiene on explicit clear), and resets the file input (`fileInputNeedsReset`) so re-selecting the SAME file re-fires `change`. Panels reset from one `DEFAULT_SETTINGS()` factory. Model cache, stage height and version badge survive.
- **Mobile layout (REQ-112)** — single CSS breakpoint `@media (max-width: 820px)`: right rail stacks below the timeline, ≥ 40 px touch targets, 48 vh default stage, header/stepper compression. Coarse-pointer hit zones: `editor.effectiveEdgePx` widens chip-edge grab zones 6 px → 14 px (`CHIP_EDGE_PX_COARSE`) so fingertip trims work.
- **Overlay controls + idle auto-hide (REQ-111)** — fullscreen/zoom modes render an in-stage control bar (`.stage-overlay-controls`, distinct ov-* ids) calling the SAME shared transport actions as the bottom bar (`togglePlay`/`stepFrame`/`setSpeed`/`exitPreview`). It hides after `OVERLAY_HIDE_MS` (3000 ms) without pointer/touch activity on the stage and re-shows on activity or mode enter.

## Test strategy

- **Unit (vitest, node env)** — 14 files, 469 tests. Pure logic is tested directly (tracker, redact geometry + style dispatch, timeline model incl. trim/style/clock parsing, detector decode math + tile geometry, capability guidance, models cache, exporter ladder, analyze loop + sampleFrameAt, main formatters/state machine incl. CLEAR + threshold panels, stage-resize helpers, mobile-UI breakpoint wiring, version stamp). Browser/CDN dependencies are seamed: duck-typed mediabunny inputs (capability), injectable WebCodecs/UA (capability), `setModelDeps` (fake-indexeddb + stubbed fetch), mocked `onnxruntime-web` import, injectable canvas factory/yield/clock (analyze). Coverage gate: ≥ 85% lines on the 8 logic modules (main.js/editor.js DOM wiring measured but gated via E2E).
- **E2E (Playwright, Chromium)** — 5 spec files, 6 tests, serial `workers: 1` with a shared worker-scoped context so the IndexedDB model cache and HTTP cache carry over (offline-models spec depends on that ordering). Specs: smoke (2), journey (in-page re-decode burn-in assertion + AAC preserved), auto-detect (real YuNet detection on `tests/fixtures/detectable.mp4`, provenance in `fixture.json`), offline-models, errors. Real network is used (CDN libs + model weights, ~40 MB first run — perf gate P-4).
- **Fixtures** — generated in-browser by `tools/make-fixture.mjs` using the same pinned mediabunny bundle.
- **Quality gate** — `npm run gate` = eslint + `tsc --noEmit` + vitest + build, all exit 0.
