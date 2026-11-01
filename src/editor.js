/**
 * editor.js — REQ-012/013/014/015 + SPEC-VID-002 REQ-101/103 + v1.3.0
 * REQ-108/109/110 (design.md §3, §4.7). @MX:ANCHOR (preview burns through the
 * SAME redact.pixelateFrame the export burn-in uses — pixel-truthful preview,
 * REQ-016 / AC-04).
 *
 * Review-editor module, split in two halves:
 *
 *   1. PURE timeline model functions (fully unit-tested in
 *      tests/unit/timeline.test.js — no DOM, run in the node environment):
 *        renderTimeline()      → chips view model + playhead percentage
 *        hitTestTimeline()     → { track, zone } | null (chip edge zones,
 *                                REQ-103 + v1.3.0 REQ-110 outward zones)
 *        effectiveEdgePx()     → edge-zone width for a pointer kind
 *                                (v1.4.0 REQ-112: 6 px fine, 14 px touch)
 *        timelineTimeAt()      → seek time for a pointer x on the axis
 *                                (v1.6.1 REG-1)
 *        timelinePointerAction() → pointerdown/up gesture verdict
 *                                ('trim-end'|'trim-start'|'seek'|'none',
 *                                v1.6.2: seek fires on pointerup)
 *        CLICK_SEEK_MAX_DRAG_PX  tap-vs-drag movement threshold (REG-1)
 *        thumbLeftPct()        → scrub-thumb left % (v1.7.0; shares the
 *                                playhead clamp-and-scale rule)
 *        thumbAriaValue()      → scrub-thumb aria-valuenow seconds (v1.7.0)
 *        thumbPinSettled()     → has the post-release seek landed? (v1.8.0
 *                                release-pin seam; THUMB_PIN_EPSILON_S;
 *                                v1.9.0 pairs it with the hard THUMB_PIN_MS
 *                                deadline — deadline OR settled, whichever
 *                                first, so the pin can never latch forever)
 *        THUMB_PIN_MS          → release-pin max lifetime, ms (v1.9.0)
 *        toggleTrack()         → immutable enabled-flip (REQ-014)
 *        trimTrack()           → immutable span trim (SPEC-VID-002 REQ-103)
 *        setTrackStyle()       → immutable style flip (SPEC-VID-002 REQ-101)
 *        tracksAtForView()     → thin wrapper over redact.tracksAt
 *        manualTrackFromBox()  → manual Track factory (REQ-015 + REQ-103 +
 *                                REQ-109 palette colors; v1.22.0 REQ-201:
 *                                the box keys AT the drawn time)
 *        interpolateBetween()  → linear box lerp between two keyed samples
 *                                (v1.22.0 REQ-201 sparse-keyframe model)
 *        interpolatedBoxAt()   → a track's interpolated box at t (REQ-201;
 *                                null outside the span)
 *        upsertKeyframe()      → immutable keyframe upsert at the playhead
 *                                (v1.22.0 REQ-201 K action)
 *        densifyManualTracks() → sparse manual keyframes → 1/30 s dense
 *                                interpolated maps (v1.22.0 REQ-201: the
 *                                preview/export consumer-boundary upgrade)
 *        KEYFRAME_DENSE_STEP_S → that grid's step (mirrors tracker)
 *        parseClockInput()     → "m:ss.s" / "ss.s" text → seconds|null
 *                                (REQ-108)
 *        formatSpan()          → "0:04.2 – 0:07.8" readout (REQ-108)
 *        normalizeView()       → safe {start, end} view window (v1.22.0
 *                                REQ-204; missing view → full clip)
 *        isZoomed()            → is the view window actually zoomed?
 *        pctToTime()/timeToPct() → view-window ⇄ strip-percentage mapping
 *                                (0–100, the ONE rule every renderer shares)
 *        zoomWindow()          → anchor-preserving zoom (REQ-204; clamps
 *                                span ≥ MIN_VIEW_SPAN_S, window in [0, dur])
 *        panWindow()           → span-preserving pan (REQ-204)
 *        zoomStep()/fitWindow() → the +/- and Fit button models
 *        MIN_VIEW_SPAN_S / ZOOM_WHEEL_FACTOR → zoom constants (REQ-204)
 *
 *   2. Thin DOM adapters (guarded, NOT unit-tested — node has no DOM):
 *        mountEditor()    → wire playback/overlay sync + timeline events
 *        beginManualBox() → pointer-drag rectangle on the overlay canvas
 *
 * The editor NEVER owns AppState: it reads via `hooks.getState()` and emits
 * mutations via `hooks.onToggle / onSeek / onManualBox / onTrimTrack /
 * onSetStyle / onKeyframe / onSelectTrack / onRescanTrack` (main.js's stepper
 * state machine persists them; the last three are v1.22.0 and optional —
 * guarded like the rest).
 *
 * ---------------------------------------------------------------------------
 * INTERACTION MAP (review step; design-direction "signature element")
 * ---------------------------------------------------------------------------
 *
 *   Timeline (#timeline strip, single-lane chips):
 *     press + release (pointerup, ≤ CLICK_SEEK_MAX_DRAG_PX movement)
 *                      → onSeek(time under pointer)      — chip, bare rail,
 *                        timecode labels (clamped to the ends). v1.6.2: the
 *                        seek fires on POINTERUP, not `click` — WebKit never
 *                        fires click on plain divs for touch, so taps were
 *                        dead on iOS Safari. The decision (tap vs drag vs
 *                        chip-edge trim) is the PURE timelinePointerAction.
 *                        The time maps through the CHIPS-layer rect (the axis
 *                        the chips and playhead live in — v1.6.1 REG-1).
 *     dblclick on chip → hitTestTimeline → onToggle(id, !enabled)
 *                        (the two preceding taps also seek — harmless)
 *     drag a chip EDGE (± 6 px zone; ± 14 px on touch — REQ-112)
 *                        → onTrimTrack(id, start, end)
 *                        (chip-edge hit zones from hitTestTimeline; zones
 *                        extend OUTWARD past the edge too — REQ-110: the
 *                        visible edge line of a full-span chip sits on the
 *                        strip boundary, where a pointerdown would otherwise
 *                        land on #timeline and never start the drag). The
 *                        gesture is wired to the whole #timeline strip and
 *                        maps the pointer through the chips-layer rect. Each
 *                        pointermove re-emits the span → onTrimTrack →
 *                        refresh → the chip length and the row span readout
 *                        update LIVE. A release on an edge zone (an edge tap,
 *                        zero movement) is a trim-side no-op — never a seek.
 *                        Drags from a chip body or bare rail never trim, and
 *                        any press→release that moved further than the
 *                        threshold never seeks (body is not a scrubber).
 *     drag the scrub THUMB (#timeline-thumb, v1.7.0)
 *                        → LIVE scrub: pointerdown stopPropagation (the strip
 *                          gesture above never owns a thumb press — no trim
 *                          latch, no tap verdict), setPointerCapture, then
 *                          pointermove maps the pointer through the CHIPS-layer
 *                          rect (timelineTimeAt) and seeks THROTTLED (~50 ms);
 *                          pointerup fires the exact endpoint seek. The thumb
 *                          follows the pointer live (the drag owns its position
 *                          until release). A still tap on the thumb lands the
 *                          endpoint seek at the playhead's own position — a
 *                          harmless no-op.
 *                          v1.8.0 desktop-mouse fixes: (a) RELEASE PIN — the
 *                          drag guard drops before the endpoint seek completes,
 *                          so the frame loop re-derived the thumb from stale
 *                          video.currentTime and yanked it back until `seeked`
 *                          (visible seek latency on desktop = "the handle
 *                          doesn't stick"); the release point is now pinned
 *                          (thumbPinSettled seam) until the seek lands. (b)
 *                          CAPTURE NET — the move/up/cancel handlers are
 *                          mirrored on window for the gesture's lifetime and
 *                          drive the same drag whenever the event target is
 *                          NOT the thumb, so a silently failed
 *                          setPointerCapture (cursor outruns the 20 px thumb
 *                          → drag dies mid-gesture) can no longer kill a drag.
 *     keyboard on the focused thumb (role="slider")
 *                        → ←/→ ±1 frame via hooks.onStepFrame (the SAME step
 *                          math as the transport buttons; falls back to ±1/30 s
 *                          seek when the hook is absent), ↑/↓ ±1 s via onSeek;
 *                          handled keys stopPropagation so the doc-level
 *                          shortcuts never double-fire, unhandled keys bubble.
 *
 *   Track list (#track-list rows, rendered by the editor):
 *     checkbox change  → onToggle(trackId, checked)
 *     style select     → onSetStyle(trackId, 'pixelate'|'solid')  (REQ-101)
 *     start/end input  → parseClockInput → onTrimTrack(id, start, end)
 *                        (REQ-108: committed on change/blur/Enter; invalid
 *                        input reverts to the model value; rows reconcile
 *                        in place and a focused input's value is never
 *                        overwritten by a refresh)
 *     row click        → onSeek(track.start clamped)     — checkbox/select/
 *                                                          inputs excluded
 *
 *   Preview stage (manual region, REQ-015 — keyboard "B" is wired by main.js,
 *   which then calls beginManualBox or routes into onManualBox on commit):
 *     drag on #overlay-canvas → rubber band → onManualBox(box, t)
 *                             (box in native display px; t = video.currentTime)
 *     Escape           → cancel the in-progress drag
 *     v1.22.0 REQ-201 keyframing — while a MANUAL track is SELECTED (row
 *     click → onSelectTrack; getState().selectedTrackId), a drawn box does
 *     NOT create a new track: it arms a PENDING keyframe (kept visible as
 *     the dashed overlay box). K (editor window keydown, typing-surface
 *     guarded) commits it AT THE CURRENT PLAYHEAD → onKeyframe(trackId, box,
 *     t) — main.js upserts through the pure upsertKeyframe. B draws, K
 *     commits at the playhead. Escape clears the pending box. The selected
 *     track's keyframes render as .kf-marker diamonds in the chips layer.
 *
 *   Playback sync: one loop via requestVideoFrameCallback (rAF fallback):
 *     per presented frame → draw the video frame into the overlay canvas,
 *     pixelateFrame (the shared export burn-in seam) for every enabled
 *     tracksAt hit, drawOverlay for ALL tracks (enabled solid strokes +
 *     disabled dashed "visible"), then move the playhead. Scrub → 'seeked'
 *     event redraws once; handle.redraw() re-sizes/re-draws after layout
 *     changes (fullscreen/zoom/viewport resize — wired by main.js).
 *     v1.8.1: a `timeupdate` listener drives updatePlayhead (position only —
 *     never the canvas draw) as a media-event fallback, because rVFC fires
 *     ONLY when the compositor presents frames and some browser/GPU/window
 *     states never present during playback → playhead + thumb froze at 0%
 *     for a whole clip (field report) while the transport readout — driven
 *     by main.js's own `timeupdate` listener — stayed live.
 *
 * IMPORT-TIME SAFETY: no DOM access at import time (vitest imports this file
 * in the node environment). Every DOM access inside the adapters is guarded —
 * mountEditor(null, null) and beginManualBox(null, null) are no-ops.
 */
import './types.js';
import { tracksAt, pixelateFrame, drawOverlay } from './redact.js';
import { TRACK_COLORS } from './tracker.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum redacted span for a manual track after trimming, seconds (REQ-103):
 * a chip can never be squeezed out of existence by dragging its edges.
 * @type {number}
 */
export const MIN_TRACK_SPAN_S = 0.1;

/**
 * Half-width of a chip's draggable edge zone on the timeline, CSS px
 * (REQ-103: "≤ 6 px edge hit zones").
 * @type {number}
 */
export const CHIP_EDGE_PX = 6;

/**
 * Chip-edge half-width on coarse pointers (touch), CSS px (v1.4.0 REQ-112):
 * a fingertip needs roughly double the grab zone of a 6 px mouse cursor.
 * @type {number}
 */
export const CHIP_EDGE_PX_COARSE = 14;

/**
 * Effective chip-edge half-width for a pointer kind. PURE — unit-testable
 * seam; mountEditor resolves `coarse` once from matchMedia('(pointer: coarse)')
 * and passes the result everywhere it calls hitTestTimeline (whose own
 * default-parameter behavior stays on the fine-grained CHIP_EDGE_PX).
 *
 * @param {boolean} coarse True on coarse pointers (touch).
 * @returns {number} Edge-zone half-width, CSS px (fine → 6, coarse → 14).
 */
export function effectiveEdgePx(coarse) {
  return coarse === true ? CHIP_EDGE_PX_COARSE : CHIP_EDGE_PX;
}

/**
 * Movement (CSS px) along the timeline axis above which a strip
 * pointerdown/up pair counts as a DRAG, not a tap — a drag released on the
 * strip must never seek (v1.6.1 REG-1: "click-seek on pointerup only if the
 * movement is under the threshold"). Sits between the fine (6 px) and coarse
 * (14 px) edge zones so an edge-grab wiggle never degenerates into a seek.
 * @type {number}
 */
export const CLICK_SEEK_MAX_DRAG_PX = 8;

/**
 * Map a pointer x on the timeline to a seek time. PURE (v1.6.1 REG-1 seam,
 * unit-tested): x/width → fraction of `durationSec`, clamped into
 * [0, durationSec] — clicks on the timecode labels or strip padding seek to
 * the ends. A degenerate width or duration yields 0 (never NaN).
 *
 * The axis rect MUST be the chips layer (#timeline-track / #track-chips — the
 * space hitTestTimeline maps and the playhead is positioned in), not the full
 * #timeline strip: mapping through the strip made every seek land off the
 * clicked point by the combined width of the timecodes + padding (up to
 * ~10% of the video — the field-reported "clicking no longer jumps where I
 * click").
 *
 * @param {number} x Pointer x within the axis rect, CSS px.
 * @param {number} width Axis rect width, CSS px (same space as `x`).
 * @param {number} durationSec Video duration (> 0).
 * @returns {number} Seek time in seconds, clamped.
 */
export function timelineTimeAt(x, width, durationSec) {
  if (!(width > 0) || !(Number.isFinite(durationSec) && durationSec > 0)) return 0;
  const t = ((Number.isFinite(x) ? x : 0) / width) * durationSec;
  return Math.min(Math.max(t, 0), durationSec);
}

/**
 * Verdict for a completed strip pointer gesture (pointerdown → pointerup).
 * PURE (v1.6.2 seam, unit-tested) — the pointerup handler resolves it:
 *
 *   'trim-end' | 'trim-start'  the press latched a chip-edge zone (the edge
 *                              flags come from the pointerdown hit test) —
 *                              the trim drag owns the gesture, and an
 *                              edge TAP (zero movement) is a trim-side
 *                              no-op, never a seek;
 *   'seek'                     a tap: the release landed within `maxDrag`
 *                              of the press along the timeline axis;
 *   'none'                     anything else (a drag released on the strip
 *                              must never seek — v1.6.1 REG-1).
 *
 * WebKit note (v1.6.2): the seek previously rode the `click` event, which
 * Safari never fires on plain divs for touch — finger taps on the timeline
 * were dead on iOS. Moving the decision to pointerup serves both pointer
 * kinds through this one path (a mouse tap is a pointerdown/up pair too).
 * Movement is measured along the strip's axis (x) only: with
 * touch-action: none on #timeline a vertical slip stays part of the tap
 * gesture (no scroll takeover), so it no longer cancels a seek.
 *
 * @param {number} startX Pointerdown client x, CSS px.
 * @param {number} endX Pointerup client x, CSS px.
 * @param {boolean} edgeLeft The press landed in a chip's 'start' edge zone.
 * @param {boolean} edgeRight The press landed in a chip's 'end' edge zone.
 * @param {number} maxDrag Max release offset that still counts as a tap
 *     (CLICK_SEEK_MAX_DRAG_PX). Non-finite/negative → 'none' (never seek on
 *     garbage); non-finite coordinates degrade to 0 (same convention as
 *     timelineTimeAt).
 * @returns {'trim-end'|'trim-start'|'seek'|'none'} The gesture verdict.
 */
export function timelinePointerAction(startX, endX, edgeLeft, edgeRight, maxDrag) {
  if (edgeRight) return 'trim-end';
  if (edgeLeft) return 'trim-start';
  const dx = Math.abs(
    (Number.isFinite(endX) ? endX : 0) - (Number.isFinite(startX) ? startX : 0),
  );
  return Number.isFinite(maxDrag) && maxDrag >= 0 && dx <= maxDrag ? 'seek' : 'none';
}

/**
 * Left position (%) of the scrub-handle thumb for a playback time (v1.7.0).
 * PURE — the same clamp-and-scale rule renderTimeline applies to the playhead,
 * extracted so the thumb, the playhead line and the drag/keyboard paths share
 * ONE mapping (thumbLeftPct(t, d) === renderTimeline([], d, t).playheadPct).
 *
 * @param {number} currentTimeSec Playback time, seconds.
 * @param {number} durationSec Video duration (> 0; 0/NaN → 0%).
 * @returns {number} 0–100, clamped; non-finite time or duration → 0.
 */
export function thumbLeftPct(currentTimeSec, durationSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (dur <= 0 || !Number.isFinite(currentTimeSec)) return 0;
  const clamped = Math.min(Math.max(currentTimeSec, 0), dur);
  return (clamped / dur) * 100;
}

/**
 * The scrub-handle thumb's `aria-valuenow` (v1.7.0): the playback position in
 * seconds. PURE — non-finite or negative input degrades to 0 (an ARIA value
 * must never be NaN; the upper bound lives in the separate `aria-valuemax`).
 *
 * @param {number} currentTimeSec Playback time, seconds.
 * @returns {number} Finite, non-negative seconds.
 */
export function thumbAriaValue(currentTimeSec) {
  return Number.isFinite(currentTimeSec) && currentTimeSec > 0 ? currentTimeSec : 0;
}

/**
 * How close the displayed time must be to the thumb's pinned release point
 * before the release pin self-clears, seconds (v1.8.0). A seek is "landed"
 * when currentTime reaches its target; the epsilon absorbs float drift and
 * the last sub-frame of decoder rounding. Well under one rendered frame at
 * any sane fps, and far below any real seek latency.
 * @type {number}
 */
export const THUMB_PIN_EPSILON_S = 0.05;

/**
 * Hard deadline of the post-release thumb pin, ms (v1.9.0). v1.8.0 made the
 * pin purely condition-based (`seeked` clears it, or the displayed time
 * settles within THUMB_PIN_EPSILON_S) — an unreproducible field failure
 * showed both conditions never passing on one machine (thumb frozen during
 * playback while the timecode advanced), so the pin now ALSO expires
 * unconditionally after this long: suppression ends at the deadline OR when
 * the seek lands, whichever comes first. 350 ms covers real desktop seek
 * latency while staying far below a user-noticeable "frozen thumb" window.
 * @type {number}
 */
export const THUMB_PIN_MS = 350;

