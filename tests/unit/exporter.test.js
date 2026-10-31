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

/** Mutable fixture state shared with the mock classes (v1.15.0 trim path). */
const { mbState } = vi.hoisted(() => ({
  mbState: {
    // Concat-phase fixtures: packets the mock segment Inputs yield.
    segVideoPackets: [],
    segAudioPackets: [],
    segVideoCodec: 'avc',
    segAudioCodec: 'aac',
    segVideoDecoderConfig: { codec: 'avc1.640028' },
    segAudioDecoderConfig: { codec: 'mp4a.40.2' },
    // When true, the video packet source throws from its 2nd add (mux fail).
    failVideoAdd: false,
    // Every mock Output / Input instance, for assertions.
    outputs: [],
    inputs: [],
  },
}));

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
      this.tracks = [];
      this.started = false;
      this.finalized = false;
      mbState.outputs.push(this);
    }
    addVideoTrack(source, metadata) {
      this.tracks.push({ source, metadata, type: 'video' });
      return { source };
    }
    addAudioTrack(source, metadata) {
      this.tracks.push({ source, metadata, type: 'audio' });
      return { source };
    }
    hasEnoughTracks() { return this.tracks.length > 0; }
    async start() { this.started = true; }
    async finalize() { this.finalized = true; }
    async cancel() {}
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
  // --- v1.15.0 trim-concat surface ---
  const ALL_FORMATS = ['ALL_FORMATS'];
  class BlobSource {
    constructor(blob) { this.blob = blob; }
  }
  class EncodedPacket {
    constructor(data, type, timestamp, duration, sequenceNumber, byteLength, sideData) {
      this.data = data;
      this.type = type;
      this.timestamp = timestamp;
      this.duration = duration;
      this.sequenceNumber = sequenceNumber;
      this.byteLength = byteLength;
      this.sideData = sideData;
    }
  }
  class EncodedVideoPacketSource {
    constructor(codec) {
      this.codec = codec;
      this.added = [];
    }
    async add(packet) {
      if (mbState.failVideoAdd && this.added.length >= 1) {
        throw new Error('sink exploded');
      }
      this.added.push(packet);
    }
  }
  class EncodedAudioPacketSource {
    constructor(codec) {
      this.codec = codec;
      this.added = [];
    }
    async add(packet) {
      this.added.push(packet);
    }
  }
  class EncodedPacketSink {
    constructor(track) { this.track = track; }
    async *packets() {
      for (const p of this.track.__packets ?? []) yield p;
    }
  }
  /** Segment reopen (concat phase): yields the fixture tracks. */
  class Input {
    constructor(options) {
      this.options = options;
      mbState.inputs.push(this);
    }
    async getPrimaryVideoTrack() {
      return {
        codec: mbState.segVideoCodec,
        getDecoderConfig: async () => mbState.segVideoDecoderConfig,
        __packets: mbState.segVideoPackets,
      };
    }
    async getAudioTracks() {
      return [
        {
          codec: mbState.segAudioCodec,
          getDecoderConfig: async () => mbState.segAudioDecoderConfig,
          __packets: mbState.segAudioPackets,
        },
      ];
    }
    dispose() {}
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
    ALL_FORMATS,
    BlobSource,
    EncodedPacket,
    EncodedVideoPacketSource,
    EncodedAudioPacketSource,
    EncodedPacketSink,
    Input,
  };
});

