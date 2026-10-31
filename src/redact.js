/**
 * redact.js — REQ-016 (design.md §3, §4.5); REQ-101/102 per-track styles
 * (SPEC-VID-002). @MX:ANCHOR (apply path is the privacy invariant: preview
 * and export share this exact code — pixel-truthful preview; ADR-6 pixelate
 * extended by REQ-101 with the per-track 'solid' style, dispatched inside
 * pixelateFrame).
 *
 * Pure geometry + canvas 2D. No DOM access at import time (vitest imports
 * this file in the node environment; the shared scratch canvas is created
 * lazily on first applyPixelation call and callers in node inject a scratch).
 */
import './types.js';

/**
 * Dilate a box by `factor` (total, ±factor/2 per side; default 0.15 → ±7.5%
 * per side per REQ-007). The dilated SIZE is always preserved; when
 * `frameSize` is given the box is shifted (clamped) to fit inside the frame
 * so dilation is never lost at the edges. Degenerate (sub-pixel) boxes are
 * grown to ≥ 1 px around their center so a region can never dilate away.
 *
 * @param {import('./types.js').Box} box
 * @param {number} [factor] Dilation fraction of the box's own size (0.15).
 * @param {{width: number, height: number}} [frameSize] Frame bounds to clamp into.
 * @returns {import('./types.js').Box}
 */
export function dilate(box, factor = 0.15, frameSize) {
  const growX = (box.w * factor) / 2;
  const growY = (box.h * factor) / 2;
  let w = box.w + growX * 2;
  let h = box.h + growY * 2;
  let x = box.x - growX;
  let y = box.y - growY;
  if (w < 1) { w = 1; x = box.x + box.w / 2 - 0.5; }
  if (h < 1) { h = 1; y = box.y + box.h / 2 - 0.5; }
  if (frameSize) {
    x = Math.max(0, Math.min(x, frameSize.width - w));
    y = Math.max(0, Math.min(y, frameSize.height - h));
  }
  return { x, y, w, h };
}

/**
 * Nearest-keyframe box for one track at time `t`: the keyframe minimizing
 * |kt − t| (ties resolve to the earlier keyframe). Linear scan over the
 * dense map — keyframe counts per track are small and this is robust to any
 * key insertion order.
 *
 * @param {import('./types.js').Track} track
 * @param {number} t Seconds.
 * @returns {import('./types.js').Box}
 */
function nearestBox(track, t) {
  if (track.keyframes.size === 0) {
    // Density invariant (design §2): an active span always has a box for
    // every t in [start, end]. Violations mean a tracker bug — fail loudly
    // instead of silently shipping an unredacted frame.
    throw new Error(`tracksAt: track ${track.id} covers t=${t} but has no keyframes (density invariant violated)`);
  }
  let bestK = Infinity;
  let best = null;
  for (const [kt, box] of track.keyframes) {
    const d = Math.abs(kt - t);
    if (d < bestK) {
      bestK = d;
      best = box;
    }
  }
  return best;
}

/**
 * All enabled tracks whose redacted span covers `t`, with the box for this
 * exact instant (dense keyframes guaranteed by tracker.finalize /
 * interpolation — export asks ONLY this and never re-derives, design §2).
 * Disabled tracks are skipped (REQ-014): they must stay visible everywhere,
 * in the preview and in the exported file.
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} t Seconds.
 * @returns {Array<{track: import('./types.js').Track, box: import('./types.js').Box}>}
 */
export function tracksAt(tracks, t) {
  const hits = [];
  for (const track of tracks) {
    if (!track.enabled || t < track.start || t > track.end) continue;
    hits.push({ track, box: nearestBox(track, t) });
  }
  return hits;
}

/**
 * Pixelation strength presets (v1.17.0 field fix: wide-but-short regions such
 * as license plates stayed readable at the old base block size). The chosen
 * multiplier is applied to the base block AFTER the `max(12, min/10)` floor,
 * so a higher strength coarsens the mosaic everywhere. `fine` (×1) preserves
 * the v1.16 block sizes for users who want maximum regional fidelity; the
 * DEFAULT is `normal` (×2) — the block size doubles vs v1.16 whenever no
 * explicit strength is supplied.
 * @type {{fine: number, normal: number, coarse: number, max: number}}
 */