/**
 * Has the post-release endpoint seek reached the pinned release point?
 * PURE (v1.8.0 seam, unit-tested) — updateThumb consults this to decide
 * whether a stale displayTime may move the thumb again.
 *
 * v1.8.0 desktop fix: onThumbPointerUp releases the drag guard BEFORE the
 * endpoint seek completes, so until `seeked` fires, video.currentTime still
 * reads the PRE-drag position — every frame loop tick re-derived the thumb
 * from it and visibly yanked the handle back off the release point (read as
 * "the scrub handle doesn't work" on desktop browsers/hardware where seek
 * latency is tens-to-hundreds of ms; headless seeks are sub-frame and hid
 * it). While the release pin is set, updateThumb steps aside until EITHER
 * `seeked` fires OR this predicate reports the displayed time has caught up.
 *
 * v1.9.0: the runtime pin is TIME-BOXED (THUMB_PIN_MS deadline — see
 * updateThumb); this predicate remains the settled-side of the "deadline OR
 * settled, whichever first" rule and stays exported because tests (and any
 * embedder reusing the pin) reference it.
 *
 * Non-finite input is "settled" — there is nothing meaningful to guard, and
 * a pin that can never be compared must never wedge the thumb.
 *
 * @param {number} pinnedTimeSec The release-point time the thumb was left at.
 * @param {number} currentTimeSec The currently displayed time.
 * @returns {boolean} True when the seek has landed (or can't be compared).
 */
export function thumbPinSettled(pinnedTimeSec, currentTimeSec) {
  if (!Number.isFinite(pinnedTimeSec) || !Number.isFinite(currentTimeSec)) return true;
  // Millisecond precision: binary-float noise (2 − 0.05 → 0.05000…004) must
  // never flip the verdict at the epsilon boundary.
  const driftMs = Math.round(Math.abs(currentTimeSec - pinnedTimeSec) * 1000);
  return driftMs <= THUMB_PIN_EPSILON_S * 1000;
}

// ---------------------------------------------------------------------------
// PURE: view window — zoom/pan mapping (v1.22.0 REQ-204)
// ---------------------------------------------------------------------------

/**
 * Smallest view span zoomWindow can produce, seconds (v1.22.0 REQ-204): the
 * zoom can never squeeze the window below this — a sub-frame window would
 * make chip/edge interaction impossible.
 * @type {number}
 */
export const MIN_VIEW_SPAN_S = 0.5;

/**
 * Per-notch zoom factor of the ctrl/cmd+wheel gesture (v1.22.0 REQ-204).
 * @type {number}
 */
export const ZOOM_WHEEL_FACTOR = 1.2;

/**
 * Normalize a view window into a safe `{start, end}` pair. PURE. A missing
 * (undefined/null) view is the FULL window over `durationSec`; a non-finite
 * bound degrades to that side's full-window bound; a finite duration clamps
 * both bounds into [0, durationSec]. A degenerate window (inverted or
 * zero-width) resets to the FULL window. No usable duration (≤ 0/NaN)
 * yields {0, 0} — the "no metadata" view every downstream mapping guards
 * with `end > start`.
 *
 * @param {{start?: number, end?: number} | null | undefined} view
 * @param {number} durationSec Video duration.
 * @returns {{start: number, end: number}}
 */
export function normalizeView(view, durationSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!(dur > 0)) return { start: 0, end: 0 };
  let start = view && Number.isFinite(view.start) ? view.start : 0;
  let end = view && Number.isFinite(view.end) ? view.end : dur;
  start = Math.min(Math.max(start, 0), dur);
  end = Math.min(Math.max(end, 0), dur);
  if (!(end > start)) return { start: 0, end: dur };
  return { start, end };
}

/**
 * Is the view window actually zoomed (span < duration − epsilon)? PURE.
 * A missing/degenerate view or duration counts as NOT zoomed.
 *
 * @param {{start: number, end: number} | null | undefined} view
 * @param {number} durationSec
 * @returns {boolean}
 */
export function isZoomed(view, durationSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!(dur > 0)) return false;
  const v = normalizeView(view, dur);
  return v.end - v.start < dur - 1e-9;
}

/**
 * Map a strip percentage (0–100, the pctToTime/timeToPct unit) to a time
 * inside the view window. PURE. pct clamps into [0, 100]; a degenerate view
 * (end ≤ start) resolves to view.start (never NaN).
 *
 * @param {number} pct 0–100 within the view.
 * @param {{start: number, end: number} | null | undefined} view
 * @returns {number} Seconds.
 */
export function pctToTime(pct, view) {
  const start = view && Number.isFinite(view.start) ? view.start : 0;
  const end = view && Number.isFinite(view.end) ? view.end : 0;
  if (!(end > start)) return start;
  const p = Number.isFinite(pct) ? Math.min(Math.max(pct, 0), 100) : 0;
  return start + (p / 100) * (end - start);
}

/**
 * Map a time to its strip percentage (0–100) inside the view window. PURE —
 * the ONE clamp-and-scale rule every view-window renderer (chips, regions,
 * playhead, thumb, keyframe markers, waveform) shares. `t` clamps into the
 * view; a degenerate view yields 0.
 *
 * @param {number} t Seconds.
 * @param {{start: number, end: number} | null | undefined} view
 * @returns {number} 0–100.
 */
export function timeToPct(t, view) {
  const start = view && Number.isFinite(view.start) ? view.start : 0;
  const end = view && Number.isFinite(view.end) ? view.end : 0;
  if (!(end > start)) return 0;
  const clamped = Number.isFinite(t) ? Math.min(Math.max(t, start), end) : start;
  return ((clamped - start) / (end - start)) * 100;
}

/**
 * Anchor-preserving zoom of the view window (v1.22.0 REQ-204). PURE — the
 * time under `anchorPct` (0–100 strip %, the cursor for wheel zoom) stays
 * FIXED while the span scales by 1/factor. The new span clamps into
 * [MIN_VIEW_SPAN_S, durationSec]; the window then clamps into
 * [0, durationSec] preserving the clamped span (an anchor run past an edge
 * slides the window instead of overshooting). Garbage factor → 1 (no-op);
 * degenerate duration/view → the full window.
 *
 * @param {{start: number, end: number}} view Current view window.
 * @param {number} factor Zoom factor (> 1 zooms in; 0 < f < 1 zooms out).
 * @param {number} anchorPct Anchor position on the strip, 0–100.
 * @param {number} durationSec Video duration (> 0).
 * @returns {{start: number, end: number}} New view window.
 */
export function zoomWindow(view, factor, anchorPct, durationSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!(dur > 0)) return { start: 0, end: 0 };
  const v = normalizeView(view, dur);
  const span = v.end - v.start;
  if (!(span > 0)) return { start: 0, end: dur };
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const anchor = pctToTime(anchorPct, v);
  const nextSpan = Math.min(Math.max(span / f, MIN_VIEW_SPAN_S), dur);
  const leftFrac = Math.min(Math.max((anchor - v.start) / span, 0), 1);
  let start = anchor - nextSpan * leftFrac;
  let end = start + nextSpan;
  if (start < 0) {
    start = 0;
    end = nextSpan;
  } else if (end > dur) {
    end = dur;
    start = Math.max(0, dur - nextSpan);
  }
  return { start, end };
}

/**
 * Pan the view window by `deltaSec` (v1.22.0 REQ-204). PURE — both edges
 * shift equally (span preserved) and the window clamps into [0, durationSec]
 * without overshoot. Garbage delta → unchanged window (new object).
 *
 * @param {{start: number, end: number}} view Current view window.
 * @param {number} deltaSec Shift in seconds (positive = later).
 * @param {number} durationSec Video duration (> 0).
 * @returns {{start: number, end: number}} New view window.
 */
export function panWindow(view, deltaSec, durationSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!(dur > 0)) return { start: 0, end: 0 };
  const v = normalizeView(view, dur);
  const span = v.end - v.start;
  const d = Number.isFinite(deltaSec) ? deltaSec : 0;
  const start = Math.min(Math.max(v.start + d, 0), Math.max(0, dur - span));
  return { start, end: start + span };
}

/**
 * One zoom-step for the +/- buttons (v1.22.0 REQ-204): zoomWindow with a
 * center anchor. PURE. `anchorPct` defaults to 50 (strip % — the pctToTime
 * unit; the task spec's 0.5 shorthand would be 0.5% here, so the pct-unit
 * default of 50 IS the intended center anchor).
 *
 * @param {{start: number, end: number}} view Current view window.
 * @param {number} factor Zoom factor.
 * @param {number} [anchorPct] Anchor, 0–100 (default 50 = center).
 * @param {number} [durationSec] Video duration (clamps the result).
 * @returns {{start: number, end: number}} New view window.
 */
export function zoomStep(view, factor, anchorPct = 50, durationSec) {
  return zoomWindow(view, factor, anchorPct, durationSec);
}

/**
 * Reset the view to the FULL clip (v1.22.0 REQ-204, the Fit button). PURE —
 * a non-positive duration yields {0, 0} (the editor's "no metadata" view).
 *
 * @param {number} durationSec Video duration.
 * @returns {{start: number, end: number}}
 */
export function fitWindow(durationSec) {
  return normalizeView(null, durationSec);
}

/** Manual-drag rubber band (REQ-109: manual tracks themselves use the
 * categorical palette — alert red stays on the in-progress rubber band). */
const ALERT_RED = '#E5484D';
/** Grey veil over a frame whose time sits inside a trim region (REQ-125). */
const TRIM_VEIL = 'rgba(128, 128, 128, 0.45)';
/** "Keep visible" chips (design-direction.md safe green). */
const SAFE_GREEN = '#3ECF8E';
/** Drags smaller than this (canvas px) are clicks, not boxes. */
const MIN_DRAG_PX = 2;

/**
 * Read a track's redaction style (SPEC-VID-002 REQ-101 contract: `track.style`
 * is `'pixelate' | 'solid'`, auto default 'pixelate', manual default 'solid').
 * Tracks authored before the style field existed (or missing it) degrade to
 * 'pixelate' — the SPEC-VID-001 behavior.
 * @param {import('./types.js').Track} track
 * @returns {'pixelate'|'solid'}
 */
function styleOf(track) {
  return /** @type {{style?: unknown}} */ (/** @type {unknown} */ (track)).style === 'solid'
    ? 'solid'
    : 'pixelate';
}

// ---------------------------------------------------------------------------
// PURE: renderTimeline — chips view model + playhead (REQ-013, AC-18)
// ---------------------------------------------------------------------------

/**
 * Compute the timeline view model: one chip per track spanning its redacted
 * range as percentages of `durationSec`, plus the playhead percentage.
 * PURE — no DOM, no mutation; the caller maps chips onto #track-chips.
 *
 * v1.22.0 REQ-204: the optional `view` window (`{start, end}` seconds) makes
 * every percentage VIEW-relative — chips/playhead map through timeToPct, so
 * a zoomed window magnifies the strip around the visible span. Omitted /
 * null / degenerate views degrade to the FULL window, which is
 * pixel-identical to the pre-REQ-204 math (the existing full-view numbers
 * are pinned by tests). Chip spans outside the view clamp to the view edges;
 * a chip fully outside produces a zero-width chip the DOM renderer skips.
 *
 * Chips keep the track's categorical `color` even when disabled; renderers
 * use `enabled === false` to apply the safe-green/dimmed state instead
 * (design-direction.md: safe green = keep visible).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} durationSec Video duration (> 0; 0/NaN → everything at 0%).
 * @param {number} currentTimeSec Playhead position (clamped to the view).
 * @param {{start: number, end: number} | null} [view] View window
 *     (v1.22.0 REQ-204; omitted → full clip).
 * @returns {{chips: Array<{track: import('./types.js').Track,
 *                            startPct: number, endPct: number,
 *                            color: string, enabled: boolean}>,
 *            playheadPct: number}}
 *     Chip spans are clamped to the view window; zero/negative duration puts
 *     every percentage at 0 (never NaN/Infinity).
 */
export function renderTimeline(tracks, durationSec, currentTimeSec, view) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  const v = normalizeView(view, dur);
  /** Clamp a seconds value into the view and express it as a percentage. */
  const pct = (sec) => {
    if (!(v.end > v.start) || !Number.isFinite(sec)) return 0;
    const clamped = Math.min(Math.max(sec, v.start), v.end);
    return ((clamped - v.start) / (v.end - v.start)) * 100;
  };
  const chips = (Array.isArray(tracks) ? tracks : []).map((track) => ({
    track,
    startPct: pct(track.start),
    endPct: pct(track.end),
    color: track.color,
    enabled: track.enabled,
  }));
  return { chips, playheadPct: pct(currentTimeSec) };
}

// ---------------------------------------------------------------------------
// PURE: trimRegionViews — greyed trim-region view model (v1.15.0 REQ-125)
// ---------------------------------------------------------------------------

/**
 * Compute the trim-region view model: one greyed overlay per trim region
 * (v1.15.0 REQ-125) spanning its range as percentages of `durationSec`.
 * PURE — no DOM; the caller maps the views onto the #trim-regions layer.
 * v1.22.0 REQ-204: the optional `view` window makes the percentages
 * view-relative (omitted → full clip, identical numbers).
 *
 * @param {Array<{id: number, start: number, end: number}>} trims Trim
 *     regions (sorted, non-overlapping — main.js's pure model).
 * @param {number} durationSec Video duration (> 0; 0/NaN → no views).
 * @param {{start: number, end: number} | null} [view] View window
 *     (v1.22.0 REQ-204; omitted → full clip).
 * @returns {Array<{id: number, startPct: number, widthPct: number}>}
 */
export function trimRegionViews(trims, durationSec, view) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!(dur > 0)) return [];
  const v = normalizeView(view, dur);
  return (Array.isArray(trims) ? trims : []).map((r) => {
    const a = Math.min(Math.max(r.start, v.start), v.end);
    const b = Math.min(Math.max(r.end, v.start), v.end);
    return {
      id: r.id,
      startPct: v.end > v.start ? ((a - v.start) / (v.end - v.start)) * 100 : 0,
      widthPct: v.end > v.start ? ((b - a) / (v.end - v.start)) * 100 : 0,
    };
  });
}

// ---------------------------------------------------------------------------
// PURE: hitTestTimeline — chip under a timeline point (REQ-013, AC-18)
// ---------------------------------------------------------------------------

/**
 * Hit-test a timeline pointer position against track chips: x → time → the
 * track whose (clamped) redacted span contains it, plus WHICH part of the
 * chip was hit (REQ-103): `'start'` / `'end'` inside the `edgePx` CSS-px
 * edge zones (draggable trim handles), `'body'` otherwise. `y` is accepted
 * for call-site symmetry but unused — the v1 timeline is single-lane.
 *
 * OUTWARD EDGE ZONES (REQ-110): the zones also extend `edgePx` OUTSIDE the
 * (clamped) span, so the visible edge line itself is grabbable from both
 * sides. This is what makes the trim gesture reliable for full-span chips —
 * every manual region defaults to [0, duration], so its end edge sits ON the
 * strip boundary where a pointerdown would otherwise hit-test to the strip
 * (box interiors exclude the right/bottom boundary coordinate) and never
 * start a drag. When no zone matches, null (click → seek).
 *
 * Track selection rule: among tracks whose span CONTAINS the point, the
 * SMALLEST span wins ("topmost" for precise selection — a short chip
 * crossing a long one is picked inside the crossing); exact ties resolve to
 * the earlier track in array order. If no span contains the point, the
 * OUTWARD candidate with the smallest edge distance wins (ties → earlier
 * track). Span edges are inclusive (mirrors redact.tracksAt).
 *
 * Zone rule: an edge zone spans `edgePx / width * viewSpan` seconds
 * inward — and outward — from each (clamped) span edge (the zone is a PIXEL
 * width, so under a zoomed view it covers proportionally less time —
 * v1.22.0 REQ-204). When a chip is narrower than both inward zones combined,
 * the midpoint splits them (left half 'start', right half 'end') so both
 * handles stay reachable on tiny chips.
 *
 * @param {number} x Pointer x within the strip, CSS px.
 * @param {number} y Pointer y within the strip (unused, single lane).
 * @param {number} width Strip width, CSS px (same space as `x`).
 * @param {import('./types.js').Track[]} tracks
 * @param {number} durationSec Video duration (> 0).
 * @param {number} [edgePx] Edge-zone half-width in CSS px (CHIP_EDGE_PX).
 * @param {{start: number, end: number} | null} [view] View window
 *     (v1.22.0 REQ-204; omitted → full clip).
 * @returns {{track: import('./types.js').Track,
 *            zone: 'start'|'end'|'body'} | null}
 */
export function hitTestTimeline(x, y, width, tracks, durationSec, edgePx = CHIP_EDGE_PX, view) {
  void y;
  if (!(width > 0) || !(durationSec > 0)) return null;
  const v = normalizeView(view, durationSec);
  const span = v.end - v.start;
  if (!(span > 0)) return null;
  const t = v.start + (x / width) * span;
  const all = Array.isArray(tracks) ? tracks : [];
  let best = null;
  let bestSpan = Infinity;
  for (const track of all) {
    const start = Math.max(v.start, track.start); // clamp to the rendered window
    const end = Math.min(v.end, track.end);
    if (t < start || t > end) continue;
    const span2 = end - start;
    if (span2 < bestSpan) {
      bestSpan = span2;
      best = track;
    }
  }
  if (best) {
    const start = Math.max(v.start, best.start);
    const end = Math.min(v.end, best.end);
    const edgeSec = edgePx > 0 ? (edgePx / width) * span : 0;
    const inStart = t - start <= edgeSec;
    const inEnd = end - t <= edgeSec;
    /** @type {'start'|'end'|'body'} */
    let zone = 'body';
    if (inStart && inEnd) zone = t < (start + end) / 2 ? 'start' : 'end';
    else if (inStart) zone = 'start';
    else if (inEnd) zone = 'end';
    return { track: best, zone };
  }
  // Outward pass (REQ-110): within `edgePx` OUTSIDE a (clamped) span edge —
  // nearest edge wins, ties resolve to the earlier track in array order.
  if (!(edgePx > 0)) return null;
  const edgeSecOut = (edgePx / width) * span;
  /** @type {{track: import('./types.js').Track, zone: 'start'|'end'} | null} */
  let outward = null;
  let bestDist = Infinity;
  for (const track of all) {
    const start = Math.max(v.start, track.start);
    const end = Math.min(v.end, track.end);
    if (t < start && start - t <= edgeSecOut && start - t < bestDist) {
      bestDist = start - t;
      outward = { track, zone: 'start' };
    } else if (t > end && t - end <= edgeSecOut && t - end < bestDist) {
      bestDist = t - end;
      outward = { track, zone: 'end' };
    }
  }
  return outward;
}

// ---------------------------------------------------------------------------
// PURE: toggleTrack — immutable enabled flip (REQ-014, AC-06)
// ---------------------------------------------------------------------------

/**
 * Set one track's enabled flag and return a NEW array (input never mutated;
 * only the target track object is copied). The caller persists the result via
 * its state owner. Toggling OFF removes the track from redact.tracksAt output
 * everywhere — preview AND export (REQ-014).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} trackId
 * @param {boolean} enabled
 * @returns {import('./types.js').Track[]} New array; unknown id → unchanged
 *     content (still a new array).
 */
export function toggleTrack(tracks, trackId, enabled) {
  return (Array.isArray(tracks) ? tracks : []).map((track) =>
    track.id === trackId ? { ...track, enabled } : track,
  );
}

// ---------------------------------------------------------------------------
// PURE: trimTrack — immutable span trim (SPEC-VID-002 REQ-103, AC-101)
// ---------------------------------------------------------------------------

