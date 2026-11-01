/**
 * Unit tests for src/editor.js — PURE timeline model half (SPEC-VID-001,
 * design.md §4.7, REQ-012/013/014/015, AC-06/07/18; SPEC-VID-002 REQ-101/103,
 * AC-101; tasks.md T-502).
 *
 * Only the pure functions + the module's export surface are tested here —
 * the node environment has no DOM and the adapters (mountEditor,
 * beginManualBox) are guarded no-ops without one. Rendering/interaction is
 * E2E territory (Playwright, tests/e2e).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  MIN_TRACK_SPAN_S,
  MIN_VIEW_SPAN_S,
  ZOOM_WHEEL_FACTOR,
  CHIP_EDGE_PX,
  CHIP_EDGE_PX_COARSE,
  CLICK_SEEK_MAX_DRAG_PX,
  THUMB_PIN_MS,
  effectiveEdgePx,
  timelinePointerAction,
  timelineTimeAt,
  thumbLeftPct,
  thumbAriaValue,
  thumbPinSettled,
  THUMB_PIN_EPSILON_S,
  renderTimeline,
  hitTestTimeline,
  toggleTrack,
  trimTrack,
  setTrackStyle,
  tracksAtForView,
  manualTrackFromBox,
  parseClockInput,
  formatSpan,
  scaleTracksToCanvas,
  normalizeView,
  isZoomed,
  pctToTime,
  timeToPct,
  zoomWindow,
  panWindow,
  zoomStep,
  fitWindow,
  beginManualBox,
  mountEditor,
} from '../../src/editor.js';
import { TRACK_COLORS } from '../../src/tracker.js';
import { tracksAt, dilate } from '../../src/redact.js';

/** Track factory matching the design.md §2 Track typedef. */
function makeTrack(over = {}) {
  return {
    id: 1,
    cls: 'face',
    label: 'Face #1',
    color: '#2DD4BF',
    keyframes: new Map([[5, { x: 10, y: 10, w: 100, h: 100 }]]),
    start: 2,
    end: 4,
    enabled: true,
    source: 'auto',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// renderTimeline (REQ-013, AC-18)
// ---------------------------------------------------------------------------

describe('renderTimeline (chips view model + playhead)', () => {
  it('maps track spans to percentages of the duration', () => {
    const vm = renderTimeline([makeTrack({ start: 2, end: 4 })], 10, 5);
    expect(vm.chips).toHaveLength(1);
    expect(vm.chips[0].startPct).toBeCloseTo(20, 10);
    expect(vm.chips[0].endPct).toBeCloseTo(40, 10);
    expect(vm.playheadPct).toBeCloseTo(50, 10);
  });

  it('carries the track, its categorical color and enabled state per chip', () => {
    const track = makeTrack({ color: '#A78BFA', enabled: false });
    const vm = renderTimeline([track], 10, 0);
    expect(vm.chips[0].track).toBe(track);
    expect(vm.chips[0].color).toBe('#A78BFA');
    expect(vm.chips[0].enabled).toBe(false);
  });

  it('clamps a track span overflowing both ends to [0, duration]', () => {
    const vm = renderTimeline([makeTrack({ start: -2, end: 15 })], 10, 0);
    expect(vm.chips[0].startPct).toBe(0);
    expect(vm.chips[0].endPct).toBe(100);
  });

  it('clamps a track beyond the duration to a zero-width chip at 100%', () => {
    const vm = renderTimeline([makeTrack({ start: 12, end: 15 })], 10, 0);
    expect(vm.chips[0].startPct).toBe(100);
    expect(vm.chips[0].endPct).toBe(100);
  });

  it('clamps the playhead into [0%, 100%] (before start / after end)', () => {
    expect(renderTimeline([], 10, -3).playheadPct).toBe(0);
    expect(renderTimeline([], 10, 42).playheadPct).toBe(100);
  });

  it('degrades to all-zero percentages on zero/negative duration (no NaN)', () => {
    const vm = renderTimeline([makeTrack()], 0, 5);
    expect(vm.chips[0].startPct).toBe(0);
    expect(vm.chips[0].endPct).toBe(0);
    expect(vm.playheadPct).toBe(0);
    expect(renderTimeline([makeTrack()], -1, 5).playheadPct).toBe(0);
  });

  it('treats a non-finite playhead time as 0% (never NaN)', () => {
    expect(renderTimeline([], 10, NaN).playheadPct).toBe(0);
    expect(Number.isFinite(renderTimeline([], 10, Infinity).playheadPct)).toBe(true);
  });

  it('is pure: no input mutation and empty tracks → empty chips', () => {
    const tracks = [makeTrack()];
    const snapshot = JSON.stringify({ ...tracks[0], keyframes: [...tracks[0].keyframes] });
    const vm = renderTimeline(tracks, 10, 5);
    expect(vm.chips).toHaveLength(1);
    expect(JSON.stringify({ ...tracks[0], keyframes: [...tracks[0].keyframes] })).toBe(snapshot);
    expect(renderTimeline([], 10, 5).chips).toEqual([]);
    expect(renderTimeline(undefined, 10, 5).chips).toEqual([]);
  });

  it('renders a full-span manual track as a full-width chip (REQ-103)', () => {
    const track = manualTrackFromBox(1, 2, { x: 0, y: 0, w: 10, h: 10 }, 10);
    const vm = renderTimeline([track], 10, 5);
    expect(vm.chips[0].startPct).toBe(0);
    expect(vm.chips[0].endPct).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// hitTestTimeline (REQ-013, AC-18; SPEC-VID-002 REQ-103 edge zones)
// ---------------------------------------------------------------------------

describe('hitTestTimeline (chip under a point, smallest span wins)', () => {
  // Geometry used throughout: width=100 px, durationSec=10 s → the pointer x
  // is strip CSS px and maps to t = (x / width) * durationSec = x / 10, so
  // 1 px == 0.1 s and the default CHIP_EDGE_PX zone == 0.6 s.
  it('finds the track whose span contains the mapped time (body zone)', () => {
    const a = makeTrack({ id: 1, start: 2, end: 4 });
    const hit = hitTestTimeline(30, 10, 100, [a], 10); // x=30% → t=3
    expect(hit).toEqual({ track: a, zone: 'body' });
  });

  it('returns null off every chip and on empty/missing tracks', () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(10, 10, 100, [a], 10)).toBeNull(); // t=1 < start
    expect(hitTestTimeline(50, 10, 100, [a], 10)).toBeNull(); // t=5 > end
    expect(hitTestTimeline(30, 10, 100, [], 10)).toBeNull(); // t=3, no tracks
    expect(hitTestTimeline(30, 10, 100, undefined, 10)).toBeNull();
  });

  it('includes the span edges (t === start / t === end) as edge zones', () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(20, 10, 100, [a], 10)).toEqual({ track: a, zone: 'start' }); // t=2
    expect(hitTestTimeline(40, 10, 100, [a], 10)).toEqual({ track: a, zone: 'end' }); // t=4
  });

  it('maps the right edge exactly to duration (t = durationSec hittable)', () => {
    const a = makeTrack({ start: 0, end: 10 });
    expect(hitTestTimeline(100, 10, 100, [a], 10)?.track.id).toBe(1); // t=10
  });

  it('picks the SMALLEST overlapping span (precise selection on crossings)', () => {
    const long = makeTrack({ id: 1, start: 0, end: 10, label: 'Face #1' });
    const short = makeTrack({ id: 2, start: 2.5, end: 3.5, label: 'Face #2' });
    expect(hitTestTimeline(30, 10, 100, [long, short], 10)?.track.id).toBe(2); // t=3
    expect(hitTestTimeline(30, 10, 100, [short, long], 10)?.track.id).toBe(2);
    // Outside the short chip the long one is the only candidate.
    expect(hitTestTimeline(10, 10, 100, [long, short], 10)?.track.id).toBe(1); // t=1
    expect(hitTestTimeline(80, 10, 100, [long, short], 10)?.track.id).toBe(1); // t=8
  });

  it('uses spans clamped to the duration (track beyond end hit only within it)', () => {
    const a = makeTrack({ start: 8, end: 15 }); // clamps to [8, 10]
    expect(hitTestTimeline(89, 10, 100, [a], 10)?.track.id).toBe(1); // t=8.9
    expect(hitTestTimeline(5, 10, 100, [a], 10)).toBeNull(); // t=0.5 < start
  });

  it('returns null for zero width or zero duration (degenerate geometry)', () => {
    const a = makeTrack();
    expect(hitTestTimeline(30, 10, 0, [a], 10)).toBeNull();
    expect(hitTestTimeline(30, 10, 100, [a], 0)).toBeNull();
  });

  it('ignores y (single-lane timeline): every lane resolves identically', () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(30, 0, 100, [a], 10)).toEqual({ track: a, zone: 'body' }); // t=3
    expect(hitTestTimeline(30, 43, 100, [a], 10)).toEqual({ track: a, zone: 'body' });
  });
});

describe('hitTestTimeline chip edge zones (SPEC-VID-002 REQ-103)', () => {
  // width=100 px, durationSec=10 s → 1 px == 0.1 s; CHIP_EDGE_PX == 6 px
  // → each edge zone is 0.6 s deep into a chip.
  it('exposes the documented constants (≤ 6 px edges, 0.1 s min span)', () => {
    expect(CHIP_EDGE_PX).toBe(6);
    expect(MIN_TRACK_SPAN_S).toBe(0.1);
  });

  it("classifies 'start' within the edge zone and 'body' past it", () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(20, 10, 100, [a], 10)?.zone).toBe('start'); // t=2.0
    expect(hitTestTimeline(25, 10, 100, [a], 10)?.zone).toBe('start'); // t=2.5 (0.5 ≤ 0.6)
    expect(hitTestTimeline(26.5, 10, 100, [a], 10)?.zone).toBe('body'); // t=2.65 (0.65 > 0.6)
  });

  it("classifies 'end' within the edge zone and 'body' before it", () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(40, 10, 100, [a], 10)?.zone).toBe('end'); // t=4.0
    expect(hitTestTimeline(37, 10, 100, [a], 10)?.zone).toBe('end'); // t=3.7 (0.3 ≤ 0.6)
    expect(hitTestTimeline(33.5, 10, 100, [a], 10)?.zone).toBe('body'); // t=3.35 (0.65 > 0.6)
  });

  it("zones shrink with a smaller edgePx and vanish at 0 (whole chip = 'body')", () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(29, 10, 100, [a], 10, 10)?.zone).toBe('start'); // 1.0 s zone
    expect(hitTestTimeline(29, 10, 100, [a], 10)?.zone).toBe('body'); // default 0.6 s zone
    expect(hitTestTimeline(20.5, 10, 100, [a], 10, 0)?.zone).toBe('body');
    expect(hitTestTimeline(39.5, 10, 100, [a], 10, 0)?.zone).toBe('body');
  });

  it("splits overlapping zones at the chip midpoint when the span is tiny", () => {
    const tiny = makeTrack({ start: 4.97, end: 5.03 }); // 0.06 s == 0.6 px wide
    expect(hitTestTimeline(49.8, 10, 100, [tiny], 10)?.zone).toBe('start'); // t=4.98 < mid
    expect(hitTestTimeline(50.2, 10, 100, [tiny], 10)?.zone).toBe('end'); // t=5.02 ≥ mid
  });

  it("zones are computed against the CLAMPED span (track beyond duration)", () => {
    const a = makeTrack({ start: 8, end: 15 }); // clamps to [8, 10]
    expect(hitTestTimeline(80, 10, 100, [a], 10)?.zone).toBe('start'); // t=8
    expect(hitTestTimeline(89, 10, 100, [a], 10)?.zone).toBe('body'); // t=8.9
    expect(hitTestTimeline(100, 10, 100, [a], 10)?.zone).toBe('end'); // t=10
  });

  it("the crossing rule still wins before zones are computed (winner's zone)", () => {
    const long = makeTrack({ id: 1, start: 0, end: 10 });
    const short = makeTrack({ id: 2, start: 2.5, end: 3.5 });
    // t=3.2 is inside the short chip's end zone → the WINNER's zone, not the
    // long chip's body zone.
    expect(hitTestTimeline(32, 10, 100, [long, short], 10)).toEqual({
      track: short,
      zone: 'end',
    });
  });
});

// ---------------------------------------------------------------------------
// effectiveEdgePx (v1.4.0 REQ-112 — coarse-pointer trim targets)
// ---------------------------------------------------------------------------

describe('effectiveEdgePx (REQ-112 coarse-pointer edge zones)', () => {
  it('documents the constants (6 px fine pointer, 14 px coarse pointer)', () => {
    expect(CHIP_EDGE_PX).toBe(6);
    expect(CHIP_EDGE_PX_COARSE).toBe(14);
  });

  it('fine pointer (coarse=false) → CHIP_EDGE_PX; coarse (true) → 14 px', () => {
    expect(effectiveEdgePx(false)).toBe(6);
    expect(effectiveEdgePx(true)).toBe(14);
  });

  it('non-boolean input degrades to the fine-pointer zone (never NaN)', () => {
    expect(effectiveEdgePx(undefined)).toBe(6);
    expect(effectiveEdgePx(null)).toBe(6);
    expect(effectiveEdgePx(0)).toBe(6);
    expect(effectiveEdgePx('yes')).toBe(6);
  });

  it('a coarse zone passed as edgePx widens hitTestTimeline zones proportionally', () => {
    // width=100 px, durationSec=10 s → 1 px == 0.1 s; the 14 px coarse zone
    // is 1.4 s deep (vs 0.6 s fine) both inward and outward.
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(28, 10, 100, [a], 10, effectiveEdgePx(true))?.zone).toBe('start'); // t=2.8 ≤ 1.4
    expect(hitTestTimeline(28, 10, 100, [a], 10, effectiveEdgePx(false))?.zone).toBe('body'); // fine: 0.8 > 0.6
    expect(hitTestTimeline(52, 10, 100, [a], 10, effectiveEdgePx(true))?.zone).toBe('end'); // t=5.2: 1.2s past end ≤ 1.4
  });

  it('outward grabs widen with the coarse zone (fingertip reach)', () => {
    const a = makeTrack({ start: 2, end: 4 });
    // t=5.3 is 1.3 s past the end edge: inside the 1.4 s coarse zone, outside
    // the 0.6 s fine zone.
    expect(hitTestTimeline(53, 10, 100, [a], 10, effectiveEdgePx(true))).toEqual({
      track: a,
      zone: 'end',
    });
    expect(hitTestTimeline(53, 10, 100, [a], 10, effectiveEdgePx(false))).toBeNull();
  });

  it('hitTestTimeline keeps its own CHIP_EDGE_PX default (param behavior intact)', () => {
    const a = makeTrack({ start: 2, end: 4 });
    // No edgePx arg → 0.6 s zone, unchanged from v1.3.x.
    expect(hitTestTimeline(25, 10, 100, [a], 10)?.zone).toBe('start'); // t=2.5 ≤ 0.6
    expect(hitTestTimeline(28, 10, 100, [a], 10)?.zone).toBe('body'); // t=2.8 > 0.6
  });
});

