/**
 * tracker.js unit tests (SPEC-VID-001, plan §E M3 — TDD).
 *
 * Covers: IoU exactness, KalmanCV constant-velocity convergence, the AC-05
 * privacy centerpiece (dense 1/30 s keyframe interpolation over detection
 * dropout, ±padding span materialization), track lifecycle (tentative →
 * confirmed → closed; no revival), gated greedy association (crossing
 * objects keep identities), per-class independence, and the manual-track
 * skeleton helper.
 */
import { describe, it, expect } from 'vitest';
import { Tracker, KalmanCV, iou, interpolate, TRACK_COLORS } from '../../src/tracker.js';

const FPS = 30;
const frame = (f) => f / FPS;

/** Detection factory (design.md §2). */
function det(t, box, cls = 'face', conf = 0.9) {
  return { t, box, cls, conf, pass: 'full' };
}

/** Nearest entry of a dense [{t, box}] array to time t (the tracksAt contract). */
function nearestSample(dense, t) {
  let best = null;
  let bestDist = Infinity;
  for (const s of dense) {
    const d = Math.abs(s.t - t);
    if (d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return { sample: best, dist: bestDist };
}

describe('iou — xywh exactness (REQ-006)', () => {
  it('identical boxes → 1', () => {
    expect(iou({ x: 10, y: 20, w: 30, h: 40 }, { x: 10, y: 20, w: 30, h: 40 })).toBe(1);
  });

  it('disjoint boxes → 0', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 100, w: 10, h: 10 })).toBe(0);
  });

  it('edge-touching boxes → 0 (empty intersection)', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(0);
  });

  it('half-overlap → exact 1/3', () => {
    // inter = 5*10 = 50; union = 100 + 100 - 50 = 150.
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 0, w: 10, h: 10 })).toBeCloseTo(1 / 3, 12);
  });

  it('contained box → exact 0.16', () => {
    // inter = 4*4 = 16; union = 100.
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 2, w: 4, h: 4 })).toBeCloseTo(0.16, 12);
  });

  it('zero-area boxes → 0 (no division blowup)', () => {
    expect(iou({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 })).toBe(0);
  });
});

