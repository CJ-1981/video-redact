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
 *
 * v1.5.0 (SPEC-VID-002 REQ-113/114): `settings.confFace` / `settings.confPlate`
 * gate EVERY detect call (full-frame and tile passes), and `sampleFrameAt()`
 * decodes ONE sample at a requested time through the same seams — the
 * single-frame threshold comparison's decode step.
 *
 * v1.12.0 (SPEC-VID-002 REQ-117/120): `settings.downscale` ('full'|'1080p'|
 * '720p') caps the analysis canvas LONG edge (`scaleFactorFor`), shrinking the
 * per-frame draw + getImageData cost at 4K; detections come back in SCALED
 * space and are rescaled to display space before stamping/tracking, so the
 * tracker, editor, and exporter stay in the one display coordinate space
 * (ADR-9 unchanged downstream). Note: detector inference input is always 640²
 * letterboxed regardless of canvas size, so the downscale win is the
 * pre-processing cost (draw + getImageData) and tile-count stability — the
 * dashcam tileGrid is computed on the SCALED frame, which keeps tile geometry
 * sane for 4K portrait. `settings.minSizePx` (0 = off) drops detections whose
 * display-space min(w, h) is below the threshold BEFORE the tracker
 * (`filterByMinSize`), so tiny false positives never become tracks.
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
 * REQ-117 downscale presets → LONG-edge cap (native px) of the analysis
 * canvas. A Map (not an object literal) so arbitrary strings like
 * 'constructor' can never hit prototype members.
 */
const DOWNSCALE_CAPS = new Map([
  ['1080p', 1920],
  ['720p', 1280],
]);

/**
 * REQ-117 pure helper — analysis-canvas scale factor for a downscale preset.
 * The factor caps the LONG edge of the frame: '1080p' → 1920, '720p' → 1280;
 * 'full' (and any unknown/invalid preset) → 1. Frames already at or under
 * the cap are never upscaled (result clamped to ≤ 1).
 *
 * @param {'full'|'1080p'|'720p'|undefined} downscale Downscale preset.
 * @param {number} displayW Display frame width, native px.
 * @param {number} displayH Display frame height, native px.
 * @returns {number} Scale factor ∈ (0, 1] to apply to BOTH axes.
 */
export function scaleFactorFor(downscale, displayW, displayH) {
  const cap = DOWNSCALE_CAPS.get(downscale);
  if (!cap) return 1;
  if (
    !Number.isFinite(displayW) ||
    !Number.isFinite(displayH) ||
    displayW <= 0 ||
    displayH <= 0
  ) {
    return 1;
  }
  return Math.min(1, cap / Math.max(displayW, displayH));
}

/**
 * REQ-120 pure helper — minimum-size filter. Keeps detections whose
 * DISPLAY-space box has min(w, h) >= `minPx`; `minPx <= 0` (the default) and
 * non-finite `minPx` disable the filter entirely. Non-mutating: always
 * returns a NEW array, never the input.
 *
 * @param {import('./types.js').Detection[]} detections Detections in display space.
 * @param {number} minPx Minimum min(w, h) in display px (0 = no filter).
 * @returns {import('./types.js').Detection[]} New filtered array.
 */
/**
 * Is `t` inside any trim region? PURE (v1.15.2): the analyze loop skips
 * decode + inference entirely for frames inside trimmed regions — they are
 * removed at export, so detecting them wastes time and creates ghost tracks.
 *
 * @param {number} t Presentation time in seconds.
 * @param {Array<{start: number, end: number}> | undefined} [trims] Sorted, non-overlapping regions.
 * @returns {boolean} True when t falls inside any region (boundaries inclusive).
 */
export function inTrims(t, trims) {
  if (!Array.isArray(trims) || trims.length === 0) return false;
  if (!Number.isFinite(t)) return false;
  return trims.some((r) => t >= r.start && t <= r.end);
}

