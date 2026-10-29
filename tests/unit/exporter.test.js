/**
 * Unit tests for src/exporter.js — REQ-017/018/019/021 (M6 task 12, plan §B).
 *
 * mediabunny is fully mocked: the tests pin the exact API surface exporter.js
 * relies on (Conversion.init/execute/cancel/onProgress, StreamTarget with a
 * WritableStream + chunked option, BufferTarget, Mp4/WebMOutputFormat,
 * canEncodeVideo, Quality, ConversionCanceledError), so the mock doubles as
 * an executable record of the contract (ADR-2, mediabunny 1.63.0 .d.ts).
 *
 * Pixelation is asserted with REAL redact.js code (no redact mock): the
 * burn-in process callback runs against a recording canvas context, so the
 * dilated burned region is read back from the recorded drawImage rects
 * (AC-04 pixel-truth symmetry).
 *
 * Covers: burn-in per sample (display-size draw + dilated box per timestamp),
 * disabled tracks kept visible, privacy density invariant surfaced (never
 * swallowed, no ladder retry), codec ladder probe order (avc hw → avc
 * software → vp9/WebM), settings.forceWebM escape hatch, runtime-failure
 * ladder retries with temp cleanup, audio packet-copy invariant (no `audio`
 * config, no `copy` override), StreamTarget→OPFS staging (chunked, byte
 * counting, chunk passthrough), progress payload {ratio, bytesWritten},
 * cancellation cleanup (AC-14), delivery channels (saveHandle / picker /
 * Blob fallback), buffer mode, and discardExportTemp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// mediabunny mock — pinned to the 1.63.0 surface exporter.js may use
// ---------------------------------------------------------------------------

vi.mock('mediabunny', () => {
  class ConversionCanceledError extends Error {
    constructor(message) {
      super(message ?? 'The conversion was canceled.');
      this.name = 'ConversionCanceledError';
    }
  }
  class Quality {
    constructor(level) { this.level = level; }
  }
  class Mp4OutputFormat {
    fileExtension = '.mp4';
    mimeType = 'video/mp4';
  }
  class WebMOutputFormat {
    fileExtension = '.webm';
    mimeType = 'video/webm';
  }
  class StreamTarget {
    constructor(writable, options) {
      this.writable = writable;
      this.options = options ?? {};
    }
  }
  class BufferTarget {
    constructor(options) {
      this.options = options ?? {};
      this.buffer = null;
    }
  }
  class Output {
    constructor(options) {
      this.format = options.format;
      this.target = options.target;
    }
  }
  class Conversion {
    constructor(options) {
      this.opts = options;
      this.onProgress = null;
      this.isValid = true;
      this.state = 'idle';
      this.execute = vi.fn(async () => {});
      this.cancel = vi.fn(async () => {});
    }
    static init = vi.fn(async (options) => new Conversion(options));
  }
  const canEncodeVideo = vi.fn();
  return {
    Conversion,
    ConversionCanceledError,
    Mp4OutputFormat,
    WebMOutputFormat,
    StreamTarget,
    BufferTarget,
    Output,
    Quality,
    canEncodeVideo,
  };
});

import * as mb from 'mediabunny';
import {
  ExportError,
  runExport,
  discardExportTemp,
  pixelateFrame,
} from '../../src/exporter.js';
import { dilate } from '../../src/redact.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Recording 2D-context mock (same pattern as redact.test.js): calls pushed
 * as [name, ...args], property sets as ['set', key, value].
 */
function makeCtx(canvas) {
  const calls = [];
  const props = {};
  const ctx = {
    canvas,
    save: () => calls.push(['save']),
    restore: () => calls.push(['restore']),
    drawImage: (img, ...args) => calls.push(['drawImage', img, ...args]),
  };
  for (const key of ['imageSmoothingEnabled', 'fillStyle', 'strokeStyle']) {
    Object.defineProperty(ctx, key, {
      get: () => props[key],
      set: (v) => { props[key] = v; calls.push(['set', key, v]); },
    });
  }
  return { ctx, calls, props };
}

/** Fake canvas standing in for OffscreenCanvas (stubbed global). */
let canvases;
class FakeOffscreenCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.rec = makeCtx(this);
    canvases.push(this);
  }
  getContext() { return this.rec.ctx; }
}

/** Fake VideoSample: only what the burn-in process callback consumes. */
function fakeSample(t, { w = 320, h = 180 } = {}) {
  const draws = [];
  return {
    timestamp: t,
    duration: 1 / 30,
    displayWidth: w,
    displayHeight: h,
    draw: vi.fn((ctx, dx, dy, dw, dh) => draws.push([dx, dy, dw, dh])),
    close: vi.fn(),
    draws,
  };
}

/** Track fixture matching the design §2 typedef (dense keyframes). */
function makeTrack(over = {}) {
  return {
    id: 1,
    cls: 'face',
    label: 'Face #1',
    color: '#2DD4BF',
    keyframes: new Map(),
    start: 0,
    end: 10,
    enabled: true,
    source: 'auto',
    ...over,
  };
}