describe('TRACK_COLORS — 8-slot categorical palette', () => {
  it('exports 8 CSS hex colors (teal/violet/coral/lime/amber/cyan/rose/mint)', () => {
    expect(TRACK_COLORS).toHaveLength(8);
    for (const c of TRACK_COLORS) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('KalmanCV — constant-velocity model (REQ-006)', () => {
  it('exposes the initial box before any predict/update', () => {
    const kf = new KalmanCV({ x: 10, y: 20, w: 30, h: 40 });
    expect(kf.box()).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it('predict() on a static box keeps the box (zero velocity)', () => {
    const kf = new KalmanCV({ x: 50, y: 60, w: 20, h: 20 });
    const p = kf.predict();
    for (const k of ['x', 'y', 'w', 'h']) expect(p[k]).toBeCloseTo({ x: 50, y: 60, w: 20, h: 20 }[k], 6);
  });

  it('converges on linear motion: predicted next box within tolerance', () => {
    const kf = new KalmanCV({ x: 100, y: 200, w: 40, h: 40 });
    for (let i = 0; i < 10; i++) {
      kf.predict();
      kf.update({ x: 100 + 2 * i, y: 200, w: 40, h: 40 });
    }
    const p = kf.predict(); // one step ahead of the last update
    expect(p.x).toBeCloseTo(120, 1); // 100 + 2*10
    expect(p.y).toBeCloseTo(200, 1);
    expect(p.w).toBeCloseTo(40, 1);
    expect(p.h).toBeCloseTo(40, 1);
  });

  it('predict() advances state by the learned velocity per call', () => {
    const kf = new KalmanCV({ x: 0, y: 0, w: 20, h: 20 });
    for (let i = 0; i < 10; i++) {
      kf.predict();
      kf.update({ x: 3 * i, y: 0, w: 20, h: 20 });
    }
    const p1 = kf.predict();
    const p2 = kf.predict();
    expect(p2.x - p1.x).toBeCloseTo(3, 1); // ~3 px per frame period
  });
});

describe('interpolate — dense 1/30 s gap sampling (AC-05 contract)', () => {
  it('keeps endpoint keyframes exact and fills gaps linearly on the 1/30 s grid', () => {
    const track = {
      keyframes: new Map([
        [1, { x: 0, y: 0, w: 10, h: 10 }],
        [2, { x: 30, y: 10, w: 20, h: 30 }],
      ]),
    };
    const dense = interpolate(track);

    expect(dense[0]).toEqual({ t: 1, box: { x: 0, y: 0, w: 10, h: 10 } });
    const last = dense[dense.length - 1];
    expect(last.t).toBeCloseTo(2, 9);
    expect(last.box).toEqual({ x: 30, y: 10, w: 20, h: 30 });

    // 29 interior samples on the 1/30 s grid strictly between 1 and 2.
    expect(dense).toHaveLength(31);

    // Midpoint: fraction 0.5 → x=15, y=5, w=15, h=20.
    const mid = nearestSample(dense, 1.5);
    expect(mid.dist).toBeLessThan(1 / 60);
    expect(mid.sample.box.x).toBeCloseTo(15, 9);
    expect(mid.sample.box.y).toBeCloseTo(5, 9);
    expect(mid.sample.box.w).toBeCloseTo(15, 9);
    expect(mid.sample.box.h).toBeCloseTo(20, 9);
  });

  it('single keyframe → dense array with that one sample', () => {
    const dense = interpolate({ keyframes: new Map([[5, { x: 1, y: 2, w: 3, h: 4 }]]) });
    expect(dense).toEqual([{ t: 5, box: { x: 1, y: 2, w: 3, h: 4 } }]);
  });

  it('empty keyframes → empty array', () => {
    expect(interpolate({ keyframes: new Map() })).toEqual([]);
  });

  it('sorts an out-of-order keyframe map by time', () => {
    const dense = interpolate({
      keyframes: new Map([
        [2, { x: 10, y: 0, w: 1, h: 1 }],
        [1, { x: 0, y: 0, w: 1, h: 1 }],
      ]),
    });
    expect(dense.map((s) => s.t)).toEqual([...dense.map((s) => s.t)].sort((a, b) => a - b));
    expect(dense[0].t).toBeCloseTo(1, 9);
    expect(dense[dense.length - 1].t).toBeCloseTo(2, 9);
  });

  it('does not mutate the input track and returns fresh box objects', () => {
    const kf = new Map([[1, { x: 0, y: 0, w: 10, h: 10 }]]);
    const track = { keyframes: kf };
    const dense = interpolate(track);
    dense[0].box.x = 999;
    expect(kf.get(1).x).toBe(0);
    expect(track.keyframes).toBe(kf);
    expect(kf.size).toBe(1);
  });
});

describe('Tracker — lifecycle (tentative → confirmed → closed)', () => {
  it('confirms a track after 2 hits and materializes a finalized Track', () => {
    const tracker = new Tracker();
    tracker.update([det(0, { x: 0, y: 0, w: 40, h: 40 })], 0);
    tracker.update([det(1 / 30, { x: 1, y: 0, w: 40, h: 40 })], 1 / 30);
    tracker.update([det(2 / 30, { x: 2, y: 0, w: 40, h: 40 })], 2 / 30);

    const tracks = tracker.finalize(0.1);
    expect(tracks).toHaveLength(1);
    const tr = tracks[0];
    expect(tr.cls).toBe('face');
    expect(tr.label).toBe('Face #1');
    expect(tr.enabled).toBe(true);
    expect(tr.source).toBe('auto');
    expect(TRACK_COLORS).toContain(tr.color);
    expect(tr.keyframes).toBeInstanceOf(Map);
    expect(tr.start).toBe(0); // first − pad < 0 clamps at 0 (span shrink never leaks)
    expect(tr.end).toBeCloseTo(2 / 30 + 0.1, 9);
  });

  it('drops 1-hit tentative tracks by default (ghost suppression)', () => {
    const tracker = new Tracker();
    tracker.update([det(1, { x: 0, y: 0, w: 40, h: 40 })], 1);
    tracker.update([], 1 + 1 / 30);
    tracker.update([], 1 + 2 / 30);
    expect(tracker.finalize(0)).toEqual([]);
  });

  it('keeps tentative tracks when the keepTentative option is set', () => {
    const tracker = new Tracker();
    tracker.update([det(1, { x: 0, y: 0, w: 40, h: 40 })], 1);
    const tracks = tracker.finalize(0, { keepTentative: true });
    expect(tracks).toHaveLength(1);
    expect(tracks[0].keyframes.size).toBe(1);
    expect(tracks[0].start).toBe(1);
    expect(tracks[0].end).toBe(1);
  });

  it('closes a track after > maxCoast of coasting; a detection there opens a NEW track (no revival)', () => {
    const tracker = new Tracker();
    const box = { x: 100, y: 100, w: 50, h: 50 };
    // Confirmed track: hits at frames 0..2 (t up to 2/30).
    tracker.update([det(frame(0), { ...box })], frame(0));
    tracker.update([det(frame(1), { ...box })], frame(1));
    tracker.update([det(frame(2), { ...box })], frame(2));
    // Coasting: empty frames 3..18 → t−lastT = 16/30 ≈ 0.533 > 0.5 ⇒ closed.
    for (let f = 3; f <= 18; f++) tracker.update([], frame(f));
    // Detection at the closed track's location → must open a new track.
    tracker.update([det(frame(20), { ...box }), ], frame(20));
    tracker.update([det(frame(21), { ...box })], frame(21));

    const tracks = tracker.finalize(0);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].label).toBe('Face #1');
    expect(tracks[1].label).toBe('Face #2');
    expect(tracks[0].end).toBeCloseTo(frame(2), 6);
    expect(tracks[1].start).toBeCloseTo(frame(20), 6);
    expect(tracks[1].end).toBeCloseTo(frame(21), 6);
    // The gap is never bridged: closed track did not revive.
    expect(tracks[0].end).toBeLessThan(tracks[1].start);
    expect(tracks[0].id).not.toBe(tracks[1].id);
  });

  it('finalize is stable across repeated calls (ids/labels/spans unchanged)', () => {
    const tracker = new Tracker();
    tracker.update([det(0, { x: 0, y: 0, w: 40, h: 40 })], 0);
    tracker.update([det(1 / 30, { x: 1, y: 0, w: 40, h: 40 })], 1 / 30);
    const a = tracker.finalize(0.05);
    const b = tracker.finalize(0.05);
    expect(b).toEqual(a);
  });
});

describe('Tracker — gated greedy association (design §4.4)', () => {
  it('a detection below the IoU gate does not match — it opens a new track', () => {
    const tracker = new Tracker();
    const near = { x: 40, y: 0, w: 100, h: 100 }; // IoU ≈ 0.43 vs static track ≥ gate
    const far = { x: 60, y: 0, w: 100, h: 100 };  // IoU = 0.25 < gate 0.3

    tracker.update([det(0, { x: 0, y: 0, w: 100, h: 100 })], 0);
    tracker.update([det(frame(1), { x: 0, y: 0, w: 100, h: 100 })], frame(1));
    tracker.update([det(frame(2), { x: 0, y: 0, w: 100, h: 100 })], frame(2));

    tracker.update([det(frame(3), near)], frame(3));
    tracker.update([det(frame(4), near)], frame(4));
    let tracks = tracker.finalize(0);
    expect(tracks).toHaveLength(1); // matched — track continues
    expect(tracks[0].keyframes.size).toBe(5);

    const tracker2 = new Tracker();
    tracker2.update([det(0, { x: 0, y: 0, w: 100, h: 100 })], 0);
    tracker2.update([det(frame(1), { x: 0, y: 0, w: 100, h: 100 })], frame(1));
    tracker2.update([det(frame(2), { x: 0, y: 0, w: 100, h: 100 })], frame(2));
    tracker2.update([det(frame(3), far)], frame(3));
    tracker2.update([det(frame(4), far)], frame(4));
    tracks = tracker2.finalize(0);
    expect(tracks).toHaveLength(2); // gated out → new track
    expect(tracks[0].end).toBeCloseTo(frame(2), 6);
    expect(tracks[1].start).toBeCloseTo(frame(3), 6);
  });

  it('two crossing objects keep separate identities (velocity disambiguates)', () => {
    const tracker = new Tracker();
    // A moves +3 px/frame from x=50; B moves −3 px/frame from x=200. They
    // cross around frame 25 (both at x=125) — pure-IoU matching would swap,
    // predicted-box gating must not.
    for (let f = 0; f <= 40; f++) {
      const a = { x: 50 + 3 * f, y: 100, w: 20, h: 20 };
      const b = { x: 200 - 3 * f, y: 100, w: 20, h: 20 };
      tracker.update([det(frame(f), a), det(frame(f), b)], frame(f));
    }
    const tracks = tracker.finalize(0);
    expect(tracks).toHaveLength(2);
    expect(tracks[0].label).toBe('Face #1'); // creation order
    expect(tracks[1].label).toBe('Face #2');

    for (const tr of tracks) expect(tr.keyframes.size).toBe(41); // matched every frame
    // Track #1 must follow the A line (50 + 3f) — including through the crossing.
    for (const [t, box] of tracks[0].keyframes) {
      const f = Math.round(t * FPS);
      expect(box.x).toBeCloseTo(50 + 3 * f, 1);
    }
    // Track #2 must follow the B line (200 − 3f).
    for (const [t, box] of tracks[1].keyframes) {
      const f = Math.round(t * FPS);
      expect(box.x).toBeCloseTo(200 - 3 * f, 1);
    }
  });
});

describe('Tracker — per-class independence (REQ-006)', () => {
  it('face and plate detections at the same place/time form independent tracks', () => {
    const tracker = new Tracker();
    const box = { x: 10, y: 10, w: 60, h: 60 };
    tracker.update([det(0, { ...box }, 'face'), det(0, { ...box }, 'plate')], 0);
    tracker.update([det(frame(1), { ...box }, 'face'), det(frame(1), { ...box }, 'plate')], frame(1));

    const tracks = tracker.finalize(0);
    expect(tracks).toHaveLength(2);
    const face = tracks.find((tr) => tr.cls === 'face');
    const plate = tracks.find((tr) => tr.cls === 'plate');
    expect(face.label).toBe('Face #1');
    expect(plate.label).toBe('Plate #1');
    expect(face.keyframes.size).toBe(2);
    expect(plate.keyframes.size).toBe(2);
  });

  it('ignores manual-class entries and filters detections below minConf', () => {
    const tracker = new Tracker({ minConf: 0.5 });
    tracker.update([det(0, { x: 0, y: 0, w: 40, h: 40 }, 'face', 0.4)], 0);
    expect(tracker.finalize(0)).toHaveLength(0);
    tracker.update([det(0, { x: 0, y: 0, w: 40, h: 40 }, 'manual', 0.9)], 0);
    tracker.update([det(frame(1), { x: 0, y: 0, w: 40, h: 40 }, 'face', 0.6)], frame(1));
    tracker.update([det(frame(2), { x: 0, y: 0, w: 40, h: 40 }, 'face', 0.6)], frame(2));
    const tracks = tracker.finalize(0);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].cls).toBe('face');
  });
});

describe('AC-05 (PRIVACY-BLOCKING) — dense keyframes over dropout + padding', () => {
  // 101 frames of detection at every frame 100..200 EXCEPT a 3-frame dropout
  // at 150..152. Linear motion: x = 100 + f, y = 500 + 0.5·f, w = h = 40.
  const tracker = new Tracker();
  for (let f = 100; f <= 200; f++) {
    if (f >= 150 && f <= 152) {
      tracker.update([], frame(f));
    } else {
      tracker.update([det(frame(f), { x: 100 + f, y: 500 + 0.5 * f, w: 40, h: 40 })], frame(f));
    }
  }
  const PAD = 5 / FPS;
  const tracks = tracker.finalize(PAD);

  it('yields exactly one confirmed track with identity and materialized span', () => {
    expect(tracks).toHaveLength(1);
    const tr = tracks[0];
    expect(tr.label).toBe('Face #1');
    expect(tr.enabled).toBe(true);
    expect(tr.source).toBe('auto');
    // Span = [first − pad, last + pad].
    expect(tr.start).toBeCloseTo(frame(100) - PAD, 9);
    expect(tr.end).toBeCloseTo(frame(200) + PAD, 9);
  });

  it('dense keyframes cover EVERY sampled instant across the detected span', () => {
    const tr = tracks[0];
    const keys = [...tr.keyframes.keys()];
    // 98 detected keyframes + 3 interpolated dropout frames = 101.
    expect(keys).toHaveLength(101);

    // Contiguous on the 1/30 s grid: consecutive samples are one frame apart.
    const sorted = [...keys].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i] - sorted[i - 1]).toBeCloseTo(1 / FPS, 6);
    }

    // Privacy coverage: for every frame instant, a keyframe sits within half
    // a frame period — nearest-sample lookup can never fall back to nothing.
    for (let f = 100; f <= 200; f++) {
      const t = frame(f);
      const { dist } = nearestSample(sorted.map((k) => ({ t: k })), t);
      expect(dist).toBeLessThanOrEqual(1 / (2 * FPS) + 1e-9);
    }
  });

  it('preserves detected boxes exactly and interpolates the dropout linearly', () => {
    const tr = tracks[0];
    // Detected keyframes must be untouched by interpolation (exact copies).
    expect(tr.keyframes.get(frame(100)).x).toBe(200);
    expect(tr.keyframes.get(frame(149)).x).toBe(249);
    expect(tr.keyframes.get(frame(149)).y).toBe(574.5);
    expect(tr.keyframes.get(frame(200)).x).toBe(300);

    // Dropout frames 150/151/152 interpolate between f=149 and f=153 at
    // fractions 0.25/0.5/0.75 — which coincide with the true linear motion.
    const gap = nearestSample([...tr.keyframes.entries()].map(([t, box]) => ({ t, box })), frame(150));
    expect(gap.sample.box.x).toBeCloseTo(250, 6);
    expect(gap.sample.box.y).toBeCloseTo(575.0, 6);
    expect(gap.sample.box.w).toBeCloseTo(40, 6);
    expect(gap.sample.box.h).toBeCloseTo(40, 6);

    const f151 = nearestSample([...tr.keyframes.entries()].map(([t, box]) => ({ t, box })), frame(151));
    expect(f151.sample.box.x).toBeCloseTo(251, 6);
    expect(f151.sample.box.y).toBeCloseTo(575.5, 6);

    const f152 = nearestSample([...tr.keyframes.entries()].map(([t, box]) => ({ t, box })), frame(152));
    expect(f152.sample.box.x).toBeCloseTo(252, 6);
    expect(f152.sample.box.y).toBeCloseTo(576.0, 6);
  });

  it('interpolate() on the finalized (already dense) track is idempotent', () => {
    const dense = interpolate(tracks[0]);
    expect(dense).toHaveLength(101);
  });

  it('cancellation path: finalize with zero pad keeps spans at the detected extent', () => {
    const fresh = new Tracker();
    fresh.update([det(1, { x: 0, y: 0, w: 40, h: 40 })], 1);
    fresh.update([det(2, { x: 2, y: 0, w: 40, h: 40 })], 2);
    const [tr] = fresh.finalize(0);
    expect(tr.start).toBe(1);
    expect(tr.end).toBe(2);
  });
});

