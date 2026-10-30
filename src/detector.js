/**
 * detector.js — REQ-005/008/010 (design.md §3, §4.1–4.3).
 *
 * ORT session management, letterbox preprocessing, YuNet decode + NMS, plate
 * end-to-end row parsing, tiled dashcam pass, and execution-provider
 * fallback. Pure functions are ORT-free and unit-tested; createDetectors()
 * lazily `import('onnxruntime-web')` so node/vitest only ever sees a mock
 * (tests/unit/detector.test.js); the real sessions are exercised by E2E.
 *
 * ─── Research-verified model facts (transcribed verbatim; fixture-test in M2) ───
 *
 * YuNet (`face_detection_yunet_2023mar.onnx`, via models.ensureModel('yunet')):
 *   • Input: [1, 3, 640, 640] float32, BGR in the RAW 0-255 range, letterboxed
 *     (design §4.1). OpenCV FaceDetectorYN feeds dnn::blobFromImage(padded)
 *     with ALL DEFAULTS (scale 1.0, swapRB=false) — verified 2026-10-28
 *     (face_detect.cpp) and empirically (tools/debug-yunet.mjs): with a /255
 *     RGB tensor the obj_* head outputs exactly 0 for EVERY anchor.
 *   • Outputs at strides 8 / 16 / 32:
 *       cls_8 [1, 6400, 1] · cls_16 [1, 1600, 1] · cls_32 [1, 400, 1]
 *       obj_*  [1, same, 1]
 *       bbox_* [1, same, 4]
 *       kps_*  (5 face landmarks — IGNORED: detection-only product)
 *   • Anchor grids per stride: 80² / 40² / 20² (640 / stride).
 *   • cls/obj are ALREADY sigmoid'ed IN-GRAPH (observed values in [0,1]; obj
 *     saturates at 0.999 on a face): the score is the raw geometric mean
 *     sqrt(clamp01(cls)·clamp01(obj)) — NOT sigmoid(cls)·sigmoid(obj); a
 *     second sigmoid squashes a 0.96 face to ~0.52, under the 0.6 threshold.
 *     Distance2bbox decode against the anchor grid; NMS IoU threshold 0.3;
 *     confidence threshold default 0.6 (configurable).
 *
 * Plate (`yolo-v9-t-640-license-plates-end2end.onnx`, end-to-end):
 *   • Output rows: [x1, y1, x2, y2, class_id, score] in LETTERBOXED coords.
 *   • Filter score ≥ 0.25 (conf threshold).
 *   • Un-letterbox each row: v' = (v − pad) / ratio (v-pad per axis: x by
 *     horizontal pad, y by vertical pad), then convert (x1,y1,x2,y2) → Box.
 *   • No JS-side NMS — NMS is graph-embedded (end-to-end export).
 *
 * ─── YuNet bbox decode formula (EXACT, as implemented in decodeYunetOutputs) ───
 *
 * The 2023mar ONNX export stores RAW bbox distances (not exp-scaled), so the
 * reference decode is OpenCV's FaceDetectorYNImpl::postProcess
 * (modules/objdetect/src/face_detect.cpp, verified 2026-10-28) with anchor
 * index (col c, row r) at stride s, bbox distances (d0, d1, d2, d3):
 *
 *   score    = sqrt(clamp01(cls[idx]) · clamp01(obj[idx]))
 *              (sigmoid is IN-GRAPH — OpenCV postProcess clamps both heads
 *              to [0,1] and takes the geometric mean; verified 2026-10-28)
 *   cx       = (c + d0) · s
 *   cy       = (r + d1) · s
 *   w        = exp(d2) · s
 *   h        = exp(d3) · s
 *   x1       = cx − w/2   y1 = cy − h/2   (then xywh form)
 *
 * (This is YuNet's center-displacement + exp-size decode, NOT the FCOS
 * ltrb-against-anchor-center variant — with it, the same fixture numbers
 * read as d_l = −d0·s, d_t = −d1·s, d_r = d0·s + w, d_b = d1·s + h. The
 * implementation and its fixture are self-consistent either way.) The unit
 * fixture pins THIS interpretation. bbox tensors are accepted in both
 * layouts — [1, N, 4] interleaved and [1, 4, N] planar — chosen from dims.
 *
 * ─── Coordinate-space decision (per ADR-9: one display space downstream) ───
 *
 * decodeYunetOutputs / parsePlateRows / detectFace / detectPlate RETURN
 * DISPLAY-space boxes (letterbox→display inversion applied here via
 * unletterboxBox). NOTE FOR analyze.js / redact.js / tracker.js: every
 * Detection you receive from this module is already in display-oriented
 * native pixels — never un-letterbox again. Model space exists only inside
 * this module. mergeTiles additionally translates tile-local detections
 * into the same display space (offset by tile origin), tagging
 * `pass: 'tile'`.
 *
 * ─── Dashcam tiling axis (REQ-107: split along the DOMINANT axis) ───
 *
 * tileGrid splits landscape/square frames horizontally (k full-height
 * columns) and PORTRAIT frames vertically (r full-width stacked rows), the
 * exact w↔h mirror:
 *
 *   k = clamp(ceil(w / (target·(h/w))), 1, 4)   aspect ≥ 1
 *   r = clamp(ceil(h / (target·(w/h))), 1, 4)   aspect < 1
 *
 * Pre-REQ-107 the horizontal-only formula gave a 540×960 portrait frame
 * k = 1 — a single full-frame pass and NO mitigation for the small
 * through-glass faces of the 2026-10-29 field miss (~40-60 px, below conf
 * 0.6 at the 0.667 full-frame 640 scale). Vertical rows re-scale each band
 * at 640/540 ≈ 1.19: ~1.8× the single-pass model scale (~2.3× on 9:21-class
 * frames before the r ≤ 4 clamp). mergeTiles needs no axis knowledge — it
 * offsets by tile origin, so origin-translated rects work identically for
 * rows and columns; landscape geometry is bit-identical to pre-REQ-107.
 *
 * ─── Execution-provider policy (ADR-5, @MX:WARN fallback order) ───
 *   • WebKit (engine-sniffed): EP = ['wasm'] — WebGPU EP is broken on
 *     WebKit 26 (ort#26827). WASM-only asset set.
 *   • Chromium/Gecko: EP = ['webgpu', 'wasm'] with session-create retry on
 *     WebGPU failure. numThreads = 1 (no COOP/COEP requirement).
 *
 * Depends on: onnxruntime-web (importmap pin 1.31.1), models.js.
 */