/** Fake input exposing only getPrimaryVideoTrack (display-size probe). */
function fakeInput({ w = 320, h = 180 } = {}) {
  return {
    getPrimaryVideoTrack: vi.fn(async () => ({
      getDisplayWidth: async () => w,
      getDisplayHeight: async () => h,
    })),
  };
}

/** Fake OPFS file handle: writable records StreamTargetChunks, getFile → Blob. */
function fakeOpfsFile(name) {
  const chunks = [];
  const writable = new WritableStream({
    write(c) { chunks.push(c); },
  });
  const handle = {
    name,
    createWritable: vi.fn(async () => writable),
    getFile: vi.fn(async () => new Blob(chunks.map((c) => c.data))),
  };
  return { handle, chunks };
}

/** Fake OPFS 'exports' dir + root, with a removal log. */
function installOpfs() {
  const removed = [];
  const files = [];
  const exportsDir = {
    removeEntry: vi.fn(async (name) => { removed.push(name); }),
    getFileHandle: vi.fn(async (name) => {
      const f = fakeOpfsFile(name);
      files.push(f);
      return f.handle;
    }),
  };
  const root = {
    getDirectoryHandle: vi.fn(async (name, opts) => {
      expect(name).toBe('exports');
      if (opts !== undefined) expect(opts).toEqual({ create: true }); // discardExportTemp opens without create
      return exportsDir;
    }),
    removeEntry: vi.fn(async () => {}),
  };
  vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn(async () => root) } });
  return { root, exportsDir, files, removed };
}

/** Fake File System Access save target: records piped bytes. */
function fakeSaveHandle() {
  const parts = [];
  const writable = new WritableStream({
    write(c) { parts.push(c); },
  });
  return { handle: { createWritable: vi.fn(async () => writable) }, parts };
}

/** Script a Conversion instance's execute() like the real pipeline would run. */
function scriptExecute(conv, { failWith = null, onDone = () => {}, gate = null, cancelGate = null } = {}) {
  conv.execute.mockImplementation(async () => {
    if (gate) await gate.promise;
    const target = conv.opts.output.target;
    if (target instanceof mb.StreamTarget) {
      const writer = target.writable.getWriter();
      await writer.write({ type: 'write', data: new Uint8Array([1, 2, 3]), position: 0 });
      await writer.close();
    }
    if (target instanceof mb.BufferTarget) {
      target.buffer = new Uint8Array([9, 8, 7]).buffer;
    }
    conv.onProgress?.(0.5, 0.5); // progress fires after bytes flowed (bytesWritten visible)
    onDone();
    if (cancelGate) await cancelGate.promise;
    if (failWith) throw failWith;
  });
  return conv;
}

const u8 = (...bytes) => new Uint8Array(bytes);