export const PIXEL_STRENGTHS = { fine: 1, normal: 2, coarse: 3, max: 4 };

/**
 * Resolve the block-size multiplier for a pixelation strength. Invalid or
 * missing values fall back to `normal` (×2) — the same default preview and
 * export must both land on (AC-04 shared-seam rule).
 *
 * @param {'fine'|'normal'|'coarse'|'max'|null|undefined} [strength]
 * @returns {number} Multiplier (one of 1, 2, 3, 4; default 2).
 */
export function pixelStrengthMultiplier(strength) {
  return strength != null && Object.prototype.hasOwnProperty.call(PIXEL_STRENGTHS, strength)
    ? PIXEL_STRENGTHS[strength]
    : PIXEL_STRENGTHS.normal;
}

/**
 * Shared scratch canvas for applyPixelation (module-level lazy singleton;
 * OffscreenCanvas preferred, DOM canvas fallback). Resized per call —
 * assignment resets the bitmap, so only assign when the size actually
 * changes to keep the export hot path allocation-free.
 * @type {OffscreenCanvas | HTMLCanvasElement | null}
 */
let sharedScratch = null;

/**
 * Resolve the scratch canvas for one applyPixelation call. `requested` may be
 * a canvas instance (caller reuse), a factory `(dw, dh) => canvas` (tests
 * inject recorder contexts), or null/undefined for the shared singleton.
 *
 * @param {HTMLCanvasElement | OffscreenCanvas |
 *         ((dw: number, dh: number) => HTMLCanvasElement | OffscreenCanvas) |
 *         null | undefined} requested
 * @param {number} dw Downscaled target width (px).
 * @param {number} dh Downscaled target height (px).
 * @returns {HTMLCanvasElement | OffscreenCanvas}
 */
function resolveScratch(requested, dw, dh) {
  let canvas = typeof requested === 'function' ? requested(dw, dh) : requested;
  if (!canvas) {
    if (!sharedScratch) {
      if (typeof OffscreenCanvas !== 'undefined') {
        sharedScratch = new OffscreenCanvas(dw, dh);
      } else if (typeof document !== 'undefined') {
        sharedScratch = document.createElement('canvas');
      } else {
        throw new Error('applyPixelation: no canvas available — inject one via opts.scratch');
      }
    }
    canvas = sharedScratch;
  }
  if (canvas.width !== dw) canvas.width = dw;
  if (canvas.height !== dh) canvas.height = dh;
  return canvas;
}

/**
 * Pixelate one region IN PLACE on a 2D context (the 'pixelate' redaction
 * style, ADR-6; 'solid' has its own applySolid — REQ-101). Pipeline (design §4.5):
 *
 *   1. ctx.save()
 *   2. scratch ctx: imageSmoothingEnabled = true (smooth the downscale)
 *      scratch.drawImage(ctx.canvas, box.x, box.y, box.w, box.h, 0, 0, dw, dh)
 *      — samples ONLY the region, never the full frame
 *   3. ctx.imageSmoothingEnabled = false (nearest-neighbour upscale)
 *      ctx.drawImage(scratch, 0, 0, dw, dh, box.x, box.y, box.w, box.h)
 *   4. ctx.restore()  (caller's smoothing state and transform untouched)
 *
 * Block size rule (design §4.5, extended v1.17.0 by the user-selectable
 * strength): `block = max(12, round(min(boxW, boxH)/10)) * multiplier` native
 * px — ≥ ~10 blocks across the smallest dimension BEFORE the strength
 * multiplier, so the region is unrecoverable at a glance; the multiplier
 * (opts.strength → pixelStrengthMultiplier, default 'normal' = ×2) coarsens
 * the mosaic on top. The product is rounded and clamped ≥ 4. `opts.block`
 * overrides the whole rule outright (≥ 1; strength does not apply to an
 * explicit override). Downscale target is dw = ceil(box.w / block) ×
 * dh = ceil(box.h / block). Called on the region AFTER dilation (REQ-007).
 *
 * Preview and export share this exact function (pixel-truthful preview,
 * REQ-016 / AC-04).
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {import('./types.js').Box} box Region to pixelate (display px).
 * @param {{block?: number,
 *          strength?: 'fine'|'normal'|'coarse'|'max',
 *          scratch?: HTMLCanvasElement | OffscreenCanvas |
 *                    ((dw: number, dh: number) => HTMLCanvasElement | OffscreenCanvas)}} [opts]
 *     `block` overrides the block-size rule entirely; `strength` selects the
 *     strength multiplier applied to the rule (invalid/missing → 'normal',
 *     ×2); `scratch` injects or reuses a canvas — an instance (export hot
 *     path avoids per-frame allocation) or a factory called as scratch(dw, dh)
 *     (tests inject recorder contexts).
 * @returns {void}
 */
