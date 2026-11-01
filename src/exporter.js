/**
 * exporter.js — REQ-017/018/019/021 (design.md §3, §4.8).
 *
 * Burn-in export via mediabunny `Conversion.init({ input, output,
 * video: { process } })`: the process callback draws each sample, applies
 * redact.pixelateFrame for `redact.tracksAt(t)` — which renders each track's
 * chosen style ('pixelate' mosaic or 'solid' opaque black, REQ-101/102) —
 * and returns the canvas —
 * which forces video transcode (redaction is BURNED IN, ADR-7). Audio is
 * ALWAYS packet-copied: no `audio` config is ever passed and the default
 * copy policy (`copy: {}` — mediabunny copies "whenever possible") packet-
 * copies the source audio into a container that hosts its codec (AAC→MP4,
 * Opus/Vorbis→WebM; verified in mediabunny 1.63.0 `_processAudioTrack` —
 * `needsTranscode` stays false with no audio options). There is no audio
 * re-encode path (AC-08).
 *
 * Output streams to OPFS `FileSystemWritableFileStream` via
 * `StreamTarget(writable, { chunked: true })` (default) or buffers via
 * `BufferTarget` (`settings.outputMode: 'buffer'`, small clips). Delivery:
 * `settings.saveHandle` → `showSaveFilePicker` (Chromium) → Blob download
 * anchor (DOM-guarded). The staged temp file is deleted after delivery, on
 * cancellation, and on failure (REQ-019, AC-14); `discardExportTemp` exists
 * for crash-recovery of temps orphaned by a tab crash.
 *
 * Codec fallback ladder (ADR-7 / AC-12), probed up front with
 * `canEncodeVideo(codec, { width, height, hardwareAcceleration })`:
 *   avc `prefer-hardware` → avc `prefer-software` → vp9 + WebMOutputFormat
 * Rungs that pass the probe are attempted in order; a runtime encode failure
 * advances the ladder (fresh conversion + fresh staging). I/O write failures
 * and the redact density invariant fail immediately (retrying cannot help).
 * `settings.forceWebM` skips the probe straight to the WebM rung.
 *
 * Frame lifecycle (@MX:WARN): the process callback must NOT close the
 * VideoSample it receives — Conversion owns it and closes it after the
 * returned pixels are taken (verified in mediabunny 1.63.0 `conversion.ts`:
 * `await source.add(sample); sample.close()`). A returned canvas is wrapped
 * into a fresh VideoSample carrying the source sample's timestamp.
 *
 * Trimmed export (v1.15.0 REQ-126): with non-empty `settings.trims`, the
 * export EXCLUDES every trimmed region. One native mediabunny `trim`
 * Conversion runs per KEPT segment (burn-in applies per segment; audio
 * packet-copies per segment — same invariants as the single pass), then the
 * segments' ENCODED packets are concatenated into ONE final Output via
 * EncodedVideoPacketSource/EncodedAudioPacketSource with shifted timestamps
 * (no re-encode of already-encoded segments). Segment temps + the final temp
 * are deleted in every path (REQ-021/AC-14). With no trims the single-pass
 * path below runs byte-for-byte unchanged.
 *
 * Depends on: mediabunny Conversion, redact.js, OPFS / File System Access.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferSource,
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  canEncodeVideo,
} from 'mediabunny';
import { pixelateFrame } from './redact.js';
import { scaleFactorFor } from './analyze.js';
import './types.js';

/**
 * Typed export failure carrying the ladder stage — REQ-021 maps `stage` to
 * the user-facing message shown in #export-status / toast.
 *
 * @extends Error
 */
export class ExportError extends Error {
  /**
   * @param {string} stage 'encode-avc' | 'encode-avc-software' | 'encode-vp9'
   *     | 'mux' | 'io' | 'cancelled'
   * @param {string} message
   * @param {{cause?: unknown}} [opts]
   */
  constructor(stage, message, opts) {
    super(message, opts);
    this.name = 'ExportError';
    this.stage = stage;
  }
}

/** OPFS directory (below the root) that holds export staging files. */
const STAGING_DIR = 'exports';

/** Prefix identifying OUR staging files for crash-recovery listing (main.js). */
const STAGING_PREFIX = 'redact-export-';

/**
 * Codec ladder rungs in ADR-7 order. `hw` is the WebCodecs hardware
 * acceleration hint used for both the probe and the conversion.
 * @type {Array<{codec: 'avc'|'vp9', hw: 'prefer-hardware'|'prefer-software'|'no-preference',
 *               Format: typeof Mp4OutputFormat | typeof WebMOutputFormat,
 *               stage: string, ext: string, mime: string}>}
 */
const LADDER = [
  { codec: 'avc', hw: 'prefer-hardware', Format: Mp4OutputFormat, stage: 'encode-avc', ext: 'mp4', mime: 'video/mp4' },
  { codec: 'avc', hw: 'prefer-software', Format: Mp4OutputFormat, stage: 'encode-avc-software', ext: 'mp4', mime: 'video/mp4' },
  { codec: 'vp9', hw: 'no-preference', Format: WebMOutputFormat, stage: 'encode-vp9', ext: 'webm', mime: 'video/webm' },
];

/** Monotonic suffix component for staging file names. */
let stagingSeq = 0;

/**
 * Create a canvas at the given size (OffscreenCanvas preferred, DOM canvas
 * fallback). Throws when neither exists (non-visual environment) — surfaced
 * as ExportError('io') by the caller.
 *
 * @param {number} w
 * @param {number} h
 * @returns {OffscreenCanvas | HTMLCanvasElement}
 */
function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    // DOM fallback must carry the SIZE too — a bare createElement('canvas')
    // defaults to 300×150 and would scale the first burned frame.
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  }
  throw new Error('No canvas implementation available for burn-in export.');
}

/**
 * THE redaction composition shared by export and preview (AC-04 pixel-truth
 * symmetry): `tracksAt(t)` hits, each box dilated 15% and clamped to the
 * frame, then rendered per the track's style (`pixelate` → applyPixelation
 * with the caller's reused scratch canvas; `solid` → opaque black fillRect,
 * REQ-101/102 — dispatch lives inside redact.pixelateFrame).
 *
 * Implemented in redact.js (single source of truth — the editor's review
 * canvas calls the same function, so preview pixels equal exported pixels)
 * and re-exported here for the burn-in path and its tests.
 */
export { pixelateFrame };

