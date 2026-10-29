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
 * Depends on: mediabunny Conversion, redact.js, OPFS / File System Access.
 */
import {
  BufferTarget,
  Conversion,
  ConversionCanceledError,
  Mp4OutputFormat,
  Output,
  Quality,
  StreamTarget,
  WebMOutputFormat,
  canEncodeVideo,
} from 'mediabunny';
import { pixelateFrame } from './redact.js';
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
 * @returns {{process: (sample: object) => OffscreenCanvas | HTMLCanvasElement,
 *            frameCanvas: OffscreenCanvas | HTMLCanvasElement,
 *            scratchCanvas: OffscreenCanvas | HTMLCanvasElement}}
 */
function createBurnIn(tracks, width, height, stage) {
  const frameCanvas = createCanvas(width, height);
  const scratchCanvas = createCanvas(1, 1);
  const ctx = /** @type {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} */ (
    frameCanvas.getContext('2d')
  );
  let knownW = width;
  let knownH = height;

  /**
   * @param {object} sample mediabunny VideoSample (timestamp in seconds;
   *     displayWidth/Height are rotation-applied). MUST NOT be closed here —
   *     the Conversion pipeline owns and closes it (see module doc).
   * @returns {OffscreenCanvas | HTMLCanvasElement} The reused frame canvas.
   */
  function process(sample) {
    try {
      const w = Number(sample.displayWidth) || knownW;
      const h = Number(sample.displayHeight) || knownH;
      if (w !== knownW || h !== knownH) {
        // Resolution changed mid-stream (rare): resize resets the bitmap.
        frameCanvas.width = w;
        frameCanvas.height = h;
        knownW = w;
        knownH = h;
      }
      // VideoSample.draw applies rotation/flip metadata (AC-15): the canvas
      // is upright display space, matching the display-oriented track boxes.
      sample.draw(ctx, 0, 0, w, h);
      pixelateFrame(ctx, tracks, sample.timestamp, { width: w, height: h }, { scratch: scratchCanvas });
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
 * Create the OPFS staging file for one stream attempt.
 *
 * @param {string} ext Output extension ('mp4' | 'webm').
 * @returns {Promise<{kind: 'stream', dir: object, handle: object,
 *                     name: string, opfsPath: string}>}
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
  return { kind: 'stream', dir, handle, name, opfsPath: `${STAGING_DIR}/${name}` };
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

/**
 * Run the burn-in export.
 *
 * @param {object} opts
 * @param {object} opts.input Mediabunny `Input` (reopened or reused from ingest).
 * @param {import('./types.js').Track[]} [opts.tracks] ENABLED tracks only matter —
 *     burn-in asks redact.tracksAt(t) per sample; disabled tracks are ignored.
 * @param {{quality?: 'high'|'balanced', outputMode?: 'stream'|'buffer',
 *           saveHandle?: object, forceWebM?: boolean,
 *           dashcamMode?: boolean, padSeconds?: number}} [opts.settings]
 *     `outputMode` 'stream' (default) stages into OPFS via chunked
 *     StreamTarget; 'buffer' holds the whole file in a BufferTarget (small
 *     clips only). `saveHandle` delivers directly into that handle. See
 *     probeLadder for `forceWebM`.
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

  /** @type {unknown} */
  let lastError = null;
  let lastStage = rungs[0].stage;

  for (const rung of rungs) {
    /** @type {{kind:'buffer', target: BufferTarget} | Awaited<ReturnType<typeof stageInOpfs>>} */
    const staging = settings.outputMode === 'buffer'
      ? { kind: 'buffer', target: new BufferTarget() }
      : await stageInOpfs(rung.ext);

    /** @type {{writable?: WritableStream<object>, bytes?: () => number, ioError?: () => unknown}} */
    let stream;
    try {
      const burn = createBurnIn(tracks, width, height, rung.stage);
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

      // NO `audio` options and NO `copy` override: audio packet-copies into
      // the container that hosts its codec (REQ-017 / AC-08 invariant).
      const conversion = await Conversion.init({
        input,
        output,
        video: {
          codec: rung.codec,
          quality: mapQuality(settings.quality),
          hardwareAcceleration: rung.hw,
          process: burn.process,
        },
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