beforeEach(() => {
  canvases = [];
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
  mb.Conversion.init.mockClear();
  mb.canEncodeVideo.mockReset();
  mb.canEncodeVideo.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Default runExport options: buffer mode unless a test needs OPFS. */
const bufferSettings = { outputMode: 'buffer', quality: 'high' };

// ---------------------------------------------------------------------------
// Burn-in (REQ-016/017, AC-04)
// ---------------------------------------------------------------------------

describe('runExport — burn-in process callback (AC-04)', () => {
  it('draws each sample at display size and burns the DILATED box per timestamp', async () => {
    const boxA = { x: 100, y: 50, w: 40, h: 40 }; // → dilated {97, 47, 46, 46}
    const boxB = { x: 200, y: 60, w: 20, h: 20 }; // → dilated {198.5, 58.5, 23, 23}
    const track = makeTrack({
      keyframes: new Map([[1, boxA], [2, boxB]]),
      start: 1,
      end: 3,
    });
    const input = fakeInput();
    const s1 = fakeSample(1.2); // nearest keyframe → boxA
    const s2 = fakeSample(1.9); // nearest keyframe → boxB

    let conv;
    mb.Conversion.init.mockImplementation(async (opts) => {
      conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => { conv.opts.video.process(s1); conv.opts.video.process(s2); } });
      return conv;
    });

    const result = await runExport({ input, tracks: [track], settings: bufferSettings });

    // Frame canvas drawn at source display size, one per sample, in order.
    const frameCanvas = canvases[0];
    expect(frameCanvas.width).toBe(320);
    expect(frameCanvas.height).toBe(180);
    expect(s1.draw).toHaveBeenCalledWith(frameCanvas.rec.ctx, 0, 0, 320, 180);
    expect(s2.draw).toHaveBeenCalledWith(frameCanvas.rec.ctx, 0, 0, 320, 180);
    expect(s1.close).not.toHaveBeenCalled(); // pipeline owns sample lifecycle
    expect(s2.close).not.toHaveBeenCalled();

    // The process callback returned the reused frame canvas both times.
    expect(result.blob).toBeInstanceOf(Blob);

    // Pixelation burned: the last drawImage per sample is the nearest-neighbour
    // upscale back into the DILATED box (dilate(box, 0.15, frame) — clamped).
    const upscales = [...frameCanvas.rec.calls].filter((c) => c[0] === 'drawImage');
    expect(upscales).toHaveLength(2);
    expect(upscales[0].slice(2)).toEqual([0, 0, 4, 4, 97, 47, 46, 46]);
    expect(upscales[1].slice(2)).toEqual([0, 0, 2, 2, 198.5, 58.5, 23, 23]);
  });

  it('samples ONLY the dilated region into the pixelation scratch (reused canvas)', async () => {
    const track = makeTrack({ keyframes: new Map([[0, { x: 100, y: 50, w: 40, h: 40 }]]) });
    let conv;
    mb.Conversion.init.mockImplementation(async (opts) => {
      conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => conv.opts.video.process(fakeSample(0)) });
      return conv;
    });
    await runExport({ input: fakeInput(), tracks: [track], settings: bufferSettings });

    const frameCanvas = canvases[0];
    const scratch = canvases[1]; // second created canvas = pixelation scratch
    expect(scratch).toBeDefined();

    // Downscale step ran on the scratch, sourcing exactly the dilated box
    // from the frame canvas: drawImage(frame, 97, 47, 46, 46, 0, 0, 4, 4).
    const downs = scratch.rec.calls.filter((c) => c[0] === 'drawImage');
    expect(downs).toHaveLength(1);
    expect(downs[0][1]).toBe(frameCanvas);
    expect(downs[0].slice(2)).toEqual([97, 47, 46, 46, 0, 0, 4, 4]);

    // The upscale drew FROM the scratch canvas.
    const ups = frameCanvas.rec.calls.filter((c) => c[0] === 'drawImage');
    expect(ups[0][1]).toBe(scratch);
  });

  it('keeps disabled tracks visible (REQ-014): no pixelation for disabled hits', async () => {
    const track = makeTrack({ enabled: false, keyframes: new Map([[0, { x: 10, y: 10, w: 50, h: 50 }]]) });
    let conv;
    mb.Conversion.init.mockImplementation(async (opts) => {
      conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => conv.opts.video.process(fakeSample(0)) });
      return conv;
    });
    await runExport({ input: fakeInput(), tracks: [track], settings: bufferSettings });
    const frameCanvas = canvases[0];
    expect(frameCanvas.rec.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(0);
  });

  it('leaves frames untouched outside active spans', async () => {
    const track = makeTrack({ keyframes: new Map([[5, { x: 0, y: 0, w: 20, h: 20 }]]), start: 5, end: 6 });
    let conv;
    mb.Conversion.init.mockImplementation(async (opts) => {
      conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => conv.opts.video.process(fakeSample(0)) });
      return conv;
    });
    await runExport({ input: fakeInput(), tracks: [track], settings: bufferSettings });
    const frameCanvas = canvases[0];
    expect(frameCanvas.rec.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(0);
  });

  it('surfaces the tracksAt density invariant as ExportError — no ladder retry, no silent output', async () => {
    // Enabled track covering t=0 with ZERO keyframes: a tracker bug that must
    // fail loudly (privacy invariant, design §2) — never export unredacted.
    const track = makeTrack({ keyframes: new Map() });
    let conv;
    mb.Conversion.init.mockImplementation(async (opts) => {
      conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => conv.opts.video.process(fakeSample(0)) });
      return conv;
    });

    const promise = runExport({ input: fakeInput(), tracks: [track], settings: bufferSettings });
    await expect(promise).rejects.toMatchObject({ name: 'ExportError' });
    const err = await promise.catch((e) => e);
    expect(err.stage).toBe('encode-avc');
    expect(String(err.cause?.message)).toMatch(/tracksAt: track 1 covers t=0/);
    expect(mb.Conversion.init).toHaveBeenCalledTimes(1); // invariant is codec-independent: no retry
  });
});

// ---------------------------------------------------------------------------
// Shared composition seam (editor alignment — AC-04 symmetry)
// ---------------------------------------------------------------------------

describe('pixelateFrame — shared dilate+applyPixelation composition', () => {
  it('pixelates the dilated box at t, ignoring disabled tracks', () => {
    const rec = makeCtx({ width: 320, height: 180 });
    const scratchRec = makeCtx({ width: 0, height: 0 });
    const scratch = { width: 0, height: 0, getContext: () => scratchRec.ctx };
    const tracks = [
      makeTrack({ keyframes: new Map([[2, { x: 100, y: 50, w: 40, h: 40 }]]), start: 2, end: 3 }),
      makeTrack({ id: 2, enabled: false, keyframes: new Map([[2, { x: 0, y: 0, w: 99, h: 99 }]]) }),
    ];
    pixelateFrame(rec.ctx, tracks, 2, { width: 320, height: 180 }, { scratch });
    const ups = rec.calls.filter((c) => c[0] === 'drawImage');
    expect(ups).toHaveLength(1);
    expect(ups[0].slice(2)).toEqual([0, 0, 4, 4, 97, 47, 46, 46]);
  });

  it('matches the box redact.dilate produces (composition contract)', () => {
    const rec = makeCtx({ width: 320, height: 180 });
    const scratch = { width: 0, height: 0, getContext: () => makeCtx({ width: 0, height: 0 }).ctx };
    const box = { x: 20, y: 30, w: 60, h: 10 };
    const tracks = [makeTrack({ keyframes: new Map([[0, box]]) })];
    pixelateFrame(rec.ctx, tracks, 0, { width: 320, height: 180 }, { scratch });
    const expected = dilate(box, 0.15, { width: 320, height: 180 });
    const ups = rec.calls.filter((c) => c[0] === 'drawImage');
    expect(ups[0].slice(6)).toEqual([expected.x, expected.y, expected.w, expected.h]);
  });
});