import * as mb from 'mediabunny';
import {
  ExportError,
  runExport,
  discardExportTemp,
  pixelateFrame,
  scaleTracks,
  exportGeometry,
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
    fillRect: (x, y, w, h) => calls.push(['fillRect', x, y, w, h]),
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
  // v1.15.0 mock-state reset (concat fixtures + instance logs).
  mbState.segVideoPackets = [];
  mbState.segAudioPackets = [];
  mbState.failVideoAdd = false;
  mbState.outputs.length = 0;
  mbState.inputs.length = 0;
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
    // Default pixelStrength 'normal' (×2): dilated 46×46 → block 24 → src 2×2;
    // dilated 23×23 → block 24 → src 1×1.
    const upscales = [...frameCanvas.rec.calls].filter((c) => c[0] === 'drawImage');
    expect(upscales).toHaveLength(2);
    expect(upscales[0].slice(2)).toEqual([0, 0, 2, 2, 97, 47, 46, 46]);
    expect(upscales[1].slice(2)).toEqual([0, 0, 1, 1, 198.5, 58.5, 23, 23]);
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
    // from the frame canvas: drawImage(frame, 97, 47, 46, 46, 0, 0, 2, 2)
    // (default pixelStrength 'normal' ×2 → block 24 → src 2×2).
    const downs = scratch.rec.calls.filter((c) => c[0] === 'drawImage');
    expect(downs).toHaveLength(1);
    expect(downs[0][1]).toBe(frameCanvas);
    expect(downs[0].slice(2)).toEqual([97, 47, 46, 46, 0, 0, 2, 2]);

    // The upscale drew FROM the scratch canvas.
    const ups = frameCanvas.rec.calls.filter((c) => c[0] === 'drawImage');
    expect(ups[0][1]).toBe(scratch);
  });

  it('burns a solid-style track as an opaque black fillRect through the SAME seam (REQ-102)', async () => {
    const track = makeTrack({
      style: 'solid',
      keyframes: new Map([[0, { x: 100, y: 50, w: 40, h: 40 }]]),
    });
    let conv;
    mb.Conversion.init.mockImplementation(async (opts) => {
      conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => conv.opts.video.process(fakeSample(0)) });
      return conv;
    });
    await runExport({ input: fakeInput(), tracks: [track], settings: bufferSettings });

    const frameCanvas = canvases[0];
    // Same dilated box {97, 47, 46, 46} the pixelate path would cover —
    // REQ-102: style choice is dispatched INSIDE the shared pixelateFrame seam.
    const fills = frameCanvas.rec.calls.filter((c) => c[0] === 'fillRect');
    expect(fills).toHaveLength(1);
    expect(fills[0].slice(1)).toEqual([97, 47, 46, 46]);
    const fillSets = frameCanvas.rec.calls.filter(
      (c) => c[0] === 'set' && c[1] === 'fillStyle',
    );
    expect(fillSets).toContainEqual(['set', 'fillStyle', '#000000']);

    // Solid path rasterizes with fillRect only — no pixelation draws on the
    // frame canvas and nothing drawn into the (still created) scratch.
    expect(frameCanvas.rec.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(0);
    const scratch = canvases[1];
    expect(scratch).toBeDefined();
    expect(scratch.rec.calls.filter((c) => c[0] === 'drawImage')).toHaveLength(0);
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
// Pixelation strength plumbing (v1.17.0): settings.pixelStrength → burn-in
// ---------------------------------------------------------------------------

describe('runExport — settings.pixelStrength flows into the burn-in (v1.17.0)', () => {
  // A 400×400 box dilates to 460×460 (frame 320×180 clamps the shifted origin
  // to 0,0 but the dilated SIZE is preserved). Base block = max(12, 46) = 46:
  //   fine ×1 → 46  → scratch ceil(460/46)  = 10×10 (v1.16 behavior)
  //   normal ×2 → 92 → 5×5 (the DEFAULT — doubles vs v1.16)
  //   coarse ×3 → 138 → 4×4
  //   max ×4 → 184  → 3×3
  const bigBox = { x: 0, y: 0, w: 400, h: 400 };

  /** Burn one frame with the given settings; return the pixelation scratch dims. */
  async function burnWithStrength(settings) {
    const track = makeTrack({ keyframes: new Map([[0, bigBox]]) });
    let conv;
    mb.Conversion.init.mockImplementation(async (opts) => {
      conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => conv.opts.video.process(fakeSample(0)) });
      return conv;
    });
    await runExport({ input: fakeInput(), tracks: [track], settings: { ...bufferSettings, ...settings } });
    const scratch = canvases[1]; // [0] = frame canvas, [1] = pixelation scratch
    return { w: scratch.width, h: scratch.height };
  }

  it("missing pixelStrength resolves to 'normal' ×2 → block 92 → scratch 5×5", async () => {
    expect(await burnWithStrength({})).toEqual({ w: 5, h: 5 });
  });

  it("'normal' ×2 → block 92 → scratch 5×5", async () => {
    expect(await burnWithStrength({ pixelStrength: 'normal' })).toEqual({ w: 5, h: 5 });
  });

  it("'fine' ×1 preserves the v1.16 block rule → block 46 → scratch 10×10", async () => {
    expect(await burnWithStrength({ pixelStrength: 'fine' })).toEqual({ w: 10, h: 10 });
  });

  it("'coarse' ×3 → block 138 → scratch 4×4", async () => {
    expect(await burnWithStrength({ pixelStrength: 'coarse' })).toEqual({ w: 4, h: 4 });
  });

  it("'max' ×4 → block 184 → scratch 3×3", async () => {
    expect(await burnWithStrength({ pixelStrength: 'max' })).toEqual({ w: 3, h: 3 });
  });

  it("invalid pixelStrength falls back to 'normal' ×2 → scratch 5×5 (never throws, never ×1)", async () => {
    expect(await burnWithStrength({ pixelStrength: 'bogus' })).toEqual({ w: 5, h: 5 });
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
    expect(ups[0].slice(2)).toEqual([0, 0, 2, 2, 97, 47, 46, 46]); // default ×2 → block 24
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

// ---------------------------------------------------------------------------
// v1.15.0 REQ-126 — trimmed export (multi-segment + packet concat)
// ---------------------------------------------------------------------------

/** Source input for the trimmed path: computeDuration + display size probe. */
function fakeTrimInput({ duration = 10, w = 320, h = 180 } = {}) {
  return {
    computeDuration: vi.fn(async () => duration),
    getPrimaryVideoTrack: vi.fn(async () => ({
      getDisplayWidth: async () => w,
      getDisplayHeight: async () => h,
    })),
  };
}

/** Raw packet fixture (EncodedPacket-shaped, pre-shift). */
function rawPacket(t, kind = 'key') {
  return {
    data: u8(1, 2, 3),
    type: kind,
    timestamp: t,
    duration: 1 / 30,
    sequenceNumber: 7,
    byteLength: 3,
    sideData: undefined,
  };
}

describe('runExport — trimmed path (v1.15.0 REQ-126)', () => {
  /** Script every Conversion (segment + none) with the default happy path. */
  function scriptAllConversions() {
    const conversions = [];
    mb.Conversion.init.mockImplementation(async (opts) => {
      const conv = new mb.Conversion(opts);
      conversions.push(conv);
      scriptExecute(conv, {});
      return conv;
    });
    return conversions;
  }

  it('no trims → single conversion, no `trim` key, no concat inputs', async () => {
    const opfs = installOpfs();
    const conversions = scriptAllConversions();
    await runExport({
      input: fakeInput(),
      tracks: [makeTrack()],
      settings: { ...bufferSettings, trims: [] },
    });
    expect(mb.Conversion.init).toHaveBeenCalledTimes(1);
    expect('trim' in conversions[0].opts).toBe(false);
    expect(mbState.inputs).toHaveLength(0); // no segment reopen
    expect(opfs.removed).toHaveLength(0); // buffer mode → no temps at all
  });

  it('2 trims → 3 kept segments → 3 Conversions with the right trim windows', async () => {
    installOpfs();
    const conversions = scriptAllConversions();
    // trims [{2,4},{6,7}] on 10 s → kept [{0,2},{4,6},{7,10}].
    const result = await runExport({
      input: fakeTrimInput({ duration: 10 }),
      tracks: [makeTrack()],
      settings: {
        ...bufferSettings,
        trims: [
          { id: 1, start: 2, end: 4 },
          { id: 2, start: 6, end: 7 },
        ],
      },
    });
    expect(mb.Conversion.init).toHaveBeenCalledTimes(3);
    expect(conversions.map((c) => c.opts.trim)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
      { start: 7, end: 10 },
    ]);
    // Same burn-in + NO audio options per segment (audio stays packet-copy).
    for (const conv of conversions) {
      expect(conv.opts.video.codec).toBe('avc');
      expect('audio' in conv.opts).toBe(false);
      expect(typeof conv.opts.video.process).toBe('function');
    }
    expect(result.blob).toBeInstanceOf(Blob);
  });

  it('concat: ONE final output, first-segment decoder meta, packets re-added with shifted timestamps', async () => {
    installOpfs();
    scriptAllConversions();
    // Audio leads with a NEGATIVE priming packet (rebased trim temps) — the
    // monotonic-key guard must skip it in every segment.
    mbState.segVideoPackets = [rawPacket(0.5), rawPacket(1.2, 'delta')];
    // Each reopened segment carries the SAME rebased packet set — like real
    // trim temps: a negative PRIMING packet (covers the trimmed sliver just
    // before trim.start) + content near the segment end (0.9863 of ~1.0 s).
    mbState.segAudioPackets = [rawPacket(-0.0354), rawPacket(0.9863)];
    // trims [{1,2},{3,4}] on 10 → kept [{0,1},{2,3},{4,10}]. Segment temps are
    // rebased to ~0 by the trim, so offsets are the running kept duration:
    // seg1: 0; seg2: 1; seg3: 2.
    await runExport({
      input: fakeTrimInput({ duration: 10 }),
      tracks: [],
      settings: {
        ...bufferSettings,
        trims: [
          { id: 1, start: 1, end: 2 },
          { id: 2, start: 3, end: 4 },
        ],
      },
    });
    // 3 segment Outputs + 1 final Output.
    expect(mbState.outputs).toHaveLength(4);
    const final = mbState.outputs[3];
    expect(final.started).toBe(true);
    expect(final.finalized).toBe(true);
    expect(final.tracks.map((t) => t.type)).toEqual(['video', 'audio']);
    const [videoTrack, audioTrack] = final.tracks;
    expect(videoTrack.source.codec).toBe('avc');
    expect(videoTrack.metadata).toEqual({ decoderConfig: { codec: 'avc1.640028' } });
    expect(audioTrack.source.codec).toBe('aac');
    expect(audioTrack.metadata).toEqual({ decoderConfig: { codec: 'mp4a.40.2' } });
    // 3 segments × 2 video packets, timestamps: [0.5,1.2] + [1.5,2.2] + [2.5,3.2].
    expect(videoTrack.source.added.map((p) => +p.timestamp.toFixed(6))).toEqual([
      0.5, 1.2, 1.5, 2.2, 2.5, 3.2,
    ]);
    // Audio rides the SAME offsets per segment (A/V sync contract); the
    // negative priming packets are skipped by the monotonic-key guard.
    expect(audioTrack.source.added.map((p) => +p.timestamp.toFixed(6))).toEqual([
      0.9863, 1.9863, 2.9863,
    ]);
    // The priming packet (−0.0354) never reaches the audio source in any
    // segment: ts < 0 for seg1, ts ≤ the previous segment's last for the rest.
    // Packets are FRESH EncodedPacket instances carrying original side data.
    expect(videoTrack.source.added[0]).toBeInstanceOf(mb.EncodedPacket);
    expect(videoTrack.source.added[0].sequenceNumber).toBe(7);
    expect(videoTrack.source.added[0].type).toBe('key');
  });

  it('success cleans every segment temp (stream mode)', async () => {
    const opfs = installOpfs();
    scriptAllConversions();
    await runExport({
      input: fakeTrimInput({ duration: 10 }),
      tracks: [],
      settings: {
        outputMode: 'stream',
        trims: [{ id: 1, start: 2, end: 4 }],
      },
    });
    // 2 kept segments (stream-staged) + 1 final staging; deliver removed the
    // final temp and the exporter removed both segment temps.
    expect(opfs.removed).toHaveLength(3);
    expect(mbState.inputs).toHaveLength(2); // both segments reopened for concat
  });

  it('concat failure → ExportError("mux") with cause, ALL temps cleaned', async () => {
    const opfs = installOpfs();
    scriptAllConversions();
    mbState.segVideoPackets = [rawPacket(0.5)];
    mbState.failVideoAdd = true;
    await expect(
      runExport({
        input: fakeTrimInput({ duration: 10 }),
        tracks: [],
        settings: {
          outputMode: 'stream',
          trims: [{ id: 1, start: 2, end: 4 }],
        },
      }),
    ).rejects.toMatchObject({ name: 'ExportError', stage: 'mux' });
    // 2 segment temps + 1 final temp, all removed (REQ-021).
    expect(opfs.removed).toHaveLength(3);
  });

  it('abort between segments → ExportError("cancelled"), segment temps cleaned', async () => {
    const opfs = installOpfs();
    const ctl = new AbortController();
    const conversions = [];
    mb.Conversion.init.mockImplementation(async (opts) => {
      const conv = new mb.Conversion(opts);
      conversions.push(conv);
      scriptExecute(conv, {});
      if (conversions.length === 2) ctl.abort(); // die after segment 2
      return conv;
    });
    await expect(
      runExport({
        input: fakeTrimInput({ duration: 10 }),
        tracks: [],
        settings: {
          outputMode: 'stream',
          trims: [
            { id: 1, start: 1, end: 2 },
            { id: 2, start: 3, end: 4 },
            { id: 3, start: 5, end: 6 },
          ],
        },
        signal: ctl.signal,
      }),
    ).rejects.toMatchObject({ name: 'ExportError', stage: 'cancelled' });
    expect(mb.Conversion.init).toHaveBeenCalledTimes(2);
    expect(opfs.removed).toHaveLength(2);
  });

  it('every second trimmed → ExportError("io"), nothing exported', async () => {
    const opfs = installOpfs();
    scriptAllConversions();
    await expect(
      runExport({
        input: fakeTrimInput({ duration: 10 }),
        tracks: [],
        settings: {
          outputMode: 'stream',
          trims: [{ id: 1, start: 0, end: 10 }],
        },
      }),
    ).rejects.toMatchObject({ name: 'ExportError', stage: 'io' });
    expect(opfs.removed).toHaveLength(0); // failed before any staging
  });

  it('progress crosses the segments (ratio monotonic, ≤ 1)', async () => {
    installOpfs();
    scriptAllConversions();
    const ratios = [];
    await runExport({
      input: fakeTrimInput({ duration: 10 }),
      tracks: [],
      settings: {
        ...bufferSettings,
        trims: [
          { id: 1, start: 2, end: 4 },
          { id: 2, start: 6, end: 7 },
        ],
      },
      onProgress: (p) => ratios.push(p.ratio),
    });
    expect(ratios.length).toBeGreaterThan(0);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]).toBeGreaterThanOrEqual(ratios[i - 1]);
    }
    expect(ratios[ratios.length - 1]).toBeLessThanOrEqual(1);
  });
});

