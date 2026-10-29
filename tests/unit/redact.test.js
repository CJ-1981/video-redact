/**
 * Unit tests for src/redact.js (SPEC-VID-001 design.md §4.5, REQ-007/014/016;
 * SPEC-VID-002 REQ-101/102 — per-track solid-black style).
 *
 * Canvas rendering is verified through a recording mock 2D context — no real
 * canvas exists in node. The pixelation pipeline is exercised end-to-end by
 * injecting a `scratch` factory whose context is the same kind of recorder.
 */
import { describe, it, expect } from 'vitest';
import {
  dilate, tracksAt, applyPixelation, applySolid, pixelateFrame, drawOverlay,
} from '../../src/redact.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A recording 2D-context mock. Method calls are pushed to `calls` as
 * [name, ...args]; property assignments (strokeStyle, lineWidth,
 * imageSmoothingEnabled, font, ...) are pushed as ['set', name, value] AND
 * stored in `props`, so ordering between property sets and calls is visible.
 */
function makeCtx(canvasWidth = 1920, canvasHeight = 1080) {
  const calls = [];
  const props = {};
  const ctx = {
    canvas: { width: canvasWidth, height: canvasHeight },
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    beginPath: () => calls.push(['beginPath']),
    strokeRect: (x, y, w, h) => calls.push(['strokeRect', x, y, w, h]),
    fillRect: (x, y, w, h) => calls.push(['fillRect', x, y, w, h]),
    fillText: (text, x, y) => calls.push(['fillText', text, x, y]),
    setLineDash: (dash) => calls.push(['setLineDash', dash]),
    drawImage: (img, ...args) => calls.push(['drawImage', img, ...args]),
  };
  for (const key of [
    'strokeStyle', 'fillStyle', 'lineWidth', 'font', 'textAlign',
    'textBaseline', 'imageSmoothingEnabled', 'globalAlpha', 'shadowColor',
  ]) {
    Object.defineProperty(ctx, key, {
      get: () => props[key],
      set: (v) => { props[key] = v; calls.push(['set', key, v]); },
    });
  }
  return { ctx, calls, props };
}

/**
 * A scratch-canvas stand-in: `canvas.width/height` are plain settable fields
 * (applyPixelation resizes the scratch per call) and `getContext('2d')`
 * returns a recorder.
 */
function makeScratch() {
  const rec = makeCtx(0, 0);
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => rec.ctx,
  };
  return { canvas, ...rec };
}

/** Track factory matching the design.md §2 Track typedef. */
function makeTrack(over = {}) {
  return {
    id: 1,
    cls: 'face',
    label: 'Face #1',
    color: '#2DD4BF',
    keyframes: new Map([[0, { x: 10, y: 10, w: 100, h: 100 }]]),
    start: 0,
    end: 10,
    enabled: true,
    source: 'auto',
    ...over,
  };
}

/** Convenience: nearest-call index finder. */
function callsNamed(calls, name) {
  return calls.filter((c) => c[0] === name);
}

// ---------------------------------------------------------------------------
// dilate
// ---------------------------------------------------------------------------