// ---------------------------------------------------------------------------
// Codec ladder (REQ-017, AC-12) + audio packet-copy invariant (AC-08)
// ---------------------------------------------------------------------------

describe('runExport — codec ladder and container selection', () => {
  it('uses avc + Mp4OutputFormat + prefer-hardware as the primary path', async () => {
    let opts;
    mb.Conversion.init.mockImplementation(async (o) => {
      opts = o;
      return scriptExecute(new mb.Conversion(o));
    });
    const result = await runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });

    expect(mb.canEncodeVideo).toHaveBeenCalledWith('avc', {
      width: 320, height: 180, hardwareAcceleration: 'prefer-hardware',
    });
    expect(opts.video.codec).toBe('avc');
    expect(opts.video.hardwareAcceleration).toBe('prefer-hardware');
    expect(opts.output.format).toBeInstanceOf(mb.Mp4OutputFormat);
    expect(opts.video.quality.level).toBe('high');
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.bytes).toBe(3); // scripted buffer payload
  });

  it('walks the full ladder when probing fails: avc → software → vp9/WebM', async () => {
    mb.canEncodeVideo
      .mockResolvedValueOnce(false) // avc prefer-hardware
      .mockResolvedValueOnce(false) // avc prefer-software
      .mockResolvedValueOnce(true); // vp9
    let opts;
    mb.Conversion.init.mockImplementation(async (o) => {
      opts = o;
      return scriptExecute(new mb.Conversion(o));
    });

    await runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });

    expect(mb.canEncodeVideo.mock.calls.map((c) => c[0])).toEqual(['avc', 'avc', 'vp9']);
    expect(mb.canEncodeVideo.mock.calls[1][1].hardwareAcceleration).toBe('prefer-software');
    expect(opts.video.codec).toBe('vp9');
    expect(opts.output.format).toBeInstanceOf(mb.WebMOutputFormat);
  });

  it('throws ExportError with the deepest stage when no encode path exists', async () => {
    mb.canEncodeVideo.mockResolvedValue(false);
    const promise = runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });
    await expect(promise).rejects.toMatchObject({ name: 'ExportError', stage: 'encode-vp9' });
    expect(mb.Conversion.init).not.toHaveBeenCalled();
  });

  it('settings.forceWebM jumps straight to vp9 + WebMOutputFormat', async () => {
    let opts;
    mb.Conversion.init.mockImplementation(async (o) => {
      opts = o;
      return scriptExecute(new mb.Conversion(o));
    });
    await runExport({
      input: fakeInput(), tracks: [], settings: { ...bufferSettings, forceWebM: true },
    });
    expect(mb.canEncodeVideo).toHaveBeenCalledTimes(1);
    expect(mb.canEncodeVideo).toHaveBeenCalledWith('vp9', expect.objectContaining({ width: 320, height: 180 }));
    expect(opts.video.codec).toBe('vp9');
    expect(opts.output.format).toBeInstanceOf(mb.WebMOutputFormat);
  });

  it('retries the ladder at RUNTIME when encoding fails mid-conversion (AC-12)', async () => {
    mb.canEncodeVideo.mockResolvedValue(true); // all rungs pass the probe
    const opfs = installOpfs(); // stream mode stages into OPFS per attempt
    const inits = [];
    let call = 0;
    mb.Conversion.init.mockImplementation(async (o) => {
      inits.push(o);
      const conv = new mb.Conversion(o);
      scriptExecute(conv, {
        failWith: call++ === 0 ? Object.assign(new Error('H.264 encoder failed at 320x180'), { name: 'EncodingError' }) : null,
      });
      return conv;
    });

    const result = await runExport({
      input: fakeInput(),
      tracks: [],
      settings: { outputMode: 'stream', quality: 'high' },
    });

    expect(mb.Conversion.init).toHaveBeenCalledTimes(2);
    expect(inits[0].video.hardwareAcceleration).toBe('prefer-hardware');
    expect(inits[1].video.hardwareAcceleration).toBe('prefer-software');
    expect(result.blob).toBeInstanceOf(Blob);
    // Attempt 1's temp removed on failure; attempt 2's temp removed after blob delivery.
    expect(opfs.removed).toEqual([opfs.files[0].handle.name, opfs.files[1].handle.name]);
  });

  it('exhausts the ladder at runtime and throws the deepest stage with cause', async () => {
    mb.canEncodeVideo.mockResolvedValue(true);
    installOpfs();
    const lastError = new Error('vp9 encoder exploded');
    mb.Conversion.init.mockImplementation(async (o) => {
      const conv = new mb.Conversion(o);
      scriptExecute(conv, { failWith: lastError });
      return conv;
    });
    const promise = runExport({
      input: fakeInput(), tracks: [], settings: { outputMode: 'stream', quality: 'high' },
    });
    await expect(promise).rejects.toMatchObject({
      name: 'ExportError',
      stage: 'encode-vp9',
      cause: lastError,
    });
    expect(mb.Conversion.init).toHaveBeenCalledTimes(3);
  });

  it('never configures audio (packet-copy invariant) on both container paths (AC-08)', async () => {
    const seen = [];
    mb.Conversion.init.mockImplementation(async (o) => {
      seen.push(o);
      return scriptExecute(new mb.Conversion(o));
    });

    mb.canEncodeVideo
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });

    for (const opts of seen) {
      expect('audio' in opts).toBe(false); // omitting audio ⇒ packet-copy when container hosts the codec
      expect(opts.copy).toBeUndefined();   // default copy policy — never forced to transcode
      expect(opts.video.forceTranscode).toBeUndefined();
    }
  });

  it('maps settings.quality balanced → Quality medium', async () => {
    let opts;
    mb.Conversion.init.mockImplementation(async (o) => {
      opts = o;
      return scriptExecute(new mb.Conversion(o));
    });
    await runExport({ input: fakeInput(), tracks: [], settings: { ...bufferSettings, quality: 'balanced' } });
    expect(opts.video.quality.level).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Stream target → OPFS staging (REQ-018) + progress + cancel (AC-14)
// ---------------------------------------------------------------------------

describe('runExport — stream mode (default): OPFS staging, progress, cancel', () => {
  it('stages into OPFS exports/ via chunked StreamTarget, counting bytes and forwarding progress', async () => {
    const opfs = installOpfs();
    const progress = [];
    let opts;
    mb.Conversion.init.mockImplementation(async (o) => {
      opts = o;
      return scriptExecute(new mb.Conversion(o));
    });

    const result = await runExport({
      input: fakeInput(), tracks: [], settings: { quality: 'high' }, onProgress: (p) => progress.push(p),
    });

    // Staging location + naming (crash-recovery listing relies on the prefix).
    expect(opfs.files).toHaveLength(1);
    expect(opfs.files[0].handle.name).toMatch(/^redact-export-\d+-[a-z0-9]+-[a-z0-9]+\.mp4$/);

    // Chunked StreamTarget receiving a real WritableStream.
    const target = opts.output.target;
    expect(target).toBeInstanceOf(mb.StreamTarget);
    expect(target.options.chunked).toBe(true);
    expect(target.writable).toBeInstanceOf(WritableStream);

    // Scripted chunk flowed through to the staged file; bytes counted.
    expect(opfs.files[0].chunks).toEqual([
      { type: 'write', data: u8(1, 2, 3), position: 0 },
    ]);
    expect(progress).toEqual([{ ratio: 0.5, bytesWritten: 3 }]);
    expect(result.bytes).toBe(3);
    expect(result.handle).toBeNull();
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.opfsPath).toBeUndefined(); // temp is always cleaned before return (REQ-019)

    // Blob delivery deletes the temp file.
    expect(opfs.removed).toEqual([opfs.files[0].handle.name]);
    expect(await result.blob.arrayBuffer()).toEqual(u8(1, 2, 3).buffer);
  });

  it('cancels via conversion.cancel(), cleans the temp file, and rejects ExportError(cancelled)', async () => {
    const opfs = installOpfs();
    const gate = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    const controller = new AbortController();

    let conv;
    let started = false;
    mb.Conversion.init.mockImplementation(async (o) => {
      conv = new mb.Conversion(o);
      conv.cancel.mockImplementation(async () => gate.resolve());
      conv.execute.mockImplementation(async () => {
        started = true;
        await gate.promise;
        throw new mb.ConversionCanceledError('canceled');
      });
      return conv;
    });

    const promise = runExport({
      input: fakeInput(), tracks: [], settings: { quality: 'high' }, signal: controller.signal,
    });
    await vi.waitUntil(() => started);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'ExportError', stage: 'cancelled' });
    expect(conv.cancel).toHaveBeenCalledTimes(1);
    // AC-14: no temporary residue in OPFS after cancellation.
    expect(opfs.removed).toEqual([opfs.files[0].handle.name]);
  });

  it('rejects immediately with ExportError(cancelled) when the signal is pre-aborted', async () => {
    installOpfs();
    const controller = new AbortController();
    controller.abort();
    const promise = runExport({
      input: fakeInput(), tracks: [], settings: { quality: 'high' }, signal: controller.signal,
    });
    await expect(promise).rejects.toMatchObject({ name: 'ExportError', stage: 'cancelled' });
    expect(mb.Conversion.init).not.toHaveBeenCalled();
  });

  it('removes a failed attempt’s temp before retrying the ladder (no partial residue)', async () => {
    mb.canEncodeVideo.mockResolvedValue(true);
    const opfs = installOpfs();
    let call = 0;
    mb.Conversion.init.mockImplementation(async (o) => {
      const conv = new mb.Conversion(o);
      scriptExecute(conv, { failWith: call++ === 0 ? new Error('boom') : null });
      return conv;
    });
    await runExport({ input: fakeInput(), tracks: [], settings: { quality: 'high' } });
    expect(opfs.files).toHaveLength(2);
    expect(opfs.removed).toEqual([
      opfs.files[0].handle.name, // failed attempt's temp
      opfs.files[1].handle.name, // delivered-as-blob temp
    ]);
  });

  it('maps stream-write failures to ExportError(io) without ladder retries', async () => {
    const opfs = installOpfs();
    const writeFail = new Error('quota exceeded');
    opfs.exportsDir.getFileHandle.mockImplementationOnce(async (name) => {
      const f = fakeOpfsFile(name);
      f.handle.createWritable = async () => new WritableStream({
        write() { throw writeFail; },
      });
      opfs.files[0] = f;
      return f.handle;
    });
    mb.Conversion.init.mockImplementation(async (o) => {
      const conv = new mb.Conversion(o);
      conv.execute.mockImplementation(async () => {
        const writer = conv.opts.output.target.writable.getWriter();
        await writer.write({ type: 'write', data: u8(1), position: 0 });
      });
      return conv;
    });

    const promise = runExport({ input: fakeInput(), tracks: [], settings: { quality: 'high' } });
    await expect(promise).rejects.toMatchObject({ name: 'ExportError', stage: 'io', cause: writeFail });
    expect(mb.Conversion.init).toHaveBeenCalledTimes(1); // disk errors don't burn the codec ladder
    expect(opfs.removed).toEqual([opfs.files[0].handle.name]);
  });
});

