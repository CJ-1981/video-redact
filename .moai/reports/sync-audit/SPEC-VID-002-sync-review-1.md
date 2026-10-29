# Sync Audit — SPEC-VID-002 docs sync (v1.6.0) — sync-review-1

- Auditor: independent sync-auditor (did not author the synced docs)
- Date: 2026-10-29
- Scope under audit: README.md, CHANGELOG.md, docs/README.md + docs/screenshots/*.png, .moai/project/{product,structure,tech}.md, .moai/project/codemaps/{pipeline,modules,state}.md, .moai/specs/SPEC-VID-002/progress.md
- Method: adversarial verification against the repo — static greps, source reads, `npx playwright test --list` (listing only, no full E2E run), one `npx vitest run`, visual inspection of all 4 screenshots, git status/diff vs HEAD (55185ee).

---

## Check 1 — Version consistency — PASS (1 minor)

- All live docs carry the current version: README.md:15,100 (`v1.6.0 · built 2026-10-29`, "Current version: 1.6.0"); .moai/project/product.md:36; .moai/project/structure.md:8; .moai/project/tech.md:41; codemaps pipeline.md:75, modules.md:17, state.md:30,58. package.json:3 = 1.6.0 (SSOT) and dist/index.html contains the stamped `1.6.0` + `2026-10-29` literals.
- Dist size: actual 178,010 bytes = 173.8 KiB — matches "~174 KiB" (README.md:87, tech.md:41, progress.md:10). No stale "~122 KiB" outside CHANGELOG release history (CHANGELOG.md:96, 1.0.0 entry — allowed).
- No stale 1.0.0–1.5.0 version claims outside CHANGELOG history. References to "v1.1.0–v1.5.0" for SPEC-VID-002 scope (README.md:96, structure.md:54, product.md:36) are scope statements consistent with the spec's REQ-101..114 amendments; v1.6.0 (Clear, no REQ) is consistently described as a separate enhancement.
- [MINOR] .moai/project/tech.md:43 — section heading "v1.1.0–v1.6.0 design notes (SPEC-VID-002)" groups the v1.6.0 CLEAR note under a SPEC-VID-002 label, while README.md:96 / structure.md:54 / product.md:36 scope SPEC-VID-002 to v1.1.0–v1.5.0. Labeling inconsistency only; the CLEAR bullet content itself is accurate.

## Check 2 — Factual spot-checks (24 verified) — PASS

Script chain (package.json:11–19 vs README.md:83–90, tech.md:57):
1. `gate` = `lint && typecheck && test && build` — exact match.
2. `test` = `vitest run`; `test:e2e` = `playwright test`; `build` = `node tools/inline.mjs`; `dev` = `node tools/serve.mjs` — all match.

Module exports claimed in codemaps/modules.md vs actual `export` statements:
3. `sampleFrameAt` — src/analyze.js:289 ✓ (codemaps/modules.md:14, pipeline.md:42)
4. `detectFaceRaw` / `detectPlateRaw` as `createDetectors` accessors returning undecoded outputs — src/detector.js:630–648 (return object `{detectFace, detectPlate, detectFaceRaw, detectPlateRaw, close, effectiveEp}`) ✓ (modules.md:11)
5. `trimTrack` — src/editor.js:334 ✓
6. `setTrackStyle` — src/editor.js:375 ✓
7. `parseClockInput` — src/editor.js:419 ✓
8. `dragStageHeight` — src/main.js:343 ✓
9. `DEFAULT_SETTINGS()` — src/main.js:482 (confFace 0.6 / confPlate 0.25 / dashcamMode false) ✓ matches CHANGELOG.md:15 claim "face 0.60 / plate 0.25, dashcam off"
10. `buildThresholdPanels` — src/main.js:419 ✓
11. `effectiveEdgePx` — src/editor.js:123 ✓
12. `clearModelCache(name?)` — src/models.js:222 ✓

State machine, detector constants, changelog:
13. STEP_TRANSITIONS: `CLEAR: 'gate'` present in ALL six steps (gate/ready/analyzing/review/exporting/done) — src/main.js:136–170; every other edge in codemaps/state.md:21–28 matches the source table one-for-one ✓ (state.md:30 "ANY step ──CLEAR──▶ gate").
14. Threshold defaults 0.60 / 0.25 — src/detector.js:117–118 (`DEFAULT_CONF_FACE = 0.6`, `DEFAULT_CONF_PLATE = 0.25`); slider ranges in src/main.js:397–400 match CHANGELOG.md:23 (face 0.10–0.90, plate 0.05–0.90) ✓.
15. Tile axis rule — src/detector.js:450–480 `tileGrid`: `width >= height` → horizontal columns; portrait → stacked full-width rows ✓ matches modules.md:11, pipeline.md:23–24, README.md:38.
16. Five fixed compare levels ≥0.15/0.30/0.45/0.60/0.75 — src/main.js:394 `THRESHOLD_LEVELS` ✓ (CHANGELOG.md:24, pipeline.md:48).
17. CHANGELOG ordering strictly descending 1.6.0→1.5.0→1.4.1→1.4.0→1.3.1→1.3.0→1.2.0→1.1.0→1.0.0 (CHANGELOG.md:9–83); all dated 2026-10-29, consistent with git commit dates (18:32–21:06 on 2026-10-29). progress.md:10's note "1.3.1/1.4.1 moved into descending sequence" is confirmed in the current order ✓.
18. clearAll DOM wiring (abort, editor destroy, blob URL revoke, OPFS `exports/redact-export-*` sweep, file-input reset) — src/main.js:43–44, 95, 133, 1139–1177 ✓ matches CHANGELOG.md:15, tech.md:48, pipeline.md:74–75.
19. `formatVersionBadge` renders `v{version} · built {date}` (src/main.js:276–281) ✓ matches the badge string quoted in README.md:15/100 and tech.md:41; `dev build (unbuilt)` fallback confirmed.
20. Unit suite composition claims — 14 files verified on disk; main-wiring.test.js = 39 tests (state.md:3) ✓ confirmed by vitest per-file output.
21. Coverage gate "≥ 85% lines on the 8 logic modules" (README.md:85, tech.md:54) — vitest.config.js present with v8 coverage; consistent with project docs (not re-run in this audit; no contradicting evidence).
22. e2e = 5 spec files (smoke, journey, auto-detect, offline-models, errors) + fixtures.js/geometry.js helpers — matches tests/e2e/ listing ✓ (the test COUNT inside those specs is the failure — see Check 4).
23. Screenshot byte sizes in progress.md:10 (94.7/644.5/596.3/259.1 KiB) match actual files (96947/659990/610650/265278 bytes) ✓.
24. Model registry sizes (tech.md:34–35: 232,589 / 7,835,770 bytes) unchanged from pre-sync git history — not contradicted by source (`MODELS` in src/models.js carries the same pins; spot-checked keys `yunet`, `plate-yolov9t`).

## Check 3 — README links + screenshots — FAIL (1 minor caption error, verdict driven by Check 4)

- All relative links resolve: README.md → docs/screenshots/{01-landing,02-capability,03-review,04-export}.png and CHANGELOG.md; docs/README.md → screenshots/*.png (relative to docs/) and ../README.md. All 4 PNGs are valid, > 30 KB (94.7 / 644.5 / 610.7→596.3 / 265.3 KB as listed above), regenerated 2026-10-29 by tools/capture-docs.mjs (MIN_BYTES = 30 KB gate at tools/capture-docs.mjs:35).
- Shot 02 — visually current ✓: shows "✕ Clear" + "Open another file" header actions, Detection Sensitivity sliders (Face 0.60, Plate 0.25), "Compare thresholds" section with Frame time input, dashcam toggle, capability report, transport bar, timeline — matches docs/README.md:8 exactly. Badge `v1.6.0 · built 2026-10-29` visible.
- Shot 03 — visually current ✓: Face #1 overlay box (pixelated), timeline chip, track row with clock inputs + Pixelate dropdown + redact toggle — matches docs/README.md:9.
- Shot 04 — ✓: "Exported — download started (55.7 KB)" toast + export status line, models panel with attribution.
- [MINOR] docs/README.md:7 — shot-01 caption claims "header actions (✕ Clear / Open another file)", but 01-landing.png shows NO header actions: `#clear-file` is `hidden` at step `gate` by design (index.html:688; src/main.js:834–837 "the Clear button mirrors #change-file — hidden at the gate"). The screenshot is truthful and current (badge `v1.6.0 · built 2026-10-29` ✓ bottom-right); the caption is wrong, not the image. Note the capture script's own header comment (tools/capture-docs.mjs:8) correctly describes shot 01 as "stepper + drop zone + footer version badge" with no Clear claim. Fix: drop the header-actions phrase from docs/README.md:7 (the ✕ Clear header IS correctly visible in shots 02–04).
- [INFO] docs/README.md:10 — shot-04 caption "all four stepper steps done": the capture is scrolled below the header, so the stepper is not visible in the frame. The described app state is correct; the visual evidence for the stepper is simply out of frame. Cosmetic.

## Check 4 — E2E test-count claim — FAIL (MAJOR)

Docs claim 8 tests / "smoke (4)"; the actual suite has 6 tests in 5 files:

- `npx playwright test --list` (this audit, listing only): **"Total: 6 tests in 5 files"** — smoke 2, journey 1, auto-detect 1, offline-models 1, errors 1. No parameterized/looped `test()` generation exists in any spec (static grep: exactly 6 `test(` declarations).
- The last recorded suite run agrees: .moai/specs/SPEC-VID-002/progress.md:7 "E2E 6/6 in 37.9s" (v1.1.0 record). Even the CHANGELOG 1.0.0 historical entry (CHANGELOG.md:98) correctly says "6 Playwright E2E tests across 5 specs — smoke (2)".

The wrong claim appears in FOUR live locations:
- [MAJOR] .moai/project/tech.md:55 — "5 spec files, 8 tests" and "Specs: smoke (4)" (smoke actually has 2 tests: smoke.spec.js:14,54).
- [MAJOR] .moai/project/structure.md:44 — "5 Playwright specs + fixtures.js + geometry.js helpers (8 tests)".
- [MAJOR] .moai/project/product.md:36 — "v1.6.0 implemented and verified (469 unit tests across 14 files, 8/8 E2E, gate exit 0)" — a false verification claim; no 8-test run can have occurred.
- [MAJOR] .moai/specs/SPEC-VID-002/progress.md:10 — the sync record itself states "E2E count corrected to 8 across 5 specs": the pre-sync count (6) was CORRECT and the sync "correction" introduced the error, then recorded it as a fix.

Root-cause guess (unproven): the numbers 8/4 look like a planned-but-never-landed smoke expansion. Whatever the origin, the docs must say 6 tests / 5 specs (smoke 2) or the suite must actually grow to 8 — either way the current sync state is factually wrong in its verification claims.

## Check 5 — Unit count claim — PASS

- `npx vitest run` (this audit, single run): **Test Files 14 passed (14), Tests 469 passed (469)** in 0.9 s.
- Matches tech.md:54 ("14 files, 469 tests"), structure.md:43, product.md:36 ("469 unit tests across 14 files"), progress.md:10 ("469/469 unit"). Note: a raw grep of `test(`/`it(` yields 438 declarations; the 469 total comes from `it.each` table expansion (e.g. ingest.test.js:363) — the vitest-reported number is the correct one and the docs use it consistently.

## Check 6 — Spec hygiene — PASS

- `git status --porcelain` vs HEAD (55185ee): only the 14 expected paths modified — README.md, CHANGELOG.md, docs/README.md, 4 PNGs, 6 .moai/project files, SPEC-VID-002/progress.md. No source (src/, tests/, tools/, index.html) changes.
- `git diff HEAD --name-only -- .moai/specs/`: ONLY SPEC-VID-002/progress.md (+1 line — the docs-sync record). SPEC-VID-002/spec.md and the entire SPEC-VID-001 tree are untouched by this sync ✓.
- Sync record present and substantive: progress.md:10 documents what was refreshed, the screenshot regeneration (4/4 with sizes), and the post-sync gate (lint 0, tsc 0, 469/469 unit, build 173.8 KiB) — dist size and unit count independently re-verified above ✓. The record's E2E sentence is wrong (Check 4).

---

## Summary

| # | Check | Result |
| --- | --- | --- |
| 1 | Version consistency | PASS (1 MINOR: tech.md:43 heading labels v1.6.0 as SPEC-VID-002) |
| 2 | Factual spot-checks (24) | PASS |
| 3 | README links + screenshots | FAIL on the check's visual expectation (MINOR caption error docs/README.md:7; images themselves current and valid) |
| 4 | E2E count claim | FAIL — MAJOR: docs say 8 tests / smoke (4) in 4 places; actual is 6 tests / smoke 2 |
| 5 | Unit count 469/469 | PASS (verified by live vitest run) |
| 6 | Spec hygiene | PASS |

Findings list:
1. [MAJOR] False E2E test-count claim (8 vs actual 6; smoke 4 vs actual 2) — tech.md:55, structure.md:44, product.md:36, progress.md:10. The sync overwrote a correct count with a wrong one and recorded the change as a "correction".
2. [MINOR] docs/README.md:7 shot-01 caption claims "✕ Clear / Open another file" header actions that cannot appear on the landing state (hidden at `gate`, src/main.js:837).
3. [MINOR] tech.md:43 heading "v1.1.0–v1.6.0 design notes (SPEC-VID-002)" conflicts with the SPEC-VID-002 scope (v1.1.0–v1.5.0) used in README.md:96, structure.md:54, product.md:36.
4. [INFO] docs/README.md:10 shot-04 caption references the stepper, which is out of frame in the exported image.

Required remediation before this sync can pass: correct the E2E count to 6 tests / 5 specs (smoke 2) in tech.md:55, structure.md:44, product.md:36 and amend the progress.md:10 sync-record sentence; optionally fix the two MINOR caption/labeling items.

Verdict: FAIL

---

# Iteration 2 (delta)

Re-audit scope: ONLY the six prescribed fixes + two MINORs from iteration 1, plus a residual-claim sweep. No other files were modified by this audit; verification used the same method as iteration 1 (greps + source/caption reads + image inspection + git status). The authoritative E2E count from iteration 1 (`npx playwright test --list` → 6 tests in 5 files) remains valid: `git status` shows tests/ untouched since, so no re-run was needed.

## Prescribed fixes — verification

| # | Fix | Location | Result |
| --- | --- | --- | --- |
| 1 | structure.md 8→6 tests | .moai/project/structure.md:44 — "5 Playwright specs + fixtures.js + geometry.js helpers (6 tests)" | VERIFIED ✓ |
| 2 | product.md 8/8→6/6 | .moai/project/product.md:36 — "(469 unit tests across 14 files, 6/6 E2E, gate exit 0)" | VERIFIED ✓ |
| 3 | tech.md "8 tests"→"6 tests" | .moai/project/tech.md:55 — "5 spec files, 6 tests" | VERIFIED ✓ |
| 4 | tech.md smoke (4)→smoke (2) | .moai/project/tech.md:55 — "Specs: smoke (2), journey …" — matches smoke.spec.js (2 `test()` declarations) | VERIFIED ✓ |
| 5 | progress.md sync-record sentence | .moai/specs/SPEC-VID-002/progress.md:10 — "E2E count verified at 6 tests across 5 specs (an initial 8-claim was wrong)" — accurate against the 6-test reality | VERIFIED ✓ |
| 6 | docs/README.md shot-01 caption | docs/README.md:7 — "…footer version badge (the ✕ Clear / Open another file header actions appear once a file is loaded)" — now matches the screenshot AND the code (`#clear-file` hidden at step `gate`, src/main.js:837; buttons visible in shots 02–04) | VERIFIED ✓ |

## MINOR fixes — verification

| # | Fix | Location | Result |
| --- | --- | --- | --- |
| 7 | tech.md heading renamed | .moai/project/tech.md:43 — "## Design notes added since v1.0.0 (SPEC-VID-002 amendments, v1.1.0–v1.6.0)" — no longer labels the whole v1.6.0 span as SPEC-VID-002; consistent with README.md:96 / structure.md:54 / product.md:36 scope statements | VERIFIED ✓ |
| 8 | docs/README.md shot-04 caption softened | docs/README.md:10 — "'Exported — download started' confirmation with the success toast (stepper completion visible in the full-size capture)" | PARTIAL — see residual defect below |

## Residual-claim sweep — CLEAN

- Repo-wide grep for `8 tests` / `8/8` / `smoke (4)` across README.md, docs/, .moai/project/, codemaps/, .moai/specs/: zero hits outside the audit report itself and the self-correcting note in progress.md:10 ("an initial 8-claim was wrong" — a correction record, not a claim). CHANGELOG history (1.0.0's "6 Playwright E2E tests … smoke (2)") remains consistent with reality.
- Codemaps contain no test-count claims; README.md:95's "5 spec files" (no count) remains correct.

## Spec hygiene (re-checked)

`git status --porcelain` vs HEAD (55185ee): same 14 expected doc/screenshot/project paths plus this report (untracked). No src/, tests/, tools/, or spec-body changes — the delta edits stayed inside the permitted set. ✓

## Residual defect (non-blocking)

1. [MINOR, cosmetic] docs/README.md:10 — the softened parenthetical "(stepper completion visible in the full-size capture)" still misdescribes the shipped image: 04-export.png is byte-identical to iteration 1 and is scrolled below the header, so the stepper is not visible in it at any size, and no separate "full-size capture" exists in docs/screenshots/. Suggested one-line reword: "(the stepper is out of frame in this scrolled view)" — or simply drop the parenthetical; the toast + export-status claims in the caption are accurate and visible.

## Delta result

All six prescribed fixes applied and verified against the current files; the MAJOR cluster from iteration 1 (false 8-test E2E claims) is fully eliminated and the corrected counts (6 tests / 5 specs / smoke 2 / 6/6) now match the verified suite. Both MINORs addressed; one leaves a cosmetic parenthetical imprecision (item 8 above) that touches no verification claim, version fact, or count.

Verdict: PASS