/**
 * Build the burn-in `video.process` callback for one ladder attempt: a
 * reused frame canvas at source display size + a reused pixelation scratch.
 * Failures inside the burn-in (density invariant, canvas loss) are wrapped
 * as ExportError carrying the attempt's stage so the attempt loop fails
 * fast without burning the remaining ladder.
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} width Display px.
 * @param {number} height Display px.
 * @param {string} stage Ladder stage of the current attempt.
 * @param {boolean} [lockSize] When true the frame canvas NEVER follows the
 *     sample's native dims (export downscale — the canvas defines resolution).
 * @param {('fine'|'normal'|'coarse'|'max')} [strength] Pixelation strength
 *     forwarded into pixelateFrame → applyPixelation (v1.17.0). Invalid or
 *     missing values resolve to the shared default 'normal' (×2 block size)
 *     inside redact.pixelStrengthMultiplier — preview and export land on the
 *     SAME multiplier (AC-04 shared-seam rule).
 * @param {{text: string, corner: 'tl'|'tr'|'bl'|'br', opacity: number} | null}
 *     [watermark] Normalized watermark (normalizeWatermark) drawn AFTER the
 *     redaction mosaic on every frame (v1.22.0 REQ-133) — the overlay must
 *     stay plain and legible, never pixelated with the faces. null → nothing.
 * @returns {{process: (sample: object) => OffscreenCanvas | HTMLCanvasElement,
 *            frameCanvas: OffscreenCanvas | HTMLCanvasElement,
 *            scratchCanvas: OffscreenCanvas | HTMLCanvasElement}}
 */