import './types.js';

/**
 * Minimal raster accepted by frameToTensor / letterbox / detectFace /
 * detectPlate: a real ImageData or any {data (RGBA), width, height} triple.
 * @typedef {{data: Uint8ClampedArray | Uint8Array, width: number, height: number}} ImageDataLike
 */

/** jsDelivr asset root; the .mjs bundle and .wasm binaries must be same-version (research §2.2). */
const ORT_VERSION = '1.31.1';
export const ORT_WASM_PATHS = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/**
 * Default confidence thresholds (REQ-113): face 0.6, plate 0.25 — the values
 * baked into every call before v1.5.0, preserved as defaults so existing call
 * sites behave identically. Per-call override: `detectFace(frame,
 * { confThreshold })` / `detectPlate(frame, { confThreshold })`; the analyze
 * pass forwards `settings.confFace` / `settings.confPlate` (analyze.js).
 */
export const DEFAULT_CONF_FACE = 0.6;
export const DEFAULT_CONF_PLATE = 0.25;

/**
 * Greedy non-maximum suppression.
 *
 * @param {Array<{box: import('./types.js').Box, conf: number, [k: string]: unknown}>} dets
 * @param {number} [iouThreshold=0.3] Suppress lower-conf boxes overlapping above this.
 * @returns {Array<{box: import('./types.js').Box, conf: number, [k: string]: unknown}>}
 */
export function nms(dets, iouThreshold = 0.3) {
  const order = [...dets].sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const det of order) {
    if (keep.every((k) => iou(k.box, det.box) <= iouThreshold)) keep.push(det);
  }
  return keep;
}

/**
 * Letterbox GEOMETRY (pure, no pixels): scale `frameSize` to fit a
 * `target`×`target` square preserving aspect, pad the short side.
 *
 * @param {{width: number, height: number}} frameSize Display frame size.
 * @param {number} [target=640] Model input edge.
 * @returns {{ratio: number, padX: number, padY: number, scaledW: number, scaledH: number}}
 *     `ratio = min(tw/fw, th/fh)`; the scaled image is centered, so the
 *     leftover on each axis is split evenly: `padX = (tw − scaledW)/2`,
 *     `padY = (th − scaledH)/2`. Model-space → display-space is
 *     `(v − pad) / ratio` per axis (padX for x, padY for y).
 */
export function letterboxGeometry(frameSize, target = 640) {
  const { width: fw, height: fh } = frameSize;
  const ratio = Math.min(target / fw, target / fh);
  const scaledW = fw * ratio;
  const scaledH = fh * ratio;
  return {
    ratio,
    padX: (target - scaledW) / 2,
    padY: (target - scaledH) / 2,
    scaledW,
    scaledH,
  };
}

/**
 * Map ONE model-space scalar back to display space along an axis:
 * `(v − pad) / ratio` — padX on the x axis, padY on the y axis.
 *
 * @param {number} v Model-space coordinate (640² letterbox space).
 * @param {'x'|'y'} axis Which pad applies.
 * @param {{ratio: number, padX: number, padY: number}} geom From letterboxGeometry().
 * @returns {number} Display-space coordinate, native px.
 */
export function unletterboxCoord(v, axis, geom) {
  return (v - (axis === 'x' ? geom.padX : geom.padY)) / geom.ratio;
}

