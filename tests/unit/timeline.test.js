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
import { describe, it, expect } from 'vitest';
import {
  MIN_TRACK_SPAN_S,
  CHIP_EDGE_PX,
  CHIP_EDGE_PX_COARSE,
  effectiveEdgePx,
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

  it('keys a COPY of the box as the constant keyframe at 0 (never shared)', () => {
    const track = manualTrackFromBox(1, 3, box);
    expect(track.keyframes.size).toBe(1);
    const kf = track.keyframes.get(0);
    expect(kf).toEqual(box);
    expect(kf).not.toBe(box);
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
      scaleTracksToCanvas, beginManualBox, mountEditor,
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
