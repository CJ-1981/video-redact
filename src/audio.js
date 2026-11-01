/**
 * audio.js — v1.22.0 REQ-206: waveform peaks for the review timeline's
 * waveform strip.
 *
 * The module owns DECODE + BINNING only — never rendering, never state:
 *
 *   WAVEFORM_DEFAULT_BARS  default bar resolution (240 — one bar ≈ 4 px on
 *                          a ~1000 px strip)
 *   packetPeak()           PURE peak-abs of one decoded audio packet
 *                          (channels downmixed by max-abs)
 *   binPeaks()             PURE (timestamp, peak) packets → normalized
 *                          Float32Array (one peak-abs per bar, 0–1 by the
 *                          global max)
 *   decodeWaveform()       decode an input's first audio track through the
 *                          mediabunny `AudioSampleSink` and produce
 *                          `{ bars: Float32Array, duration: number }`;
 *                          resolves NULL on no-audio / undecodable / any
 *                          failure — the waveform is an amenity and degrades
 *                          SILENTLY (REQ-206: "no error surfaced").
 *   clearWaveformCache()   test seam — drops the per-file result cache
 *
 * LAZY + CACHED (REQ-206): main.js calls decodeWaveform only after the first
 * review entry, keyed by `name:size` in this module-level Map (no
 * IndexedDB — the peaks are cheap to recompute and die with the session).
 * The PROMISE is cached, so concurrent calls dedupe and a failure result is
 * cached too (no per-refresh decode storm on undecodable audio).
 *
 * IMPORT-TIME SAFETY: no DOM access; `mediabunny` is only touched inside
 * decodeWaveform's async path — node tests import the pure helpers and mock
 * the module (same seam discipline as src/analyze.js).
 */
import { AudioSampleSink } from 'mediabunny';

/**
 * Default bar count of a decoded waveform (v1.22.0 REQ-206).
 * @type {number}
 */
export const WAVEFORM_DEFAULT_BARS = 240;

/**
 * Peak amplitude of one decoded audio packet. PURE. `data` is INTERLEAVED
 * float32 PCM (mediabunny `AudioSample.copyTo(..., {format: 'f32'})`);
 * channels are downmixed by max-abs — mathematically the max-abs over every
 * value, so the loop scans once. NaN samples are skipped (a corrupt packet
 * must not poison the peak). Empty/garbage input → 0.
 *
 * @param {Float32Array} data Interleaved PCM frames.
 * @param {number} [channels] Channel count (≥ 1; only documents the
 *     max-abs downmix — the scan is channel-agnostic).
 * @returns {number} Peak absolute amplitude in [0, 1] for sane PCM.
 */
export function packetPeak(data, channels) {
  void channels;
  if (!data || typeof data.length !== 'number' || data.length === 0) return 0;
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v !== v) continue; // NaN — corrupt frame, skip
    const a = v < 0 ? -v : v;
    if (a > max) max = a;
  }
  return max;
}

/**
 * Bin decoded packet peaks into a normalized bar array. PURE. `packets` is
 * `Array<{timestamp: number, duration: number, peak: number}>` (seconds);
 * each peak lands in `floor(timestamp / durationSec * bars)`; the array is
 * then normalized by the GLOBAL max so the loudest bar reads exactly 1
 * (silence/all-zero → all zeros, never NaN). A non-positive duration yields
 * an all-zero array of the right length.
 *
 * @param {Array<{timestamp: number, duration: number, peak: number}>} packets
 * @param {number} bars Bar count (> 0; garbage → WAVEFORM_DEFAULT_BARS).
 * @param {number} durationSec Total media duration the timestamps live in.
 * @returns {Float32Array} Peak per bar, normalized 0–1.
 */
export function binPeaks(packets, bars, durationSec) {
  const n = Number.isFinite(bars) && bars > 0 ? Math.floor(bars) : WAVEFORM_DEFAULT_BARS;
  const out = new Float32Array(n);
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  if (!(dur > 0)) return out;
  let max = 0;
  for (const p of Array.isArray(packets) ? packets : []) {
    const ts = Number(p && p.timestamp);
    const peak = Number(p && p.peak);
    if (!Number.isFinite(ts) || !(peak > 0)) continue;
    let idx = Math.floor((Math.max(ts, 0) / dur) * n);
    if (idx >= n) idx = n - 1;
    else if (idx < 0) idx = 0;
    if (peak > out[idx]) out[idx] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) {
    for (let i = 0; i < n; i++) out[i] = out[i] / max;
  }
  return out;
}