/**
 * Set one track's redacted span and return a NEW array (input never mutated;
 * only the target track object is copied — keyframes Map is shared, since
 * manual full-span tracks hold ONE constant box and auto tracks are only
 * trimmed, never re-keyed, by the UI). The caller persists the result via
 * its state owner. Trimming changes redact.tracksAt coverage everywhere —
 * preview AND export (REQ-103 / AC-101).
 *
 * Normalization (in order):
 *   1. non-finite bounds degrade (start → 0, end → start);
 *   2. inverted input is ordered (min(start,end), max(start,end));
 *   3. both bounds are clamped into [0, durationSec] when a finite positive
 *      duration is given (else just ≥ 0);
 *   4. the span is floored at MIN_TRACK_SPAN_S — growing `end` first, and
 *      when the floor overflows the duration, pulling `start` back instead.
 *      The chip-edge drag pre-clamps the moving edge in the DOM layer, so
 *      this floor only ever binds on raw/degenerate input.
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} trackId
 * @param {number} start New span start, seconds.
 * @param {number} end New span end, seconds.
 * @param {number} [durationSec] Video duration; clamps the span when given.
 * @returns {import('./types.js').Track[]} New array; unknown id → unchanged
 *     content (still a new array).
 */
/**
 * Filter tracks by class for the track list (v1.21.0 REQ: filter buttons).
 * 'all' → everything; 'face'/'plate'/'manual' → that class only.
 * PURE — returns a NEW array; invalid filter → unchanged (all).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {string | undefined} [filter] 'all' | 'face' | 'plate' | 'manual'
 * @returns {import('./types.js').Track[]}
 */
export function filterTracksByClass(tracks, filter) {
  if (!Array.isArray(tracks)) return [];
  if (filter !== 'face' && filter !== 'plate' && filter !== 'manual') {
    return [...tracks];
  }
  return tracks.filter((t) => t.cls === filter);
}

/**
 * Per-class counts for the Tracks summary (v1.21.0). PURE.
 * @param {import('./types.js').Track[]} tracks
 * @returns {{faces: number, plates: number, manual: number, total: number}}
 */
export function trackSummaryCounts(tracks) {
  const counts = { faces: 0, plates: 0, manual: 0, total: 0 };
  for (const t of Array.isArray(tracks) ? tracks : []) {
    counts.total += 1;
    if (t.cls === 'face') counts.faces += 1;
    else if (t.cls === 'plate') counts.plates += 1;
    else if (t.cls === 'manual') counts.manual += 1;
  }
  return counts;
}

/**
 * Human summary for the Tracks panel title (v1.21.0): "3 faces · 2 plates ·
 * 1 manual" (zero parts omitted), "No tracks" when empty. PURE.
 *
 * @param {{faces: number, plates: number, manual: number, total: number}} counts
 * @returns {string}
 */
export function formatTrackSummary(counts) {
  /** @type {{faces?: number, plates?: number, manual?: number, total?: number}} */
  const c = /** @type {any} */ (counts ?? {});
  if (!Number(c.total)) return 'No tracks';
  const parts = [];
  if (c.faces) parts.push(`${c.faces} face${c.faces === 1 ? '' : 's'}`);
  if (c.plates) parts.push(`${c.plates} plate${c.plates === 1 ? '' : 's'}`);
  if (c.manual) parts.push(`${c.manual} manual`);
  return parts.join(' · ') || 'No tracks';
}


export function trimTrack(tracks, trackId, start, end, durationSec) {
  let a = Number.isFinite(start) ? start : 0;
  let b = Number.isFinite(end) ? end : a;
  if (b < a) [a, b] = [b, a]; // ordered
  if (Number.isFinite(durationSec) && durationSec > 0) {
    a = Math.min(Math.max(a, 0), durationSec);
    b = Math.min(Math.max(b, 0), durationSec);
  } else {
    a = Math.max(a, 0);
    b = Math.max(b, 0);
  }
  if (b - a < MIN_TRACK_SPAN_S) {
    b = a + MIN_TRACK_SPAN_S;
    if (Number.isFinite(durationSec) && durationSec > 0 && b > durationSec) {
      b = durationSec;
      a = Math.max(0, b - MIN_TRACK_SPAN_S);
    }
  }
  return (Array.isArray(tracks) ? tracks : []).map((track) =>
    track.id === trackId ? { ...track, start: a, end: b } : track,
  );
}

// ---------------------------------------------------------------------------
// PURE: setTrackStyle — immutable style flip (SPEC-VID-002 REQ-101, AC-103)
// ---------------------------------------------------------------------------

/**
 * Set one track's redaction style ('pixelate' | 'solid') and return a NEW
 * array (input never mutated; only the target track object is copied). The
 * style is consumed by the shared redact.pixelateFrame seam (per-track
 * dispatch — preview AND export, AC-102/103). Any style value other than the
 * two contract literals is rejected (content unchanged, still a new array) —
 * the redaction must never degrade to an unrenderable style.
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} trackId
 * @param {'pixelate'|'solid'} style
 * @returns {import('./types.js').Track[]} New array; unknown id or invalid
 *     style → unchanged content (still a new array).
 */
export function setTrackStyle(tracks, trackId, style) {
  const valid = style === 'pixelate' || style === 'solid';
  return (Array.isArray(tracks) ? tracks : []).map((track) =>
    track.id === trackId && valid
      ? /** @type {import('./types.js').Track} */ ({ ...track, style })
      : track,
  );
}

// ---------------------------------------------------------------------------
// PURE: parseClockInput / formatSpan — clock text ⇄ seconds (REQ-108)
// ---------------------------------------------------------------------------

/**
 * Format seconds with the formatClock convention (src/main.js): `m:ss.d`,
 * rounded to 0.1 s, never rolling over into ":60.0". Internal shared
 * formatter for the row span readout, the span inputs and formatSpan — kept
 * in sync with main.formatClock by unit tests on both sides.
 * @param {number} sec
 * @returns {string}
 */