// ---------------------------------------------------------------------------
// Delivery channels (REQ-019) + buffer mode
// ---------------------------------------------------------------------------

describe('runExport — delivery channels and buffer mode', () => {
  it('delivers to settings.saveHandle and deletes the temp (REQ-019)', async () => {
    const opfs = installOpfs();
    const save = fakeSaveHandle();
    let opts;
    mb.Conversion.init.mockImplementation(async (o) => {
      opts = o;
      return scriptExecute(new mb.Conversion(o));
    });

    const result = await runExport({
      input: fakeInput(), tracks: [], settings: { quality: 'high', saveHandle: save.handle },
    });

    expect(opts.output.target).toBeInstanceOf(mb.StreamTarget);
    expect(save.parts).toEqual([u8(1, 2, 3)]);
    expect(opfs.removed).toEqual([opfs.files[0].handle.name]);
    expect(result.handle).toBe(save.handle);
    expect(result.blob).toBeUndefined();
    expect(result.bytes).toBe(3);
  });

  it('uses showSaveFilePicker when available and writes the picked file', async () => {
    installOpfs();
    const picker = vi.fn(async (pickerOpts) => {
      expect(pickerOpts.suggestedName).toMatch(/^redacted-\d+\.mp4$/);
      return fakeSaveHandle().handle;
    });
    vi.stubGlobal('showSaveFilePicker', picker);

    const result = await runExport({ input: fakeInput(), tracks: [], settings: { quality: 'high' } });
    expect(picker).toHaveBeenCalledTimes(1);
    expect(result.handle).toBeDefined();
    expect(result.blob).toBeUndefined();
  });

  it('falls back to Blob download when the picker is unavailable (DOM-guarded)', async () => {
    installOpfs(); // no showSaveFilePicker global → blob path
    const result = await runExport({ input: fakeInput(), tracks: [], settings: { quality: 'high' } });
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.handle).toBeNull();
  });

  it('buffer mode: BufferTarget → Blob without touching OPFS', async () => {
    const opfs = installOpfs();
    let opts;
    mb.Conversion.init.mockImplementation(async (o) => {
      opts = o;
      return scriptExecute(new mb.Conversion(o));
    });

    const result = await runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });

    expect(opts.output.target).toBeInstanceOf(mb.BufferTarget);
    expect(opfs.root.getDirectoryHandle).not.toHaveBeenCalled(); // no OPFS staging
    expect(result.blob).toBeInstanceOf(Blob);
    expect(await result.blob.arrayBuffer()).toEqual(u8(9, 8, 7).buffer);
    expect(result.bytes).toBe(3);
    expect(result.handle).toBeNull();
  });

  it('buffer mode + saveHandle pipes the buffer without staging', async () => {
    installOpfs();
    const save = fakeSaveHandle();
    const result = await runExport({
      input: fakeInput(), tracks: [], settings: { ...bufferSettings, saveHandle: save.handle },
    });
    expect(save.parts).toEqual([u8(9, 8, 7)]);
    expect(result.handle).toBe(save.handle);
    expect(result.bytes).toBe(3);
  });

  it('wraps missing decode/input failures as ExportError(io)', async () => {
    const input = { getPrimaryVideoTrack: async () => null };
    const promise = runExport({ input, tracks: [], settings: bufferSettings });
    await expect(promise).rejects.toMatchObject({ name: 'ExportError', stage: 'io' });
  });
});