/** Per-file result cache (REQ-206: keyed by video name+size; no IndexedDB).
 * @type {Map<string, Promise<{bars: Float32Array, duration: number} | null>>}
 */
const peaksCache = new Map();

/** Drop the waveform cache (test seam; also usable on explicit eviction). */
export function clearWaveformCache() {
  peaksCache.clear();
}

/**
 * Decode the input's first audio track into waveform peaks (v1.22.0
 * REQ-206). Resolves NULL — never throws — when there is no audio track,
 * the track cannot be decoded, or anything at all fails (silent degrade:
 * the caller hides the strip). Progress callbacks fire roughly every 5% of
 * the track duration; a CACHE HIT replays none (the caller ignores late
 * progress anyway).
 *
 * @param {object | null | undefined} input A mediabunny Input (duck-typed:
 *     `getAudioTracks()`; capability.js discipline — no static import of
 *     the Input class).
 * @param {{bars?: number, cacheKey?: string, onProgress?: (p: number) => void}}
 *     [opts] `bars` resolution (default 240), `cacheKey` (`"name:size"`),
 *     `onProgress` callback.
 * @returns {Promise<{bars: Float32Array, duration: number} | null>}
 */
export function decodeWaveform(input, opts = {}) {
  const bars =
    Number.isFinite(opts.bars) && opts.bars > 0 ? Math.floor(opts.bars) : WAVEFORM_DEFAULT_BARS;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const key = typeof opts.cacheKey === 'string' && opts.cacheKey ? opts.cacheKey : null;
  if (key && peaksCache.has(key)) return peaksCache.get(key);
  const promise = decodeUncached(input, { bars, onProgress }).catch(() => null);
  if (key) peaksCache.set(key, promise);
  return promise;
}

/**
 * Uncached decode path. Iterate the sink's samples ONCE, collect (timestamp,
 * peak) packets, then bin + normalize (binPeaks). `track.duration` (metadata
 * duration, may be null) drives progress + binning; when absent, the last
 * packet's end timestamp does.
 *
 * @param {object | null | undefined} input
 * @param {{bars: number, onProgress: ((p: number) => void) | null}} opts
 * @returns {Promise<{bars: Float32Array, duration: number} | null>}
 */
async function decodeUncached(input, { bars, onProgress }) {
  const tracks =
    typeof (input && input.getAudioTracks) === 'function' ? await input.getAudioTracks() : [];
  const track = Array.isArray(tracks) ? tracks.find((t) => t) : null;
  if (!track) return null;
  if (typeof track.canDecode === 'function') {
    let decodable = false;
    try {
      decodable = await track.canDecode();
    } catch {
      decodable = false;
    }
    if (!decodable) return null;
  }
  let trackDuration = Number(track.duration);
  if (!Number.isFinite(trackDuration) || trackDuration <= 0) trackDuration = 0;
  const sink = new AudioSampleSink(track);
  /** @type {Array<{timestamp: number, duration: number, peak: number}>} */
  const packets = [];
  let lastEnd = 0;
  let lastBucket = -1;
  for await (const sample of sink.samples()) {
    if (!sample) continue;
    let peak = 0;
    try {
      const frames = Number(sample.numberOfFrames);
      if (Number.isFinite(frames) && frames > 0) {
        const size = sample.allocationSize({ planeIndex: 0, format: 'f32', frameCount: frames });
        const data = new Float32Array(Math.max(0, size / 4));
        sample.copyTo(data, { planeIndex: 0, format: 'f32', frameCount: frames });
        peak = packetPeak(data, sample.numberOfChannels);
      }
    } catch {
      peak = 0; // unconvertible/corrupt packet — skip it (silent degrade)
    } finally {
      try {
        sample.close();
      } catch {
        /* already closed */
      }
    }
    const ts = Number(sample.timestamp);
    const sdur = Number(sample.duration);
    const end =
      Number.isFinite(ts) && Number.isFinite(sdur) ? ts + sdur : lastEnd;
    if (end > lastEnd) lastEnd = end;
    packets.push({ timestamp: ts, duration: sdur, peak });
    if (onProgress && trackDuration > 0 && end > 0) {
      const p = Math.min(1, end / trackDuration);
      const bucket = Math.floor(p * 20); // ~5% steps
      if (bucket > lastBucket) {
        lastBucket = bucket;
        onProgress(p);
      }
    }
  }
  const total = trackDuration > 0 ? trackDuration : lastEnd;
  return { bars: binPeaks(packets, bars, total), duration: total };
}
