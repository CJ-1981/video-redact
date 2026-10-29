# Structure: Video Redact (SPEC-VID-001)

Module responsibilities follow `src/` contracts (design.md §3). Codemaps: `codemaps/pipeline.md`, `codemaps/modules.md`, `codemaps/state.md`.

```
video-redact/
├── index.html                  # Dev shell: CSP, pinned importmap (mediabunny 1.63.0, onnxruntime-web 1.31.1), dark editor UI, serve gate
├── package.json                # Pinned scripts + deps; version 1.6.0 is the build-stamp source of truth
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
│   ├── redact.js               # REQ-016 + 101/102: dilate, tracksAt, applyPixelation, applySolid, drawOverlay, pixelateFrame (shared preview/export seam, per-track style dispatch)
│   ├── analyze.js              # REQ-009 + 113/114: runAnalyze loop (VideoSampleSink, face/plate strides, configurable conf, dashcam tiles, progress, cancel), sampleFrameAt single-frame decode
│   ├── editor.js               # REQ-012..015 + 101/103/108/109/110: pure timeline model (render/hitTest/toggle/trim/style/clock inputs) + thin DOM adapters (mountEditor)
│   ├── exporter.js             # REQ-017..019/021: runExport burn-in via mediabunny Conversion, codec ladder, OPFS staging, temp cleanup
│   ├── main.js                 # M5 + SPEC-VID-002 wiring: deriveStep state machine (incl. CLEAR), transport/overlay/fullscreen/stage-resize/threshold-compare/clear wiring, formatters, error mapping, version badge, mountApp
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
│   └── debug-clear.mjs         # v1.6.0 clear-all probe: teardown, generation counter, OPFS temp sweep, input reset
├── tests/
│   ├── unit/                   # 14 vitest files, 469 tests (pure logic + seams; node env)
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
    └── specs/SPEC-VID-002/     # Review UX amendments (v1.1.0–v1.5.0 REQ-101..114): spec.md, progress.md
```

Build outputs (`dist/`, `coverage/`, `test-results/`) are generated and gitignored.
