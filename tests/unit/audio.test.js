/**
 * Unit tests for src/audio.js — v1.22.0 REQ-206 waveform decode + binning.
 *
 * Split (same discipline as analyze.test.js): the PURE seams (packetPeak,
 * binPeaks) run directly; the mediabunny `AudioSampleSink` is module-mocked
 * so decodeWaveform is exercised against synthetic samples (sine → peaks at
 * expected positions; silence → zeros; no-audio/undecodable → null).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('mediabunny', () => ({
  AudioSampleSink: vi.fn(),
}));

const { AudioSampleSink } = await import('mediabunny');
const {
  WAVEFORM_DEFAULT_BARS,
  packetPeak,
  binPeaks,
  decodeWaveform,
  clearWaveformCache,
} = await import('../../src/audio.js');

/** One fake decoded AudioSample (the surface audio.js touches). */
function mkSample(timestamp, duration, values, channels = 1) {
  const frames = values.length / channels;
  return {
    timestamp,
    duration,
    numberOfFrames: frames,
    numberOfChannels: channels,
    allocationSize: (opts) => (opts.frameCount ?? frames) * 4 * channels,
    copyTo: (dest, opts) => {
      const n = (opts.frameCount ?? frames) * channels;
      for (let i = 0; i < n; i++) dest[i] = values[i];
    },
    close: vi.fn(),
  };
}

/** Fake input whose getAudioTracks resolves the given tracks. */
function mkInput(tracks) {
  return { getAudioTracks: vi.fn(async () => tracks) };
}

function mockSink(samples, { throwInIterate = false } = {}) {
  AudioSampleSink.mockImplementation(function () {
    return {
      samples: async function* () {
        if (throwInIterate) throw new Error('decode blew up');
        for (const s of samples) yield s;
      },
    };
  });
}

beforeEach(() => {
  AudioSampleSink.mockReset();
  clearWaveformCache();
});

// ---------------------------------------------------------------------------
// packetPeak (PURE)
// ---------------------------------------------------------------------------

describe('packetPeak (max-abs downmix, v1.22.0 REQ-206)', () => {
  it('returns the peak absolute amplitude of a packet', () => {
    expect(packetPeak(new Float32Array([0.1, -0.5, 0.25, -0.9, 0.3]))).toBeCloseTo(0.9, 5);
    expect(packetPeak(new Float32Array([0, 0, 0]))).toBe(0);
  });

  it('downmixes interleaved stereo by max-abs across channels', () => {
    // Stereo frame [L, R]: peak = max(|L|, |R|) over every frame.
    expect(packetPeak(new Float32Array([0.2, -0.8, 0.6, -0.1]), 2)).toBeCloseTo(0.8, 5);
  });

  it('skips NaN frames (a corrupt packet never poisons the peak) and degrades on garbage', () => {
    expect(packetPeak(new Float32Array([0.4, NaN, -0.2]))).toBeCloseTo(0.4, 5);
    expect(packetPeak(new Float32Array([]))).toBe(0);
    expect(packetPeak(null)).toBe(0);
    expect(packetPeak(undefined, 2)).toBe(0);
  });

  it('a full-scale sine reaches ~1.0', () => {
    const n = 4410;
    const sine = Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 3 * i) / n));
    expect(packetPeak(sine)).toBeGreaterThan(0.99);
  });
});

// ---------------------------------------------------------------------------
// binPeaks (PURE)
// ---------------------------------------------------------------------------

describe('binPeaks (bar binning + normalization, v1.22.0 REQ-206)', () => {
  it('bins packet peaks at their timestamp positions', () => {
    // 10 s, 10 bars → 1 s per bar. Peaks at 0.5 s → bar 0, at 5.5 s → bar 5.
    const peaks = binPeaks(
      [
        { timestamp: 0.5, duration: 1, peak: 0.8 },
        { timestamp: 5.5, duration: 1, peak: 0.4 },
      ],
      10,
      10,
    );
    expect(peaks).toHaveLength(10);
    expect(peaks[0]).toBeCloseTo(1, 10); // loudest bar normalizes to exactly 1
    expect(peaks[5]).toBeCloseTo(0.5, 5); // 0.4 / 0.8
    for (const i of [1, 2, 3, 4, 6, 7, 8, 9]) expect(peaks[i]).toBe(0);
  });

  it('keeps the MAX peak when several packets land in one bar', () => {
    const peaks = binPeaks(
      [
        { timestamp: 0, duration: 1, peak: 0.3 },
        { timestamp: 0.9, duration: 1, peak: 0.6 },
      ],
      4,
      4,
    );
    expect(peaks[0]).toBeCloseTo(1, 5); // 0.6 is the bar max (and the global max)
  });

  it('silence (all-zero peaks) stays all zeros — never NaN', () => {
    const peaks = binPeaks(
      [
        { timestamp: 0, duration: 1, peak: 0 },
        { timestamp: 1, duration: 1, peak: 0 },
      ],
      8,
      2,
    );
    expect(peaks).toHaveLength(8);
    for (const p of peaks) expect(p).toBe(0);
  });

  it('degrades on a non-positive duration (right length, all zeros) and garbage bars', () => {
    expect(binPeaks([{ timestamp: 0, duration: 1, peak: 0.5 }], 5, 0)).toEqual(new Float32Array(5));
    expect(binPeaks([], NaN, 10)).toHaveLength(WAVEFORM_DEFAULT_BARS);
    expect(binPeaks('nope', 4, 10)).toEqual(new Float32Array(4));
  });

  it('clamps out-of-range timestamps into the bar array', () => {
    const peaks = binPeaks([{ timestamp: 999, duration: 1, peak: 0.5 }], 4, 10);
    expect(peaks[3]).toBeCloseTo(1, 10); // clamped into the last bar
  });
});