export function applyPixelation(ctx, box, opts) {
  const minSide = Math.min(box.w, box.h);
  const block = (opts && opts.block) !== undefined
    ? Math.max(1, opts.block)
    : Math.max(
      4,
      Math.round(Math.max(12, Math.round(minSide / 10)) * pixelStrengthMultiplier(opts?.strength)),
    );
  const dw = Math.max(1, Math.ceil(box.w / block));
  const dh = Math.max(1, Math.ceil(box.h / block));
  const scratch = resolveScratch(opts && opts.scratch, dw, dh);
  const sctx = /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} */ (
    scratch.getContext('2d')
  );

  ctx.save();
  // Downscale: smooth average per block — this is what destroys the detail.
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(ctx.canvas, box.x, box.y, box.w, box.h, 0, 0, dw, dh);
  // Upscale: nearest neighbour — hard block edges, no re-smoothing back.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, dw, dh, box.x, box.y, box.w, box.h);
  ctx.restore();
}

// Palette (design-direction.md). Track.color carries the categorical palette
// slot everywhere; manual regions are assigned alert red by the editor.
const ALERT_RED = '#E5484D'; // manual regions (fallback if color missing)
const SAFE_GREEN = '#3ECF8E'; // "keep visible" state
const AMBER = '#F5A623'; // fallback for color-less auto tracks

/** The 'solid' style fill color (REQ-101): fully opaque black. */
const SOLID_BLACK = '#000000';

/**
 * Paint one region opaque black IN PLACE on a 2D context (REQ-101 'solid'
 * style). The fillRect is intersected with the canvas bounds, so a box that
 * overhangs the frame (dilation before clamping, raw caller geometry) never
 * throws and never leaks outside the canvas. Rasterizes with fillRect only —
 * no scratch canvas, no pixel sampling.
 *
 * Preview and export share this exact function through `pixelateFrame`
 * (pixel-truthful preview, REQ-016 / REQ-102).
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {import('./types.js').Box} box Region to black out (display px).
 * @returns {void}
 */
export function applySolid(ctx, box) {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const x = Math.max(0, Math.min(box.x, cw));
  const y = Math.max(0, Math.min(box.y, ch));
  const w = Math.min(box.x + box.w, cw) - x;
  const h = Math.min(box.y + box.h, ch) - y;
  if (w <= 0 || h <= 0) return; // entirely outside the canvas (or degenerate)
  ctx.save();
  ctx.fillStyle = SOLID_BLACK;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/**
 * Draw one track label near a box — above it, or flipped just inside the top
 * edge when the box touches the canvas top.
 */
function drawLabel(ctx, text, box, viewScale, color) {
  const fontPx = 12 * viewScale;
  const pad = 4 * viewScale;
  ctx.fillStyle = color;
  if (box.y - pad >= fontPx) {
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, box.x, box.y - pad);
  } else {
    ctx.textBaseline = 'top';
    ctx.fillText(text, box.x, box.y + pad);
  }
}

/**
 * Draw the review overlay onto the overlay canvas: track-colored stroke boxes
 * with labels ("Face #1") for every ENABLED track active at `t`, plus dashed
 * safe-green boxes tagged "(visible)" for every DISABLED track active at `t`
 * (REQ-014 visual state — the user always sees what is kept visible).
 * Overlay ONLY — never drawn into exported pixels (design §4.7; the burn-in
 * uses applyPixelation alone, driven by the same tracksAt hits, so the
 * preview is pixel-truthful, REQ-016 / AC-04).
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {import('./types.js').Track[]} tracks
 * @param {number} t Seconds.
 * @param {number} [viewScale] Preview-scale multiplier (DPR × fit-to-panel
 *     zoom); multiplies stroke width, label font and dash metrics so the
 *     overlay reads identically at any preview size. Default 1.
 * @returns {void}
 */