// ---------------------------------------------------------------------------
// discardExportTemp (crash-recovery seam for main.js)
// ---------------------------------------------------------------------------

describe('discardExportTemp', () => {
  it('removes the entry under exports/ and resolves true', async () => {
    const opfs = installOpfs();
    await expect(discardExportTemp('exports/redact-export-123.mp4')).resolves.toBe(true);
    expect(opfs.exportsDir.removeEntry).toHaveBeenCalledWith('redact-export-123.mp4');
  });

  it('resolves false when the exports dir does not exist', async () => {
    const notFound = Object.assign(new Error('not found'), { name: 'NotFoundError' });
    const root = {
      getDirectoryHandle: async () => { throw notFound; },
    };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    await expect(discardExportTemp('exports/x.mp4')).resolves.toBe(false);
  });

  it('rejects with ExportError(io) when OPFS is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const promise = discardExportTemp('exports/x.mp4');
    await expect(promise).rejects.toMatchObject({ name: 'ExportError', stage: 'io' });
  });
});

// ---------------------------------------------------------------------------
// Focused error-path coverage (T-702): pure failure modes of exporter's
// internal helpers, exercised through runExport / discardExportTemp.
// ---------------------------------------------------------------------------

describe('runExport — probe and frame-size failure paths', () => {
  it('a REJECTING canEncodeVideo probe is an unsupported rung; empty ladder → deepest stage', async () => {
    mb.canEncodeVideo.mockRejectedValue(new Error('probe crashed'));
    const promise = runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });
    await expect(promise).rejects.toMatchObject({
      name: 'ExportError',
      stage: 'encode-vp9',
      message: expect.stringContaining('No viable video encode path at 320×180'),
    });
  });

  it('getPrimaryVideoTrack rejection → ExportError(io) "Could not read the video track"', async () => {
    const input = { getPrimaryVideoTrack: async () => { throw new Error('demuxer exploded'); } };
    await expect(runExport({ input, tracks: [], settings: bufferSettings })).rejects.toMatchObject({
      name: 'ExportError',
      stage: 'io',
      message: 'Could not read the video track for export.',
    });
  });

  it('invalid display size (0×0) → ExportError(io) "invalid frame size"', async () => {
    const input = fakeInput({ w: 0, h: 0 });
    await expect(runExport({ input, tracks: [], settings: bufferSettings })).rejects.toMatchObject({
      name: 'ExportError',
      stage: 'io',
      message: 'The video track reports an invalid frame size.',
    });
  });
});