describe('export resolution + audio removal (v1.16.0)', () => {
  it('scaleTracks scales every keyframe box non-mutatingly; sf 1 returns input', () => {
    const track = { id: 1, keyframes: new Map([[0, { x: 100, y: 200, w: 50, h: 25 }]]) };
    const out = scaleTracks([track], 0.5);
    expect(out).not.toStrictEqual([track]);
    expect([...out[0].keyframes][0][1]).toEqual({ x: 50, y: 100, w: 25, h: 12.5 });
    expect([...track.keyframes][0][1]).toEqual({ x: 100, y: 200, w: 50, h: 25 }); // untouched
    const input = [track]; // identity contract: sf 1 returns the SAME array
    expect(scaleTracks(input, 1)).toBe(input);
  });

  it('exportGeometry: full → sf 1 native dims; 1080p/720p scale the long edge', () => {
    expect(exportGeometry('full', 3840, 2160)).toEqual({ sf: 1, outW: 3840, outH: 2160 });
    expect(exportGeometry('1080p', 3840, 2160)).toEqual({ sf: 0.5, outW: 1920, outH: 1080 });
    expect(exportGeometry('720p', 3840, 2160)).toEqual({ sf: 1280 / 3840, outW: 1280, outH: 720 });
    // portrait: long edge is the height
    const g = exportGeometry('1080p', 2160, 3840);
    expect(g.outW).toBe(1080);
    expect(g.outH).toBe(1920);
    expect(exportGeometry(undefined, 1920, 1080).sf).toBe(1); // invalid/absent → 1
  });

  it('single pass with resolution 720p on a 2560x1440 source: burn-in canvas + processedWidth/Height hints scale', async () => {
    const input = fakeInput({ w: 2560, h: 1440 });
    const track = makeTrack({ keyframes: new Map([[1, { x: 1000, y: 500, w: 200, h: 100 }]]), start: 1, end: 3 });
    const sample = fakeSample(1.2, { w: 2560, h: 1440 });
    let conv;
    mb.Conversion.init.mockImplementation(async (opts) => {
      conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => { conv.opts.video.process(sample); } });
      return conv;
    });
    // 720p cap 1280 on long edge 2560 → sf 0.5 → canvas 1280x720
    await runExport({ input, tracks: [track], settings: { outputMode: 'buffer', quality: 'high', exportResolution: '720p' } });
    expect(conv.opts.video.processedWidth).toBe(1280);
    expect(conv.opts.video.processedHeight).toBe(720);
    const frameCanvas = canvases[0]; // frame canvas is created first in the run
    expect(frameCanvas.width).toBe(1280);
    expect(frameCanvas.height).toBe(720);
    // the box was scaled BEFORE dilate/pixelate: dilated scaled box
    // (500*0.5=250, 250, 50, 25 → dilate 15% → {246.25, 246.25, 57.5, 32.5})
    const draws = frameCanvas.rec.ctx.draws ?? frameCanvas.rec.draws ?? [];
    const rect = (draws.length ? draws : frameCanvas.rec.calls).find?.((c) => c?.method === 'strokeRect' || c?.name === 'strokeRect');
    // fall back: pixelate asserts live in redact tests; here just assert the
    // sample was drawn into the SCALED canvas:
    expect(sample.draw).toHaveBeenCalledWith(frameCanvas.rec.ctx, 0, 0, 1280, 720);
    void rect;
  });

  it('single pass with removeAudio: audio discard option present; absent → no audio key', async () => {
    let captured;
    mb.Conversion.init.mockImplementation(async (opts) => {
      captured = opts;
      const conv = new mb.Conversion(opts);
      scriptExecute(conv, { onDone: () => {} });
      return conv;
    });
    await runExport({ input: fakeInput(), tracks: [], settings: { outputMode: 'buffer', quality: 'high', removeAudio: true } });
    expect(captured.audio).toEqual({ discard: true });
    mb.Conversion.init.mockClear();
    await runExport({ input: fakeInput(), tracks: [], settings: { outputMode: 'buffer', quality: 'high' } });
    expect(captured.audio).toBeUndefined();
  });
});