/**
 * Map an {x,y,w,h} box from model space back to display space: edges are
 * inverted per axis, then the size re-derived from the inverted edges
 * (`(e2 − pad)/ratio − (e1 − pad)/ratio = (e2 − e1)/ratio`, so w/h simply
 * divide by ratio; x/y get the pad shift).
 *
 * @param {import('./types.js').Box} box Model-space box.
 * @param {{ratio: number, padX: number, padY: number}} geom From letterboxGeometry().
 * @returns {import('./types.js').Box} Display-space box, native px.
 */
export function unletterboxBox(box, geom) {
  return {
    x: unletterboxCoord(box.x, 'x', geom),
    y: unletterboxCoord(box.y, 'y', geom),
    w: box.w / geom.ratio,
    h: box.h / geom.ratio,
  };
}

/**
 * Letterbox a display-space frame into 640×640 model space (design §4.1):
 * scale to fit preserving aspect, pad the short side, RGB float32 CHW.
 *
 * Convenience wrapper over letterboxGeometry + frameToTensor.
 *
 * @param {ImageDataLike} frame RGBA source (native display pixels).
 * @param {number} [target=640] Model input edge.
 * @returns {{ratio: number, padX: number, padY: number, input: Float32Array}}
 *     `unletterbox(v) = (v − pad) / ratio` per axis (padX for x, padY for y).
 */
export function letterbox(frame, target = 640) {
  const frameSize = frameSizeOf(frame);
  const geom = letterboxGeometry(frameSize, target);
  return {
    ratio: geom.ratio,
    padX: geom.padX,
    padY: geom.padY,
    input: frameToTensor(frame, geom, target),
  };
}

/**
 * Map model-space coordinates back to display space: `(v − pad) / ratio`.
 * Accepts scalar, [x, y] pairs, or [x1, y1, x2, y2] rows using the stored
 * `{ratio, padX, padY}` transform for the frame size. For legacy array-form
 * input [a, b] is treated as an (x, y) POINT (padX/padY per component); pass
 * a Box to unletterboxBox for size-correct box inversion.
 *
 * @param {number|number[]} v Coordinate(s) in 640² model space.
 * @param {{ratio: number, padX: number, padY: number}} t Transform from letterbox().
 * @returns {number|number[]} Display-space coordinate(s), native px.
 */
export function unletterbox(v, t) {
  if (typeof v === 'number') return unletterboxCoord(v, 'x', t);
  return v.map((c, i) => unletterboxCoord(c, i % 2 === 0 ? 'x' : 'y', t));
}

/**
 * Draw the RGBA source into the letterboxed `target`² raster (bilinear
 * resample, letterbox area left black) and pack it as RGB float32 CHW.
 * Overwrites `out` when given (allocation-free steady state).
 *
 * Raster path only — ORT never sees a canvas; upload is done by the caller
 * building an ORT Tensor from the returned Float32Array.
 *
 * @param {ImageDataLike} frame RGBA source (native display pixels).
 * @param {{ratio: number, padX: number, padY: number, scaledW: number, scaledH: number}} geom
 *     From letterboxGeometry().
 * @param {number} [target=640] Model input edge.
 * @param {Float32Array} [out] Destination, length 3·target² (CHW).
 * @returns {Float32Array} RGB float32, CHW layout, [0,1] range, pads = 0.
 */
export function frameToTensor(frame, geom, target = 640, out) {
  const data = frame.data;
  if (data.length < frame.width * frame.height * 4) {
    throw new TypeError('frame.data must be RGBA (width·height·4 bytes)');
  }
  const tensor = out ?? new Float32Array(3 * target * target);
  if (tensor.length !== 3 * target * target) {
    throw new TypeError(`out must be length ${3 * target * target}`);
  }
  // Only the in-bounds (scaled) region is written below — the letterbox pad
  // cells MUST be zeroed here or a REUSED buffer (`out`, the analyze loop's
  // shared scratch) keeps stale pixel data from earlier calls whose letterbox
  // geometry padded a DIFFERENT region (full-frame calls pad rows, dashcam
  // tile calls pad columns). The YuNet input path then rescales that garbage
  // ×255 (toYunetInput) and the model fires conf-0.99 ghosts on the pad —
  // observed as ~2646 spurious face tracks on a 120-frame synthetic clip.
  tensor.fill(0);

  // Bilinear kernel shared by the H and V passes. `src0/src1` are the two
  // straddling source coordinates, `frac` the blend weight toward src1.
  const taps = (dst, dstMax, srcMax) => {
    const scaled = dst * (srcMax / dstMax) - 0.5; // center-of-pixel mapping
    const f = Math.floor(scaled);
    const frac = scaled - f;
    const src0 = Math.min(Math.max(f, 0), srcMax - 1);
    const src1 = Math.min(Math.max(f + 1, 0), srcMax - 1);
    return { src0, src1, frac };
  };

  const x0 = new Int32Array(target);
  const x1 = new Int32Array(target);
  const fx = new Float32Array(target);
  for (let dx = 0; dx < target; dx++) {
    if (dx < geom.padX || dx >= geom.padX + geom.scaledW) continue;
    const t = taps(dx - geom.padX, geom.scaledW, frame.width);
    x0[dx] = t.src0;
    x1[dx] = t.src1;
    fx[dx] = t.frac;
  }
  // Separable bilinear: vertical blend into `rowA` (RGBA), then a horizontal
  // blend per output pixel — mathematically identical to full 2D bilinear.
  const rowA = new Float32Array(frame.width * 4);
  for (let dy = 0; dy < target; dy++) {
    if (dy < geom.padY || dy >= geom.padY + geom.scaledH) continue; // letterbox rows stay 0
    const t = taps(dy - geom.padY, geom.scaledH, frame.height);
    const rowOff0 = t.src0 * frame.width * 4;
    const rowOff1 = t.src1 * frame.width * 4;
    for (let i = 0; i < rowA.length; i++) {
      rowA[i] = data[rowOff0 + i] + (data[rowOff1 + i] - data[rowOff0 + i]) * t.frac;
    }
    for (let dx = 0; dx < target; dx++) {
      if (dx < geom.padX || dx >= geom.padX + geom.scaledW) continue; // letterbox cols stay 0
      const s0 = x0[dx] * 4;
      const s1 = x1[dx] * 4;
      const w1 = fx[dx];
      const w0 = 1 - w1;
      const di = dy * target + dx;
      for (let c = 0; c < 3; c++) {
        tensor[c * target * target + di] = (rowA[s0 + c] * w0 + rowA[s1 + c] * w1) / 255;
      }
    }
  }
  return tensor;
}