function createBurnIn(tracks, width, height, stage, lockSize = false, strength, watermark = null) {
  const frameCanvas = createCanvas(width, height);
  const scratchCanvas = createCanvas(1, 1);
  const ctx = /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} */ (
    frameCanvas.getContext('2d')
  );
  let knownW = width;
  let knownH = height;
  const wm = normalizeWatermark(watermark);
  // REQ-133: text is measured ONCE per canvas size (the font scales with the
  // frame height), never per frame — the cache key is the frame height, which
  // fully determines both the font px and the re-measure need.
  let wmMeasuredH = -1;
  let wmTextWidth = 0;

  /**
   * Draw the watermark overlay (REQ-133) in display space: 600-weight
   * system-ui at 4% of the frame height, white at the configured opacity,
   * inset 2% of the frame from the chosen corner's edges.
   * @param {number} w Current frame width.
   * @param {number} h Current frame height.
   * @returns {void}
   */
  function drawWatermark(w, h) {
    if (!wm) return;
    const fontPx = Math.max(8, Math.round(h * 0.04));
    const font = `600 ${fontPx}px system-ui`;
    if (wmMeasuredH !== h) {
      ctx.font = font;
      wmTextWidth = Number(ctx.measureText?.(wm.text)?.width ?? 0);
      wmMeasuredH = h;
    } else {
      ctx.font = font;
    }
    const mx = w * 0.02;
    const my = h * 0.02;
    const right = w - mx - wmTextWidth;
    const top = my + fontPx; // baseline sits one font-height under the margin
    const bottom = h - my;
    const x = wm.corner === 'tl' || wm.corner === 'bl' ? mx : right;
    const y = wm.corner === 'tl' || wm.corner === 'tr' ? top : bottom;
    ctx.save();
    ctx.globalAlpha = wm.opacity;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(wm.text, x, y);
    ctx.restore();
  }

  /**
   * @param {object} sample mediabunny VideoSample (timestamp in seconds;
   *     displayWidth/Height are rotation-applied). MUST NOT be closed here —
   *     the Conversion pipeline owns and closes it (see module doc).
   * @returns {OffscreenCanvas | HTMLCanvasElement} The reused frame canvas.
   */
  function process(sample) {
    try {
      // v1.16.0: with a locked size (export downscale) the canvas NEVER
      // follows the sample's native dims — the sample draws INTO the scaled
      // canvas, which defines the output resolution.
      const w = lockSize ? knownW : Number(sample.displayWidth) || knownW;
      const h = lockSize ? knownH : Number(sample.displayHeight) || knownH;
      if (!lockSize && (w !== knownW || h !== knownH)) {
        // Resolution changed mid-stream (rare): resize resets the bitmap.
        frameCanvas.width = w;
        frameCanvas.height = h;
        knownW = w;
        knownH = h;
      }
      // VideoSample.draw applies rotation/flip metadata (AC-15): the canvas
      // is upright display space, matching the display-oriented track boxes.
      sample.draw(ctx, 0, 0, w, h);
      pixelateFrame(ctx, tracks, sample.timestamp, { width: w, height: h }, { scratch: scratchCanvas, strength });
      // REQ-133: the watermark renders AFTER pixelation (plain, legible —
      // never mosaic-filtered with the redaction boxes).
      drawWatermark(w, h);
      return frameCanvas;
    } catch (err) {
      // tracksAt density violation or renderer failure: wrap as ExportError so
      // the attempt loop surfaces it WITHOUT retrying other codec rungs.
      throw new ExportError(
        stage,
        `Burn-in failed at t=${sample.timestamp}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  return { process, frameCanvas, scratchCanvas };
}

/**
 * The legal watermark corners (REQ-133), in #watermark-corner select order.
 * @type {Array<'tl'|'tr'|'bl'|'br'>}
 */
export const WATERMARK_CORNERS = ['tl', 'tr', 'bl', 'br'];

/**
 * Normalize the optional watermark settings (v1.22.0 REQ-133). PURE —
 * returns a sanitized `{text, corner, opacity}` or **null** when no watermark
 * should render (settings absent / text blank after trimming). An unknown
 * corner falls back to 'br'; a non-finite or out-of-range opacity falls back
 * to 0.5 (then clamped to [0, 1]). Exported so main.js wiring normalizes the
 * UI values through the SAME rule the burn-in applies (one source of truth).
 *
 * @param {{text?: unknown, corner?: unknown, opacity?: unknown}} [raw]
 * @returns {{text: string, corner: 'tl'|'tr'|'bl'|'br', opacity: number} | null}
 */
export function normalizeWatermark(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const text = String(src.text ?? '').trim();
  if (!text) return null;
  const corner = /** @type {typeof WATERMARK_CORNERS[number]} */ (
    WATERMARK_CORNERS.includes(/** @type {any} */ (src.corner)) ? src.corner : 'br'
  );
  const opacityRaw = Number(src.opacity);
  const opacity = Number.isFinite(opacityRaw)
    ? Math.min(1, Math.max(0, opacityRaw))
    : 0.5;
  return { text, corner, opacity };
}

/**
 * Resolve the primary video track's rotation-applied display size.
 *
 * @param {object} input Mediabunny `Input`.
 * @returns {Promise<{width: number, height: number}>}
 * @throws {ExportError} stage 'io' when no video track exists.
 */
async function primaryFrameSize(input) {
  let track = null;
  try {
    track = await input.getPrimaryVideoTrack();
  } catch (err) {
    throw new ExportError('io', 'Could not read the video track for export.', { cause: err });
  }
  if (!track) throw new ExportError('io', 'The source has no video track to export.');
  const width = Number(await (track.getDisplayWidth?.() ?? track.displayWidth) ?? 0);
  const height = Number(await (track.getDisplayHeight?.() ?? track.displayHeight) ?? 0);
  if (!(width > 0 && height > 0)) {
    throw new ExportError('io', 'The video track reports an invalid frame size.');
  }
  return { width, height };
}

/**
 * Probe the ladder up front (AC-12 "capability probing"): every rung is
 * checked with `canEncodeVideo` so hopeless rungs are skipped and the full
 * viable order is known before any encoding starts.
 *
 * @param {number} width
 * @param {number} height
 * @param {{forceWebM?: boolean}} settings
 * @returns {Promise<typeof LADDER>} Viable rungs, ladder order preserved.
 * @throws {ExportError} Deepest probed stage when nothing is viable.
 */
async function probeLadder(width, height, settings) {
  const rungs = settings?.forceWebM ? [LADDER[LADDER.length - 1]] : LADDER;
  /** @type {typeof LADDER} */
  const viable = [];
  for (const rung of rungs) {
    let ok = false;
    try {
      ok = (await canEncodeVideo(rung.codec, {
        width,
        height,
        hardwareAcceleration: rung.hw,
      })) === true;
    } catch {
      ok = false; // a rejecting probe is an unsupported rung
    }
    if (ok) viable.push(rung);
  }
  if (viable.length === 0) {
    const deepest = rungs[rungs.length - 1];
    throw new ExportError(
      deepest.stage,
      `No viable video encode path at ${width}×${height} (tried ${rungs.map((r) => r.codec).join(' → ')}).`,
    );
  }
  return viable;
}

/** settings.quality → mediabunny Quality ('balanced' ≈ encoder 'medium'). */
function mapQuality(quality) {
  return new Quality(quality === 'balanced' ? 'medium' : 'high');
}

/**
 * Scale EVERY track's keyframe boxes by `sf` (v1.16.0 export resolution):
 * pixelateFrame consumes display-space tracks matched to the canvas it draws
 * on, so a downscaled export needs proportionally scaled tracks. PURE —
 * returns a NEW array (input untouched); `sf === 1` returns the input.
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} sf
 * @returns {import('./types.js').Track[]}
 */
export function scaleTracks(tracks, sf) {
  if (!Array.isArray(tracks) || !Number.isFinite(sf) || sf === 1) return tracks;
  return tracks.map((t) => ({
    ...t,
    keyframes: new Map(
      [...t.keyframes].map(([kt, b]) => [
        kt,
        { x: b.x * sf, y: b.y * sf, w: b.w * sf, h: b.h * sf },
      ]),
    ),
  }));
}

/**
 * Export geometry for the chosen resolution (v1.16.0): scale factor + the
 * integer output dimensions. PURE. `full`/unknown → 1.
 *
 * @param {'full'|'1080p'|'720p'|undefined} resolution
 * @param {number} width Source display width.
 * @param {number} height Source display height.
 * @returns {{sf: number, outW: number, outH: number}}
 */
export function exportGeometry(resolution, width, height) {
  const sf = scaleFactorFor(resolution, width, height);
  return {
    sf,
    outW: Math.max(1, Math.round(width * sf)),
    outH: Math.max(1, Math.round(height * sf)),
  };
}

/**
 * Create the OPFS staging file for one stream attempt.
 *
 * @param {string} ext Output extension ('mp4' | 'webm').
 * @returns {Promise<{kind: 'stream', dir: object, handle: object, name: string, opfsPath: string, canStream: boolean}>}
  * @throws {ExportError} stage 'io' when OPFS is unavailable.
 */
async function stageInOpfs(ext) {
  let root;
  try {
    root = await globalThis.navigator?.storage?.getDirectory();
    if (!root) throw new Error('OPFS unavailable');
  } catch (err) {
    throw new ExportError('io', 'Origin-private file storage (OPFS) is unavailable for export staging.', { cause: err });
  }
  let dir;
  try {
    dir = await root.getDirectoryHandle(STAGING_DIR, { create: true });
  } catch (err) {
    throw new ExportError('io', `Could not open the ${STAGING_DIR}/ staging directory.`, { cause: err });
  }
  const name = `${STAGING_PREFIX}${Date.now()}-${(stagingSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  let handle;
  try {
    handle = await dir.getFileHandle(name, { create: true });
  } catch (err) {
    throw new ExportError('io', `Could not create staging file ${STAGING_DIR}/${name}.`, { cause: err });
  }
  // v1.24.0: some mobile browsers (iOS Safari < 17.4, Firefox mobile) lack
  // OPFS createWritable — signal that so runExport can fall back to
  // in-memory staging instead of failing the whole export.
  const canStream = typeof handle.createWritable === 'function';
  return { kind: 'stream', dir, handle, name, opfsPath: `${STAGING_DIR}/${name}`, canStream };
}

/**
 * Wrap the staging file's writable in a real WritableStream that forwards
 * StreamTargetChunks untouched (StreamTarget requires a `WritableStream`
 * instance) while counting delivered bytes and capturing write failures so
 * they can be classified as ExportError('io') instead of ladder failures.
 *
 * @param {object} fileHandle OPFS file handle with createWritable().
 * @returns {Promise<{writable: WritableStream<object>, bytes: () => number,
 *                     ioError: () => unknown}>}
 */
async function countingWritable(fileHandle) {
  const writer = await (await fileHandle.createWritable()).getWriter();
  let bytes = 0;
  let ioErr = null;
  const writable = new WritableStream({
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (err) {
        ioErr = err;
        throw err;
      }
      bytes += chunk?.data?.byteLength ?? 0;
    },
    async abort(reason) {
      ioErr = ioErr ?? reason;
      try {
        await writer.abort?.(reason);
      } catch {
        // abort is best-effort; the temp file is removed by the caller
      }
    },
    close() {
      return writer.close();
    },
  });
  return { writable, bytes: () => bytes, ioError: () => ioErr };
}

/** Best-effort temp removal (REQ-019/AC-14): never masks the primary error. */
async function removeTemp(staging) {
  if (!staging || staging.kind !== 'stream') return;
  try {
    await staging.dir.removeEntry(staging.name);
  } catch {
    // Already gone or unwritable — the crash-recovery sweep handles strays.
  }
}

/**
 * Acquire export staging with a MOBILE-SAFE fallback (v1.24.0): OPFS
 * stream staging when the browser supports createWritable; otherwise an
 * in-memory BufferTarget so exports on iOS Safari < 17.4 / Firefox mobile
 * still succeed (delivered as a Blob download). Returns the staging object
 * plus a `fallback` flag so the caller can inform the user.
 *
 * @param {string} ext File extension for the staging file.
 * @param {boolean} [forceBuffer] Skip OPFS entirely (outputMode 'buffer').
 * @returns {Promise<{kind: 'stream'|'buffer', dir?: object, handle?: object,
 *                     name?: string, opfsPath?: string, target?: object,
 *                     canStream: boolean, fallback: boolean}>}
 * @throws {ExportError} stage 'io' when even the buffer fallback fails.
 */
/**
 * @returns {Promise<{kind: 'stream'|'buffer', dir?: object, handle?: object,
 *                     name?: string, opfsPath?: string, target?: object,
 *                     canStream: boolean, fallback: boolean}>}
 */
async function acquireStaging(ext, forceBuffer = false) {
  if (!forceBuffer) {
    try {
      const staging = await stageInOpfs(ext);
      if (staging.handle && typeof staging.handle.createWritable === 'function') {
        return { ...staging, canStream: true, fallback: false };
      }
      // Handle exists but createWritable is missing — fall through to buffer.
    } catch (err) {
      // OPFS unavailable entirely — fall through to buffer.
      if (!(err instanceof ExportError)) throw err;
    }
  }
  return { kind: 'buffer', target: new BufferTarget(), canStream: false, fallback: true };
}

/**
 * Pipe a Blob (OPFS File or in-memory buffer) into a destination file
 * handle's writable; pipeTo closes the destination (seals the file).
 *
 * @param {object} fileHandle Handle with createWritable().
 * @param {Blob} blob
 * @returns {Promise<void>}
 */
async function pipeInto(fileHandle, blob) {
  const writable = await fileHandle.createWritable();
  await blob.stream().pipeTo(writable);
}

/**
 * Trigger a Blob download when a DOM is present (worker contexts skip this;
 * the blob is still returned to the caller).
 *
 * @param {Blob} blob
 * @param {string} filename
 * @returns {void}
 */
function triggerDownload(blob, filename) {
  if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Deliver a finished export (REQ-019): saveHandle → picker → Blob download.
 * Exactly one channel is populated. The staging temp is deleted in every
 * delivered path; a user-cancelled picker falls back to the Blob channel so
 * a completed export is never lost.
 *
 * @param {object} staging Staging descriptor ({kind:'stream',...}|{kind:'buffer',...}).
 * @param {Blob} blob Final output bytes.
 * @param {object} settings runExport settings.
 * @param {number} bytes Total byte count.
 * @param {string} ext Output extension.
 * @param {string} mime Output MIME type.
 * @returns {Promise<{blob?: Blob, handle: object|null, opfsPath: undefined, bytes: number}>}
 *     `opfsPath` is always undefined on return: temps are deleted before the
 *     result is produced (kept in the shape for forward compatibility).
 */
async function deliver(staging, blob, settings, bytes, ext, mime) {
  const filename = `redacted-${Date.now()}.${ext}`;

  if (settings?.saveHandle) {
    await pipeInto(settings.saveHandle, blob);
    await removeTemp(staging);
    return { handle: settings.saveHandle, opfsPath: undefined, bytes };
  }

  // v1.29.0 iOS path: iOS Safari ignores <a download> for blob URLs, so
  // the Web Share API is the ONLY reliable delivery there. Preferred
  // whenever the file is shareable (Safari 15+; keep the blob alive — iOS
  // reads it lazily after share resolves).
  const shareFile = globalThis.navigator?.share?.bind(globalThis.navigator);
  // v1.31.0 regression fix: the Web Share path is for iOS Safari — the ONE
  // environment where <a download> fails. Desktop Chromium supports BOTH
  // share and showSaveFilePicker, and the picker is better there (direct
  // save dialog). Gating share on the ABSENCE of showSaveFilePicker routes
  // desktop Chromium to the picker and mobile Safari/iOS to share — each
  // browser gets its best channel. Probe seam: `preferShare` override.
  const sharePreferred =
    shareFile &&
    typeof globalThis.showSaveFilePicker !== 'function' &&
    typeof globalThis.navigator.canShare === 'function' &&
    (() => {
      try {
        const probe = new Blob([new Uint8Array(8)], { type: mime });
        return globalThis.navigator.canShare({ files: [new File([probe], filename, { type: mime })] });
      } catch {
        return false;
      }
    })();
  if (sharePreferred) {
    await shareFile({ files: [new File([blob], filename, { type: mime })] });
    await removeTemp(staging);
    return { blob, handle: null, opfsPath: undefined, bytes };
  }

  const picker = globalThis.showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName: filename,
        types: [{ description: 'Redacted video', accept: { [mime]: [`.${ext}`] } }],
      });
      await pipeInto(handle, blob);
      await removeTemp(staging);
      return { handle, opfsPath: undefined, bytes };
    } catch {
      // Picker refused/cancelled — fall through to the Blob channel.
    }
  }

  // Blob-download channel. @MX:WARN the staging File must be SNAPSHOT into
  // an in-memory Blob BEFORE the temp entry is removed: a blob URL over an
  // OPFS File whose backing entry was deleted resolves as a CANCELED
  // download (Chrome re-reads the backing file lazily — deleting even right
  // after anchor.click() still races the download's read). The snapshot
  // costs one in-memory copy of the output at delivery, same as
  // outputMode 'buffer'.
  const safeBlob = staging.kind === 'buffer'
    ? blob
    : new Blob([await blob.arrayBuffer()], { type: mime });
  await removeTemp(staging);
  triggerDownload(safeBlob, filename);
  return { blob: safeBlob, handle: null, opfsPath: undefined, bytes };
}

