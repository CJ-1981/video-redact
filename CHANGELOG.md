# Changelog

All notable changes to this project are documented in this file.

The format is based on the Keep a Changelog convention, and this project adheres to Semantic Versioning.

## [Unreleased]

## [1.18.2] — 2026-11-01

### Fixed
- The preview height handle could no longer drag DOWN to enlarge (v1.18.1 follow-up): the reserved-space clamp counted the tracks/compare panels — which moved into the same column in v1.18.1 — as must-stay-visible, leaving almost no enlargement room. The clamp now reserves only the chrome above the stage plus a minimal constant for the controls directly below it; enlarging pushes the timeline/tracks below the fold (theater-mode behavior, bounded by the 75vh cap, footer in normal flow can never overlap).

## [1.20.0] — 2026-11-01

### Added
- Skip trimmed parts during playback: an opt-in checkbox in the trim bar — when playing, the playhead jumps over trimmed regions instead of showing the grey veil. Paused inspection still shows the veil.
- Friendlier wording for the enhanced-scan toggle (was "Dashcam mode (tiled pass for small plates)" — now "Enhanced scan (finds small or distant faces & plates — 3× slower)").

## [1.19.0] — 2026-11-01

### Fixed
- The two width handles had inconsistent visual states: the left handle (capability | preview) had no hover highlight or focus ring, while the right handle (preview | rail) highlighted grey on hover. Both handles now share identical styling — grey hover highlight, accent focus ring, and a visible grip affordance so they are discoverable without hovering.

## [1.18.1] — 2026-11-01

### Fixed
- Large empty gap between the timeline and the Tracks panel: the below-timeline section was a workspace-grid child, so its position depended on the right rail's height. It now lives inside the preview column directly after the timeline — the tracks panel always follows the timeline with a constant 28px margin, measured at every layout width.

## [1.18.0] — 2026-10-31

### Added
- Export resolution 480p (long edge 854) — smallest/fastest export option.
- The Tracks and Compare-thresholds panels now align with the preview column width (they previously spanned under the right rail).

## [1.17.1] — 2026-10-31

### Fixed
- Export resolution and audio removal did not apply (field report with an affected export): clicking Export called resetExportUi() FIRST, which reset the resolution select to Full and re-checked audio BEFORE the settings were read — every export ran with defaults. Choices now reset only on file load and Clear; an export click keeps them. Verified with a real-browser probe: a 2560×1440 source exported at 720p with audio off produces exactly 1280×720 with 0 audio tracks (tools/debug-export-settings.mjs).

## [1.17.0] — 2026-10-31

### Fixed
- Export resolution + audio removal selections now actually reach the exporter (v1.16.0 regression: missing element refs silently fell back to full resolution + audio).

### Added
- Threshold comparison honors dashcam mode, minimum object size, and detection detail — panels show what a real analyze would find at each threshold.
- Pixelation strength control (Fine ×1 / Normal ×2 / Coarse ×3 / Max ×4 block multiplier; Normal default doubles the old block size) — same strength in preview and export.
- Project save/load: 💾 Save project downloads a .vrproj with settings, trims, tracks, and video identity (no video bytes); 📂 Load project restores them with typed error handling and video re-association warnings.

## [1.16.0] — 2026-10-31

### Added
- Export resolution selection: Full (match source) / 1080p / 720p — the burn-in canvas, redaction boxes, and encoder hints all scale together (locked-size burn-in prevents the pipeline from silently reverting to source dims).
- Audio removal: an "Include audio" checkbox in the export panel — off exports a silent video (audio track discarded).
- Honest labels on the encoder-quality select (the old labels implied a resolution change that never happened).

### Changed
- The resolution and audio choices reset with every export-panel reset (file load, Clear, re-export).

## [1.15.2] — 2026-10-31

### Added
- Trimmed regions are now skipped during analysis: frames inside trim regions cost no draw, no inference, and no tracking — large trims make analysis proportionally faster and keep ghost tracks out of the list. The analyze status reports how many trimmed frames were skipped, and the trim hint documents the behavior.

## [1.15.1] — 2026-10-31

### Fixed
- Trim drags starting at the playhead were stolen by the scrub thumb's hit zone (users naturally drag from where the playhead is) — in trim mode the thumb now yields so region creation works from anywhere on the timeline. Verified by a faithful probe: a drag starting exactly at the thumb creates a region.
- Changed: the ✂ Trim toggle moved from the Tracks panel to the timeline area (trimming is independent of redaction tracks), with an inline hint while trim mode is active.

## [1.15.0] — 2026-10-31