describe('dilate (REQ-007: 15% total, 7.5% per side)', () => {
  it('expands 7.5% of each dimension per side by default', () => {
    // dx = 200 * 0.075 = 15, dy = 100 * 0.075 = 7.5
    expect(dilate({ x: 100, y: 50, w: 200, h: 100 })).toEqual({
      x: 85, y: 42.5, w: 230, h: 115,
    });
  });

  it('honours a custom factor (0.5 total → 25% per side)', () => {
    expect(dilate({ x: 0, y: 0, w: 40, h: 80 }, 0.5)).toEqual({
      x: -10, y: -20, w: 60, h: 120,
    });
  });

  it('is pure: does not mutate its input box', () => {
    const box = { x: 10, y: 10, w: 100, h: 50 };
    const snapshot = { ...box };
    dilate(box);
    expect(box).toEqual(snapshot);
  });

  it('clamps into frame bounds when frameSize is given (left/top edge)', () => {
    const out = dilate({ x: 0, y: 0, w: 100, h: 80 }, 0.15, { width: 1920, height: 1080 });
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    // Dilated size is preserved even at the edge.
    expect(out.w).toBe(115);
    expect(out.h).toBe(92);
  });

  it('clamps into frame bounds (right/bottom edge) by shifting, keeping the dilated size', () => {
    const out = dilate({ x: 1900, y: 1070, w: 30, h: 20 }, 0.15, { width: 1920, height: 1080 });
    // raw: x = 1897.75, w = 34.5 → x+w = 1932.25 > 1920 → shifted to fit.
    expect(out.w).toBeCloseTo(34.5, 10);
    expect(out.h).toBeCloseTo(23, 10);
    expect(out.x + out.w).toBeLessThanOrEqual(1920);
    expect(out.y + out.h).toBeLessThanOrEqual(1080);
  });

  it('keeps result ≥ 1 px per side for degenerate (zero-sized) boxes', () => {
    const out = dilate({ x: 10, y: 10, w: 0, h: 0 });
    expect(out.w).toBeGreaterThanOrEqual(1);
    expect(out.h).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// tracksAt
// ---------------------------------------------------------------------------

describe('tracksAt (dense nearest-keyframe lookup, REQ-014 skip)', () => {
  const denseKeyframes = new Map([
    [4, { x: 40, y: 0, w: 10, h: 10 }],
    [5, { x: 50, y: 0, w: 10, h: 10 }],
    [6, { x: 60, y: 0, w: 10, h: 10 }],
  ]);

  it('returns the box of the exact keyframe when t lands on one', () => {
    const track = makeTrack({ keyframes: denseKeyframes, start: 4, end: 6 });
    expect(tracksAt([track], 5)).toEqual([{ track, box: { x: 50, y: 0, w: 10, h: 10 } }]);
  });

  it('returns the nearest keyframe box (|kt − t| minimal)', () => {
    const track = makeTrack({ keyframes: denseKeyframes, start: 4, end: 6 });
    const [hit] = tracksAt([track], 5.4);
    expect(hit.box.x).toBe(50); // |5 − 5.4| = 0.4 < |6 − 5.4| = 0.6
    const [hit2] = tracksAt([track], 5.75);
    expect(hit2.box.x).toBe(60); // |6 − 5.75| = 0.25 < 0.75
  });

  it('breaks exact ties in favour of the earlier keyframe', () => {
    const track = makeTrack({ keyframes: denseKeyframes, start: 4, end: 6 });
    const [hit] = tracksAt([track], 5.5);
    expect(hit.box.x).toBe(50);
  });

  it('includes tracks when t equals start or end (span is inclusive)', () => {
    const track = makeTrack({ keyframes: denseKeyframes, start: 4, end: 6 });
    expect(tracksAt([track], 4)).toHaveLength(1);
    expect(tracksAt([track], 6)).toHaveLength(1);
  });

  it('excludes tracks when t is outside [start, end]', () => {
    const track = makeTrack({ keyframes: denseKeyframes, start: 4, end: 6 });
    expect(tracksAt([track], 3.999)).toEqual([]);
    expect(tracksAt([track], 6.001)).toEqual([]);
  });

  it('skips disabled tracks even inside their span (REQ-014)', () => {
    const track = makeTrack({ keyframes: denseKeyframes, start: 4, end: 6, enabled: false });
    expect(tracksAt([track], 5)).toEqual([]);
  });

  it('returns hits in input array order and only active ones', () => {
    const a = makeTrack({
      id: 1, label: 'Face #1', color: '#2DD4BF', keyframes: denseKeyframes, start: 4, end: 6,
    });
    const b = makeTrack({
      id: 2, cls: 'plate', label: 'Plate #2', color: '#A78BFA',
      keyframes: new Map([[5, { x: 0, y: 500, w: 200, h: 60 }]]),
      start: 0, end: 10,
    });
    const c = makeTrack({
      id: 3, label: 'Face #3', color: '#F472B6', keyframes: denseKeyframes,
      start: 4, end: 6, enabled: false,
    });
    const hits = tracksAt([c, b, a], 5);
    expect(hits.map((h) => h.track.id)).toEqual([2, 1]);
    expect(hits[0].box).toEqual({ x: 0, y: 500, w: 200, h: 60 });
  });

  it('throws loudly when an enabled track covers t with no keyframes (density invariant)', () => {
    const track = makeTrack({ keyframes: new Map(), start: 4, end: 6 });
    expect(() => tracksAt([track], 5)).toThrow(/keyframes/i);
  });
});

// ---------------------------------------------------------------------------
// applyPixelation
// ---------------------------------------------------------------------------

describe('applyPixelation (design.md §4.5 burn-in, ADR-6)', () => {
  it('derives block = max(12, round(min(w,h)/10)): 120×60 → block 12 (scratch 10×5)', () => {
    const main = makeCtx();
    const scratch = makeScratch();
    applyPixelation(main.ctx, { x: 0, y: 0, w: 120, h: 60 }, { scratch: () => scratch.canvas });
    // block = max(12, round(60/10)=6) = 12 → dw = ceil(120/12) = 10, dh = ceil(60/12) = 5.
    expect(scratch.canvas.width).toBe(10);
    expect(scratch.canvas.height).toBe(5);
  });

  it('derives block 40 for a 400×400 box (scratch 10×10)', () => {
    const main = makeCtx();
    const scratch = makeScratch();
    applyPixelation(main.ctx, { x: 10, y: 10, w: 400, h: 400 }, { scratch: () => scratch.canvas });
    expect(scratch.canvas.width).toBe(10);
    expect(scratch.canvas.height).toBe(10);
  });

  it('honours an explicit opts.block override', () => {
    const main = makeCtx();
    const scratch = makeScratch();
    applyPixelation(
      main.ctx,
      { x: 0, y: 0, w: 100, h: 100 },
      { block: 25, scratch: () => scratch.canvas },
    );
    expect(scratch.canvas.width).toBe(4); // ceil(100/25)
    expect(scratch.canvas.height).toBe(4);
  });

  it('downscales with smoothing ON (scratch ctx) and upscales with smoothing OFF (main ctx)', () => {
    const main = makeCtx();
    const scratch = makeScratch();
    applyPixelation(main.ctx, { x: 0, y: 0, w: 120, h: 60 }, { scratch: () => scratch.canvas });

    const scratchSmoothing = scratch.calls.filter(
      (c) => c[0] === 'set' && c[1] === 'imageSmoothingEnabled',
    );
    expect(scratchSmoothing).toContainEqual(['set', 'imageSmoothingEnabled', true]);

    const mainSmoothing = main.calls.filter(
      (c) => c[0] === 'set' && c[1] === 'imageSmoothingEnabled',
    );
    expect(mainSmoothing).toContainEqual(['set', 'imageSmoothingEnabled', false]);
  });

  it('pipeline: save → downscale into scratch → smoothing-off upscale → restore', () => {
    const main = makeCtx();
    const scratch = makeScratch();
    const box = { x: 100, y: 50, w: 120, h: 60 };
    applyPixelation(main.ctx, box, { scratch: () => scratch.canvas });

    const names = main.calls.map((c) => c[0]);
    expect(names[0]).toBe('save');
    expect(names[names.length - 1]).toBe('restore');
    expect(names.filter((n) => n === 'save')).toHaveLength(1);
    expect(names.filter((n) => n === 'restore')).toHaveLength(1);

    // The only main-ctx draw is the upscale from the scratch canvas into the
    // exact region (dw=10, dh=5 for 120×60 at block 12).
    const draws = callsNamed(main.calls, 'drawImage');
    expect(draws).toHaveLength(1);
    const [, img, sx, sy, sw, sh, dx, dy, dw, dh] = draws[0];
    expect(img).toBe(scratch.canvas);
    expect([sx, sy, sw, sh]).toEqual([0, 0, 10, 5]);
    expect([dx, dy, dw, dh]).toEqual([100, 50, 120, 60]);
  });

  it('samples ONLY the region from the source canvas (never a full-frame filter)', () => {
    const main = makeCtx(1920, 1080);
    const scratch = makeScratch();
    applyPixelation(main.ctx, { x: 500, y: 300, w: 120, h: 60 }, { scratch: () => scratch.canvas });

    const [down] = callsNamed(scratch.calls, 'drawImage');
    const [, srcImg, sx, sy, sw, sh] = down;
    expect(srcImg).toBe(main.ctx.canvas);
    expect([sx, sy, sw, sh]).toEqual([500, 300, 120, 60]);
    expect(sw).not.toBe(main.ctx.canvas.width);
    expect(sh).not.toBe(main.ctx.canvas.height);
  });

  it('accepts a reused scratch canvas instance (export hot path) and resizes it per call', () => {
    const main = makeCtx();
    const scratch = makeScratch();
    applyPixelation(main.ctx, { x: 0, y: 0, w: 120, h: 60 }, { scratch: scratch.canvas });
    expect(scratch.canvas.width).toBe(10);
    expect(scratch.canvas.height).toBe(5);
    // Same instance flows into the upscale drawImage.
    expect(callsNamed(main.calls, 'drawImage')[0][1]).toBe(scratch.canvas);
  });

  it('rounds fractional block rules up to whole scratch pixels (100×100 → block 12 → 9×9)', () => {
    const main = makeCtx();
    const scratch = makeScratch();
    applyPixelation(main.ctx, { x: 0, y: 0, w: 100, h: 100 }, { scratch: () => scratch.canvas });
    // block = max(12, round(10)) = 12; ceil(100/12) = 9.
    expect(scratch.canvas.width).toBe(9);
    expect(scratch.canvas.height).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// applySolid (REQ-101: 'solid' style — opaque black box)
// ---------------------------------------------------------------------------

describe('applySolid (REQ-101: opaque black box over the given box)', () => {
  it('fills the EXACT box with opaque black', () => {
    const rec = makeCtx();
    applySolid(rec.ctx, { x: 10, y: 20, w: 100, h: 50 });

    const fills = callsNamed(rec.calls, 'fillRect');
    expect(fills).toHaveLength(1);
    expect(fills[0].slice(1)).toEqual([10, 20, 100, 50]);
    expect(rec.props.fillStyle).toBe('#000000');
  });

  it('clamps into the canvas bounds (left/top overflow)', () => {
    const rec = makeCtx(1920, 1080);
    applySolid(rec.ctx, { x: -15, y: -5, w: 100, h: 60 });
    expect(callsNamed(rec.calls, 'fillRect')[0].slice(1)).toEqual([0, 0, 85, 55]);
  });

  it('clamps into the canvas bounds (right/bottom overflow)', () => {
    const rec = makeCtx(1920, 1080);
    applySolid(rec.ctx, { x: 1900, y: 1050, w: 100, h: 100 });
    expect(callsNamed(rec.calls, 'fillRect')[0].slice(1)).toEqual([1900, 1050, 20, 30]);
  });

  it('no-ops without any fillRect for a box fully outside the canvas', () => {
    const rec = makeCtx(100, 100);
    applySolid(rec.ctx, { x: 200, y: 200, w: 50, h: 50 });
    expect(callsNamed(rec.calls, 'fillRect')).toHaveLength(0);
  });

  it('rasterizes with fillRect only — never drawImage (no scratch, no sampling)', () => {
    const rec = makeCtx();
    applySolid(rec.ctx, { x: 0, y: 0, w: 40, h: 40 });
    expect(callsNamed(rec.calls, 'drawImage')).toHaveLength(0);
  });

  it('wraps its drawing state in exactly one save/restore pair', () => {
    const rec = makeCtx();
    applySolid(rec.ctx, { x: 0, y: 0, w: 40, h: 40 });
    const names = rec.calls.map((c) => c[0]);
    expect(names[0]).toBe('save');
    expect(names[names.length - 1]).toBe('restore');
    expect(names.filter((n) => n === 'save')).toHaveLength(1);
    expect(names.filter((n) => n === 'restore')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pixelateFrame — per-track style dispatch (REQ-101/102 shared seam)
// ---------------------------------------------------------------------------

describe('pixelateFrame — per-track style dispatch (REQ-101/102)', () => {
  const frame = { width: 1920, height: 1080 };

  it('solid track → opaque black fillRect over the DILATED box, no drawImage', () => {
    const rec = makeCtx();
    const track = makeTrack({
      style: 'solid',
      keyframes: new Map([[0, { x: 100, y: 50, w: 40, h: 40 }]]),
    });
    pixelateFrame(rec.ctx, [track], 0, frame);

    // dilate({100,50,40,40}, 0.15) = {97, 47, 46, 46} — same dilation as pixelate.
    const fills = callsNamed(rec.calls, 'fillRect');
    expect(fills).toHaveLength(1);
    expect(fills[0].slice(1)).toEqual([97, 47, 46, 46]);
    expect(rec.props.fillStyle).toBe('#000000');
    expect(callsNamed(rec.calls, 'drawImage')).toHaveLength(0);
  });

  it('explicit pixelate track → downscale/upscale path, no fillRect', () => {
    const rec = makeCtx();
    const scratch = makeScratch();
    const track = makeTrack({
      style: 'pixelate',
      keyframes: new Map([[0, { x: 100, y: 50, w: 40, h: 40 }]]),
    });
    pixelateFrame(rec.ctx, [track], 0, frame, { scratch: () => scratch.canvas });

    expect(callsNamed(rec.calls, 'fillRect')).toHaveLength(0);
    const ups = callsNamed(rec.calls, 'drawImage');
    expect(ups).toHaveLength(1);
    expect(ups[0].slice(6)).toEqual([97, 47, 46, 46]);
  });

  it('missing style (legacy track without the field) defaults to pixelate', () => {
    const rec = makeCtx();
    const scratch = makeScratch();
    const track = makeTrack({ keyframes: new Map([[0, { x: 100, y: 50, w: 40, h: 40 }]]) });
    delete track.style;
    pixelateFrame(rec.ctx, [track], 0, frame, { scratch: () => scratch.canvas });

    expect(callsNamed(rec.calls, 'fillRect')).toHaveLength(0);
    expect(callsNamed(rec.calls, 'drawImage')).toHaveLength(1);
  });

  it('mixed tracks → both styles burn in ONE frame, dilation applied to BOTH', () => {
    const rec = makeCtx();
    const scratch = makeScratch();
    const solid = makeTrack({
      id: 1,
      style: 'solid',
      keyframes: new Map([[0, { x: 100, y: 50, w: 40, h: 40 }]]),
    });
    const pix = makeTrack({
      id: 2,
      style: 'pixelate',
      keyframes: new Map([[0, { x: 300, y: 200, w: 20, h: 20 }]]),
    });
    pixelateFrame(rec.ctx, [solid, pix], 0, frame, { scratch: () => scratch.canvas });

    // Solid: dilate({100,50,40,40}) = {97, 47, 46, 46} → one black fillRect.
    const fills = callsNamed(rec.calls, 'fillRect');
    expect(fills).toHaveLength(1);
    expect(fills[0].slice(1)).toEqual([97, 47, 46, 46]);

    // Pixelate: dilate({300,200,20,20}) = {298.5, 198.5, 23, 23} → one upscale.
    const ups = callsNamed(rec.calls, 'drawImage');
    expect(ups).toHaveLength(1);
    expect(ups[0].slice(6)).toEqual([298.5, 198.5, 23, 23]);
  });

  it('still skips disabled tracks and spans for solid style (tracksAt contract intact)', () => {
    const rec = makeCtx();
    const solid = makeTrack({
      id: 1,
      style: 'solid',
      keyframes: new Map([[0, { x: 10, y: 10, w: 40, h: 40 }]]),
    });
    const disabled = makeTrack({
      id: 2,
      style: 'solid',
      enabled: false,
      keyframes: new Map([[0, { x: 500, y: 500, w: 40, h: 40 }]]),
    });
    pixelateFrame(rec.ctx, [solid, disabled], 0, frame);
    expect(callsNamed(rec.calls, 'fillRect')).toHaveLength(1);

    pixelateFrame(rec.ctx, [solid], 0 + 1e-3 + 100, frame); // outside [start, end]
    expect(callsNamed(rec.calls, 'fillRect')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// drawOverlay
// ---------------------------------------------------------------------------

describe('drawOverlay (review overlay, REQ-014 visual state, REQ-016 preview)', () => {
  const box = { x: 100, y: 100, w: 120, h: 60 };

  it('draws a solid track-colored stroke and the label above the box for an active track', () => {
    const rec = makeCtx();
    const track = makeTrack({ keyframes: new Map([[5, box]]), start: 0, end: 10 });
    drawOverlay(rec.ctx, [track], 5);

    const strokes = callsNamed(rec.calls, 'strokeRect');
    expect(strokes).toHaveLength(1);
    expect(strokes[0].slice(1)).toEqual([100, 100, 120, 60]);
    expect(rec.props.strokeStyle).toBe('#2DD4BF');
    expect(rec.props.lineWidth).toBe(2);

    const labels = callsNamed(rec.calls, 'fillText');
    expect(labels).toHaveLength(1);
    expect(labels[0][1]).toBe('Face #1');
    expect(labels[0][3]).toBeLessThan(box.y); // label sits ABOVE the box
  });

  it('draws a dashed safe-green stroke with a "visible" tag for a disabled track', () => {
    const rec = makeCtx();
    const track = makeTrack({
      enabled: false, color: '#3ECF8E', keyframes: new Map([[5, box]]), start: 0, end: 10,
    });
    drawOverlay(rec.ctx, [track], 5);

    const dashes = callsNamed(rec.calls, 'setLineDash').filter((c) => c[1].length > 0);
    expect(dashes.length).toBeGreaterThanOrEqual(1);
    expect(rec.props.strokeStyle).toBe('#3ECF8E');

    const labels = callsNamed(rec.calls, 'fillText');
    expect(labels).toHaveLength(1);
    expect(labels[0][1]).toMatch(/visible/i);
  });

  it('draws nothing for tracks whose span does not contain t', () => {
    const rec = makeCtx();
    const track = makeTrack({ keyframes: new Map([[5, box]]), start: 0, end: 10 });
    drawOverlay(rec.ctx, [track], 99);
    expect(callsNamed(rec.calls, 'strokeRect')).toHaveLength(0);
    expect(callsNamed(rec.calls, 'fillText')).toHaveLength(0);
  });

  it('renders enabled and disabled tracks active at t in one pass', () => {
    const rec = makeCtx();
    const on = makeTrack({ id: 1, keyframes: new Map([[5, box]]), start: 0, end: 10 });
    const off = makeTrack({
      id: 2, label: 'Face #2', color: '#3ECF8E', enabled: false,
      keyframes: new Map([[5, { x: 300, y: 200, w: 80, h: 80 }]]), start: 0, end: 10,
    });
    drawOverlay(rec.ctx, [on, off], 5);
    expect(callsNamed(rec.calls, 'strokeRect')).toHaveLength(2);
    expect(callsNamed(rec.calls, 'fillText')).toHaveLength(2);
  });

  it('never rasterizes pixels: overlay contains no drawImage (overlay-only, design §4.7)', () => {
    const rec = makeCtx();
    const track = makeTrack({ keyframes: new Map([[5, box]]), start: 0, end: 10 });
    drawOverlay(rec.ctx, [track], 5);
    expect(callsNamed(rec.calls, 'drawImage')).toHaveLength(0);
  });

  it('scales stroke, label font and dash by viewScale', () => {
    const rec = makeCtx();
    const on = makeTrack({ keyframes: new Map([[5, box]]), start: 0, end: 10 });
    const off = makeTrack({
      id: 2, label: 'Face #2', color: '#3ECF8E', enabled: false,
      keyframes: new Map([[5, { x: 300, y: 200, w: 80, h: 80 }]]), start: 0, end: 10,
    });
    drawOverlay(rec.ctx, [on, off], 5, 2);

    expect(rec.props.lineWidth).toBe(4);
    expect(rec.props.font).toContain('24px');

    const dash = callsNamed(rec.calls, 'setLineDash').find((c) => c[1].length > 0);
    expect(dash[1][0]).toBeGreaterThan(4); // scaled dash, not the 1× values
  });

  it('flips the label inside the box when there is no room above (top edge)', () => {
    const rec = makeCtx();
    const topBox = { x: 100, y: 0, w: 120, h: 60 };
    const track = makeTrack({ keyframes: new Map([[5, topBox]]), start: 0, end: 10 });
    drawOverlay(rec.ctx, [track], 5);
    const [label] = callsNamed(rec.calls, 'fillText');
    expect(label[3]).toBeGreaterThan(0); // drawn inside, below the top edge
  });

  it('wraps its drawing state in exactly one save/restore pair', () => {
    const rec = makeCtx();
    const track = makeTrack({ keyframes: new Map([[5, box]]), start: 0, end: 10 });
    drawOverlay(rec.ctx, [track], 5);
    const names = rec.calls.map((c) => c[0]);
    expect(names[0]).toBe('save');
    expect(names[names.length - 1]).toBe('restore');
    expect(names.filter((n) => n === 'save')).toHaveLength(1);
    expect(names.filter((n) => n === 'restore')).toHaveLength(1);
  });

  it('is style-agnostic (REQ-101): a solid track still gets stroke + label, no fillRect', () => {
    const rec = makeCtx();
    const track = makeTrack({
      style: 'solid',
      keyframes: new Map([[5, box]]),
      start: 0,
      end: 10,
    });
    drawOverlay(rec.ctx, [track], 5);

    expect(callsNamed(rec.calls, 'strokeRect')).toHaveLength(1);
    expect(callsNamed(rec.calls, 'fillText')).toHaveLength(1);
    expect(callsNamed(rec.calls, 'fillRect')).toHaveLength(0);
  });
});