export function filterByMinSize(detections, minPx) {
  if (!Array.isArray(detections)) return [];
  if (!Number.isFinite(minPx) || minPx <= 0) return [...detections];
  return detections.filter((d) => {
    const box = d?.box;
    return Number.isFinite(Math.min(box?.w, box?.h)) && Math.min(box.w, box.h) >= minPx;
  });
}

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
 *          confFace?: number, confPlate?: number, epPolicy?: string[],
 *          downscale?: 'full'|'1080p'|'720p', minSizePx?: number,
 *          trims?: Array<{start: number, end: number}>}} [opts.settings]
 *     Analysis settings. `plateStride` (default 2) is the full-pass plate
 *     cadence; `padSeconds` overrides the finalize padding (default 5/fps,
 *     REQ-007); `confFace` / `confPlate` (REQ-113, defaults 0.6 / 0.25 —
 *     the detector's DEFAULT_CONF_FACE / DEFAULT_CONF_PLATE) gate the face /
 *     plate decode on EVERY detect call, full-frame AND dashcam tile passes;
 *     `epPolicy` overrides the ORT execution-provider ladder (ADR-5);
 *     `downscale` (REQ-117, default 'full') caps the analysis-canvas LONG
 *     edge ('1080p' → 1920, '720p' → 1280) — detections are rescaled back to
 *     display space before tracking, so everything downstream stays in
 *     native coordinates (ADR-9); `minSizePx` (REQ-120, default 0 = off)
 *     drops detections whose display-space min(w, h) is below the threshold
 *     BEFORE the tracker.
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
 *                    skippedCount: number, cancelled: boolean, effectiveEp: string | null}>}
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

  // REQ-117: optional analysis downscale. The canvas (and thus draw +
  // getImageData) runs at the SCALED size; detections come back in scaled
  // space and are rescaled to display space below, so tracking and
  // everything downstream stays in native display coordinates (ADR-9).
  // Inference input is always 640² letterboxed, so the win here is
  // pre-processing cost + stable tile geometry at 4K — not inference size.
  const sf = scaleFactorFor(settings?.downscale, width, height);
  const analysisW = sf === 1 ? width : Math.max(1, Math.round(width * sf));
  const analysisH = sf === 1 ? height : Math.max(1, Math.round(height * sf));

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
    // letterbox happens inside detector.js, not per-frame here. Sized to the
    // (possibly downscaled) analysis frame (REQ-117).
    const { ctx } = makeCanvas(analysisW, analysisH);

    // Dashcam tile grid: pure geometry on the ANALYSIS frame — tiles live in
    // scaled space and mergeTiles maps tile-local boxes back into SCALED
    // full-frame coords; the display-space rescale below then covers both
    // passes uniformly (REQ-008 + REQ-117).
    const tiles = settings?.dashcamMode ? tileGrid({ width: analysisW, height: analysisH }) : null;

    // Per-class decode gates (REQ-113): undefined → the detector's baked
    // defaults (0.6 face / 0.25 plate), so omitted settings change nothing.
    const faceOpts = { confThreshold: settings?.confFace };
    const plateOpts = { confThreshold: settings?.confPlate };

    const tracker = new Tracker();
    const frameTimes = []; // rolling clock stamps for the fps estimate
    let frameCount = 0;
    let skippedCount = 0; // v1.15.2: frames inside trimmed regions
    let cancelled = false;

    for await (const sample of sink.samples()) {
      try {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        // v1.15.2: trimmed regions are skipped entirely — no draw, no
        // inference, no tracker update (their frames never export). The
        // frame still counts toward progress so the ETA stays honest.
        if (inTrims(sample.timestamp, settings?.trims)) {
          skippedCount += 1;
          frameCount += 1;
          continue;
        }
        sample.draw(ctx, 0, 0, analysisW, analysisH);
        const frame = ctx.getImageData(0, 0, analysisW, analysisH);

        // Full pass: faces every frame, plates every plateStride-th frame.
        const dets = [...(await detectors.detectFace(frame, faceOpts))];
        if (frameCount % plateStride === 0) {
          dets.push(...(await detectors.detectPlate(frame, plateOpts)));
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
            tileDets.push(...(await detectors.detectFace(raster, faceOpts)).map(tag));
            tileDets.push(...(await detectors.detectPlate(raster, plateOpts)).map(tag));
          }
          dets.push(...mergeTiles(tileDets, tiles));
        }

        // REQ-117: both passes produced boxes in SCALED analysis space —
        // rescale to display space (guard: sf === 1 needs no pass). After
        // this point everything is native display px (ADR-9).
        if (sf !== 1) {
          for (const d of dets) {
            d.box = {
              x: d.box.x / sf,
              y: d.box.y / sf,
              w: d.box.w / sf,
              h: d.box.h / sf,
            };
          }
        }

        // REQ-120: minimum display-size filter BEFORE the tracker — tiny
        // detections never seed or feed a track.
        const kept = filterByMinSize(dets, settings?.minSizePx ?? 0);

        // Detector t is a placeholder (0) — the sink timestamp is authoritative
        // (ADR-3, seconds keyframes under VFR sources).
        const t = sample.timestamp;
        for (const d of kept) d.t = t;
        tracker.update(kept, t);
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
    return { tracks, frameCount, skippedCount, cancelled, effectiveEp: detectors.effectiveEp ?? null };
  } finally {
    detectors.close();
  }
}