export function drawOverlay(ctx, tracks, t, viewScale = 1) {
  /** @type {Array<{track: import('./types.js').Track, box: import('./types.js').Box}>} */
  const disabled = [];
  for (const track of tracks) {
    if (!track.enabled && t >= track.start && t <= track.end) disabled.push({ track, box: nearestBox(track, t) });
  }

  const hits = tracksAt(tracks, t);
  if (hits.length === 0 && disabled.length === 0) return;

  ctx.save();
  ctx.lineWidth = 2 * viewScale;
  ctx.font = `${Math.round(12 * viewScale)}px system-ui, sans-serif`;
  ctx.textAlign = 'left';

  for (const { track, box } of hits) {
    const color = track.color || (track.cls === 'manual' ? ALERT_RED : AMBER);
    ctx.strokeStyle = color;
    ctx.setLineDash([]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    drawLabel(ctx, track.label, box, viewScale, color);
  }

  for (const { track, box } of disabled) {
    // Disabled tracks render SAFE_GREEN regardless of their palette slot —
    // green = "kept visible" is the state signal (label says "(visible)").
    ctx.strokeStyle = SAFE_GREEN;
    ctx.setLineDash([6 * viewScale, 4 * viewScale]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.setLineDash([]);
    drawLabel(ctx, `${track.label} (visible)`, box, viewScale, SAFE_GREEN);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// pixelateFrame — THE shared burn-in composition (REQ-016 / AC-04 seam). @MX:ANCHOR (privacy invariant: preview == export pixels)
// ---------------------------------------------------------------------------

/**
 * Burn ONE frame's redactions onto a frame-sized 2D context — THE shared
 * seam (REQ-016 / AC-04 pixel-truth symmetry, REQ-102 style parity):
 * `tracksAt(t)` hits, each box dilated 15% and clamped to the frame, then
 * rendered per the track's `style` (REQ-101):
 *
 *   - `track.style === 'solid'` → `applySolid` (opaque black box);
 *   - anything else (incl. a missing field) → `applyPixelation`.
 *
 * Dilation applies to BOTH styles identically — the style choice changes only
 * how the dilated region is rasterized, never its geometry. This is the
 * SINGLE seam preview and export must both go through so the pixels a user
 * reviews are the pixels the exported file carries (AC-04, AC-102): the
 * exporter's burn-in callback and the editor's preview both call this exact
 * function with the same review tracks (boxes expressed in the ctx's pixel
 * space) per frame. `drawOverlay` stays style-agnostic (stroke + label
 * regardless of style).
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 *     Context of the frame-sized canvas.
 * @param {import('./types.js').Track[]} tracks Review tracks (enabled matter;
 *     box coordinates must live in the same pixel space as `ctx`).
 * @param {number} t Seconds.
 * @param {{width: number, height: number}} frameSize Display px.
 * @param {{scratch?: HTMLCanvasElement | OffscreenCanvas,
 *          strength?: 'fine'|'normal'|'coarse'|'max'}} [opts] Reused
 *     pixelation scratch (hot path avoids per-frame allocation) and the
 *     pixelation strength passed through to applyPixelation (invalid/missing
 *     → 'normal', ×2 — preview and export must resolve identically, AC-04).
 * @returns {void}
 * @throws {Error} Propagates the redact density invariant when an enabled
 *     track covering `t` has no keyframes — privacy failure, never swallowed.
 */
export function pixelateFrame(ctx, tracks, t, frameSize, opts = {}) {
  for (const { track, box } of tracksAt(tracks, t)) {
    const region = dilate(box, 0.15, frameSize);
    if (track && track.style === 'solid') {
      applySolid(ctx, region);
    } else {
      applyPixelation(ctx, region, { scratch: opts?.scratch, strength: opts?.strength });
    }
  }
}
