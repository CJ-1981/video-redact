# Codemap: Modules (exports + dependencies)

Per `src/*.js` module headers (contracts) — verified against actual exports (grep `^export`).

| Module | Key exports | Depends on |
| --- | --- | --- |
| `types.js` | (no runtime exports) JSDoc typedefs: `Box`, `Detection`, `Track` (incl. `style: 'pixelate'\|'solid'`, REQ-101), `MediaMeta`, `CapabilityReport`, `AppState` (settings incl. `confFace`/`confPlate`, REQ-113) | — |
| `capability.js` | `secureContextInfo()`, `sniffEngine(ua)` → 'webkit'\|'chromium', `probeCapabilities(input, opts)` → `CapabilityReport`, `guidance(report)` → `{canAnalyze, canExport, messages}` | mediabunny (duck-typed input only), WebCodecs via `globalThis` seam |
| `ingest.js` | `PRORES_MODULE_URL`, `IngestError` (`unsupported-container`\|`no-video-track`\|`undecodable-track`\|`prores-without-extension`\|`corrupt`), `ensureProresDecoder()`, `containerTag()`, `metaFromTracks()`, `openInput(file)` → `{input, meta}` | mediabunny (+ `@mediabunny/prores` via dynamic import) |
| `models.js` | `MODELS` registry, `MODEL_DB_NAME`, `MODEL_STORE`, `ModelError`, `modelCacheKey()`, `ensureModel(name, onProgress)` → ArrayBuffer, `clearModelCache(name?)` (whole store when name omitted), `setModelDeps()`/`resetModelDeps()` | IndexedDB, fetch (both seamed for tests) |
| `detector.js` | `ORT_WASM_PATHS`, `DEFAULT_CONF_FACE` (0.6) / `DEFAULT_CONF_PLATE` (0.25) (REQ-113), `nms()`, `letterboxGeometry()`, `letterbox()`/`unletterbox()`, `unletterboxCoord()`/`unletterboxBox()`, `frameToTensor()`, `decodeYunetOutputs(outputs, shapes, t, opts)` / `parsePlateRows(rows, dims, t, opts)` (opts.confThreshold), `tileGrid(frameSize, target)` (dominant-axis: columns for aspect ≥ 1, stacked rows for aspect < 1 — REQ-107), `mergeTiles()`, `createDetectors(opts)` → `{detectFace, detectPlate, detectFaceRaw, detectPlateRaw, close, effectiveEp}` (raw accessors return undecoded outputs — REQ-114) | onnxruntime-web (lazy `import()`), models.js |
| `tracker.js` | `TRACK_COLORS` (8-slot palette; manual tracks take slots too — REQ-109), `KalmanCV`, `iou()`, `interpolate()`, `Tracker` (`update(detections, t)`, `finalize(padSeconds)` → `Track[]`; sets `style` defaults: pixelate auto / solid manual) | — (pure logic) |
| `redact.js` | `dilate(box, factor=0.15, frameSize)`, `tracksAt(tracks, t)` (throws on density-invariant violation), `applyPixelation()`, `applySolid()` (REQ-101), `drawOverlay()`, `pixelateFrame(ctx, tracks, t, frameSize, opts)` (per-track style dispatch) | — (canvas 2D; lazy scratch canvas) |
| `analyze.js` | `runAnalyze({...})` → `{tracks}` with progress + AbortSignal cancel; face stride 1, plate stride 2 (default), dashcam tiled pass, `settings.confFace`/`confPlate` gate EVERY detect call (REQ-113); `sampleFrameAt(input, t, maxSize, seams)` → single-frame decode for the threshold compare (REQ-114) | mediabunny (`VideoSampleSink`), detector.js, tracker.js |
| `editor.js` | `MIN_TRACK_SPAN_S` (0.1), `CHIP_EDGE_PX` (6) / `CHIP_EDGE_PX_COARSE` (14) + `effectiveEdgePx(coarse)` (REQ-112), `CLICK_SEEK_MAX_DRAG_PX` (8), `renderTimeline()`, `hitTestTimeline(x, y, width, tracks, durationSec, edgePx)` (outward edge zones — REQ-110), `timelineTimeAt(x, width, durationSec)` (chips-layer rect mapping, v1.6.1), `timelinePointerAction(...)` (tap/trim gesture classification, v1.6.2), scrub thumb (v1.7.0–1.9.0): `thumbLeftPct()`, `thumbAriaValue()`, `THUMB_PIN_EPSILON_S` (0.05) / `THUMB_PIN_MS` (350) / `thumbPinSettled()`, `toggleTrack()`, `trimTrack(tracks, trackId, start, end, durationSec)` (REQ-103/108), `setTrackStyle()` (REQ-101), `parseClockInput(str, durationSec)` / `formatSpan(start, end)` (REQ-108), `tracksAtForView()`, `manualTrackFromBox(...)` (full-span default, palette color — REQ-103/109), `scaleTracksToCanvas()`, `beginManualBox()`, `mountEditor(els, hooks)` (incl. `onStepFrame` hook, v1.7.0) | redact.js (`tracksAt`, `pixelateFrame`, `drawOverlay`), tracker.js (`TRACK_COLORS`) |
| `exporter.js` | `ExportError` (`stage`: encode-avc\|encode-avc-software\|encode-vp9\|mux\|io\|cancelled), `runExport(opts)`, `discardExportTemp(opfsPath)`, re-exports `pixelateFrame` | mediabunny (`Conversion`, outputs, `canEncodeVideo`), redact.js |
| `main.js` | `deriveStep(step, event)` (incl. `CLEAR` → gate from EVERY step, v1.6.0; export gated to review/done — null at ready), `stepperModel(step)`, `formatBytes()`/`formatEta()`/`formatClock()`, `formatVersionBadge()`, `mapExportErrorToMessage()`, `describeIngestFailure()`, `renderProbeRows()`, `metaSummaryRows()`, `inferenceRow()`, `epLabel()`; stage resize (v1.2.0/1.3.1/1.6.1): `DEFAULT_STAGE_HEIGHT_PX`, `STAGE_MIN_HEIGHT_PX`, `STAGE_HEIGHT_STEP_PX`, `clampStageHeight()`, `nextStageHeight()`, `dragStageHeight()`; transport/overlay (v1.4.0): `OVERLAY_HIDE_MS`, `transportGlyph()`, `normalizePlaybackRate()`; mute (v1.8.0): `muteGlyph()` + shared `toggleMute()` (internal); threshold compare (v1.5.0): `THRESHOLD_LEVELS`, `THRESHOLD_FACE_RANGE`, `THRESHOLD_PLATE_RANGE`, `THRESHOLD_PANEL_FRACTION`, `buildThresholdPanels()`, `formatThresholdCaption()`, `applyThresholdLevel()`; clear (v1.6.0): `DEFAULT_SETTINGS()`, `fileInputNeedsReset()`; keyboard gating (v1.6.1): `SHORTCUT_TYPING_SELECTOR`, `shortcutEnabledFor()`; diag (v1.8.2/1.9.0): `DIAG_KEY_ORDER`, `parseDebugFlag()`, `formatDiagLine()`, `focusLabel()`; editor resilience (v1.9.0/1.10.0): `mountEditorSafe()`, `mergeManualTracks()` (manual-keep merge on analyze completion), internal `mountEditorLive()` (mounts at READY); `mountApp()` | capability.js, models.js, editor.js, ingest.js, analyze.js, exporter.js (all) |

## Dependency arrows (module level)

```
types.js ◀ (referenced by every module's JSDoc)

capability.js ──┐
ingest.js ──────┤
models.js ──▶ detector.js ──▶ analyze.js ──▶ main.js
tracker.js ────────────────▶ analyze.js ──┤   (stepper owns AppState;
tracker.js ──▶ editor.js                  │    wires all events)
redact.js ──▶ editor.js ─────────────────┤
redact.js ──▶ exporter.js ───────────────┤
editor.js ──▶ main.js                    │
models.js ──▶ main.js                    │
capability.js / ingest.js ───────────────┘

CDN runtime imports (importmap-pinned, NOT bundled):
  ingest.js / analyze.js / exporter.js ──▶ mediabunny@1.63.0
  detector.js (lazy) ──▶ onnxruntime-web@1.31.1 (+ wasm assets, same pin)
  ingest.js (lazy) ──▶ @mediabunny/prores@1.63.0 (raw dist bundle — see PRORES_MODULE_URL note)
```

Cycle-free. The shared privacy seam: `redact.pixelateFrame` is consumed by both `editor.js` (preview) and `exporter.js` (burn-in) — one redaction implementation, dispatching per-track `pixelate`/`solid` styles (REQ-101/102).
