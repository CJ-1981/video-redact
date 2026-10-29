/**
 * Unit tests for src/analyze.js — REQ-009 analyze pass (design.md §4.6).
 *
 * Seams: mediabunny's VideoSampleSink is module-mocked to feed synthetic
 * samples; src/detector.js is PARTIALLY mocked — the pure geometry
 * (tileGrid / mergeTiles) stays real so the dashcam tile pass is verified
 * against actual display-space math, while createDetectors() is replaced
 * with controllable fakes (no ORT needed here; the ORT seam itself is
 * pinned in tests/unit/detector.test.js). Canvas / yield / clock are
 * injected via runAnalyze's own test seams.
 *
 * Covers: stride schedule (faces every frame, plates every 2nd + overrides),
 * dashcam tiled pass additions (tile rasters at real geometry, per-frame
 * tile plates ignoring the stride, merged single coordinate space),
 * sink-timestamp stamping (monotonic; detector t=0 placeholder replaced),
 * progress payload sanity (models phase → per-frame analyze fps/ETA),
 * mid-stream AbortSignal → {cancelled: true} with finalized partial tracks,
 * sample.close() on every exit path (success / cancel / detector throw),
 * one-canvas reuse, and the per-frame yield (P-5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const detState = vi.hoisted(() => ({
  detectFace: null,
  detectPlate: null,
  detectorClosed: 0,
  createOpts: null,
}));

vi.mock('mediabunny', () => ({
  VideoSampleSink: vi.fn(),
}));

vi.mock('../../src/detector.js', async (importOriginal) => {
  const actual = await importOriginal();
  const detectFace = vi.fn(async () => []);
  const detectPlate = vi.fn(async () => []);
  detState.detectFace = detectFace;
  detState.detectPlate = detectPlate;
  return {
    ...actual,
    createDetectors: vi.fn(async (opts) => {
      detState.createOpts = opts;
      opts?.onModelProgress?.('yunet', 0.5);
      opts?.onModelProgress?.('plate-yolov9t', 1);
      return {
        detectFace,
        detectPlate,
        close: () => {
          detState.detectorClosed += 1;
        },
      };
    }),
  };
});

const { runAnalyze } = await import('../../src/analyze.js');
const { VideoSampleSink } = await import('mediabunny');
const { tileGrid } = await import('../../src/detector.js');

/* ─── fixtures ─── */

const W = 1280;
const H = 720;
const FPS = 10;
const PAD = 5 / FPS; // default padSeconds (REQ-007)

const fullFaceDet = () => [
  { t: 0, box: { x: 100, y: 100, w: 60, h: 60 }, cls: 'face', conf: 0.9, pass: 'full' },
];
const fullPlateDet = () => [
  { t: 0, box: { x: 200, y: 200, w: 80, h: 40 }, cls: 'plate', conf: 0.8, classId: 0, pass: 'full' },
];

function makeMeta(overrides = {}) {
  return { displayWidth: W, displayHeight: H, fps: FPS, duration: 0.4, ...overrides };
}

/** Install a VideoSampleSink mock yielding one synthetic sample per timestamp. */
function installSink(timestamps) {
  const samples = [];
  VideoSampleSink.mockImplementation(function (videoTrack) {
    return {
      videoTrack,
      samples: () =>
        (async function* () {
          for (const timestamp of timestamps) {
            const sample = { timestamp, draw: vi.fn(), close: vi.fn() };
            samples.push(sample);
            yield sample;
          }
        })(),
    };
  });
  return samples;
}

/** Install a canvas-factory seam: ONE fake canvas + a recording 2D context. */
function installCanvas() {
  const ctx = {
    getImageData: vi.fn((x, y, w, h) => ({
      data: new Uint8ClampedArray(w * h * 4),
      width: w,
      height: h,
    })),
  };
  const factory = vi.fn(() => ({ canvas: { width: W, height: H }, ctx }));
  factory.ctx = ctx;
  return factory;
}

