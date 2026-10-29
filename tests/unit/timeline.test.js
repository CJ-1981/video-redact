/**
 * Unit tests for src/editor.js — PURE timeline model half (SPEC-VID-001,
 * design.md §4.7, REQ-012/013/014/015, AC-06/07/18; tasks.md T-502).
 *
 * Only the pure functions + the module's export surface are tested here —
 * the node environment has no DOM and the adapters (mountEditor,
 * beginManualBox) are guarded no-ops without one. Rendering/interaction is
 * E2E territory (Playwright, tests/e2e).
 */
import { describe, it, expect } from 'vitest';
import {
  MIN_MANUAL_SPAN_S,
  renderTimeline,
  hitTestTimeline,
  toggleTrack,
  tracksAtForView,
  manualTrackFromBox,
  scaleTracksToCanvas,
  beginManualBox,
  mountEditor,
} from '../../src/editor.js';
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
});

// ---------------------------------------------------------------------------
// hitTestTimeline (REQ-013, AC-18: "clicking a chip seeks the playhead")
// ---------------------------------------------------------------------------

describe('hitTestTimeline (chip under a point, smallest span wins)', () => {
  // Geometry used throughout: width=100 px, durationSec=10 s → the pointer x
  // is strip CSS px and maps to t = (x / width) * durationSec = x / 10.
  it('finds the track whose span contains the mapped time', () => {
    const a = makeTrack({ id: 1, start: 2, end: 4 });
    const hit = hitTestTimeline(30, 10, 100, [a], 10); // x=30% → t=3
    expect(hit).toEqual({ track: a });
  });

  it('returns null off every chip and on empty/missing tracks', () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(10, 10, 100, [a], 10)).toBeNull(); // t=1 < start
    expect(hitTestTimeline(50, 10, 100, [a], 10)).toBeNull(); // t=5 > end
    expect(hitTestTimeline(30, 10, 100, [], 10)).toBeNull(); // t=3, no tracks
    expect(hitTestTimeline(30, 10, 100, undefined, 10)).toBeNull();
  });

  it('includes the span edges (t === start and t === end, like tracksAt)', () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(20, 10, 100, [a], 10)?.track.id).toBe(1); // t=2
    expect(hitTestTimeline(40, 10, 100, [a], 10)?.track.id).toBe(1); // t=4
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
    expect(hitTestTimeline(95, 10, 100, [a], 10)?.track.id).toBe(1); // t=9.5
    expect(hitTestTimeline(5, 10, 100, [a], 10)).toBeNull(); // t=0.5 < start
  });

  it('returns null for zero width or zero duration (degenerate geometry)', () => {
    const a = makeTrack();
    expect(hitTestTimeline(30, 10, 0, [a], 10)).toBeNull();
    expect(hitTestTimeline(30, 10, 100, [a], 0)).toBeNull();
  });

  it('ignores y (single-lane timeline): every lane resolves identically', () => {
    const a = makeTrack({ start: 2, end: 4 });
    expect(hitTestTimeline(30, 0, 100, [a], 10)).toEqual({ track: a }); // t=3
    expect(hitTestTimeline(30, 43, 100, [a], 10)).toEqual({ track: a });
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
// manualTrackFromBox (REQ-015, AC-07)
// ---------------------------------------------------------------------------

describe('manualTrackFromBox (manual region factory)', () => {
  const box = { x: 40, y: 30, w: 120, h: 80 };

  it('builds a red, enabled, manual-source track labelled "Manual #N"', () => {
    const track = manualTrackFromBox(7, 3, box);
    expect(track.id).toBe(7);
    expect(track.cls).toBe('manual');
    expect(track.label).toBe('Manual #7');
    expect(track.color).toBe('#E5484D'); // design-direction alert red
    expect(track.enabled).toBe(true);
    expect(track.source).toBe('manual');
  });

  it('keys a COPY of the box at t (caller object never shared)', () => {
    const track = manualTrackFromBox(1, 3, box);
    expect(track.keyframes.size).toBe(1);
    const kf = track.keyframes.get(3);
    expect(kf).toEqual(box);
    expect(kf).not.toBe(box);
  });

  it(`materializes a ${MIN_MANUAL_SPAN_S}s minimum span [t, t + min]`, () => {
    expect(MIN_MANUAL_SPAN_S).toBeGreaterThan(0);
    const track = manualTrackFromBox(1, 3, box);
    expect(track.start).toBe(3);
    expect(track.end).toBeCloseTo(3 + MIN_MANUAL_SPAN_S, 10);
  });

  it('clamps the span end to durationSec (and never below start)', () => {
    expect(manualTrackFromBox(1, 9.8, box, 10).end).toBe(10);
    // t beyond duration: span degenerates but stays valid (end ≥ start).
    const beyond = manualTrackFromBox(1, 10.5, box, 10);
    expect(beyond.start).toBe(10.5);
    expect(beyond.end).toBe(10.5);
  });

  it('integrates: the created track renders as a chip and redacts like auto tracks', () => {
    const track = manualTrackFromBox(3, 2, box, 10);
    const vm = renderTimeline([track], 10, 2.2);
    expect(vm.chips).toHaveLength(1);
    expect(vm.chips[0].startPct).toBeCloseTo(20, 10);
    expect(tracksAt([track], 2.2)).toHaveLength(1); // inside [2, 2.5] → pixelated
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
  it('mountEditor(null, null) returns inert destroy/refresh that never throw', () => {
    const handle = mountEditor(null, null);
    expect(typeof handle.destroy).toBe('function');
    expect(typeof handle.refresh).toBe('function');
    expect(() => handle.refresh()).not.toThrow();
    expect(() => handle.destroy()).not.toThrow();
  });

  it('mountEditor tolerates missing hooks and partial els', () => {
    const handle = mountEditor(
      { video: null, overlayCanvas: null, timeline: null, chipsContainer: null, playhead: null, trackList: null },
      {},
    );
    expect(() => {
      handle.refresh();
      handle.destroy();
    }).not.toThrow();
  });

  it('beginManualBox(null, …) / no-callback detach without throwing', () => {
    expect(() => beginManualBox(null, () => {})()).not.toThrow();
    expect(() => beginManualBox({}, null)()).not.toThrow();
  });

  it('every pure export is a function (module contract surface)', () => {
    for (const fn of [
      renderTimeline, hitTestTimeline, toggleTrack,
      tracksAtForView, manualTrackFromBox, scaleTracksToCanvas,
      beginManualBox, mountEditor,
    ]) {
      expect(typeof fn).toBe('function');
    }
  });
});