function fmtClock(sec) {
  const s0 = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const m = Math.floor(s0 / 60);
  const r = Math.round((s0 - m * 60) * 10) / 10;
  if (r >= 60) return `${m + 1}:00.0`;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/**
 * Parse a track-row time input into seconds (REQ-108). Accepted shapes:
 * `m:ss.s` ("0:04.2", "1:23", "2:00.5"), plain seconds ("4.2", "83"),
 * surrounding whitespace tolerated. The `m:ss` seconds part must stay below
 * 60 ("1:60" is rejected — that is "2:00").
 *
 * A parsed value beyond `durationSec` (when finite and positive) is INVALID —
 * the caller reverts the input, matching trimTrack's clamp semantics while
 * giving explicit feedback instead of a silently clamped commit. Negative or
 * non-numeric input → null.
 *
 * @param {string} str Raw input value.
 * @param {number} [durationSec] Video duration; values beyond it are invalid.
 * @returns {number | null} Seconds, or null when the input is invalid.
 */
export function parseClockInput(str, durationSec) {
  if (typeof str !== 'string') return null;
  const match = /^\s*(?:(\d+):(\d{1,2}(?:\.\d+)?)|(\d+(?:\.\d+)?))\s*$/.exec(str);
  if (!match) return null;
  let sec;
  if (match[1] !== undefined) {
    const s = Number(match[2]);
    if (s >= 60) return null;
    sec = Number(match[1]) * 60 + s;
  } else {
    sec = Number(match[3]);
  }
  if (!Number.isFinite(sec) || sec < 0) return null;
  if (Number.isFinite(durationSec) && durationSec > 0 && sec > durationSec) return null;
  return sec;
}

/**
 * A track's span as a compact readout in the formatClock convention
 * (REQ-108): "0:04.2 – 0:07.8" (en dash with spaces).
 * @param {number} start Span start, seconds.
 * @param {number} end Span end, seconds.
 * @returns {string}
 */
export function formatSpan(start, end) {
  return `${fmtClock(start)} – ${fmtClock(end)}`;
}

// ---------------------------------------------------------------------------
// PURE: tracksAtForView — view-side lookup (REQ-012/016 seam)
// ---------------------------------------------------------------------------

/**
 * Thin wrapper over redact.tracksAt for the preview path. Kept as a named
 * export so the DOM adapter and main.js ask ONE question with ONE answer.
 * The density-invariant throw propagates UNCHANGED — an enabled track
 * covering t with zero keyframes is a tracker bug and must fail loudly,
 * never render an unredacted frame (design §2 invariant).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} t Seconds.
 * @returns {Array<{track: import('./types.js').Track, box: import('./types.js').Box}>}
 */
export function tracksAtForView(tracks, t) {
  return tracksAt(tracks, t);
}

// ---------------------------------------------------------------------------
// PURE: sparse manual keyframes — interpolation model (v1.22.0 REQ-201)
// ---------------------------------------------------------------------------

/**
 * Reference grid step for densifying SPARSE manual keyframe maps, seconds
 * (v1.22.0 REQ-201). Mirrors the tracker's DENSE_STEP_S: the interpolated
 * materialization lands on the same 1/30 s grid the auto tracks use, so
 * every consumer downstream (redact.tracksAt's nearest-sample lookup) has
 * the SAME ≤ half-step (≈16.7 ms) bound for manual and auto tracks alike.
 * @type {number}
 */
export const KEYFRAME_DENSE_STEP_S = 1 / 30;

/** Float guard for "reached the next keyframe" (mirrors tracker.js EPS). */
const KF_EPS = 1e-9;

/**
 * Linear box interpolation between two keyed samples (v1.22.0 REQ-201). PURE.
 * `a` / `b` are `{t, box}` samples with a.t < b.t; `t` is a time in seconds.
 * The fraction is CLAMPED into [0, 1] — extrapolation before a.t (after b.t)
 * resolves to a's (b's) box, so out-of-bracket queries degrade to the nearest
 * endpoint instead of overshooting. Degenerate inputs (b.t ≤ a.t, missing
 * boxes) resolve to a copy of the best available endpoint box; the result is
 * always a NEW box — inputs are never shared or mutated.
 *
 * THE interpolation primitive for sparse manual keyframes: manual tracks keep
 * keyframes only where the user drew/committed one (unlike auto tracks, whose
 * finalized maps are dense), so preview and export resolve in-between
 * instants through here (via interpolatedBoxAt / densifyManualTracks).
 *
 * @param {{t: number, box: import('./types.js').Box}} a Earlier keyframe sample.
 * @param {{t: number, box: import('./types.js').Box}} b Later keyframe sample.
 * @param {number} t Query time, seconds.
 * @returns {import('./types.js').Box} Interpolated (or endpoint) box copy.
 */
export function interpolateBetween(a, b, t) {
  const boxA = a && typeof a.box === 'object' ? a.box : null;
  const boxB = b && typeof b.box === 'object' ? b.box : null;
  if (!boxA) return boxB ? { ...boxB } : { x: 0, y: 0, w: 0, h: 0 };
  if (!boxB) return { ...boxA };
  const ta = Number.isFinite(a.t) ? a.t : 0;
  const tb = Number.isFinite(b.t) ? b.t : ta;
  const span = tb - ta;
  const f =
    !(span > 0) || !Number.isFinite(t)
      ? 0
      : Math.min(1, Math.max(0, (t - ta) / span));
  return {
    x: boxA.x + (boxB.x - boxA.x) * f,
    y: boxA.y + (boxB.y - boxA.y) * f,
    w: boxA.w + (boxB.w - boxA.w) * f,
    h: boxA.h + (boxB.h - boxA.h) * f,
  };
}

/**
 * The box a track shows at time `t` under SPARSE-keyframe linear
 * interpolation (v1.22.0 REQ-201). PURE. Outside the track's [start, end]
 * span → null (the caller's span gate decides visibility — mirrors
 * redact.tracksAt). Inside: exactly one keyframe → that box (a manual
 * region's constant-box contract); before/after the outermost keyframes →
 * the nearest endpoint box (extrapolation clamps); between two keyframes →
 * interpolateBetween. Zero keyframes → null (this is a pure VIEW helper —
 * the redact-side density invariant still throws where it must).
 *
 * @param {import('./types.js').Track} track
 * @param {number} t Seconds.
 * @returns {import('./types.js').Box | null}
 */
export function interpolatedBoxAt(track, t) {
  if (!track || !(track.keyframes instanceof Map) || track.keyframes.size === 0) return null;
  if (!Number.isFinite(t)) return null;
  const { start, end } = track;
  if (Number.isFinite(start) && Number.isFinite(end) && (t < start || t > end)) return null;
  const pts = [...track.keyframes.entries()]
    .filter(([kt, box]) => Number.isFinite(kt) && box && typeof box === 'object')
    .sort((x, y) => x[0] - y[0]);
  if (pts.length === 0) return null;
  if (pts.length === 1) return { ...pts[0][1] };
  if (t <= pts[0][0]) return { ...pts[0][1] };
  const last = pts[pts.length - 1];
  if (t >= last[0]) return { ...last[1] };
  for (let i = 0; i < pts.length - 1; i++) {
    const [ta, ba] = pts[i];
    const [tb, bb] = pts[i + 1];
    if (t >= ta && t <= tb) return interpolateBetween({ t: ta, box: ba }, { t: tb, box: bb }, t);
  }
  return { ...last[1] }; // unreachable with sorted pts — defensive
}

/**
 * Add or update one track's keyframe at time `t` (v1.22.0 REQ-201, the K
 * action's model half). PURE — returns a NEW array; only the target track
 * object is copied (its keyframes Map is rebuilt with the upserted entry;
 * "min-order": entries stay sorted ascending by time, and the upsert REPLACES
 * any existing keyframe at the same clamped time — nearest-keyframe update
 * semantics). `t` is clamped into [0, durationSec] (non-finite → 0; without
 * a usable duration just ≥ 0). Unknown id or a box-less target → unchanged
 * content (still a new array), mirroring toggleTrack.
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} trackId
 * @param {number} t Keyframe time, seconds (the playhead).
 * @param {import('./types.js').Box} box Box in native display px.
 * @param {number} [durationSec] Video duration; clamps `t` when finite > 0.
 * @returns {import('./types.js').Track[]}
 */
export function upsertKeyframe(tracks, trackId, t, box, durationSec) {
  if (!box || typeof box !== 'object') {
    return (Array.isArray(tracks) ? tracks : []).slice();
  }
  let ct = Number.isFinite(t) ? Math.max(t, 0) : 0;
  if (Number.isFinite(durationSec) && durationSec > 0) ct = Math.min(ct, durationSec);
  return (Array.isArray(tracks) ? tracks : []).map((track) => {
    if (!track || track.id !== trackId) return track;
    const entries = track.keyframes instanceof Map ? [...track.keyframes.entries()] : [];
    /** @type {Array<[number, import('./types.js').Box]>} */
    const merged = entries.filter(([kt]) => kt !== ct);
    merged.push([ct, { ...box }]);
    merged.sort((a, b) => a[0] - b[0]); // min-order
    const next = new Map(merged);
    return /** @type {import('./types.js').Track} */ ({ ...track, keyframes: next });
  });
}

/**
 * Materialize every MANUAL track's sparse keyframes onto the 1/30 s
 * reference grid with linear interpolation (v1.22.0 REQ-201). PURE — auto
 * tracks (and anything with ≤ 1 keyframe, whose interpolation is constant
 * anyway) pass through UNCHANGED by reference.
 *
 * WHY THIS EXISTS — the interpolation decision: redact.tracksAt resolves a
 * track's box with a NEAREST-keyframe lookup (and redact.js is the shared
 * preview/export seam both consumers must go through). Sparse manual
 * keyframes under nearest-lookup would STEP between drawn boxes instead of
 * following the subject. redact.js is deliberately untouched; instead every
 * consumer boundary in the files that OWN manual-track state densifies
 * FIRST:
 *   - preview: editor.drawPreview's tracksInCanvasPx memo (below), and
 *   - export: main.js startExport passes densifyManualTracks(app.tracks).
 * Both then run the SAME redact.pixelateFrame over dense maps — nearest
 * lookup on a 1/30 s interpolated grid resolves any instant within half a
 * step (≈16.7 ms) of the true linear interpolation, the exact AC-05 contract
 * auto tracks already satisfy. Preview and export share densification AND
 * the burn-in seam, so the pixels stay identical (REQ-016 / AC-04).
 *
 * @param {import('./types.js').Track[]} tracks
 * @returns {import('./types.js').Track[]} New array; manual tracks with 2+
 *     keyframes replaced by dense-grid copies.
 */
export function densifyManualTracks(tracks) {
  return (Array.isArray(tracks) ? tracks : []).map((track) => {
    if (!track || track.source !== 'manual' || !(track.keyframes instanceof Map)) return track;
    if (track.keyframes.size <= 1) return track; // constant box — already dense-equivalent
    const pts = [...track.keyframes.entries()].sort((a, b) => a[0] - b[0]);
    const dense = new Map();
    for (let i = 0; i < pts.length; i++) {
      const [ta, ba] = pts[i];
      dense.set(ta, { ...ba });
      if (i + 1 >= pts.length) break;
      const [tb, bb] = pts[i + 1];
      for (let m = 1; ; m++) {
        const t = ta + m * KEYFRAME_DENSE_STEP_S;
        if (t >= tb - KF_EPS) break; // next keyframe (exact) reached — never duplicated
        dense.set(t, interpolateBetween({ t: ta, box: ba }, { t: tb, box: bb }, t));
      }
    }
    return /** @type {import('./types.js').Track} */ ({ ...track, keyframes: dense });
  });
}

// ---------------------------------------------------------------------------
// PURE: manualTrackFromBox — manual region factory (REQ-015, AC-07)
// ---------------------------------------------------------------------------

/**
 * Build a manual Track from a user-drawn box at time `t` (design §4.4:
 * manual tracks bypass the tracker — direct keyframes; SPEC-VID-002 REQ-103:
 * the region spans the ENTIRE video by default). PURE: the box is copied,
 * the caller's object is untouched.
 *
 * Divergence from tracker.beginManualTrack (intentional): that skeleton
 * assigns a palette slot and a zero-length span via the Tracker instance's
 * counters; this factory is standalone (main.js owns the id counter across
 * analyze runs), labels from the same counter, and spans [0, durationSec]
 * (REQ-103).
 *
 * COLOR (REQ-109): manual tracks take the SAME categorical palette slot as
 * auto tracks — TRACK_COLORS[(trackIdCounter − 1) % TRACK_COLORS.length],
 * the exact tracker.js rule — so manual and auto tracks never collide within
 * a session and two manual tracks never share a color. Manual identity stays
 * visible through the "Manual #N" label (+ the dashed chip outline the
 * renderer adds for source === 'manual'), NOT through a color collision.
 *
 * SPARSE KEYFRAMES (v1.22.0 REQ-201): the drawn box becomes a keyframe AT
 * the drawn time `t` (clamped ≥ 0) — no longer forced to t=0. With a single
 * keyframe the track still redacts as a CONSTANT box everywhere in the span
 * (redact.tracksAt's nearest lookup returns it for every t; the density
 * invariant never sees an empty map) — that remains the documented exception
 * to the tracker's dense-keyframe guarantee. With 2+ keyframes (the K action,
 * upsertKeyframe) the track FOLLOWS the subject: consumers densify via
 * densifyManualTracks, which linearly interpolates between the sparse
 * keyframes on the 1/30 s grid (see that helper for the full rationale).
 *
 * Without a usable duration the span degrades to [0, max(t, MIN_TRACK_SPAN_S)]
 * (cover at least up to the drawn frame); the caller can trim once duration
 * is known. Style defaults to 'solid' (REQ-101 manual default; opaque black
 * burn-in dispatched per track by the shared seam).
 *
 * @param {number} trackIdCounter Id AND label number for the new track
 *     ("Manual #<trackIdCounter>"); caller increments its counter on accept.
 * @param {number} t Presentation time, seconds — the drawn frame AND the
 *     keyframe time (clamped ≥ 0; also the no-duration fallback span end).
 * @param {import('./types.js').Box} box Box in native display px.
 * @param {number} [durationSec] Video duration; the default span end.
 * @returns {import('./types.js').Track}
 */
export function manualTrackFromBox(trackIdCounter, t, box, durationSec) {
  let end;
  let kt = Number.isFinite(t) ? Math.max(t, 0) : 0;
  if (Number.isFinite(durationSec) && durationSec > 0) {
    end = durationSec;
    kt = Math.min(kt, durationSec);
  } else {
    end = Math.max(kt, MIN_TRACK_SPAN_S);
  }
  return /** @type {import('./types.js').Track} */ ({
    id: trackIdCounter,
    cls: 'manual',
    label: `Manual #${trackIdCounter}`,
    // REQ-109: same categorical slot rule as the tracker's auto tracks —
    // manual regions are no longer a shared fixed alert red.
    color: TRACK_COLORS[(trackIdCounter - 1) % TRACK_COLORS.length],
    // v1.22.0 REQ-201: the box is keyed AT the drawn time (the constant-box
    // behavior for single-keyframe regions is unchanged — see above).
    keyframes: new Map([[kt, { ...box }]]),
    start: 0,
    end,
    enabled: true,
    source: 'manual',
    style: 'solid', // REQ-101: manual regions default to opaque black
  });
}

// ---------------------------------------------------------------------------
// PURE: scaleTracksToCanvas — native-px boxes → preview-canvas px (AC-04)
// ---------------------------------------------------------------------------

/**
 * Copy tracks with every keyframe box uniformly scaled by `scale` (PURE —
 * the input objects and their Maps are never touched). redact.pixelateFrame
 * consumes tracks whose boxes live in the ctx's pixel space; preview boxes
 * are authored in native display px, so the shared burn-in seam runs against
 * this scaled copy. Uniform scaling COMMUTES with the seam: dilate grows a
 * box by a fraction of its own size and clamps it into `frameSize`, and
 * scaling boxes + frameSize by the same factor scales the clamped result
 * exactly — so canvas-px composition == scaled native-px composition and
 * preview pixels match export pixels (REQ-016 / AC-04).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} scale Canvas px per native px (> 0).
 * @returns {import('./types.js').Track[]} New track objects sharing
 *     everything but `keyframes` (new Map, new scaled boxes).
 */
export function scaleTracksToCanvas(tracks, scale) {
  return (Array.isArray(tracks) ? tracks : []).map((track) => ({
    ...track,
    keyframes: new Map(
      Array.from(track.keyframes, ([kt, box]) => [
        kt,
        { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale },
      ]),
    ),
  }));
}

// ---------------------------------------------------------------------------
// DOM ADAPTER: beginManualBox — pointer-draw a region (REQ-015)
// ---------------------------------------------------------------------------

/**
 * Wire manual-box drawing on the preview canvas: pointerdown starts a drag,
 * pointermove reports the rubber band, pointerup commits. Boxes are reported
 * in CANVAS BITMAP pixels (0..canvas.width/height space); mountEditor maps
 * them into native display px before calling hooks. Negative drags are
 * normalized to a min-corner box clamped into the canvas.
 *
 * @param {HTMLCanvasElement} overlayCanvas #overlay-canvas.
 * @param {(box: import('./types.js').Box, t: number) => void} onCommit
 *     Called with the normalized canvas-space box and `getTime()`.
 * @param {{getTime?: () => number,
 *          onPendingChange?: (box: import('./types.js').Box | null) => void,
 *     }} [opts]
 *     `getTime` supplies the commit time (default () => 0; mountEditor passes
 *     video.currentTime). `onPendingChange` streams the live rubber band
 *     (null on cancel/commit) so the host can preview it above the frame.
 * @returns {() => void} Detach all handlers and cancel any in-flight drag.
 */
export function beginManualBox(overlayCanvas, onCommit, opts = {}) {
  if (!overlayCanvas || typeof overlayCanvas.addEventListener !== 'function') {
    return () => {};
  }
  if (typeof onCommit !== 'function') return () => {};
  const getTime = typeof opts.getTime === 'function' ? opts.getTime : () => 0;
  const onPending =
    typeof opts.onPendingChange === 'function' ? opts.onPendingChange : null;

  /** @type {{x0: number, y0: number, box: import('./types.js').Box} | null} */
  let drag = null;

  /** Map a pointer event to canvas bitmap px (rect-relative, resolution-safe). */
  function toCanvasPx(e) {
    const rect = overlayCanvas.getBoundingClientRect();
    const sx = rect.width > 0 ? overlayCanvas.width / rect.width : 1;
    const sy = rect.height > 0 ? overlayCanvas.height / rect.height : 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  /** Normalize a corner drag into a min-corner box clamped into the canvas. */
  function normalizedBox(x0, y0, x1, y1) {
    let box = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
    if (box.x < 0) {
      box.w += box.x;
      box.x = 0;
    }
    if (box.y < 0) {
      box.h += box.y;
      box.y = 0;
    }
    if (box.x + box.w > overlayCanvas.width) box.w = overlayCanvas.width - box.x;
    if (box.y + box.h > overlayCanvas.height) box.h = overlayCanvas.height - box.y;
    return box;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const p = toCanvasPx(e);
    drag = { x0: p.x, y0: p.y, box: null };
    try {
      overlayCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* detached canvas — capture is best-effort */
    }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const p = toCanvasPx(e);
    drag.box = normalizedBox(drag.x0, drag.y0, p.x, p.y);
    if (onPending) onPending({ ...drag.box });
  }

  function finish(e, commit) {
    if (!drag) return;
    const box = drag.box;
    drag = null;
    try {
      overlayCanvas.releasePointerCapture(e.pointerId);
    } catch {
      /* Escape path or never captured */
    }
    if (onPending) onPending(null);
    if (commit && box && box.w >= MIN_DRAG_PX && box.h >= MIN_DRAG_PX) {
      onCommit(box, getTime());
    }
  }

  function onPointerUp(e) {
    finish(e, true);
  }
  function onPointerCancel(e) {
    finish(e, false);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') finish(e, false);
  }

  overlayCanvas.addEventListener('pointerdown', onPointerDown);
  overlayCanvas.addEventListener('pointermove', onPointerMove);
  overlayCanvas.addEventListener('pointerup', onPointerUp);
  overlayCanvas.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);

  return () => {
    overlayCanvas.removeEventListener('pointerdown', onPointerDown);
    overlayCanvas.removeEventListener('pointermove', onPointerMove);
    overlayCanvas.removeEventListener('pointerup', onPointerUp);
    overlayCanvas.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    if (drag) {
      drag = null;
      if (onPending) onPending(null);
    }
  };
}

// ---------------------------------------------------------------------------
// DOM ADAPTER: mountEditor — preview lifecycle + timeline wiring (§4.7)
// ---------------------------------------------------------------------------

/**
 * Mount the review editor (interaction map in the module header). Guards
 * every element: missing els disable just that feature; mountEditor(null)
 * returns inert destroy/refresh.
 *
 * Preview composition per presented frame (REQ-012/016, AC-04/18) — the
 * overlay canvas becomes the pixel-truthful preview:
 *   1. contain-fit the native frame into the element box (mirrors the video's
 *      object-fit: contain) and size the canvas bitmap to the CONTENT box ×
 *      devicePixelRatio, so canvas px map to native px by ONE uniform scale;
 *   2. draw the current video frame into the canvas (it covers the <video>);
 *   3. pixelateFrame (the SAME single-seam function the export burn-in
 *      uses) against canvas-px scaled tracks — tracksAt → dilate 15% →
 *      applyPixelation, identical to export per frame (AC-04);
 *   4. drawOverlay for ALL tracks on top (enabled solid strokes + labels,
 *      disabled dashed "(visible)") with viewScale = that scale.
 * A density-invariant throw clears the canvas and re-throws (fail-closed:
 * the loop halts rather than ever showing an unredacted frame).
 *
 * @param {object} els Stable DOM handles:
 *     `{ video, overlayCanvas, timeline, chipsContainer, playhead, trackList,
 *        timelineThumb?, trimRegions?, zoomIn?, zoomOut?, zoomFit?,
 *        waveform? }`. The timeline strip is the trim-handle
 *     gesture surface (REQ-103, and REQ-110: bound to #timeline so
 *     boundary-edge grabs on full-span chips are seen); pointer geometry still
 *     maps through the chips layer. `timelineThumb` (v1.7.0) is the draggable
 *     scrub handle — when omitted it is resolved as the static
 *     `#timeline-thumb` inside the strip markup. `trimRegions` (v1.15.0
 *     REQ-125) is the greyed trim-region layer — when omitted it is resolved
 *     as the static `#trim-regions` inside the strip markup; a missing layer
 *     disables only the trim UI (chips/playhead/list are unaffected).
 *     v1.22.0 REQ-204: `zoomIn`/`zoomOut`/`zoomFit` are the optional zoom
 *     buttons (missing markup → the wheel/pan gestures still zoom).
 *     v1.22.0 REQ-206: `waveform` is the optional waveform strip canvas —
 *     absent → the waveform feature is off.
 * @param {object} hooks Callbacks into main.js:
 *     `{ onToggle(trackId, enabled), onSeek(t), onManualBox(box, t),
 *        onTrimTrack(trackId, start, end), onSetStyle(trackId, style),
 *        onStepFrame(dir)?, getState() → { tracks, currentTime,
 *        duration? } }`. `duration` (v1.8.1) is the host's meta duration —
 *     consulted ONLY when video.duration is NaN/≤0 (see duration()).
 *     `onStepFrame` (v1.7.0, optional) is the thumb's ±1-frame keyboard path —
 *     the host's own step math (source fps); without it the thumb falls back
 *     to a ±1/30 s seek. v1.15.0 REQ-125: `getState().trims` +
 *     `getState().trimMode` drive the greyed regions, the crosshair strip and
 *     the preview veil; `onTrimAdd(start, end)` / `onTrimEdge(id, which, t)` /
 *     `onTrimRemove(id)` (optional) mutate the region model — all optional,
 *     guarded like the other hooks. v1.22.0 REQ-201: `getState()
 *     .selectedTrackId` names the SELECTED track (row click →
 *     `onSelectTrack(trackId)`) — the K-keyframe target and the only track
 *     whose `.kf-marker` diamonds render; `onKeyframe(trackId, box, t)`
 *     commits a drawn box as a keyframe at the playhead (B draws, K commits).
 *     v1.22.0 REQ-202: `onRescanTrack(trackId)` fires from the auto-track
 *     rows' Re-scan buttons. v1.22.0 REQ-204: `getState().viewStart`/
 *     `viewEnd` carry the host-owned view window (omitted → full clip) and
 *     `onZoomView(view)` (optional) receives the next window from the wheel
 *     zoom / shift-drag pan / zoom buttons — the editor never mutates the
 *     window itself.
 * @returns {{destroy: () => void, refresh: () => void,
 *            redraw: () => void, getGestureState: () => {dragging: boolean,
 *            pinRemainingMs: number},
 *            setRescanBusy: (trackId: number | null) => void,
 *            setPeek: (on: boolean) => void}}
 *     `destroy` tears all listeners/frames down on step change; `refresh`
 *     re-renders chips + track list + playhead from getState() (main calls
 *     it on state change); `redraw` re-runs the preview draw + playhead at
 *     the CURRENT element layout — main calls it after fullscreen/zoom/
 *     viewport resizes (the per-frame loop only fires on presented frames,
 *     so a paused video needs this explicit kick to re-size the overlay
 *     canvas); `getGestureState` (v1.9.0) exposes the live thumb drag +
 *     release-pin state for the host's ?debug=1 diag line; `setRescanBusy`
 *     (v1.22.0 REQ-202) flips the row Re-scan button's "…" busy state;
 *     `setPeek` (v1.22.0 REQ-205) drives hold-to-peek (main wires the
 *     #peek-button hold + the A key).
 */
export function mountEditor(els, hooks) {
  const video = (els && els.video) || null;
  const canvas = (els && els.overlayCanvas) || null;
  const timeline = (els && els.timeline) || null;
  const chipsContainer = (els && els.chipsContainer) || null;
  const playhead = (els && els.playhead) || null;
  // v1.7.0 scrub handle: an explicit handle wins; otherwise the static
  // #timeline-thumb inside the strip markup (main.js passes neither — the
  // thumb ships as part of #timeline-track in index.html).
  const thumb =
    (els && els.timelineThumb) ||
    (timeline && typeof timeline.querySelector === 'function'
      ? timeline.querySelector('#timeline-thumb')
      : null);
  const trackList = (els && els.trackList) || null;
  // v1.15.0 REQ-125: the greyed trim-region layer (sits above #track-chips,
  // below the playhead/thumb). Resolved by the HOST (main.js passes
  // els.trimRegions — a querySelector fallback here would happily grab the
  // wrong node in partial-els embeds); an absent layer disables only the trim
  // UI (chips/playhead/list are unaffected).
  const trimRegions = (els && els.trimRegions) || null;
  // v1.22.0 REQ-204: the zoom controls (+ / − / Fit). All optional — missing
  // markup disables only the buttons; wheel zoom + shift-drag pan still work.
  const zoomInBtn = (els && els.zoomIn) || null;
  const zoomOutBtn = (els && els.zoomOut) || null;
  const zoomFitBtn = (els && els.zoomFit) || null;
  // v1.22.0 REQ-206: the waveform strip canvas (optional — absent → the
  // waveform feature is off entirely).
  const waveformCanvas = (els && els.waveform) || null;

  const hasHook = (name) => !!(hooks && typeof hooks[name] === 'function');
  const getState = () =>
    hasHook('getState') ? hooks.getState() : { tracks: [], currentTime: 0 };

  // v1.4.0 REQ-112: coarse (touch) pointers get wider chip-edge grab zones.
  // matchMedia is browser-only — node (unit tests) degrades to the fine zone.
  const coarsePointer =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(pointer: coarse)').matches === true;
  const edgePx = effectiveEdgePx(coarsePointer);
  const callToggle = (id, enabled) => {
    if (hasHook('onToggle')) hooks.onToggle(id, enabled);
  };
  const callSeek = (t) => {
    if (hasHook('onSeek')) hooks.onSeek(t);
  };
  const callTrim = (id, start, end) => {
    if (hasHook('onTrimTrack')) hooks.onTrimTrack(id, start, end);
  };
  const callSetStyle = (id, style) => {
    if (hasHook('onSetStyle')) hooks.onSetStyle(id, style);
  };
  // v1.22.0 REQ-201: row click selects a track (K-keyframe targeting + the
  // keyframe markers' subject); optional hook — absent → selection stays a
  // no-op and the editor never renders markers.
  const callSelect = (id) => {
    if (hasHook('onSelectTrack')) hooks.onSelectTrack(id);
  };
  // v1.22.0 REQ-202: the row's "Re-scan" button (auto tracks only).
  const callRescan = (id) => {
    if (hasHook('onRescanTrack')) hooks.onRescanTrack(id);
  };
  // v1.15.0 REQ-125 trim hooks: region create / edge move / remove.
  const callTrimAdd = (start, end) => {
    if (hasHook('onTrimAdd')) hooks.onTrimAdd(start, end);
  };
  const callTrimEdge = (id, which, t) => {
    if (hasHook('onTrimEdge')) hooks.onTrimEdge(id, which, t);
  };
  const callTrimRemove = (id) => {
    if (hasHook('onTrimRemove')) hooks.onTrimRemove(id);
  };
  // v1.22.0 REQ-204: the host owns the view window (getState().viewStart/
  // viewEnd); zoom/pan/fit interactions emit the NEXT window through this
  // optional hook — absent → the editor renders through whatever view the
  // host supplies but can never change it.
  const callZoomView = (view) => {
    if (hasHook('onZoomView') && view) hooks.onZoomView(view);
  };
  // v1.7.0 thumb keyboard: ±1 frame rides the host's step math (main.js's
  // stepFrame knows the source fps via app.meta); without the hook a ~30 fps
  // seek fallback keeps the thumb steppable in partial-hook embeds.
  const callStepFrame = (dir) => {
    if (hasHook('onStepFrame')) hooks.onStepFrame(dir);
    else callSeek(clampTime(displayTime() + dir / 30));
  };

  const doc = typeof document !== 'undefined' ? document : null;

  /** Video duration in seconds; 0 until finite metadata exists. v1.8.1:
   * when video.duration is not usable (NaN/≤0 — e.g. a browser that reports
   * duration late), fall back to the host state's meta duration — never to a
   * value captured at mount, so the thumb/playhead scale can never degenerate
   * to 0% for lack of a denominator while a usable duration exists. */
  const duration = () => {
    const d = video ? video.duration : NaN;
    if (Number.isFinite(d) && d > 0) return d;
    const meta = getState().duration;
    return Number.isFinite(meta) && meta > 0 ? meta : 0;
  };
  /** Displayed-frame time (video.currentTime), falling back to state. */
  const displayTime = () => {
    if (video && Number.isFinite(video.currentTime)) return video.currentTime;
    const st = getState();
    return Number.isFinite(st.currentTime) ? st.currentTime : 0;
  };
  const clampTime = (t) => Math.min(duration(), Math.max(0, t));

  // --- View window (v1.22.0 REQ-204) + peek flag (REQ-205) state ------------

  /**
   * The current view window, read LIVE from getState().viewStart/viewEnd
   * (main.js owns it; both fields optional → full clip). Re-normalized so a
   * stale/garbage host window can never produce NaN positions.
   * @returns {{start: number, end: number}}
   */
  const getView = () => normalizeView(
    { start: getState().viewStart, end: getState().viewEnd },
    duration(),
  );

  /**
   * v1.22.0 REQ-205: while true, drawPreview renders the RAW frame — no
   * pixelation, no overlay boxes, no trim veil — plus a "RAW" badge. Set
   * through the handle's setPeek (wired by main.js to the #peek-button
   * hold gesture and the A key). Preview-only: the export burn path never
   * consults it.
   * @type {boolean}
   */
  let peeking = false;

  // --- Preview loop (video frame → pixelation → overlay → playhead) -------

  const ctx =
    canvas && typeof canvas.getContext === 'function'
      ? canvas.getContext('2d')
      : null;
  let frameHandle = 0;
  let usingVFC = false;
  let closed = false;
  /** Live manual-drag rubber band (canvas bitmap px) drawn above the frame. */
  let pendingBox = null;
  /**
   * v1.22.0 REQ-201: the ARMED keyframe box — a box drawn while a manual
   * track is selected, waiting for K to commit it as a keyframe at the
   * playhead (or Escape to discard). `{ trackId, box }` in NATIVE display
   * px; the canvas-px twin stays visible through `pendingBox` until commit.
   * @type {{trackId: number, box: import('./types.js').Box} | null}
   */
  let pendingKeyframe = null;
  /**
   * v1.22.0 REQ-202: the track id whose row is mid-re-scan (the row's
   * .rescan-btn reads "…" while set); null when idle. main.js clears it via
   * the handle's setRescanBusy.
   * @type {number | null}
   */
  let rescanBusyId = null;
  /** Canvas px per native px — set by drawPreview once metadata exists. */
  let previewScale = 1;
  /**
   * Memo for tracksInCanvasPx: rebuild the scaled copy only when the state
   * array identity or the scale changes (toggle/resize), never per frame.
   * @type {{tracks: object[] | null, scale: number, scaled: object[] | null}}
   */
  let scaledMemo = { tracks: null, scale: -1, scaled: null };

  /**
   * Memoized scaleTracksToCanvas (see the pure helper for the AC-04 math).
   * v1.22.0 REQ-201: the state tracks densify FIRST (sparse manual keyframes
   * → 1/30 s interpolated maps) so pixelateFrame/drawOverlay — both redact
   * nearest-lookup consumers — resolve interpolated boxes in the preview
   * exactly as the export will (main.js densifies the export tracks too).
   * The memo key stays (state array identity, scale): densification runs
   * only when the state actually changed.
   */
  function tracksInCanvasPx(tracks, scale) {
    if (scaledMemo.tracks !== tracks || scaledMemo.scale !== scale) {
      scaledMemo = {
        tracks,
        scale,
        scaled: scaleTracksToCanvas(densifyManualTracks(tracks), scale),
      };
    }
    return scaledMemo.scaled;
  }

  /** Draw the manual rubber band (dashed alert red) over the current frame. */
  function drawPending() {
    if (!ctx || !pendingBox) return;
    ctx.save();
    ctx.strokeStyle = ALERT_RED;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(pendingBox.x, pendingBox.y, pendingBox.w, pendingBox.h);
    ctx.restore();
  }

  /**
   * v1.22.0 REQ-205: the "RAW" peek badge — a small dark plate with red
   * text in the canvas's top-right corner (bitmap px, so it tracks the
   * drawn frame). Scaled by dpr so its CSS size stays constant.
   * @param {number} bw Canvas bitmap width.
   * @param {number} dpr Device pixel ratio (≥ 1).
   */
  function drawRawBadge(bw, dpr) {
    if (!ctx) return;
    const s = Math.max(1, dpr);
    const pad = 8 * s;
    const h = 20 * s;
    ctx.save();
    ctx.font = `600 ${12 * s}px system-ui, sans-serif`;
    const label = 'RAW';
    const tw = ctx.measureText(label).width;
    const x = Math.max(0, bw - tw - pad * 3);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fillRect(x, pad, tw + pad * 2, h);
    ctx.fillStyle = '#FF5D5D';
    ctx.fillText(label, x + pad, pad + h - 6 * s);
    ctx.restore();
  }

  function drawPreview() {
    if (!video || !ctx || !canvas) return;
    const nw = video.videoWidth || 0;
    const nh = video.videoHeight || 0;
    if (!nw || !nh) return;

    // Contain-fit the native frame into the element box (object-fit: contain
    // twin) and resize the bitmap to the CONTENT box × DPR, so boxes map to
    // canvas px with one uniform scale and the canvas exactly covers the
    // visible video content (no letterbox offset math anywhere else).
    const dpr =
      typeof devicePixelRatio === 'number' && devicePixelRatio > 0
        ? devicePixelRatio
        : 1;
    const ew = video.clientWidth || nw;
    const eh = video.clientHeight || nh;
    const fit = Math.min(ew / nw, eh / nh);
    const cssW = nw * fit;
    const cssH = nh * fit;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    if (canvas.style) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.style.left = `${(ew - cssW) / 2}px`;
      canvas.style.top = `${(eh - cssH) / 2}px`;
    }
    previewScale = bw / nw;

    if (video.readyState < 2) return; // no decoded frame yet — stay clear

    ctx.clearRect(0, 0, bw, bh);
    ctx.drawImage(video, 0, 0, bw, bh); // canvas becomes the visible preview

    // v1.22.0 REQ-205: HOLD-TO-PEEK — while the flag is set the preview is
    // the RAW frame and nothing else (no pixelation, no track outlines, no
    // trim veil): the user checks what the source actually looks like under
    // the redactions. A small "RAW" badge keeps the state obvious. Preview
    // ONLY — the export burn path never reads this flag.
    if (peeking) {
      drawRawBadge(bw, dpr);
      return;
    }

    const state = getState();
    const t = displayTime();
    try {
      // 1. Burn pixelation through THE shared seam (REQ-016 pixel-truthful
      //    preview): redact.pixelateFrame = tracksAt → dilate 15% →
      //    applyPixelation — the exact composition the export burn-in runs
      //    per sample, here in canvas px against scaled tracks so preview
      //    pixels equal exported pixels (AC-04). Source-rect sampling in
      //    applyPixelation is untransformed — no ctx transform anywhere.
      const tracksCanvasPx = tracksInCanvasPx(state.tracks, previewScale);
      // v1.15.0 REQ-125: the playhead inside a trim region — the frame is
      // marked for deletion and never reaches the export, so the pixelation
      // burn is SKIPPED here too (the veil, not the mosaic, is the truth),
      // and a grey veil fills the canvas LAST — on top of frames and track
      // outlines alike, the clearest "this part will be removed" signal.
      const inTrim = (state.trims ?? []).some(
        (r) => Number.isFinite(t) && t >= r.start && t <= r.end,
      );
      if (!inTrim) {
        // v1.17.0 REQ-129: the selected pixelation strength rides through the
        // shared seam — getState().pixelStrength ('fine'|'normal'|'coarse'|
        // 'max'; invalid/missing → redact's 'normal' default) so the preview
        // resolves the same block sizes the export burn-in will (AC-04).
        pixelateFrame(ctx, tracksCanvasPx, t, { width: bw, height: bh }, {
          strength: state.pixelStrength,
        });
      }
      // 2. Outline pass for ALL tracks (enabled solid + disabled dashed),
      //    on top of the burned pixels so strokes stay crisp — same scaled
      //    boxes so strokes align with the burned regions; viewScale keeps
      //    stroke/label metrics CSS-px consistent.
      drawOverlay(ctx, tracksCanvasPx, t, previewScale);
      if (inTrim) {
        ctx.save();
        ctx.fillStyle = TRIM_VEIL;
        ctx.fillRect(0, 0, bw, bh);
        ctx.restore();
      }
    } catch (err) {
      // Density invariant violated (tracker bug): fail CLOSED — never leave
      // an unredacted frame on screen — and re-throw (never swallow). The
      // loop then halts because tick() schedules only after a clean draw.
      ctx.clearRect(0, 0, bw, bh);
      throw err;
    }
    drawPending();
  }

  /**
   * v1.7.0 scrub handle: position the thumb at the playhead and keep its ARIA
   * values honest (aria-valuemax = duration, aria-valuenow = seconds). Two
   * states step aside so a stale displayTime can never fight the gesture:
   *   - while `thumbDrag` is live: a lagging seek (video.currentTime updates
   *     asynchronously) must never drag the thumb back off the pointer;
   *   - while the RELEASE PIN is set (endpoint seek still in flight after
   *     pointerup): the pre-seek position must never yank the thumb back off
   *     the release point.
   *
   * v1.9.0 TIME-BOXED PIN: the pin clears at the EARLIER of the seek landing
   * (`thumbPinSettled` / `seeked`) or the hard `THUMB_PIN_MS` deadline. The
   * v1.8.0 condition-based pin could latch FOREVER when both `seeked` and the
   * settled check never fired on one machine — the field report (thumb frozen
   * during playback while the timecode advanced) — so the deadline is
   * unconditional: no event, no condition, can hold it past THUMB_PIN_MS.
   */
  function updateThumb() {
    if (!thumb || thumbDrag) return;
    if (thumbPin !== null) {
      if (Date.now() >= thumbPinUntil || thumbPinSettled(thumbPin, displayTime())) {
        thumbPin = null;
      } else {
        return;
      }
    }
    const d = duration();
    const t = displayTime();
    // v1.22.0 REQ-204: the thumb maps through the VIEW window (it must sit
    // over the same strip space the chips/playhead occupy). Its ARIA values
    // stay in real seconds (media time), independent of the view.
    if (thumb.style) thumb.style.left = `${timeToPct(t, getView())}%`;
    if (typeof thumb.setAttribute === 'function') {
      thumb.setAttribute('aria-valuemax', String(Number.isFinite(d) && d > 0 ? d : 0));
      thumb.setAttribute('aria-valuenow', String(thumbAriaValue(t)));
    }
  }

  function updatePlayhead() {
    updateThumb();
    // v1.22.0 REQ-206: the played-portion tint follows the playhead — cheap
    // (≈ one rect per bar) and keeps the waveform honest during playback.
    drawWaveform();
    if (!playhead) return;
    // v1.22.0 REQ-204: view-window position (full view → the old math).
    const pct = timeToPct(displayTime(), getView());
    playhead.style.left = `${pct}%`;
  }

  function scheduleFrame() {
    if (closed || !video || !ctx) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      usingVFC = true;
      frameHandle = video.requestVideoFrameCallback(tick);
    } else {
      usingVFC = false;
      frameHandle = requestAnimationFrame(tick);
    }
  }

  /**
   * v1.9.0 per-tick exception isolation: warn ONCE per editor mount (the
   * console must never flood at frame rate) and bump the shared
   * `__VR_DIAG.tickErr` counter on EVERY failure — the ?debug=1 diag line
   * turns a silently-throwing tick into machine-readable evidence instead
   * of an unreproducible field report.
   * @param {unknown} err
   */
  let tickErrorLogged = false;
  function noteTickFailure(err) {
    if (!tickErrorLogged) {
      tickErrorLogged = true;
      console.warn('[editor-tick-error]', err);
    }
    if (globalThis.__VR_DIAG) {
      globalThis.__VR_DIAG.tickErr = (globalThis.__VR_DIAG.tickErr || 0) + 1;
    }
  }

  function tick() {
    frameHandle = 0;
    if (usingVFC && globalThis.__VR_DIAG) globalThis.__VR_DIAG.vfc += 1; // v1.8.2 diag: rVFC DELIVERED this tick (rAF fallback never counts)
    // v1.9.0: a throwing seam must never stop the loop OR the other seam.
    // drawPreview and updatePlayhead are isolated; scheduleFrame is
    // unconditional. drawPreview's own fail-closed canvas clear still runs
    // on an invariant throw (never an unredacted frame) — the loop now
    // retries instead of halting, and each failure counts in __VR_DIAG.
    try {
      drawPreview();
    } catch (err) {
      noteTickFailure(err);
    }
    try {
      updatePlayhead();
    } catch (err) {
      noteTickFailure(err);
    }
    scheduleFrame();
  }

  /** Immediate redraw after a scrub (vfc may not fire while paused). The seek
   * that just landed also retires the thumb's release pin (v1.8.0). */
  function onSeeked() {
    clearThumbPin();
    drawPreview();
    updatePlayhead();
  }

  /**
   * v1.8.1 playback-following fallback: keep the playhead AND the scrub thumb
   * on the video's live time even when the frame loop never delivers. rVFC
   * fires only when the compositor PRESENTS a frame — on browsers/GPUs/window
   * states where playback presents nothing, the loop registered but never
   * fired: the thumb sat at its CSS-default 0% for the whole clip (field
   * report: transport timecode `0:11.1 / 0:11.1` live, thumb pinned left,
   * both moved fine on explicit seeks — `seeked` is media-event-driven and
   * drags are DOM-only, which is exactly the observed split). `timeupdate`
   * fires 4–66 Hz during playback and after every seek, from the same media
   * event source main.js's transport readout uses, so it now drives the SAME
   * updatePlayhead path (live video.currentTime + duration — thumbDrag and
   * the v1.8.0 release pin still step aside inside updateThumb). Position
   * ONLY: the preview canvas draw stays frame-loop-owned (a 4 Hz full redraw
   * here would stutter it, and drawPreview already tracks every presented
   * frame where frames actually arrive). This also keeps position honest if
   * the draw loop ever halts fail-closed on an invariant throw.
   */
  /** v1.14.1: timeupdate-driven canvas redraw throttle (rVFC-dead machines). */
  const TU_DRAW_THROTTLE_MS = 250;
  let lastTuDrawAt = 0;

  function onTimeUpdate() {
    // v1.9.0 diag: the EDITOR-owned timeupdate path proves itself on the
    // reporting machine — main.js's `tu` counter with `tued: 0` here would
    // pin a dead editor listener instead of a dead media event.
    if (globalThis.__VR_DIAG) {
      globalThis.__VR_DIAG.tued = (globalThis.__VR_DIAG.tued || 0) + 1;
    }
    try {
      updatePlayhead();
      // v1.14.1: on machines where rVFC never presents frames (the reported
      // Chrome/Win11), the frame loop is dead and the preview canvas keeps a
      // stale bitmap forever — stretched/duplicated after any layout change.
      // The media event stream is the reliable fallback: redraw the canvas
      // here, throttled (timeupdate fires ~4 Hz).
      const now = Date.now();
      if (now - lastTuDrawAt >= TU_DRAW_THROTTLE_MS) {
        lastTuDrawAt = now;
        drawPreview();
      }
    } catch (err) {
      noteTickFailure(err); // v1.9.0: a bad position write never kills the fallback
    }
  }

  // --- Timeline + track list DOM (chips, rows, playhead) -------------------

  function render() {
    if (closed || !doc) return;
    const state = getState();
    const d = duration();
    // v1.22.0 REQ-204: every strip mapping goes through the VIEW window —
    // chips, playhead, keyframe markers, trim regions, waveform (full view →
    // the exact pre-zoom numbers).
    const view = getView();
    const vm = renderTimeline(state.tracks, d, displayTime(), view);

    if (chipsContainer) {
      chipsContainer.textContent = '';
      for (const chip of vm.chips) {
        const widthPct = chip.endPct - chip.startPct;
        if (widthPct <= 0) continue; // nothing visible inside the duration
        const el = doc.createElement('div');
        el.dataset.trackId = String(chip.track.id);
        el.title = chip.enabled
          ? chip.track.label
          : `${chip.track.label} (visible)`;
        el.style.cssText =
          'position:absolute;top:6px;bottom:6px;border-radius:4px;' +
          'min-width:2px;cursor:pointer;';
        el.style.left = `${chip.startPct}%`;
        el.style.width = `${widthPct}%`;
        el.style.background = chip.enabled ? chip.color : SAFE_GREEN;
        el.style.opacity = chip.enabled ? '1' : '0.55';
        // Solid-style chips get a dark inset outline so the burn style is
        // readable on the timeline too (background stays the palette color).
        if (chip.enabled && styleOf(chip.track) === 'solid') {
          el.style.boxShadow = 'inset 0 0 0 2px rgba(0, 0, 0, 0.6)';
        }
        // REQ-109: manual identity stays visible beyond color — a dashed
        // outline on the chip (the box overlay already carries the palette
        // color via drawOverlay).
        if (chip.track.source === 'manual') {
          el.style.outline = '1px dashed rgba(232, 236, 241, 0.6)';
          el.style.outlineOffset = '-1px';
        }
        chipsContainer.appendChild(el);
      }

      // v1.22.0 REQ-201: the SELECTED manual track's keyframes render as
      // small diamond markers in the chips layer, positioned at their
      // (clamped) keyframe times. Canvas-free divs with pointer-events:none
      // — timeline gestures never hit them; they re-render with every
      // refresh (upsertKeyframe fires a refresh via main.js). Nothing
      // renders when nothing is selected, the selection is not a manual
      // track, or the duration is unusable.
      const selectedId = state.selectedTrackId;
      const sel = (Array.isArray(state.tracks) ? state.tracks : []).find(
        (tr) => tr && tr.id === selectedId && tr.source === 'manual',
      );
      if (sel && sel.keyframes instanceof Map && sel.keyframes.size > 0) {
        const entries = [...sel.keyframes.entries()].sort((a, b) => a[0] - b[0]);
        for (const [kt] of entries) {
          if (!Number.isFinite(kt)) continue;
          // v1.22.0 REQ-204: markers outside the view window are skipped
          // (a clamped pile-up at the edges would lie about their times).
          if (kt < view.start || kt > view.end) continue;
          const marker = doc.createElement('div');
          marker.className = 'kf-marker';
          marker.dataset.trackId = String(sel.id);
          marker.dataset.kfTime = String(kt);
          marker.title = `${sel.label} keyframe @ ${fmtClock(kt)}`;
          marker.style.cssText =
            'position:absolute;top:50%;left:0;width:8px;height:8px;margin:0;padding:0;' +
            'border:0;pointer-events:none;transform:translate(-50%, -50%) rotate(45deg);';
          marker.style.left = `${timeToPct(kt, view)}%`;
          marker.style.background = sel.color || '#E5484D';
          chipsContainer.appendChild(marker);
        }
      }
    }

    if (playhead) playhead.style.left = `${vm.playheadPct}%`;
    updateThumb();
    // v1.22.0 REQ-206: the waveform strip repaints on every refresh (view
    // changes and peak arrivals both ride refresh). updatePlayhead covers the
    // played-tint during playback; a PAUSED video presents no frames (rVFC
    // idles), so the refresh path must own the unhide + redraw.
    drawWaveform();

    // v1.15.0 REQ-125: greyed trim regions in the dedicated layer (above the
    // chips, below the playhead/thumb) + the trim-mode strip cursor. The
    // live-create ghost survives refreshes (edge drags fire hooks → render).
    if (trimRegions) {
      trimRegions.textContent = '';
      for (const regionView of trimRegionViews(state.trims, d, view)) {
        trimRegions.appendChild(buildTrimRegion(regionView));
      }
      if (trimCreate?.ghost) trimRegions.appendChild(trimCreate.ghost);
    }
    if (timeline && timeline.style) {
      timeline.style.cursor = state.trimMode ? 'crosshair' : '';
    }
    // v1.15.1: in trim mode the scrub thumb must yield — its fat-finger
    // hit zone would otherwise steal the presses that start a trim region
    // (users naturally drag from the playhead). pointer-events: none makes
    // strip presses fall through to the trim-create handler.
    if (thumb && thumb.style) {
      thumb.style.pointerEvents = state.trimMode ? 'none' : '';
    }

    if (trackList) renderTrackList(state.tracks, d, state.trackFilter);
  }

  /**
   * Track-list render (REQ-108): keyed row reconciliation — existing rows
   * are updated IN PLACE (a text input must never lose focus or its in-flight
   * value to a refresh; only rows for tracks that appeared/disappeared are
   * created/removed). The focused start/end input's value is never
   * overwritten while it has focus (classic controlled-input pitfall); after
   * a commit (blur/Enter) the input is no longer focused and the next render
   * syncs it to the canonical formatted value.
   * @param {import('./types.js').Track[]} tracks
   * @param {number} d Video duration (0 until metadata exists).
   */
  function renderTrackList(tracks, d, trackFilter) {
    // v1.21.0: the list honors the class filter (chips/timeline/preview are
    // unaffected — filtering is a list-finding aid only).
    const filtered = filterTracksByClass(tracks, trackFilter);
    const active = doc && doc.activeElement;
    const selectedId = getState().selectedTrackId;
    const existing = new Map();
    for (const row of Array.from(trackList.querySelectorAll('li.track-row[data-track-id]'))) {
      existing.set(String(row.dataset.trackId), row);
    }
    const keep = new Set();
    for (const track of filtered) {
      const idStr = String(track.id);
      keep.add(idStr);
      const row = existing.get(idStr) ?? buildTrackRow(track);
      syncTrackRow(row, track, d, active, selectedId);
      trackList.appendChild(row); // moves new + existing rows into array order
    }
    for (const [idStr, row] of existing) {
      if (!keep.has(idStr)) row.remove();
    }
  }

  /**
   * Build one empty track row (structure only; syncTrackRow fills it in).
   * Row contract kept Playwright/E2E-compatible: li.track-row with
   * .swatch / .label / .span / .style-select / input[type=checkbox], plus
   * the REQ-108 .times group with the start/end span inputs. v1.22.0
   * REQ-202 adds the .rescan-btn (auto tracks only — visibility is decided
   * per track in syncTrackRow, since rows are reused by id).
   * @param {import('./types.js').Track} track
   * @returns {HTMLLIElement}
   */
  function buildTrackRow(track) {
    const trackId = track.id;
    const row = doc.createElement('li');
    row.className = 'track-row';
    row.dataset.trackId = String(trackId);

    const swatch = doc.createElement('span');
    swatch.className = 'swatch';

    const label = doc.createElement('span');
    label.className = 'label';

    const span = doc.createElement('span');
    span.className = 'span num';

    const times = doc.createElement('span');
    times.className = 'times';
    for (const role of ['start', 'end']) {
      const input = doc.createElement('input');
      input.type = 'text';
      input.className = 'span-input num';
      input.dataset.trackId = String(trackId);
      input.dataset.role = role;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.title = role === 'start' ? 'Redaction start (m:ss.s)' : 'Redaction end (m:ss.s)';
      times.appendChild(input);
      if (role === 'start') {
        const sep = doc.createElement('span');
        sep.className = 'sep';
        sep.textContent = '–';
        times.appendChild(sep);
      }
    }

    const styleSelect = doc.createElement('select');
    styleSelect.className = 'style-select';
    styleSelect.dataset.trackId = String(trackId);
    styleSelect.title = 'Redaction style';
    for (const [value, text] of [['pixelate', 'Pixelate'], ['solid', 'Solid']]) {
      const opt = doc.createElement('option');
      opt.value = value;
      opt.textContent = text;
      styleSelect.appendChild(opt);
    }

    // v1.22.0 REQ-202: per-track "Re-scan span" action — auto tracks only
    // (visibility decided in syncTrackRow). The click is consumed by the
    // list's delegated click handler BEFORE the row-click seek.
    const rescanBtn = doc.createElement('button');
    rescanBtn.type = 'button';
    rescanBtn.className = 'rescan-btn';
    rescanBtn.dataset.trackId = String(trackId);
    rescanBtn.title = 'Re-scan this span: re-run detection here at a lower threshold and merge new boxes';
    rescanBtn.textContent = 'Re-scan';

    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.trackId = String(trackId);
    checkbox.title = 'Redact this track';

    row.append(swatch, label, span, times, styleSelect, rescanBtn, checkbox);
    return row;
  }

  /**
   * Sync one track row's live values in place (see renderTrackList for the
   * reconciliation rationale). `active` is the document's focused element —
   * a focused span input keeps its in-flight value (guard) and is synced
   * from the model on the render following its commit/blur. `selectedId`
   * (v1.22.0 REQ-201) drives the row's `.selected` highlight.
   * @param {HTMLLIElement} row
   * @param {import('./types.js').Track} track
   * @param {number} d Video duration (0 until metadata exists).
   * @param {Element | null} active Currently focused element, if any.
   * @param {number | undefined} [selectedId] The app's selected track id.
   */
  function syncTrackRow(row, track, d, active, selectedId) {
    row.className =
      'track-row' +
      (track.enabled ? '' : ' enabled-off') +
      (track.id === selectedId ? ' selected' : '');

    const swatch = /** @type {HTMLElement | null} */ (row.querySelector('.swatch'));
    if (swatch) swatch.style.background = track.enabled ? track.color : SAFE_GREEN;

    const label = row.querySelector('.label');
    if (label) {
      const base = track.enabled ? track.label : `${track.label} (visible)`;
      // v1.22.0 REQ-202: mean detection confidence readout — auto tracks
      // carry `track.conf` (tracker.finalize); manual tracks have none and
      // omit the suffix entirely (never an invented value).
      const conf = Number(track.conf);
      label.textContent =
        track.source === 'auto' && Number.isFinite(conf)
          ? `${base} · conf ${conf.toFixed(2)}`
          : base;
    }

    const span = row.querySelector('.span');
    if (span) {
      span.textContent = formatSpan(
        track.start,
        Number.isFinite(d) && d > 0 ? Math.min(track.end, d) : track.end,
      );
    }

    for (const inputEl of row.querySelectorAll('input.span-input')) {
      const input = /** @type {HTMLInputElement} */ (inputEl);
      const role = input.dataset.role === 'end' ? 'end' : 'start';
      const value = fmtClock(role === 'start' ? track.start : track.end);
      if (active !== input) input.value = value; // focused guard (REQ-108)
      const aria = `${track.label} ${role} time`;
      if (input.getAttribute('aria-label') !== aria) input.setAttribute('aria-label', aria);
    }

    const selectEl = row.querySelector('.style-select');
    if (selectEl) {
      const styleSelect = /** @type {HTMLSelectElement} */ (selectEl);
      const currentStyle = styleOf(track);
      // Only touch the select when out of sync — resetting .value would also
      // be harmless, but keep the DOM churn minimal.
      if (styleSelect.value !== currentStyle) styleSelect.value = currentStyle;
      const aria = `${track.label} redaction style`;
      if (styleSelect.getAttribute('aria-label') !== aria) styleSelect.setAttribute('aria-label', aria);
    }

    const checkboxEl = row.querySelector('input[type="checkbox"]');
    if (checkboxEl) {
      /** @type {HTMLInputElement} */ (checkboxEl).checked = !!track.enabled;
    }

    // v1.22.0 REQ-202: the re-scan action exists for AUTO tracks only and
    // reads "…" while its pass is running (setRescanBusy).
    const rescanEl = /** @type {HTMLButtonElement | null} */ (row.querySelector('.rescan-btn'));
    if (rescanEl) {
      const busy = rescanBusyId === track.id;
      rescanEl.hidden = track.source !== 'auto';
      rescanEl.disabled = busy;
      const text = busy ? '…' : 'Re-scan';
      if (rescanEl.textContent !== text) rescanEl.textContent = text;
    }
  }

  // --- Timeline events: pointerup tap = seek, dblclick on chip = toggle,
  //     chip-edge drag = trim (REQ-103; v1.6.2: seek on pointerup) ----------

  /** Live chip-edge trim drag: which track/edge is moving, and whether the
   * pointer actually moved (a no-move click must not jump-trim the edge). */
  let trimDrag = /** @type {{id: number, zone: 'start'|'end', moved: boolean} | null} */ (null);
  /**
   * v1.15.0 REQ-125: live trim-CREATE drag (trim mode) — anchor time plus the
   * live ghost preview element (null ghost when the regions layer is absent;
   * creation still works). A release shorter than MIN_TRACK_SPAN_S is ignored
   * and falls back to the tap-seek verdict.
   * @type {{t0: number, ghost: HTMLElement | null} | null}
   */
  let trimCreate = null;
  /**
   * v1.15.0 REQ-125: live trim-REGION edge drag (delegated on the regions
   * layer; region presses never reach the strip handlers).
   * @type {{id: number, which: 'start'|'end', pointerId: number} | null}
   */
  let regionDrag = null;
  /**
   * Strip pointerdown anchor for the pointerup gesture decision (v1.6.2):
   * press position plus the press-time hit verdict — whether it latched a
   * chip edge zone (that side's trim owns the gesture) and whether the press
   * was primary-button (only primary presses ever seeked via click either).
   */
  let downPos =
    /** @type {{x: number, y: number, edgeLeft: boolean, edgeRight: boolean, primary: boolean} | null} */ (
      null
    );
  /** Chip element whose inline cursor we overrode for the edge affordance. */
  let hoverChip = /** @type {HTMLElement | null} */ (null);
  /**
   * v1.22.0 REQ-204: live VIEW PAN drag (shift+drag on the strip) — the
   * press point, the captured pointerId and the drag-start view window. The
   * window the drag started from is the base (not the live state) so a slow
   * host refresh can never compound the delta.
   * @type {{pointerId: number, startX: number, view: {start: number, end: number}} | null}
   */
  let panDrag = null;

  function timelinePos(e) {
    if (!timeline || !timeline.getBoundingClientRect) return null;
    const rect = timeline.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, width: rect.width };
  }

  /** Chips-container geometry (same space hitTestTimeline maps back to). */
  function chipsPos(e) {
    if (!chipsContainer || !chipsContainer.getBoundingClientRect) return null;
    const rect = chipsContainer.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, width: rect.width };
  }

  // --- Trim regions (v1.15.0 REQ-125): layer render + gestures --------------

  /**
   * Map a client x to a time through the CHIPS-layer rect — the SAME axis the
   * chips, playhead, thumb and every other timeline mapping use (v1.6.1 REG-1
   * rule). v1.22.0 REQ-204: the result maps through the VIEW window (full
   * view → the old full-duration math).
   * @param {number} clientX
   * @returns {number | null} Seconds, or null when geometry/duration is unusable.
   */
  function trimTimeAtClientX(clientX) {
    const rect =
      chipsContainer && typeof chipsContainer.getBoundingClientRect === 'function'
        ? chipsContainer.getBoundingClientRect()
        : null;
    const d = duration();
    if (!rect || !(rect.width > 0) || !(d > 0)) return null;
    return pctToTime(timelineTimeAt(clientX - rect.left, rect.width, 100), getView());
  }

  /**
   * Build one greyed trim-region overlay (scissors at both edges, ✕ remove
   * button). The edges are the drag handles (`.trim-cut`); the ✕ is the
   * remove button — both consumed by the delegated layer listeners below.
   * @param {{id: number, startPct: number, widthPct: number}} view
   * @returns {HTMLElement}
   */
  function buildTrimRegion(view) {
    const el = doc.createElement('div');
    el.className = 'trim-region';
    el.dataset.trimId = String(view.id);
    el.title = 'Trim region — drag an edge to adjust · ✕ or double-click removes';
    el.style.left = `${view.startPct}%`;
    el.style.width = `${view.widthPct}%`;
    for (const which of ['start', 'end']) {
      const edge = doc.createElement('span');
      edge.className = 'trim-cut trim-edge';
      edge.dataset.which = which;
      edge.textContent = '✂';
      edge.title = 'Drag to adjust the trim edge';
      el.appendChild(edge);
    }
    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'trim-remove';
    remove.dataset.trimId = String(view.id);
    remove.textContent = '✕';
    remove.title = 'Remove this trim region';
    el.appendChild(remove);
    return el;
  }

  /** Fresh live-create ghost preview in the regions layer (may be null). */
  function makeGhost() {
    if (!doc || !trimRegions || typeof trimRegions.appendChild !== 'function') return null;
    const ghost = doc.createElement('div');
    ghost.className = 'trim-ghost';
    trimRegions.appendChild(ghost);
    return ghost;
  }

  /** Position the live-create ghost between two times (clamped, ordered). */
  function positionGhost(ghost, t0, t1) {
    const d = duration();
    if (!ghost || !(d > 0)) return;
    const a = Math.min(Math.max(Math.min(t0, t1), 0), d);
    const b = Math.min(Math.max(Math.max(t0, t1), 0), d);
    ghost.style.left = `${(a / d) * 100}%`;
    ghost.style.width = `${((b - a) / d) * 100}%`;
  }

  /** End the create-drag with no residue (cancel path). */
  function dropGhost() {
    if (trimCreate?.ghost) trimCreate.ghost.remove();
    trimCreate = null;
  }

  function onTimelineDblClick(e) {
    const p = timelinePos(e);
    if (!p) return;
    const d = duration();
    if (!(d > 0)) return;
    const hit = hitTestTimeline(p.x, p.y, p.width, getState().tracks, d, edgePx, getView());
    if (hit) callToggle(hit.track.id, !hit.track.enabled);
  }

  /**
   * Trim drag lifecycle: pointerdown inside a chip's ± edge zone starts it
   * ('body' falls through to the pointerup tap-to-seek), pointermove maps
   * the pointer to a time and re-emits the span through onTrimTrack (the
   * moving edge is pre-clamped so the min-span floor holds at the drag
   * layer), pointerup ends it. The handlers are wired to the whole
   * #timeline STRIP (REQ-110): a pointerdown at a full-span chip's end-edge
   * boundary pixel hit-tests to the strip — box interiors exclude the right
   * boundary coordinate, so binding to the chips layer alone would never
   * even see the event. Pointer x is still mapped through the CHIPS-layer
   * rect (the space the chips are laid out in); hitTestTimeline's outward
   * zones handle points slightly outside it.
   */
  function applyTrimDrag(clientX) {
    if (!trimDrag || !chipsContainer || !chipsContainer.getBoundingClientRect) return;
    const rect = chipsContainer.getBoundingClientRect();
    const d = duration();
    if (!(rect.width > 0) || !(d > 0)) return;
    const track = (getState().tracks || []).find((tr) => tr.id === trimDrag?.id);
    if (!track) return;
    const t = pctToTime(timelineTimeAt(clientX - rect.left, rect.width, 100), getView());
    const start = trimDrag.zone === 'start' ? Math.min(t, track.end - MIN_TRACK_SPAN_S) : track.start;
    const end = trimDrag.zone === 'end' ? Math.max(t, track.start + MIN_TRACK_SPAN_S) : track.end;
    callTrim(trimDrag.id, start, end);
  }

  function onChipsPointerDown(e) {
    // Anchor EVERY press (any button, any strip point) for the pointerup
    // decision; the edge flags need the chips-space hit test below.
    downPos = {
      x: e.clientX,
      y: e.clientY,
      edgeLeft: false,
      edgeRight: false,
      primary: e.button === 0,
    };
    if (!downPos.primary) return;
    // v1.22.0 REQ-204: shift+press starts a VIEW PAN drag — orthogonal to
    // every other strip gesture (thumb drag = seek still owns its own
    // surface; chip edges = trim are skipped for a shift press; plain drag =
    // nothing). At full view panWindow clamps to a no-op.
    if (e.shiftKey) {
      panDrag = { pointerId: e.pointerId, startX: e.clientX, view: getView() };
      try {
        timeline.setPointerCapture(e.pointerId);
      } catch {
        /* detached strip — capture is best-effort */
      }
      e.preventDefault();
      return;
    }
    const p = chipsPos(e);
    if (!p) return;
    const d = duration();
    if (!(d > 0)) return;
    const hit = hitTestTimeline(p.x, p.y, p.width, getState().tracks, d, edgePx, getView());
    if (hit) {
      // Latch the press-time zone: an edge press hands the gesture to the
      // trim path (timelinePointerAction will never turn it into a seek),
      // a body press keeps the tap-to-seek path alive.
      downPos.edgeLeft = hit.zone === 'start';
      downPos.edgeRight = hit.zone === 'end';
    }
    if (!hit || hit.zone === 'body') {
      // v1.15.0 REQ-125: in trim mode, a press on the bare strip or a chip
      // BODY starts a trim-CREATE drag — the region runs from the press time
      // to the release time. (A press on a trim REGION never gets here: the
      // regions layer stops propagation on its own pointerdowns.) A release
      // shorter than MIN_TRACK_SPAN_S is ignored as a create and falls back
      // to the tap-seek verdict in onChipsPointerUp.
      if (getState().trimMode) {
        trimCreate = {
          t0: pctToTime(timelineTimeAt(p.x, p.width, 100), getView()),
          ghost: makeGhost(),
        };
        try {
          timeline.setPointerCapture(e.pointerId);
        } catch {
          /* detached strip — capture is best-effort */
        }
        e.preventDefault();
      }
      return; // plain chip / bare rail tap → pointerup-seek path
    }
    trimDrag = { id: hit.track.id, zone: hit.zone, moved: false };
    try {
      timeline.setPointerCapture(e.pointerId);
    } catch {
      /* detached strip — capture is best-effort */
    }
    e.preventDefault();
  }

  function onChipsPointerMove(e) {
    // v1.22.0 REQ-204: shift-drag pans the view window (1 px = span/width
    // seconds, drag right = window moves earlier — content follows the
    // pointer). Based on the DRAG-START view; the host persists + refreshes.
    if (panDrag) {
      if (e.pointerId !== panDrag.pointerId) return;
      const rect =
        chipsContainer && typeof chipsContainer.getBoundingClientRect === 'function'
          ? chipsContainer.getBoundingClientRect()
          : null;
      const d = duration();
      if (rect && rect.width > 0 && d > 0) {
        const span = panDrag.view.end - panDrag.view.start;
        const delta = ((panDrag.startX - e.clientX) / rect.width) * span;
        callZoomView(panWindow(panDrag.view, delta, d));
      }
      e.preventDefault();
      return;
    }
    if (trimDrag) {
      trimDrag.moved = true;
      applyTrimDrag(e.clientX);
      e.preventDefault();
      return;
    }
    if (trimCreate) {
      // v1.15.0: live ghost preview for the region being drawn.
      const t = trimTimeAtClientX(e.clientX);
      if (t != null) positionGhost(trimCreate.ghost, trimCreate.t0, t);
      e.preventDefault();
      return;
    }
    updateChipCursor(e);
  }

  function endTrimDrag(e) {
    if (!trimDrag) return;
    if (trimDrag.moved) applyTrimDrag(e.clientX);
    trimDrag = null;
    downPos = null;
    try {
      timeline.releasePointerCapture(e.pointerId);
    } catch {
      /* never captured or already released */
    }
  }

  /**
   * Seek fires here, on POINTERUP (v1.6.2): WebKit never fires `click` on
   * plain divs for touch, so the old click-based seek was dead for finger
   * taps on iOS Safari. One decision path now serves both pointer kinds —
   * a mouse tap is a pointerdown/up pair too, so the click listener is gone
   * entirely (no double-fire is possible). A press that latched a chip edge
   * resolves to a trim (an edge tap is a trim-side no-op, NOT a seek), and a
   * press→release that moved beyond the threshold is a drag (never a seek,
   * v1.6.1 REG-1).
   */
  function onChipsPointerUp(e) {
    // v1.22.0 REQ-204: a pan drag CONSUMES its release (never a seek).
    if (panDrag) {
      const pointerId = panDrag.pointerId;
      panDrag = null;
      downPos = null; // exactly one verdict per press→release pair
      try {
        timeline.releasePointerCapture(pointerId);
      } catch {
        /* never captured or already released */
      }
      return;
    }
    const start = downPos;
    endTrimDrag(e); // no-op unless this gesture is a chip-edge trim
    // v1.15.0 REQ-125: finish a trim-CREATE drag first. A region of at least
    // MIN_TRACK_SPAN_S is committed through onTrimAdd and CONSUMES the
    // gesture (never a seek); a shorter drag is ignored as a create and
    // falls through to the normal verdict (a still tap stays a seek).
    if (trimCreate) {
      const t0 = trimCreate.t0;
      const t1 = trimTimeAtClientX(e.clientX);
      if (trimCreate.ghost) trimCreate.ghost.remove();
      trimCreate = null;
      try {
        timeline.releasePointerCapture(e.pointerId);
      } catch {
        /* never captured or already released */
      }
      if (t1 != null && Math.abs(t1 - t0) >= MIN_TRACK_SPAN_S) {
        downPos = null; // exactly one verdict per press→release pair
        callTrimAdd(Math.min(t0, t1), Math.max(t0, t1));
        return;
      }
    }
    if (!start || !start.primary) return;
    downPos = null; // exactly one verdict per press→release pair
    if (timelinePointerAction(start.x, e.clientX, start.edgeLeft, start.edgeRight, CLICK_SEEK_MAX_DRAG_PX) !== 'seek') {
      return;
    }
    // Seek axis = the CHIPS layer (the rect hitTestTimeline maps and the
    // playhead is positioned in). Mapping through the full strip rect put
    // every seek off the tapped point by the timecodes + padding width
    // (field-reported REG-1); points on the labels/padding clamp to the ends.
    // v1.22.0 REQ-204: the tap maps through the VIEW window.
    const p = chipsPos(e) ?? timelinePos(e);
    if (!p) return;
    const d = duration();
    if (!(d > 0)) return;
    callSeek(pctToTime(timelineTimeAt(p.x, p.width, 100), getView()));
  }

  function onChipsPointerCancel() {
    // A canceled gesture (palm rejection, …) must leave NO residue: both the
    // trim drag and the pointerup anchor reset here, so a canceled press can
    // never turn a later tap into a trim or a seek (v1.6.1 REG-1). v1.15.0:
    // the create-drag ghost dies with it too. v1.22.0 REQ-204: the pan drag.
    trimDrag = null;
    dropGhost();
    downPos = null;
    panDrag = null;
    resetChipCursor();
  }

  function onChipsPointerLeave() {
    resetChipCursor();
  }

  /** Reset the hover cursor override back to the chip's inline pointer. */
  function resetChipCursor() {
    if (hoverChip) {
      hoverChip.style.cursor = 'pointer';
      hoverChip = null;
    }
  }

  /** col-resize over chip edge zones, pointer over chip bodies (REQ-103).
   * v1.15.0: in trim mode the strip is crosshair (set in render) — the chip
   * cursor overrides step aside; trim-region edges carry their own CSS
   * col-resize affordance. */
  function updateChipCursor(e) {
    if (!chipsContainer) return;
    if (getState().trimMode) {
      resetChipCursor();
      return;
    }
    const p = chipsPos(e);
    const d = duration();
    let cursor = '';
    if (p && d > 0) {
      const hit = hitTestTimeline(p.x, p.y, p.width, getState().tracks, d, edgePx);
      cursor = !hit ? '' : hit.zone === 'body' ? 'pointer' : 'col-resize';
    }
    const target =
      e.target && typeof e.target.closest === 'function'
        ? e.target.closest('[data-track-id]')
        : null;
    if (hoverChip && hoverChip !== target) resetChipCursor();
    if (target && cursor) {
      target.style.cursor = cursor;
      hoverChip = target;
    }
  }

  // --- Trim regions layer: edge drag + remove (v1.15.0 REQ-125) -------------

  /**
   * Region presses are consumed HERE (stopPropagation — the strip handlers
   * must never read a region press as a chip-edge trim latch or a create-drag
   * start). A press on a `.trim-cut` edge starts the edge drag (pointer
   * captured on the LAYER, like the strip gesture); a press on the region
   * body is inert (the ✕ click and double-click remove instead).
   */
  function onTrimRegionPointerDown(e) {
    e.stopPropagation();
    const target = e.target;
    const region =
      target && typeof target.closest === 'function' ? target.closest('.trim-region') : null;
    if (!region || e.button !== 0) return;
    const edge = typeof target.closest === 'function' ? target.closest('.trim-cut') : null;
    if (!edge) return;
    const id = Number(region.dataset.trimId);
    const which = edge.dataset.which === 'end' ? 'end' : 'start';
    if (!Number.isFinite(id)) return;
    regionDrag = { id, which, pointerId: e.pointerId };
    try {
      trimRegions.setPointerCapture(e.pointerId);
    } catch {
      /* detached layer — capture is best-effort */
    }
    e.preventDefault();
  }

  function onTrimRegionPointerMove(e) {
    if (!regionDrag || e.pointerId !== regionDrag.pointerId) return;
    const t = trimTimeAtClientX(e.clientX);
    if (t != null) {
      callTrimEdge(regionDrag.id, regionDrag.which, t); // moveTrimEdge clamps
    }
    e.preventDefault();
  }

  /** End the region edge drag on any path (up / cancel). */
  function endRegionDrag(e) {
    if (!regionDrag) return;
    regionDrag = null;
    try {
      trimRegions.releasePointerCapture(e.pointerId);
    } catch {
      /* never captured or already released */
    }
  }

  function onTrimRegionPointerUp(e) {
    endRegionDrag(e);
  }
  function onTrimRegionPointerCancel(e) {
    endRegionDrag(e);
  }

  /** ✕ button click → onTrimRemove (stopPropagation: never a strip gesture). */
  function onTrimRegionClick(e) {
    const target = e.target;
    const btn = target && typeof target.closest === 'function' ? target.closest('.trim-remove') : null;
    if (!btn) return;
    e.stopPropagation();
    const id = Number(btn.dataset.trimId);
    if (Number.isFinite(id)) callTrimRemove(id);
  }

  /** Double-click on a region → remove (REQ-125: "double-click or a
   * per-region ✕"). The ✕'s own click already removed it — a double-click
   * there is a harmless second remove of an unknown id. */
  function onTrimRegionDblClick(e) {
    const target = e.target;
    const region =
      target && typeof target.closest === 'function' ? target.closest('.trim-region') : null;
    if (!region) return;
    e.stopPropagation();
    const id = Number(region.dataset.trimId);
    if (Number.isFinite(id)) callTrimRemove(id);
  }

  // --- View zoom controls + waveform strip (v1.22.0 REQ-204/206) ------------

  /** One #zoom-in / #zoom-out click step (stronger than the wheel notch — a
   * discrete click should travel; the wheel keeps REQ-204's 1.2). */
  const ZOOM_BUTTON_FACTOR = 1.5;

  /** Apply one zoom step around the strip center through the host hook. */
  function zoomBy(factor) {
    const d = duration();
    if (!(d > 0)) return;
    callZoomView(zoomStep(getView(), factor, 50, d));
  }
  function onZoomInClick() {
    zoomBy(ZOOM_BUTTON_FACTOR);
  }
  function onZoomOutClick() {
    zoomBy(1 / ZOOM_BUTTON_FACTOR);
  }
  function onZoomFitClick() {
    const d = duration();
    if (!(d > 0)) return;
    callZoomView(fitWindow(d));
  }

  /**
   * ctrl/cmd+wheel on the strip zooms AT THE CURSOR (REQ-204: the time under
   * the pointer stays fixed — anchorPct from the pointer x). Plain wheel is
   * untouched (page scroll); ctrl+wheel also carries trackpad pinch on
   * Chromium. Registered non-passive so preventDefault can stop the
   * browser's own page zoom.
   * @param {WheelEvent} e
   */
  function onTimelineWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    const d = duration();
    if (!(d > 0)) return;
    const p = chipsPos(e) ?? timelinePos(e);
    const anchorPct = p ? Math.min(Math.max((p.x / p.width) * 100, 0), 100) : 50;
    const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR;
    callZoomView(zoomWindow(getView(), factor, anchorPct, d));
    e.preventDefault();
  }

  /**
   * v1.22.0 REQ-206: draw the waveform strip from getState().waveform (the
   * host's decoded peaks — decode/cache live in main.js + src/audio.js).
   * Bars map through the VIEW window (re-render rides zoom/pan refreshes),
   * sit symmetric around the vertical center, and tint the PLAYED portion
   * (bar time ≤ playhead) in the accent color at 60% alpha. No peaks → the
   * canvas hides itself (silent degrade for silent/undecodable audio).
   */
  function drawWaveform() {
    if (!waveformCanvas || closed || typeof waveformCanvas.getContext !== 'function') return;
    const peaks = getState().waveform;
    const hasPeaks = !!peaks && typeof peaks.length === 'number' && peaks.length > 0;
    if (waveformCanvas.hidden !== !hasPeaks) waveformCanvas.hidden = !hasPeaks;
    if (!hasPeaks) return;
    const d = duration();
    if (!(d > 0)) return;
    const dpr =
      typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const rect = waveformCanvas.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return;
    const bw = Math.max(1, Math.round(rect.width * dpr));
    const bh = Math.max(1, Math.round(rect.height * dpr));
    if (waveformCanvas.width !== bw) waveformCanvas.width = bw;
    if (waveformCanvas.height !== bh) waveformCanvas.height = bh;
    const wctx = waveformCanvas.getContext('2d');
    if (!wctx) return;
    wctx.clearRect(0, 0, bw, bh);
    const view = getView();
    const t = displayTime();
    const mid = bh / 2;
    const n = peaks.length;
    const barW = Math.max(1, bw / n - 1);
    const styles =
      typeof getComputedStyle === 'function' ? getComputedStyle(waveformCanvas) : null;
    const accent = (styles?.getPropertyValue('--accent') || '').trim() || '#F5A623';
    for (let i = 0; i < n; i++) {
      const barTime = ((i + 0.5) / n) * d;
      const x = (timeToPct(barTime, view) / 100) * bw;
      if (x < -barW || x > bw + barW) continue; // outside the view window
      const amp = Math.min(1, Math.max(0, Number(peaks[i]) || 0));
      const half = Math.max(1 * dpr, amp * (bh / 2 - 2 * dpr));
      wctx.globalAlpha = barTime <= t ? 0.6 : 0.35;
      wctx.fillStyle = barTime <= t ? accent : '#9AA4B2';
      wctx.fillRect(x, mid - half, barW, half * 2);
    }
    wctx.globalAlpha = 1;
  }

  // Waveform seek: click/drag maps through the waveform element's own rect
  // (the bars share the chips layer's width — same view mapping).
  const WAVE_SEEK_THROTTLE_MS = 50;
  /** @type {{pointerId: number, lastSeekAt: number} | null} */
  let waveDrag = null;

  function waveTimeAtClientX(clientX) {
    if (!waveformCanvas || typeof waveformCanvas.getBoundingClientRect !== 'function') {
      return null;
    }
    const rect = waveformCanvas.getBoundingClientRect();
    const d = duration();
    if (!(rect.width > 0) || !(d > 0)) return null;
    return pctToTime(timelineTimeAt(clientX - rect.left, rect.width, 100), getView());
  }

  function onWavePointerDown(e) {
    if (e.button !== 0) return;
    waveDrag = { pointerId: e.pointerId, lastSeekAt: 0 };
    try {
      waveformCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* detached canvas — capture is best-effort */
    }
    const t = waveTimeAtClientX(e.clientX);
    if (t != null) callSeek(t);
    e.preventDefault();
  }

  function onWavePointerMove(e) {
    if (!waveDrag || e.pointerId !== waveDrag.pointerId) return;
    const now = Date.now();
    if (now - waveDrag.lastSeekAt < WAVE_SEEK_THROTTLE_MS) return;
    const t = waveTimeAtClientX(e.clientX);
    if (t == null) return;
    waveDrag.lastSeekAt = now;
    callSeek(t);
  }

  /** End the waveform drag on any path; `seek` adds the exact endpoint. */
  function endWaveDrag(e, seek) {
    if (!waveDrag) return;
    const pointerId = waveDrag.pointerId;
    waveDrag = null;
    try {
      waveformCanvas.releasePointerCapture(pointerId);
    } catch {
      /* never captured or already released */
    }
    if (seek) {
      const t = waveTimeAtClientX(e.clientX);
      if (t != null) callSeek(t);
    }
  }

  function onWavePointerUp(e) {
    endWaveDrag(e, true);
  }
  function onWavePointerCancel(e) {
    endWaveDrag(e, false);
  }

  // --- Scrub thumb: drag = throttled scrub seeks + exact endpoint (v1.7.0) --

  /** Min interval between live scrub seeks during a thumb drag, ms. The exact
   * endpoint seek rides pointerup, so throttling never loses the destination. */
  const THUMB_SEEK_THROTTLE_MS = 50;

  /** Live thumb drag: the captured pointerId and the last throttled-seek stamp. */
  let thumbDrag = /** @type {{pointerId: number, lastSeekAt: number} | null} */ (null);
  /**
   * Release pin (v1.8.0): the endpoint time the thumb was left at on
   * pointerup, guarded until the seek lands. null = no pin. Without it the
   * drag guard dropped BEFORE the endpoint seek completed and the frame loop
   * yanked the thumb back to the stale pre-seek position — on desktop
   * browsers/hardware with real seek latency that visibly reads as "dragging
   * the scrub handle doesn't stick".
   * @type {number | null}
   */
  let thumbPin = null;
  /**
   * v1.9.0 hard deadline for the release pin, epoch ms (0 = no pin). The pin
   * clears at the earlier of thumbPinSettled / `seeked` / this deadline —
   * suppression can never latch forever (see updateThumb).
   * @type {number}
   */
  let thumbPinUntil = 0;

  /** Drop the release pin (seek landed / gesture restarted / teardown). */
  function clearThumbPin() {
    thumbPin = null;
    thumbPinUntil = 0;
  }

  /**
   * v1.8.0 capture net. The drag handlers above live on the thumb itself, so
   * they only receive events while `setPointerCapture` retargets the gesture.
   * If capture silently fails (engine/driver edge cases), the first move that
   * outruns the 20px thumb targets ANOTHER element and the drag dies
   * mid-gesture — the classic desktop "the scrub handle doesn't work" — and a
   * release outside #timeline would leak `thumbDrag` (the thumb freezes
   * forever, since updateThumb steps aside while it is set). While a drag is
   * live, window-level capture listeners mirror every event whose target is
   * NOT the thumb into the same handlers; with a healthy capture the target
   * IS the thumb and these are exact no-ops (the thumb handler owns it).
   * @param {PointerEvent} e
   * @returns {boolean} True when the net consumed the event.
   */
  function thumbNetHandle(e) {
    if (!thumbDrag || e.pointerId !== thumbDrag.pointerId || e.target === thumb) return false;
    return true;
  }
  function onWindowThumbMove(e) {
    if (thumbNetHandle(e)) onThumbPointerMove(e);
  }
  function onWindowThumbUp(e) {
    if (thumbNetHandle(e)) onThumbPointerUp(e);
  }
  function onWindowThumbCancel(e) {
    if (thumbNetHandle(e)) onThumbPointerCancel(e);
  }
  /** Attach/detach the gesture-scoped capture net. Guarded for the node test
   * environment (no window — destroy() must stay inert there too). */
  function armThumbNet() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('pointermove', onWindowThumbMove, true);
    window.addEventListener('pointerup', onWindowThumbUp, true);
    window.addEventListener('pointercancel', onWindowThumbCancel, true);
  }
  function disarmThumbNet() {
    if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;
    window.removeEventListener('pointermove', onWindowThumbMove, true);
    window.removeEventListener('pointerup', onWindowThumbUp, true);
    window.removeEventListener('pointercancel', onWindowThumbCancel, true);
  }

  /**
   * Map a client x to a seek time through the CHIPS-layer rect — the SAME axis
   * the strip tap-seek, hitTestTimeline, the playhead and the thumb itself are
   * positioned in (v1.6.1 REG-1 rule: never map through the full strip rect).
   * v1.22.0 REQ-204: view-window mapping (full view → the old math).
   * @param {number} clientX Pointer client x, CSS px.
   * @returns {number | null} Seconds, or null when geometry/duration is unusable.
   */
  function thumbTimeAtClientX(clientX) {
    const rect =
      chipsContainer && typeof chipsContainer.getBoundingClientRect === 'function'
        ? chipsContainer.getBoundingClientRect()
        : null;
    const d = duration();
    if (!rect || !(rect.width > 0) || !(d > 0)) return null;
    return pctToTime(timelineTimeAt(clientX - rect.left, rect.width, 100), getView());
  }

  /** Move the thumb visually (no seek) — the drag's live follow.
   * v1.22.0 REQ-204: view-window position. */
  function moveThumbToTime(t) {
    if (!thumb || !thumb.style) return;
    thumb.style.left = `${timeToPct(t, getView())}%`;
  }

  /**
   * End a live thumb drag on ANY path (v1.9.0 residue guarantee): releases
   * the capture net, clears the pin and the drag flag. `thumbDrag` must
   * never leak — updateThumb steps aside while it is set, so a leaked drag
   * reads as "the thumb froze forever" (the exact field symptom).
   * @param {number} [releasePointerId] Pointer id for releasePointerCapture.
   */
  function endThumbGesture(releasePointerId) {
    if (!thumbDrag) return;
    const pointerId = thumbDrag.pointerId;
    thumbDrag = null;
    disarmThumbNet();
    clearThumbPin();
    try {
      thumb.releasePointerCapture(releasePointerId ?? pointerId);
    } catch {
      /* never captured or already released */
    }
  }

  /** Window blur mid-drag (alt-tab, OS overlay, devtools): the pointerup that
   * would end the gesture may never arrive, so the blur ends it instead
   * (v1.9.0). Editor-lifetime listener — removed in destroy(). */
  function onWindowBlur() {
    if (thumbDrag) endThumbGesture();
  }
  /** Guarded for the node test environment (no window). */
  function armBlurGuard() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('blur', onWindowBlur);
  }
  function disarmBlurGuard() {
    if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;
    window.removeEventListener('blur', onWindowBlur);
  }

  function onThumbPointerDown(e) {
    if (e.button !== 0) return;
    // The strip gesture block must never see this press: no chip-edge trim
    // latch, no tap-to-seek anchor — the thumb owns scrubbing only.
    e.stopPropagation();
    thumbDrag = { pointerId: e.pointerId, lastSeekAt: 0 };
    clearThumbPin(); // a fresh gesture owns the position again
    try {
      thumb.setPointerCapture(e.pointerId);
    } catch {
      /* detached thumb — capture is best-effort */
    }
    armThumbNet(); // v1.8.0: gesture-scoped fallback if capture silently fails
    e.preventDefault();
  }

  function onThumbPointerMove(e) {
    if (!thumbDrag || e.pointerId !== thumbDrag.pointerId) return;
    const t = thumbTimeAtClientX(e.clientX);
    if (t == null) return;
    moveThumbToTime(t); // live follow regardless of seek throttling
    const now = Date.now();
    if (now - thumbDrag.lastSeekAt < THUMB_SEEK_THROTTLE_MS) return;
    thumbDrag.lastSeekAt = now;
    callSeek(t);
  }

  function onThumbPointerUp(e) {
    if (!thumbDrag || e.pointerId !== thumbDrag.pointerId) return;
    const pointerId = thumbDrag.pointerId;
    thumbDrag = null;
    disarmThumbNet();
    try {
      thumb.releasePointerCapture(pointerId);
    } catch {
      /* never captured or already released */
    }
    // Exact endpoint seek (never throttled). A still tap on the thumb lands at
    // the pointer's own mapped time — the playhead's position, a no-op re-seek.
    const t = thumbTimeAtClientX(e.clientX);
    if (t != null) {
      moveThumbToTime(t);
      // v1.8.0 release pin, v1.9.0 time-boxed: pin the release point until
      // the seek lands OR THUMB_PIN_MS elapses (updateThumb clears at the
      // earlier of settled / deadline) — the stale pre-seek currentTime must
      // not yank the thumb back, and the pin must never hold forever.
      thumbPin = t;
      thumbPinUntil = Date.now() + THUMB_PIN_MS;
      callSeek(t);
    }
  }

  function onThumbPointerCancel(e) {
    if (!thumbDrag || e.pointerId !== thumbDrag.pointerId) return;
    // Canceled gesture (palm rejection, …): no endpoint seek, no residue.
    endThumbGesture(e.pointerId);
  }

  /**
   * v1.9.0: the pointer LEFT the thumb mid-gesture. With a healthy
   * setPointerCapture this never fires during a drag (boundary events are
   * retargeted to the capture element), so a leave during a live drag means
   * capture was lost — end the gesture like a cancel instead of leaking the
   * drag flag (which would freeze the thumb forever).
   */
  function onThumbPointerLeave(e) {
    if (!thumbDrag || e.pointerId !== thumbDrag.pointerId) return;
    endThumbGesture(e.pointerId);
  }

  /**
   * Keyboard on the focused thumb: ←/→ ±1 frame via hooks.onStepFrame (the
   * SAME step math as the transport buttons), ↑/↓ ±1 s via onSeek. Handled
   * keys stopPropagation so the doc-level shortcuts never double-fire; every
   * other key (Space, Tab, …) bubbles untouched.
   */
  function onThumbKeyDown(e) {
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        callStepFrame(-1);
        break;
      case 'ArrowRight':
        callStepFrame(1);
        break;
      case 'ArrowUp':
        callSeek(clampTime(displayTime() + 1));
        break;
      case 'ArrowDown':
        callSeek(clampTime(displayTime() - 1));
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // --- Track list events: checkbox = toggle, select = style, span inputs =
  //     trim (REQ-108), row = seek -------------------------------------------

  /** This target is one of the row's start/end span inputs (REQ-108). */
  function isSpanInput(target) {
    return !!(target && typeof target.closest === 'function' && target.closest('input.span-input'));
  }

  function onListChange(e) {
    const target = e.target;
    if (!target) return;
    if (target.tagName === 'SELECT') {
      // Style flip (REQ-101): only the contract literals ever leave here.
      const id = Number(target.dataset && target.dataset.trackId);
      if (Number.isFinite(id)) {
        callSetStyle(id, target.value === 'solid' ? 'solid' : 'pixelate');
      }
      // v1.6.1 REG-2: release focus after the choice so the doc-level
      // transport shortcuts keep working (selects are a typing surface while
      // focused; a committed choice is done with it).
      if (typeof target.blur === 'function') target.blur();
      return;
    }
    if (isSpanInput(target)) {
      // Span edit (REQ-108): committed on change (blur / Enter). Invalid
      // input REVERTS to the model value; valid input goes through the SAME
      // trim path as the chip-edge drag (onTrimTrack → trimTrack), so the
      // chips, readout, preview and export span all update together.
      const id = Number(target.dataset && target.dataset.trackId);
      const role = target.dataset && target.dataset.role === 'end' ? 'end' : 'start';
      const track = (getState().tracks || []).find((tr) => tr.id === id);
      if (!track) return;
      const parsed = parseClockInput(target.value, duration());
      if (parsed == null) {
        target.value = fmtClock(role === 'start' ? track.start : track.end);
        return;
      }
      // Canonicalize even when the browser fired change without a blur.
      target.value = fmtClock(parsed);
      callTrim(id, role === 'start' ? parsed : track.start, role === 'end' ? parsed : track.end);
      return;
    }
    if (target.type !== 'checkbox') return;
    const id = Number(target.dataset && target.dataset.trackId);
    if (Number.isFinite(id)) callToggle(id, !!target.checked);
  }

  /**
   * Span-input keyboard (REQ-108): Enter commits (blur fires change) and
   * Escape reverts to the model value before committing. The doc-level
   * shortcuts ignore events from inputs, but blurring on Enter keeps the
   * edit session explicit.
   */
  function onListKeyDown(e) {
    const target = e.target;
    if (!isSpanInput(target)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      target.blur(); // commit: change fires on blur when dirty
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const id = Number(target.dataset && target.dataset.trackId);
      const role = target.dataset && target.dataset.role === 'end' ? 'end' : 'start';
      const track = (getState().tracks || []).find((tr) => tr.id === id);
      if (track) target.value = fmtClock(role === 'start' ? track.start : track.end);
      target.blur();
    }
  }

  function onListClick(e) {
    const target = e.target;
    if (target && (target.type === 'checkbox' || target.tagName === 'SELECT' || isSpanInput(target))) {
      return;
    }
    // v1.22.0 REQ-202: the row's Re-scan button owns its click (never a
    // row-click seek; the row itself carries data-track-id too, so the
    // button must be resolved first).
    const rescanBtn =
      target && typeof target.closest === 'function' ? target.closest('.rescan-btn') : null;
    if (rescanBtn) {
      const id = Number(rescanBtn.dataset && rescanBtn.dataset.trackId);
      if (Number.isFinite(id)) {
        rescanBusyId = id; // the row reads "…" until main.js clears the flag
        callRescan(id);
        render(); // repaint the busy button immediately
      }
      return;
    }
    const row =
      target && typeof target.closest === 'function'
        ? target.closest('[data-track-id]')
        : null;
    if (!row) return;
    const id = Number(row.dataset && row.dataset.trackId);
    const track = (getState().tracks || []).find((tr) => tr.id === id);
    if (track) {
      // v1.22.0 REQ-201: a row click SELECTS the track (K-keyframe target +
      // keyframe markers) in addition to the existing jump to its start.
      callSelect(id);
      callSeek(clampTime(track.start));
    }
  }

  // --- Manual box: canvas-space box → native display px --------------------

  /**
   * The manual-box pointer commit (REQ-015 flow, unchanged gesture):
   *   - default: a NEW manual track via hooks.onManualBox(box, t);
   *   - v1.22.0 REQ-201: when a MANUAL track is SELECTED (getState()
   *     .selectedTrackId) and the onKeyframe hook exists, the drawn box
   *     instead ARMS a pending keyframe (B draws) — the dashed box stays
   *     visible until K commits it AT THE PLAYHEAD (onKeyframe(trackId,
   *     box, displayTime())) or Escape discards it. The drawn box never
   *     becomes a track, and the drawn-at time is irrelevant (K supplies
   *     the playhead time).
   * @param {import('./types.js').Box} boxCanvas Canvas-bitmap-px box.
   * @param {number} t Draw time (displayTime at pointerup).
   */
  function commitManualBox(boxCanvas, t) {
    if (!video) return;
    const nw = video.videoWidth || 0;
    const nh = video.videoHeight || 0;
    if (!nw || !nh || !(previewScale > 0)) return; // no frame to map against
    const native = {
      x: boxCanvas.x / previewScale,
      y: boxCanvas.y / previewScale,
      w: boxCanvas.w / previewScale,
      h: boxCanvas.h / previewScale,
    };
    const st = getState();
    const selected = (Array.isArray(st.tracks) ? st.tracks : []).find(
      (tr) => tr && tr.id === st.selectedTrackId && tr.source === 'manual',
    );
    if (selected && hasHook('onKeyframe')) {
      pendingKeyframe = { trackId: selected.id, box: native };
      pendingBox = { ...boxCanvas }; // keep the drawn box visible until K/Escape
      drawPending();
      return;
    }
    if (!hasHook('onManualBox')) return;
    hooks.onManualBox(native, t);
  }

  /**
   * v1.22.0 REQ-201 keyframe keyboard (editor window-level, mirrors
   * beginManualBox's Escape path): K commits the pending drawn box as a
   * keyframe AT THE CURRENT PLAYHEAD through hooks.onKeyframe; Escape
   * discards it. Typing surfaces (span inputs, selects) never trigger it —
   * the same exclusion main.js's doc shortcuts apply (REG-2). Handled keys
   * do not propagate, so main.js's doc handler can never double-fire.
   * @param {KeyboardEvent} e
   */
  function onEditorKeyDown(e) {
    if (e.key === 'Escape' && pendingKeyframe) {
      pendingKeyframe = null;
      pendingBox = null;
      drawPending();
      return;
    }
    if ((e.key === 'k' || e.key === 'K') && pendingKeyframe) {
      const target = /** @type {Element | null} */ (/** @type {unknown} */ (e.target));
      if (
        target &&
        typeof target.closest === 'function' &&
        target.closest('input, select, textarea, [contenteditable]')
      ) {
        return; // typing surface — the keystroke means text, not a commit
      }
      e.preventDefault();
      e.stopPropagation();
      const { trackId, box } = pendingKeyframe;
      pendingKeyframe = null;
      pendingBox = null;
      drawPending();
      if (hasHook('onKeyframe')) hooks.onKeyframe(trackId, box, displayTime());
    }
  }

  /** Guarded window-keydown attach (node test env has no window). */
  function armKeyframeKeys() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('keydown', onEditorKeyDown);
  }
  function disarmKeyframeKeys() {
    if (typeof window === 'undefined' || typeof window.removeEventListener !== 'function') return;
    window.removeEventListener('keydown', onEditorKeyDown);
  }

  const disposeManual =
    canvas && video
      ? beginManualBox(canvas, commitManualBox, {
          getTime: () => displayTime(),
          onPendingChange: (box) => {
            pendingBox = box;
            drawPending();
          },
        })
      : null;

  // --- Wire + first paint ---------------------------------------------------

  armKeyframeKeys(); // v1.22.0 REQ-201: K commit / Escape discard (window-level)
  if (video && ctx) scheduleFrame();
  if (video) {
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadedmetadata', render);
    video.addEventListener('timeupdate', onTimeUpdate); // v1.8.1 playback-following fallback
  }
  if (timeline) {
    timeline.addEventListener('dblclick', onTimelineDblClick);
    // Trim gesture + pointerup tap-to-seek on the whole STRIP (REQ-110):
    // #timeline contains the chips layer, so every chips event still arrives
    // — plus the boundary pixel of a full-span chip's end edge, which
    // hit-tests to the strip itself. v1.6.2: there is NO click listener —
    // the pointerup path handles taps for mouse AND touch (WebKit never
    // fires click on plain divs for touch).
    timeline.addEventListener('pointerdown', onChipsPointerDown);
    timeline.addEventListener('pointermove', onChipsPointerMove);
    timeline.addEventListener('pointerup', onChipsPointerUp);
    timeline.addEventListener('pointercancel', onChipsPointerCancel);
    timeline.addEventListener('pointerleave', onChipsPointerLeave);
    // v1.22.0 REQ-204: ctrl/cmd+wheel zoom (non-passive — preventDefault
    // must beat the browser's page zoom; plain wheel scrolls untouched).
    timeline.addEventListener('wheel', onTimelineWheel, { passive: false });
  }
  if (zoomInBtn && typeof zoomInBtn.addEventListener === 'function') {
    zoomInBtn.addEventListener('click', onZoomInClick);
  }
  if (zoomOutBtn && typeof zoomOutBtn.addEventListener === 'function') {
    zoomOutBtn.addEventListener('click', onZoomOutClick);
  }
  if (zoomFitBtn && typeof zoomFitBtn.addEventListener === 'function') {
    zoomFitBtn.addEventListener('click', onZoomFitClick);
  }
  if (waveformCanvas && typeof waveformCanvas.addEventListener === 'function') {
    // v1.22.0 REQ-206: click/drag on the waveform seeks (thumb-like gesture).
    waveformCanvas.addEventListener('pointerdown', onWavePointerDown);
    waveformCanvas.addEventListener('pointermove', onWavePointerMove);
    waveformCanvas.addEventListener('pointerup', onWavePointerUp);
    waveformCanvas.addEventListener('pointercancel', onWavePointerCancel);
  }
  if (thumb && typeof thumb.addEventListener === 'function') {
    // v1.7.0 scrub handle: its own gesture surface. pointerdown stops
    // propagation, so the strip listeners above never see a thumb press.
    thumb.addEventListener('pointerdown', onThumbPointerDown);
    thumb.addEventListener('pointermove', onThumbPointerMove);
    thumb.addEventListener('pointerup', onThumbPointerUp);
    thumb.addEventListener('pointercancel', onThumbPointerCancel);
    // v1.9.0: a mid-drag pointerleave means pointer capture was lost — end
    // the gesture instead of leaking the drag flag (frozen thumb forever).
    thumb.addEventListener('pointerleave', onThumbPointerLeave);
    thumb.addEventListener('keydown', onThumbKeyDown);
    armBlurGuard(); // v1.9.0: window blur mid-drag ends the gesture
  }
  if (trackList) {
    trackList.addEventListener('change', onListChange);
    trackList.addEventListener('keydown', onListKeyDown);
    trackList.addEventListener('click', onListClick);
  }
  if (trimRegions) {
    // v1.15.0 REQ-125: the region layer consumes its own presses (edge drags,
    // ✕ removal, double-click removal) — the strip handlers never see them.
    trimRegions.addEventListener('pointerdown', onTrimRegionPointerDown);
    trimRegions.addEventListener('pointermove', onTrimRegionPointerMove);
    trimRegions.addEventListener('pointerup', onTrimRegionPointerUp);
    trimRegions.addEventListener('pointercancel', onTrimRegionPointerCancel);
    trimRegions.addEventListener('click', onTrimRegionClick);
    trimRegions.addEventListener('dblclick', onTrimRegionDblClick);
  }
  render(); // initial chips + track list (inert in node: doc is undefined)

  /** Immediate redraw at the current layout (fullscreen/zoom/resize seams). */
  function redraw() {
    if (closed) return;
    drawPreview();
    updatePlayhead();
  }

  function destroy() {
    closed = true;
    if (frameHandle) {
      if (usingVFC && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameHandle);
      } else {
        cancelAnimationFrame(frameHandle);
      }
      frameHandle = 0;
    }
    if (video) {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', render);
      video.removeEventListener('timeupdate', onTimeUpdate); // v1.8.1
    }
    if (timeline) {
      timeline.removeEventListener('dblclick', onTimelineDblClick);
      timeline.removeEventListener('pointerdown', onChipsPointerDown);
      timeline.removeEventListener('pointermove', onChipsPointerMove);
      timeline.removeEventListener('pointerup', onChipsPointerUp);
      timeline.removeEventListener('pointercancel', onChipsPointerCancel);
      timeline.removeEventListener('pointerleave', onChipsPointerLeave);
      timeline.removeEventListener('wheel', onTimelineWheel);
    }
    if (zoomInBtn && typeof zoomInBtn.removeEventListener === 'function') {
      zoomInBtn.removeEventListener('click', onZoomInClick);
    }
    if (zoomOutBtn && typeof zoomOutBtn.removeEventListener === 'function') {
      zoomOutBtn.removeEventListener('click', onZoomOutClick);
    }
    if (zoomFitBtn && typeof zoomFitBtn.removeEventListener === 'function') {
      zoomFitBtn.removeEventListener('click', onZoomFitClick);
    }
    if (waveformCanvas && typeof waveformCanvas.removeEventListener === 'function') {
      waveformCanvas.removeEventListener('pointerdown', onWavePointerDown);
      waveformCanvas.removeEventListener('pointermove', onWavePointerMove);
      waveformCanvas.removeEventListener('pointerup', onWavePointerUp);
      waveformCanvas.removeEventListener('pointercancel', onWavePointerCancel);
    }
    if (thumb && typeof thumb.removeEventListener === 'function') {
      thumb.removeEventListener('pointerdown', onThumbPointerDown);
      thumb.removeEventListener('pointermove', onThumbPointerMove);
      thumb.removeEventListener('pointerup', onThumbPointerUp);
      thumb.removeEventListener('pointercancel', onThumbPointerCancel);
      thumb.removeEventListener('pointerleave', onThumbPointerLeave); // v1.9.0
      thumb.removeEventListener('keydown', onThumbKeyDown);
    }
    if (trackList) {
      trackList.removeEventListener('change', onListChange);
      trackList.removeEventListener('keydown', onListKeyDown);
      trackList.removeEventListener('click', onListClick);
    }
    if (trimRegions) {
      trimRegions.removeEventListener('pointerdown', onTrimRegionPointerDown);
      trimRegions.removeEventListener('pointermove', onTrimRegionPointerMove);
      trimRegions.removeEventListener('pointerup', onTrimRegionPointerUp);
      trimRegions.removeEventListener('pointercancel', onTrimRegionPointerCancel);
      trimRegions.removeEventListener('click', onTrimRegionClick);
      trimRegions.removeEventListener('dblclick', onTrimRegionDblClick);
    }
    if (disposeManual) disposeManual();
    disarmKeyframeKeys(); // v1.22.0 REQ-201: K/Escape listener dies with the editor
    trimDrag = null;
    dropGhost(); // v1.15.0: no ghost residue past teardown
    regionDrag = null;
    downPos = null;
    hoverChip = null;
    pendingKeyframe = null; // v1.22.0 REQ-201: no armed keyframe past teardown
    rescanBusyId = null; // v1.22.0 REQ-202: no busy row past teardown
    disarmBlurGuard(); // v1.9.0: blur guard dies with the editor
    thumbDrag = null; // v1.9.0 residue rule: endThumbGesture minus the capture release
    disarmThumbNet(); // v1.8.0: a drag torn down mid-gesture leaves no net
    clearThumbPin();
    pendingBox = null;
    panDrag = null; // v1.22.0 REQ-204: no pan drag past teardown
    waveDrag = null; // v1.22.0 REQ-206: no waveform drag past teardown
    peeking = false; // v1.22.0 REQ-205: a fresh mount never starts peeking
    if (ctx && canvas && canvas.width > 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  /**
   * v1.22.0 REQ-202: flip the row Re-scan button's busy state ("…") for one
   * track — main.js sets it when its pass starts and clears it (null) when
   * the pass settles, then refreshes. No-op after destroy (a cleared editor
   * has no rows to repaint; the next mount starts idle).
   * @param {number | null} trackId Busy track id, or null to clear.
   */
  function setRescanBusy(trackId) {
    if (closed) return;
    rescanBusyId = Number.isFinite(trackId) ? trackId : null;
    render();
  }

  /**
   * v1.22.0 REQ-205: hold-to-peek — main.js wires the #peek-button hold
   * gesture and the A key here. Idempotent (a repeated `true` from keyboard
   * auto-repeat never restarts the draw); each transition redraws the
   * preview IMMEDIATELY (the frame loop may be idle while paused), so press
   * shows the RAW frame and release restores the redacted one in the same
   * tick. No-op after destroy.
   * @param {boolean} on True while the peek control is held.
   */
  function setPeek(on) {
    const next = !!on;
    if (peeking === next || closed) return;
    peeking = next;
    drawPreview();
  }

  /**
   * v1.9.0 diagnostic seam for the host's ?debug=1 diag line (main.js reads
   * it per tick): `dragging` is true while a thumb drag is live,
   * `pinRemainingMs` is the time left before the release pin self-expires
   * (0 when none) — a pinRemainingMs that never reaches 0 while the video is
   * playing is the frozen-thumb signature, now machine-readable.
   * @returns {{dragging: boolean, pinRemainingMs: number}}
   */
  function getGestureState() {
    return {
      dragging: thumbDrag != null,
      pinRemainingMs: thumbPin === null ? 0 : Math.max(0, thumbPinUntil - Date.now()),
    };
  }

  return { destroy, refresh: render, redraw, getGestureState, setRescanBusy, setPeek };
}
