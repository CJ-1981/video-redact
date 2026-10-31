# SPEC-VID-002 Sync Review 3 — Independent Sync-Phase Audit (v1.18.1)

- **Date**: 2026-10-31
- **Auditor**: sync-auditor (independent; did not author the synced docs)
- **Scope**: docs changed in the v1.18.1 docs-sync — README.md, .moai/project/{product,structure,tech}.md, .moai/project/codemaps/{modules,state,pipeline}.md, .moai/specs/SPEC-VID-002/progress.md, docs/screenshots/*.png (4)
- **Method**: adversarial verification against the repo (source grep, Playwright `--list`, fresh `npm run gate` run, git history, screenshot inspection). No files modified other than this report.

---

## Check 1 — Version / count consistency

**Result: PASS (with 1 minor on progress.md)**

| Claim | Verified against | Evidence |
| --- | --- | --- |
| Current version 1.18.1 | `package.json` | `1.18.1` |
| Footer badge `v1.18.1 · built 2026-10-31` | `docs/screenshots/01-landing.png` (visual read) | badge renders bottom-right: `v1.18.1 · built 2026-10-31` — exact match |
| Unit tests 765/765 across 15 files | fresh `npm run gate` output | `Test Files 15 passed (15)` / `Tests 765 passed (765)` |
| E2E count "6 tests in 5 specs" | `npx playwright test --list` | `Total: 6 tests in 5 files` — exact (product.md:36, structure.md, README.md:101 all agree; prior-audit lesson honored — counted via the runner, not by reading specs) |
| dist ~281 KiB (287,706 bytes at v1.18.1) | `dist/index.html` on disk + gate build log | 287,706 bytes = 281.0 KiB (tech.md:41 exact) |
| No stale ≤ v1.17.1 "current" claims | grep of README.md, .moai/project/**, docs/README.md | every v1.16/v1.17 mention is a historical attribution ("v1.17.1 fixed…", version-range notes); "Current version" is 1.18.1 (README.md:104), structure.md:8 = 1.18.1, tech.md:41 badge = v1.18.1, spec ranges v1.1.0–v1.18.1 |

- **MINOR** — `.moai/specs/SPEC-VID-002/progress.md:13`: the v1.18.1 sync record says "CHANGELOG verified strictly descending (1.18.1 → 1.0.0, **30 release entries**)". Actual count from `1.18.1` to `1.0.0` is **32** entries (verified `grep -cE "^## \[1\."` = 32). The "30" was correct for the *previous* v1.17.1 record (progress.md:12) and appears carried over unchanged. The CHANGELOG itself is correct; only the sync-record's self-audit number is stale.

## Check 2 — Factual spot-checks (20 performed, ≥14 required)

**Result: PASS**

| # | Claim | Source of truth | Status |
| --- | --- | --- | --- |
| 1 | 480p in `analyze.DOWNSCALE_CAPS`, long edge 854 | src/analyze.js:63 `['480p', 854]` | OK |
| 2 | 480p in `main.DOWNSCALE_VALUES` | src/main.js:696 `['full','1080p','720p','480p']` | OK |
| 3 | 480p as export `<option>` | index.html:1364 `<option value="480p">480p (long edge)</option>` | OK |
| 4 | `#below-timeline` inside `#stage-column`, after `#timeline` | index.html: `#stage-column` @1159 → `#timeline` @1227 → `#below-timeline` @1241 | OK |
| 5 | stage-column closes before `#rail-resize` | `</section>` ×2 @~1274-1275, `#rail-resize` @1282 | OK |
| 6 | 28px = 16px margin + 12px gap | index.html:676 `#below-timeline { margin-top: 16px }` + index.html:274 `#stage-column { … gap: 12px }` = 28px | OK |
| 7 | codemap: project.js exports | src/project.js: `PROJECT_FORMAT_VERSION`:28, `serializeProject`:45, `parseProject`:107, `validateVideoMatch`:198 | OK |
| 8 | codemap: `inTrims` (analyze.js) | src/analyze.js:110 `export function inTrims` | OK |
| 9 | codemap: `scaleTracks` (exporter.js) | src/exporter.js:296 | OK |
| 10 | codemap: `exportGeometry` (exporter.js) | src/exporter.js:318, returns `{sf, outW, outH}` (line 971 destructure confirms) | OK |
| 11 | codemap: `pixelStrengthMultiplier` (redact.js) | src/redact.js:111 | OK |
| 12 | codemap: `keptSegments` (main.js) | src/main.js:1481 | OK |
| 13 | codemap: `clampTracksToDuration` (main.js) | src/main.js:1271 | OK |
| 14 | codemap: `normalizePixelStrength` (main.js) | src/main.js:737 | OK |
| 15 | structure.md tools list complete | diff vs `ls tools/` — **26/26 files match, no extras, no omissions** (incl. debug-export-settings.mjs, debug-plate-e2e.mjs, debug-mb-semantics.mjs, debug-collapse-space.mjs) | OK |
| 16 | exporter re-exports `pixelateFrame` (modules.md) | src/exporter.js:69 `import { pixelateFrame } from './redact.js'` | OK |
| 17 | unit 15 files / 765 tests (structure.md) | gate output | OK |
| 18 | E2E 5 specs + 6 tests (structure.md, README) | playwright --list | OK |
| 19 | dist 287,706 B (tech.md:41) | `ls -l dist/index.html` | OK |
| 20 | `.vrproj` = settings/trims/tracks/video identity, no video bytes (README/tech/pipeline) | src/project.js header + exports | OK |

## Check 3 — README

**Result: PASS (with 1 minor, pre-existing)**

- **Links**: internal links (`CHANGELOG.md`, 4× `docs/screenshots/*.png`) all resolve to existing files; `docs/README.md` exists (screenshot index). External links (huggingface.co/opencv/face_detection_yunet, github.com/ankandrew/open-image-models) match the model attributions rendered in the landing screenshot's Models panel.
- **Screenshots**: 4/4 present, all >30 KB (155,132 / 674,002 / 649,888 / 378,270 bytes = 151.5 / 658.2 / 634.7 / 369.4 KiB — matches the sizes recorded in progress.md:13), mtimes 2026-10-31 22:46 (fresh, post-1.18.1-build 22:52 dist capture run). 01-landing.png visually confirms the `v1.18.1 · built 2026-10-31` badge and the v1.18.1-era layout.
- **Version claims**: badge text at README.md:15/104 = `v1.18.1` — matches package.json and screenshot.
- **Feature bullets**: all traceable — 480p export + long-edge 854 (CHANGELOG 1.18.0, analyze.js:63), choices-persist/reset-only-on-load-and-Clear (1.17.1), pixelation strength ×1–×4 (1.17.0, redact.js `PIXEL_STRENGTHS`), `.vrproj` save/load (1.17.0, project.js), workspace/keyboard/resize wave (1.11.0–1.14.x), trim + kept-segment concat (1.15.x), Include-audio (1.16.0), below-timeline-inside-preview-column (1.18.0–1.18.1 — matches index.html DOM and CHANGELOG 1.18.1).
- **Limitations**: styles/OCR/audio/.vrproj/min-block-size claims all trace to CHANGELOG + source.
- **MINOR (pre-existing, NOT introduced by this sync)** — README.md:111: "iPhone HDR/Dolby Vision footage exports tone-mapped to SDR (**warned in the UI**)". No warning string about HDR/DV tone-mapping exists anywhere in `src/` or `index.html`; the only capability warning pushed is HEVC hardware-gating (src/capability.js:188), and the sole repo trace of the concept is the JSDoc at src/types.js:99 ("HDR/DV tone-shift and similar advisories"). The line predates this sync (unchanged in `git diff README.md`) and the tone-mapped-export behavior itself is plausible, but the "warned in the UI" clause is unverifiable against the code. Recommend either adding the warning or softening the clause in a future pass.

## Check 4 — CHANGELOG

**Result: PASS**

- Strictly descending 1.18.1 → 1.0.0 with no gaps or duplicates across all 32 release entries (verified every `## [x.y.z]` heading in order); `[Unreleased]` sits on top as expected.
- Spot-check 1: **1.18.1** entry ("below-timeline section was a workspace-grid child… now inside the preview column directly after the timeline, constant 28px") matches commit `62e17b3` ("fix: v1.18.1 — tracks panel follows the timeline directly (no grid gap)"; touched index.html, mobile-ui.test.js, version.test.js, package.json).
- Spot-check 2: **1.17.0** entry (export-settings regression fix + compare-honors-settings + pixel strength + project save/load) matches commit `78db2fd` ("feat: v1.17.0 — export settings fix, compare honors settings, pixel strength, project save/load").
- CHANGELOG.md is NOT in the modified set — content untouched this sync, as claimed in progress.md:13.

## Check 5 — Spec hygiene

**Result: PASS**

- `git status --porcelain` shows exactly the 12 expected paths: README.md, 6× .moai/project/**, .moai/specs/SPEC-VID-002/progress.md, 4× docs/screenshots/*.png. Nothing else modified, nothing staged, no untracked strays.
- SPEC bodies untouched: the only modified file under .moai/specs/ is progress.md; spec.md is clean.
- Sync record present: progress.md:13 documents the v1.18.1 docs-sync in full (scope, verification steps, live counts, gate re-run) — one stale number flagged in Check 1.

## Check 6 — Gate

**Result: PASS**

- `npm run gate` re-run from clean: **exit 0**, well under 300 s. Lint + typecheck clean; vitest `Test Files 15 passed (15)`, `Tests 765 passed (765)`; build emitted `dist/index.html` 281.0 KiB (287,706 bytes) — matching every documented figure.

---

## Findings summary

| Severity | Location | Finding |
| --- | --- | --- |
| MINOR | .moai/specs/SPEC-VID-002/progress.md:13 | Sync record claims "30 release entries"; actual 1.18.1→1.0.0 count is 32 (stale carry-over from the v1.17.1 record). CHANGELOG itself is correct. |
| MINOR (pre-existing, out of change set) | README.md:111 | "HDR/Dolby Vision… warned in the UI" has no matching warning string in src/ or index.html (only src/types.js:99 JSDoc). Not introduced by this sync; flagged for a future pass. |

No CRITICAL or MAJOR findings. All load-bearing claims (version, test counts, E2E count, dist size, DOM/CSS layout contract, exports, tools inventory, screenshot currency) verified against the repository.

Verdict: PASS