describe('runExport — burn-in canvas paths', () => {
  it('no canvas implementation at all → every rung fails, deepest stage surfaces', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined); // node env also has no document
    const promise = runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });
    await expect(promise).rejects.toMatchObject({
      name: 'ExportError',
      stage: 'encode-vp9',
      message: expect.stringContaining('No canvas implementation available for burn-in export.'),
    });
  });

  it('DOM canvas fallback sizes the canvas (never the 300×150 default)', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const created = [];
    const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal('document', {
      createElement: (tag) => {
        created.push(tag);
        if (tag === 'a') return anchor;
        const c = new FakeOffscreenCanvas(0, 0); // fresh canvas per createCanvas call
        return c;
      },
      body: { appendChild: vi.fn() }, // deliver() may reach the DOM download path
    });
    let conv;
    mb.Conversion.init.mockImplementation(async (o) => {
      conv = new mb.Conversion(o);
      scriptExecute(conv, { onDone: () => conv.opts.video.process(fakeSample(1)) });
      return conv;
    });

    const result = await runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });

    expect(created[0]).toBe('canvas'); // frame canvas via the DOM fallback
    expect([canvases[0].width, canvases[0].height]).toEqual([320, 180]); // sized, not 300×150
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it('mid-stream resolution change resizes the reused frame canvas', async () => {
    const s1 = fakeSample(1); // 320×180
    const s2 = fakeSample(2, { w: 160, h: 90 });
    let conv;
    mb.Conversion.init.mockImplementation(async (o) => {
      conv = new mb.Conversion(o);
      scriptExecute(conv, { onDone: () => { conv.opts.video.process(s1); conv.opts.video.process(s2); } });
      return conv;
    });

    await runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });

    const frame = canvases[0]; // frameCanvas is created before the scratch
    expect([frame.width, frame.height]).toEqual([160, 90]); // resized on s2
  });
});