// @MX:ANCHOR correctness-critical YuNet tensor decode — formula pinned EXACTLY in the module header + unit fixture.
/**
 * Decode raw YuNet output tensors for one frame (design §4.2). The decode
 * formula is documented EXACTLY in the module header — the unit fixture pins
 * it. kps_* landmarks are ignored (detection-only product).
 *
 * @param {Record<string, {data: Float32Array, dims: number[]} | Float32Array>} outputs
 *     Raw ONNX output tensors keyed `cls_8|obj_8|bbox_8|cls_16|…` — ORT
 *     Tensor objects (read `.data`/`.dims`) or bare Float32Arrays paired via
 *     `shapes`; `kps_*` keys are ignored.
 * @param {Record<string, number[]>} shapes dims for bare-Float32Array
 *     entries, keyed like `outputs` (e.g. `{ cls_8: [1, 6400, 1], … }`);
 *     pass `undefined` when outputs are ORT Tensor objects.
 * @param {{ratio: number, padX: number, padY: number}} t Letterbox transform.
 * @param {{confThreshold?: number, nmsIoU?: number}} [opts] Defaults: 0.6 / 0.3.
 * @returns {Array<{box: import('./types.js').Box, conf: number}>} Display space.
 */
export function decodeYunetOutputs(outputs, shapes, t, opts = {}) {
  const { confThreshold = 0.6, nmsIoU = 0.3 } = opts;
  // ORT output names may be exactly `cls_8`… or carry graph prefixes
  // (`/model/cls_8`); exact match first, then unique suffix match. Both plain
  // objects and Maps (older ort run() API) are accepted.
  const entries = outputs instanceof Map ? [...outputs.entries()] : Object.entries(outputs);
  const of = (token) => {
    let hit = entries.find(([k]) => k === token) ?? entries.find(([k]) => k.endsWith(token));
    if (!hit) throw new Error(`decodeYunetOutputs: missing output "${token}"`);
    const [, v] = hit;
    if (v instanceof Float32Array) {
      const dims = shapes?.[token] ?? shapes?.[entries.find(([k]) => k.endsWith(token))[0]];
      if (!dims) throw new Error(`decodeYunetOutputs: missing shape for "${token}"`);
      return { data: v, dims };
    }
    return { data: v.data, dims: v.dims };
  };

  /** @type {Array<{box: import('./types.js').Box, conf: number}>} */
  const cands = [];
  for (const stride of [8, 16, 32]) {
    const { data: cls } = of(`cls_${stride}`);
    const { data: obj } = of(`obj_${stride}`);
    const { data: bbox, dims: bboxDims } = of(`bbox_${stride}`);
    const cols = 640 / stride; // anchor grid per stride: 80² / 40² / 20²
    const n = cols * cols;
    // bbox layout: [1, N, 4] interleaved (per-anchor l,t,r,b) or
    // [1, 4, N] planar (four full-anchor planes) — decided from dims.
    const planar = Array.isArray(bboxDims) && bboxDims.length === 3 && bboxDims[1] === 4 && bboxDims[2] === n;
    const at = (i, k) => (planar ? bbox[k * n + i] : bbox[i * 4 + k]);
    const rows = cols;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        // cls/obj are in-graph probabilities (see module header) — raw
        // geometric mean, OpenCV FaceDetectorYNImpl::postProcess.
        const conf = Math.sqrt(clamp01(cls[idx]) * clamp01(obj[idx]));
        if (conf < confThreshold) continue;
        // Decode formula — OpenCV FaceDetectorYNImpl::postProcess (verified
        // 2026-10-28, see module header): centers move by the RAW (un-scaled,
        // un-exp'd) first two distances; sizes exp-decode the last two.
        const cx = (c + at(idx, 0)) * stride;
        const cy = (r + at(idx, 1)) * stride;
        const w = Math.exp(at(idx, 2)) * stride;
        const h = Math.exp(at(idx, 3)) * stride;
        cands.push({
          box: unletterboxBox({ x: cx - w / 2, y: cy - h / 2, w, h }, t),
          conf,
        });
      }
    }
  }
  return nms(cands, nmsIoU);
}

