/**
 * ingest.js — REQ-001 (design.md §3).
 *
 * Opens a user file as a mediabunny `Input` and extracts display-oriented
 * metadata. Registers `@mediabunny/prores` (idempotently, before the Input is
 * created) so iPhone ProRes `.mov` files decode. All downstream coordinates
 * are display-oriented — mediabunny applies container rotation at decode, and
 * `meta.displayWidth/Height` are already rotation-applied (ADR-9), so every
 * later consumer (tracker, redact, editor, exporter) shares one upright space.
 *
 * Error taxonomy (typed `IngestError.code`, REQ-001/M1 task 3):
 *   'unsupported-container'     unrecognized container format
 *   'no-video-track'            file has audio/subtitles only
 *   'undecodable-track'         codec not decodable in this browser (REQ-003 gate)
 *   'prores-without-extension'  ProRes track but the decoder extension failed to load
 *   'corrupt'                   file is unreadable/corrupt/truncated
 *
 * Depends on: mediabunny (+ @mediabunny/prores loaded at runtime).
 */
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import './types.js';

/**
 * Exact-pinned `@mediabunny/prores` ESM bundle (mirrors the mediabunny@1.63.0
 * pin). Imported lazily through a dynamic `import()` so that (a) node-based
 * unit tests never touch the CDN (the URL is mocked) and (b) the single-file
 * build keeps it as a runtime import instead of bundling the WASM decoder.
 *
 * NOTE: this is the package's raw dist bundle, NOT jsDelivr's `/+esm` rewrite.
 * `/+esm` re-bundles the bundle's bare `"mediabunny"` import into a SECOND
 * mediabunny instance, so `registerProresDecoder()` would mutate the wrong
 * copy and ProRes would never decode. The raw dist bundle keeps
 * `import ... from "mediabunny"`, which the importmap resolves to the same
 * module instance our `Input` comes from.
 * @type {string}
 */
export const PRORES_MODULE_URL =
  'https://cdn.jsdelivr.net/npm/@mediabunny/prores@1.63.0/dist/bundles/mediabunny-prores.mjs';

/**
 * Upper bound on packets scanned for the fps estimate. `computePacketStats`
 * defaults to the whole file — unacceptable as a first read on multi-GB
 * footage; ~64 packets is ≥ 2 s at any frame rate and keeps the open instant.
 * @type {number}
 */
const FPS_PACKET_SAMPLE = 64;

/** Short container tags for the InputFormat names mediabunny reports. */
const CONTAINER_TAGS = {
  'MP4': 'mp4',
  'QuickTime File Format': 'mov',
  'WebM': 'webm',
  'Matroska': 'mkv',
};

/**
 * Typed ingest failure (see module doc for the `code` taxonomy).
 */
