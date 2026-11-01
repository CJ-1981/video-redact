/**
 * tracker.js — REQ-006/007 (design.md §3, §4.4). @MX:ANCHOR
 *
 * Hand-rolled IoU + constant-velocity Kalman tracking (no maintained
 * ByteTrack npm port exists — plan §B). Per class: Kalman CV predict
 * (x, y, w, h, dx, dy), IoU-gated greedy association (gate 0.3), tentative
 * tracks confirmed after 2 hits (one-frame ghost suppression), coast ≤
 * maxCoast (default 0.5 s) then close; closed tracks never revive.
 *
 * `finalize()` interpolates gaps on a fixed 1/30 s reference grid and
 * attaches the result as the track's DENSE `keyframes` map — the AC-05
 * privacy invariant: combined with the consumer's nearest-sample clamp in
 * `redact.tracksAt`, every instant of the padded span resolves to a box.
 * Spans are materialized as [start − pad, end + pad]; the analyze loop
 * passes `padSeconds = 5 / fps` (REQ-007).
 *
 * Depends on: nothing (pure logic — fully unit-testable).
 */
import './types.js';

/**
 * Categorical 8-slot track palette (CSS hex, dark-UI tuned). Slots are
 * assigned per finalized track by stable id: TRACK_COLORS[(id − 1) % 8].
 */
export const TRACK_COLORS = Object.freeze([
  '#2dd4bf', // teal
  '#a78bfa', // violet
  '#fb7185', // coral
  '#a3e635', // lime
  '#fbbf24', // amber
  '#22d3ee', // cyan
  '#f472b6', // rose
  '#6ee7b7', // mint
]);

const IOU_GATE = 0.3; // association gate (design §4.4)
const CONFIRM_HITS = 2; // tentative → confirmed after this many total hits
const MAX_COAST_S = 0.5; // unmatched longer than this closes the track
const DENSE_STEP_S = 1 / 30; // reference grid for gap interpolation (AC-05)
const EPS = 1e-9; // float guard: "reached the next keyframe"

// ---------------------------------------------------------------------------
// KalmanCV — standard KF over state [x, y, w, h, dx, dy]
// ---------------------------------------------------------------------------

// Tuning constants (documented per plan §B "hand-rolled, tune as constants"):
// measurement noise 4 px² (σ ≈ 2 px detector jitter); process noise: 1 px²
// position random-walk + 25 (px/frame)² velocity diffusion — velocity adapts
// over ~3-5 frames without ringing on turns; initial covariance 10 px²
// position / 100 (px/frame)² velocity (deliberately loose so early frames
// dominate direction learning). Units are native display px, dt = 1 frame.
const KF_Q_POS = 1.0;
const KF_Q_VEL = 25.0;
const KF_R = 4.0;
const KF_P0_POS = 10.0;
const KF_P0_VEL = 100.0;

// F: x' = x + dx; y' = y + dy; w,h constant (no velocity channels).
const KF_F = [
  1, 0, 0, 0, 1, 0,
  0, 1, 0, 0, 0, 1,
  0, 0, 1, 0, 0, 0,
  0, 0, 0, 1, 0, 0,
  0, 0, 0, 0, 1, 0,
  0, 0, 0, 0, 0, 1,
];
// H: position is observed directly (identity-observable).
const KF_H = [
  1, 0, 0, 0, 0, 0,
  0, 1, 0, 0, 0, 0,
  0, 0, 1, 0, 0, 0,
  0, 0, 0, 1, 0, 0,
];