// ---------------------------------------------------------------------------
// Trimmed export (v1.15.0 REQ-126)
// ---------------------------------------------------------------------------

/** Progress split: the per-segment Conversions own 0–0.85, concat 0.85–1. */
const SEGMENT_PROGRESS_SHARE = 0.85;

/**
 * Shape-check one raw trim entry (defensive — main.js's pure model guarantees
 * this, but the settings object crosses a boundary).
 * @param {unknown} t
 * @returns {boolean}
 */
function isValidTrim(t) {
  if (!t || typeof t !== 'object') return false;
  const r = /** @type {{start?: unknown, end?: unknown}} */ (t);
  return (
    Number.isFinite(Number(r.start)) &&
    Number.isFinite(Number(r.end)) &&
    Number(r.end) > Number(r.start)
  );
}

/**
 * Complement of the trim regions over [0, durationSec] — the kept segments
 * that survive into the output, in order. Private mirror of main.js's
 * exported `keptSegments` (importing main.js here would be a module cycle;
 * the unit suites pin BOTH sides to the same fixtures).
 *
 * @param {Array<{start: number, end: number}>} trims Sorted, non-overlapping.
 * @param {number} durationSec Video duration (> 0).
 * @returns {Array<{start: number, end: number}>} Empty trims → [{0, dur}];
 *     full coverage → [].
 */