/** Monotonic step clock: each call advances `stepMs` (deterministic fps math). */
function stepClock(stepMs = 10) {
  let t = 0;
  return () => (t += stepMs);
}

function makeInput() {
  const track = { __primaryVideoTrack: true };
  return { input: { getPrimaryVideoTrack: vi.fn(async () => track) }, track };
}

/**
 * Assert a finalized track's DENSE keyframe map (Tracker.finalize inserts
 * interpolated 1/30 s-grid samples inside gaps): keys strictly increasing,
 * every raw sample timestamp present EXACTLY with the exact detection box
 * (proving the sink-timestamp stamp), first/last keys at the raw span.
 */
function expectStamped(track, timestamps, box) {
  const keys = [...track.keyframes.keys()];
  for (let i = 1; i < keys.length; i++) expect(keys[i]).toBeGreaterThan(keys[i - 1]);
  for (const t of timestamps) expect(track.keyframes.get(t)).toEqual(box);
  expect(keys[0]).toBe(timestamps[0]);
  expect(keys[keys.length - 1]).toBe(timestamps[timestamps.length - 1]);
}

function baseOpts(overrides = {}) {
  const { input } = makeInput();
  return {
    input,
    meta: makeMeta(),
    canvasFactory: installCanvas(), // node has no OffscreenCanvas/document — always seam it
    yieldNow: vi.fn(async () => {}),
    now: stepClock(),
    ...overrides,
  };
}

beforeEach(() => {
  VideoSampleSink.mockReset();
  detState.detectFace.mockReset();
  detState.detectFace.mockImplementation(async () => fullFaceDet());
  detState.detectPlate.mockReset();
  detState.detectPlate.mockImplementation(async () => fullPlateDet());
  detState.detectorClosed = 0;
  detState.createOpts = null;
});

describe('stride schedule — faces every frame, plates every 2nd (REQ-009)', () => {
  it('runs detectFace on all frames and detectPlate only on stride-aligned frames', async () => {
    const samples = installSink([0, 0.1, 0.2, 0.3]);
    const canvas = installCanvas();

    const result = await runAnalyze(baseOpts({ canvasFactory: canvas }));

    expect(result.cancelled).toBe(false);
    expect(result.frameCount).toBe(4);
    expect(samples).toHaveLength(4);
    expect(detState.detectFace).toHaveBeenCalledTimes(4);
    expect(detState.detectPlate).toHaveBeenCalledTimes(2);
    // Every detector raster is the full display frame (no dashcam tiles).
    for (const calls of [detState.detectFace.mock.calls, detState.detectPlate.mock.calls]) {
      for (const [frame] of calls) expect(frame.width).toBe(W);
    }
  });

  it('stamps sink timestamps onto detections — face track covers every frame, plate only strides', async () => {
    installSink([0, 0.1, 0.2, 0.3]);

    const result = await runAnalyze(baseOpts({}));

    expect(result.tracks).toHaveLength(2);
    const face = result.tracks.find((tr) => tr.cls === 'face');
    const plate = result.tracks.find((tr) => tr.cls === 'plate');
    // The detector placeholder t = 0 must be replaced by sample.timestamp
    // (ADR-3): strictly increasing, seconds-keyed, exact box at each frame.
    const faceBox = { x: 100, y: 100, w: 60, h: 60 };
    expectStamped(face, [0, 0.1, 0.2, 0.3], faceBox);
    expectStamped(plate, [0, 0.2], { x: 200, y: 200, w: 80, h: 40 });
    // Default padding 5/fps materialized on the spans (REQ-007).
    expect(face.start).toBe(0); // clamped at 0, never negative
    expect(face.end).toBeCloseTo(0.3 + PAD, 12);
    expect(plate.end).toBeCloseTo(0.2 + PAD, 12);
  });

  it('honors plateStride overrides (3 → frames 0 and 3; 1 → every frame)', async () => {
    installSink([0, 0.1, 0.2, 0.3, 0.4, 0.5]);

    const result = await runAnalyze(baseOpts({ settings: { plateStride: 3 } }));

    expect(detState.detectFace).toHaveBeenCalledTimes(6);
    expect(detState.detectPlate).toHaveBeenCalledTimes(2);
    const plate = result.tracks.find((tr) => tr.cls === 'plate');
    expectStamped(plate, [0, 0.3], { x: 200, y: 200, w: 80, h: 40 });

    const before = detState.detectPlate.mock.calls.length;
    installSink([0, 0.1, 0.2, 0.3]);
    await runAnalyze(baseOpts({ settings: { plateStride: 1 } }));
    expect(detState.detectPlate.mock.calls.length - before).toBe(4);
  });

  it('clamps a non-positive plateStride to 1', async () => {
    installSink([0, 0.1]);

    await runAnalyze(baseOpts({ settings: { plateStride: 0 } }));

    expect(detState.detectPlate).toHaveBeenCalledTimes(2);
  });

  it('forwards epPolicy to createDetectors and honors a padSeconds override', async () => {
    installSink([0, 0.1]);

    const result = await runAnalyze(
      baseOpts({ settings: { epPolicy: ['wasm'], padSeconds: 0.05 } }),
    );

    expect(detState.createOpts.epPolicy).toEqual(['wasm']);
    const face = result.tracks.find((tr) => tr.cls === 'face');
    expect(face.end).toBeCloseTo(0.1 + 0.05, 12);
  });
});

