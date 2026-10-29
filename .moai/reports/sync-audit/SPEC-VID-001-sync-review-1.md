# Sync Audit: SPEC-VID-001 — review-1

- auditor: sync-auditor (independent; docs author identity distinct)
- date: 2026-10-29
- scope: README.md, CHANGELOG.md, docs/README.md + docs/screenshots/*.png, .moai/project/{product,structure,tech}.md, .moai/project/codemaps/{pipeline,modules,state}.md, spec.md status transition, sync-phase gate
- method: every claim re-verified against the repository (package.json, src/, tests/, tools/, index.html, dist/, git history); `npm run gate` and `npm run test:coverage` re-executed by the auditor. No files modified.

## Check 1 — Factual accuracy (26 claims verified)

All claims sampled across README/CHANGELOG/tech.md/product.md are supported by the repo:

| # | Claim (doc:line) | Repo evidence | Result |
| --- | --- | --- | --- |
| 1 | Version 1.0.0, single source of truth in package.json (README.md:78) | package.json:3 `"version": "1.0.0"` | OK |
| 2 | Node >= 20 (README.md:20) | package.json:8 engines | OK |
| 3 | mediabunny 1.63.0 importmap pin (tech.md:7) | index.html:29 exact pin | OK |
| 4 | onnxruntime-web 1.31.1, same-version WASM root (tech.md:9) | index.html:30; src/detector.js:89 `ORT_VERSION = '1.31.1'` | OK |
| 5 | @mediabunny/prores 1.63.0, raw jsDelivr dist bundle (tech.md:8) | package.json:34; src/ingest.js:37-38 | OK |
| 6 | YuNet `face_detection_yunet_2023mar.onnx`, 232,589 B, MIT, HF opencv (tech.md:34) | src/models.js:54-64 | OK |
| 7 | Plate model 7,835,770 B; upstream ankandrew/open-image-models; HF mirror `wide-video/open-image-models-v0.5.1` CORS rationale (tech.md:35) | src/models.js:65-84 | OK |
| 8 | IndexedDB db `video-redact-models`, store `models`, key `model@version` (README.md:44, tech.md:37) | src/models.js:88-101 | OK |
| 9 | ~8 MB of weights (README.md:44) | 232,589 + 7,835,770 = 8,068,359 B ≈ 8 MB | OK |
| 10 | dist/index.html ~122 KiB (README.md:65, CHANGELOG.md:22, tech.md:41) | gate build output: 125,085 bytes = 122.2 KiB | OK |
| 11 | Footer badge `v1.0.0 · built 2026-10-29`; console echo; dev shows `dev build (unbuilt)` (README.md:78) | dist stamps `APP_VERSION = "1.0.0"`, `BUILD_DATE = "2026-10-29"`; src/main.js:214-219; badge visible in screenshot 01 | OK |
| 12 | 310 unit tests, 12 files (CHANGELOG.md:24,30; product.md:35; tech.md:45) | auditor re-run: `Tests 310 passed (310)`, 12 files | OK |
| 13 | Unit 303 → 310 (CHANGELOG.md:28) | progress.md:50 (303/11 files at run) + sync re-run 310/12; new tests/unit/version.test.js (7 tests) accounts for delta | OK |
| 14 | 6 Playwright E2E tests across 5 specs, smoke = 2 (CHANGELOG.md:24, tech.md:46) | static count: smoke 2, journey/auto-detect/offline-models/errors 1 each; tests/e2e = 5 specs + fixtures.js + geometry.js | OK |
| 15 | Coverage per module: analyze 85.5, capability 96.9, detector 99.4, exporter 100, ingest 95.7, models 94.2, redact 92, tracker 100; ≥ 85% gate on 8 logic modules (CHANGELOG.md:30) | auditor re-ran v8 coverage: 85.5 / 96.9 / 99.45 / 100 / 95.7 / 94.2 / 91.95 / 100 — all ≥ 85 (detector 99.45 vs "99.4" is rounding convention, not an error) | OK |
| 16 | Scripts dev/test/test:coverage/test:e2e/build/lint/typecheck/gate (README.md:61-68) | package.json:10-19 | OK |
| 17 | Dev server 127.0.0.1:8000, no-store (README.md:25,61) | tools/serve.mjs:29-30 | OK |
| 18 | YuNet 2023mar, 640×640 letterboxed, raw 0–255 BGR input, in-graph sigmoid (README.md:36, CHANGELOG.md:35) | src/detector.js:13,120,167; letterbox target=640 | OK |
| 19 | Face stride 1, plate stride 2 default (README.md —, modules.md:14, CHANGELOG.md:17) | src/analyze.js:34-35 `DEFAULT_PLATE_STRIDE = 2` | OK |
| 20 | Span padding ±5 frame periods (README.md:37, CHANGELOG.md:18) | src/analyze.js:79-80 (default 5/fps, REQ-007); src/tracker.js finalize | OK |
| 21 | Box dilation 15% (7.5% per side) (README.md:37) | src/redact.js:24 `dilate(box, factor = 0.15, frameSize)` | OK |
| 22 | Dense 1/30 s keyframe grid (CHANGELOG.md:18) | src/tracker.js:10 | OK |
| 23 | `numThreads = 1`, no COOP/COEP (tech.md:9) | src/detector.js:76,458 | OK |
| 24 | IngestError 5-code taxonomy; ExportError stages encode-avc/avc-software/vp9/mux/io/cancelled (modules.md:9,16) | src/ingest.js:11-16,61-63; src/exporter.js:61-62,87-89 | OK |
| 25 | Build fails on leaked `src/` reference; stamps version+date via esbuild define (README.md:72, tech.md:41) | tools/inline.mjs:44-45,68-70 | OK |
| 26 | E2E Chromium, serial workers=1, served by tools/serve.mjs (README.md:64, structure.md:12) | playwright.config.js:16,26 | OK |

No claim was found that the repo does not support.

**Result: PASS** (no CRITICAL/MAJOR/MINOR findings; one rounding note on item 15)

## Check 2 — Internal links

All relative links resolve to existing files:
- README.md:7,11 → docs/screenshots/0{1,2,3,4}-export/landing/capability/review.png (exist)
- README.md:78 → CHANGELOG.md (exists)
- docs/README.md:7-10 → screenshots/*.png (exist, correct relative depth from docs/)
- docs/README.md:12 → ../README.md (exists)
- codemaps (pipeline/modules/state.md): no markdown links; backtick path references (src/types.js, tests/unit/main-wiring.test.js, src/main.js) all exist.

External http(s) links (huggingface.co, github.com, localhost) are out of scope for the relative-link check; the two model URLs match src/models.js exactly.

**Result: PASS**

## Check 3 — Screenshots

- All 4 PNGs exist under docs/screenshots/ and are valid PNG (magic verified by `file`): 2560×1600 8-bit RGB = 1280×800 @2x as claimed (docs/README.md:3, structure.md:45, progress.md:62).
- Sizes: 01-landing 95,034 B; 02-capability 629,978 B; 03-review 593,787 B; 04-export 609,043 B — all > 30 KB.
- All referenced in README.md:7,11 with correct relative paths; captions visually verified against the images: 01 shows stepper at ① + drop zone + `v1.0.0 · built 2026-10-29` badge; 02 shows capability report with decode/encode probes, Inference row, Analyze enabled; 03 shows pixelated preview overlay, timeline chip, track list with toggle; 04 shows "Exported — download started (55.7 KB)" with all four stepper steps done.

**Result: PASS**

## Check 4 — CHANGELOG

- Keep-a-Changelog structure present: `# Changelog`, purpose paragraph, `## [Unreleased]`, `## [1.0.0] — 2026-10-29` with `### Added` and `### Fixed` (canonical categories) and semver statement. Note: `### Verification` (CHANGELOG.md:26) is an extra non-canonical section — acceptable as evidence documentation, noted as observation, no action required.
- Date 2026-10-29 confirmed (CHANGELOG.md:9); matches progress.md sync record and dist BUILD_DATE.
- Claims consistent with progress.md run record: 310/12-file unit suite and 303→310 progression (progress.md:50,66), 6/6 E2E (progress.md:50), per-module coverage table identical (progress.md:46), dist 125,085 bytes (progress.md:66).
- Fixed list (CHANGELOG.md:35-38) matches the four defects recorded in progress.md:45,48: YuNet 0–255 BGR + double-sigmoid scoring; plate model GitHub-release CORS → HF mirror; OPFS temp deletion vs blob download race; preview dilation parity via shared `redact.pixelateFrame`.

**Result: PASS** (1 observation: non-canonical "Verification" section — MINOR, informational)

## Check 5 — Status transition legality

- `git diff .moai/specs/SPEC-VID-001/spec.md` shows exactly one changed line: `status: planned` → `status: implemented`. BODY (HISTORY, sections 1–5) byte-identical to the committed plan-phase version.
- Frontmatter integrity: all 12 fields present in canonical order — id, title, version, status, created, updated, author, priority, phase, module, lifecycle, tags (spec.md:2-13). No legacy aliases (no `spec_id`/`created_at`/`name` variants).
- plan.md and acceptance.md: `git diff` empty — untouched since the plan-phase commit.
- spec-compact.md was also touched at sync (header status note) — documented in progress.md:63, outside this check's legality scope.

**Result: PASS**

## Check 6 — Codemaps accuracy

- **modules.md exports vs src/*.js** — verified beyond the 8-module spot-check minimum, all 11 modules: types.js (`export {}` only), capability.js (4/4), ingest.js (6/6 incl. PRORES_MODULE_URL + full IngestError union), models.js (9/9 incl. MODEL_DB_NAME/MODEL_STORE literals), detector.js (11/11 incl. ORT_WASM_PATHS), tracker.js (5/5), redact.js (5/5, dilate default 0.15 confirmed), analyze.js (runAnalyze), editor.js (9/9 incl. MIN_MANUAL_SPAN_S), exporter.js (4/4 incl. `export { pixelateFrame }` at exporter.js:126), main.js (13/13). Dependency arrows verified against actual imports (editor.js:55 ← redact; analyze.js:26-28 ← mediabunny/detector/tracker; exporter.js:39-50; main.js:26-31). No discrepancy.
- **state.md vs src/main.js** — `STEP_TRANSITIONS` (main.js:80-106) matches the state.md table exactly: 13 legal transitions, unlisted pairs → null via deriveStep (main.js:117-119). Stepper current/done table matches STEPPER_CURRENT/STEPPER_DONE (main.js:122-137). Cancellation convention matches code (ANALYZE_FINISH carries `cancelled`; EXPORT_FAIL + cancelled marker at main.js:1002). AppState data shapes match src/types.js:54-55,102-107.
- **MINOR — stale test count**: state.md:3 states "(16 unit tests in `main-wiring.test.js` cover the transition table)". The file actually contains 22 tests; the deriveStep describe block has 3 tests that walk the full transition table (tests/unit/main-wiring.test.js:47-90). The "16" figure appears carried from progress.md:44 ("deriveStep state machine reducer (16 tests)") and does not match the current test file. No functional impact; recommend "3 table-walking tests in main-wiring.test.js (22 total)" or dropping the count.
- **pipeline.md** — stage order ingest → capability → analyze (detectFace → detectPlate → Tracker; models feed ORT) → review (editor+redact) → export (Conversion process burn-in → OPFS staging → delivery → temp cleanup) matches main.js wiring order (main.js:723-745 analyze path, 954-1021 export path) and module imports. Shared `redact.pixelateFrame` seam claim verified at both call sites (editor.js:55, exporter.js:50) — AC-04 pixel-truthful preview. CDN arrows match importmap pins.

**Result: PASS** (1 MINOR: state.md:3 test-count figure)

## Check 7 — Sync-phase gate

- `npm run gate` executed by the auditor: exit 0 in ~40 s (< 300 s budget). Stages: eslint clean (0 errors), `tsc --noEmit` clean (0 errors), vitest 310/310 in 12 files, build OK.
- Build output: `dist/index.html written: 122.2 KiB (125085 bytes)`; grep confirms `APP_VERSION = "1.0.0"` and `BUILD_DATE = "2026-10-29"` stamped in dist — the 1.0.0 stamp requirement is met.
- Supplemental: `npm run test:coverage` exit 0; all 8 logic modules ≥ 85% lines (see Check 1 item 15).

**Result: PASS**

## Findings summary

| Severity | Location | Finding |
| --- | --- | --- |
| MINOR | .moai/project/codemaps/state.md:3 | "16 unit tests in main-wiring.test.js cover the transition table" — file has 22 tests, 3 of which walk the transition table; figure carried stale from progress.md:44 |
| MINOR (observation) | CHANGELOG.md:26 | "### Verification" is not a canonical Keep-a-Changelog category (extra evidence section; consistent with progress.md; no change required) |
| NOTE | CHANGELOG.md:30 | detector coverage "99.4" vs computed 99.45% (182/183) — rounding convention, within tolerance |

No CRITICAL or MAJOR findings. All factual claims sampled are supported by the repository; links resolve; screenshots are genuine dist captures matching captions; the spec transition is legal (body untouched, 12-field frontmatter intact, plan/acceptance untouched); the gate is green with the 1.0.0 stamp present.

Verdict: PASS
