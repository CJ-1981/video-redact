# Sync Audit — SPEC-VID-002 docs at v1.17.1 (review 2)

- Auditor: independent sync-auditor (adversarial re-verification; auditor did not author the docs)
- Date: 2026-10-31
- Scope: README.md, .moai/project/{product,structure,tech}.md, .moai/project/codemaps/{modules,state,pipeline}.md, .moai/specs/SPEC-VID-002/progress.md, docs/screenshots, CHANGELOG.md (read-only), verified against src/, tools/, tests/, git.

## Check 1 — Version/count consistency — PASS

- package.json `"version": "1.17.1"`; every live doc states 1.17.1 (README.md:15,18,104; product.md:36; structure.md:8,67; tech.md:41; state.md:44; progress.md:12).
- Test count: `npm run gate` vitest output — **"Test Files 15 passed (15) / Tests 765 passed (765)"** → 765/765 across 15 files confirmed (product.md:36, structure.md:56, tech.md:65, progress.md:12).
- E2E count (verified precisely per the previous audit's lesson): `npx playwright test --list` → **"Total: 6 tests in 5 files"**, matching the "6 E2E tests in 5 specs" claim in product.md:36, structure.md:57, progress.md:12. No stale "8 tests" claim anywhere.
- dist: `dist/index.html` = 287,589 bytes = 280.85 KiB → "~281 KiB (287,589 bytes at v1.17.1)" (tech.md:41) and README.md:91 "~281 KiB" both correct.
- Stale-version sweep (`grep 1.1[0-7].x` across README + .moai/project + progress.md): all v1.10–v1.17 mentions are historical attributions per feature/release ("v1.15.0–v1.15.2", "v1.11.0–v1.14.0", etc.) or the correct current version. No stale size/count/version claims found.
- CHANGELOG entry count: 30 release entries (1.17.1 → 1.0.0) + empty Unreleased — matches progress.md:12's "30 entries".

## Check 2 — Factual spot-checks vs source (24 claims verified) — PASS

modules.md exports (grep `^export` per module):
1. src/project.js — `PROJECT_FORMAT_VERSION = '1'` (:28), `serializeProject` (:45), `parseProject` (:107), `validateVideoMatch` (:198) — all 4 listed exports present, no missing ones.
2. src/redact.js — `PIXEL_STRENGTHS = {fine:1, normal:2, coarse:3, max:4}` (:101), `pixelStrengthMultiplier` default → normal ×2 (:111-114), `tracksAt`, `dilate`, `applyPixelation/applySolid/drawOverlay/pixelateFrame` — all present.
3. src/analyze.js — `inTrims` (:109), `filterByMinSize` (:115), `scaleFactorFor` (:76), `sampleFrameAt(input, t, maxSize=0, seams={})` (:420) — signatures match.
4. src/editor.js — `MIN_TRACK_SPAN_S` 0.1 (:160), `CHIP_EDGE_PX` 6 / `CHIP_EDGE_PX_COARSE` 14 (:167/174), `effectiveEdgePx` (:185), `CLICK_SEEK_MAX_DRAG_PX` 8 (:197), `THUMB_PIN_EPSILON_S` 0.05 / `THUMB_PIN_MS` 350 (:301/314), `trimRegionViews` (:429), `hitTestTimeline` (:484), `trimTrack`, `parseClockInput`, `mountEditor` — all present.
5. src/exporter.js — `ExportError` (:79), `exportGeometry(resolution, width, height)` → `{sf, outW, outH}` (:318-325, matches exactly), `scaleTracks(tracks, sf)` (:296), `runExport` (:928), `discardExportTemp` (:1074), re-export `pixelateFrame` (:148) — all present.
6. src/main.js — all listed exports verified incl. `SEEK_STEP_S = 5` (:775), `OVERLAY_HIDE_MS = 3000` (:768), rail widths 240/480/320/24 (:463-469), `SIZE_FILTER_VALUES [0,24,48,96]` (:660), `DOWNSCALE_VALUES` (:696), `THEME_STORAGE_KEY 'video-redact-theme'` (:542), `PIXEL_STRENGTH_VALUES`/`normalizePixelStrength`/`pixelStrengthPressed` (:725-753), THRESHOLD_* + `describeCompareContext` (:823-910), trims set `MIN_TRIM_SPAN_S 0.1`/`normalizeTrims`/`addTrim`/`moveTrimEdge`/`removeTrim`/`trimsAt`/`keptSegments` (:1327-1481), `adoptTracks`/`clampTracksToDuration`/`videoBaseName` (:1205-1271/1181), `mountEditorSafe`/`mergeManualTracks` (:1075/1112), `mountApp` (:1695).
7. types.js "no runtime exports" — `export {};` only (:15). Correct.

state.md vs src/main.js:
8. Keyboard map — doc-level handler (:2666-2692): `←`/`→` seek ∓/±`SEEK_STEP_S` (5 s, no shift), `Shift+←/→` frame-step ±1, `F` fullscreen/enlarge, `M` mute, `Space` play/pause, `B` manual-box hint; playback live at ready/review/done (:2670-2672). Matches state.md:42 and README.md:44 exactly.
9. Export settings flow (state.md:44) — `resetExportChoices()` is internal (:2095-2097, resolution→'full', audio→checked) and is called at exactly two sites: file load (:2353) and Clear (:2594); `startExport` reads live UI: `els.exportResolution` (:3417), `els.exportAudio` (:3418), `app.settings.pixelStrength` (:3426). v1.17.1 claim verified in code.
10. `pendingProject` lifecycle (state.md:78) — set by Load handler (:1863, :2411), cleared by Clear (:2573), applied on video open (:3511). Verified.

pipeline.md vs src/:
11. Analysis skips trims — src/analyze.js:284-288 `if (inTrims(sample.timestamp, settings?.trims)) { skippedCount += 1; ... }` (no draw/inference/tracking), skipped count reported (:377). Matches pipeline.md:24-26.
12. Trim concat export — src/exporter.js: per-kept-segment `Conversion` (`keptSegmentsOf` :530, `concatKeptSegments` :583) with packet timestamp shifting (:639-650), audio packet-copied per segment, progress split 0–0.85 segments / 0.85–1 concat (:500). Matches pipeline.md:89-94.
13. Export resolution locked burn-in — `exportGeometry` scales burn-in canvas dims, `scaleTracks(tracks, sf)` rescales keyframes; removeAudio → `{ audio: { discard: true } }` (:822, :998). Matches pipeline.md:84-88 and tech.md:58.
14. Pixel-strength seam — exporter process callback passes `strength` into `pixelateFrame` (:204); preview uses the same seam; `pixelStrengthMultiplier` fallback normal ×2. Matches pipeline.md:82-83/106.
15. Compare honors settings (REQ-128) — main.js compare path: `sampleFrameAt` (:3270), `scaleFactorFor(app.settings.downscale, ...)` (:3282), dashcam toggle read (:3281), min-size filter imported (:127). Matches pipeline.md:106.

structure.md vs repo:
16. tools/ list — structure.md:29-54 lists 26 entries; actual `tools/` contains exactly those 26 files (incl. all 6 previously-missing probes: debug-plate, debug-plate-e2e, debug-trim-export, debug-mb-semantics, debug-collapse-space, debug-export-settings). No extra, none missing.
17. Test layout — tests/unit: 15 files, exact names match claims; tests/e2e: 5 specs + fixtures.js + geometry.js; tests/fixtures: detectable.mp4, fixture.json, synthetic.mp4. All match structure.md:55-58.
18. main.js → project.js dependency edge — `import { parseProject, serializeProject, validateVideoMatch } from './project.js'` (main.js:136). Edge is real (see MINOR-1 for the "(all)" wording).

## Check 3 — README — PASS

- Local links: CHANGELOG.md, docs/screenshots/01..04 all resolve to existing files. External links verified live (HTTP 200): cj-1981.github.io/video-redact/, github.com/ankandrew/open-image-models, huggingface.co/opencv/face_detection_yunet.
- Screenshots: 4/4 exist, all 151-651 KB (>30 KB), all mtimes 2026-10-31 21:21–21:22 (today). Sizes byte-match progress.md's claim (154,886 / 666,361 / 641,680 / 220,223 B = 151.3 / 650.7 / 626.6 / 215.1 KiB). 01-landing.png visually inspected: footer badge reads **"v1.17.1 · built 2026-10-31"** — current version, current date. (Git shows only 01/03 content-modified; 02/04 were re-captured byte-identical — consistent with a same-day, same-build recapture; not a defect.)
- Version: 1.17.1 in intro bullet (:15), export bullet (:18), versioning section (:104). Correct.
- Feature bullets traceable to CHANGELOG: trims v1.15.0–v1.15.2 (:41 ↔ CHANGELOG 1.15.x), pixel strength v1.17.0 (:42 ↔ 1.17.0 Added), project save/load v1.17.0 (:43 ↔ 1.17.0), workspace wave v1.11.0–v1.14.0 (:44), export resolution/audio v1.16.0 + v1.17.1 persist fix (:18 ↔ 1.16.0 Added + 1.17.1 Fixed), Clear (:47), mobile (:45) — all traceable.
- Limitations section (:106-114): pixelate/solid-only styles, no OCR/recognition, audio whole-track only, HDR→SDR, one file per session, .vrproj without video bytes — all accurate against product.md exclusions and code (audio discard :822; no blur style anywhere in redact.js).

## Check 4 — CHANGELOG — PASS

- Ordering: strictly descending 1.17.1 → 1.0.0 (30 entries), single linear strand, no duplicates, no orphaned versions; empty `## [Unreleased]` at top.
- Git spot-check 1: `2ad7a0a` "fix: v1.17.1 — export resolution/audio settings wiped by the export click" ↔ CHANGELOG 1.17.1 entry (resetExportUi ran before settings were read; reset only on file load/Clear) — match.
- Git spot-check 2: `9b51496` "feat: v1.16.0 — export resolution selection + audio removal" ↔ CHANGELOG 1.16.0 Added (Full/1080p/720p + Include-audio checkbox) — match.

## Check 5 — Spec hygiene — PASS

- `git status --porcelain`: exactly 10 modified files — README.md, .moai/project/{product,structure,tech}.md, .moai/project/codemaps/{modules,state,pipeline}.md, .moai/specs/SPEC-VID-002/progress.md, docs/screenshots/01-landing.png, docs/screenshots/03-review.png. No unexpected files, no untracked debris, no source/tool changes.
- SPEC bodies untouched: `git diff --stat .moai/specs/SPEC-VID-002/` → only progress.md (+1 line). spec.md untouched.
- progress.md sync record present and detailed (docs-sync 2026-10-31 v1.17.1 entry, line 12); every claim in it re-verified above (counts, sizes, screenshot badge, probe list) and all held.

## Check 6 — Gate — PASS

- `npm run gate` (lint → typecheck → test → build): exit code 0, well under 300 s.
- vitest: **Test Files 15 passed (15) / Tests 765 passed (765)** — the documented count is exact, not rounded.

## Findings

- MINOR-1 — .moai/project/codemaps/modules.md:18 (main.js row, "Depends on" column): "project.js (all)" overstates slightly — main.js imports 3 of 4 project.js exports (main.js:136; `PROJECT_FORMAT_VERSION` is not imported into main). The dependency edge itself is correct; only the "(all)" qualifier is imprecise. Cosmetic; no doc correction required this round.
- No CRITICAL or MAJOR findings.

## Verdict: PASS