// ---------------------------------------------------------------------------
// toggleTrack (REQ-014, AC-06)
// ---------------------------------------------------------------------------

describe('toggleTrack (immutable enabled flip)', () => {
  it('sets the target track enabled flag and leaves siblings untouched', () => {
    const a = makeTrack({ id: 1 });
    const b = makeTrack({ id: 2, cls: 'plate', label: 'Plate #2', color: '#A78BFA' });
    const out = toggleTrack([a, b], 2, false);
    expect(out[0]).toEqual(a);
    expect(out[1].enabled).toBe(false);
  });

  it('returns a NEW array and NEW target object — no mutation anywhere', () => {
    const a = makeTrack({ id: 1 });
    const tracks = [a];
    const out = toggleTrack(tracks, 1, false);
    expect(out).not.toBe(tracks);
    expect(out[0]).not.toBe(a);
    expect(a.enabled).toBe(true); // original untouched
    expect(tracks[0].enabled).toBe(true);
  });

  it('round-trips both directions and works for unknown ids (content unchanged)', () => {
    const tracks = [makeTrack({ id: 1 })];
    const off = toggleTrack(tracks, 1, false);
    expect(off[0].enabled).toBe(false);
    expect(toggleTrack(off, 1, true)[0].enabled).toBe(true);
    const unknown = toggleTrack(tracks, 99, false);
    expect(unknown).not.toBe(tracks);
    expect(unknown[0]).toEqual(tracks[0]);
  });

  it('integrates with tracksAt: toggled-off track leaves the redaction set (REQ-014)', () => {
    const tracks = [makeTrack({ id: 1, start: 0, end: 10 })];
    expect(tracksAt(tracks, 5)).toHaveLength(1);
    const off = toggleTrack(tracks, 1, false);
    expect(tracksAt(off, 5)).toEqual([]);
    // ...and the original array still redacts (state is caller-owned).
    expect(tracksAt(tracks, 5)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// trimTrack (SPEC-VID-002 REQ-103, AC-101)
// ---------------------------------------------------------------------------

describe('trimTrack (immutable span trim)', () => {
  it('trims the target span and leaves siblings untouched', () => {
    const a = makeTrack({ id: 1, start: 0, end: 10 });
    const b = makeTrack({ id: 2, start: 1, end: 2 });
    const out = trimTrack([a, b], 1, 3, 6);
    expect(out[0].start).toBe(3);
    expect(out[0].end).toBe(6);
    expect(out[1]).toEqual(b);
  });

  it('returns a NEW array and NEW target object — no mutation anywhere', () => {
    const a = makeTrack({ id: 1, start: 0, end: 10 });
    const tracks = [a];
    const out = trimTrack(tracks, 1, 2, 8);
    expect(out).not.toBe(tracks);
    expect(out[0]).not.toBe(a);
    expect(a.start).toBe(0); // original untouched
    expect(a.end).toBe(10);
  });

  it('orders inverted input (min, max)', () => {
    const out = trimTrack([makeTrack({ start: 0, end: 10 })], 1, 7, 3);
    expect(out[0].start).toBe(3);
    expect(out[0].end).toBe(7);
  });

  it('clamps both bounds into [0, durationSec]', () => {
    const out = trimTrack([makeTrack({ start: 0, end: 10 })], 1, -5, 20, 10);
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBe(10);
    const neg = trimTrack([makeTrack({ start: 5, end: 9 })], 1, -3, -1);
    expect(neg[0].start).toBe(0);
    expect(neg[0].end).toBe(0.1); // clamped then floored to the min span
  });

  it(`floors the span at ${MIN_TRACK_SPAN_S}s (growing the end first)`, () => {
    const out = trimTrack([makeTrack({ start: 5, end: 6 })], 1, 5, 5.05);
    expect(out[0].start).toBe(5);
    expect(out[0].end).toBeCloseTo(5 + MIN_TRACK_SPAN_S, 10);
  });

  it('keeps the floor at the duration end by pulling the start back', () => {
    const out = trimTrack([makeTrack({ start: 0, end: 10 })], 1, 9.95, 9.98, 10);
    expect(out[0].end).toBe(10);
    expect(out[0].start).toBeCloseTo(10 - MIN_TRACK_SPAN_S, 10);
  });

  it('degrades non-finite bounds (start → 0, end → start) then floors', () => {
    const out = trimTrack([makeTrack({ start: 0, end: 10 })], 1, NaN, NaN);
    expect(out[0].start).toBe(0);
    expect(out[0].end).toBeCloseTo(MIN_TRACK_SPAN_S, 10);
  });

  it('returns unchanged content (new array) for unknown ids', () => {
    const tracks = [makeTrack({ id: 1, start: 2, end: 4 })];
    const out = trimTrack(tracks, 99, 0, 1);
    expect(out).not.toBe(tracks);
    expect(out[0]).toEqual(tracks[0]);
  });

  it('integrates with tracksAt: the trimmed span IS the redacted span (AC-101)', () => {
    const tracks = [makeTrack({ id: 1, start: 0, end: 10 })];
    const trimmed = trimTrack(tracks, 1, 2, 3, 10);
    expect(tracksAt(trimmed, 1)).toEqual([]); // before the span
    expect(tracksAt(trimmed, 2.5)).toHaveLength(1); // inside the span
    expect(tracksAt(trimmed, 5)).toEqual([]); // after the span
    expect(tracksAt(tracks, 5)).toHaveLength(1); // original state intact
  });
});

// ---------------------------------------------------------------------------
// setTrackStyle (SPEC-VID-002 REQ-101, AC-103)
// ---------------------------------------------------------------------------

describe('setTrackStyle (immutable style flip)', () => {
  it('sets the target style and leaves siblings untouched', () => {
    const a = makeTrack({ id: 1, style: 'pixelate' });
    const b = makeTrack({ id: 2, style: 'pixelate' });
    const out = setTrackStyle([a, b], 1, 'solid');
    expect(out[0].style).toBe('solid');
    expect(out[1].style).toBe('pixelate');
  });

  it('returns a NEW array and NEW target object — no mutation anywhere', () => {
    const a = makeTrack({ id: 1, style: 'pixelate' });
    const tracks = [a];
    const out = setTrackStyle(tracks, 1, 'solid');
    expect(out).not.toBe(tracks);
    expect(out[0]).not.toBe(a);
    expect(a.style).toBe('pixelate'); // original untouched
  });

  it('round-trips pixelate ↔ solid', () => {
    let tracks = [makeTrack({ id: 1, style: 'pixelate' })];
    tracks = setTrackStyle(tracks, 1, 'solid');
    expect(tracks[0].style).toBe('solid');
    tracks = setTrackStyle(tracks, 1, 'pixelate');
    expect(tracks[0].style).toBe('pixelate');
  });

  it('rejects styles outside the contract (content unchanged, new array)', () => {
    const tracks = [makeTrack({ id: 1, style: 'pixelate' })];
    for (const bogus of ['blur', '', 'SOLID', null, undefined, 42]) {
      const out = setTrackStyle(tracks, 1, /** @type {any} */ (bogus));
      expect(out).not.toBe(tracks);
      expect(out[0]).toEqual(tracks[0]);
    }
  });

  it('returns unchanged content for unknown ids', () => {
    const tracks = [makeTrack({ id: 1, style: 'pixelate' })];
    const out = setTrackStyle(tracks, 99, 'solid');
    expect(out).not.toBe(tracks);
    expect(out[0]).toEqual(tracks[0]);
  });

  it('style rides along the chips view model (single source: track.style)', () => {
    let tracks = [makeTrack({ id: 1, style: 'pixelate' })];
    const before = renderTimeline(tracks, 10, 0).chips[0].track.style;
    expect(before).toBe('pixelate');
    tracks = setTrackStyle(tracks, 1, 'solid');
    expect(renderTimeline(tracks, 10, 0).chips[0].track.style).toBe('solid');
  });
});

// ---------------------------------------------------------------------------
// tracksAtForView (view seam over redact.tracksAt)
// ---------------------------------------------------------------------------

describe('tracksAtForView (thin wrapper, invariant never swallowed)', () => {
  it('delegates: identical hits to redact.tracksAt (enabled + span only)', () => {
    const on = makeTrack({ id: 1, start: 0, end: 10 });
    const off = makeTrack({ id: 2, start: 0, end: 10, enabled: false });
    const tracks = [on, off];
    expect(tracksAtForView(tracks, 5)).toEqual(tracksAt(tracks, 5));
    expect(tracksAtForView(tracks, 5).map((h) => h.track.id)).toEqual([1]);
    expect(tracksAtForView(tracks, 99)).toEqual([]);
  });

  it('propagates the density-invariant throw instead of swallowing it', () => {
    const broken = makeTrack({ keyframes: new Map(), start: 0, end: 10 });
    expect(() => tracksAtForView([broken], 5)).toThrow(/keyframes/i);
  });
});

// ---------------------------------------------------------------------------
// manualTrackFromBox (REQ-015 + SPEC-VID-002 REQ-103, AC-07/AC-101)
// ---------------------------------------------------------------------------

describe('manualTrackFromBox (manual region factory — full-span default)', () => {
  const box = { x: 40, y: 30, w: 120, h: 80 };

  it('builds an enabled, manual-source track labelled "Manual #N" in a palette color (REQ-109)', () => {
    const track = manualTrackFromBox(7, 3, box);
    expect(track.id).toBe(7);
    expect(track.cls).toBe('manual');
    expect(track.label).toBe('Manual #7');
    // REQ-109: the same categorical palette slot rule as auto tracks —
    // TRACK_COLORS[(id − 1) % 8] — no longer a shared fixed alert red.
    expect(track.color).toBe(TRACK_COLORS[(7 - 1) % TRACK_COLORS.length]);
    expect(track.color).not.toBe('#E5484D');
    expect(track.enabled).toBe(true);
    expect(track.source).toBe('manual');
  });

  it('defaults to SOLID style (REQ-101: manual regions burn opaque black)', () => {
    expect(manualTrackFromBox(1, 3, box, 10).style).toBe('solid');
  });

  it('spans the WHOLE video by default: [0, durationSec] (REQ-103)', () => {
    const track = manualTrackFromBox(1, 3, box, 10);
    expect(track.start).toBe(0);
    expect(track.end).toBe(10);
  });

  it('keys a COPY of the box AT the drawn time (v1.22.0 REQ-201; never shared)', () => {
    const track = manualTrackFromBox(1, 3, box);
    expect(track.keyframes.size).toBe(1);
    const kf = track.keyframes.get(3);
    expect(kf).toEqual(box);
    expect(kf).not.toBe(box);
    // Clamped into the span bounds: negative times → 0, past-end → duration.
    expect(manualTrackFromBox(1, -2, box, 10).keyframes.get(0)).toEqual(box);
    expect(manualTrackFromBox(1, 42, box, 10).keyframes.get(10)).toEqual(box);
  });

  it('without a usable duration it degrades to [0, max(t, min-span)]', () => {
    expect(manualTrackFromBox(1, 3, box).start).toBe(0);
    expect(manualTrackFromBox(1, 3, box).end).toBe(3); // up to the drawn frame
    expect(manualTrackFromBox(1, 0.05, box).end).toBe(MIN_TRACK_SPAN_S); // floor
    expect(manualTrackFromBox(1, NaN, box).end).toBe(MIN_TRACK_SPAN_S);
    expect(manualTrackFromBox(1, 3, box, 0).end).toBe(3); // 0 is not a duration
  });

  it('draws past the end still cover the whole video (span [0, duration])', () => {
    const track = manualTrackFromBox(1, 10.5, box, 10);
    expect(track.start).toBe(0);
    expect(track.end).toBe(10);
  });

  it('INTEGRATION: the sparse single keyframe redacts at EVERY t in the span', () => {
    // Verified contract with redact.tracksAt/nearestBox: the nearest-keyframe
    // lookup returns the constant box for any t — one keyframe suffices for a
    // full-span manual region (documented editor.js divergence from the
    // tracker's dense keyframes).
    const track = manualTrackFromBox(3, 2, box, 10);
    for (const t of [0, 0.001, 2, 5, 9.999, 10]) {
      const hits = tracksAt([track], t);
      expect(hits, `t=${t}`).toHaveLength(1);
      expect(hits[0].box).toEqual(box);
    }
    expect(tracksAt([track], -0.5)).toEqual([]); // outside the span
    expect(tracksAt([track], 10.5)).toEqual([]);
  });

  it('integrates: the created track renders as a full-width chip', () => {
    const track = manualTrackFromBox(3, 2, box, 10);
    const vm = renderTimeline([track], 10, 2.2);
    expect(vm.chips).toHaveLength(1);
    expect(vm.chips[0].startPct).toBe(0);
    expect(vm.chips[0].endPct).toBe(100);
  });

  it('composes with trimTrack: draw full-span, then trim a sub-span', () => {
    const track = manualTrackFromBox(1, 4, box, 10);
    const tracks = trimTrack([track], 1, 2, 5, 10);
    expect(tracks[0].start).toBe(2);
    expect(tracks[0].end).toBe(5);
    expect(tracksAt(tracks, 3)[0].box).toEqual(box); // same constant box
    expect(tracksAt(tracks, 7)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scaleTracksToCanvas (native-px boxes → canvas px for the shared seam)
// ---------------------------------------------------------------------------

describe('scaleTracksToCanvas (preview boxes for redact.pixelateFrame)', () => {
  const box = { x: 40, y: 30, w: 120, h: 80 };
  const track = makeTrack({ keyframes: new Map([[5, box]]) });

  it('scales every keyframe box, shares nothing with the input', () => {
    const [out] = scaleTracksToCanvas([track], 2);
    expect(out).not.toBe(track);
    expect(out.id).toBe(1); // non-geometry fields carried over
    expect(out.enabled).toBe(true);
    expect(out.keyframes.get(5)).toEqual({ x: 80, y: 60, w: 240, h: 160 });
    expect(track.keyframes.get(5)).toEqual(box); // input untouched (PURE)
  });

  it('commutes with the burn-in seam: dilate(scale(box)) == scale(dilate(box))', () => {
    // AC-04 justification: uniformly scaling tracks+frame lets the preview
    // run redact.pixelateFrame in canvas px with EXACTLY the export result.
    const s = 1.5;
    const frame = { width: 320, height: 180 };
    const preview = dilate(
      scaleTracksToCanvas([track], s)[0].keyframes.get(5),
      0.15,
      { width: frame.width * s, height: frame.height * s },
    );
    const exported = dilate(box, 0.15, frame);
    expect(preview.x).toBeCloseTo(exported.x * s, 10);
    expect(preview.y).toBeCloseTo(exported.y * s, 10);
    expect(preview.w).toBeCloseTo(exported.w * s, 10);
    expect(preview.h).toBeCloseTo(exported.h * s, 10);
  });
});

// ---------------------------------------------------------------------------
// Export surface: DOM adapters are guarded no-ops without a DOM (node)
// ---------------------------------------------------------------------------

describe('DOM adapter guards (node environment, no faked DOM)', () => {
  it('mountEditor(null, null) returns inert destroy/refresh/redraw that never throw', () => {
    const handle = mountEditor(null, null);
    expect(typeof handle.destroy).toBe('function');
    expect(typeof handle.refresh).toBe('function');
    expect(typeof handle.redraw).toBe('function');
    expect(() => handle.refresh()).not.toThrow();
    expect(() => handle.redraw()).not.toThrow();
    expect(() => handle.destroy()).not.toThrow();
  });

  it('mountEditor tolerates missing hooks and partial els', () => {
    const handle = mountEditor(
      { video: null, overlayCanvas: null, timeline: null, chipsContainer: null, playhead: null, trackList: null },
      {},
    );
    expect(() => {
      handle.refresh();
      handle.redraw();
      handle.destroy();
    }).not.toThrow();
  });

  it('beginManualBox(null, …) / no-callback detach without throwing', () => {
    expect(() => beginManualBox(null, () => {})()).not.toThrow();
    expect(() => beginManualBox({}, null)()).not.toThrow();
  });

  it('every pure export is a function (module contract surface)', () => {
    for (const fn of [
      renderTimeline, hitTestTimeline, toggleTrack, trimTrack, setTrackStyle,
      tracksAtForView, manualTrackFromBox, parseClockInput, formatSpan,
      scaleTracksToCanvas, thumbLeftPct, thumbAriaValue, thumbPinSettled,
      beginManualBox, mountEditor,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });
});

// ---------------------------------------------------------------------------
// hitTestTimeline OUTWARD edge zones (v1.3.0 REQ-110 grab reliability)
// ---------------------------------------------------------------------------

describe('hitTestTimeline outward edge zones (REQ-110)', () => {
  // Geometry: width=100 px, durationSec=10 s → 1 px == 0.1 s; the 6 px zone
  // reaches 0.6 s beyond each (clamped) span edge.
  const a = makeTrack({ id: 1, start: 2, end: 4 });

  it("matches within the zone OUTSIDE the span ('start' before, 'end' after)", () => {
    expect(hitTestTimeline(15, 10, 100, [a], 10)).toEqual({ track: a, zone: 'start' }); // t=1.5, 0.5s before
    expect(hitTestTimeline(43, 10, 100, [a], 10)).toEqual({ track: a, zone: 'end' }); // t=4.3, 0.3s past
  });

  it('returns null once the point is more than one edge zone away', () => {
    expect(hitTestTimeline(9, 10, 100, [a], 10)).toBeNull(); // t=0.9 → 1.1s before start
    expect(hitTestTimeline(47, 10, 100, [a], 10)).toBeNull(); // t=4.7 → 0.7s past end
  });

  it('keeps a full-span chip grabbable past the strip boundary (the REQ-110 case)', () => {
    // A manual track / whole-video chip ends exactly at the strip boundary —
    // a pointerdown there (or a few px beyond, on the strip padding) must
    // still resolve to the chip's 'end' zone.
    const full = makeTrack({ id: 1, start: 0, end: 10 });
    expect(hitTestTimeline(100, 10, 100, [full], 10)).toEqual({ track: full, zone: 'end' }); // t=10
    expect(hitTestTimeline(103, 10, 100, [full], 10)).toEqual({ track: full, zone: 'end' }); // t=10.3
    expect(hitTestTimeline(-3, 10, 100, [full], 10)).toEqual({ track: full, zone: 'start' }); // t=-0.3
  });

  it('nearest edge wins when two outward zones overlap; gaps stay null', () => {
    const left = makeTrack({ id: 1, start: 0, end: 4 });
    const right = makeTrack({ id: 2, start: 6, end: 10 });
    expect(hitTestTimeline(44, 10, 100, [left, right], 10)).toEqual({ track: left, zone: 'end' });
    expect(hitTestTimeline(56, 10, 100, [left, right], 10)).toEqual({ track: right, zone: 'start' });
    expect(hitTestTimeline(50, 10, 100, [left, right], 10)).toBeNull(); // 1s from both edges
  });

  it('zones vanish at edgePx=0 (no outward matching either)', () => {
    expect(hitTestTimeline(43, 10, 100, [a], 10, 0)).toBeNull();
  });

  it('the inward classification is unchanged (zone tests keep passing)', () => {
    expect(hitTestTimeline(37, 10, 100, [a], 10)?.zone).toBe('end'); // t=3.7 inside
    expect(hitTestTimeline(26.5, 10, 100, [a], 10)?.zone).toBe('body'); // t=2.65 inside
  });
});

// ---------------------------------------------------------------------------
// trimTrack → renderTimeline render pipeline (v1.3.0 REQ-110 model guard)
// ---------------------------------------------------------------------------

describe('trimTrack → renderTimeline pipeline (REQ-110 regression guard)', () => {
  it('reflects a trimmed span in the chips view model percentages', () => {
    const tracks = [makeTrack({ id: 1, start: 0, end: 10 })];
    const trimmed = trimTrack(tracks, 1, 1, 7, 10);
    const vm = renderTimeline(trimmed, 10, 0);
    expect(vm.chips[0].startPct).toBeCloseTo(10, 10);
    expect(vm.chips[0].endPct).toBeCloseTo(70, 10);
    expect(vm.chips[0].endPct - vm.chips[0].startPct).toBeCloseTo(60, 10);
  });

  it('the chip width follows the dragged edge on a pointermove sequence', () => {
    // Emulates the drag: each pointermove emits trimTrack, and the view model
    // must shrink monotonically — this is the model half of "chip length
    // updates LIVE during the drag" (the DOM half is the E2E debug-trim probe).
    let tracks = [makeTrack({ id: 1, start: 0, end: 10 })];
    const widths = [];
    for (const end of [9.4, 8.8, 8.2]) {
      tracks = trimTrack(tracks, 1, tracks[0].start, end, 10);
      const vm = renderTimeline(tracks, 10, 0);
      widths.push(vm.chips[0].endPct - vm.chips[0].startPct);
    }
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
    expect(widths[2]).toBeCloseTo(82, 10);
  });

  it('a trimmed manual track renders at the same span it will export', () => {
    const manual = manualTrackFromBox(1, 2, { x: 0, y: 0, w: 10, h: 10 }, 10);
    const trimmed = trimTrack([manual], 1, 2, 5, 10);
    const vm = renderTimeline(trimmed, 10, 0);
    expect(vm.chips[0].startPct).toBeCloseTo(20, 10);
    expect(vm.chips[0].endPct).toBeCloseTo(50, 10);
    // The redaction span (export truth) is exactly the chip span (UI truth).
    expect(tracksAt(trimmed, 3)).toHaveLength(1);
    expect(tracksAt(trimmed, 1)).toEqual([]);
    expect(tracksAt(trimmed, 6)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseClockInput / formatSpan (v1.3.0 REQ-108)
// ---------------------------------------------------------------------------

describe('parseClockInput (REQ-108 clock text → seconds)', () => {
  it.each([
    ['0:04.2', undefined, 4.2],
    ['0:07.8', undefined, 7.8],
    ['1:23', undefined, 83],
    ['2:00', undefined, 120],
    ['2:00.5', undefined, 120.5],
    ['4.2', undefined, 4.2],
    ['83', undefined, 83],
    ['0:4.2', undefined, 4.2], // single-digit seconds part
    [' 0:07.8 ', undefined, 7.8], // surrounding whitespace
    ['10.0', 10, 10], // exactly at the duration is valid
    ['0:09.9', 10, 9.9],
  ])('parses %s → %n seconds', (str, durationSec, expected) => {
    expect(parseClockInput(str, durationSec)).toBeCloseTo(expected, 10);
  });

  it.each([
    ['abc'],
    [''],
    ['   '],
    ['1:60'], // seconds part must stay below 60 (that is "2:00")
    ['-1'],
    ['1:2:3'],
    ['0x10'],
    ['1e3'],
  ])('rejects %s (null)', (str) => {
    expect(parseClockInput(str, undefined)).toBeNull();
  });

  it('rejects values beyond the duration when one is given', () => {
    expect(parseClockInput('0:12', 10)).toBeNull();
    expect(parseClockInput('12', 10)).toBeNull();
    expect(parseClockInput('10.1', 10)).toBeNull();
    // Without a duration the raw value passes (the caller/model clamps).
    expect(parseClockInput('0:12', undefined)).toBe(12);
    expect(parseClockInput('0:12', 0)).toBe(12); // 0 is "no duration known"
    expect(parseClockInput('0:12', NaN)).toBe(12);
  });

  it('rejects non-string input and negative durations', () => {
    expect(parseClockInput(undefined, 10)).toBeNull();
    expect(parseClockInput(null, 10)).toBeNull();
    expect(parseClockInput(42, 10)).toBeNull();
    expect(parseClockInput(':-1', 10)).toBeNull();
  });
});

describe('formatSpan (REQ-108 span readout)', () => {
  it('formats "0:04.2 – 0:07.8" (en dash with spaces)', () => {
    expect(formatSpan(4.2, 7.8)).toBe('0:04.2 – 0:07.8');
  });

  it('uses the formatClock convention: zero pad under 10s, rollover at :60', () => {
    expect(formatSpan(0, 83)).toBe('0:00.0 – 1:23.0');
    expect(formatSpan(59.97, 60.03)).toBe('1:00.0 – 1:00.0'); // never ":60.0"
    expect(formatSpan(0, 0)).toBe('0:00.0 – 0:00.0');
  });

  it('degrades non-finite bounds to 0:00.0 (never NaN text)', () => {
    expect(formatSpan(NaN, 5)).toBe('0:00.0 – 0:05.0');
    expect(formatSpan(1, Infinity)).toBe('0:01.0 – 0:00.0');
  });

  it('matches main.js formatClock digit-for-digit (shared convention)', () => {
    // Guards the "reuse formatClock conventions" contract without an
    // editor→main import cycle: both must render the same seconds value
    // identically.
    for (const s of [0, 4.16, 9.96, 59.95, 60, 83.34, 754.9]) {
      const m = Math.floor(s / 60);
      const r = Math.round((s - m * 60) * 10) / 10;
      const expected = r >= 60 ? `${m + 1}:00.0` : `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
      expect(formatSpan(s, s)).toBe(`${expected} – ${expected}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Manual palette colors (v1.3.0 REQ-109)
// ---------------------------------------------------------------------------

describe('manualTrackFromBox palette colors (REQ-109)', () => {
  const box = { x: 40, y: 30, w: 120, h: 80 };

  it('assigns TRACK_COLORS[(id − 1) % 8] — the exact auto-track rule', () => {
    for (const id of [1, 2, 3, 5, 8, 9, 15]) {
      const track = manualTrackFromBox(id, 1, box, 10);
      expect(track.color).toBe(TRACK_COLORS[(id - 1) % TRACK_COLORS.length]);
      expect(track.color).not.toBe('#E5484D'); // the old shared alert red
    }
  });

  it('two manual tracks get DISTINCT colors (no color collision)', () => {
    const first = manualTrackFromBox(1, 1, box, 10);
    const second = manualTrackFromBox(2, 1, box, 10);
    const third = manualTrackFromBox(3, 1, box, 10);
    expect(second.color).not.toBe(first.color);
    expect(third.color).not.toBe(first.color);
    expect(third.color).not.toBe(second.color);
  });

  it('manual/auto never collide within a session (same global id space)', () => {
    // main.js owns ONE id counter across analyze runs, so a manual track's
    // palette slot is derived from the same counter as auto ids — slot i is
    // used by exactly one track (id i+1) regardless of source.
    const auto = makeTrack({ id: 2, color: TRACK_COLORS[(2 - 1) % TRACK_COLORS.length] });
    const manual = manualTrackFromBox(2, 1, box, 10);
    expect(manual.color).toBe(auto.color); // same id → same slot (consistent)
    const otherManual = manualTrackFromBox(3, 1, box, 10);
    expect(otherManual.color).not.toBe(manual.color); // different id → different slot
  });

  it('keeps manual identity beyond color: label, source, solid style, full span', () => {
    const track = manualTrackFromBox(4, 1, box, 10);
    expect(track.label).toBe('Manual #4');
    expect(track.source).toBe('manual');
    expect(track.cls).toBe('manual');
    expect(track.style).toBe('solid');
    expect(track.start).toBe(0);
    expect(track.end).toBe(10);
  });

  it('a manual track renders as a chip in its palette color', () => {
    const track = manualTrackFromBox(1, 1, box, 10);
    const vm = renderTimeline([track], 10, 0);
    expect(vm.chips[0].color).toBe(TRACK_COLORS[0]);
  });
});

describe('timelineTimeAt — pointer x → seek time (v1.6.1 REG-1)', () => {

  it('maps the axis-rect fraction linearly onto the duration', () => {
    expect(timelineTimeAt(100, 400, 10)).toBeCloseTo(2.5, 10);
    expect(timelineTimeAt(0, 400, 10)).toBe(0);
    expect(timelineTimeAt(400, 400, 10)).toBe(10);
    expect(timelineTimeAt(201, 402, 3.04)).toBeCloseTo(1.52, 10);
  });

  it('clamps points outside the axis (timecode labels / strip padding) to the ends', () => {
    expect(timelineTimeAt(-80, 402, 3.04)).toBe(0);
    expect(timelineTimeAt(500, 402, 3.04)).toBe(3.04);
  });

  it('degrades safely: zero width, zero/NaN duration, NaN x → 0 (never NaN)', () => {
    expect(timelineTimeAt(100, 0, 10)).toBe(0);
    expect(timelineTimeAt(100, 400, 0)).toBe(0);
    expect(timelineTimeAt(100, 400, Number.NaN)).toBe(0);
    expect(timelineTimeAt(Number.NaN, 400, 10)).toBe(0);
  });

  it('click-vs-drag movement threshold sits between the fine and coarse edge zones', () => {
    // An edge-grab wiggle (≤ 6 px fine zone) must never read as a seek drag,
    // and the threshold must stay below the coarse grab zone (14 px).
    expect(CLICK_SEEK_MAX_DRAG_PX).toBeGreaterThanOrEqual(CHIP_EDGE_PX);
    expect(CLICK_SEEK_MAX_DRAG_PX).toBeLessThan(CHIP_EDGE_PX_COARSE);
  });
});

describe('timelinePointerAction — pointerup gesture decision (v1.6.2)', () => {
  // The v1.6.2 seek path fires on pointerup (WebKit never fires `click` on
  // plain divs for touch, so the old click listener never saw a finger tap).
  // This helper IS the decision: a press that started in a chip-edge zone is
  // a trim of that side; otherwise a release within CLICK_SEEK_MAX_DRAG_PX of
  // the press is a tap → 'seek'; anything else is 'none'.
  const M = CLICK_SEEK_MAX_DRAG_PX;

  it('small-movement pointerup on the strip → seek (mouse tap and finger tap alike)', () => {
    expect(timelinePointerAction(100, 100, false, false, M)).toBe('seek'); // dead-still tap
    expect(timelinePointerAction(100, 100 + M, false, false, M)).toBe('seek'); // drift exactly at threshold
    expect(timelinePointerAction(103, 100, false, false, M)).toBe('seek'); // leftward slip
  });

  it('movement beyond the threshold → none (a drag released on the strip never seeks, REG-1)', () => {
    expect(timelinePointerAction(100, 100 + M + 0.5, false, false, M)).toBe('none');
    expect(timelinePointerAction(100, 200, false, false, M)).toBe('none');
    expect(timelinePointerAction(200, 100, false, false, M)).toBe('none');
  });

  it("press on a chip-edge zone → that side's trim, NEVER a seek (edge tap included)", () => {
    expect(timelinePointerAction(40, 40, false, true, M)).toBe('trim-end'); // edge tap, no movement
    expect(timelinePointerAction(20, 20, true, false, M)).toBe('trim-start');
    expect(timelinePointerAction(40, 80, false, true, M)).toBe('trim-end'); // even a large drag
    expect(timelinePointerAction(20, 21, true, false, M)).not.toBe('seek');
  });

  it('edge latch wins over the movement rule in both directions', () => {
    // A wiggle near an edge stays a trim decision even when it would pass the
    // movement test, and a far-from-edge release stays a seek decision even
    // when edges exist elsewhere on the strip.
    expect(timelinePointerAction(20, 100, true, false, M)).toBe('trim-start');
    expect(timelinePointerAction(100, 101, false, false, M)).toBe('seek');
  });

  it('degrades non-finite coordinates/thresholds without NaN (garbage never seeks blindly)', () => {
    // NaN coordinates degrade to 0 (same convention as timelineTimeAt).
    expect(timelinePointerAction(Number.NaN, 5, false, false, M)).toBe('seek');
    expect(timelinePointerAction(0, Number.NaN, false, false, M)).toBe('seek');
    // A missing/bogus threshold refuses to seek (safe side).
    expect(timelinePointerAction(0, 5, false, false, Number.NaN)).toBe('none');
    expect(timelinePointerAction(0, 5, false, false, -1)).toBe('none');
    // Missing edge flags behave as "not an edge".
    expect(timelinePointerAction(100, 100, undefined, undefined, M)).toBe('seek');
  });
});

// ---------------------------------------------------------------------------
// Scrub thumb (v1.7.0): thumbLeftPct / thumbAriaValue + the drag→time mapping
// ---------------------------------------------------------------------------

describe('thumbLeftPct (v1.7.0 scrub-handle position)', () => {
  it('maps a playback time to its percentage of the duration', () => {
    expect(thumbLeftPct(2.5, 10)).toBeCloseTo(25, 10);
    expect(thumbLeftPct(5, 10)).toBeCloseTo(50, 10);
    expect(thumbLeftPct(0, 10)).toBe(0);
  });

  it('clamps into [0%, 100%]: negative → 0, exact end and beyond → 100', () => {
    expect(thumbLeftPct(-0.5, 10)).toBe(0);
    expect(thumbLeftPct(10, 10)).toBe(100);
    expect(thumbLeftPct(42, 10)).toBe(100);
  });

  it('degrades to 0 on zero/negative/NaN duration and non-finite time (never NaN)', () => {
    expect(thumbLeftPct(5, 0)).toBe(0);
    expect(thumbLeftPct(5, -1)).toBe(0);
    expect(thumbLeftPct(5, Number.NaN)).toBe(0);
    expect(thumbLeftPct(Number.NaN, 10)).toBe(0);
    expect(thumbLeftPct(Number.POSITIVE_INFINITY, 10)).toBe(0);
    expect(Number.isFinite(thumbLeftPct(5, 10))).toBe(true);
  });

  it('shares ONE mapping with the playhead: thumbLeftPct === renderTimeline().playheadPct', () => {
    // The thumb rides the playhead position — the two must never diverge.
    for (const [t, d] of [[2.5, 10], [0, 10], [10, 10], [42, 10], [5, 0], [Number.NaN, 10]]) {
      expect(thumbLeftPct(t, d)).toBe(renderTimeline([], d, t).playheadPct);
    }
  });
});

describe('thumbAriaValue (v1.7.0 scrub-handle aria-valuenow)', () => {
  it('passes finite non-negative seconds through unchanged', () => {
    expect(thumbAriaValue(0)).toBe(0);
    expect(thumbAriaValue(4.2)).toBeCloseTo(4.2, 10);
    expect(thumbAriaValue(83.25)).toBeCloseTo(83.25, 10);
  });

  it('degrades non-finite and negative input to 0 (ARIA values never NaN)', () => {
    expect(thumbAriaValue(Number.NaN)).toBe(0);
    expect(thumbAriaValue(Number.POSITIVE_INFINITY)).toBe(0);
    expect(thumbAriaValue(-1)).toBe(0);
    expect(thumbAriaValue(undefined)).toBe(0);
  });
});

describe('scrub-thumb drag → time mapping (v1.7.0; existing timelineTimeAt seam)', () => {
  it('a drag from the 25% position to the 50% position seeks dur/4 → dur/2', () => {
    // The DOM drag maps every pointermove through timelineTimeAt on the
    // CHIPS-layer rect — no new mapping exists to unit-test, so assert the
    // gesture's endpoints through THE existing mapping (grab at 25%, release
    // at 50% of the axis width).
    const w = 402;
    const dur = 3.04;
    const grabT = timelineTimeAt(0.25 * w, w, dur);
    const releaseT = timelineTimeAt(0.5 * w, w, dur);
    expect(grabT).toBeCloseTo(dur / 4, 10);
    expect(releaseT).toBeCloseTo(dur / 2, 10);
    // ...and the release endpoint equals thumbLeftPct at that time (thumb
    // parks where the seek landed).
    expect(thumbLeftPct(releaseT, dur)).toBeCloseTo(50, 10);
  });

  it('clamped drag endpoints land exactly on the ends (thumb dragged past both edges)', () => {
    const w = 400;
    const dur = 8;
    expect(timelineTimeAt(-40, w, dur)).toBe(0); // dragged left of the axis
    expect(timelineTimeAt(w + 40, w, dur)).toBe(dur); // dragged right of the axis
    expect(thumbLeftPct(timelineTimeAt(w + 40, w, dur), dur)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Release pin (v1.8.0): the pointerup endpoint seek lands asynchronously; the
// pin keeps stale frames from yanking the thumb back off the release point.
// ---------------------------------------------------------------------------

describe('thumbPinSettled (v1.8.0 scrub-handle release-pin guard)', () => {
  it('settles when the displayed time has reached the pinned release point', () => {
    expect(thumbPinSettled(1.5, 1.5)).toBe(true); // exact landing
    expect(thumbPinSettled(1.5, 1.53)).toBe(true); // within the epsilon
    expect(thumbPinSettled(1.5, 1.549)).toBe(true);
  });

  it('stays armed while the displayed time is still the stale pre-seek position', () => {
    // The defect this guards: after release at 1.5s, currentTime still reads
    // the pre-drag 0.76s until `seeked` — the pin must hold the thumb there.
    expect(thumbPinSettled(1.5, 0.76)).toBe(false);
    expect(thumbPinSettled(1.5, 1.4)).toBe(false); // near but not landed
  });

  it('epsilon covers float drift around the pinned time in both directions', () => {
    const eps = THUMB_PIN_EPSILON_S;
    expect(thumbPinSettled(2, 2 + eps)).toBe(true);
    expect(thumbPinSettled(2, 2 - eps)).toBe(true);
    // Clearly beyond the epsilon (margins far outside float dust): still armed.
    expect(thumbPinSettled(2, 2 + eps * 1.5)).toBe(false);
    expect(thumbPinSettled(2, 2 - eps * 1.5)).toBe(false);
    // Half the epsilon: comfortably settled.
    expect(thumbPinSettled(2, 2 + eps * 0.5)).toBe(true);
  });

  it('non-finite input settles (nothing meaningful to guard; the pin never wedges)', () => {
    expect(thumbPinSettled(Number.NaN, 1.5)).toBe(true);
    expect(thumbPinSettled(1.5, Number.NaN)).toBe(true);
    expect(thumbPinSettled(Number.POSITIVE_INFINITY, 1.5)).toBe(true);
    expect(thumbPinSettled(1.5, Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe('mountEditor wires the scrub thumb (v1.7.0; guarded node fakes)', () => {
  /** Minimal DOM-element fake: listener map + style + attributes. */
  function makeFakeEl() {
    const listeners = new Map();
    return {
      style: {},
      attrs: {},
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type, fn) {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      __listeners: listeners,
    };
  }

  it('attaches the thumb gesture/keyboard listeners and positions it on redraw', () => {
    const timeline = makeFakeEl();
    const thumb = makeFakeEl();
    timeline.querySelector = () => thumb;
    const handle = mountEditor({ video: null, overlayCanvas: null, timeline, chipsContainer: null, playhead: null, trackList: null }, {});
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown']) {
      expect(typeof thumb.__listeners.get(type), `listener ${type}`).toBe('function');
    }
    // redraw() → updateThumb: parked at the degenerate 0% with honest ARIA.
    handle.redraw();
    expect(thumb.style.left).toBe('0%');
    expect(thumb.attrs['aria-valuemax']).toBe('0');
    expect(thumb.attrs['aria-valuenow']).toBe('0');
    handle.destroy();
    expect(thumb.__listeners.size).toBe(0); // every thumb listener detached
  });

  it('destroy() with a live thumb drag resets the drag state (no residue)', () => {
    const timeline = makeFakeEl();
    const thumb = makeFakeEl();
    timeline.querySelector = () => thumb;
    const handle = mountEditor({ video: null, overlayCanvas: null, timeline, chipsContainer: null, playhead: null, trackList: null }, {});
    const down = thumb.__listeners.get('pointerdown');
    const up = thumb.__listeners.get('pointerup');
    const stopPropagation = () => {};
    const preventDefault = () => {};
    // A press → release cycle through the real handlers (capture calls are
    // guarded try/catch on the fake; the up handler must clear the drag).
    down({ button: 0, pointerId: 7, stopPropagation, preventDefault, clientX: 0 });
    expect(() => up({ pointerId: 7, clientX: 0 })).not.toThrow();
    // A foreign pointerId must be ignored by both handlers.
    expect(() => down({ button: 0, pointerId: 99, stopPropagation, preventDefault, clientX: 0 })).not.toThrow();
    expect(() => up({ pointerId: 1234, clientX: 0 })).not.toThrow();
    expect(() => handle.destroy()).not.toThrow();
    expect(thumb.__listeners.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Playback following (v1.8.1 regression): the thumb froze at 0% during
// playback. Root cause: position updates rode EXCLUSIVELY on the rVFC/rAF
// frame loop — rVFC fires only when the compositor presents frames, and on
// browsers/GPU/window states that never present during playback the loop
// registered but never fired, so tick() → updatePlayhead() → updateThumb()
// never ran. The transport readout stayed live because main.js drives it from
// `timeupdate`; seeks/drags worked because `seeked` and the pointer handlers
// are event/DOM-driven. Fix: `timeupdate` now drives updatePlayhead too.
// ---------------------------------------------------------------------------

describe('mountEditor playback following (v1.8.1 thumb-froze regression)', () => {
  /** Minimal DOM-element fake (same shape as the harness above). */
  function makeFakeEl() {
    const listeners = new Map();
    return {
      style: {},
      attrs: {},
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type, fn) {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      __listeners: listeners,
    };
  }

  /**
   * Fake <video> whose requestVideoFrameCallback REGISTERS but never
   * auto-fires — the exact field condition: the loop is armed, the
   * compositor presents nothing, so no frame callback ever runs. Playback is
   * simulated by mutating currentTime and dispatching media events.
   */
  function makeFakeVideo({ duration = 11.1, currentTime = 0 } = {}) {
    const listeners = new Map();
    const vfc = { next: 0, pending: new Map() };
    return {
      currentTime,
      duration,
      addEventListener(type, fn) {
        listeners.set(type, fn);
      },
      removeEventListener(type, fn) {
        if (listeners.get(type) === fn) listeners.delete(type);
      },
      requestVideoFrameCallback(cb) {
        vfc.next += 1;
        vfc.pending.set(vfc.next, cb);
        return vfc.next;
      },
      cancelVideoFrameCallback(h) {
        vfc.pending.delete(h);
      },
      dispatch(type) {
        listeners.get(type)?.();
      },
      fireFrame() {
        for (const cb of [...vfc.pending.values()]) cb();
      },
      __listeners: listeners,
      __vfc: vfc,
    };
  }

  /** Mount with a truthy 2d ctx so scheduleFrame arms rVFC (never fires). */
  function mountStarved(video) {
    const timeline = makeFakeEl();
    const thumb = makeFakeEl();
    timeline.querySelector = () => thumb;
    const canvas = { getContext: () => ({}) };
    const handle = mountEditor(
      { video, overlayCanvas: canvas, timeline, chipsContainer: null, playhead: null, trackList: null },
      {},
    );
    return { handle, thumb };
  }

  it('REGRESSION: thumb follows playback 0% → 50% → 100% via timeupdate when the frame loop never fires', () => {
    const video = makeFakeVideo({ duration: 11.1, currentTime: 0 });
    const { handle, thumb } = mountStarved(video);
    // The field condition: loop armed, zero frames ever presented.
    expect(video.__vfc.pending.size).toBe(1);
    handle.redraw(); // initial paint — the field screenshot state (parked left)
    expect(thumb.style.left).toBe('0%');

    // Playback with rVFC starved: only `timeupdate` fires (the transport's
    // source — the thing that worked per the field report).
    video.currentTime = 5.55;
    video.dispatch('timeupdate');
    expect(parseFloat(thumb.style.left)).toBeCloseTo(50, 5);
    expect(thumb.attrs['aria-valuenow']).toBe('5.55');
    expect(thumb.attrs['aria-valuemax']).toBe('11.1');

    video.currentTime = 11.1;
    video.dispatch('timeupdate');
    expect(parseFloat(thumb.style.left)).toBeCloseTo(100, 5);

    handle.destroy();
    expect(video.__listeners.size).toBe(0); // timeupdate detached with the rest
  });

  it('primary loop intact: a delivered rVFC frame still moves the thumb', () => {
    const video = makeFakeVideo({ duration: 11.1, currentTime: 2.775 });
    const { handle, thumb } = mountStarved(video);
    video.fireFrame(); // one presented frame → tick() → updatePlayhead
    expect(parseFloat(thumb.style.left)).toBeCloseTo(25, 5);
    handle.destroy();
  });

  it('duration falls back to getState().duration only when video.duration is unusable', () => {
    const video = makeFakeVideo({ duration: Number.NaN, currentTime: 5.55 });
    const timeline = makeFakeEl();
    const thumb = makeFakeEl();
    timeline.querySelector = () => thumb;
    const handle = mountEditor(
      { video, overlayCanvas: null, timeline, chipsContainer: null, playhead: null, trackList: null },
      { getState: () => ({ tracks: [], currentTime: video.currentTime, duration: 11.1 }) },
    );
    handle.redraw();
    // NaN video.duration → meta 11.1 → 5.55/11.1 = 50% (pre-v1.8.1: 0%).
    video.dispatch('timeupdate');
    expect(parseFloat(thumb.style.left)).toBeCloseTo(50, 5);
    // And without any usable duration it degrades to 0% (never NaN).
    const bare = makeFakeVideo({ duration: Number.NaN, currentTime: 5.55 });
    const { handle: h2, thumb: t2 } = mountStarved(bare);
    h2.redraw();
    bare.dispatch('timeupdate');
    expect(t2.style.left).toBe('0%');
    handle.destroy();
    h2.destroy();
  });
});

// ---------------------------------------------------------------------------
// v1.9.0 — gesture diagnostics + hardening: getGestureState, the TIME-BOXED
// release pin (deadline OR settled, whichever first), the drag-flag residue
// guarantee (pointerleave / window blur / destroy), and per-tick exception
// isolation. Harness: the same guarded node fakes as the v1.8.1 block above.
// ---------------------------------------------------------------------------

/** Minimal DOM-element fake (listener map + style + attributes). */
function makeGestureEl() {
  const listeners = new Map();
  return {
    style: {},
    attrs: {},
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    setAttribute(k, v) {
      this.attrs[k] = v;
    },
    releasePointerCapture() {},
    setPointerCapture() {},
    __listeners: listeners,
  };
}

/** Fake <video> whose rVFC registers but never auto-fires (starved loop). */
function makeGestureVideo({ duration = 10, currentTime = 0 } = {}) {
  const listeners = new Map();
  const vfc = { next: 0, pending: new Map() };
  return {
    currentTime,
    duration,
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type, fn) {
      if (listeners.get(type) === fn) listeners.delete(type);
    },
    requestVideoFrameCallback(cb) {
      vfc.next += 1;
      vfc.pending.set(vfc.next, cb);
      return vfc.next;
    },
    cancelVideoFrameCallback(h) {
      vfc.pending.delete(h);
    },
    dispatch(type) {
      listeners.get(type)?.();
    },
    fireFrame() {
      // Real rVFC semantics: a delivered callback is consumed after firing.
      const pending = [...vfc.pending.values()];
      vfc.pending.clear();
      for (const cb of pending) cb();
    },
    __listeners: listeners,
    __vfc: vfc,
  };
}

/**
 * Mount with a thumb + a chips layer whose rect is 100 px wide — so a
 * pointerup at clientX=50 maps to exactly half the duration (the endpoint
 * seek that ARMS the release pin). No canvas → position-only updates.
 */
function mountGesture(video, { hooks } = {}) {
  const timeline = makeGestureEl();
  const thumb = makeGestureEl();
  timeline.querySelector = () => thumb;
  const chips = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 10 }),
  };
  const playhead = makeGestureEl();
  const handle = mountEditor(
    { video, overlayCanvas: null, timeline, chipsContainer: chips, playhead, trackList: null },
    hooks ?? {},
  );
  const down = (pointerId = 1) =>
    thumb.__listeners
      .get('pointerdown')
      ({ button: 0, pointerId, stopPropagation() {}, preventDefault() {} });
  const up = (clientX, pointerId = 1) =>
    thumb.__listeners.get('pointerup')({ pointerId, clientX });
  return { handle, thumb, timeline, chips, playhead, down, up };
}

describe('THUMB_PIN_MS + getGestureState (v1.9.0 gesture diagnostics)', () => {
  it('the pin deadline constant is exported and sub-half-second', () => {
    expect(THUMB_PIN_MS).toBe(350);
    expect(THUMB_PIN_MS).toBeLessThan(500); // never a user-noticeable freeze
  });

  it('getGestureState: idle → {dragging: false, pinRemainingMs: 0}', () => {
    const { handle } = mountGesture(makeGestureVideo());
    expect(handle.getGestureState()).toEqual({ dragging: false, pinRemainingMs: 0 });
    handle.destroy();
  });

  it('getGestureState: dragging during a fake drag; pinRemainingMs counts down to 0', () => {
    const nowMock = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const { handle, down, up } = mountGesture(makeGestureVideo());
      down();
      expect(handle.getGestureState().dragging).toBe(true);
      up(50); // endpoint seek at 5s → pin armed at now=1000, deadline 1350
      expect(handle.getGestureState().dragging).toBe(false);
      expect(handle.getGestureState().pinRemainingMs).toBe(THUMB_PIN_MS);
      nowMock.mockReturnValue(1_100);
      expect(handle.getGestureState().pinRemainingMs).toBe(THUMB_PIN_MS - 100);
      nowMock.mockReturnValue(1_349);
      expect(handle.getGestureState().pinRemainingMs).toBe(1);
      nowMock.mockReturnValue(1_350);
      expect(handle.getGestureState().pinRemainingMs).toBe(0); // expired
      handle.destroy();
    } finally {
      nowMock.mockRestore();
    }
  });
});

describe('time-boxed release pin expiry (v1.9.0 THE regression pin)', () => {
  it('REGRESSION: suppression self-expires after THUMB_PIN_MS even when the seek NEVER lands', () => {
    // The v1.8.0 field-failure shape, made deterministic: the endpoint seek
    // fires but never completes (no hooks → no seek → `seeked` never fires),
    // the displayed time stays stale at 0s, so thumbPinSettled(5, 0) is
    // false FOREVER. The old condition-based pin held the thumb at 50%
    // forever; the time-boxed pin must give the position back at 350 ms.
    let now = 2_000;
    const nowMock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const video = makeGestureVideo({ duration: 10, currentTime: 0 });
      const { handle, thumb, down, up } = mountGesture(video);
      handle.redraw();
      expect(thumb.style.left).toBe('0%');

      down();
      up(50); // release point 5s → thumb parks at 50%, pin armed
      expect(thumb.style.left).toBe('50%');

      // Before the deadline: every timeupdate still steps aside (the seek is
      // "in flight" — the stale 0s position must not yank the thumb back).
      video.dispatch('timeupdate');
      expect(thumb.style.left).toBe('50%');
      now = 2_000 + THUMB_PIN_MS - 1;
      video.dispatch('timeupdate');
      expect(thumb.style.left).toBe('50%');

      // The deadline passes — suppression ends UNCONDITIONALLY (settled never
      // passed, `seeked` never fired): the thumb follows the live time again.
      now = 2_000 + THUMB_PIN_MS;
      video.dispatch('timeupdate');
      expect(thumb.style.left).toBe('0%'); // currentTime 0 of 10 → 0%
      // And the state agrees: the pin is gone.
      expect(handle.getGestureState().pinRemainingMs).toBe(0);
      handle.destroy();
    } finally {
      nowMock.mockRestore();
    }
  });

  it('the pin still clears EARLY when the seek lands (deadline OR settled, whichever first)', () => {
    let now = 3_000;
    const nowMock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const video = makeGestureVideo({ duration: 10, currentTime: 0 });
      const { handle, thumb, down, up } = mountGesture(video);
      down();
      up(50); // pin at 5s, deadline 3350
      now = 3_100;
      video.dispatch('timeupdate'); // stale 0s → still pinned at 50%
      expect(thumb.style.left).toBe('50%');
      // The seek lands (currentTime within THUMB_PIN_EPSILON_S of the pin).
      video.currentTime = 5.02;
      video.dispatch('timeupdate');
      // Settled → pin cleared early; the thumb re-derives from the LIVE time.
      expect(parseFloat(thumb.style.left)).toBeCloseTo(50.2, 5);
      // NOW playback moves on and the thumb follows immediately (no deadline
      // wait: the settled path retired the pin early).
      video.currentTime = 6;
      video.dispatch('timeupdate');
      expect(thumb.style.left).toBe('60%');
      handle.destroy();
    } finally {
      nowMock.mockRestore();
    }
  });

  it('a new gesture re-arms cleanly: pin cleared on pointerdown, deadline reset on the next release', () => {
    let now = 5_000;
    const nowMock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { handle, down, up } = mountGesture(makeGestureVideo());
      down();
      up(50); // pin armed at 5000 → 5350
      expect(handle.getGestureState().pinRemainingMs).toBe(THUMB_PIN_MS);
      now = 5_200; // 150 ms into the old pin
      down(); // a fresh gesture owns the position again
      expect(handle.getGestureState().pinRemainingMs).toBe(0);
      now = 5_250;
      up(25); // new release at 2.5s → NEW deadline from NOW (5600, not 5350)
      expect(handle.getGestureState().pinRemainingMs).toBe(THUMB_PIN_MS);
      handle.destroy();
    } finally {
      nowMock.mockRestore();
    }
  });
});

describe('drag-flag residue guarantee (v1.9.0: every end path clears the gesture)', () => {
  it('pointercancel clears the drag (existing path, now via the shared ender)', () => {
    const { handle, thumb, down } = mountGesture(makeGestureVideo());
    down(9);
    expect(handle.getGestureState().dragging).toBe(true);
    thumb.__listeners.get('pointercancel')({ pointerId: 9 });
    expect(handle.getGestureState()).toEqual({ dragging: false, pinRemainingMs: 0 });
    handle.destroy();
  });

  it('a foreign-pointerId cancel/leave is ignored (still dragging)', () => {
    const { handle, thumb, down } = mountGesture(makeGestureVideo());
    down(9);
    thumb.__listeners.get('pointercancel')({ pointerId: 1234 });
    expect(handle.getGestureState().dragging).toBe(true);
    thumb.__listeners.get('pointerleave')({ pointerId: 1234 });
    expect(handle.getGestureState().dragging).toBe(true);
    handle.destroy();
  });

  it('pointerleave MID-DRAG ends the gesture (capture was lost — no residue)', () => {
    const { handle, thumb, down } = mountGesture(makeGestureVideo());
    down(9);
    expect(handle.getGestureState().dragging).toBe(true);
    thumb.__listeners.get('pointerleave')({ pointerId: 9 });
    expect(handle.getGestureState()).toEqual({ dragging: false, pinRemainingMs: 0 });
    handle.destroy();
  });

  it('window blur mid-drag ends the gesture; the blur guard dies with destroy()', () => {
    const winListeners = new Map(); // type -> Set<fn>
    const savedWindow = globalThis.window;
    globalThis.window = {
      addEventListener(type, fn) {
        if (!winListeners.has(type)) winListeners.set(type, new Set());
        winListeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        winListeners.get(type)?.delete(fn);
      },
    };
    try {
      const { handle, thumb, down } = mountGesture(makeGestureVideo());
      const blurs = winListeners.get('blur');
      expect(blurs?.size).toBe(1); // editor-lifetime guard armed at mount
      down(9);
      expect(handle.getGestureState().dragging).toBe(true);
      for (const fn of blurs) fn();
      expect(handle.getGestureState()).toEqual({ dragging: false, pinRemainingMs: 0 });
      handle.destroy();
      expect(winListeners.get('blur')?.size ?? 0).toBe(0); // guard removed
    } finally {
      if (savedWindow === undefined) delete globalThis.window;
      else globalThis.window = savedWindow;
    }
  });

  it('destroy() during a live drag clears the gesture state (no leak)', () => {
    const { handle, down } = mountGesture(makeGestureVideo());
    down(4);
    expect(handle.getGestureState().dragging).toBe(true);
    handle.destroy();
    expect(handle.getGestureState()).toEqual({ dragging: false, pinRemainingMs: 0 });
  });
});

describe('per-tick exception isolation (v1.9.0: one bad tick must not stop the loop)', () => {
  /** Canvas ctx whose drawImage always throws — the failing seam. */
  function throwingCtxCanvas() {
    return {
      width: 0,
      height: 0,
      style: {},
      getContext: () => ({
        clearRect() {},
        drawImage() {
          throw new Error('draw boom');
        },
      }),
    };
  }

  it('a throwing draw seam keeps the loop alive: re-scheduled + tickErr counted, warn ONCE', () => {
    const diag = (globalThis.__VR_DIAG = { tu: 0, vfc: 0, tickErr: 0, tued: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const video = makeGestureVideo({ duration: 10, currentTime: 0 });
      video.videoWidth = 640;
      video.videoHeight = 360;
      video.readyState = 2;
      const handle = mountEditor(
        { video, overlayCanvas: throwingCtxCanvas(), timeline: null, chipsContainer: null, playhead: null, trackList: null },
        {},
      );
      const armed = video.__vfc.pending.size; // the loop is armed
      expect(armed).toBe(1);

      video.fireFrame(); // tick: drawPreview throws → isolated
      expect(diag.tickErr).toBe(1);
      expect(diag.vfc).toBe(1); // the rVFC delivery still counted
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toBe('[editor-tick-error]');
      expect(video.__vfc.pending.size).toBe(1); // re-scheduled — LOOP ALIVE

      video.fireFrame(); // the next tick still runs
      expect(diag.tickErr).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1); // but the console warns ONCE
      handle.destroy();
    } finally {
      warn.mockRestore();
      delete globalThis.__VR_DIAG;
    }
  });

  it('the timeupdate fallback survives a throwing position write and still counts itself', () => {
    const diag = (globalThis.__VR_DIAG = { tu: 0, vfc: 0, tickErr: 0, tued: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const video = makeGestureVideo({ duration: 10, currentTime: 2.5 });
      const thumb = makeGestureEl();
      Object.defineProperty(thumb.style, 'left', {
        set() {
          throw new Error('style write boom');
        },
      });
      const timeline = makeGestureEl();
      timeline.querySelector = () => thumb;
      const handle = mountEditor(
        { video, overlayCanvas: null, timeline, chipsContainer: null, playhead: null, trackList: null },
        {},
      );
      video.dispatch('timeupdate'); // onTimeUpdate → tued++, updatePlayhead throws
      expect(diag.tued).toBe(1); // the editor's own listener proved itself
      expect(diag.tickErr).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      // A second timeupdate still arrives (handler alive) and counts again.
      video.dispatch('timeupdate');
      expect(diag.tued).toBe(2);
      handle.destroy();
    } finally {
      warn.mockRestore();
      delete globalThis.__VR_DIAG;
    }
  });

  it('getGestureState exists on every mount shape (contract surface)', () => {
    for (const handle of [
      mountEditor(null, null),
      mountEditor(
        { video: null, overlayCanvas: null, timeline: null, chipsContainer: null, playhead: null, trackList: null },
        {},
      ),
    ]) {
      expect(typeof handle.getGestureState).toBe('function');
      expect(handle.getGestureState()).toEqual({ dragging: false, pinRemainingMs: 0 });
      handle.destroy();
    }
  });
});

// ---------------------------------------------------------------------------
// v1.10.0 — the editor mounts at READY (file loaded, ZERO tracks), so the
// pre-analyze timeline must be fully driven: position updates, scrub gesture
// and clean teardown with an empty track set. This is the unit-side of the
// P0 probe (tools/debug-freeze-emulated.mjs) that failed on ≤ v1.9.0 builds.
// ---------------------------------------------------------------------------

describe('mountEditor at READY with zero tracks (v1.10.0 pre-analyze editor)', () => {
  it('the empty state renders clean: thumb + playhead parked at 0%, refresh safe, position still driven', () => {
    const video = makeGestureVideo({ duration: 10, currentTime: 0 });
    const { handle, thumb, playhead } = mountGesture(video, {
      hooks: { getState: () => ({ tracks: [], currentTime: video.currentTime, duration: 10 }) },
    });
    // Initial paint at mount: chips empty (none exist), thumb parked left.
    handle.redraw();
    expect(thumb.style.left).toBe('0%');
    expect(playhead.style.left).toBe('0%');
    // A refresh with 0 tracks never throws (the ready-state editor refreshes
    // on every refreshTrackUi call with nothing to show).
    expect(() => handle.refresh()).not.toThrow();
    // Position is driven with ZERO tracks: playback pre-analyze moves both.
    video.currentTime = 5;
    video.dispatch('timeupdate');
    expect(parseFloat(thumb.style.left)).toBeCloseTo(50, 5);
    expect(parseFloat(playhead.style.left)).toBeCloseTo(50, 5);
    handle.destroy();
  });

  it('scrub works pre-analyze: a thumb drag seeks and the pin retires when the seek lands', () => {
    let now = 1_000;
    const nowMock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const video = makeGestureVideo({ duration: 10, currentTime: 0 });
      const { handle, thumb, down, up } = mountGesture(video, {
        hooks: {
          getState: () => ({ tracks: [], currentTime: video.currentTime, duration: 10 }),
          onSeek: (t) => {
            video.currentTime = t; // the host seek path (main.js onSeek)
          },
        },
      });
      down();
      up(50); // release at 5s → endpoint seek → thumb parked at 50%, pin armed
      expect(thumb.style.left).toBe('50%');
      expect(video.currentTime).toBe(5);
      // The seek LANDS (currentTime within THUMB_PIN_EPSILON_S of the pin) —
      // the next timeupdate retires the pin early; the thumb re-derives.
      now += 50;
      video.currentTime = 5.02;
      video.dispatch('timeupdate');
      expect(parseFloat(thumb.style.left)).toBeCloseTo(50.2, 5);
      expect(handle.getGestureState().pinRemainingMs).toBe(0); // retired (settled)
      // And playback moves on freely: the thumb follows immediately.
      video.currentTime = 6;
      video.dispatch('timeupdate');
      expect(thumb.style.left).toBe('60%');
      handle.destroy();
    } finally {
      nowMock.mockRestore();
    }
  });

  it('destroy after an empty-track mount detaches every media listener (no pre-analyze leak)', () => {
    const video = makeGestureVideo({ duration: 10, currentTime: 0 });
    const { handle } = mountGesture(video, {
      hooks: { getState: () => ({ tracks: [], currentTime: 0, duration: 10 }) },
    });
    expect(video.__listeners.size).toBeGreaterThan(0); // seeked/loadedmetadata/timeupdate
    handle.destroy();
    expect(video.__listeners.size).toBe(0);
    expect(handle.getGestureState()).toEqual({ dragging: false, pinRemainingMs: 0 });
  });
});

// ---------------------------------------------------------------------------
// v1.15.0 REQ-125/126 — trim-region pure model (main.js) + region views
// (editor.js). main.js pulls ingest/analyze (real-media modules) at import
// time; both are mocked with the same shape main-wiring.test.js uses.
// ---------------------------------------------------------------------------

vi.mock('../../src/ingest.js', () => ({
  openInput: vi.fn(async () => { throw new Error('unused in unit tests'); }),
}));
vi.mock('../../src/analyze.js', () => ({
  runAnalyze: vi.fn(async () => { throw new Error('unused in unit tests'); }),
  sampleFrameAt: vi.fn(async () => { throw new Error('unused in unit tests'); }),
}));

const {
  MIN_TRIM_SPAN_S,
  normalizeTrims,
  addTrim,
  moveTrimEdge,
  removeTrim,
  trimsAt,
  keptSegments,
} = await import('../../src/main.js');
const { trimRegionViews } = await import('../../src/editor.js');

describe('main.trim helpers (v1.15.0 REQ-125): MIN_TRIM_SPAN_S', () => {
  it('is 0.1 s — the same floor as the chip-span trim', () => {
    expect(MIN_TRIM_SPAN_S).toBe(0.1);
  });
});

describe('main.normalizeTrims (v1.15.0)', () => {
  it('sorts by start and clamps into [0, duration]', () => {
    expect(
      normalizeTrims(
        [
          { id: 2, start: 7, end: 12 },
          { id: 1, start: -1, end: 3 },
        ],
        10,
      ),
    ).toEqual([
      { id: 1, start: 0, end: 3 },
      { id: 2, start: 7, end: 10 },
    ]);
  });

  it('drops regions below the minimum span and non-array input → []', () => {
    expect(normalizeTrims([{ id: 1, start: 2, end: 2.05 }], 10)).toEqual([]);
    expect(normalizeTrims('nope', 10)).toEqual([]);
    expect(normalizeTrims(null)).toEqual([]);
  });
});

describe('main.addTrim (v1.15.0 REQ-125)', () => {
  it('inserts a new region keeping the array sorted', () => {
    const base = [{ id: 1, start: 4, end: 6 }];
    const next = addTrim(base, 2, 1, 2, 10);
    expect(next).toEqual([
      { id: 2, start: 1, end: 2 },
      { id: 1, start: 4, end: 6 },
    ]);
    expect(base).toEqual([{ id: 1, start: 4, end: 6 }]); // input untouched
  });

  it('clips a request whose start edge sits inside an existing region', () => {
    // Drag [5,8] over region [4,6]: the region covers the drag's start edge →
    // the start is pulled right to the region's end → kept [6,8].
    expect(addTrim([{ id: 1, start: 4, end: 6 }], 2, 5, 8, 10)).toEqual([
      { id: 1, start: 4, end: 6 },
      { id: 2, start: 6, end: 8 },
    ]);
    // Same rule from the other side: drag [3,5] → end pulled left to 4
    // (covered by the end-edge test below).
    expect(addTrim([{ id: 1, start: 4, end: 6 }], 2, 1, 5, 10)).toEqual([
      { id: 2, start: 1, end: 4 },
      { id: 1, start: 4, end: 6 },
    ]);
  });

  it('clips a request whose end edge sits inside an existing region', () => {
    // Existing [4,6]; drag [3,5] → end pulled left to the region's start.
    expect(addTrim([{ id: 1, start: 4, end: 6 }], 2, 3, 5, 10)).toEqual([
      { id: 2, start: 3, end: 4 },
      { id: 1, start: 4, end: 6 },
    ]);
  });

  it('rejects a request fully covered by an existing region (identity)', () => {
    const base = [{ id: 1, start: 4, end: 6 }];
    expect(addTrim(base, 2, 4.5, 5.5, 10)).toBe(base);
  });

  it('rejects a request that would swallow an interior region (identity)', () => {
    const base = [
      { id: 1, start: 2, end: 3 },
      { id: 2, start: 5, end: 6 },
    ];
    expect(addTrim(base, 3, 1, 8, 10)).toBe(base);
  });

  it('rejects a sub-minimum-span request (identity)', () => {
    const base = [];
    expect(addTrim(base, 1, 2, 2.05, 10)).toBe(base);
  });

  it('clamps bounds into [0, duration]', () => {
    expect(addTrim([], 1, -5, 99, 10)).toEqual([{ id: 1, start: 0, end: 10 }]);
  });
});

describe('main.moveTrimEdge (v1.15.0 REQ-125)', () => {
  const base = [
    { id: 1, start: 1, end: 2 },
    { id: 2, start: 4, end: 6 },
  ];

  it('moves the start edge, clamped against the previous region + min span', () => {
    // Start of region 2 cannot cross region 1's end (2) nor region 2's end − 0.1.
    expect(moveTrimEdge(base, 2, 'start', 0.5, 10)).toEqual([
      { id: 1, start: 1, end: 2 },
      { id: 2, start: 2, end: 6 },
    ]);
    expect(moveTrimEdge(base, 2, 'start', 5.9, 10)).toEqual([
      { id: 1, start: 1, end: 2 },
      { id: 2, start: 5.9, end: 6 },
    ]);
  });

  it('moves the end edge, clamped against the next region + duration', () => {
    // Region 1's end can grow up to region 2's start (touching is allowed —
    // the regions stay non-overlapping); never past it.
    expect(moveTrimEdge(base, 1, 'end', 99, 10)).toEqual([
      { id: 1, start: 1, end: 4 },
      { id: 2, start: 4, end: 6 },
    ]);
    expect(moveTrimEdge(base, 1, 'end', 5, 10)).toEqual([
      { id: 1, start: 1, end: 4 },
      { id: 2, start: 4, end: 6 },
    ]);
    expect(moveTrimEdge(base, 2, 'end', 99, 10)).toEqual([
      { id: 1, start: 1, end: 2 },
      { id: 2, start: 4, end: 10 },
    ]);
  });

  it('returns unchanged content for an unknown id or impossible move', () => {
    expect(moveTrimEdge(base, 99, 'start', 3, 10)).toEqual(base);
    // Squeezing below the min span: region [1,2] start pushed to 2.05 with
    // end 2 → hi = end − 0.1 = 1.9, lo = 0 → start clamps to 1.9, never < 0.1 span.
    const moved = moveTrimEdge(base, 1, 'start', 2.05, 10);
    expect(moved[0].end - moved[0].start).toBeGreaterThanOrEqual(MIN_TRIM_SPAN_S);
  });
});

describe('main.removeTrim / main.trimsAt (v1.15.0 REQ-125)', () => {
  const base = [
    { id: 1, start: 2, end: 4 },
    { id: 2, start: 6, end: 8 },
  ];

  it('removeTrim drops the region by id (input untouched)', () => {
    expect(removeTrim(base, 1)).toEqual([{ id: 2, start: 6, end: 8 }]);
    expect(removeTrim(base, 99)).toEqual(base);
    expect(base).toHaveLength(2);
  });

  it('trimsAt is inclusive on both bounds and false outside', () => {
    expect(trimsAt(base, 2)).toBe(true);
    expect(trimsAt(base, 4)).toBe(true);
    expect(trimsAt(base, 3)).toBe(true);
    expect(trimsAt(base, 1.99)).toBe(false);
    expect(trimsAt(base, 4.01)).toBe(false);
    expect(trimsAt(base, NaN)).toBe(false);
    expect(trimsAt([], 3)).toBe(false);
  });
});

describe('main.keptSegments (v1.15.0 REQ-126 export contract)', () => {
  it('complements the trims: [{2,4}] on 10 s → [{0,2},{4,10}]', () => {
    expect(keptSegments([{ id: 1, start: 2, end: 4 }], 10)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 10 },
    ]);
  });

  it('empty trims → the whole video is kept', () => {
    expect(keptSegments([], 10)).toEqual([{ start: 0, end: 10 }]);
  });

  it('adjacent (touching) trims produce one merged kept tail, full coverage → []', () => {
    expect(keptSegments([
      { id: 1, start: 0, end: 2 },
      { id: 2, start: 2, end: 4 },
    ], 10)).toEqual([{ start: 4, end: 10 }]);
    expect(keptSegments([{ id: 1, start: 0, end: 10 }], 10)).toEqual([]);
  });

  it('a trim covering the head leaves no leading segment', () => {
    expect(keptSegments([{ id: 1, start: 0, end: 1 }], 5)).toEqual([{ start: 1, end: 5 }]);
  });

  it('degenerate duration → no segments', () => {
    expect(keptSegments([{ id: 1, start: 0, end: 5 }], 0)).toEqual([]);
  });
});

describe('editor.trimRegionViews (v1.15.0 REQ-125 view model)', () => {
  it('maps regions to clamped percentages', () => {
    expect(
      trimRegionViews(
        [
          { id: 1, start: 0, end: 2.5 },
          { id: 2, start: 5, end: 7.5 },
        ],
        10,
      ),
    ).toEqual([
      { id: 1, startPct: 0, widthPct: 25 },
      { id: 2, startPct: 50, widthPct: 25 },
    ]);
  });

  it('degenerate duration → no views; out-of-range bounds clamp', () => {
    expect(trimRegionViews([{ id: 1, start: 0, end: 5 }], 0)).toEqual([]);
    expect(trimRegionViews([{ id: 1, start: -3, end: 99 }], 10)).toEqual([
      { id: 1, startPct: 0, widthPct: 100 },
    ]);
  });
});

const { filterTracksByClass, trackSummaryCounts, formatTrackSummary } = await import('../../src/editor.js');

describe('track-list filter + summary (v1.21.0)', () => {
  const face = { id: 1, cls: 'face' };
  const plate = { id: 2, cls: 'plate' };
  const manual = { id: 3, cls: 'manual' };

  it('filterTracksByClass filters by class; all/invalid returns everything', () => {
    const tracks = [face, plate, manual];
    expect(filterTracksByClass(tracks, 'face')).toEqual([face]);
    expect(filterTracksByClass(tracks, 'plate')).toEqual([plate]);
    expect(filterTracksByClass(tracks, 'manual')).toEqual([manual]);
    expect(filterTracksByClass(tracks, 'all')).toEqual(tracks);
    expect(filterTracksByClass(tracks, 'bogus')).toEqual(tracks);
    expect(filterTracksByClass(undefined, 'face')).toEqual([]);
  });

  it('trackSummaryCounts + formatTrackSummary produce the panel summary', () => {
    const counts = trackSummaryCounts([face, face, plate, manual]);
    expect(counts).toEqual({ faces: 2, plates: 1, manual: 1, total: 4 });
    expect(formatTrackSummary(counts)).toBe('2 faces · 1 plate · 1 manual');
    expect(formatTrackSummary(trackSummaryCounts([face]))).toBe('1 face');
    expect(formatTrackSummary(trackSummaryCounts([]))).toBe('No tracks');
  });
});

// ---------------------------------------------------------------------------
// Sparse manual keyframes (v1.22.0 REQ-201) — interpolation model
// ---------------------------------------------------------------------------

const {
  interpolateBetween,
  interpolatedBoxAt,
  upsertKeyframe,
  densifyManualTracks,
  KEYFRAME_DENSE_STEP_S,
} = await import('../../src/editor.js');
import { pixelateFrame } from '../../src/redact.js';

describe('sparse manual keyframes (v1.22.0 REQ-201)', () => {
  const boxA = { x: 10, y: 20, w: 100, h: 50 };
  const boxB = { x: 30, y: 60, w: 200, h: 150 };
  const MID = { x: 20, y: 40, w: 150, h: 100 }; // exact 0.5 lerp A→B
  const lerp = (f) => interpolateBetween({ t: 2, box: boxA }, { t: 6, box: boxB }, 2 + f * 4);

  /** A manual track with keyframes {2: boxA, 6: boxB} over a 10 s video. */
  function manualTwoKf() {
    return upsertKeyframe([manualTrackFromBox(1, 2, boxA, 10)], 1, 6, boxB, 10)[0];
  }

  describe('interpolateBetween', () => {
    it('returns exact endpoint copies at the neighbor times', () => {
      expect(lerp(0)).toEqual(boxA);
      expect(lerp(1)).toEqual(boxB);
      expect(lerp(0)).not.toBe(boxA); // copies — inputs never shared
      expect(lerp(1)).not.toBe(boxB);
    });

    it('lerps every channel at the midpoint', () => {
      expect(lerp(0.5)).toEqual(MID);
      expect(lerp(0.25)).toEqual({ x: 15, y: 30, w: 125, h: 75 });
    });

    it('extrapolation clamps to the nearest endpoint (never overshoots)', () => {
      expect(interpolateBetween({ t: 2, box: boxA }, { t: 6, box: boxB }, 0)).toEqual(boxA);
      expect(interpolateBetween({ t: 2, box: boxA }, { t: 6, box: boxB }, 99)).toEqual(boxB);
    });

    it('degenerate inputs resolve to an endpoint copy, never NaN', () => {
      expect(interpolateBetween({ t: 5, box: boxA }, { t: 5, box: boxB }, 5)).toEqual(boxA);
      expect(interpolateBetween({ t: 2, box: boxA }, null, 4)).toEqual(boxA);
      expect(interpolateBetween(null, { t: 6, box: boxB }, 4)).toEqual(boxB);
      expect(interpolateBetween(null, null, 4)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
      expect(interpolateBetween({ t: 2, box: boxA }, { t: 6, box: boxB }, NaN)).toEqual(boxA);
    });
  });

  describe('interpolatedBoxAt', () => {
    it('resolves linearly between bracketing keyframes; exact at keyframes', () => {
      const track = manualTwoKf();
      expect(interpolatedBoxAt(track, 2)).toEqual(boxA);
      expect(interpolatedBoxAt(track, 6)).toEqual(boxB);
      expect(interpolatedBoxAt(track, 4)).toEqual(MID);
      // Outside the outermost keyframes → the nearest endpoint (clamp).
      expect(interpolatedBoxAt(track, 0)).toEqual(boxA);
      expect(interpolatedBoxAt(track, 10)).toEqual(boxB);
    });

    it('single keyframe is a constant box; outside the span → null', () => {
      const track = manualTrackFromBox(1, 2, boxA, 10);
      for (const t of [0, 0.5, 2, 5, 9.999, 10]) {
        expect(interpolatedBoxAt(track, t)).toEqual(boxA);
      }
      // Span gate ([start, end] inclusive — mirrors redact.tracksAt).
      const trimmed = { ...manualTwoKf(), start: 3, end: 5 };
      expect(interpolatedBoxAt(trimmed, 1)).toBeNull();
      expect(interpolatedBoxAt(trimmed, 7)).toBeNull();
      expect(interpolatedBoxAt(trimmed, 4)).toEqual(MID);
    });

    it('degrades to null on no keyframes / no Map / non-finite t', () => {
      expect(interpolatedBoxAt({ ...manualTwoKf(), keyframes: new Map() }, 4)).toBeNull();
      expect(interpolatedBoxAt({ ...manualTwoKf(), keyframes: null }, 4)).toBeNull();
      expect(interpolatedBoxAt(null, 4)).toBeNull();
      expect(interpolatedBoxAt(manualTwoKf(), NaN)).toBeNull();
    });
  });

  describe('upsertKeyframe', () => {
    it('adds a keyframe at the playhead in min-order and is PURE', () => {
      const track = manualTrackFromBox(1, 2, boxA, 10);
      const snapshot = [...track.keyframes];
      const out = upsertKeyframe([track], 1, 4, boxB, 10);
      expect(out).toHaveLength(1);
      expect(out[0]).not.toBe(track); // track copied
      expect(out[0].keyframes).not.toBe(track.keyframes); // Map rebuilt
      expect([...track.keyframes]).toEqual(snapshot); // input untouched
      const entries = [...out[0].keyframes.entries()];
      expect(entries.map(([t]) => t)).toEqual([2, 4]); // sorted ascending
      expect(entries[1][1]).toEqual(boxB);
      expect(entries[1][1]).not.toBe(boxB);
    });

    it('overwrites at the same time (nearest-keyframe update semantics)', () => {
      const track = upsertKeyframe([manualTrackFromBox(1, 2, boxA, 10)], 1, 4, boxB, 10);
      const updated = upsertKeyframe(track, 1, 4, { x: 0, y: 0, w: 1, h: 1 }, 10)[0];
      expect(updated.keyframes.size).toBe(2); // replaced, not duplicated
      expect(updated.keyframes.get(4)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
      expect(updated.keyframes.get(2)).toEqual(boxA);
    });

    it('clamps t into [0, durationSec]', () => {
      const track = manualTrackFromBox(1, 2, boxA, 10);
      expect(upsertKeyframe([track], 1, -3, boxB, 10)[0].keyframes.get(0)).toEqual(boxB);
      expect(upsertKeyframe([track], 1, 99, boxB, 10)[0].keyframes.get(10)).toEqual(boxB);
      expect(upsertKeyframe([track], 1, -3, boxB)[0].keyframes.get(0)).toEqual(boxB);
      // Non-finite t degrades to 0.
      expect(upsertKeyframe([track], 1, NaN, boxB, 10)[0].keyframes.get(0)).toEqual(boxB);
    });

    it('unknown id or a box-less call → unchanged content (new array)', () => {
      const track = manualTrackFromBox(1, 2, boxA, 10);
      const res = upsertKeyframe([track], 99, 4, boxB, 10);
      expect(res).not.toBe(track ? [track] : res); // new array
      expect(res[0]).toBe(track); // untouched track object by reference
      expect(res.map((t) => [...t.keyframes])).toEqual([[...track.keyframes]]);
      const res2 = upsertKeyframe([track], 1, 4, null, 10);
      expect(res2[0]).toBe(track);
    });
  });

  describe('densifyManualTracks (the preview/export consumer-boundary upgrade)', () => {
    it('materializes a sparse manual map onto the 1/30 s interpolated grid', () => {
      const track = manualTwoKf();
      const dense = densifyManualTracks([track])[0];
      expect(dense).not.toBe(track);
      expect(dense.source).toBe('manual');
      expect(dense.keyframes.get(2)).toEqual(boxA); // exact keyframes preserved
      expect(dense.keyframes.get(6)).toEqual(boxB);
      expect(dense.keyframes.get(4)).toEqual(MID); // on-grid midpoint interpolated
      // Grid coverage: strictly between the keyframes the max spacing is one
      // step (mirrors the tracker's dense contract).
      const keys = [...dense.keyframes.keys()].sort((a, b) => a - b);
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i] - keys[i - 1]).toBeLessThanOrEqual(KEYFRAME_DENSE_STEP_S + 1e-9);
      }
    });

    it('auto tracks and ≤ 1-keyframe manual tracks pass through by reference', () => {
      const auto = makeTrack();
      const single = manualTrackFromBox(2, 3, boxA, 10);
      const out = densifyManualTracks([auto, single]);
      expect(out[0]).toBe(auto);
      expect(out[1]).toBe(single);
      expect(densifyManualTracks([])).toEqual([]);
      expect(densifyManualTracks(undefined)).toEqual([]);
    });

    it('KEYFRAME_DENSE_STEP_S mirrors the tracker grid step', () => {
      expect(KEYFRAME_DENSE_STEP_S).toBe(1 / 30);
    });
  });

  describe('INTEGRATION: sparse keyframes redact with interpolation (no gap at export)', () => {
    /** Recording 2D-context (redact.test.js pattern, solid-style path). */
    function makeRec() {
      const calls = [];
      const ctx = {
        canvas: { width: 500, height: 500 },
        save: () => calls.push(['save']),
        restore: () => calls.push(['restore']),
        fillRect: (x, y, w, h) => calls.push(['fillRect', x, y, w, h]),
      };
      let fillStyle;
      Object.defineProperty(ctx, 'fillStyle', { get: () => fillStyle, set: (v) => { fillStyle = v; } });
      return { ctx, calls };
    }

    it('redact.tracksAt over the DENSIFIED track interpolates mid-span', () => {
      const track = manualTwoKf();
      const dense = densifyManualTracks([track])[0];
      expect(tracksAt([dense], 4)[0].box).toEqual(MID); // exact midpoint
      expect(tracksAt([dense], 3)[0].box).toEqual(lerp(0.25));
      // NO GAP: every instant of the span resolves to exactly one box.
      for (const t of [0, 2, 2.5, 4, 5.9, 6, 9.999, 10]) {
        expect(tracksAt([dense], t)).toHaveLength(1);
      }
      expect(tracksAt([dense], -0.5)).toEqual([]); // span gate intact
    });

    it('pixelateFrame (the export burn-in seam) receives the interpolated box', () => {
      const frame = { width: 500, height: 500 };
      const rec = makeRec();
      // The export path shape: densify → pixelateFrame(ctx, tracks, t, frame).
      pixelateFrame(rec.ctx, densifyManualTracks([manualTwoKf()]), 4, frame);
      const fills = rec.calls.filter((c) => c[0] === 'fillRect');
      expect(fills).toHaveLength(1);
      // The burned region is the DILATED interpolated midpoint box.
      expect(fills[0].slice(1)).toEqual([...Object.values(dilate(MID, 0.15, frame))]);
    });

    it('a sparse manual track burned WITHOUT densification would step (guard: dense input is the contract)', () => {
      // Documenting the seam requirement: the RAW sparse track nearest-lookup
      // jumps to boxB at t=4 (|4-6| < |4-2| is false → boxA actually); either
      // way it is an ENDPOINT box, never the interpolation. The densified
      // input is what carries the feature — pin both facts.
      const track = manualTwoKf();
      const rawHits = tracksAt([track], 4);
      expect(rawHits[0].box).toEqual(boxA); // nearest-only, NOT the midpoint
      const denseHits = tracksAt([densifyManualTracks([track])[0]], 4);
      expect(denseHits[0].box).toEqual(MID);
    });
  });
});

// ---------------------------------------------------------------------------
// View window: zoom / pan / pct mapping (v1.22.0 REQ-204)
// ---------------------------------------------------------------------------

describe('pctToTime / timeToPct (view-window mapping, v1.22.0 REQ-204)', () => {
  const ZOOMED = { start: 2.5, end: 7.5 };

  it('round-trips pct ⇄ time inside a zoomed view', () => {
    for (const p of [0, 12.5, 50, 87.5, 100]) {
      expect(timeToPct(pctToTime(p, ZOOMED), ZOOMED)).toBeCloseTo(p, 10);
    }
    expect(pctToTime(50, ZOOMED)).toBeCloseTo(5, 10);
    expect(pctToTime(0, ZOOMED)).toBeCloseTo(2.5, 10);
    expect(pctToTime(100, ZOOMED)).toBeCloseTo(7.5, 10);
  });

  it('clamps pct into [0,100] and times into the view', () => {
    expect(pctToTime(-10, ZOOMED)).toBeCloseTo(2.5, 10); // underflow → start
    expect(pctToTime(140, ZOOMED)).toBeCloseTo(7.5, 10); // overflow → end
    expect(timeToPct(0, ZOOMED)).toBe(0); // before the view → left edge
    expect(timeToPct(42, ZOOMED)).toBe(100); // after the view → right edge
  });

  it('degenerate/missing views degrade (never NaN)', () => {
    expect(pctToTime(50, { start: 4, end: 4 })).toBe(4);
    expect(pctToTime(50, null)).toBe(0);
    expect(timeToPct(5, { start: 4, end: 4 })).toBe(0);
    expect(timeToPct(5, undefined)).toBe(0);
    expect(timeToPct(NaN, ZOOMED)).toBe(0); // non-finite time → left edge pct
  });

  it('normalizeView repairs garbage windows and clamps to the duration', () => {
    expect(normalizeView(undefined, 10)).toEqual({ start: 0, end: 10 });
    expect(normalizeView({ start: 8, end: 3 }, 10)).toEqual({ start: 0, end: 10 }); // inverted → full
    expect(normalizeView({ start: -5, end: 42 }, 10)).toEqual({ start: 0, end: 10 });
    expect(normalizeView({ start: 2, end: NaN }, 10)).toEqual({ start: 2, end: 10 }); // one good bound survives
    expect(normalizeView(null, 0)).toEqual({ start: 0, end: 0 });
    expect(normalizeView({ start: 0, end: 10 }, -1)).toEqual({ start: 0, end: 0 }); // no duration → no view
  });
});

describe('zoomWindow (anchor-preserving zoom, v1.22.0 REQ-204)', () => {
  it('keeps the time under the anchor fixed while scaling the span', () => {
    const next = zoomWindow({ start: 0, end: 10 }, 2, 50, 10);
    expect(next.start).toBeCloseTo(2.5, 10);
    expect(next.end).toBeCloseTo(7.5, 10);
    // The anchor contract: the same strip position maps to the SAME time.
    expect(pctToTime(50, next)).toBeCloseTo(pctToTime(50, { start: 0, end: 10 }), 10);
  });

  it('zooms at a non-center anchor (cursor position for wheel zoom)', () => {
    const next = zoomWindow({ start: 0, end: 10 }, 2, 20, 10); // anchor t=2
    expect(pctToTime(20, next)).toBeCloseTo(2, 10);
    expect(next.end - next.start).toBeCloseTo(5, 10);
  });

  it('clamps the span at MIN_VIEW_SPAN_S on extreme zoom-in', () => {
    const next = zoomWindow({ start: 0, end: 10 }, 1e9, 0, 10);
    expect(next.end - next.start).toBeCloseTo(MIN_VIEW_SPAN_S, 10);
    expect(next.start).toBe(0);
  });

  it('zoom-out clamps the window into [0, duration], preserving the span', () => {
    // 2× out of [2,6] is an 8 s window anchored at 4 — it slides to the left
    // edge, it does NOT snap to the full clip (the span is the zoom level).
    expect(zoomWindow({ start: 2, end: 6 }, 0.5, 50, 10)).toEqual({ start: 0, end: 8 });
    // Only a big-enough zoom-out (span/factor ≥ duration) reaches the full window.
    expect(zoomWindow({ start: 2, end: 6 }, 0.1, 50, 10)).toEqual({ start: 0, end: 10 });
    expect(zoomWindow({ start: 0, end: 10 }, 0.1, 50, 10)).toEqual({ start: 0, end: 10 });
  });

  it('clamps the window into [0, duration] when the anchor nears an edge', () => {
    const low = zoomWindow({ start: 0, end: 4 }, 0.5, 50, 10); // would start < 0
    expect(low).toEqual({ start: 0, end: 8 });
    const high = zoomWindow({ start: 6, end: 10 }, 0.5, 50, 10); // would end > 10
    expect(high).toEqual({ start: 2, end: 10 });
  });

  it('garbage factor is a no-op; garbage duration yields {0, 0}', () => {
    expect(zoomWindow({ start: 1, end: 9 }, NaN, 50, 10)).toEqual({ start: 1, end: 9 });
    expect(zoomWindow({ start: 1, end: 9 }, 0, 50, 10)).toEqual({ start: 1, end: 9 });
    expect(zoomWindow({ start: 1, end: 9 }, 2, 50, 0)).toEqual({ start: 0, end: 0 });
    expect(Number.isFinite(zoomWindow({ start: NaN, end: NaN }, 2, 50, 10).start)).toBe(true);
  });

  it('ZOOM_WHEEL_FACTOR is 1.2 (REQ-204 per-notch contract)', () => {
    expect(ZOOM_WHEEL_FACTOR).toBe(1.2);
  });
});

describe('panWindow (v1.22.0 REQ-204)', () => {
  it('shifts both edges equally and preserves the span', () => {
    const next = panWindow({ start: 2, end: 7 }, 1, 10);
    expect(next.start).toBeCloseTo(3, 10);
    expect(next.end).toBeCloseTo(8, 10);
    const back = panWindow(next, -2.5, 10);
    expect(back.start).toBeCloseTo(0.5, 10);
    expect(back.end).toBeCloseTo(5.5, 10);
  });

  it('clamps at both boundaries without overshoot', () => {
    expect(panWindow({ start: 2, end: 7 }, 5, 10)).toEqual({ start: 5, end: 10 });
    expect(panWindow({ start: 2, end: 7 }, -5, 10)).toEqual({ start: 0, end: 5 });
    expect(panWindow({ start: 0, end: 10 }, 3, 10)).toEqual({ start: 0, end: 10 }); // full view: no-op
  });

  it('garbage delta / duration degrade safely (never NaN)', () => {
    expect(panWindow({ start: 2, end: 7 }, NaN, 10)).toEqual({ start: 2, end: 7 });
    expect(panWindow({ start: 2, end: 7 }, 1, -1)).toEqual({ start: 0, end: 0 });
  });
});

describe('zoomStep / fitWindow / isZoomed (v1.22.0 REQ-204 button models)', () => {
  it('zoomStep zooms around the CENTER anchor by default', () => {
    const next = zoomStep({ start: 0, end: 10 }, 2, undefined, 10);
    expect(next.start).toBeCloseTo(2.5, 10);
    expect(next.end).toBeCloseTo(7.5, 10);
    expect(pctToTime(50, next)).toBeCloseTo(5, 10);
  });

  it('zoomStep honors an explicit anchor and clamps to the duration', () => {
    expect(zoomStep({ start: 0, end: 10 }, 2, 0, 10)).toEqual({ start: 0, end: 5 });
    expect(zoomStep({ start: 0, end: 10 }, 0.5, 50, 10)).toEqual({ start: 0, end: 10 });
  });

  it('fitWindow resets to the full clip', () => {
    expect(fitWindow(10)).toEqual({ start: 0, end: 10 });
    expect(fitWindow(0)).toEqual({ start: 0, end: 0 });
  });

  it('isZoomed distinguishes a zoomed window from the full clip', () => {
    expect(isZoomed({ start: 0, end: 10 }, 10)).toBe(false);
    expect(isZoomed({ start: 2.5, end: 7.5 }, 10)).toBe(true);
    expect(isZoomed(null, 10)).toBe(false);
    expect(isZoomed({ start: 0, end: 10 }, 0)).toBe(false);
  });
});

describe('renderTimeline under a view window (v1.22.0 REQ-204)', () => {
  it('maps chip + playhead percentages view-relative', () => {
    const vm = renderTimeline([makeTrack({ start: 3, end: 5 })], 10, 6, { start: 2.5, end: 7.5 });
    expect(vm.chips[0].startPct).toBeCloseTo(10, 10); // (3−2.5)/5
    expect(vm.chips[0].endPct).toBeCloseTo(50, 10); // (5−2.5)/5
    expect(vm.playheadPct).toBeCloseTo(70, 10); // (6−2.5)/5
  });

  it('clips chips partially outside the view to the view edges', () => {
    const vm = renderTimeline([makeTrack({ start: 2, end: 4 })], 10, 5, { start: 2.5, end: 7.5 });
    expect(vm.chips[0].startPct).toBe(0); // 2 < view.start → clipped to 0
    expect(vm.chips[0].endPct).toBeCloseTo(30, 10);
    const gone = renderTimeline([makeTrack({ start: 0, end: 2 })], 10, 5, { start: 2.5, end: 7.5 });
    expect(gone.chips[0].endPct - gone.chips[0].startPct).toBe(0); // zero-width → renderer skips
  });

  it('FULL-view default is pixel-identical to the legacy math (regression pin)', () => {
    const legacy = renderTimeline([makeTrack({ start: 2, end: 4 })], 10, 5);
    for (const view of [undefined, null, { start: 0, end: 10 }]) {
      const vm = renderTimeline([makeTrack({ start: 2, end: 4 })], 10, 5, view);
      expect(vm.chips[0].startPct).toBe(legacy.chips[0].startPct);
      expect(vm.chips[0].endPct).toBe(legacy.chips[0].endPct);
      expect(vm.playheadPct).toBe(legacy.playheadPct);
    }
  });

  it('zero/negative duration still degrades to all-zero percentages', () => {
    const vm = renderTimeline([makeTrack()], 0, 5, { start: 0, end: 10 });
    expect(vm.chips[0].startPct).toBe(0);
    expect(vm.playheadPct).toBe(0);
  });
});

describe('trimRegionViews under a view window (v1.22.0 REQ-204)', () => {
  it('maps region geometry view-relative and clips at the edges', () => {
    expect(trimRegionViews([{ id: 1, start: 0, end: 4 }], 10, { start: 2, end: 6 })).toEqual([
      { id: 1, startPct: 0, widthPct: 50 },
    ]);
    const full = trimRegionViews([{ id: 1, start: 1, end: 3 }], 10);
    expect(full[0].startPct).toBeCloseTo(10, 10); // legacy full-view numbers
    expect(full[0].widthPct).toBeCloseTo(20, 10);
  });
});

describe('hitTestTimeline under a view window (v1.22.0 REQ-204)', () => {
  // Geometry: width=100 px, view [2.5, 7.5] → span 5 s, 1 px == 0.05 s; the
  // default 6 px edge zone == 0.3 s (pixel zones shrink with the zoom).
  it('maps pointer x → time through the view (body hit)', () => {
    const a = makeTrack({ start: 3, end: 6 });
    expect(hitTestTimeline(10, 5, 100, [a], 10, CHIP_EDGE_PX, { start: 2.5, end: 7.5 }))
      .toEqual({ track: a, zone: 'start' }); // t=3.0 → exactly the start edge
    expect(hitTestTimeline(50, 5, 100, [a], 10, CHIP_EDGE_PX, { start: 2.5, end: 7.5 }))
      .toEqual({ track: a, zone: 'body' }); // t=5.0 → body
    const b = makeTrack({ start: 0, end: 2 }); // entirely LEFT of the view
    expect(hitTestTimeline(50, 5, 100, [b], 10, CHIP_EDGE_PX, { start: 2.5, end: 7.5 })).toBeNull();
  });

  it('edge zones are PIXEL widths — they cover less time when zoomed', () => {
    const a = makeTrack({ start: 3, end: 6 });
    // t=3.2: 0.2 s past the start edge. Full view (10 s span): zone = 0.6 s → 'start'.
    expect(hitTestTimeline(32, 5, 100, [a], 10, CHIP_EDGE_PX, { start: 0, end: 10 }).zone).toBe('start');
    // Zoomed view (5 s span): zone = 0.3 s → 0.2 s is inside; 0.5 s is not.
    expect(hitTestTimeline(14, 5, 100, [a], 10, CHIP_EDGE_PX, { start: 2.5, end: 7.5 }).zone).toBe('start'); // t=3.2
    expect(hitTestTimeline(20, 5, 100, [a], 10, CHIP_EDGE_PX, { start: 2.5, end: 7.5 }).zone).toBe('body'); // t=3.5
  });

  it('full-view default keeps the legacy verdicts (regression pin)', () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(30, 10, 100, [a], 10)).toEqual({ track: a, zone: 'body' });
    expect(hitTestTimeline(30, 10, 100, [a], 10, CHIP_EDGE_PX, { start: 0, end: 10 })).toEqual({
      track: a,
      zone: 'body',
    });
  });
});