/**
 * Decode exactly ONE video sample at time `t` into an ImageData-like raster
 * at display size (REQ-114, single-frame threshold comparison): the first
 * sample of `VideoSampleSink.samples(t, t + 0.1)` (presentation order),
 * drawn through the SAME seam as the analyze loop (`sample.draw(ctx, 0, 0,
 * w, h)` — container rotation is applied by the decoder, so the raster sits
 * in the one display coordinate space of ADR-9 and the detector's
 * letterbox inversion applies unchanged). The sample is closed on EVERY
 * exit path, like the analyze loop.
 *
 * Display size comes from the input's primary video track
 * (`track.displayWidth/displayHeight` — rotation-applied, matching
 * ingest.js MediaMeta). `maxSize` optionally caps the LONGEST edge (preview
 * panels); the returned width/height are the actual raster dims — detector
 * boxes computed on this raster are in THIS raster's display space, so
 * scale boxes by (panelWidth / result.width) to draw.
 *
 * Mockable exactly like the analyze loop: the `mediabunny` module mock
 * controls the sink, `seams.canvasFactory` the canvas (default
 * OffscreenCanvas / document canvas, read-optimized 2D context).
 *
 * @param {object} input Mediabunny `Input` from ingest.openInput().
 * @param {number} t Presentation time to sample at, seconds (the sink
 *     window is `[t, t + 0.1]` — the first sample at or after `t`).
 * @param {number} [maxSize] Optional longest-edge cap, px (0/undefined =
 *     full display size).
 * @param {{canvasFactory?: (width: number, height: number) =>
 *          {canvas: object, ctx: object}}} [seams] Test seam — canvas
 *     factory (same shape as runAnalyze's).
 * @returns {Promise<{imageDataLike: import('./detector.js').ImageDataLike,
 *                     width: number, height: number, t: number}>}
 *     `imageDataLike` is the RGBA raster (real ImageData in the browser);
 *     `width`/`height` the raster dims (may be maxSize-scaled); `t` the
 *     SAMPLE's actual presentation timestamp (ADR-3), not the request time.
 * @throws {Error} No primary video track, or no sample decoded within the
 *     `[t, t + 0.1]` window (e.g. `t` past the end of the video).
 */
export async function sampleFrameAt(input, t, maxSize = 0, seams = {}) {
  const makeCanvas = seams?.canvasFactory ?? defaultCanvasFactory;
  const videoTrack = await input?.getPrimaryVideoTrack?.();
  if (!videoTrack) throw new Error('sampleFrameAt: input has no primary video track.');
  const srcWidth = Number(videoTrack.displayWidth);
  const srcHeight = Number(videoTrack.displayHeight);
  if (!Number.isFinite(srcWidth) || !Number.isFinite(srcHeight) || srcWidth <= 0 || srcHeight <= 0) {
    throw new Error('sampleFrameAt: primary video track has no display size.');
  }
  // Optional longest-edge cap (preview panels): aspect-locked integer dims.
  let width = srcWidth;
  let height = srcHeight;
  if (Number.isFinite(maxSize) && maxSize > 0 && Math.max(srcWidth, srcHeight) > maxSize) {
    const s = maxSize / Math.max(srcWidth, srcHeight);
    width = Math.max(1, Math.round(srcWidth * s));
    height = Math.max(1, Math.round(srcHeight * s));
  }

  const sink = new VideoSampleSink(videoTrack);
  for await (const sample of sink.samples(t, t + 0.1)) {
    try {
      const { ctx } = makeCanvas(width, height);
      // Same draw seam as the analyze loop — rotation applied by the decoder.
      sample.draw(ctx, 0, 0, width, height);
      const imageDataLike = ctx.getImageData(0, 0, width, height);
      return { imageDataLike, width, height, t: sample.timestamp };
    } finally {
      // Memory discipline: a decoded frame is never retained (see runAnalyze).
      sample.close();
    }
  }
  throw new Error(
    `sampleFrameAt: no video sample at t=${t}s (searched [${t}, ${Number(t) + 0.1}]s — past the end?).`,
  );
}
