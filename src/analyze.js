/**
 * analyze.js — M4 analyze pass, REQ-009 (design.md §4.6; ties M2 + M3).
 *
 * Frame iteration via mediabunny `VideoSampleSink.samples()` (presentation
 * order, seconds-keyed timestamps), stride scheduling (faces every frame,
 * plates every 2nd; dashcam mode adds the tiled pass), progress model
 * (frame count / fps / ETA), cancellation, and memory discipline
 * (`sample.close()` immediately after draw; yield to the event loop every
 * frame so Cancel/progress stay alive — P-5).
 *
 * Loop shape (design §4.6): ONE reusable canvas at `displayWidth×displayHeight`;
 * per sample — draw → getImageData → face detector every frame, plate detector
 * every `settings.plateStride`-th frame (default 2), dashcam mode adds a
 * tiled face+plate pass (tileGrid / mergeTiles keep ONE display coordinate
 * space, ADR-9) → detections stamped with `sample.timestamp` →
 * `tracker.update()` → `sample.close()` (in a finally, so cancel/error paths
 * never leak a sample) → yield. Cancellation (AbortSignal, checked between
 * frames) still runs `tracker.finalize()` so partial tracks are usable
 * (AC-03). Detector/model failures are surfaced verbatim (REQ-021 taxonomy
 * applies to export only); `detectors.close()` runs on every exit path.
 *
 * Test seams (all optional, defaulted to the real browser APIs): a canvas
 * factory, a per-frame event-loop yield, and a monotonic clock — inject them
 * to run the loop headlessly (tests/unit/analyze.test.js).
 */
import { VideoSampleSink } from 'mediabunny';
import { createDetectors, mergeTiles, tileGrid } from './detector.js';
import { Tracker } from './tracker.js';
import './types.js';

/** Rolling window (frames) behind the analyze-fps estimate. */
const FPS_WINDOW = 30;

/** Default plate stride: plate detector runs every 2nd analyzed frame. */
const DEFAULT_PLATE_STRIDE = 2;

/**
 * Default canvas factory: one OffscreenCanvas (document canvas fallback for
 * engines without OffscreenCanvas), sized to the display frame, with a
 * read-optimized 2D context for getImageData.
 *
 * @param {number} width Display width, native px.
 * @param {number} height Display height, native px.
 * @returns {{canvas: OffscreenCanvas | HTMLCanvasElement,
 *            ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D}}
 */
function defaultCanvasFactory(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
}

/**
 * Default per-frame yield: rAF when present (keeps Cancel/progress painting
 * in the browser), else a macrotask timer so node/tests stay responsive.
 *
 * @returns {Promise<void>}
 */