// @MX:ANCHOR plate end-to-end row parse — letterbox inversion; NMS is graph-embedded upstream (no JS NMS here).
/**
 * Parse plate-model end-to-end rows, un-letterbox, filter by score (design
 * §4.3). TWO output layouts are supported (probed against the real model on
 * 2026-10-30, tools/debug-plate.mjs — the v1.0–v1.9 parser read the WRONG
 * columns and filtered every detection, so plate detection never fired):
 *
 *   • `[N, 7]` — `[batch_idx, x1, y1, x2, y2, class_id, score]` (the actual
 *     open-image-models end2end export; verified: score column holds 0-1
 *     confidences, column 0 is a constant batch index, coordinates are
 *     letterboxed 640-space).
 *   • `[N, 6]` — `[x1, y1, x2, y2, class_id, score]` (legacy/alternative
 *     exports without the batch column).
 *
 * The layout is chosen by tensor width (7 → batch offset 1, 6 → offset 0);
 * score is ALWAYS the last column and the four box columns precede
 * class_id. Filter `score ≥ confThreshold`, un-letterbox, convert to Box.
 *
 * @param {ArrayLike<number>} rows Flat row-major tensor data.
 * @param {number[]} dims Tensor dims `[n, 6|7]`.
 * @param {{ratio: number, padX: number, padY: number}} t Letterbox transform.
 * @param {{confThreshold?: number}} [opts] Default: 0.25.
 * @returns {Array<{box: import('./types.js').Box, conf: number, classId: number}>}
 *     Display space; `cls: 'plate'` on every detection.
 */