function keptSegmentsOf(trims, durationSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!(dur > 0)) return [];
  /** @type {Array<{start: number, end: number}>} */
  const kept = [];
  let cursor = 0;
  for (const r of Array.isArray(trims) ? trims : []) {
    const a = Math.min(Math.max(Number(r.start), 0), dur);
    const b = Math.min(Math.max(Number(r.end), 0), dur);
    if (b <= cursor) continue;
    if (a > cursor) kept.push({ start: cursor, end: Math.min(a, dur) });
    cursor = Math.max(cursor, b);
    if (cursor >= dur) break;
  }
  if (cursor < dur) kept.push({ start: cursor, end: dur });
  return kept;
}

/**
 * Throw ExportError('cancelled') when the abort signal has fired.
 * @param {AbortSignal} [signal]
 * @returns {void}
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ExportError('cancelled', 'Export cancelled.');
  }
}

/**
 * Concatenate the encoded packets of the per-segment temp files into ONE
 * final output (REQ-126): each segment temp is reopened as a mediabunny
 * Input, its video/audio packets are pulled in decode order via
 * EncodedPacketSink, timestamp-shifted by the running kept duration (the
 * segment temps are rebased to ~0 by mediabunny's trim — see the loop below)
 * and re-added through ONE EncodedVideoPacketSource / EncodedAudioPacketSource
 * pair — no re-encode of already-encoded segments. The FIRST segment's
 * decoder config rides the track metadata (the container needs it exactly
 * once; segments written by the same Conversion ladder share the codec).
 * A/V sync holds because video and audio packets of a segment get the SAME
 * offset. Delivery + final-temp cleanup ride the shared deliver().
 *
 * @param {Array<{kind: 'stream'|'buffer', dir?: object, handle?: object, name?: string, opfsPath?: string, target?: object, canStream?: boolean, fallback?: boolean}>} segStagings
 * @param {typeof LADDER[number]} rung
 * @param {object} settings runExport settings.
 * @param {Array<{start: number, end: number}>} kept Kept segments (same
 *     order as segStagings).
 * @param {(progress: {ratio: number, bytesWritten?: number}) => void} [onProgress]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{blob?: Blob, handle: object|null, opfsPath: undefined, bytes: number}>}
 * @throws {ExportError} 'mux' for any assembly failure (terminal — no ladder
 *     retry), 'cancelled' on abort; delivery errors propagate as-is.
 */