function transpose(F, n, m) {
  const T = new Array(n * m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) T[j * n + i] = F[i * m + j];
  return T;
}
function mul(A, B, n, m, p) {
  const C = new Array(n * p).fill(0);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < m; k++) {
      const a = A[i * m + k];
      if (a === 0) continue;
      for (let j = 0; j < p; j++) C[i * p + j] += a * B[k * p + j];
    }
  }
  return C;
}
function addMat(A, B) {
  const C = new Array(A.length);
  for (let i = 0; i < A.length; i++) C[i] = A[i] + B[i];
  return C;
}
function subMat(A, B) {
  const C = new Array(A.length);
  for (let i = 0; i < A.length; i++) C[i] = A[i] - B[i];
  return C;
}
function eye(n) {
  const I = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) I[i * n + i] = 1;
  return I;
}
function diag(values) {
  const n = values.length;
  const D = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) D[i * n + i] = values[i];
  return D;
}
/** Solve S·x = b for symmetric positive-definite S (n×n flat) via Cholesky. */
function cholSolve(S, b, n) {
  const L = new Array(n * n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = S[i * n + j];
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      L[i * n + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * n + j];
    }
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

const KF_FT = transpose(KF_F, 6, 6);
const KF_HT = transpose(KF_H, 4, 6);
const KF_Q = diag([KF_Q_POS, KF_Q_POS, KF_Q_POS, KF_Q_POS, KF_Q_VEL, KF_Q_VEL]);
const KF_R_MAT = diag([KF_R, KF_R, KF_R, KF_R]);

/**
 * Constant-velocity Kalman filter over (x, y, w, h) with velocities
 * (dx, dy) — the per-track motion model (design §4.4). `predict()` advances
 * state by dt = 1 frame period (the analyze loop drives it once per decoded
 * frame); `update()` corrects with a measured box.
 */
export class KalmanCV {
  /**
   * @param {import('./types.js').Box} box Initial measurement.
   */
  constructor(box) {
    this.s = [box.x, box.y, box.w, box.h, 0, 0];
    this.P = diag([
      KF_P0_POS, KF_P0_POS, KF_P0_POS, KF_P0_POS, KF_P0_VEL, KF_P0_VEL,
    ]);
  }

  /** @returns {import('./types.js').Box} The predicted/current position box. */
  box() {
    return { x: this.s[0], y: this.s[1], w: this.s[2], h: this.s[3] };
  }

  /** Advance state one frame period; returns the predicted box. */
  predict() {
    this.s = mul(KF_F, this.s, 6, 6, 1);
    this.P = addMat(mul(mul(KF_F, this.P, 6, 6, 6), KF_FT, 6, 6, 6), KF_Q);
    return this.box();
  }

  /** Correct state with a measured box (Joseph-form covariance update). */
  update(box) {
    const z = [box.x, box.y, box.w, box.h];
    const y = new Array(4);
    for (let i = 0; i < 4; i++) y[i] = z[i] - this.s[i]; // H·s picks first 4
    const PHt = mul(this.P, KF_HT, 6, 6, 4);
    const S = addMat(mul(KF_H, PHt, 4, 6, 4), KF_R_MAT); // 4×4, SPD
    // K = PHt·S⁻¹ (6×4). With X = S⁻¹·PHtᵀ = Kᵀ (4×6), column i of X is
    // K's row i — solve S·x = rhs column-wise (Cholesky, S is SPD).
    const K = new Array(24);
    for (let i = 0; i < 6; i++) {
      const rowK = cholSolve(S, [PHt[i * 4], PHt[i * 4 + 1], PHt[i * 4 + 2], PHt[i * 4 + 3]], 4);
      for (let j = 0; j < 4; j++) K[i * 4 + j] = rowK[j];
    }
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 4; j++) this.s[i] += K[i * 4 + j] * y[j];
    }
    // Joseph form keeps P positive-definite over long runs.
    const A = subMat(eye(6), mul(K, KF_H, 6, 4, 6));
    const At = transpose(A, 6, 6);
    const APAt = mul(mul(A, this.P, 6, 6, 6), At, 6, 6, 6);
    const KRKt = mul(mul(K, KF_R_MAT, 6, 4, 4), transpose(K, 6, 4), 6, 4, 6);
    this.P = addMat(APAt, KRKt);
  }
}

// ---------------------------------------------------------------------------
// Interpolation (AC-05 dense keyframes)
// ---------------------------------------------------------------------------

function lerpBox(a, b, f) {
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    w: a.w + (b.w - a.w) * f,
    h: a.h + (b.h - a.h) * f,
  };
}

/** Core of `interpolate` — dense samples from a seconds → Box map. */
function interpolateKeyframes(map) {
  const pts = [...map.entries()].sort((a, b) => a[0] - b[0]);
  const dense = [];
  for (let i = 0; i < pts.length; i++) {
    const [ta, ba] = pts[i];
    dense.push({ t: ta, box: { ...ba } });
    if (i + 1 >= pts.length) break;
    const [tb, bb] = pts[i + 1];
    const gap = tb - ta;
    for (let m = 1; ; m++) {
      const t = ta + m * DENSE_STEP_S;
      if (t >= tb - EPS) break; // next keyframe (exact) reached — never duplicated
      dense.push({ t, box: lerpBox(ba, bb, (t - ta) / gap) });
    }
  }
  return dense;
}

/**
 * Mean detection confidence of a detection list (v1.22.0 REQ-202). PURE.
 * Accepts Detection-like objects (`conf` field) or plain numbers; non-finite
 * values are ignored. No finite value (manual tracks never carry detections,
 * an empty list) → `undefined` — the UI omits the readout instead of showing
 * an invented 0.
 *
 * @param {Array<import('./types.js').Detection | number> | null | undefined} detections
 * @returns {number | undefined} Mean confidence in [0, 1], or undefined.
 */
export function avgConfidence(detections) {
  const list = Array.isArray(detections) ? detections : [];
  let sum = 0;
  let n = 0;
  for (const d of list) {
    const c = typeof d === 'number' ? d : d?.conf;
    if (Number.isFinite(c)) {
      sum += c;
      n += 1;
    }
  }
  return n > 0 ? sum / n : undefined;
}