export function parsePlateRows(rows, dims, t, opts = {}) {
  const confThreshold = opts.confThreshold ?? 0.25;
  const n = dims[0];
  const stride = dims.length > 1 ? dims[1] : 7;
  // 7-wide rows carry a leading batch index; 6-wide rows do not. The score
  // is the last column either way; the box occupies the 4 columns before
  // class_id.
  const batchOff = stride === 7 ? 1 : 0;
  const x1Off = batchOff + 0;
  const y1Off = batchOff + 1;
  const x2Off = batchOff + 2;
  const y2Off = batchOff + 3;
  const clsOff = batchOff + 4;
  const scoreOff = stride - 1;
  /** @type {Array<{box: import('./types.js').Box, conf: number, classId: number, cls: 'plate'}>} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = i * stride;
    const score = rows[o + scoreOff];
    if (!(score >= confThreshold)) continue; // NaN-safe: NaN never passes
    const x1 = rows[o + x1Off];
    const y1 = rows[o + y1Off];
    const x2 = rows[o + x2Off];
    const y2 = rows[o + y2Off];
    out.push({
      box: unletterboxBox({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, t),
      conf: score,
      classId: rows[o + clsOff],
      cls: 'plate',
    });
  }
  return out;
}

/**
 * Compute the dashcam tile grid (design §4.1, REQ-107): the display frame is
 * split along its DOMINANT axis, each tile letterboxed independently.
 *
 *   • Landscape / square (aspect = w/h ≥ 1): `k` full-height horizontal
 *     tiles — k = clamp(ceil(frameW / (target · frameH / frameW)), 1, 4)
 *     (e.g. 4K 16:9 → 3…4 tiles of ~960-1280×2160 display px).
 *   • Portrait (aspect < 1): the exact mirror on the vertical axis — `r`
 *     full-width stacked ROWS — r = clamp(ceil(frameH / (target · frameW /
 *     frameH)), 1, 4), tiles {x: 0, y, w, h: rowH} with the last row
 *     absorbing the rounding remainder.
 *
 * Rationale (REQ-107 miss analysis, 2026-10-29 field report): the divisor
 * target·(h/w) — resp. target·(w/h) — is the height (resp. width) the
 * full-frame letterbox occupies in model space, i.e. the widest strip /
 * tallest band that still sees ~model-scale detail. The horizontal-only
 * formula gave a 540×960 portrait frame k = ceil(540/(640·1.778)) = 1 — a
 * single full-frame pass, NO mitigation for small through-glass faces
 * (~40-60 px below conf 0.6 at the 0.667 full-frame scale). Vertical rows
 * scale each band at 640/540 ≈ 1.19 instead of 0.667: a 50 px face lands at
 * ~59 model px ≈ 1.8× the single-pass scale (~2.3× for 9:21-class frames
 * before the r ≤ 4 clamp) — REQ-107's "≥ ~2×" class of recovery. Landscape
 * geometry is bit-identical to the pre-REQ-107 behavior.
 *
 * @param {{width: number, height: number}} frameSize Display frame size.
 * @param {number} [target=640] Per-tile model input edge.
 * @returns {Array<{x: number, y: number, w: number, h: number, transform: {ratio: number, padX: number, padY: number}}>}
 *     Tile rects in display space with their per-tile letterbox transforms.
 */
export function tileGrid(frameSize, target = 640) {
  const { width, height } = frameSize;
  /** @type {Array<{x: number, y: number, w: number, h: number, transform: {ratio: number, padX: number, padY: number}}>} */
  const tiles = [];
  if (width >= height) {
    // Landscape / square (aspect ≥ 1): existing horizontal tiling.
    const k = Math.min(4, Math.max(1, Math.ceil(width / (target * (height / width)))));
    const baseW = Math.ceil(width / k);
    for (let i = 0; i < k; i++) {
      const x = i * baseW;
      const w = Math.min(width - x, baseW); // last tile absorbs the rounding remainder
      tiles.push({ x, y: 0, w, h: height, transform: letterboxGeometry({ width: w, height }, target) });
    }
  } else {
    // Portrait (REQ-107): mirror of the k formula on the vertical axis —
    // stacked full-width rows, last row absorbs the rounding remainder.
    const r = Math.min(4, Math.max(1, Math.ceil(height / (target * (width / height)))));
    const baseH = Math.ceil(height / r);
    for (let i = 0; i < r; i++) {
      const y = i * baseH;
      const h = Math.min(height - y, baseH); // last row absorbs the rounding remainder
      tiles.push({ x: 0, y, w: width, h, transform: letterboxGeometry({ width, height: h }, target) });
    }
  }
  return tiles;
}

/**
 * Merge tile-local detections back into ONE full-frame coordinate space
 * before tracking (tracking never sees tile coordinates — design §4.1):
 * translate each box by its tile's origin and tag `pass: 'tile'` (full-pass
 * detections keep `pass: 'full'`). Seam dedup/NMS of cross-tile duplicates
 * is the caller's job (tracker association collapses them) — this function
 * is a pure coordinate map.
 *
 * @param {Array<import('./types.js').Detection & {tileIndex?: number}>} tileDets
 *     Detections in tile-local space, each tagged with its tile index
 *     (missing tag ⇒ tile 0).
 * @param {Array<{x: number, y: number, w: number, h: number}>} tiles Tile rects.
 * @returns {Array<import('./types.js').Detection>}
 *     Detections in full-frame display space.
 */
export function mergeTiles(tileDets, tiles) {
  return tileDets.map((det) => {
    const tile = tiles[det.tileIndex ?? 0];
    return {
      ...det,
      box: { x: det.box.x + tile.x, y: det.box.y + tile.y, w: det.box.w, h: det.box.h },
      pass: det.pass ?? 'tile',
    };
  });
}

/**
 * Create the face and plate detectors. Loads both model byte caches and
 * creates ORT sessions per the EP policy above. ONE instance per analyze
 * run; callers must `close()` it (session + wasm memory release).
 *
 * EP ladder (ADR-5): `epPolicy` override wins; otherwise
 * `['webgpu','wasm']`, except WebKit engines (per capability.engine) which
 * start at `['wasm']` directly (ort#26827). A webgpu-first session whose
 * creation fails retries on wasm (AC-17). `ort.env.wasm.wasmPaths` is pinned
 * to the jsDelivr 1.31.1 dist; `numThreads = 1` (no COOP/COEP requirement).
 *
 * @param {{onModelProgress?: (name: string, fraction: number) => void, epPolicy?: string[]}} [opts]
 *     `onModelProgress('yunet'|'plate-yolov9t', 0..1)` during ensureModel;
 *     `epPolicy` overrides the EP ladder (e.g. `['wasm']` to force CPU).
 * @returns {Promise<{
 *   detectFace: (frame: ImageDataLike, opts?: {confThreshold?: number}) => Promise<import('./types.js').Detection[]>,
 *   detectPlate: (frame: ImageDataLike, opts?: {confThreshold?: number}) => Promise<import('./types.js').Detection[]>,
 *   detectFaceRaw: (frame: ImageDataLike, geom?: {ratio: number, padX: number, padY: number}) =>
 *     Promise<{outputs: Record<string, {data: Float32Array, dims: number[]}>, geom: {ratio: number, padX: number, padY: number}}>,
 *   detectPlateRaw: (frame: ImageDataLike, geom?: {ratio: number, padX: number, padY: number}) =>
 *     Promise<{rows: Float32Array, dims: number[], geom: {ratio: number, padX: number, padY: number}}>,
 *   close: () => void,
 *   effectiveEp: string | null
 * }>} Detections carry display-space boxes and `pass: 'full' | 'tile'`;
 *     `t` is stamped by the analyze loop, not here. `opts.confThreshold`
 *     (REQ-113) overrides the per-call decode gate — default
 *     DEFAULT_CONF_FACE / DEFAULT_CONF_PLATE, so existing call sites are
 *     unchanged. The RAW accessors (REQ-114) run ONE inference and return
 *     the undecoded model outputs (`detectFaceRaw` → YuNet head tensors +
 *     the letterbox transform; `detectPlateRaw` → flat end-to-end rows +
 *     their `[n, 6]` dims), so callers can decode the SAME inference at
 *     many thresholds (single-frame threshold comparison). `geom` is
 *     inferred from the frame when omitted; a passed `geom` is echoed back
 *     unchanged as the transform to decode with. `effectiveEp` is the
 *     execution provider the sessions ACTUALLY created with (AC-17 UI
 *     notice): the first successful ladder rung — `'webgpu'` when WebGPU
 *     worked, `'wasm'` after a fallback (or a WebKit wasm-only policy);
 *     null only if no session was created (both creations throw before any
 *     success — the factory then rejects, so in practice the resolve value
 *     is always non-null).
 */
export async function createDetectors(opts = {}) {
  const ort = await import('onnxruntime-web');
  const models = await import('./models.js');

  ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
  ort.env.wasm.numThreads = 1;

  const isWebKit = opts.epPolicy
    ? false
    : typeof navigator !== 'undefined' && /webkit/i.test(navigator.userAgent) && !/chrome|chromium|android/i.test(navigator.userAgent);
  const eps = opts.epPolicy ?? (isWebKit ? ['wasm'] : ['webgpu', 'wasm']);

  /** The EP the sessions actually created with (AC-17 UI notice) — the
   * first successful ladder rung; both sessions walk the same ladder. */
  let effectiveEp = /** @type {string | null} */ (null);

  /** Create a session, walking the EP ladder on failure (AC-17). */
  const createSession = async (bytes) => {
    /** @type {unknown[]} */
    let lastErr;
    for (let i = 0; i < eps.length; i++) {
      const trial = eps.slice(i);
      try {
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: trial,
          graphOptimizationLevel: 'all',
        });
        effectiveEp ??= String(trial[0]);
        return session;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };

  // models.ensureModel invokes its listener with a ModelProgress object
  // ({received, total, ratio}) — tests (and the onModelProgress contract
  // below) pass a plain number. Normalize BOTH shapes to the numeric 0..1
  // fraction the analyze.js onProgress contract forwards to the UI.
  const progress = (name) => (update) => {
    const fraction =
      typeof update === 'number' ? update : typeof update?.ratio === 'number' ? update.ratio : 0;
    if (typeof opts.onModelProgress === 'function') opts.onModelProgress(name, fraction);
  };
  const [yunetBytes, plateBytes] = await Promise.all([
    models.ensureModel('yunet', progress('yunet')),
    models.ensureModel('plate-yolov9t', progress('plate-yolov9t')),
  ]);
  // Sequential session creation keeps the EP-ladder deterministic (face
  // walks it fully before plate starts); model BYTES load in parallel above.
  const faceSession = await createSession(yunetBytes);
  const plateSession = await createSession(plateBytes);

  const TARGET = 640;
  // Allocation-free steady state: analyze.js awaits each detection before the
  // next frame (design §4.6), so one scratch buffer is never shared in flight.
  const scratch = new Float32Array(3 * TARGET * TARGET);

  /**
   * Letterbox an RGBA-like frame and run ONE ORT session — the shared
   * inference half of every accessor below (decode is separate so the raw
   * accessors can skip it and callers can decode at any threshold, REQ-114).
   *
   * @param {ImageDataLike} frame
   * @param {'face'|'plate'} kind
   * @returns {Promise<{results: Record<string, {data: Float32Array, dims: number[]}>,
   *                     geom: {ratio: number, padX: number, padY: number}}>}
   */
  const runInference = async (frame, kind) => {
    const frameSize = frameSizeOf(frame);
    const geom = letterboxGeometry(frameSize, TARGET);
    const input = frameToTensor(frame, geom, TARGET, scratch);
    if (kind === 'face') toYunetInput(input); // YuNet wants raw BGR 0-255 (in place)
    const session = kind === 'face' ? faceSession : plateSession;
    const feed = {
      [session.inputNames?.[0] ?? 'input']: new ort.Tensor('float32', input, [1, 3, TARGET, TARGET]),
    };
    const results = await session.run(feed);
    return { results, geom };
  };

  /**
   * Decode YuNet head outputs into display-space face Detections.
   * @param {Record<string, {data: Float32Array, dims: number[]}>} results
   * @param {{ratio: number, padX: number, padY: number}} geom
   * @param {{confThreshold?: number}} [opts]
   * @returns {import('./types.js').Detection[]}
   */
  const decodeFace = (results, geom, opts = {}) =>
    decodeYunetOutputs(results, undefined, geom, {
      confThreshold: opts.confThreshold ?? DEFAULT_CONF_FACE,
      nmsIoU: 0.3,
    }).map((d) => ({ t: 0, box: d.box, cls: 'face', conf: d.conf, pass: 'full' }));

  /**
   * Decode plate end-to-end rows (single [rows, 6] output; dims may be
   * [1, N, 6]) into display-space plate Detections.
   * @param {Record<string, {data: Float32Array, dims: number[]}>} results
   * @param {{ratio: number, padX: number, padY: number}} geom
   * @param {{confThreshold?: number}} [opts]
   * @returns {import('./types.js').Detection[]}
   */
  const decodePlate = (results, geom, opts = {}) => {
    // Output width 7 = [batch, x1, y1, x2, y2, class, score] (the real
    // end2end export — probed 2026-10-30); 6 = legacy layout without the
    // batch column. The v1.0–v1.9 finder hard-matched 6 and REJECTED the
    // real tensor, so plate detection never fired.
    const plate = Object.values(results).find(
      (out) =>
        Array.isArray(out.dims) &&
        out.dims.length >= 2 &&
        (out.dims[out.dims.length - 1] === 7 || out.dims[out.dims.length - 1] === 6),
    );
    if (!plate) return [];
    const [rowsN, colsN] = plate.dims.slice(-2);
    return parsePlateRows(plate.data, [rowsN, colsN], geom, {
      confThreshold: opts.confThreshold ?? DEFAULT_CONF_PLATE,
    }).map((d) => ({ t: 0, box: d.box, cls: 'plate', conf: d.conf, classId: d.classId, pass: 'full' }));
  };

  /**
   * Letterbox + one inference + decode (detectFace / detectPlate path).
   * @param {ImageDataLike} frame
   * @param {'face'|'plate'} kind
   * @param {{confThreshold?: number}} [opts]
   * @returns {Promise<import('./types.js').Detection[]>}
   */
  const runDetector = async (frame, kind, opts = {}) => {
    const { results, geom } = await runInference(frame, kind);
    return kind === 'face' ? decodeFace(results, geom, opts) : decodePlate(results, geom, opts);
  };

  return {
    detectFace: (frame, opts) => runDetector(frame, 'face', opts),
    detectPlate: (frame, opts) => runDetector(frame, 'plate', opts),
    // REQ-114 raw accessors: ONE inference, NO decoding — the single-frame
    // threshold comparison decodes the same outputs at every level.
    detectFaceRaw: async (frame, geom) => {
      const { results, geom: computed } = await runInference(frame, 'face');
      return { outputs: results, geom: geom ?? computed };
    },
    detectPlateRaw: async (frame, geom) => {
      const { results, geom: computed } = await runInference(frame, 'plate');
      const effective = geom ?? computed;
      // Width 7 = the real end2end layout (batch column); 6 = legacy (see decodePlate).
      const plate = Object.values(results).find(
        (out) =>
          Array.isArray(out.dims) &&
          out.dims.length >= 2 &&
          (out.dims[out.dims.length - 1] === 7 || out.dims[out.dims.length - 1] === 6),
      );
      if (!plate) return { rows: new Float32Array(0), dims: [0, 6], geom: effective };
      const [rowsN, colsN] = plate.dims.slice(-2);
      return { rows: plate.data, dims: [rowsN, colsN], geom: effective };
    },
    close: () => {
      for (const s of [faceSession, plateSession]) s.release?.();
    },
    effectiveEp,
  };
}

/* ─── internal helpers ─── */

/**
 * Extract the letterbox source size from a canvas (width/height attrs) or
 * ImageData-like raster.
 * @param {ImageDataLike | {width: number, height: number}} frame
 */
function frameSizeOf(frame) {
  if (typeof frame?.width !== 'number' || typeof frame?.height !== 'number') {
    throw new TypeError('frame must expose numeric width/height');
  }
  return { width: frame.width, height: frame.height };
}

/** Clamp to [0, 1] — YuNet cls/obj head outputs are already probabilities. */
const clamp01 = (z) => Math.min(1, Math.max(0, z));

/**
 * Adapt an RGB [0,1] CHW tensor IN PLACE to the raw BGR [0,255] layout the
 * YuNet face model expects (OpenCV blobFromImage defaults: scale 1.0,
 * swapRB=false — see the module header). The plate model keeps the RGB [0,1]
 * encoding, so this runs on the face path only. The CHW channel planes are
 * disjoint ranges of the buffer, so the swap + rescale needs no second
 * buffer (allocation-free steady state with the shared scratch).
 * @param {Float32Array} t frameToTensor output (CHW, length 3·target²)
 * @returns {Float32Array} The same buffer, BGR-ordered, [0,255].
 */
function toYunetInput(t) {
  const n = t.length / 3;
  for (let i = 0; i < n; i++) {
    const r = t[i];
    t[i] = t[2 * n + i] * 255;
    t[2 * n + i] = r * 255;
  }
  for (let i = n; i < 2 * n; i++) t[i] *= 255;
  return t;
}

/**
 * Axis-aligned IoU between two {x,y,w,h} boxes. Boxes with non-positive area
 * contribute IoU 0 (no suppression).
 * @param {import('./types.js').Box} a
 * @param {import('./types.js').Box} b
 */
function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  if (inter <= 0 || areaA <= 0 || areaB <= 0) return 0;
  return inter / (areaA + areaB - inter);
}