describe('beginManualTrack — manual region skeleton (REQ-015 seam)', () => {
  it('returns an enabled manual Track with a copied keyframe at t', () => {
    const tracker = new Tracker();
    const box = { x: 1, y: 2, w: 3, h: 4 };
    const tr = tracker.beginManualTrack(3.5, box);

    expect(tr.cls).toBe('manual');
    expect(tr.source).toBe('manual');
    expect(tr.label).toBe('Manual #1');
    expect(tr.enabled).toBe(true);
    expect(tr.start).toBe(3.5);
    expect(tr.end).toBe(3.5);
    expect(tr.keyframes.get(3.5)).toEqual(box);
    expect(TRACK_COLORS).toContain(tr.color);
    expect(typeof tr.id).toBe('number');

    // Caller-side mutation must not leak into the track.
    box.x = 999;
    expect(tr.keyframes.get(3.5).x).toBe(1);
  });

  it('assigns incrementing per-manual labels and unique ids', () => {
    const tracker = new Tracker();
    const a = tracker.beginManualTrack(0, { x: 0, y: 0, w: 10, h: 10 });
    const b = tracker.beginManualTrack(1, { x: 5, y: 5, w: 10, h: 10 });
    expect(a.label).toBe('Manual #1');
    expect(b.label).toBe('Manual #2');
    expect(a.id).not.toBe(b.id);
  });
});

