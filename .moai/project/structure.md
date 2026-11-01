# Structure: Video Redact (SPEC-VID-001)

Module responsibilities follow `src/` contracts (design.md §3). Codemaps: `codemaps/pipeline.md`, `codemaps/modules.md`, `codemaps/state.md`.

```
video-redact/
├── index.html                  # Dev shell: CSP, pinned importmap (mediabunny 1.63.0, onnxruntime-web 1.31.1), dark editor UI, serve gate
├── package.json                # Pinned scripts + deps; version 1.39.3 is the build-stamp source of truth
├── eslint.config.js            # Flat ESLint config (src + tools)
├── tsconfig.json               # tsc --noEmit checkJs over JSDoc types (src, tools; tests/dist excluded)
├── vitest.config.js            # Unit suite: node env, tests/unit/**; v8 coverage (>= 85% gate on logic modules)
├── playwright.config.js        # E2E: tests/e2e, Chromium, serial workers=1, serves via tools/serve.mjs
├── src/
│   ├── types.js                # Documentation-only JSDoc typedefs: Box, Detection, Track, MediaMeta, CapabilityReport, AppState
│   ├── capability.js           # REQ-002/003/004: secure-context info, engine sniff, decode/encode probes, guidance messages
│   ├── ingest.js               # REQ-001: openInput(file) -> { input, meta }; ProRes decoder registration; typed IngestError taxonomy
│   ├── models.js               # REQ-011: pinned MODELS registry, fetch-with-progress, IndexedDB byte cache (model@version)
│   ├── detector.js             # REQ-005/008/010 + 107/113: ORT sessions, letterbox, YuNet/plate decode, NMS, dominant-axis tile grid/merge, EP fallback, DEFAULT_CONF_FACE/PLATE
│   ├── tracker.js              # REQ-006/007 + 109: KalmanCV + gated IoU Tracker, interpolation, dense keyframes, span padding, TRACK_COLORS for auto AND manual tracks
│   ├── redact.js               # REQ-016 + 101/102/129: dilate, tracksAt, PIXEL_STRENGTHS/pixelStrengthMultiplier, applyPixelation, applySolid, drawOverlay, pixelateFrame (shared preview/export seam, per-track style dispatch, strength-scaled block size)
│   ├── analyze.js              # REQ-009 + 113/114/117/128 + 126-skip: runAnalyze loop (VideoSampleSink, face/plate strides, configurable conf, per-class detectFace/detectPlate toggles — false skips a model incl. tiles, min-size filter, downscale via scaleFactorFor, dashcam tiles, trims skipped via inTrims, progress, cancel), sampleFrameAt single-frame decode
│   ├── audio.js                # REQ-206: waveform peaks — decodeWaveform (AudioSampleSink single pass → packetPeak/binPeaks, per-file promise cache keyed "name:size", silent-degrade null), fired at FILE LOAD since v1.39.3
│   ├── editor.js               # REQ-012..015 + 101/103/108..110/125: pure timeline model (render/hitTest/toggle/trim/style/clock inputs, trimRegionViews overlays) + scrub thumb (thumbLeftPct/thumbAriaValue/thumbPinSettled, THUMB_PIN_*) + thin DOM adapters (mountEditor)
│   ├── exporter.js             # REQ-017..019/021/126: runExport burn-in via mediabunny Conversion, codec ladder, exportGeometry resolution scaling + scaleTracks, per-segment trim conversion + concat, OPFS staging, temp cleanup
│   ├── project.js              # REQ-130: .vrproj project save/load — PROJECT_FORMAT_VERSION, serializeProject, parseProject, validateVideoMatch (video re-association warnings)
│   ├── main.js                 # M5 + SPEC-VID-002 wiring: deriveStep state machine (incl. CLEAR), transport/overlay/fullscreen/keyboard (±5 s jump, F/M), stage/rail/intake resize, theme, file info, size filter, downscale, pixel strength, trim regions (normalizeTrims/addTrim/moveTrimEdge/removeTrim/trimsAt/keptSegments), threshold compare (settings-honoring), project save/load wiring, export choices (resetExportChoices on load/Clear only), mute toggle, keyboard gating (shortcutEnabledFor), per-class detector toggles (syncDetectToggles/enforceDetectorPair — v1.39.0/1.39.1), counter-separator paint (v1.39.2), waveform load-time decode trigger (v1.39.3), ?debug=1 diag (parseDebugFlag/formatDiagLine), mountEditorSafe + mountEditorLive + mergeManualTracks, adoptTracks/clampTracksToDuration, formatters, error mapping, version badge, mountApp
│   ├── ort-runtime.d.ts        # Ambient module declaration for the lazily imported 'onnxruntime-web'
│   └── build-env.d.ts          # Ambient declarations for __APP_VERSION__ / __BUILD_DATE__ build stamps
├── tools/
│   ├── serve.mjs               # Zero-dependency static server (127.0.0.1:8000, no-store) for dev + E2E
│   ├── inline.mjs              # ADR-1 single-file build: esbuild bundle -> dist/index.html, version/date stamp, leak check
│   ├── capture-docs.mjs        # Drives the real dist through the journey; captures docs/screenshots/*.png (1280x800@2x)
│   ├── make-fixture.mjs        # Generates E2E fixture clips (detectable.mp4, synthetic.mp4) in-browser via mediabunny
│   ├── fixture-page.html       # Page harness used by make-fixture.mjs (served origin for WebCodecs)
│   ├── probe-synthetic.mjs     # Temporary diagnosis: which detector call in the dashcam analyze loop fires on synthetic frames
│   ├── debug-yunet.mjs         # Dev diagnosis of the YuNet detection path (input scale/score decode)
│   ├── debug-yunet.html        # Browser harness for debug-yunet.mjs
│   ├── debug-export.mjs        # Reproduces E2E export-ladder failures outside Playwright with console capture
│   ├── debug-trim.mjs          # REQ-110 acceptance probe: chip-edge trim drag updates the rendered chip LIVE
│   ├── debug-mobile.mjs        # v1.4.0 REQ-111/112 probe: 390x844 viewport, overflow / touch targets / overlay controls
│   ├── debug-times-overflow.mjs# v1.4.1 element-level audit: track-row time fields inside the row content box
│   ├── debug-thresholds.mjs    # v1.5.0 REQ-113/114 probe: sensitivity sliders + threshold-compare panels
│   ├── debug-clear.mjs         # v1.6.0 clear-all probe: teardown, generation counter, OPFS temp sweep, input reset
│   ├── debug-regressions.mjs   # v1.6.1 field-regression probe: timeline seek accuracy, suppression latch, keyboard-after-click, footer/timeline clearance
│   ├── debug-touch-timeline.mjs# v1.6.2/1.7.0/1.8.1 touch probe: tap-to-seek, chip-edge touch trim, scrub-thumb drag, playback following
│   ├── debug-thumb-mouse.mjs   # v1.8.0 real-mouse probe: thumb drag/capture/overshoot, optional WITH_MUTE=1 mute checks
│   ├── debug-diag.mjs          # v1.8.2/1.9.0 ?debug=1 probe: diag line cadence, bundle identity, tu/vfc/error counters
│   ├── debug-freeze-repro.mjs  # Thumb-freeze field reproduction probe (v1.8.0/1.9.0 pin work)
│   ├── debug-freeze-emulated.mjs # v1.10.0 probe: FIRST-phase pre-analyze (READY) transport/scrub/keyboard/manual-box checks + post-analyze regression phases
│   ├── debug-plate.mjs         # Plate-detection diagnosis (YOLOv9-t path on real frames)
│   ├── debug-plate-e2e.mjs     # Plate detector E2E-style probe (full journey with plate assertions)
│   ├── debug-trim-export.mjs   # v1.15.x probe: trim-region export exclusion + kept-segment concat
│   ├── debug-mb-semantics.mjs  # mediabunny semantics probe (trim Conversion / concat behavior)
│   ├── debug-collapse-space.mjs# Collapsible-panels + Space-key interaction probe (v1.13.x)
│   ├── debug-strength-redraw.mjs # v1.38.1 probe: rVFC-dead emulation — strength/style clicks must redraw the paused canvas
│   └── debug-export-settings.mjs # v1.17.1 probe: real-browser proof that resolution/audio choices reach the exporter (720p + audio-off export)
├── tests/
│   ├── unit/                   # 16 vitest files, 913 tests (pure logic + seams; node env)
│   ├── e2e/                    # 5 Playwright specs + fixtures.js + geometry.js helpers (6 tests)
│   └── fixtures/               # detectable.mp4 (real detected face; provenance in fixture.json), synthetic.mp4
├── dist/
│   └── index.html              # THE shipped artifact: single self-contained file (importmap-pinned CDN deps)
├── docs/
│   ├── README.md               # Screenshot index
│   └── screenshots/            # 01-landing, 02-capability, 03-review, 04-export (.png, 1280x800@2x)
└── .moai/
    ├── project/                # This docs set: product.md, structure.md, tech.md, codemaps/
    ├── specs/SPEC-VID-001/     # Base app: spec.md, spec-compact.md, acceptance.md, plan.md, design.md, research.md, design-direction.md, progress.md, tasks.md
    └── specs/SPEC-VID-002/     # Review UX amendments (v1.1.0–v1.37.0 REQ-101..130): spec.md, progress.md
```

Build outputs (`dist/`, `coverage/`, `test-results/`) are generated and gitignored.
