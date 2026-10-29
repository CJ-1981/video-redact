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
 *        CLICK_SEEK_MAX_DRAG_PX  click-vs-drag movement threshold (REG-1)
 *        toggleTrack()         → immutable enabled-flip (REQ-014)
 *        trimTrack()           → immutable span trim (SPEC-VID-002 REQ-103)
 *        setTrackStyle()       → immutable style flip (SPEC-VID-002 REQ-101)
 *        tracksAtForView()     → thin wrapper over redact.tracksAt
 *        manualTrackFromBox()  → manual Track factory (REQ-015 + REQ-103 +
 *                                REQ-109 palette colors)
 *        parseClockInput()     → "m:ss.s" / "ss.s" text → seconds|null
 *                                (REQ-108)
 *        formatSpan()          → "0:04.2 – 0:07.8" readout (REQ-108)
 *
 *   2. Thin DOM adapters (guarded, NOT unit-tested — node has no DOM):
 *        mountEditor()    → wire playback/overlay sync + timeline events
 *        beginManualBox() → pointer-drag rectangle on the overlay canvas
 *
 * The editor NEVER owns AppState: it reads via `hooks.getState()` and emits
 * mutations via `hooks.onToggle / onSeek / onManualBox / onTrimTrack /
 * onSetStyle` (main.js's stepper state machine persists them).
 *
 * ---------------------------------------------------------------------------
 * INTERACTION MAP (review step; design-direction "signature element")
 * ---------------------------------------------------------------------------
 *
 *   Timeline (#timeline strip, single-lane chips):
 *     click            → onSeek(time under pointer)      — chip, bare rail,
 *                        timecode labels (clamped to the ends). The time maps
 *                        through the CHIPS-layer rect (the axis the chips and
 *                        playhead live in — v1.6.1 REG-1), and a press→release
 *                        pair that MOVED more than CLICK_SEEK_MAX_DRAG_PX is a
 *                        drag, not a click (no seek).
 *     dblclick on chip → hitTestTimeline → onToggle(id, !enabled)
 *                        (the two preceding clicks also seek — harmless)
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
 *                        update LIVE. The click that follows a trim is
 *                        suppressed EXACTLY ONCE (v1.6.1 REG-1: the
 *                        suppression can no longer latch — a pointercancel
 *                        resets it, and a pointerup without a follow-up click
 *                        expires it — a canceled gesture must never eat the
 *                        NEXT click). Drags from a chip body or bare rail
 *                        never trim and never seek (body is not a scrubber).
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
 *
 *   Playback sync: one loop via requestVideoFrameCallback (rAF fallback):
 *     per presented frame → draw the video frame into the overlay canvas,
 *     pixelateFrame (the shared export burn-in seam) for every enabled
 *     tracksAt hit, drawOverlay for ALL tracks (enabled solid strokes +
 *     disabled dashed "visible"), then move the playhead. Scrub → 'seeked'
 *     event redraws once; handle.redraw() re-sizes/re-draws after layout
 *     changes (fullscreen/zoom/viewport resize — wired by main.js).
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
 * Movement (CSS px, squared-distance radius) above which a strip
 * pointerdown/up pair counts as a DRAG, not a click — a drag released on the
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

/** Manual-drag rubber band (REQ-109: manual tracks themselves use the
 * categorical palette — alert red stays on the in-progress rubber band). */
const ALERT_RED = '#E5484D';
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
 * Chips keep the track's categorical `color` even when disabled; renderers
 * use `enabled === false` to apply the safe-green/dimmed state instead
 * (design-direction.md: safe green = keep visible).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} durationSec Video duration (> 0; 0/NaN → everything at 0%).
 * @param {number} currentTimeSec Playhead position (clamped to [0, duration]).
 * @returns {{chips: Array<{track: import('./types.js').Track,
 *                            startPct: number, endPct: number,
 *                            color: string, enabled: boolean}>,
 *            playheadPct: number}}
 *     Chip spans are clamped to [0, durationSec]; zero/negative duration puts
 *     every percentage at 0 (never NaN/Infinity).
 */
export function renderTimeline(tracks, durationSec, currentTimeSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  /** Clamp a seconds value into [0, dur] and express it as a percentage. */
  const pct = (sec) => {
    if (dur <= 0 || !Number.isFinite(sec)) return 0;
    const clamped = Math.min(Math.max(sec, 0), dur);
    return (clamped / dur) * 100;
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
 * Zone rule: an edge zone spans `edgePx / width * durationSec` seconds
 * inward — and outward — from each (clamped) span edge. When a chip is
 * narrower than both inward zones combined, the midpoint splits them (left
 * half 'start', right half 'end') so both handles stay reachable on tiny
 * chips.
 *
 * @param {number} x Pointer x within the strip, CSS px.
 * @param {number} y Pointer y within the strip (unused, single lane).
 * @param {number} width Strip width, CSS px (same space as `x`).
 * @param {import('./types.js').Track[]} tracks
 * @param {number} durationSec Video duration (> 0).
 * @param {number} [edgePx] Edge-zone half-width in CSS px (CHIP_EDGE_PX).
 * @returns {{track: import('./types.js').Track,
 *            zone: 'start'|'end'|'body'} | null}
 */
export function hitTestTimeline(x, y, width, tracks, durationSec, edgePx = CHIP_EDGE_PX) {
  void y;
  if (!(width > 0) || !(durationSec > 0)) return null;
  const t = (x / width) * durationSec;
  const all = Array.isArray(tracks) ? tracks : [];
  let best = null;
  let bestSpan = Infinity;
  for (const track of all) {
    const start = Math.max(0, track.start); // clamp to the rendered window
    const end = Math.min(durationSec, track.end);
    if (t < start || t > end) continue;
    const span = end - start;
    if (span < bestSpan) {
      bestSpan = span;
      best = track;
    }
  }
  if (best) {
    const start = Math.max(0, best.start);
    const end = Math.min(durationSec, best.end);
    const edgeSec = edgePx > 0 ? (edgePx / width) * durationSec : 0;
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
  const edgeSecOut = (edgePx / width) * durationSec;
  /** @type {{track: import('./types.js').Track, zone: 'start'|'end'} | null} */
  let outward = null;
  let bestDist = Infinity;
  for (const track of all) {
    const start = Math.max(0, track.start);
    const end = Math.min(durationSec, track.end);
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
 * SPARSE KEYFRAMES — verified against src/redact.js: `tracksAt` gates only on
 * `enabled` and `t ∈ [start, end]`, and `nearestBox` picks the keyframe
 * minimizing |kt − t| over whatever keyframes exist. With the single constant
 * keyframe `{0: box}` that nearest lookup returns the SAME box for every t
 * in the span — one keyframe suffices, no interpolation, and the density
 * invariant (an enabled covering track always yields a box) is never
 * violated: a manual track always has exactly one keyframe. This is the
 * documented exception to the tracker's dense-keyframe guarantee (manual
 * regions are FIXED boxes — no motion tracking, per spec exclusions).
 *
 * Without a usable duration the span degrades to [0, max(t, MIN_TRACK_SPAN_S)]
 * (cover at least up to the drawn frame); the caller can trim once duration
 * is known. Style defaults to 'solid' (REQ-101 manual default; opaque black
 * burn-in dispatched per track by the shared seam).
 *
 * @param {number} trackIdCounter Id AND label number for the new track
 *     ("Manual #<trackIdCounter>"); caller increments its counter on accept.
 * @param {number} t Presentation time, seconds (the drawn frame; only used
 *     for the no-duration fallback span — the box itself is constant).
 * @param {import('./types.js').Box} box Box in native display px.
 * @param {number} [durationSec] Video duration; the default span end.
 * @returns {import('./types.js').Track}
 */
export function manualTrackFromBox(trackIdCounter, t, box, durationSec) {
  let end;
  if (Number.isFinite(durationSec) && durationSec > 0) {
    end = durationSec;
  } else {
    const drawnAt = Number.isFinite(t) ? Math.max(t, 0) : 0;
    end = Math.max(drawnAt, MIN_TRACK_SPAN_S);
  }
  return /** @type {import('./types.js').Track} */ ({
    id: trackIdCounter,
    cls: 'manual',
    label: `Manual #${trackIdCounter}`,
    // REQ-109: same categorical slot rule as the tracker's auto tracks —
    // manual regions are no longer a shared fixed alert red.
    color: TRACK_COLORS[(trackIdCounter - 1) % TRACK_COLORS.length],
    keyframes: new Map([[0, { ...box }]]),
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
 *     `{ video, overlayCanvas, timeline, chipsContainer, playhead, trackList }`.
 *     The timeline strip is the trim-handle gesture surface (REQ-103, and
 *     REQ-110: bound to #timeline so boundary-edge grabs on full-span chips
 *     are seen); pointer geometry still maps through the chips layer.
 * @param {object} hooks Callbacks into main.js:
 *     `{ onToggle(trackId, enabled), onSeek(t), onManualBox(box, t),
 *        onTrimTrack(trackId, start, end), onSetStyle(trackId, style),
 *        getState() → { tracks, currentTime } }`.
 * @returns {{destroy: () => void, refresh: () => void,
 *            redraw: () => void}} `destroy` tears all listeners/frames down
 *     on step change; `refresh` re-renders chips + track list + playhead from
 *     getState() (main calls it on state change); `redraw` re-runs the
 *     preview draw + playhead at the CURRENT element layout — main calls it
 *     after fullscreen/zoom/viewport resizes (the per-frame loop only fires
 *     on presented frames, so a paused video needs this explicit kick to
 *     re-size the overlay canvas).
 */
export function mountEditor(els, hooks) {
  const video = (els && els.video) || null;
  const canvas = (els && els.overlayCanvas) || null;
  const timeline = (els && els.timeline) || null;
  const chipsContainer = (els && els.chipsContainer) || null;
  const playhead = (els && els.playhead) || null;
  const trackList = (els && els.trackList) || null;

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

  const doc = typeof document !== 'undefined' ? document : null;

  /** Video duration in seconds; 0 until finite metadata exists. */
  const duration = () => {
    const d = video ? video.duration : NaN;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  /** Displayed-frame time (video.currentTime), falling back to state. */
  const displayTime = () => {
    if (video && Number.isFinite(video.currentTime)) return video.currentTime;
    const st = getState();
    return Number.isFinite(st.currentTime) ? st.currentTime : 0;
  };
  const clampTime = (t) => Math.min(duration(), Math.max(0, t));

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
  /** Canvas px per native px — set by drawPreview once metadata exists. */
  let previewScale = 1;
  /**
   * Memo for tracksInCanvasPx: rebuild the scaled copy only when the state
   * array identity or the scale changes (toggle/resize), never per frame.
   * @type {{tracks: object[] | null, scale: number, scaled: object[] | null}}
   */
  let scaledMemo = { tracks: null, scale: -1, scaled: null };

  /** Memoized scaleTracksToCanvas (see the pure helper for the AC-04 math). */
  function tracksInCanvasPx(tracks, scale) {
    if (scaledMemo.tracks !== tracks || scaledMemo.scale !== scale) {
      scaledMemo = { tracks, scale, scaled: scaleTracksToCanvas(tracks, scale) };
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
      pixelateFrame(ctx, tracksCanvasPx, t, { width: bw, height: bh });
      // 2. Outline pass for ALL tracks (enabled solid + disabled dashed),
      //    on top of the burned pixels so strokes stay crisp — same scaled
      //    boxes so strokes align with the burned regions; viewScale keeps
      //    stroke/label metrics CSS-px consistent.
      drawOverlay(ctx, tracksCanvasPx, t, previewScale);
    } catch (err) {
      // Density invariant violated (tracker bug): fail CLOSED — never leave
      // an unredacted frame on screen — and re-throw (never swallow). The
      // loop then halts because tick() schedules only after a clean draw.
      ctx.clearRect(0, 0, bw, bh);
      throw err;
    }
    drawPending();
  }

  function updatePlayhead() {
    if (!playhead) return;
    const d = duration();
    const pct = d > 0 ? (clampTime(displayTime()) / d) * 100 : 0;
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

  function tick() {
    frameHandle = 0;
    drawPreview(); // may throw on invariant violation → loop halts (fail-closed)
    updatePlayhead();
    scheduleFrame();
  }

  /** Immediate redraw after a scrub (vfc may not fire while paused). */
  function onSeeked() {
    drawPreview();
    updatePlayhead();
  }

  // --- Timeline + track list DOM (chips, rows, playhead) -------------------

  function render() {
    if (closed || !doc) return;
    const state = getState();
    const d = duration();
    const vm = renderTimeline(state.tracks, d, displayTime());

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
    }

    if (playhead) playhead.style.left = `${vm.playheadPct}%`;

    if (trackList) renderTrackList(state.tracks, d);
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
  function renderTrackList(tracks, d) {
    const active = doc && doc.activeElement;
    const existing = new Map();
    for (const row of Array.from(trackList.querySelectorAll('li.track-row[data-track-id]'))) {
      existing.set(String(row.dataset.trackId), row);
    }
    const keep = new Set();
    for (const track of Array.isArray(tracks) ? tracks : []) {
      const idStr = String(track.id);
      keep.add(idStr);
      const row = existing.get(idStr) ?? buildTrackRow(track.id);
      syncTrackRow(row, track, d, active);
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
   * the REQ-108 .times group with the start/end span inputs.
   * @param {number} trackId
   * @returns {HTMLLIElement}
   */
  function buildTrackRow(trackId) {
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

    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.trackId = String(trackId);
    checkbox.title = 'Redact this track';

    row.append(swatch, label, span, times, styleSelect, checkbox);
    return row;
  }

  /**
   * Sync one track row's live values in place (see renderTrackList for the
   * reconciliation rationale). `active` is the document's focused element —
   * a focused span input keeps its in-flight value (guard) and is synced
   * from the model on the render following its commit/blur.
   * @param {HTMLLIElement} row
   * @param {import('./types.js').Track} track
   * @param {number} d Video duration (0 until metadata exists).
   * @param {Element | null} active Currently focused element, if any.
   */
  function syncTrackRow(row, track, d, active) {
    row.className = 'track-row' + (track.enabled ? '' : ' enabled-off');

    const swatch = /** @type {HTMLElement | null} */ (row.querySelector('.swatch'));
    if (swatch) swatch.style.background = track.enabled ? track.color : SAFE_GREEN;

    const label = row.querySelector('.label');
    if (label) {
      label.textContent = track.enabled ? track.label : `${track.label} (visible)`;
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
  }

  // --- Timeline events: click = seek, dblclick on chip = toggle,
  //     chip-edge drag = trim (REQ-103) --------------------------------------

  /** Live chip-edge trim drag: which track/edge is moving, and whether the
   * pointer actually moved (a no-move click must not jump-trim the edge). */
  let trimDrag = /** @type {{id: number, zone: 'start'|'end', moved: boolean} | null} */ (null);
  /** A trim drag swallowed the pointer: the follow-up click must not seek. */
  let suppressClick = false;
  /** Strip pointerdown anchor for the click-vs-drag movement check (REG-1). */
  let downPos = /** @type {{x: number, y: number} | null} */ (null);
  /** Chip element whose inline cursor we overrode for the edge affordance. */
  let hoverChip = /** @type {HTMLElement | null} */ (null);

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

  function onTimelineClick(e) {
    // v1.6.1 REG-1: the suppression is consumed by exactly one click — and it
    // can never be LEFT armed by a canceled gesture (see onChipsPointerCancel
    // and endTrimDrag), so a latched flag can no longer eat a later click.
    if (suppressClick) {
      suppressClick = false; // the pointerup of a trim drag — not a seek
      return;
    }
    // A press→release that moved is a drag, not a click: never seek (the
    // browser still fires `click` after a large same-element drag).
    if (downPos) {
      const dx = e.clientX - downPos.x;
      const dy = e.clientY - downPos.y;
      downPos = null;
      if (dx * dx + dy * dy > CLICK_SEEK_MAX_DRAG_PX * CLICK_SEEK_MAX_DRAG_PX) return;
    }
    // Seek axis = the CHIPS layer (the rect hitTestTimeline maps and the
    // playhead is positioned in). Mapping through the full strip rect put
    // every seek off the clicked point by the timecodes + padding width
    // (field-reported REG-1); points on the labels/padding clamp to the ends.
    const p = chipsPos(e) ?? timelinePos(e);
    if (!p) return;
    const d = duration();
    if (!(d > 0)) return;
    callSeek(timelineTimeAt(p.x, p.width, d));
  }

  function onTimelineDblClick(e) {
    const p = timelinePos(e);
    if (!p) return;
    const d = duration();
    if (!(d > 0)) return;
    const hit = hitTestTimeline(p.x, p.y, p.width, getState().tracks, d, edgePx);
    if (hit) callToggle(hit.track.id, !hit.track.enabled);
  }

  /**
   * Trim drag lifecycle: pointerdown inside a chip's ± edge zone starts it
   * ('body' falls through to the ordinary click-to-seek), pointermove maps
   * the pointer to a time and re-emits the span through onTrimTrack (the
   * moving edge is pre-clamped so the min-span floor holds at the drag
   * layer), pointerup ends it and suppresses the follow-up click. The
   * handlers are wired to the whole #timeline STRIP (REQ-110): a pointerdown
   * at a full-span chip's end-edge boundary pixel hit-tests to the strip —
   * box interiors exclude the right boundary coordinate, so binding to the
   * chips layer alone would never even see the event. Pointer x is still
   * mapped through the CHIPS-layer rect (the space the chips are laid out
   * in); hitTestTimeline's outward zones handle points slightly outside it.
   */
  function applyTrimDrag(clientX) {
    if (!trimDrag || !chipsContainer || !chipsContainer.getBoundingClientRect) return;
    const rect = chipsContainer.getBoundingClientRect();
    const d = duration();
    if (!(rect.width > 0) || !(d > 0)) return;
    const track = (getState().tracks || []).find((tr) => tr.id === trimDrag?.id);
    if (!track) return;
    const t = clampTime(((clientX - rect.left) / rect.width) * d);
    const start = trimDrag.zone === 'start' ? Math.min(t, track.end - MIN_TRACK_SPAN_S) : track.start;
    const end = trimDrag.zone === 'end' ? Math.max(t, track.start + MIN_TRACK_SPAN_S) : track.end;
    callTrim(trimDrag.id, start, end);
  }

  function onChipsPointerDown(e) {
    downPos = { x: e.clientX, y: e.clientY }; // click-vs-drag anchor (REG-1)
    if (e.button !== 0) return;
    const p = chipsPos(e);
    if (!p) return;
    const d = duration();
    if (!(d > 0)) return;
    const hit = hitTestTimeline(p.x, p.y, p.width, getState().tracks, d, edgePx);
    if (!hit || hit.zone === 'body') return; // plain chip click → seek path
    trimDrag = { id: hit.track.id, zone: hit.zone, moved: false };
    suppressClick = true;
    try {
      timeline.setPointerCapture(e.pointerId);
    } catch {
      /* detached strip — capture is best-effort */
    }
    e.preventDefault();
  }

  function onChipsPointerMove(e) {
    if (trimDrag) {
      trimDrag.moved = true;
      applyTrimDrag(e.clientX);
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
    // v1.6.1 REG-1: expire the suppression if the follow-up click never
    // arrives (release off-strip after a failed capture, etc.) — it must not
    // latch onto the NEXT click. When the click does exist it is dispatched
    // synchronously after pointerup, i.e. before this timer, so a real trim's
    // click is still suppressed exactly once.
    setTimeout(() => {
      suppressClick = false;
    }, 0);
  }

  function onChipsPointerUp(e) {
    endTrimDrag(e);
  }

  function onChipsPointerCancel() {
    // v1.6.1 REG-1: a canceled gesture (touch scroll taking over the strip,
    // palm rejection, …) never produces a click, so BOTH gesture flags must
    // reset here. Leaving suppressClick armed used to eat the NEXT click —
    // the field-reported "clicking the timeline no longer seeks".
    trimDrag = null;
    suppressClick = false;
    downPos = null;
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

  /** col-resize over chip edge zones, pointer over chip bodies (REQ-103). */
  function updateChipCursor(e) {
    if (!chipsContainer) return;
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
    const row =
      target && typeof target.closest === 'function'
        ? target.closest('[data-track-id]')
        : null;
    if (!row) return;
    const id = Number(row.dataset && row.dataset.trackId);
    const track = (getState().tracks || []).find((tr) => tr.id === id);
    if (track) callSeek(clampTime(track.start));
  }

  // --- Manual box: canvas-space box → native display px --------------------

  function commitManualBox(boxCanvas, t) {
    if (!hasHook('onManualBox') || !video) return;
    const nw = video.videoWidth || 0;
    const nh = video.videoHeight || 0;
    if (!nw || !nh || !(previewScale > 0)) return; // no frame to map against
    hooks.onManualBox(
      {
        x: boxCanvas.x / previewScale,
        y: boxCanvas.y / previewScale,
        w: boxCanvas.w / previewScale,
        h: boxCanvas.h / previewScale,
      },
      t,
    );
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

  if (video && ctx) scheduleFrame();
  if (video) {
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadedmetadata', render);
  }
  if (timeline) {
    timeline.addEventListener('click', onTimelineClick);
    timeline.addEventListener('dblclick', onTimelineDblClick);
    // Trim gesture on the whole STRIP (REQ-110): #timeline contains the chips
    // layer, so every chips event still arrives — plus the boundary pixel of
    // a full-span chip's end edge, which hit-tests to the strip itself.
    timeline.addEventListener('pointerdown', onChipsPointerDown);
    timeline.addEventListener('pointermove', onChipsPointerMove);
    timeline.addEventListener('pointerup', onChipsPointerUp);
    timeline.addEventListener('pointercancel', onChipsPointerCancel);
    timeline.addEventListener('pointerleave', onChipsPointerLeave);
  }
  if (trackList) {
    trackList.addEventListener('change', onListChange);
    trackList.addEventListener('keydown', onListKeyDown);
    trackList.addEventListener('click', onListClick);
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
    }
    if (timeline) {
      timeline.removeEventListener('click', onTimelineClick);
      timeline.removeEventListener('dblclick', onTimelineDblClick);
      timeline.removeEventListener('pointerdown', onChipsPointerDown);
      timeline.removeEventListener('pointermove', onChipsPointerMove);
      timeline.removeEventListener('pointerup', onChipsPointerUp);
      timeline.removeEventListener('pointercancel', onChipsPointerCancel);
      timeline.removeEventListener('pointerleave', onChipsPointerLeave);
    }
    if (trackList) {
      trackList.removeEventListener('change', onListChange);
      trackList.removeEventListener('keydown', onListKeyDown);
      trackList.removeEventListener('click', onListClick);
    }
    if (disposeManual) disposeManual();
    trimDrag = null;
    suppressClick = false;
    downPos = null;
    hoverChip = null;
    pendingBox = null;
    if (ctx && canvas && canvas.width > 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  return { destroy, refresh: render, redraw };
}