async function concatKeptSegments(segStagings, rung, settings, kept, onProgress, signal) {
  /** @type {object[]} */
  const segInputs = [];
  /** @type {{kind:'buffer', target: BufferTarget} | Awaited<ReturnType<typeof stageInOpfs>> | null} */
  let finalStaging = null;
  /** @type {{writable?: WritableStream<object>, bytes?: () => number, ioError?: () => unknown} | null} */
  let stream = null;
  try {
    for (const staging of segStagings) {
      // v1.24.0: segment stagings may be OPFS streams or in-memory buffers
      // (mobile fallback) — both reopen as Inputs for the concat pass.
      if (staging.kind === 'buffer') {
        const bytes = new Uint8Array(staging.target.buffer ?? new Uint8Array(0));
        segInputs.push(new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS }));
      } else {
        const file = await staging.handle.getFile();
        segInputs.push(new Input({ source: new BlobSource(file), formats: ALL_FORMATS }));
      }
    }

    // Codec identity + decoder configs come from the FIRST segment.
    const firstVideo = await segInputs[0].getPrimaryVideoTrack();
    if (!firstVideo) throw new Error('The first kept segment has no video track.');
    const videoConfig = await firstVideo.getDecoderConfig();
    const firstAudio = settings.removeAudio
      ? null
      : (await segInputs[0].getAudioTracks())[0] ?? null;
    const audioConfig = firstAudio ? await firstAudio.getDecoderConfig() : null;

    if (settings.outputMode === 'buffer') {
      finalStaging = { kind: 'buffer', target: new BufferTarget() };
    } else {
      finalStaging = await stageInOpfs(rung.ext);
    }
    /** @type {Output} */
    let output;
    if (finalStaging.kind === 'buffer') {
      output = new Output({ format: new rung.Format(), target: finalStaging.target });
    } else {
      stream = await countingWritable(finalStaging.handle);
      output = new Output({
        format: new rung.Format(),
        target: new StreamTarget(stream.writable, { chunked: true }),
      });
    }

    const videoSource = new EncodedVideoPacketSource(firstVideo.codec);
    output.addVideoTrack(
      videoSource,
      videoConfig ? { decoderConfig: videoConfig } : undefined,
    );
    /** @type {EncodedAudioPacketSource | null} */
    let audioSource = null;
    if (firstAudio) {
      audioSource = new EncodedAudioPacketSource(firstAudio.codec);
      output.addAudioTrack(
        audioSource,
        audioConfig ? { decoderConfig: audioConfig } : undefined,
      );
    }
    await output.start();

    /**
     * Shift one packet's timestamps by `offset` — a fresh EncodedPacket
     * (constructor: data, type, timestamp, duration, sequenceNumber?,
     * byteLength?, sideData?) carrying the ORIGINAL side data.
     * @param {object} packet
     * @param {number} offset
     * @returns {EncodedPacket}
     */
    const shifted = (packet, offset) =>
      new EncodedPacket(
        packet.data,
        packet.type,
        packet.timestamp + offset,
        packet.duration,
        packet.sequenceNumber,
        packet.byteLength,
        packet.sideData,
      );

    let cumulative = 0;
    const total = segInputs.length;
    // Per-track guard state for the muxer's monotonic key-packet rule
    // (muxer.js: a key packet's timestamp must not undercut the largest
    // timestamp before the previous key packet). Segment temps are REBASED by
    // the trim region to start at ~0 (verified against mediabunny 1.63.0:
    // transcode AND copy tracks alike), so the concat offset is simply the
    // running kept duration — uniform per segment, which preserves A/V sync.
    // Copied audio may carry a few PRIMING packets with slightly negative
    // rebased timestamps (they cover the trimmed region just before
    // trim.start) — those are skipped so each seam stays monotonic.
    let lastVideoTs = -Infinity;
    let lastAudioTs = -Infinity;
    for (let i = 0; i < total; i++) {
      throwIfAborted(signal);
      const seg = kept[i];
      const offset = cumulative;
      const vin = i === 0 ? firstVideo : await segInputs[i].getPrimaryVideoTrack();
      if (!vin) throw new Error(`Kept segment ${i} has no video track.`);
      const vsink = new EncodedPacketSink(vin);
      for await (const packet of vsink.packets()) {
        const ts = packet.timestamp + offset;
        // Delta (B-frame) packets may legally dip below the running max —
        // only KEY packets are guarded (mirrors the muxer rule exactly).
        if (packet.type === 'key' && (ts <= lastVideoTs || ts < 0)) continue;
        lastVideoTs = Math.max(lastVideoTs, ts);
        await videoSource.add(shifted(packet, offset));
      }
      const ain = firstAudio
        ? i === 0
          ? firstAudio
          : ((await segInputs[i].getAudioTracks())[0] ?? null)
        : null;
      if (ain && audioSource) {
        const asink = new EncodedPacketSink(ain);
        for await (const packet of asink.packets()) {
          const ts = packet.timestamp + offset;
          if (packet.type === 'key' && (ts <= lastAudioTs || ts < 0)) continue;
          lastAudioTs = Math.max(lastAudioTs, ts);
          await audioSource.add(shifted(packet, offset));
        }
      }
      cumulative += seg.end - seg.start;
      onProgress?.({
        ratio: SEGMENT_PROGRESS_SHARE + ((i + 1) / total) * (1 - SEGMENT_PROGRESS_SHARE),
        bytesWritten: stream ? stream.bytes() : undefined,
      });
    }

    await output.finalize();
    const bytes = finalStaging.kind === 'buffer'
      ? Number(finalStaging.target.buffer?.byteLength ?? 0)
      : stream ? stream.bytes() : 0;
    const blob = finalStaging.kind === 'buffer'
      ? new Blob([finalStaging.target.buffer ?? new Uint8Array(0)], { type: rung.mime })
      : await finalStaging.handle.getFile();
    return await deliver(finalStaging, blob, settings, bytes, rung.ext, rung.mime);
  } catch (err) {
    if (finalStaging) await removeTemp(finalStaging);
    if (err instanceof ExportError) throw err;
    if (err instanceof ConversionCanceledError || signal?.aborted) {
      throw new ExportError('cancelled', 'Export cancelled.', { cause: err });
    }
    // REQ-021: a concat/mux failure is terminal — the encoded segments are
    // fine, retrying the ladder cannot help. Never a silent corrupt file.
    throw new ExportError(
      'mux',
      `Concatenating the kept segments failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  } finally {
    for (const input of segInputs) {
      try {
        input.dispose?.();
      } catch {
        /* already disposed / racing teardown — the drop is what matters */
      }
    }
  }
}

/**
 * Multi-segment trimmed export (v1.15.0 REQ-126): one trimmed Conversion per
 * kept segment (burn-in + packet-copied audio, identical settings to the
 * single pass), then packet concatenation into one output. Same ladder
 * semantics as the single pass: a segment ENCODE failure advances the rung;
 * mux/io/cancelled are terminal. ALL temps (segments + final) are removed on
 * every failure path (REQ-021/AC-14).
 *
 * @param {object} args
 * @param {object} args.input Mediabunny `Input`.
 * @param {import('./types.js').Track[]} args.tracks Enabled tracks (burn-in).
 * @param {object} args.settings runExport settings (trims already validated).
 * @param {Array<{start: number, end: number}>} args.trims Validated trims.
 * @param {(progress: {ratio: number, bytesWritten?: number}) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 * @param {typeof LADDER} args.rungs Viable ladder rungs.
 * @param {number} args.width Display px.
 * @param {number} args.height Display px.
 * @returns {Promise<{blob?: Blob, handle: object|null, opfsPath: undefined, bytes: number}>}
 */
async function runTrimmedExport({
  input,
  tracks,
  settings,
  trims,
  onProgress,
  signal,
  rungs,
  width,
  height,
}) {
  let durationSec = 0;
  try {
    durationSec = await input.computeDuration();
  } catch (err) {
    throw new ExportError('io', 'Could not read the source duration for the trimmed export.', { cause: err });
  }
  if (!(Number.isFinite(durationSec) && durationSec > 0)) {
    throw new ExportError('io', 'The source duration is unusable for the trimmed export.');
  }
  const kept = keptSegmentsOf(trims, durationSec);
  if (kept.length === 0) {
    throw new ExportError('io', 'Every part of the video is trimmed — there is nothing left to export.');
  }

  /** @type {unknown} */
  let lastError = null;
  let lastStage = rungs[0].stage;

  for (const rung of rungs) {
    /** @type {Array<{kind: 'stream'|'buffer', dir?: object, handle?: object, name?: string, opfsPath?: string, target?: object, canStream?: boolean, fallback?: boolean}>} */
    const segStagings = [];
    try {
      // -- Phase 1: one trimmed Conversion per kept segment ----------------
      let bytesSoFar = 0;
      for (let i = 0; i < kept.length; i++) {
        throwIfAborted(signal);
        const seg = kept[i];
        const staging = await acquireStaging(rung.ext, settings.outputMode === 'buffer');
        segStagings.push(staging);
        let segStream = null;
        let output;
        if (staging.kind === 'buffer') {
          output = new Output({ format: new rung.Format(), target: staging.target });
        } else {
          segStream = await countingWritable(staging.handle);
          output = new Output({
            format: new rung.Format(),
            target: new StreamTarget(segStream.writable, { chunked: true }),
          });
        }
        // v1.16.0: export resolution — same scaling as the single pass.
        const { sf: segSf, outW: segOutW, outH: segOutH } = exportGeometry(
          settings.exportResolution, width, height,
        );
        const burn = createBurnIn(scaleTracks(tracks, segSf), segOutW, segOutH, rung.stage, segSf !== 1, settings.pixelStrength, normalizeWatermark(settings.watermark));
        // Same invariant as the single pass: NO `copy` override — the audio
        // track packet-copies within the segment window (REQ-017 / AC-08),
        // unless the user removed the audio track.
        const conversion = await Conversion.init({
          input,
          output,
          trim: { start: seg.start, end: seg.end },
          video: {
            codec: rung.codec,
            quality: mapQuality(settings.quality),
            hardwareAcceleration: rung.hw,
            process: burn.process,
            ...(segSf !== 1 ? { processedWidth: segOutW, processedHeight: segOutH } : {}),
          },
          ...(settings.removeAudio ? { audio: { discard: true } } : {}),
        });
        if (!conversion.isValid) {
          const reasons = (conversion.discardedTracks ?? [])
            .map((d) => `${d.track?.type ?? 'track'}: ${d.reason}`)
            .join('; ');
          throw new Error(`Conversion configuration is invalid (${reasons || 'no usable tracks'}).`);
        }
        const segIndex = i;
        conversion.onProgress = (ratio) => {
          onProgress?.({
            ratio:
              ((segIndex + (Number.isFinite(ratio) ? ratio : 0)) / kept.length) *
              SEGMENT_PROGRESS_SHARE,
            bytesWritten: bytesSoFar + (segStream ? segStream.bytes() : 0),
          });
        };
        const onAbort = () => void conversion.cancel();
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
          await conversion.execute();
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
        bytesSoFar += segStream ? segStream.bytes() : 0;
      }

      // -- Phase 2: concat the encoded packets into ONE output -------------
      const result = await concatKeptSegments(
        segStagings,
        rung,
        settings,
        kept,
        onProgress,
        signal,
      );
      // Delivered — the per-segment temps are dead weight now. removeTemp is
      // best-effort and never masks the result.
      for (const staging of segStagings) await removeTemp(staging);
      return result;
    } catch (err) {
      for (const staging of segStagings) await removeTemp(staging);

      if (err instanceof ExportError) {
        // Our own classification (mux / io / cancelled / burn-in): final.
        throw err;
      }
      if (err instanceof ConversionCanceledError || signal?.aborted) {
        throw new ExportError('cancelled', 'Export cancelled.', { cause: err });
      }
      // Encode/pipeline failure at runtime — try the next rung (AC-12).
      lastError = err;
      lastStage = rung.stage;
    }
  }

  throw new ExportError(
    lastStage,
    `All encode paths failed (deepest: ${lastStage}): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }. No output file was delivered.`,
    { cause: lastError },
  );
}

/**
 * Run the burn-in export.
 *
 * @param {object} opts
 * @param {object} opts.input Mediabunny `Input` (reopened or reused from ingest).
 * @param {import('./types.js').Track[]} [opts.tracks] ENABLED tracks only matter —
 *     burn-in asks redact.tracksAt(t) per sample; disabled tracks are ignored.
 * @param {{quality?: 'high'|'balanced', outputMode?: 'stream'|'buffer',
 *           saveHandle?: object, forceWebM?: boolean,
 *           dashcamMode?: boolean, padSeconds?: number,
 *           exportResolution?: 'full'|'1080p'|'720p',
 *           removeAudio?: boolean,
 *           pixelStrength?: 'fine'|'normal'|'coarse'|'max',
 *           watermark?: {text?: string, corner?: 'tl'|'tr'|'bl'|'br', opacity?: number},
 *           trims?: Array<{id?: number, start: number, end: number}>}} [opts.settings]
 *     `outputMode` 'stream' (default) stages into OPFS via chunked
 *     StreamTarget; 'buffer' holds the whole file in a BufferTarget (small
 *     clips only). `saveHandle` delivers directly into that handle. See
 *     probeLadder for `forceWebM`. v1.17.0 `pixelStrength` selects the
 *     pixelation block-size multiplier for the burn-in ('fine' ×1 preserves
 *     the v1.16 sizes; default 'normal' ×2; 'coarse' ×3; 'max' ×4) — honored
 *     identically by the preview seam (redact.pixelateFrame). v1.22.0
 *     REQ-133: optional `watermark` overlay — `text` (absent/blank → no
 *     watermark), `corner` ('tl'|'tr'|'bl'|'br', invalid → 'br') and
 *     `opacity` (0–1, default 0.5); normalized once per export via
 *     normalizeWatermark and drawn plain AFTER the redaction mosaic on every
 *     frame. v1.15.0
 *     REQ-126: non-empty `trims` switches to the multi-segment trimmed export
 *     — the output contains only the kept segments, concatenated with
 *     continuous timestamps; empty/undefined trims run the single-pass path
 *     byte-for-byte unchanged.
 * @param {(progress: {ratio: number, bytesWritten?: number}) => void} [opts.onProgress]
 *     `ratio` 0–1 from Conversion.onProgress; `bytesWritten` is the staged
 *     byte count so far (stream mode).
 * @param {AbortSignal} [opts.signal] Triggers `conversion.cancel()` + temp
 *     cleanup; rejection is ExportError('cancelled').
 * @returns {Promise<{blob?: Blob, handle: (FileSystemFileHandle|null),
 *                     opfsPath: undefined, bytes: number}>}
 *     Blob-download path populates `blob` (handle null); save-handle/picker
 *     paths populate `handle` — exactly one delivery channel per run. The
 *     staged temp is always deleted before this resolves (REQ-019), so
 *     `opfsPath` is always undefined.
 * @throws {import('./exporter.js').ExportError} On every failure with the
 *     deepest ladder `stage` reached; 'cancelled' after cancellation (AC-14);
 *     'io' for staging/write failures; rung stages for encode failures with
 *     the underlying error as `cause` (REQ-021: never a silent corrupt file).
 */
export async function runExport(opts) {
  const { input, tracks = [], settings = {}, onProgress, signal } = opts ?? {};

  if (signal?.aborted) {
    throw new ExportError('cancelled', 'Export cancelled before it started.');
  }

  const { width, height } = await primaryFrameSize(input);
  const rungs = await probeLadder(width, height, settings);

  // v1.15.0 REQ-126: non-empty trims → multi-segment export (kept segments
  // only, concatenated). Empty/undefined → the single-pass path below runs
  // byte-for-byte unchanged (regression-critical).
  const trims = (Array.isArray(settings.trims) ? settings.trims : []).filter(isValidTrim);
  if (trims.length > 0) {
    return runTrimmedExport({
      input,
      tracks,
      settings,
      trims,
      onProgress,
      signal,
      rungs,
      width,
      height,
    });
  }

  /** @type {unknown} */
  let lastError = null;
  let lastStage = rungs[0].stage;

  for (const rung of rungs) {
    // v1.24.0: mobile-safe staging — falls back to in-memory when the
    // browser lacks OPFS createWritable (field report: mobile export IO fail).
    const staging = await acquireStaging(rung.ext, settings.outputMode === 'buffer');

    /** @type {{writable?: WritableStream<object>, bytes?: () => number, ioError?: () => unknown}} */
    let stream;
    try {
      // v1.16.0: export resolution — burn-in canvas + tracks scale together;
      // processedWidth/Height hint the encoder.
      const { sf, outW, outH } = exportGeometry(settings.exportResolution, width, height);
      const exportTracks = scaleTracks(tracks, sf);
      const burn = createBurnIn(exportTracks, outW, outH, rung.stage, sf !== 1, settings.pixelStrength, normalizeWatermark(settings.watermark));
      let output;
      if (staging.kind === 'buffer') {
        output = new Output({ format: new rung.Format(), target: staging.target });
      } else {
        stream = await countingWritable(staging.handle);
        output = new Output({
          format: new rung.Format(),
          target: new StreamTarget(stream.writable, { chunked: true }),
        });
      }

      // NO `copy` override: audio packet-copies into the container that hosts
      // its codec (REQ-017 / AC-08 invariant) — unless the user removed the
      // audio track (v1.16.0).
      const conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: rung.codec,
          quality: mapQuality(settings.quality),
          hardwareAcceleration: rung.hw,
          process: burn.process,
          ...(sf !== 1 ? { processedWidth: outW, processedHeight: outH } : {}),
        },
        ...(settings.removeAudio ? { audio: { discard: true } } : {}),
      });
      if (!conversion.isValid) {
        const reasons = (conversion.discardedTracks ?? [])
          .map((d) => `${d.track?.type ?? 'track'}: ${d.reason}`)
          .join('; ');
        throw new Error(`Conversion configuration is invalid (${reasons || 'no usable tracks'}).`);
      }

      conversion.onProgress = (ratio) => {
        onProgress?.({ ratio, bytesWritten: stream ? stream.bytes() : undefined });
      };

      const onAbort = () => void conversion.cancel();
      signal?.addEventListener('abort', onAbort, { once: true });
      let done;
      try {
        await conversion.execute();
        done = true;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      if (!done) throw new Error('unreachable');

      const bytes = staging.kind === 'buffer'
        ? Number(staging.target.buffer?.byteLength ?? 0)
        : stream ? stream.bytes() : 0;
      const blob = staging.kind === 'buffer'
        ? new Blob([staging.target.buffer ?? new Uint8Array(0)], { type: rung.mime })
        : await staging.handle.getFile();
      return await deliver(staging, blob, settings, bytes, rung.ext, rung.mime);
    } catch (err) {
      await removeTemp(staging);

      if (err instanceof ExportError) {
        // Our own classification (burn-in invariant / staging io): final.
        throw err;
      }
      if (err instanceof ConversionCanceledError || signal?.aborted) {
        throw new ExportError('cancelled', 'Export cancelled.', { cause: err });
      }
      if (stream && stream.ioError() !== null) {
        // Disk write failure: retrying other codecs cannot help (REQ-021).
        throw new ExportError(
          'io',
          `Writing the export file failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
      // Encode/pipeline failure at runtime — try the next rung (AC-12).
      lastError = err;
      lastStage = rung.stage;
    }
  }

  throw new ExportError(
    lastStage,
    `All encode paths failed (deepest: ${lastStage}): ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }. No output file was delivered.`,
    { cause: lastError },
  );
}

