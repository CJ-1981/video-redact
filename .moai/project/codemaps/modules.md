# Codemap: Modules (exports + dependencies)

Per `src/*.js` module headers (contracts) — verified against actual exports.

| Module | Key exports | Depends on |
| --- | --- | --- |
| `types.js` | (no runtime exports) JSDoc typedefs: `Box`, `Detection`, `Track`, `MediaMeta`, `CapabilityReport`, `AppState` | — |
| `capability.js` | `secureContextInfo()`, `sniffEngine(ua)` → 'webkit'\|'chromium', `probeCapabilities(input, opts)` → `CapabilityReport`, `guidance(report)` → `{canAnalyze, canExport, messages}` | mediabunny (duck-typed input only), WebCodecs via `globalThis` seam |
| `ingest.js` | `PRORES_MODULE_URL`, `IngestError` (`unsupported-container`\|`no-video-track`\|`undecodable-track`\|`prores-without-extension`\|`corrupt`), `ensureProresDecoder()`, `containerTag()`, `metaFromTracks()`, `openInput(file)` → `{input, meta}` | mediabunny (+ `@mediabunny/prores` via dynamic import) |
| `models.js` | `MODELS` registry, `MODEL_DB_NAME`, `MODEL_STORE`, `ModelError`, `modelCacheKey()`, `ensureModel(name, onProgress)` → ArrayBuffer, `clearModelCache()`, `setModelDeps()`/`resetModelDeps()` | IndexedDB, fetch (both seamed for tests) |
| `detector.js` | `ORT_WASM_PATHS`, `letterboxGeometry()`, `letterbox()`/`unletterbox()`, `unletterboxBox()`, `frameToTensor()`, `decodeYunetOutputs()`, `parsePlateRows()`, `nms()`, `tileGrid()`, `mergeTiles()`, `createDetectors()` → `{detectFace, detectPlate, close}` | onnxruntime-web (lazy `import()`), models.js |
| `tracker.js` | `TRACK_COLORS` (8-slot palette), `KalmanCV`, `iou()`, `interpolate()`, `Tracker` (`update(detections, t)`, `finalize(padSeconds)` → `Track[]`) | — (pure logic) |
| `redact.js` | `dilate(box, factor=0.15, frameSize)`, `tracksAt(tracks, t)` (throws on density-invariant violation), `applyPixelation()`, `drawOverlay()`, `pixelateFrame(ctx, tracks, t, frameSize)` | — (canvas 2D; lazy scratch canvas) |
| `analyze.js` | `runAnalyze({...})` → `{tracks}` with progress + AbortSignal cancel; face stride 1, plate stride 2 (default), dashcam tiled pass | mediabunny (`VideoSampleSink`), detector.js, tracker.js |
| `editor.js` | `MIN_MANUAL_SPAN_S`, `renderTimeline()`, `hitTestTimeline()`, `toggleTrack()`, `tracksAtForView()`, `manualTrackFromBox()`, `scaleTracksToCanvas()`, `beginManualBox()`, `mountEditor(els, hooks)` | redact.js (`tracksAt`, `pixelateFrame`, `drawOverlay`) |
| `exporter.js` | `ExportError` (`stage`: encode-avc\|encode-avc-software\|encode-vp9\|mux\|io\|cancelled), `runExport(opts)`, `discardExportTemp(opfsPath)`, re-exports `pixelateFrame` | mediabunny (`Conversion`, outputs, `canEncodeVideo`), redact.js |
| `main.js` | `deriveStep(step, event)`, `stepperModel(step)`, `formatBytes()`/`formatEta()`/`formatClock()`, `formatVersionBadge()`, `mapExportErrorToMessage()`, `describeIngestFailure()`, `renderProbeRows()`, `metaSummaryRows()`, `inferenceRow()`, `epLabel()`, `mountApp()` | capability.js, models.js, editor.js, ingest.js, analyze.js, exporter.js (all) |

## Dependency arrows (module level)

```
types.js ◀ (referenced by every module's JSDoc)

capability.js ──┐
ingest.js ──────┤
models.js ──▶ detector.js ──▶ analyze.js ──▶ main.js
tracker.js ────────────────▶ analyze.js ──┤   (stepper owns AppState;
redact.js ──▶ editor.js ─────────────────┤    wires all events)
redact.js ──▶ exporter.js ───────────────┤
editor.js ──▶ main.js                    │
models.js ──▶ main.js                    │
capability.js / ingest.js ───────────────┘

CDN runtime imports (importmap-pinned, NOT bundled):
  ingest.js / analyze.js / exporter.js ──▶ mediabunny@1.63.0
  detector.js (lazy) ──▶ onnxruntime-web@1.31.1 (+ wasm assets, same pin)
  ingest.js (lazy) ──▶ @mediabunny/prores@1.63.0 (raw dist bundle — see PRORES_MODULE_URL note)
```

Cycle-free. The shared privacy seam: `redact.pixelateFrame` is consumed by both `editor.js` (preview) and `exporter.js` (burn-in) — one pixelation implementation.