function defaultYieldNow() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Run the full detection sweep over an opened input.
 *
 * @param {object} opts
 * @param {object} [opts.input] Mediabunny `Input` from ingest.openInput().
 * @param {import('./types.js').MediaMeta} [opts.meta] Display size / fps / duration.
 * @param {{dashcamMode?: boolean, plateStride?: number, padSeconds?: number,
 *          epPolicy?: string[]}} [opts.settings] Analysis settings.
 *     `plateStride` (default 2) is the full-pass plate cadence; `padSeconds`
 *     overrides the finalize padding (default 5/fps, REQ-007); `epPolicy`
 *     overrides the ORT execution-provider ladder (ADR-5).
 * @param {(progress: {phase: 'models', model: string, fraction: number} |
 *                {phase: 'analyze', frameCount: number,
 *                 totalFrames: number|null, analyzeFps: number|null,
 *                 etaSec: number|null, trackCount: number}) => void} [opts.onProgress]
 *     Model download progress, then honest per-frame progress (drives
 *     #analyze-progress / fps / ETA). Fired every frame — throttling is the
 *     caller's concern.
 * @param {AbortSignal} [opts.signal] Checked per frame; on abort, `finalize()`
 *     STILL runs so partial tracks are usable (design §4.6).
 * @param {(width: number, height: number) => {canvas: object, ctx: object}} [opts.canvasFactory]
 *     Test seam — canvas + 2D-context factory (default OffscreenCanvas /
 *     document canvas). Called EXACTLY once per run; the canvas is reused.
 * @param {() => Promise<void>} [opts.yieldNow] Test seam — per-frame event
 *     loop yield (default rAF / setTimeout).
 * @param {() => number} [opts.now] Test seam — monotonic ms clock for the
 *     rolling fps/ETA estimate (default performance.now).
 * @returns {Promise<{tracks: import('./types.js').Track[], frameCount: number,
 *                    cancelled: boolean, effectiveEp: string | null}>}
 *     Review-ready tracks (interpolated, padded, labeled). `effectiveEp` is
 *     the ORT execution provider the detector sessions actually created with
 *     (createDetectors' resolve value) — surfaced by the UI after analyze
 *     (AC-17 active-provider notice).
 * @throws {Error} Detector/model failures surfaced verbatim (REQ-021 taxonomy
 *     applies to export only).
 */
export async function runAnalyze({
  input,
  meta,
  settings,
  onProgress,
  signal,
  canvasFactory,
  yieldNow,
  now,
} = {}) {
  const report = typeof onProgress === 'function' ? onProgress : () => {};
  const makeCanvas = canvasFactory ?? defaultCanvasFactory;
  const yield_ = yieldNow ?? defaultYieldNow;
  const clock = now ?? (() => performance.now());

  const width = meta?.displayWidth;
  const height = meta?.displayHeight;
  const fps = meta?.fps;
  const plateStride = Math.max(1, Math.floor(settings?.plateStride ?? DEFAULT_PLATE_STRIDE));
  const padSeconds =
    typeof settings?.padSeconds === 'number' && Number.isFinite(settings.padSeconds)
      ? settings.padSeconds
      : Number.isFinite(fps) && fps > 0
        ? 5 / fps
        : 0;
  const totalFrames =
    Number.isFinite(fps) && fps > 0 && Number.isFinite(meta?.duration)
      ? Math.max(0, Math.round(meta.duration * fps))
      : null;

  // Models + ORT sessions (download progress folded into onProgress).
  const detectors = await createDetectors({
    epPolicy: settings?.epPolicy,
    onModelProgress: (model, fraction) => report({ phase: 'models', model, fraction }),
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) throw new Error('runAnalyze: input has no primary video track.');
    const sink = new VideoSampleSink(videoTrack);

    // ONE canvas for the whole run (@MX:WARN memory discipline) — the 640²
    // letterbox happens inside detector.js, not per-frame here.
    const { ctx } = makeCanvas(width, height);

    // Dashcam tile grid is pure display-space geometry — compute once (REQ-008).
    const tiles = settings?.dashcamMode ? tileGrid({ width, height }) : null;

    const tracker = new Tracker();
    const frameTimes = []; // rolling clock stamps for the fps estimate
    let frameCount = 0;
    let cancelled = false;

    for await (const sample of sink.samples()) {
      try {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        sample.draw(ctx, 0, 0, width, height);
        const frame = ctx.getImageData(0, 0, width, height);

        // Full pass: faces every frame, plates every plateStride-th frame.
        const dets = [...(await detectors.detectFace(frame))];
        if (frameCount % plateStride === 0) {
          dets.push(...(await detectors.detectPlate(frame)));
        }

        // Dashcam pass: tiled face+plate every analyzed frame, tile-local
        // rasters merged back into full-frame display coords BEFORE tracking
        // (design §4.1 — tracking never sees tile coordinates).
        if (tiles) {
          const tileDets = [];
          for (let i = 0; i < tiles.length; i++) {
            const tile = tiles[i];
            const raster = ctx.getImageData(tile.x, tile.y, tile.w, tile.h);
            const tag = (d) => ({ ...d, tileIndex: i, pass: 'tile' });
            tileDets.push(...(await detectors.detectFace(raster)).map(tag));
            tileDets.push(...(await detectors.detectPlate(raster)).map(tag));
          }
          dets.push(...mergeTiles(tileDets, tiles));
        }

        // Detector t is a placeholder (0) — the sink timestamp is authoritative
        // (ADR-3, seconds keyframes under VFR sources).
        const t = sample.timestamp;
        for (const d of dets) d.t = t;
        tracker.update(dets, t);
      } finally {
        // @MX:WARN memory discipline: the sample is closed on EVERY exit path
        // (success, cancel, detector throw) — decoded frames are never retained.
        sample.close();
      }

      frameCount += 1;

      // Rolling analyze fps + honest progress (REQ-009).
      const stamp = clock();
      frameTimes.push(stamp);
      if (frameTimes.length > FPS_WINDOW) frameTimes.shift();
      const elapsedSec = frameTimes.length >= 2 ? (stamp - frameTimes[0]) / 1000 : 0;
      const analyzeFps =
        frameTimes.length >= 2 && elapsedSec > 0
          ? (frameTimes.length - 1) / elapsedSec
          : null;
      const remaining =
        totalFrames != null && analyzeFps != null
          ? Math.max(0, (totalFrames - frameCount) / analyzeFps)
          : null;
      // Tracker._order is the tracker's creation-ordered record — the only
      // live track count it exposes (finalized ids are assigned in finalize()).
      report({
        phase: 'analyze',
        frameCount,
        totalFrames,
        analyzeFps,
        etaSec: remaining,
        trackCount: tracker._order.length,
      });

      // P-5: yield every frame so Cancel/progress stay alive.
      await yield_();
    }

    // Runs on completion AND cancellation — partial tracks stay usable (AC-03).
    const tracks = tracker.finalize(padSeconds);
    return { tracks, frameCount, cancelled, effectiveEp: detectors.effectiveEp ?? null };
  } finally {
    detectors.close();
  }
}