describe('runExport — OPFS staging failure paths (stream mode)', () => {
  it('OPFS unavailable → ExportError(io) "OPFS ... unavailable for export staging"', async () => {
    vi.stubGlobal('navigator', {}); // no navigator.storage
    await expect(runExport({ input: fakeInput(), tracks: [], settings: { quality: 'high' } }))
      .rejects.toMatchObject({
        name: 'ExportError',
        stage: 'io',
        message: expect.stringContaining('unavailable for export staging'),
      });
  });

  it('exports/ dir creation failure → ExportError(io) "staging directory"', async () => {
    const root = { getDirectoryHandle: async () => { throw new Error('quota exceeded'); } };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    await expect(runExport({ input: fakeInput(), tracks: [], settings: { quality: 'high' } }))
      .rejects.toMatchObject({
        name: 'ExportError',
        stage: 'io',
        message: expect.stringContaining('Could not open the exports/ staging directory'),
      });
  });

  it('staging file creation failure → ExportError(io) "Could not create staging file"', async () => {
    const exportsDir = { getFileHandle: async () => { throw new Error('quota exceeded'); } };
    const root = { getDirectoryHandle: async () => exportsDir };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    await expect(runExport({ input: fakeInput(), tracks: [], settings: { quality: 'high' } }))
      .rejects.toMatchObject({
        name: 'ExportError',
        stage: 'io',
        message: expect.stringContaining('Could not create staging file exports/redact-export-'),
      });
  });

  it('aborted sink classifies as ExportError(io) without ladder retry', async () => {
    installOpfs();
    let conv;
    mb.Conversion.init.mockImplementation(async (o) => {
      conv = new mb.Conversion(o);
      conv.execute.mockImplementation(async () => {
        const target = conv.opts.output.target;
        await target.writable.abort(new Error('disk full'));
        throw new Error('stream closed');
      });
      return conv;
    });

    await expect(runExport({ input: fakeInput(), tracks: [], settings: { quality: 'high' } }))
      .rejects.toMatchObject({
        name: 'ExportError',
        stage: 'io',
        message: expect.stringContaining('Writing the export file failed'),
      });
  });
});

describe('runExport — conversion validity and Blob-channel DOM delivery', () => {
  it('isValid=false on every rung → deepest stage surfaces the discarded-track reasons', async () => {
    mb.Conversion.init.mockImplementation(async (o) => {
      const conv = new mb.Conversion(o);
      conv.isValid = false;
      conv.discardedTracks = [{ track: { type: 'video' }, reason: 'no supported codec' }];
      return conv;
    });

    await expect(runExport({ input: fakeInput(), tracks: [], settings: bufferSettings }))
      .rejects.toMatchObject({
        name: 'ExportError',
        stage: 'encode-vp9',
        message: expect.stringContaining(
          'Conversion configuration is invalid (video: no supported codec)',
        ),
      });
  });

  it('Blob channel drives the DOM download (anchor click + delayed revoke)', async () => {
    vi.useFakeTimers();
    try {
      const created = [];
      const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
      vi.stubGlobal('document', {
        createElement: (tag) => { created.push(tag); return anchor; },
        body: { appendChild: vi.fn() },
      });
      const urls = [];
      const revoked = [];
      vi.stubGlobal('URL', {
        createObjectURL: (blob) => { urls.push(blob); return `blob:fake-${urls.length}`; },
        revokeObjectURL: (u) => { revoked.push(u); },
      });
      // Conversion.init implementations leak across tests in this suite
      // (beforeEach only mockClears) — install this test's own success script.
      mb.Conversion.init.mockImplementation(async (o) => scriptExecute(new mb.Conversion(o)));

      const result = await runExport({ input: fakeInput(), tracks: [], settings: bufferSettings });

      expect(result.blob).toBeInstanceOf(Blob);
      expect(created).toEqual(['a']);
      expect(anchor.download).toMatch(/^redacted-\d+\.mp4$/);
      expect(anchor.click).toHaveBeenCalledTimes(1);
      expect(urls[0]).toBe(result.blob);
      vi.advanceTimersByTime(30_000);
      expect(revoked).toEqual(['blob:fake-1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('discardExportTemp — non-NotFound failure classification', () => {
  it('dir open failure (non-NotFoundError) → ExportError(io) "Could not open exports/"', async () => {
    const root = { getDirectoryHandle: async () => { throw new Error('permission denied'); } };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    await expect(discardExportTemp('exports/x.mp4')).rejects.toMatchObject({
      name: 'ExportError',
      stage: 'io',
      message: 'Could not open exports/ for cleanup.',
    });
  });

  it('removeEntry failure (non-NotFoundError) → ExportError(io) "Could not delete"', async () => {
    const exportsDir = { removeEntry: async () => { throw new Error('readonly fs'); } };
    const root = { getDirectoryHandle: async () => exportsDir };
    vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } });
    await expect(discardExportTemp('exports/x.mp4')).rejects.toMatchObject({
      name: 'ExportError',
      stage: 'io',
      message: 'Could not delete exports/x.mp4.',
    });
  });
});