describe('track style defaults (REQ-101: manual=solid, auto=pixelate)', () => {
  it('manual track skeleton defaults to the solid style', () => {
    const tracker = new Tracker();
    const tr = tracker.beginManualTrack(0, { x: 0, y: 0, w: 10, h: 10 });
    expect(tr.style).toBe('solid');
  });

  it('each manual skeleton carries its own solid default (no shared reference)', () => {
    const tracker = new Tracker();
    const a = tracker.beginManualTrack(0, { x: 0, y: 0, w: 10, h: 10 });
    const b = tracker.beginManualTrack(1, { x: 5, y: 5, w: 10, h: 10 });
    expect(a.style).toBe('solid');
    expect(b.style).toBe('solid');
  });

  it('finalized auto tracks default to the pixelate style', () => {
    const tracker = new Tracker();
    tracker.update([det(0, { x: 0, y: 0, w: 40, h: 40 })], 0);
    tracker.update([det(frame(1), { x: 1, y: 0, w: 40, h: 40 })], frame(1));

    const tracks = tracker.finalize(0);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].style).toBe('pixelate');
  });

  it('finalize stability holds with the style field present (idempotent output)', () => {
    const tracker = new Tracker();
    tracker.update([det(0, { x: 0, y: 0, w: 40, h: 40 })], 0);
    tracker.update([det(frame(1), { x: 1, y: 0, w: 40, h: 40 })], frame(1));
    const a = tracker.finalize(0.05);
    const b = tracker.finalize(0.05);
    expect(b).toEqual(a);
    expect(a[0].style).toBe('pixelate');
  });
});