export class IngestError extends Error {
  /**
   * @param {'unsupported-container'|'no-video-track'|'undecodable-track'|
   *         'prores-without-extension'|'corrupt'} code
   * @param {string} message Readable, actionable description.
   * @param {{cause?: unknown}} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'IngestError';
    this.code = code;
  }
}

let proresDecoderRegistered = false;

/**
 * Register the Apple ProRes decoder extension with mediabunny. Safe to call
 * any number of times: a module-level flag short-circuits repeats, and the
 * extension itself additionally guards its global registration. Failure is
 * not fatal here — it only becomes one when a ProRes track is actually met
 * ('prores-without-extension').
 *
 * @returns {Promise<boolean>} true when the decoder is registered.
 */
export async function ensureProresDecoder() {
  if (proresDecoderRegistered) {
    return true;
  }
  try {
    const prores = await import(/* @vite-ignore */ PRORES_MODULE_URL);
    prores.registerProresDecoder();
    proresDecoderRegistered = true;
  } catch (error) {
    void error; // Offline / CDN blocked; re-reported per-file if ProRes shows up.
  }
  return proresDecoderRegistered;
}

/**
 * Map a mediabunny `InputFormat.name` to the short container tag used in
 * `MediaMeta.container` (e.g. 'mp4' | 'mov' | 'webm'). Unknown formats are
 * slugified so nothing crashes on future format additions.
 *
 * @param {string|null} formatName `InputFormat.name` from `input.getFormat()`.
 * @returns {string}
 */
export function containerTag(formatName) {
  const known = CONTAINER_TAGS[formatName];
  if (known !== undefined) {
    return known;
  }
  const slug = String(formatName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

/**
 * Assemble a display-oriented {@link MediaMeta} from opened tracks (pure with
 * respect to mediabunny — takes the track objects, never the Input).
 *
 * Display dimensions come exclusively from `track.getDisplayWidth/Height()`,
 * which mediabunny computes post-rotation (and post pixel-aspect-ratio); the
 * coded values are carried alongside for capability probing (REQ-002).
 *
 * @param {object} videoTrack Primary video track (mediabunny InputVideoTrack).
 * @param {{codec: string}|null} audioTrack Primary audio track or null.
 * @param {number} duration Seconds (`input.computeDuration()`).
 * @param {string} container Short container tag (`containerTag()`).
 * @returns {Promise<import('./types.js').MediaMeta>}
 *     Extra fields beyond the typedef: `codedWidth`, `codedHeight`.
 */
export async function metaFromTracks(videoTrack, audioTrack, duration, container) {
  const [rotation, displayWidth, displayHeight, stats] = await Promise.all([
    videoTrack.getRotation(),
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    videoTrack.computePacketStats(FPS_PACKET_SAMPLE),
  ]);

  return {
    container,
    codec: videoTrack.codec,
    codedWidth: videoTrack.codedWidth,
    codedHeight: videoTrack.codedHeight,
    displayWidth,
    displayHeight,
    rotation,
    fps: stats.averagePacketRate,
    duration,
    audio: audioTrack ? { codec: audioTrack.codec } : null,
  };
}

/**
 * Open a media file and read its metadata.
 *
 * @param {File|Blob} file User-selected media file.
 * @returns {Promise<{input: object, meta: import('./types.js').MediaMeta}>}
 *     `input` is a mediabunny `Input` (BlobSource) reused for capability
 *     probing, analysis, and export; `meta` carries codec, coded and display
 *     width/height (rotation applied), rotation, fps, duration, audio codec.
 * @throws {IngestError} Unsupported/corrupt container, undecodable codec, or
 *     ProRes without a loadable extension (capability gate shows guidance).
 */
export async function openInput(file) {
  // Registration must happen before any decoding task starts (extension doc);
  // doing it before the Input exists also keeps the order deterministic.
  const proresReady = await ensureProresDecoder();

  let input;
  let format;
  try {
    input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    format = await input.getFormat();
  } catch (error) {
    if (error && /** @type {Error} */ (error).name === 'UnsupportedInputFormatError') {
      throw new IngestError(
        'unsupported-container',
        'This file’s container is not supported. Supported: MP4, QuickTime (.mov), WebM.',
        { cause: error },
      );
    }
    throw new IngestError(
      'corrupt',
      'The file could not be read as media — it may be corrupt or truncated.',
      { cause: error },
    );
  }

  let videoTrack;
  let audioTrack;
  let duration;
  try {
    videoTrack = await input.getPrimaryVideoTrack();
    audioTrack = await input.getPrimaryAudioTrack();
    duration = await input.computeDuration();
  } catch (error) {
    throw new IngestError(
      'corrupt',
      'The file’s tracks could not be read — it may be corrupt or truncated.',
      { cause: error },
    );
  }

  if (!videoTrack) {
    throw new IngestError('no-video-track', 'No video track was found in this file.');
  }

  // Check extension state before canDecode(): without it, mediabunny would
  // report ProRes as generically undecodable and the guidance would mislead.
  if (videoTrack.codec === 'prores' && !proresReady) {
    throw new IngestError(
      'prores-without-extension',
      'Apple ProRes video detected, but the ProRes decoder extension could not be loaded.',
    );
  }

  let canDecode;
  try {
    canDecode = await videoTrack.canDecode();
  } catch (error) {
    throw new IngestError(
      'corrupt',
      'The video track could not be inspected — the file may be corrupt.',
      { cause: error },
    );
  }
  if (!canDecode) {
    throw new IngestError(
      'undecodable-track',
      `The video codec "${videoTrack.codec}" cannot be decoded in this browser. ` +
        'Try Chrome or Edge on hardware with decode support, or re-record with ' +
        'iPhone Camera → Formats → "Most Compatible".',
    );
  }

  let meta;
  try {
    meta = await metaFromTracks(
      videoTrack,
      audioTrack,
      duration,
      containerTag(format.name),
    );
  } catch (error) {
    throw new IngestError(
      'corrupt',
      'The file’s metadata could not be read — it may be corrupt or truncated.',
      { cause: error },
    );
  }

  return { input, meta };
}