/**
 * Delete an orphaned export temp left by a crashed tab (crash-recovery sweep
 * in main.js). Accepts the `<dir>/<name>` opfsPath reported by staging
 * (`exports/redact-export-*.mp4|webm`); a bare file name is resolved in the
 * `exports/` directory.
 *
 * @param {string} opfsPath
 * @returns {Promise<boolean>} true when an entry was removed, false when
 *     nothing was there to remove (missing dir / missing entry).
 * @throws {ExportError} stage 'io' when OPFS is unavailable or the entry
 *     exists but cannot be removed.
 */
export async function discardExportTemp(opfsPath) {
  const segments = String(opfsPath ?? '').split('/').filter(Boolean);
  const dirName = segments.length >= 2 ? segments[0] : STAGING_DIR;
  const fileName = segments[segments.length - 1];
  if (!fileName) throw new ExportError('io', `discardExportTemp: invalid path ${String(opfsPath)}`);

  let root;
  try {
    root = await globalThis.navigator?.storage?.getDirectory();
    if (!root) throw new Error('OPFS unavailable');
  } catch (err) {
    throw new ExportError('io', 'Origin-private file storage (OPFS) is unavailable.', { cause: err });
  }

  let dir;
  try {
    dir = await root.getDirectoryHandle(dirName);
  } catch (err) {
    if (err instanceof Error && err.name === 'NotFoundError') return false;
    throw new ExportError('io', `Could not open ${dirName}/ for cleanup.`, { cause: err });
  }
  try {
    await dir.removeEntry(fileName);
    return true;
  } catch (err) {
    if (err instanceof Error && err.name === 'NotFoundError') return false;
    throw new ExportError('io', `Could not delete ${dirName}/${fileName}.`, { cause: err });
  }
}