### Added
- Timeline TRIM (REQ-125): a ✂ Trim toggle (Tracks panel header) activates trim mode — drag anywhere on the timeline to mark regions for deletion. Each region renders as a greyed-out overlay with ✂ marks at its draggable edges and a ✕ (or double-click) to remove; multiple regions are supported, edges never cross a neighbor, and the minimum region is 0.1 s. While the playhead is inside a region the preview frame renders under a grey veil (and skips the pixelation burn — trimmed frames never export).
- Trimmed export (REQ-126): export excludes every trimmed region — one native mediabunny trim conversion per kept segment (pixelation burn-in per segment, audio packet-copied), then the segments' encoded packets are concatenated into a single file with continuous timestamps and intact A/V sync (no re-encode). With no trims the export path is byte-for-byte unchanged. Progress, cancellation and temp cleanup cover the multi-segment pipeline; all segment temps are removed after delivery.

## [1.14.1] — 2026-10-31

### Fixed
- Preview image duplicated/stretched along the right edge after dragging a width handle: the preview IS the editor canvas, and on machines where rVFC never presents frames the frame loop never re-drew it after a layout change — the stale bitmap stayed stretched over the new layout beside the live <video>. Width handles now kick a (throttled) editor redraw live during the drag + an exact one on drag end, and the timeupdate fallback re-draws the canvas (~4 Hz) so rVFC-dead machines keep a correct preview during playback too.

## [1.14.0] — 2026-10-31

### Added
- Draggable width handle between the capability panel and the preview (desktop): the panel's right edge follows the pointer (240–480px, keyboard + double-click reset, like the other handles).

### Fixed
- Right-rail width handle moved in the opposite direction: the handle is the rail's LEFT edge and now follows the pointer (drag right = narrower rail). Direction pinned by unit tests.
- Compare-thresholds now sits UNDER the Tracks panel (stacked), per field request.

## [1.13.1] — 2026-10-31

### Fixed
- Mobile: collapsing the Capability report left a large empty area underneath — the intake panel carried a hard 320px flex-basis (meant for the desktop side-column) which becomes a fixed HEIGHT in the mobile column layout. Replaced inline flex styles with viewport-aware CSS classes (content-sized on phones; desktop unchanged).

## [1.13.0] — 2026-10-31

### Added
- Bulk restyle: "All solid" / "All pixelate" buttons in the Tracks panel restyle every track at once.
- All panels (Capability, Detection settings, Compare thresholds, Tracks, Export, Models) are collapsible via their headers (native details, open by default).
- Models/attribution panel moved below the footer as its own full-width section.
- Detection detail wording clarified: "Detection detail (analysis only)" with a hint that analysis speed is affected but export always uses the full-resolution source.

## [1.12.0] — 2026-10-31

### Added
- Layout: threshold-compare and track list moved below the preview timeline (compare panels in a horizontal scrollable strip); Models panel moved under the capability report; draggable vertical handle between the preview column and the side panel (240–480px, keyboard + double-click reset).
- File information block (name, size, modified date, type) above the capability report.
- Detection minimum-size filter as a button group (Any / ≥24px / ≥48px / ≥96px) — smaller detections are skipped before tracking.
- Optional processing downscale (Full / 1080p / 720p) for faster 4K analysis; detections are rescaled to native display coordinates before tracking.
- Keyboard: ←/→ jump ±5s, Shift+←/→ frame-step, F toggles enlarged preview, M toggles mute.
- Light theme via a header toggle (choice persisted).

### Changed
- Analysis cancel button is state-driven ("Stop analysis", danger-styled) while a pass is running.
- Compare frame-time field no longer truncates (wider bottom-section layout).

## [1.11.0] — 2026-10-31

### Added
- Jump-to-start (⏮) button in the fullscreen/enlarged overlay control bar (mirrors the transport bar).
- Selected state on threshold-compare panels: the clicked level stays visually highlighted (accent ring + ✓, aria-pressed) until another level wins or the panels clear.
- "Use preview time" button next to the compare frame-time field — one click sets the field to the preview's current position instead of reading the timecode by hand.

## [1.10.1] — 2026-10-30