// ---------------------------------------------------------------------------
// decodeWaveform (mediabunny AudioSampleSink mocked)
// ---------------------------------------------------------------------------

describe('decodeWaveform (v1.22.0 REQ-206)', () => {
  it('decodes a track into normalized bars (sine packet peaks land at their bars)', async () => {
    const loud = mkSample(0, 0.5, Float32Array.from({ length: 4410 }, (_, i) => Math.sin((2 * Math.PI * 3 * i) / 4410)));
    const quiet = mkSample(0.5, 0.5, new Float32Array(4410).fill(0.25));
    mockSink([loud, quiet]);
    const input = mkInput([{ duration: 1, canDecode: async () => true }]);
    const result = await decodeWaveform(input, { bars: 4, cacheKey: 'k1' });
    expect(result).not.toBeNull();
    expect(result.bars).toHaveLength(4);
    expect(result.duration).toBeCloseTo(1, 10); // track duration wins over packet ends
    expect(result.bars[0]).toBeCloseTo(1, 5); // sine (peak ~1) → bar 0, normalized to 1
    // The quiet packet starts at t=0.5 → bar 2 of 4 (bar width 0.25 s).
    expect(result.bars[2]).toBeGreaterThan(0.2); // 0.25 quiet packet, normalized
    expect(result.bars[2]).toBeLessThan(result.bars[0]);
    expect(result.bars[1]).toBe(0); // binning is by packet START: sine → bar 0 only
    expect(result.bars[3]).toBe(0);
    expect(loud.close).toHaveBeenCalled(); // samples are closed (release)
  });

  it('downmixes a stereo sine by max-abs and reports the duration from packets when metadata lacks it', async () => {
    const stereo = mkSample(0, 1, new Float32Array([0.1, -1, 0.5, -0.2]), 2);
    mockSink([stereo]);
    const input = mkInput([{ duration: null, canDecode: async () => true }]);
    const result = await decodeWaveform(input, { bars: 2, cacheKey: 'k2' });
    expect(result.duration).toBeCloseTo(1, 10); // fallback: last packet end
    expect(result.bars[0]).toBeCloseTo(1, 10);
  });

  it('resolves null on NO audio track (silent file — silent degrade)', async () => {
    mockSink([]);
    expect(await decodeWaveform(mkInput([]), { cacheKey: 'k3' })).toBeNull();
    expect(await decodeWaveform(mkInput(undefined), { cacheKey: 'k3b' })).toBeNull();
    expect(await decodeWaveform(null, { cacheKey: 'k3c' })).toBeNull();
  });

  it('resolves null on an UNDECODABLE track', async () => {
    mockSink([]);
    const input = mkInput([{ duration: 5, canDecode: async () => false }]);
    expect(await decodeWaveform(input, { cacheKey: 'k4' })).toBeNull();
  });

  it('resolves null (never throws) when the sink iteration blows up — and caches the failure', async () => {
    mockSink([], { throwInIterate: true });
    const input = mkInput([{ duration: 5, canDecode: async () => true }]);
    expect(await decodeWaveform(input, { cacheKey: 'k5' })).toBeNull();
    // The failure result is cached: the SAME key resolves without re-decoding.
    AudioSampleSink.mockReset();
    expect(await decodeWaveform(input, { cacheKey: 'k5' })).toBeNull();
    expect(AudioSampleSink).not.toHaveBeenCalled();
  });

  it('caches by cacheKey (concurrent + repeat calls decode once)', async () => {
    mockSink([mkSample(0, 1, new Float32Array([0.5, -0.5, 0.5, -0.5]))]);
    const input = mkInput([{ duration: 1, canDecode: async () => true }]);
    const first = decodeWaveform(input, { bars: 8, cacheKey: 'k6' });
    const second = decodeWaveform(input, { bars: 8, cacheKey: 'k6' }); // same tick — deduped
    expect(second).toBe(first);
    const resolved = await first;
    expect((await decodeWaveform(input, { cacheKey: 'k6' })).bars).toBe(resolved.bars);
    expect(AudioSampleSink).toHaveBeenCalledTimes(1);
  });

  it('clearWaveformCache forces a re-decode; distinct keys never share', async () => {
    mockSink([mkSample(0, 1, new Float32Array([0.5, -0.5]))]);
    const input = mkInput([{ duration: 1, canDecode: async () => true }]);
    await decodeWaveform(input, { cacheKey: 'k7' });
    await decodeWaveform(input, { cacheKey: 'k8' });
    expect(AudioSampleSink).toHaveBeenCalledTimes(2); // different files
    clearWaveformCache();
    await decodeWaveform(input, { cacheKey: 'k7' });
    expect(AudioSampleSink).toHaveBeenCalledTimes(3);
  });

  it('reports progress in ~5% buckets during the decode', async () => {
    const samples = [];
    for (let i = 0; i < 10; i++) samples.push(mkSample(i * 0.1, 0.1, new Float32Array([0.5])));
    mockSink(samples);
    const onProgress = vi.fn();
    await decodeWaveform(mkInput([{ duration: 1, canDecode: async () => true }]), {
      bars: 4,
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
    const calls = onProgress.mock.calls.map((c) => c[0]);
    expect(calls[0]).toBeGreaterThan(0);
    expect(Math.max(...calls)).toBeLessThanOrEqual(1);
    // Monotonically non-decreasing bucketed progress.
    for (let i = 1; i < calls.length; i++) expect(calls[i]).toBeGreaterThanOrEqual(calls[i - 1]);
  });
});