describe('dashcam tiled pass (REQ-008, ADR-9)', () => {
  it('adds a per-frame tiled face+plate pass; tile plates ignore the stride', async () => {
    installSink([0, 0.1, 0.2]);
    const canvas = installCanvas();
    // Tile rasters are 320 px wide (real tileGrid geometry for 1280×720);
    // full-pass rasters are 1280 px wide.
    detState.detectFace.mockImplementation(async (frame) =>
      frame.width === W
        ? fullFaceDet()
        : [{ t: 0, box: { x: 5, y: 5, w: 30, h: 30 }, cls: 'face', conf: 0.7 }],
    );
    detState.detectPlate.mockImplementation(async (frame) =>
      frame.width === W
        ? fullPlateDet()
        : [{ t: 0, box: { x: 2, y: 8, w: 40, h: 20 }, cls: 'plate', conf: 0.6, classId: 0 }],
    );

    const result = await runAnalyze(
      baseOpts({ settings: { dashcamMode: true }, canvasFactory: canvas }),
    );

    // 3 frames × (1 full + 4 tiles) face calls…
    expect(detState.detectFace).toHaveBeenCalledTimes(15);
    // …but the full-frame plate pass keeps the stride: frames 0 and 2 only,
    // while the tiled plate pass runs EVERY analyzed frame.
    const plateRasters = detState.detectPlate.mock.calls.map(([raster]) => raster);
    expect(plateRasters.filter((r) => r.width === W)).toHaveLength(2);
    expect(plateRasters.filter((r) => r.width === 320)).toHaveLength(12);

    // Tile rasters are cut at the real tileGrid geometry: full pass first,
    // then one raster per tile.
    const grabs = canvas.ctx.getImageData.mock.calls;
    expect(grabs[0]).toEqual([0, 0, W, H]);
    expect(grabs.slice(1, 5)).toEqual([
      [0, 0, 320, H],
      [320, 0, 320, H],
      [640, 0, 320, H],
      [960, 0, 320, H],
    ]);
    expect(grabs).toHaveLength(15);

    // mergeTiles output lands in ONE display coordinate space: tile-local
    // (5,5) face → (5 + tileX, 5); tracking never sees tile coordinates.
    const faceX = new Set(
      result.tracks
        .filter((tr) => tr.cls === 'face')
        .map((tr) => [...tr.keyframes.values()][0].x),
    );
    expect(faceX).toEqual(new Set([100, 5, 325, 645, 965]));
    const plateX = new Set(
      result.tracks
        .filter((tr) => tr.cls === 'plate')
        .map((tr) => [...tr.keyframes.values()][0].x),
    );
    expect(plateX).toEqual(new Set([200, 2, 322, 642, 962]));
  });

  it('adds no tiled pass without dashcamMode (one full-frame raster per frame)', async () => {
    installSink([0]);
    const canvas = installCanvas();

    await runAnalyze(baseOpts({ canvasFactory: canvas }));

    expect(canvas.ctx.getImageData).toHaveBeenCalledTimes(1);
    expect(canvas.ctx.getImageData).toHaveBeenCalledWith(0, 0, W, H);
  });
});