### Fixed
- License-plate detection never fired (found with the user's IMG_5019.MOV — plates clearly visible, zero detections): TWO hard-coded layout mismatches. (1) The output finder accepted only 6-wide tensors while the real open-image-models end2end export emits 7-wide rows `[batch_idx, x1, y1, x2, y2, class_id, score]`; (2) the row parser read stride-6 with score at column 5 — which is class_id (always 0) — so every detection was filtered. Parser now supports both 7-wide and legacy 6-wide layouts (score = last column, box = the 4 columns before class_id). Verified end-to-end on real frames: conf 0.887 at the true plate position (probe: tools/debug-plate.mjs, tools/debug-plate-e2e.mjs).

## [1.10.0] — 2026-10-30

The timeline works BEFORE analysis: the review editor now mounts the moment a video is loaded, not after the first analyze completes.

### Fixed

- Timeline, scrub thumb and keyboard transport were dead until the first analysis finished (field report: "it happens only before analysis is made"). Root cause: the workspace UI (preview, transport, timeline, thumb) is visible in the READY state, but `mountEditor` only ran inside the analyze completion path — pre-analyze the timeline was inert markup, the scrub thumb never moved, and Space did nothing. Fix: the editor mounts at READY (file open, capability OK, 0 tracks) through the same `mountEditorSafe` seam (a mount failure stays a readable toast; the doc-level keyboard is still wired first, preserving the v1.9.0 ordering contract), and analyze completion now only sets the merged track state + `editor.refresh()` — no destroy/remount churn at review.
- Manual redaction regions drawn before running analysis are no longer lost: the analyze pass returns a fresh auto-only track array which used to REPLACE `app.tracks`. A pure `mergeManualTracks(existing, analyzed)` seam keeps every `source === 'manual'` track, appends the analyzed tracks, and re-assigns colliding auto ids past every existing id (`manualNextId` follows the merge). Existing manual regions also stay rendered and enforced in the preview during the pass instead of vanishing mid-analysis.
- `Space` now toggles playback in the READY state (and the `B` manual-box hint fires there — canvas drawing is live from ready); `←`/`→` frame-step keeps its review-state gating. Export remains state-gated to review/done: nothing can ship pre-analyze (`deriveStep('ready', 'EXPORT_START')` is and stays null).

### Verification

- Probe: `node tools/debug-freeze-emulated.mjs` — new FIRST phase P0 (pre-analyze, READY state, no analysis): play → thumb tracks, Space toggles playback, thumb drag 25%→50% scrubs, a manual box drag creates a track, no page errors. FAILS on the v1.9.0 dist (dead UI), PASSES after the fix; P-A/P-B/P-C (post-analyze) unchanged and green, with a new assertion that the P0 manual region survives analysis (merge).
- Unit: 540 → 553 tests, all passing. New: `mergeManualTracks` (keep+append, collision re-id, re-analyze replaces autos only, degenerate inputs + no mutation), `deriveStep` ready-carries-a-live-editor / export-gated-pre-analyze, mountApp integration (mount at ready with 0 tracks, no remount on analyze completion, manual boxes survive analysis, Space-at-ready with ←/→ still gated), and empty-track editor mounts (render/refresh safe, position driven, scrub + pin, clean teardown) in `timeline.test.js`.
- Gate: `npm run gate` (eslint 0 errors · tsc --noEmit 0 errors · unit suite · build) exits 0.

## [1.9.0] — 2026-10-30

### Added
- Runtime error + gesture diagnostics in the ?debug=1 line: window error/unhandledrejection counters + last message, focused element, editor gesture state (dragging / release-pin remaining ms), editor-side timeupdate counter.

### Fixed
- Timeline thumb can no longer freeze permanently: the v1.8.0 release pin (a condition latch that could stop clearing once playback moved away from the pinned position) is replaced by a 350 ms time-boxed pin that self-expires unconditionally; drag-state guaranteed to clear on every gesture end path.
- Editor mount and per-tick exceptions are isolated: keyboard wiring runs before the editor mounts, a mount failure surfaces a readable toast while keyboard stays live, and one bad tick can never stop the loop.

## [1.8.2] — 2026-10-30

A runtime self-diagnostic for remote support: `?debug=1` makes the reporting page print its own evidence.

### Added

- `?debug=1` runtime diagnostics: with the flag in the URL, mountApp logs ONE compact JSON line to the console every 2 s (auto-stops after 10 minutes so a support session never floods the log). Each `[diag]` line leads with the RUNNING bundle identity — `v` (shipped version) + `build` (build date), the same stamps the footer badge shows, so a stale cached bundle is immediately identifiable — then the live transport facts the v1.8.1 field report needs: `tu` (timeupdate events since the previous line, counted by main.js's dedicated listener) and `vfc` (rVFC-DELIVERED frame ticks since the previous line, counted inside editor.js's tick only — the rAF fallback never counts), so playing with `vfc: 0` while `tu > 0` proves frame presentation is dead on that machine and `timeupdate` is carrying the position. Also per line: `secure`, `step`, `t`/`dur`, `paused`/`rate`/`muted`, `pin` (the editor's thumb release pin is closure-private → always `null`, honest unknown), `thumbLeft` (live `#timeline-thumb` `style.left`), `tracks`, `webgpu`. The counters ride a shared `globalThis.__VR_DIAG = {tu, vfc}` that always exists — one `++` per event — but WITHOUT the flag there is no interval and no logging (zero overhead).
- Pure seams, unit-pinned: `parseDebugFlag(search)` (accepts `debug=1` / `debug=true` anywhere in the query; everything else — absent, bare `?debug`, `0`/`false`, case variations — is deterministically OFF) and `formatDiagLine(snapshot)` (compact JSON, canonical `DIAG_KEY_ORDER` key order, finite-guarded numbers, `undefined` → null). New probe `tools/debug-diag.mjs` (desktop viewport, fixture playing).

### Verification

- Unit: 510 → 517 tests, all passing (14 files; new `?debug=1 runtime diagnostics` block in `main-wiring.test.js` — flag acceptance/rejection, canonical key order, finite guards, full-snapshot compact round-trip, non-object tolerance, counter-wiring asserts; `version.test.js` now pins 1.8.2).
- Probe: `node tools/debug-diag.mjs` — loads `dist/index.html?debug=1` with the detectable fixture: P1 a `[diag]` line every ~2 s (±700 ms), P2 every line carries `v: "1.8.2"`, P3 `tu`/`vfc` keys present, P4 a flagless page logs zero `[diag]` lines.
- Gate: `npm run gate` (eslint 0 errors · tsc --noEmit 0 errors · unit suite · build) exits 0.

## [1.8.1] — 2026-10-30

The scrub thumb follows playback again on browsers where the frame loop never fires.

### Fixed

- Scrub thumb froze at 0% during normal playback (field evidence: transport timecode `0:11.1 / 0:11.1` live while the thumb sat at its CSS-default 0% for the whole clip; thumb only ever moved on explicit seeks/drags). Root cause: playback position updates rode EXCLUSIVELY on the preview frame loop — `requestVideoFrameCallback` (rAF fallback) fires only when the compositor PRESENTS a frame, and on browsers/GPU/window states that never present during playback the loop registered but never fired, so `tick()` → `updatePlayhead()` → `updateThumb()` (editor.js) never ran. Seeks stayed live because `seeked` is media-event-driven and drags are DOM-only — exactly the observed split — and the transport readout stayed live because main.js drives it from its own `timeupdate` listener. Fix: `timeupdate` now drives the same `updatePlayhead` path from the live `video.currentTime`/`video.duration` (position only — the canvas draw stays frame-loop-owned; drag and release-pin guards still step aside inside `updateThumb`), and `duration()` falls back to the host meta duration (`getState().duration`, wired from `app.meta`) ONLY when `video.duration` is NaN/≤0. The fallback also keeps the playhead/thumb honest if the draw loop ever halts fail-closed.

### Verification

- Unit: 507 → 510 tests, all passing (14 files; new `mountEditor playback following` tests in `timeline.test.js`: thumb 0%→50%→100% via `timeupdate` with a starved frame loop — verified failing on the pre-fix wiring — plus the delivered-rVFC path and the meta-duration fallback).
- Probe: `node tools/debug-touch-timeline.mjs` — new T-play (untouched `video.play()` → thumb advanced ≥15% of the strip and thumb x ≈ currentTime/duration ±5%, with an rVFC-delivery counter distinguishing "loop healthy" from "loop starved, timeupdate carried it"); T1/T2/T2c/T3/T-thumb/T4 unchanged and passing.
- Gate: `npm run gate` (eslint 0 errors · tsc --noEmit 0 errors · unit suite · build) exits 0.

## [1.8.0] — 2026-10-30

Desktop-mouse reliability for the timeline scrub handle, plus an audio mute button on both control bars.

### Fixed

- Timeline thumb drag on desktop browsers. Field report: "timeline scrub handle doesn't work on PC browser." A new real-mouse probe (`tools/debug-thumb-mouse.mjs` — the v1.6.2 touch probe only ever exercised TOUCHSCREEN input) could not reproduce a dead drag in desktop Chromium or Firefox, but instrumentation exposed two latent desktop-only failure modes with exactly the reported symptom, both now fixed in `editor.js`: (1) **release race** — `pointerup` dropped the drag guard BEFORE the endpoint seek completed, so the frame loop re-derived the thumb from the stale pre-seek `video.currentTime` and visibly yanked the handle back off the release point until `seeked` landed (sub-frame in headless probes; tens-to-hundreds of ms on real desktop hardware — read as "the handle doesn't stick"). The release point is now PINNED (`thumbPin`, pure seam `thumbPinSettled` + `THUMB_PIN_EPSILON_S`) until the seek lands: cleared by `seeked`, by the settled check, by the next gesture, or by teardown. (2) **silent pointer-capture failure** — the drag lived only on the thumb's own `pointermove`/`pointerup` listeners, so a capture that failed without throwing killed the drag the moment the cursor outran the 20 px thumb (and a release outside `#timeline` leaked the drag state, freezing the thumb forever). A gesture-scoped window-level capture net (armed on `pointerdown`, disarmed on end/teardown) now mirrors move/up/cancel into the same handlers whenever the event target is not the thumb — an exact no-op while capture works.

### Added

- Audio mute button (v1.8.0): `#mute-button` in the transport bar and `#ov-mute` in the fullscreen/zoom overlay bar (after the step cluster, before speed — all existing E2E selectors untouched). Both route through the shared `toggleMute()`, which flips `video.muted` (NEVER volume — the user's volume level survives muting), and their glyph (`muteGlyph`: 🔊/🔇), `aria-pressed` and Mute/Unmute labels are driven by the `volumechange` event so EXTERNAL mute flips (browser media controls) stay in sync too. New files load unmuted and `clearAll` resets to unmuted (teardown checklist).

### Verification

- Unit: 501 → 507 tests, all passing (14 files; `thumbPinSettled` release-pin tests in `timeline.test.js`, `muteGlyph` + mute markup contract in `mobile-ui.test.js`).
- Probe: `node tools/debug-thumb-mouse.mjs` — real-mouse drag checks M0 (click-to-park), M1 (paused drag, mid-drag follow + release + no snap-back), M1b (grab at the half-clipped 0% position), M1c (fast fling — capture sentinel), M1d (overshoot clamps), M1e (30 px vertical drift off the thumb — capture sentinel), M1f (immediate re-grab), M2 (drag while PLAYING) — PASS on Chromium; BROWSER=firefox run PASS; WITH_MUTE=1 adds M3 (mute toggle, external-flip mirror, clearAll reset on both bars).
- Gate: `npm run gate` (eslint 0 errors · tsc --noEmit 0 errors · unit suite · build) exits 0.

## [1.7.0] — 2026-10-30

A visible, draggable scrub handle on the timeline — the standard video-player slider pattern, replacing tap-only scrubbing (field reports: timeline taps still don't register on some real devices).

### Added

- Draggable scrub handle (v1.7.0): a 20 px round thumb (`#timeline-thumb`, accent color, panel border, soft shadow) rides the playhead position inside the timeline track and moves with it during playback. Grabbing it and dragging scrubs the video live — pointer drags map through the chips-layer rect (`timelineTimeAt`) and seek throttled at ~50 ms with an exact endpoint seek on release — and the strip's existing interactions are untouched: tapping the track still jumps, chip-edge trims still trim, chip dblclick still toggles (the thumb's `pointerdown` stops propagation, so the strip gesture block never owns a thumb press). The hit target is extended to 36×28 px for fingers (`::after`), `touch-action: none` keeps the drag out of page scroll, and the focused thumb is keyboard-steppable (`role="slider"` with honest `aria-valuemin/max/now` in seconds; ←/→ step ±1 frame through the same `stepFrame` math as the transport buttons via the new `onStepFrame` mount hook, ↑/↓ ±1 s). Pure seams: `thumbLeftPct` (shares the playhead clamp-and-scale mapping) and `thumbAriaValue`.

### Verification

- Unit: 491 → 501 tests, all passing (14 files; 10 new scrub-thumb tests in `timeline.test.js`).
- Probe: `node tools/debug-touch-timeline.mjs` — T1 (plain tap strip 50%), T2 (jitter tap axis 25%), T2c (mouse click guard), T3 (chip-edge touch trim) all still PASS, plus new T-thumb (thumb parked at 25% after a 25% tap; touch-drag 25%→50% lands |t − 0.5·dur| < 0.15 s with currentTime followed mid-drag).
- Gate: `npm run gate` (eslint 0 errors · tsc --noEmit 0 errors · unit suite · build) exits 0.

## [1.6.2] — 2026-10-30

### Fixed
- Timeline tap-to-seek on touch devices: seek now fires on pointerup (works on iOS Safari/WebKit where tapping a plain div never produces a click event) and the timeline strip sets `touch-action: none` so a tap with finger drift can't be taken over by page scroll (pointercancel). Desktop mouse path unchanged; chip-edge trim unaffected.

### Changed
- Clear button styled alert red (destructive-action affordance).

## [1.6.1] — 2026-10-29

Field-regression fixes in the review workspace: timeline seeking, keyboard transport, and the enlarged-preview layout.

### Fixed

- Timeline click-to-seek restored and accurate. Two defects shipped in the v1.3.0 trim-gesture rework. (1) The seek mapped the pointer through the full `#timeline` strip rect (timecode labels + padding included) instead of the time axis the chips and playhead live in, so every click landed up to ~10% of the video away from the point actually clicked (`editor.js` now maps through the chips-layer rect, with label/padding clicks clamping to the ends — pure `timelineTimeAt`). (2) The "follow-up click suppressed" flag of a trim-armed pointerdown survived a `pointercancel` (touch scroll over the strip cancels pointers constantly), silently swallowing the NEXT click — clicking the timeline appeared dead until a second tap. The suppression now resets on cancel, expires if the follow-up click never arrives, and additionally refuses presses that moved more than 8 px (a drag released on the strip is never a seek).
- Keyboard shortcuts work again after clicking any control. The doc-level handler excluded key events whose focus was inside ANY `button`, and browsers leave a clicked button focused — so after touching transport/fullscreen/handle controls, Space re-activated the focused button (re-stepping frames, exiting fullscreen) instead of toggling playback. Transport, overlay, fullscreen, handle, style-select and action controls now release focus after pointer activation (`blur` on click/change/pointerup), the exclusion is limited to typing surfaces (`shortcutEnabledFor`: input/select/textarea/contenteditable — the track-row time inputs keep it), and the Space branch preventDefaults so a focused button toggles the video exactly once.
- The footer no longer overlaps the timeline on enlarged previews. The stage-height clamp only knew the 75vh bound, which ignores the header, footer, paddings and the rest of the stage column — dragging to max pushed the transport bar and timeline into and past the footer (measured: timeline bottom at y=1431 on a 390×844 viewport). The clamp now also caps the stage at `innerHeight − reserved` where `reserved` is measured live (header + footer + #app-main vertical padding + every non-stage stage-column child including flex gaps); below the 220 px floor the min still wins by design.

### Verification

- Unit: 469 → 486 tests, all passing (14 files).
- Probe: `node tools/debug-regressions.mjs` (combined v1.6.1 field-regression probe on the real dist) — timeline seek accuracy (strip/axis/chip clicks), suppression latch, trim-then-seek, keyboard transport after clicking controls (incl. fullscreen + time-input exclusion), footer/timeline clearance at max stage height on 1280×800 and 390×844.
- E2E: 6/6 passing in Chromium (coordinator run).
- Gate: `npm run gate` (eslint 0 errors · tsc --noEmit 0 errors · unit suite · build) exits 0.

## [1.6.0] — 2026-10-29

A "✕ Clear" button that unloads the current video and resets the whole app to the landing view.

### Added

- Clear button (header, next to "Open another file"): aborts any in-flight analysis or export first (their stale callbacks are dropped via the generation counter), destroys the review editor (cancelling the preview frame loops and listeners), revokes the preview blob URL, unloads the video element (`src` removed + `load()` — decoder freed) and disposes the mediabunny `Input`, then sweeps any leftover OPFS export temp (`exports/redact-export-*`, the REQ-019/AC-14 hygiene on explicit clear). The file input is reset so re-selecting the SAME file fires `change` again, the stepper returns to the Capability-check gate via a new total `CLEAR` transition (legal from every step), and every panel returns to its landing state: capability report cleared, sensitivity sliders restored from a single `DEFAULT_SETTINGS()` factory (face 0.60 / plate 0.25, dashcam off), progress bars to 0, track list + timeline emptied, export status/progress cleared, transport reset (pause glyph, 1×, 0:00.0), toasts dismissed — confirmed with a "Cleared — ready for the next video." toast. The model cache (IndexedDB), the preview-stage height, the version badge and the model attribution panel survive a clear.

## [1.5.0] — 2026-10-29

Configurable detection sensitivity and a single-frame threshold comparison preview (SPEC-VID-002 amendments REQ-113/114).

### Added

- Configurable detection thresholds (REQ-113): the Analyze panel gains a "Detection sensitivity" group with face (0.10–0.90, default 0.60) and plate (0.05–0.90, default 0.25) sliders with live numeric readouts. The configured values flow into every `detectFace` / `detectPlate` call of the analyze pass — full-frame AND dashcam tile passes — and every re-analysis; the pre-1.5.0 baked gates (0.6 / 0.25) remain the defaults everywhere a setting is omitted (`DEFAULT_CONF_FACE` / `DEFAULT_CONF_PLATE`, per-call `opts.confThreshold` in detector.js).
- Single-frame threshold comparison (REQ-114): a "Compare thresholds" section in the Analyze panel decodes ONE frame at a user-chosen time (default `round(duration·0.1)`), runs each model EXACTLY once (new raw accessors `detectFaceRaw` / `detectPlateRaw` return the undecoded outputs so every level reuses the single inference), and renders five side-by-side panels at the fixed levels ≥0.15 / ≥0.30 / ≥0.45 / ≥0.60 / ≥0.75 — each panel showing the frame with its boxes (faces teal, plates violet) and a per-panel count caption. Clicking a panel applies that level to BOTH sensitivity sliders. The button shows a busy state while running and failures surface via toast; `sampleFrameAt()` (analyze.js) shares the analyze loop's decode seam and sample-closing discipline.

## [1.4.1] — 2026-10-29

### Fixed
- Track-row time fields overflowed the row on mobile (rendered 336px inside a 312px content box): the `.times` group is now pinned to exactly the row content width with zero-basis flexible inputs — no overflow, no clipped text at 390px (element-level probe `tools/debug-times-overflow.mjs`).

## [1.4.0] — 2026-10-29

Fullscreen-usable controls and a mobile-friendly single-column layout (SPEC-VID-002 amendments REQ-111/112).

### Added

- In-fullscreen overlay controls (REQ-111): an overlay control bar inside the preview stage — play/pause, frame step back/forward, playback speed, and an exit button — shown only in fullscreen / enlarged (zoom) modes so transport stays reachable while the stage fills the screen. Both bars call the same shared transport actions (`togglePlay` / `stepFrame` / `setSpeed` / `exitPreview`), so glyphs, speed selectors and behavior stay in lockstep with the existing bottom transport bar (whose `#transport-bar` / `#export-button` ids and behavior are unchanged). The bar auto-hides after ~3 s of interaction idle and reappears on any pointer/touch activity on the stage, the standard video-player pattern; entering fullscreen or zoom re-shows it with a fresh idle timer.
- Mobile-friendly layout (REQ-112): at viewport widths ≤ 820 px the app collapses to a single column — the right rail (tracks, export, attribution) stacks below the timeline — with ≥ 40 px touch targets on buttons/selects/inputs, flexible track-row time inputs, a smaller 48 vh default preview stage (the resize handle still overrides it), header/stepper compression, hidden footer keyboard hints, and no horizontal overflow at 390 px. Timeline chip-edge grab zones widen from 6 px to 14 px on coarse (touch) pointers so trims work with a fingertip.

## [1.3.1] — 2026-10-29

### Fixed
- Preview resize handle worked in the opposite direction: dragging DOWN now makes the video TALLER (the handle is the stage's bottom edge and follows the pointer). Keyboard parity unchanged (ArrowUp = taller). Direction pinned by unit tests.

## [1.3.0] — 2026-10-29

Track-time editing, distinct manual colors, and the trim-gesture fix (SPEC-VID-002 amendments REQ-108/109/110).

### Added

- Per-track start/end time inputs in the track list (REQ-108): each row exposes editable clock-format (`m:ss.s`) bounds committed on change/blur/Enter (Escape reverts); invalid input reverts to the current span. Editing routes through the same trim path as chip dragging (`onTrimTrack` → `trimTrack`), so the preview, timeline chips, row readout and export span update together. Rows reconcile in place on refresh, and the value of a focused input is never overwritten mid-edit.
- Distinct manual-region colors (REQ-109): manual tracks now take the same categorical 8-slot palette as auto tracks (`TRACK_COLORS[(id − 1) % 8]` — the exact tracker.js slot rule, so manual/auto never collide within a session) instead of a shared fixed alert red. Manual identity stays visible via the "Manual #N" label and a dashed chip outline.

### Fixed

- Chip-edge trim drags now start reliably, so the chip's rendered length updates live during the drag with the row span readout following it (REQ-110). Root cause (verified with a live pointer-event probe): the edge-grab hit test only matched INSIDE the chip span, and the trim gesture was wired to the chips layer — so on the most common chips (every manual region and any auto track spanning the whole video) the end edge sits exactly on the strip boundary, the pointerdown there hit-tests to the timeline strip instead of the chips layer, the drag never started, and the follow-up click seeked instead of trimming. Edge hit zones now extend ±6 px around each chip edge (grabbable from outside too) and the gesture is bound to the whole timeline strip; each pointermove re-renders the chip live (probe-measured: chip width changes ≥ 20 px mid-drag).

## [1.2.0] — 2026-10-29

Preview ergonomics follow-up to SPEC-VID-002: the preview stage is resizable.

### Added

- Draggable preview-height handle between the preview stage and the transport bar: drag it up/down to resize the preview (clamped to 220 px – 75% of the viewport height, recomputed while dragging), double-click to reset to the default height, and ArrowUp/ArrowDown on the focused handle steps ±24 px (`role="separator"` semantics with a live `aria-valuenow`). The stage height is driven by the `--stage-h` custom property and every change re-scales the pixel-truthful overlay through the editor's existing `redraw()` path — the same seam as fullscreen/zoom.

## [1.1.0] — 2026-10-29

SPEC-VID-002 — review UX & manual redaction enhancements from real-world field feedback.

### Added

- Solid redaction style: per-track `pixelate` / `solid` (opaque black) choice in the track list, defaulted to solid for manual regions and pixelate for auto-detected tracks; both styles burn through the same shared preview/export seam (`track.style` + per-track dispatch in `redact.pixelateFrame`) (REQ-101, AC-102/103).
- Manual regions now span the entire video by default, with draggable timeline-chip edge handles (≤ 6 px hit zones) to trim the start/end and a 0.1 s minimum span — manual regions are fixed boxes, no motion tracking (REQ-103, AC-101).
- Transport bar under the preview: jump-to-start, frame-step back/forward (±1 source frame, matching the keyboard shortcuts), play/pause with a live glyph swap, playback speed selector (0.25×–4×) and a current/total timecode readout; all keyboard shortcuts keep working (REQ-105, AC-104).
- Fullscreen / enlarge preview control: native Fullscreen API where available, with an in-page viewport-covering fallback (`.preview-zoom`) and an always-visible exit control where it is not (iOS Safari); the preview overlay re-sizes to the enlarged display on enter/exit (REQ-106, AC-105).
- Portrait-aware dashcam tiling: portrait frames tile vertically into stacked rows so small faces/plates reach ≥ ~2× the model-input scale (detector change; landscape tiling and single-coordinate merge unchanged) (REQ-107, AC-106).
- Discoverability hint next to the timeline: pause and drag a box on the video to cover anything detection missed.

### Fixed

- Portrait video dashcam tiling was a no-op: the horizontal-only tile split produced a single tile (k=1) for portrait frames, so dashcam mode did nothing exactly where it was needed most — small faces in portrait phone footage now get real tile-scale magnification (miss analysis 2026-10-29).

## [1.0.0] — 2026-10-29

Initial release — SPEC-VID-001: client-side video redaction web app (faces & license plates, pixelate burn-in, nothing uploaded).

### Added

- Local file intake (`.mov` / MP4 / WebM, including iPhone HEVC and ProRes via `@mediabunny/prores` 1.63.0) with a pre-analyze capability report: container/codec/resolution/fps/duration/audio/rotation plus per-track decode and export-encode probes; undecodable input is blocked with actionable guidance (REQ-001…003).
- Serve-over-localhost gate: under `file://` all processing is disabled with copy-paste serve instructions (REQ-004).
- Detection: YuNet 2023mar faces (640×640 letterboxed) + YOLOv9-t-640 end-to-end license plates via onnxruntime-web 1.31.1; WebGPU → WASM execution-provider ladder, WASM directly on WebKit; optional "Dashcam mode" tiled second pass (REQ-005, 008, 010).
- Tracking: IoU-gated association with a constant-velocity Kalman filter, stable labels ("Face #1", "Plate #4"), gap interpolation on a dense 1/30 s grid, ±5-frame-period span padding and 15% box dilation before redaction — no unredacted frame of a detected object is exportable (REQ-006, 007).
- Model delivery: pinned CDN URLs with download progress, IndexedDB byte cache (`model@version`), fully offline after first run (REQ-011).
- Review editor: box/label/color overlay synced to the displayed frame, timeline chips spanning each redacted range (click = seek), per-track redact/keep-visible toggles, manual drawn regions, pixel-truthful preview sharing the export burn-in code path (REQ-012…016).
- Export: burn-in re-encode with a codec fallback ladder (H.264/MP4 hardware → H.264 software → VP9/WebM), audio packets copied bit-for-bit (AAC → MP4, Opus/Vorbis → WebM), streaming output to OPFS/File System Access with progress, cancellation, temp cleanup and crash-recovery sweep (REQ-017…019, 021).
- Single-file artifact: `dist/index.html` (~122 KiB) with pinned exact-version CDN importmap, built by `tools/inline.mjs` (build fails on any leaked dev-module reference) and stamped with the version + build date (REQ-020).
- Readable, stage-specific errors with recovery actions for decode/encode/inference failures; no silently corrupted output (REQ-021).
- Test suites: 310 unit tests (12 files, vitest) and 6 Playwright E2E tests across 5 specs — smoke (2), full journey (in-page re-decode burn-in assertion + AAC preservation), auto-detect with real YuNet inference, offline model cache, corrupt-input handling.

### Verification

- Unit: 303 → 310 tests, all passing (12 files).
- E2E: 6/6 passing in Chromium.
- Coverage: v8 gate ≥ 85% lines on all 8 logic modules (analyze 85.5, capability 96.9, detector 99.4, exporter 100, ingest 95.7, models 94.2, redact 92, tracker 100).
- Gate: `npm run gate` (eslint 0 errors · tsc --noEmit 0 errors · unit suite · build) exits 0.

### Fixed

- YuNet inference produced zero detections on real photos: the 2023mar graph requires raw 0–255 BGR input (not normalized RGB) and its cls/obj heads are already sigmoid'ed in-graph, so the previous extra JS sigmoid squashed a 0.96 face below the 0.6 threshold — fixed to 0–255 BGR with geometric-mean scoring per the OpenCV `FaceDetectorYN` reference; regression-pinned and live-verified (confidence 0.936 through the production path).
- Plate model URL: the canonical GitHub release asset sends no CORS headers on any redirect hop, making it unfetchable from a browser — switched to a Hugging Face mirror serving the same bytes (size-pinned) with CORS `*`.
- Export delivery race: the Blob download could be canceled by premature deletion of the OPFS staging temp — temp cleanup now happens strictly after delivery or cancellation.
- Preview dilation parity: the editor preview did not dilate redaction boxes exactly like the export burn-in — both paths now share the same `redact.pixelateFrame` seam, keeping the preview pixel-truthful.