/**
 * Intersection-over-union of two xywh boxes (display space).
 *
 * @param {import('./types.js').Box} a
 * @param {import('./types.js').Box} b
 * @returns {number} IoU in [0, 1] (0 for non-overlapping or degenerate boxes).
 */
export function iou(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const iw = x1 - x0;
  const ih = y1 - y0;
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Linear interpolation over gaps of a track's keyframe map (design §4.4).
 *
 * Sampling contract (AC-05): the returned array contains every original
 * keyframe (exact t, exact box copy) plus, strictly inside every gap,
 * samples on a fixed 1/30 s reference grid (DENSE_STEP_S) between the two
 * endpoints, linearly interpolated per channel. Output is sorted by t,
 * strictly increasing, and covers [first, last] with max spacing 1/30 s —
 * a consumer doing nearest-sample lookup (`redact.tracksAt`) resolves ANY
 * t in the span to a box within half a step (≈16.7 ms), so no frame inside
 * the redacted span is ever unredacted.
 *
 * Contract note: returns the dense `Array<{t, box}>` (orchestrator ruling
 * for M3); `Tracker.finalize()` converts it into the dense
 * `Map<seconds, Box>` attached as `track.keyframes`. Input is not mutated.
 *
 * @param {{keyframes: Map<number, import('./types.js').Box>}} track
 * @returns {Array<{t: number, box: import('./types.js').Box}>}
 */
export function interpolate(track) {
  return interpolateKeyframes(track.keyframes);
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

/**
 * Internal per-track record (not exported): `{ id, cls, state, hits, kf,
 * pred, firstT, lastT, confs, keyframes }` — sparse keyframes (matched
 * frames only); dense materialization happens in `finalize()`. `confs`
 * accumulates every feeding detection's confidence (v1.22.0 REQ-202) and
 * finalizes into the track's mean `conf`.
 */

/**
 * Multi-object tracker. One instance per analyze run; per-class association
 * (face / plate are tracked independently). Manual tracks bypass the tracker
 * entirely (direct keyframes — design §4.4); `beginManualTrack()` only
 * hands out a ready-made skeleton with a unique id/label/color.
 */
export class Tracker {
  /**
   * @param {{maxCoast?: number, minConf?: number}} [opts]
   *   maxCoast: seconds an unmatched track coasts before closing (0.5).
   *   minConf: detections below this confidence never enter (the detectors
   *   pre-threshold, so 0 = accept everything handed over).
   */
  constructor({ maxCoast = MAX_COAST_S, minConf = 0 } = {}) {
    this.maxCoast = maxCoast;
    this.minConf = minConf;
    this._byClass = new Map(); // cls → { live: TrackRec[] }
    this._order = []; // every TrackRec, creation order
    this._nextId = 1; // global stable id (auto assigned at finalize; manual at creation)
    this._nextManual = 1; // "Manual #N" counter
  }

  /** @returns {{live: object[]}} per-class bucket, created on demand */
  _classRec(cls) {
    let rec = this._byClass.get(cls);
    if (!rec) this._byClass.set(cls, (rec = { live: [] }));
    return rec;
  }

  /**
   * Associate one frame's detections with predicted track boxes; open
   * tentative tracks for unmatched detections; coast/close unmatched tracks.
   *
   * @param {import('./types.js').Detection[]} detections All classes, one instant.
   * @param {number} t Presentation time, seconds.
   * @returns {void}
   */
  update(detections, t) {
    const all = Array.isArray(detections) ? detections : [];
    const byCls = new Map();
    for (const d of all) {
      if (!d || !d.box || (d.cls !== 'face' && d.cls !== 'plate')) continue; // manual never enters
      if (typeof d.conf === 'number' && d.conf < this.minConf) continue;
      let arr = byCls.get(d.cls);
      if (!arr) byCls.set(d.cls, (arr = []));
      arr.push(d);
    }

    const classes = new Set([...byCls.keys(), ...this._byClass.keys()]);
    for (const cls of classes) {
      const crec = this._classRec(cls);
      const dets = byCls.get(cls) || [];
      const live = crec.live;

      // 1. Motion model: advance every live track one frame period (dt = 1).
      for (const tr of live) tr.pred = tr.kf.predict();

      // 2. IoU-gated greedy association, highest IoU first (design §4.4).
      const pairs = [];
      for (let ti = 0; ti < live.length; ti++) {
        for (let di = 0; di < dets.length; di++) {
          const g = iou(live[ti].pred, dets[di].box);
          if (g >= IOU_GATE) pairs.push({ ti, di, g });
        }
      }
      pairs.sort((a, b) => b.g - a.g);
      const matchedT = new Set();
      const matchedD = new Set();
      for (const p of pairs) {
        if (matchedT.has(p.ti) || matchedD.has(p.di)) continue;
        matchedT.add(p.ti);
        matchedD.add(p.di);
        const tr = live[p.ti];
        tr.kf.update(dets[p.di].box);
        tr.hits += 1;
        tr.lastT = t;
        tr.confs.push(dets[p.di].conf); // v1.22.0 REQ-202: per-track confidence sample
        tr.keyframes.set(t, { ...dets[p.di].box });
        if (tr.state === 'tentative' && tr.hits >= CONFIRM_HITS) tr.state = 'confirmed';
      }

      // 3. Unmatched tracks coast; closed once coasting exceeds maxCoast.
      for (let ti = 0; ti < live.length; ti++) {
        const tr = live[ti];
        if (matchedT.has(ti)) continue;
        if (t - tr.lastT > this.maxCoast) tr.state = 'closed';
      }
      crec.live = live.filter((tr) => tr.state !== 'closed'); // closed never revives

      // 4. Unmatched detections open tentative tracks (ghost-prone; dropped
      // by finalize unless a second hit confirms them).
      for (let di = 0; di < dets.length; di++) {
        if (matchedD.has(di)) continue;
        const d = dets[di];
        const tr = {
          id: null,
          cls,
          state: 'tentative',
          hits: 1,
          kf: new KalmanCV(d.box),
          pred: null,
          firstT: t,
          lastT: t,
          confs: [d.conf], // v1.22.0 REQ-202: per-track confidence samples
          keyframes: new Map([[t, { ...d.box }]]),
        };
        crec.live.push(tr);
        this._order.push(tr);
      }
    }
  }

  /**
   * Close the run: drop unconfirmed tentative tracks (unless `keepTentative`),
   * interpolate over gaps into a DENSE 1/30 s keyframe map, materialize each
   * span as [start − pad, end + pad] (analyze.js passes 5/fps per REQ-007;
   * start clamped at 0 — shrinking a span never leaks), and assign stable
   * ids/labels/colors ("Face #1", "Plate #4", …). Idempotent: calling twice
   * returns identical tracks.
   *
   * @param {number} [padSeconds] Span padding in seconds (caller computes 5/fps).
   * @param {{keepTentative?: boolean}} [opts] Keep 1-hit tracks (default false).
   * @returns {import('./types.js').Track[]} Creation-ordered, review-ready tracks.
   */
  finalize(padSeconds = 0, { keepTentative = false } = {}) {
    /** @type {import('./types.js').Track[]} */
    const out = [];
    let faceN = 0;
    let plateN = 0;
    for (const tr of this._order) {
      if (tr.cls === 'manual') continue; // manual tracks never enter the tracker
      if (tr.state === 'tentative' && !keepTentative) continue;
      if (tr.id === null) tr.id = this._nextId++;
      const n = tr.cls === 'face' ? ++faceN : ++plateN;
      const dense = interpolateKeyframes(tr.keyframes);
      const times = [...tr.keyframes.keys()].sort((a, b) => a - b);
      out.push({
        id: tr.id,
        cls: tr.cls,
        label: `${tr.cls === 'face' ? 'Face' : 'Plate'} #${n}`,
        color: TRACK_COLORS[(tr.id - 1) % TRACK_COLORS.length],
        keyframes: new Map(dense.map((s) => [s.t, s.box])),
        start: Math.max(0, times[0] - padSeconds),
        end: times[times.length - 1] + padSeconds,
        enabled: true,
        source: 'auto',
        style: 'pixelate', // REQ-101: auto-detected tracks default to pixelate
        // v1.22.0 REQ-202: mean confidence of every detection that fed the
        // track (row readout + the re-scan-span threshold basis). undefined
        // only when no finite conf ever arrived — the UI omits it then.
        conf: avgConfidence(tr.confs),
      });
    }
    return out;
  }

  /**
   * Build a manual region-track skeleton (REQ-015 seam — the editor draws
   * the box and later extends `keyframes`/`start`/`end`). Ids share the
   * tracker's global counter so manual and auto tracks never collide;
   * the "Manual #N" counter is its own sequence.
   *
   * @param {number} t Presentation time, seconds.
   * @param {import('./types.js').Box} box Box drawn on the current frame.
   * @returns {import('./types.js').Track}
   */
  beginManualTrack(t, box) {
    const id = this._nextId++;
    return {
      id,
      cls: 'manual',
      label: `Manual #${this._nextManual++}`,
      color: TRACK_COLORS[(id - 1) % TRACK_COLORS.length],
      keyframes: new Map([[t, { ...box }]]),
      start: t,
      end: t,
      enabled: true,
      source: 'manual',
      style: 'solid', // REQ-101: manual regions default to the solid style
    };
  }
}
