/**
 * Unit tests for src/detector.js (SPEC-VID-001 M2, design.md §4.1–4.3).
 *
 * Two layers:
 *  • Pure functions (letterboxGeometry / frameToTensor / unletterbox* /
 *    decodeYunetOutputs / nms / parsePlateRows / tileGrid / mergeTiles) —
 *    no ORT session needed; the YuNet fixture below PINS the decode formula
 *    documented in the detector.js module header.
 *  • createDetectors — smoke-tested against a mocked onnxruntime-web module
 *    (EP ladder ordering, wasmPaths pin, AC-17 webgpu→wasm fallback, feed
 *    shape, decode end-to-end through a fake session). Real sessions are
 *    exercised by the E2E milestone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ortState = vi.hoisted(() => ({
  failWebgpu: false,
  createCalls: [],   // executionProviders arrays, one per InferenceSession.create call
  lastFeed: undefined,
  released: [],      // 'face' | 'plate' per session.release()
}));

vi.mock('onnxruntime-web', () => {
  class Tensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }

  // Synthetic YuNet head outputs pinning the decode: for stride s with grid
  // G=640/s, anchor idx = r·G + c:
  //   cx = (c + d0)·s · cy = (r + d1)·s · w = exp(d2)·s · h = exp(d3)·s
  // All bbox distances default 0 ⇒ w = h = stride (exp(0) = 1, exact).
  // cls/obj are IN-GRAPH probabilities (real-model observed range [0,1]) —
  // the score is sqrt(clamp01(cls)·clamp01(obj)), NOT a second sigmoid.
  const buildYunetOutputs = () => {
    const N8 = 6400;
    const N16 = 1600;
    const N32 = 400;
    const cls8 = new Float32Array(N8).fill(0);
    const obj8 = new Float32Array(N8).fill(0);
    const bbox8 = new Float32Array(N8 * 4); // zeros
    cls8[30 * 80 + 10] = 0.9; // A: stride 8, (c=10, r=30), conf 0.9 — survives
    obj8[30 * 80 + 10] = 0.9;
    cls8[30 * 80 + 11] = 0.8; // B: (c=11, r=30), conf √(0.8·0.9) ≈ 0.8485 —
    obj8[30 * 80 + 11] = 0.9; // 60% IoU with A, lower conf → NMS'd
    bbox8[(30 * 80 + 11) * 4 + 0] = -0.75; // pulls B's center left onto A
    const cls16 = new Float32Array(N16).fill(0);
    const obj16 = new Float32Array(N16).fill(0);
    cls16[12 * 40 + 5] = 0.95; // C: stride 16, (c=5, r=12), conf 0.95 —
    obj16[12 * 40 + 5] = 0.95; // highest conf, survives
    const kps8 = new Float32Array(N8 * 10).fill(9); // landmarks must be ignored
    const T = (data, n, c) => ({ data, dims: [1, n, c] });
    return {
      cls_8: T(cls8, N8, 1),
      obj_8: T(obj8, N8, 1),
      bbox_8: T(bbox8, N8, 4),
      kps_8: T(kps8, N8, 10),
      cls_16: T(cls16, N16, 1),
      obj_16: T(obj16, N16, 1),
      bbox_16: T(new Float32Array(N16 * 4), N16, 4),
      cls_32: T(new Float32Array(N32), N32, 1),
      obj_32: T(new Float32Array(N32), N32, 1),
      bbox_32: T(new Float32Array(N32 * 4), N32, 4),
    };
  };

  // End-to-end plate head: rows [x1,y1,x2,y2,class_id,score] in LETTERBOXED
  // coords, dims [1, N, 6] (batched as the real export emits).
  const buildPlateOutput = () => ({
    output0: {
      data: new Float32Array([
        100, 240, 200, 280, 0, 0.9, // → display (200, 200, 200, 80) @ geom 1280×720
        0, 0, 10, 10, 0, 0.2,       // below 0.25 → filtered
        300, 300, 400, 360, 3, 0.3, // → display (600, 320, 200, 120)
      ]),
      dims: [1, 3, 6],
    },
  });

  return {
    Tensor,
    env: { wasm: { wasmPaths: '', numThreads: 0 } },
    InferenceSession: {
      create: vi.fn(async (bytes, options) => {
        ortState.createCalls.push([...options.executionProviders]);
        if (ortState.failWebgpu && options.executionProviders.includes('webgpu')) {
          throw new Error('WebGPU EP unavailable (simulated)');
        }
        const isFace = bytes.byteLength === 10; // ensureModel mock: yunet→10 B, plate→20 B
        return {
          inputNames: ['input'],
          outputNames: isFace ? ['cls_8'] : ['output0'],
          run: vi.fn(async (feeds) => {
            ortState.lastFeed = feeds;
            return isFace ? buildYunetOutputs() : buildPlateOutput();
          }),
          release: vi.fn(() => ortState.released.push(isFace ? 'face' : 'plate')),
        };
      }),
    },
  };
});

vi.mock('../../src/models.js', () => ({
  ensureModel: vi.fn(async (name, onProgress) => {
    onProgress?.(0.5);
    onProgress?.(1);
    return new ArrayBuffer(name === 'yunet' ? 10 : 20);
  }),
}));

const {
  letterboxGeometry,
  frameToTensor,
  letterbox,
  unletterbox,
  unletterboxCoord,
  unletterboxBox,
  decodeYunetOutputs,
  nms,
  parsePlateRows,
  tileGrid,
  mergeTiles,
  createDetectors,
  ORT_WASM_PATHS,
} = await import('../../src/detector.js');
const { env: ortEnv, Tensor } = await import('onnxruntime-web');

// geom for 1280×720 → ratio 0.5 (exact), padX 0, padY 140 — all fixture
// arithmetic below is dyadic-exact through this transform.
const GEOM_1280x720 = { ratio: 0.5, padX: 0, padY: 140 };

beforeEach(() => {
  ortState.failWebgpu = false;
  ortState.createCalls = [];
  ortState.lastFeed = undefined;
  ortState.released = [];
});

describe('letterboxGeometry (pure, §4.1)', () => {
  it('scales 1280×720 to a 640×360 band centered vertically', () => {
    expect(letterboxGeometry({ width: 1280, height: 720 })).toEqual({
      ratio: 0.5, padX: 0, padY: 140, scaledW: 640, scaledH: 360,
    });
  });

  it('scales portrait 720×1280 to a 360×640 column centered horizontally', () => {
    expect(letterboxGeometry({ width: 720, height: 1280 })).toEqual({
      ratio: 0.5, padX: 140, padY: 0, scaledW: 360, scaledH: 640,
    });
  });

  it('passes a square 640×640 through 1:1 with zero padding', () => {
    expect(letterboxGeometry({ width: 640, height: 640 })).toEqual({
      ratio: 1, padX: 0, padY: 0, scaledW: 640, scaledH: 640,
    });
  });

  it('upscales small frames (ratio > 1) and honors a custom target', () => {
    const g = letterboxGeometry({ width: 320, height: 180 }, 320);
    expect(g.ratio).toBe(1);
    expect(g.scaledW).toBe(320);
    expect(g.scaledH).toBe(180);
    expect(g.padY).toBeCloseTo(70, 10);
  });
});

describe('frameToTensor (RGBA → CHW float32, letterbox pads = 0)', () => {
  it('maps a 1×1 white frame onto every output pixel, alpha ignored', () => {
    const frame = { data: new Uint8ClampedArray([255, 255, 255, 0]), width: 1, height: 1 };
    const out = frameToTensor(frame, letterboxGeometry({ width: 1, height: 1 }, 2), 2);
    expect(out.length).toBe(3 * 2 * 2);
    // CHW: plane stride target², all three planes saturated at 1.0
    expect([...out]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('letterboxes a 2×1 frame into 4×4: content rows 1-2, pad rows 0/3 zero', () => {
    // p0 = red, p1 = blue; ratio = 2 → scaledW 4, scaledH 2, padY 1
    const frame = {
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
      width: 2,
      height: 1,
    };
    const out = frameToTensor(frame, letterboxGeometry({ width: 2, height: 1 }, 4), 4);
    const plane = (c, dy) => c * 16 + dy * 4;
    // pad rows stay zero in all planes
    for (const c of [0, 1, 2]) {
      expect([...out.slice(c * 16, c * 16 + 4)]).toEqual([0, 0, 0, 0]);
      expect([...out.slice(c * 16 + 12, c * 16 + 16)]).toEqual([0, 0, 0, 0]);
    }
    // R plane, content rows 1-2: red left half, half-blend, blue right half
    // (dx taps: p0, p0, mix, p1 — center-of-pixel mapping)
    expect([...out.slice(plane(0, 1), plane(0, 2))]).toEqual([1, 1, 0.5, 0]);
    expect([...out.slice(plane(0, 2), plane(0, 3))]).toEqual([1, 1, 0.5, 0]);
    // B plane mirrors; G stays zero (alpha ignored)
    expect([...out.slice(plane(2, 1), plane(2, 2))]).toEqual([0, 0, 0.5, 1]);
    expect([...out.slice(plane(1, 1), plane(1, 2))]).toEqual([0, 0, 0, 0]);
  });

  it('reuses a caller-provided buffer and validates sizes', () => {
    const frame = { data: new Uint8ClampedArray(4 * 4), width: 1, height: 1 };
    const geom = letterboxGeometry({ width: 1, height: 1 }, 2);
    const scratch = new Float32Array(12);
    expect(frameToTensor(frame, geom, 2, scratch)).toBe(scratch);
    expect(() => frameToTensor(frame, geom, 2, new Float32Array(11))).toThrow(TypeError);
    expect(() => frameToTensor({ data: new Uint8ClampedArray(3), width: 1, height: 1 }, geom, 2))
      .toThrow(TypeError);
  });

  it('zeroes the pad region of a REUSED buffer when the letterbox geometry changes', () => {
    // Regression (journey export hang): the analyze loop shares ONE scratch
    // across calls whose letterbox pads DIFFERENT regions — a full-frame call
    // pads rows, a dashcam tile call pads columns. frameToTensor writes only
    // the in-bounds cells, so without an explicit zero the second call's pad
    // region keeps the first call's pixels (rescaled ×255 on the YuNet path)
    // and the model fires ghost detections on the letterbox garbage.
    const target = 4;
    const scratch = new Float32Array(3 * target * target);
    // Call 1 — 4×2 frame: ratio 1, scaledH 2, padY 1 (content rows 1-2),
    // white pixels so every in-bounds cell reads 1.0.
    const white = {
      data: new Uint8ClampedArray(4 * 2 * 4).fill(255),
      width: 4,
      height: 2,
    };
    frameToTensor(white, letterboxGeometry({ width: 4, height: 2 }, target), target, scratch);
    // Call 2 — 2×4 frame: ratio 1, scaledW 2, padX 1 (content cols 1-2),
    // black pixels. The pad COLUMNS (dx 0 and 3) were call 1's CONTENT rows —
    // they must read 0, never the stale 1.0s.
    const black = { data: new Uint8ClampedArray(2 * 4 * 4), width: 2, height: 4 };
    expect(frameToTensor(black, letterboxGeometry({ width: 2, height: 4 }, target), target, scratch))
      .toBe(scratch);
    for (let c = 0; c < 3; c++) {
      for (let dy = 0; dy < target; dy++) {
        expect(scratch[c * target * target + dy * target + 0]).toBe(0);
        expect(scratch[c * target * target + dy * target + 3]).toBe(0);
      }
    }
  });

  it('letterbox() composes geometry + tensor', () => {
    const frame = {
      data: new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]),
      width: 2,
      height: 2,
    };
    const { ratio, padX, padY, input } = letterbox(frame, 2);
    expect({ ratio, padX, padY }).toEqual({ ratio: 1, padX: 0, padY: 0 });
    expect(input).toBeInstanceOf(Float32Array);
    expect(input.length).toBe(12);
    expect([...input]).toEqual([...frameToTensor(frame, letterboxGeometry({ width: 2, height: 2 }, 2), 2)]);
  });
});

describe('unletterboxCoord / unletterboxBox / unletterbox (model → display)', () => {
  it('inverts per axis: (v − pad)/ratio', () => {
    expect(unletterboxCoord(76, 'x', GEOM_1280x720)).toBe(152);
    expect(unletterboxCoord(236, 'y', GEOM_1280x720)).toBe(192);
  });

  it('inverts whole boxes (w, h divide by ratio; x, y shift by pad)', () => {
    expect(unletterboxBox({ x: 76, y: 236, w: 8, h: 8 }, GEOM_1280x720))
      .toEqual({ x: 152, y: 192, w: 16, h: 16 });
  });

  it('round-trips display → model → display as identity (exact at ratio 0.5)', () => {
    for (const [x, y] of [[0, 0], [640, 360], [1279, 719], [100, 50]]) {
      const mx = x * GEOM_1280x720.ratio + GEOM_1280x720.padX;
      const my = y * GEOM_1280x720.ratio + GEOM_1280x720.padY;
      expect(unletterboxCoord(mx, 'x', GEOM_1280x720)).toBe(x);
      expect(unletterboxCoord(my, 'y', GEOM_1280x720)).toBe(y);
    }
  });

  it('round-trips with a non-dyadic ratio to high precision', () => {
    const g = letterboxGeometry({ width: 1000, height: 333 });
    const box = { x: 37, y: 41, w: 90, h: 120 };
    const mx = box.x * g.ratio + g.padX;
    const my = box.y * g.ratio + g.padY;
    expect(unletterboxCoord(mx, 'x', g)).toBeCloseTo(box.x, 9);
    expect(unletterboxCoord(my, 'y', g)).toBeCloseTo(box.y, 9);
  });

  it('legacy unletterbox(): scalar → x axis, array → per-component pad', () => {
    expect(unletterbox(76, GEOM_1280x720)).toBe(152);
    expect(unletterbox([76, 236], GEOM_1280x720)).toEqual([152, 192]);
    expect(unletterbox([76, 236, 84, 244], GEOM_1280x720)).toEqual([152, 192, 168, 208]);
  });
});

describe('decodeYunetOutputs — fixture pins the decode formula (§4.2)', () => {
  // Decode implemented (see detector.js header, verified against OpenCV
  // FaceDetectorYNImpl::postProcess): score = sqrt(clamp01(cls)·clamp01(obj))
  // — cls/obj are in-graph probabilities; cx = (c + d0)·s; cy = (r + d1)·s;
  // w = exp(d2)·s; h = exp(d3)·s; anchors row-major on the stride grid;
  // boxes returned in DISPLAY space.
  it('decodes crafted stride-8/16 anchors to exact display boxes, NMS-suppresses the overlap', () => {
    const N8 = 6400, N16 = 1600, N32 = 400;
    const cls8 = new Float32Array(N8).fill(0);
    const obj8 = new Float32Array(N8).fill(0);
    const bbox8 = new Float32Array(N8 * 4);
    cls8[30 * 80 + 10] = 0.9; obj8[30 * 80 + 10] = 0.9;        // A: conf 0.9
    cls8[30 * 80 + 11] = 0.8; obj8[30 * 80 + 11] = 0.9;        // B: conf ≈ 0.8485
    bbox8[(30 * 80 + 11) * 4] = -0.75;                          // B center → x=82 model
    const cls16 = new Float32Array(N16).fill(0);
    const obj16 = new Float32Array(N16).fill(0);
    cls16[12 * 40 + 5] = 0.95; obj16[12 * 40 + 5] = 0.95;      // C: conf 0.95
    const out = {
      cls_8: { data: cls8, dims: [1, N8, 1] },
      obj_8: { data: obj8, dims: [1, N8, 1] },
      bbox_8: { data: bbox8, dims: [1, N8, 4] },
      cls_16: { data: cls16, dims: [1, N16, 1] },
      obj_16: { data: obj16, dims: [1, N16, 1] },
      bbox_16: { data: new Float32Array(N16 * 4), dims: [1, N16, 4] },
      cls_32: { data: new Float32Array(N32), dims: [1, N32, 1] },
      obj_32: { data: new Float32Array(N32), dims: [1, N32, 1] },
      bbox_32: { data: new Float32Array(N32 * 4), dims: [1, N32, 4] },
      kps_8: { data: new Float32Array(N8 * 10).fill(7), dims: [1, N8, 10] }, // ignored
    };

    const dets = decodeYunetOutputs(out, undefined, GEOM_1280x720);

    expect(dets).toHaveLength(2); // B suppressed (IoU 0.6 ≥ 0.3), background gated
    // Highest conf first: C at stride 16 — (cx,cy) = (80, 192), w=h=16 model
    expect(dets[0].box).toEqual({ x: 144, y: 88, w: 32, h: 32 });
    expect(dets[0].conf).toBeCloseTo(0.95, 6);
    // A at stride 8 — (cx,cy) = (80, 240), w=h=8 model
    expect(dets[1].box).toEqual({ x: 152, y: 192, w: 16, h: 16 });
    expect(dets[1].conf).toBeCloseTo(0.9, 6);
  });

  it('accepts [1, 4, N] planar bbox layout (dims-driven) with identical results', () => {
    const N8 = 6400, N16 = 1600, N32 = 400;
    const cls8 = new Float32Array(N8).fill(0);
    const obj8 = new Float32Array(N8).fill(0);
    cls8[30 * 80 + 10] = 0.9; obj8[30 * 80 + 10] = 0.9;
    // Planar: plane k at k·N + idx
    const bbox8 = new Float32Array(4 * N8);
    bbox8[0 * N8 + (30 * 80 + 11)] = -0.75;
    const cls16 = new Float32Array(N16).fill(0);
    const obj16 = new Float32Array(N16).fill(0);
    cls16[12 * 40 + 5] = 0.95; obj16[12 * 40 + 5] = 0.95;
    const dets = decodeYunetOutputs(
      {
        cls_8: { data: cls8, dims: [1, N8, 1] },
        obj_8: { data: obj8, dims: [1, N8, 1] },
        bbox_8: { data: bbox8, dims: [1, 4, N8] },
        cls_16: { data: cls16, dims: [1, N16, 1] },
        obj_16: { data: obj16, dims: [1, N16, 1] },
        bbox_16: { data: new Float32Array(4 * N16), dims: [1, 4, N16] },
        cls_32: { data: new Float32Array(N32).fill(0), dims: [1, N32, 1] },
        obj_32: { data: new Float32Array(N32).fill(0), dims: [1, N32, 1] },
        bbox_32: { data: new Float32Array(4 * N32), dims: [1, 4, N32] },
      },
      undefined,
      GEOM_1280x720,
    );
    expect(dets).toHaveLength(2);
    expect(dets[0].box).toEqual({ x: 144, y: 88, w: 32, h: 32 });
    expect(dets[1].box).toEqual({ x: 152, y: 192, w: 16, h: 16 });
  });

  it('accepts bare Float32Arrays when a shapes map is provided', () => {
    const N8 = 6400, N16 = 1600, N32 = 400;
    const cls8 = new Float32Array(N8).fill(0);
    const obj8 = new Float32Array(N8).fill(0);
    cls8[30 * 80 + 10] = 0.9; obj8[30 * 80 + 10] = 0.9;
    const dets = decodeYunetOutputs(
      {
        cls_8: cls8,
        obj_8: obj8,
        bbox_8: new Float32Array(N8 * 4),
        cls_16: new Float32Array(N16).fill(0),
        obj_16: new Float32Array(N16).fill(0),
        bbox_16: new Float32Array(N16 * 4),
        cls_32: new Float32Array(N32).fill(0),
        obj_32: new Float32Array(N32).fill(0),
        bbox_32: new Float32Array(N32 * 4),
      },
      {
        cls_8: [1, N8, 1], obj_8: [1, N8, 1], bbox_8: [1, N8, 4],
        cls_16: [1, N16, 1], obj_16: [1, N16, 1], bbox_16: [1, N16, 4],
        cls_32: [1, N32, 1], obj_32: [1, N32, 1], bbox_32: [1, N32, 4],
      },
      GEOM_1280x720,
    );
    expect(dets).toHaveLength(1);
    expect(dets[0].box).toEqual({ x: 152, y: 192, w: 16, h: 16 });
  });

  it('honors confThreshold and throws on missing outputs', () => {
    const N8 = 6400, N16 = 1600, N32 = 400;
    const cls8 = new Float32Array(N8).fill(0);
    const obj8 = new Float32Array(N8).fill(0);
    cls8[30 * 80 + 10] = 0.9; obj8[30 * 80 + 10] = 0.9; // conf 0.9 — kept at 0.6
    cls8[30 * 80 + 12] = 0.5; obj8[30 * 80 + 12] = 0.5; // conf 0.5 — only kept at threshold 0.5
    const out = {
      cls_8: { data: cls8, dims: [1, N8, 1] },
      obj_8: { data: obj8, dims: [1, N8, 1] },
      bbox_8: { data: new Float32Array(N8 * 4), dims: [1, N8, 4] },
      cls_16: { data: new Float32Array(N16), dims: [1, N16, 1] },
      obj_16: { data: new Float32Array(N16), dims: [1, N16, 1] },
      bbox_16: { data: new Float32Array(N16 * 4), dims: [1, N16, 4] },
      cls_32: { data: new Float32Array(N32), dims: [1, N32, 1] },
      obj_32: { data: new Float32Array(N32), dims: [1, N32, 1] },
      bbox_32: { data: new Float32Array(N32 * 4), dims: [1, N32, 4] },
    };
    expect(decodeYunetOutputs(out, undefined, GEOM_1280x720)).toHaveLength(1);
    expect(decodeYunetOutputs(out, undefined, GEOM_1280x720, { confThreshold: 0.5 })).toHaveLength(2);
    const { obj_8, ...withoutObj } = out;
    expect(() => decodeYunetOutputs(withoutObj, undefined, GEOM_1280x720)).toThrow(/obj_8/);
  });
});

describe('nms (greedy by score)', () => {
  it('keeps highest-conf boxes, suppresses overlaps, preserves desc order', () => {
    const dets = [
      { box: { x: 0, y: 0, w: 10, h: 10 }, conf: 0.9 },   // suppressed by D (IoU 0.82)
      { box: { x: 1, y: 1, w: 10, h: 10 }, conf: 0.8 },   // suppressed by A/D (IoU 0.68)
      { box: { x: 50, y: 50, w: 10, h: 10 }, conf: 0.7 }, // disjoint — kept
      { box: { x: 0.5, y: 0.5, w: 10, h: 10 }, conf: 0.95 },
    ];
    const kept = nms(dets);
    expect(kept.map((d) => d.conf)).toEqual([0.95, 0.7]);
  });

  it('suppresses at IoU == threshold and keeps just-below overlaps', () => {
    const a = { box: { x: 0, y: 0, w: 10, h: 10 }, conf: 0.9 };
    const b = { box: { x: 5, y: 0, w: 10, h: 10 }, conf: 0.8 }; // IoU = 50/150 ≈ 0.333
    expect(nms([a, b], 0.3)).toHaveLength(1);
    expect(nms([a, b], 0.34)).toHaveLength(2);
  });

  it('breaks conf ties by input order (stable)', () => {
    const a = { box: { x: 0, y: 0, w: 10, h: 10 }, conf: 0.9, tag: 'a' };
    const b = { box: { x: 1, y: 0, w: 10, h: 10 }, conf: 0.9, tag: 'b' };
    expect(nms([a, b])).toEqual([a]);
  });
});

describe('parsePlateRows (§4.3 — letterboxed rows, graph NMS, conf 0.25)', () => {
  it('filters, un-letterboxes, converts to display-space Boxes', () => {
    const rows = new Float32Array([
      100, 240, 200, 280, 0, 0.9,  // → (200, 200, 200, 80)
      0, 0, 10, 10, 0, 0.2,        // filtered (< 0.25)
      300, 300, 400, 360, 3, 0.3,  // → (600, 320, 200, 120)
    ]);
    const dets = parsePlateRows(rows, [3, 6], GEOM_1280x720);
    expect(dets).toHaveLength(2);
    expect(dets[0].box).toEqual({ x: 200, y: 200, w: 200, h: 80 });
    expect(dets[0].cls).toBe('plate');
    expect(dets[0].classId).toBe(0);
    expect(dets[0].conf).toBeCloseTo(0.9, 6); // conf is float32 round-tripped
    expect(dets[1].box).toEqual({ x: 600, y: 320, w: 200, h: 120 });
    expect(dets[1].classId).toBe(3);
  });

  it('applies NO JS-side NMS — overlapping rows all survive', () => {
    const rows = new Float32Array([
      100, 240, 200, 280, 0, 0.9,
      110, 250, 190, 270, 0, 0.5, // ~90% IoU with row 0 — graph already NMS'd
    ]);
    expect(parsePlateRows(rows, [2, 6], GEOM_1280x720)).toHaveLength(2);
  });

  it('honors a custom confThreshold', () => {
    const rows = new Float32Array([0, 0, 10, 10, 0, 0.3]);
    expect(parsePlateRows(rows, [1, 6], GEOM_1280x720, { confThreshold: 0.5 })).toHaveLength(0);
    expect(parsePlateRows(rows, [1, 6], GEOM_1280x720)).toHaveLength(1);
  });
});

describe('tileGrid (§4.1 dashcam tiling)', () => {
  it('splits 4K 16:9 into 4 full-height tiles per the k formula', () => {
    const tiles = tileGrid({ width: 3840, height: 2160 });
    expect(tiles).toHaveLength(4);
    expect(tiles.map((t) => t.x)).toEqual([0, 960, 1920, 2880]);
    expect(tiles.map((t) => t.w)).toEqual([960, 960, 960, 960]);
    expect(tiles.every((t) => t.y === 0 && t.h === 2160)).toBe(true);
    expect(tiles.reduce((s, t) => s + t.w, 0)).toBe(3840);
    // per-tile letterbox: 960×2160 → ratio 640/2160, centered horizontally
    expect(tiles[0].transform.ratio).toBeCloseTo(640 / 2160, 12);
    expect(tiles[0].transform.padX).toBeCloseTo((640 - 960 * (640 / 2160)) / 2, 9);
    expect(tiles[0].transform.padY).toBe(0);
  });

  it('keeps a square 640×640 as a single unpadded tile', () => {
    const tiles = tileGrid({ width: 640, height: 640 });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ x: 0, y: 0, w: 640, h: 640 });
    expect(tiles[0].transform).toMatchObject({ ratio: 1, padX: 0, padY: 0 });
  });

  it('uses k=4 for 720p 16:9 and clamps k at 4 for wider frames', () => {
    const hd = tileGrid({ width: 1280, height: 720 });
    expect(hd).toHaveLength(4);
    expect(hd.reduce((s, t) => s + t.w, 0)).toBe(1280);
    const wide = tileGrid({ width: 7680, height: 4320 });
    expect(wide).toHaveLength(4);
    expect(wide.reduce((s, t) => s + t.w, 0)).toBe(7680);
  });

  it('handles odd widths (last tile absorbs the remainder)', () => {
    const tiles = tileGrid({ width: 1000, height: 1000 });
    expect(tiles).toHaveLength(2);
    expect(tiles.map((t) => t.w)).toEqual([500, 500]);
    expect(tiles[1].x).toBe(500);
  });
});

describe('tileGrid — portrait rows (REQ-107)', () => {
  it('splits 540×960 into 3 stacked full-width rows per the r formula', () => {
    // r = clamp(ceil(h / (target·(w/h))), 1, 4) = ceil(960/(640·0.5625)) = ceil(2.67) = 3
    const tiles = tileGrid({ width: 540, height: 960 });
    expect(tiles).toHaveLength(3);
    expect(tiles.map((t) => t.y)).toEqual([0, 320, 640]);
    expect(tiles.map((t) => t.h)).toEqual([320, 320, 320]);
    expect(tiles.every((t) => t.x === 0 && t.w === 540)).toBe(true);
    expect(tiles.reduce((s, t) => s + t.h, 0)).toBe(960);
    // Per-row letterbox: 540×320 is width-limited — ratio 640/540, pad on Y.
    expect(tiles[0].transform.ratio).toBeCloseTo(640 / 540, 12);
    expect(tiles[0].transform.padX).toBe(0);
    expect(tiles[0].transform.padY).toBeCloseTo((640 - 320 * (640 / 540)) / 2, 9);
    // Equal rows share the identical transform (each computed from its own rect).
    for (const t of tiles.slice(1)) expect(t.transform).toEqual(tiles[0].transform);
  });

  it('keeps landscape 3840×2160 on the horizontal branch (full-height columns)', () => {
    // REQ-107 changes portrait ONLY — landscape rects stay bit-identical.
    const tiles = tileGrid({ width: 3840, height: 2160 });
    expect(tiles.every((t) => t.y === 0 && t.h === 2160)).toBe(true);
    expect(tiles.reduce((s, t) => s + t.w, 0)).toBe(3840);
  });

  it('routes a 1:1 square through the landscape branch (aspect ≥ 1)', () => {
    const tiles = tileGrid({ width: 1000, height: 1000 });
    expect(tiles).toHaveLength(2);
    expect(tiles.every((t) => t.y === 0 && t.h === 1000)).toBe(true); // columns, not rows
    expect(tiles.map((t) => t.x)).toEqual([0, 500]);
  });

  it('clamps r at 4 for extreme tall 9:21 frames', () => {
    // ceil(2520/(640·(1080/2520))) = ceil(9.19) → 4 (clamp), 2520/4 = 630 exact
    const tiles = tileGrid({ width: 1080, height: 2520 });
    expect(tiles).toHaveLength(4);
    expect(tiles.map((t) => t.y)).toEqual([0, 630, 1260, 1890]);
    expect(tiles.every((t) => t.x === 0 && t.w === 1080 && t.h === 630)).toBe(true);
    expect(tiles.reduce((s, t) => s + t.h, 0)).toBe(2520);
  });

  it('last row absorbs the rounding remainder (odd portrait heights)', () => {
    // r = ceil(1000/(640·0.54)) = ceil(2.89) = 3; baseH = ceil(1000/3) = 334
    const tiles = tileGrid({ width: 540, height: 1000 });
    expect(tiles).toHaveLength(3);
    expect(tiles.map((t) => t.y)).toEqual([0, 334, 668]);
    expect(tiles.map((t) => t.h)).toEqual([334, 334, 332]);
    expect(tiles.reduce((s, t) => s + t.h, 0)).toBe(1000);
  });

  it('mergeTiles round-trips a row tile by its y origin (no axis special case)', () => {
    const tiles = tileGrid({ width: 540, height: 960 });
    const merged = mergeTiles(
      [{ box: { x: 10, y: 20, w: 30, h: 40 }, conf: 0.9, cls: 'face', tileIndex: 1 }],
      tiles,
    );
    // Tile 1 starts at y=320: tile-local (10,20) → frame (10,340).
    expect(merged[0].box).toEqual({ x: 10, y: 340, w: 30, h: 40 });
    expect(merged[0].pass).toBe('tile');
  });
});

describe('mergeTiles (tile-local → full-frame, one coordinate space)', () => {
  const tiles = tileGrid({ width: 3840, height: 2160 });

  it('offsets boxes by the tile origin and tags pass tile', () => {
    const merged = mergeTiles(
      [
        { box: { x: 10, y: 20, w: 30, h: 40 }, conf: 0.9, cls: 'face', tileIndex: 2 },
        { box: { x: 5, y: 6, w: 7, h: 8 }, conf: 0.8, cls: 'face' }, // no index ⇒ tile 0
      ],
      tiles,
    );
    expect(merged[0].box).toEqual({ x: 1930, y: 20, w: 30, h: 40 });
    expect(merged[0].pass).toBe('tile');
    expect(merged[1].box).toEqual({ x: 5, y: 6, w: 7, h: 8 });
    expect(merged[0].cls).toBe('face');
    expect(merged[0].conf).toBe(0.9);
  });

  it('leaves an explicit pass tag untouched', () => {
    const merged = mergeTiles(
      [{ box: { x: 0, y: 0, w: 1, h: 1 }, conf: 1, pass: 'full', tileIndex: 1 }],
      tiles,
    );
    expect(merged[0].pass).toBe('full');
    expect(merged[0].box.x).toBe(960);
  });
});

describe('createDetectors (mocked ORT — EP ladder, env pin, AC-17 fallback)', () => {
  it('pins wasmPaths to the jsDelivr 1.31.1 dist and numThreads=1', async () => {
    await createDetectors();
    expect(ortEnv.wasm.wasmPaths).toBe(ORT_WASM_PATHS);
    expect(ORT_WASM_PATHS).toBe('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/');
    expect(ortEnv.wasm.numThreads).toBe(1);
  });

  it('walks the default EP ladder webgpu → wasm (AC-17 retry on failure)', async () => {
    ortState.failWebgpu = true;
    const detectors = await createDetectors(); // must NOT reject
    expect(ortState.createCalls).toEqual([
      ['webgpu', 'wasm'], // face: webgpu fails (simulated)…
      ['wasm'],           // …ladder retry succeeds
      ['webgpu', 'wasm'], // plate: same walk
      ['wasm'],
    ]);
    detectors.close();
  });

  it('honors an epPolicy override (wasm forced, no webgpu attempt)', async () => {
    ortState.failWebgpu = true; // would throw the ladder into retries — irrelevant here
    const detectors = await createDetectors({ epPolicy: ['wasm'] });
    expect(ortState.createCalls).toEqual([['wasm'], ['wasm']]);
    detectors.close();
  });

  it('reports effectiveEp "wasm" after the webgpu→wasm fallback (AC-17 notice)', async () => {
    ortState.failWebgpu = true;
    const detectors = await createDetectors();
    expect(detectors.effectiveEp).toBe('wasm');
    detectors.close();
  });

  it('reports effectiveEp "webgpu" when the first ladder rung succeeds', async () => {
    ortState.failWebgpu = false;
    const detectors = await createDetectors();
    expect(detectors.effectiveEp).toBe('webgpu');
    detectors.close();
  });

  it('reports the forced override EP as effectiveEp', async () => {
    ortState.failWebgpu = true;
    const detectors = await createDetectors({ epPolicy: ['wasm'] });
    expect(detectors.effectiveEp).toBe('wasm');
    detectors.close();
  });

  it('rejects when every EP in the ladder fails', async () => {
    ortState.failWebgpu = true;
    await expect(createDetectors({ epPolicy: ['webgpu'] })).rejects.toThrow(/WebGPU/);
  });

  it('detectFace: feeds [1,3,640,640] CHW and returns display-space face Detections', async () => {
    const detectors = await createDetectors();
    const frame = {
      data: new Uint8ClampedArray(1280 * 720 * 4),
      width: 1280,
      height: 720,
    };
    const dets = await detectors.detectFace(frame);
    const feedTensor = ortState.lastFeed.input;
    expect(feedTensor).toBeInstanceOf(Tensor);
    expect(feedTensor.dims).toEqual([1, 3, 640, 640]);
    expect(feedTensor.data).toBeInstanceOf(Float32Array);
    expect(feedTensor.data.length).toBe(3 * 640 * 640);
    expect(dets).toHaveLength(2);
    expect(dets[0]).toMatchObject({ box: { x: 144, y: 88, w: 32, h: 32 }, cls: 'face', pass: 'full' });
    expect(dets[0].conf).toBeCloseTo(0.95, 6);
    expect(dets[1]).toMatchObject({ box: { x: 152, y: 192, w: 16, h: 16 }, cls: 'face', pass: 'full' });
  });

  it('detectPlate: parses end-to-end rows [1,N,6] into display-space plate Detections', async () => {
    const detectors = await createDetectors();
    const frame = { data: new Uint8ClampedArray(1280 * 720 * 4), width: 1280, height: 720 };
    const dets = await detectors.detectPlate(frame);
    expect(dets).toHaveLength(2); // 0.2-score row filtered, NO extra NMS
    expect(dets[0].box).toEqual({ x: 200, y: 200, w: 200, h: 80 });
    expect(dets[0]).toMatchObject({ classId: 0, cls: 'plate', pass: 'full' });
    expect(dets[0].conf).toBeCloseTo(0.9, 6);
    expect(dets[1].box).toEqual({ x: 600, y: 320, w: 200, h: 120 });
    expect(dets[1].classId).toBe(3);
  });

  it('forwards download progress per model', async () => {
    const onModelProgress = vi.fn();
    await createDetectors({ onModelProgress });
    const calls = onModelProgress.mock.calls;
    expect(calls).toContainEqual(['yunet', 1]);
    expect(calls).toContainEqual(['plate-yolov9t', 1]);
    for (const [, fraction] of calls) expect(fraction).toBeLessThanOrEqual(1);
  });

  it('close() releases both sessions', async () => {
    const detectors = await createDetectors();
    expect(ortState.released).toEqual([]);
    detectors.close();
    expect(ortState.released.sort()).toEqual(['face', 'plate']);
  });
});

describe('createDetectors — per-call confThreshold overrides (REQ-113)', () => {
  const frame = () => ({ data: new Uint8ClampedArray(1280 * 720 * 4), width: 1280, height: 720 });
  // Face fixture confs: 0.95 (stride 16) and 0.9 (stride 8); plate rows: 0.9 / 0.2 / 0.3.

  it('detectFace honors opts.confThreshold; the default stays 0.6', async () => {
    const detectors = await createDetectors();
    expect(await detectors.detectFace(frame())).toHaveLength(2); // pre-1.5.0 behavior
    expect(await detectors.detectFace(frame(), {})).toHaveLength(2); // empty opts → default
    expect(await detectors.detectFace(frame(), { confThreshold: 0.92 })).toHaveLength(1);
    expect(await detectors.detectFace(frame(), { confThreshold: 0.99 })).toHaveLength(0);
    detectors.close();
  });

  it('detectPlate honors opts.confThreshold; the default stays 0.25', async () => {
    const detectors = await createDetectors();
    expect(await detectors.detectPlate(frame())).toHaveLength(2); // pre-1.5.0 behavior
    expect(await detectors.detectPlate(frame(), { confThreshold: 0.5 })).toHaveLength(1);
    expect(await detectors.detectPlate(frame(), { confThreshold: 0.15 })).toHaveLength(3); // 0.2 row back
    expect(await detectors.detectPlate(frame(), { confThreshold: 0.95 })).toHaveLength(0);
    detectors.close();
  });
});

describe('createDetectors — raw accessors (REQ-114: one inference, no decode)', () => {
  const frame = () => ({ data: new Uint8ClampedArray(1280 * 720 * 4), width: 1280, height: 720 });

  it('detectFaceRaw returns the undecoded head tensors + the letterbox geom', async () => {
    const detectors = await createDetectors();
    const { outputs, geom } = await detectors.detectFaceRaw(frame());
    expect(outputs.cls_8).toBeDefined();
    expect(outputs.obj_16).toBeDefined();
    expect(outputs.bbox_32).toBeDefined();
    expect(geom).toEqual(letterboxGeometry({ width: 1280, height: 720 }, 640));
    // Decoding the raw outputs matches the per-call override path exactly.
    const dets = decodeYunetOutputs(outputs, undefined, geom, { confThreshold: 0.92 });
    expect(dets).toHaveLength(1);
    expect(dets[0].conf).toBeCloseTo(0.95, 6);
    detectors.close();
  });

  it('detectFaceRaw echoes a caller-provided geom unchanged', async () => {
    const detectors = await createDetectors();
    const custom = { ratio: 0.5, padX: 3, padY: 7 };
    const { geom } = await detectors.detectFaceRaw(frame(), custom);
    expect(geom).toBe(custom);
    detectors.close();
  });

  it('detectPlateRaw returns {rows, dims, geom}; decode matches the override path', async () => {
    const detectors = await createDetectors();
    const { rows, dims, geom } = await detectors.detectPlateRaw(frame());
    expect(dims).toEqual([3, 6]); // [n, 6] rows sliced off the [1, 3, 6] tensor
    expect(rows).toHaveLength(18);
    expect(geom).toEqual(letterboxGeometry({ width: 1280, height: 720 }, 640));
    const dets = parsePlateRows(rows, dims, geom, { confThreshold: 0.15 });
    expect(dets).toHaveLength(3);
    detectors.close();
  });

  it('five compare levels reuse ONE inference: decode the same raw outputs per level', async () => {
    const detectors = await createDetectors();
    const { outputs, geom } = await detectors.detectFaceRaw(frame());
    const perLevel = [0.15, 0.3, 0.45, 0.6, 0.75].map(
      (level) => decodeYunetOutputs(outputs, undefined, geom, { confThreshold: level }).length,
    );
    expect(perLevel).toEqual([2, 2, 2, 2, 2]); // fixture confs 0.95 + 0.9 clear every level
    expect(ortState.lastFeed).toBeDefined(); // sanity: the session actually ran
    detectors.close();
  });
});

describe('parsePlateRows — real end2end layouts (v1.10.1 plate-fix regression pin)', () => {
  // Probe-verified layout (tools/debug-plate.mjs, 2026-10-30): the real
  // open-image-models export emits [N,7] rows
  // [batch_idx, x1, y1, x2, y2, class_id, score] in 640-letterbox space.
  const geom = { ratio: 0.333, padX: 140, padY: 0 }; // 1080x1920 portrait frame

  it('[N,7] layout: parses score from the LAST column and box from cols 1-4 (v1.0-v1.9 read class_id as score — always filtered)', () => {
    // Row matching the probed real detection: plate at model-space
    // [252, 296, 362, 326], conf 0.89 (user's IMG_5019.MOV frame-6s).
    const rows = [
      0, 252.21, 296.13, 361.65, 326.18, 0, 0.89, // over threshold
      0, 160.73, 127.68, 171.12, 136.62, 0, 0.06, // under threshold — filtered
      0, 10, 20, 30, 40, 0, 0.5, // over threshold
    ];
    const dets = parsePlateRows(rows, [3, 7], geom, { confThreshold: 0.25 });
    expect(dets).toHaveLength(2);
    // unletterbox: (v - pad) / ratio
    expect(dets[0].conf).toBeCloseTo(0.89, 5);
    expect(dets[0].box.x).toBeCloseTo((252.21 - 140) / 0.333, 1);
    expect(dets[0].box.y).toBeCloseTo(296.13 / 0.333, 1);
    expect(dets[0].box.w).toBeCloseTo((361.65 - 252.21) / 0.333, 1);
    expect(dets[0].cls).toBe('plate');
    expect(dets[1].conf).toBeCloseTo(0.5, 5);
  });

  it('[N,6] legacy layout (no batch column) still parses', () => {
    const rows = [
      100, 200, 150, 250, 0, 0.9,
      0, 0, 10, 10, 0, 0.1,
    ];
    const dets = parsePlateRows(rows, [2, 6], geom, { confThreshold: 0.25 });
    expect(dets).toHaveLength(1);
    expect(dets[0].conf).toBeCloseTo(0.9, 5);
    expect(dets[0].box.x).toBeCloseTo((100 - 140) / 0.333, 1);
  });

  it('NaN score never passes the threshold', () => {
    const rows = [0, 10, 10, 50, 50, 0, Number.NaN];
    const dets = parsePlateRows(rows, [1, 7], geom, {});
    expect(dets).toHaveLength(0);
  });
});