describe('progress reporting (REQ-009)', () => {
  it('emits model events first, then one honest analyze event per frame', async () => {
    installSink([0, 0.1, 0.2, 0.3]);
    const events = [];

    await runAnalyze(baseOpts({ onProgress: (p) => events.push(p) }));

    // Model download progress folded through createDetectors' callback.
    expect(events[0]).toEqual({ phase: 'models', model: 'yunet', fraction: 0.5 });
    expect(events[1]).toEqual({ phase: 'models', model: 'plate-yolov9t', fraction: 1 });

    const analyze = events.slice(2);
    expect(analyze).toHaveLength(4);
    for (const [i, e] of analyze.entries()) {
      expect(e.phase).toBe('analyze');
      expect(e.frameCount).toBe(i + 1);
      expect(e.totalFrames).toBe(4); // round(duration · fps)
      expect(e.trackCount).toBe(2); // one face + one plate record
      expect(Object.keys(e).sort()).toEqual(
        ['analyzeFps', 'etaSec', 'frameCount', 'phase', 'totalFrames', 'trackCount'].sort(),
      );
    }
    // 10 ms/frame clock → 100 fps steady state; frame 1 has no estimate yet.
    expect(analyze[0].analyzeFps).toBeNull();
    expect(analyze[0].etaSec).toBeNull();
    expect(analyze[1].analyzeFps).toBeCloseTo(100, 6);
    expect(analyze[1].etaSec).toBeCloseTo((4 - 2) / 100, 6);
    expect(analyze[3].etaSec).toBeCloseTo(0, 6);
  });

  it('reports totalFrames null (and never an ETA) when duration is unknown', async () => {
    installSink([0, 0.1]);
    const events = [];

    await runAnalyze(
      baseOpts({ meta: makeMeta({ duration: undefined }), onProgress: (p) => events.push(p) }),
    );

    const analyze = events.filter((e) => e.phase === 'analyze');
    expect(analyze.map((e) => e.totalFrames)).toEqual([null, null]);
    expect(analyze[1].analyzeFps).not.toBeNull(); // fps estimate still works
    expect(analyze[1].etaSec).toBeNull();
  });
});

describe('cancellation — AbortSignal mid-stream (AC-03)', () => {
  it('returns {cancelled: true} with finalized partial tracks and closes everything', async () => {
    const controller = new AbortController();
    const samples = installSink([0, 0.1, 0.2, 0.3]);
    detState.detectFace.mockImplementation(async () => {
      if (detState.detectFace.mock.calls.length === 2) controller.abort();
      return fullFaceDet();
    });

    const result = await runAnalyze(baseOpts({ signal: controller.signal }));

    // Frame 2 completed (abort hit mid-frame), frame 3 broke the loop.
    expect(result.cancelled).toBe(true);
    expect(result.frameCount).toBe(2);
    // finalize() STILL ran: the confirmed 2-hit face track is usable.
    // The 1-hit plate track stays tentative and is dropped.
    expect(result.tracks).toHaveLength(1);
    const face = result.tracks[0];
    expect(face.cls).toBe('face');
    expectStamped(face, [0, 0.1], { x: 100, y: 100, w: 60, h: 60 });
    expect(face.start).toBe(0);
    expect(face.end).toBeCloseTo(0.1 + PAD, 12);
    // The aborted iteration's already-pulled sample is closed too.
    expect(samples).toHaveLength(3);
    for (const s of samples) expect(s.close).toHaveBeenCalledTimes(1);
    expect(detState.detectorClosed).toBe(1);
  });

  it('a pre-aborted signal yields zero frames, no tracks, and still closes the first sample', async () => {
    const controller = new AbortController();
    controller.abort();
    const samples = installSink([0, 0.1]);
    const yieldNow = vi.fn(async () => {});

    const result = await runAnalyze(baseOpts({ signal: controller.signal, yieldNow }));

    // The mock createDetectors has no effectiveEp, so the resolve value
    // normalizes it to null (AC-17 active-provider notice field).
    expect(result).toEqual({ tracks: [], frameCount: 0, cancelled: true, effectiveEp: null });
    expect(samples).toHaveLength(1);
    expect(samples[0].close).toHaveBeenCalledTimes(1);
    expect(yieldNow).not.toHaveBeenCalled();
    expect(detState.detectorClosed).toBe(1);
  });
});

