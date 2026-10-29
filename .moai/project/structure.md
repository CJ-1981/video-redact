# Structure: Video Redact (SPEC-VID-001)

Module responsibilities follow `src/` contracts (design.md §3). Codemaps: `codemaps/pipeline.md`, `codemaps/modules.md`, `codemaps/state.md`.

```
video-redact/
├── index.html                  # Dev shell: CSP, pinned importmap (mediabunny 1.63.0, onnxruntime-web 1.31.1), dark editor UI, serve gate
├── package.json                # Pinned scripts + deps; version 1.0.0 is the build-stamp source of truth
├── eslint.config.js            # Flat ESLint config (src + tools)
├── tsconfig.json               # tsc --noEmit checkJs over JSDoc types (src, tools; tests/dist excluded)
├── vitest.config.js            # Unit suite: node env, tests/unit/**; v8 coverage (>= 85% gate on logic modules)
├── playwright.config.js        # E2E: tests/e2e, Chromium, serial workers=1, serves via tools/serve.mjs
├── src/
│   ├── types.js                # Documentation-only JSDoc typedefs: Box, Detection, Track, MediaMeta, CapabilityReport, AppState
│   ├── capability.js           # REQ-002/003/004: secure-context info, engine sniff, decode/encode probes, guidance messages
│   ├── ingest.js               # REQ-001: openInput(file) -> { input, meta }; ProRes decoder registration; typed IngestError taxonomy
│   ├── models.js               # REQ-011: pinned MODELS registry, fetch-with-progress, IndexedDB byte cache (model@version)
│   ├── detector.js             # REQ-005/008/010: ORT sessions, letterbox, YuNet/plate decode, NMS, tile grid/merge, EP fallback
│   ├── tracker.js              # REQ-006/007: KalmanCV + gated IoU Tracker, interpolation, dense keyframes, span padding
│   ├── redact.js               # REQ-016: dilate, tracksAt, applyPixelation, drawOverlay, pixelateFrame (shared preview/export seam)
│   ├── analyze.js              # REQ-009: runAnalyze loop (VideoSampleSink, face/plate strides, dashcam tiles, progress, cancel)
│   ├── editor.js               # REQ-012..015: pure timeline model (render/hitTest/toggle/manual) + thin DOM adapters (mountEditor)
│   ├── exporter.js             # REQ-017..019/021: runExport burn-in via mediabunny Conversion, codec ladder, OPFS staging, temp cleanup
│   ├── main.js                 # M5: deriveStep state machine, DOM wiring, formatters, error mapping, version badge, mountApp
│   ├── ort-runtime.d.ts        # Ambient module declaration for the lazily imported 'onnxruntime-web'
│   └── build-env.d.ts          # Ambient declarations for __APP_VERSION__ / __BUILD_DATE__ build stamps
├── tools/
│   ├── serve.mjs               # Zero-dependency static server (127.0.0.1:8000, no-store) for dev + E2E
│   ├── inline.mjs              # ADR-1 single-file build: esbuild bundle -> dist/index.html, version/date stamp, leak check
│   ├── capture-docs.mjs        # Drives the real dist through the journey; captures docs/screenshots/*.png (1280x800@2x)
│   ├── make-fixture.mjs        # Generates E2E fixture clips (detectable.mp4, synthetic.mp4) in-browser via mediabunny
│   ├── fixture-page.html       # Page harness used by make-fixture.mjs (served origin for WebCodecs)
│   ├── debug-yunet.mjs         # Dev diagnosis of the YuNet detection path (input scale/score decode)
│   ├── debug-yunet.html        # Browser harness for debug-yunet.mjs
│   ├── debug-export.mjs        # Reproduces E2E export-ladder failures outside Playwright with console capture
│   └── probe-synthetic.mjs     # Temporary diagnosis of per-call detection counts in the dashcam analyze loop
├── tests/
│   ├── unit/                   # 12 vitest files, 310 tests (pure logic + seams; node env)
│   ├── e2e/                    # 5 Playwright specs + fixtures.js + geometry.js helpers (6 tests)
│   └── fixtures/               # detectable.mp4 (real detected face; provenance in fixture.json), synthetic.mp4
├── dist/
│   └── index.html              # THE shipped artifact: single self-contained file (importmap-pinned CDN deps)
├── docs/
│   ├── README.md               # Screenshot index
│   └── screenshots/            # 01-landing, 02-capability, 03-review, 04-export (.png, 1280x800@2x)
└── .moai/
    ├── project/                # This docs set: product.md, structure.md, tech.md, codemaps/
    └── specs/SPEC-VID-001/     # spec.md, spec-compact.md, acceptance.md, plan.md, design.md, research.md, design-direction.md, progress.md, tasks.md
```

Build outputs (`dist/`, `coverage/`, `test-results/`) are generated and gitignored.