describe('memory discipline — sample.close() and error paths', () => {
  it('closes every delivered sample exactly once on a full run', async () => {
    const samples = installSink([0, 0.1, 0.2, 0.3]);

    await runAnalyze(baseOpts({}));

    expect(samples).toHaveLength(4);
    for (const s of samples) expect(s.close).toHaveBeenCalledTimes(1);
  });

  it('surfaces detector failures verbatim, closes the sample, and closes the detectors', async () => {
    const samples = installSink([0, 0.1, 0.2]);
    const yieldNow = vi.fn(async () => {});
    detState.detectFace.mockImplementation(async () => {
      if (detState.detectFace.mock.calls.length === 2) throw new Error('YuNet session exploded');
      return fullFaceDet();
    });

    await expect(runAnalyze(baseOpts({ yieldNow }))).rejects.toThrow('YuNet session exploded');

    expect(samples).toHaveLength(2); // frame 3 never pulled
    for (const s of samples) expect(s.close).toHaveBeenCalledTimes(1);
    expect(yieldNow).toHaveBeenCalledTimes(1); // frame 2 skipped its yield
    expect(detState.detectorClosed).toBe(1); // close() runs on the error path
  });
});

describe('loop mechanics — one canvas, per-frame yield (P-5)', () => {
  it('builds the canvas exactly once and draws every sample into the same context', async () => {
    installSink([0, 0.1, 0.2, 0.3]);
    const canvas = installCanvas();
    const { input, track } = makeInput();

    await runAnalyze(baseOpts({ input, canvasFactory: canvas }));

    // ONE canvas for the whole run, sized to the display frame.
    expect(canvas).toHaveBeenCalledTimes(1);
    expect(canvas.mock.calls[0]).toEqual([W, H]);
    // The sink is built once, from the input's primary video track.
    expect(VideoSampleSink).toHaveBeenCalledTimes(1);
    expect(VideoSampleSink.mock.results[0].value.videoTrack).toBe(track);
    // Every raster comes from the one shared canvas context.
    for (const call of detState.detectFace.mock.calls) {
      expect(call[0].width).toBe(W); // rasters all come from the one canvas
    }
    expect(canvas.ctx.getImageData).toHaveBeenCalledTimes(4);
    expect(canvas.ctx.getImageData).toHaveBeenCalledWith(0, 0, W, H);
  });

  it('yields to the event loop exactly once per processed frame, after its progress report', async () => {
    installSink([0, 0.1, 0.2]);
    const log = [];
    const yieldNow = vi.fn(async () => void log.push('yield'));

    await runAnalyze(
      baseOpts({
        yieldNow,
        onProgress: (e) => {
          if (e.phase === 'analyze') log.push(`frame ${e.frameCount}`);
        },
      }),
    );

    expect(log).toEqual(['frame 1', 'yield', 'frame 2', 'yield', 'frame 3', 'yield']);
  });

  it('throws when the input has no primary video track (detectors still closed)', async () => {
    await expect(
      runAnalyze(baseOpts({ input: { getPrimaryVideoTrack: vi.fn(async () => null) } })),
    ).rejects.toThrow('runAnalyze: input has no primary video track.');
    expect(detState.detectorClosed).toBe(1);
  });
});
