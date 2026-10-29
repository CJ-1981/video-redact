/**
 * Unit tests for src/ingest.js — REQ-001 (M1 task 3, plan.md §E).
 *
 * mediabunny and @mediabunny/prores are fully mocked: the tests pin the exact
 * API surface ingest.js relies on (Input/BlobSource/ALL_FORMATS plus the
 * async track metadata methods documented in mediabunny 1.63.0), so the mock
 * doubles as an executable record of the contract (ADR-2).
 *
 * Covers: happy-path metadata extraction, 90° rotation → display dims swapped
 * (AC-15 prep), audio-less files, the typed IngestError taxonomy
 * ('unsupported-container' | 'no-video-track' | 'undecodable-track' |
 * 'prores-without-extension' | 'corrupt'), ProRes detection + extension
 * registration (always, before Input creation, idempotently), and the pure
 * helpers metaFromTracks/containerTag.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerProresDecoder } = vi.hoisted(() => ({
  registerProresDecoder: vi.fn(),
}));

vi.mock('mediabunny', () => ({
  Input: vi.fn(),
  BlobSource: vi.fn(),
  ALL_FORMATS: ['__mocked_all_formats__'],
}));

vi.mock(
  'https://cdn.jsdelivr.net/npm/@mediabunny/prores@1.63.0/dist/bundles/mediabunny-prores.mjs',
  () => ({ registerProresDecoder }),
);

/** Fresh ingest.js module per test (its registration flag is module-scoped). */
async function loadIngest() {
  vi.resetModules();
  const ingest = await import('../../src/ingest.js');
  const mb = await import('mediabunny');
  return { ingest, mb };
}

/**
 * Constructor-safe Input mock install: vitest requires `function`
 * implementations when the mock is invoked with `new`.
 */
function useInput(mb, fake) {
  mb.Input.mockImplementation(function () {
    return fake;
  });
}

/** A mediabunny-like fake video track (async metadata methods, sync codecs). */
function fakeVideoTrack(overrides = {}) {
  return {
    codec: 'avc',
    codedWidth: 1920,
    codedHeight: 1080,
    getRotation: vi.fn(async () => 0),
    getDisplayWidth: vi.fn(async () => 1920),
    getDisplayHeight: vi.fn(async () => 1080),
    canDecode: vi.fn(async () => true),
    computePacketStats: vi.fn(async () => ({
      packetCount: 64,
      averagePacketRate: 29.97,
      averageBitrate: 5_000_000,
    })),
    ...overrides,
  };
}

/** A mediabunny-like fake audio track: only `codec` is consumed. */
function fakeAudioTrack(codec = 'aac') {
  return { codec };
}

/** A mediabunny-like fake Input with the members openInput() touches. */
function fakeInput({
  format = { name: 'MP4' },
  formatError = null,
  video = fakeVideoTrack(),
  audio = fakeAudioTrack(),
  duration = 12.5,
  trackError = null,
} = {}) {
  return {
    getFormat: vi.fn(async () => {
      if (formatError) throw formatError;
      return format;
    }),
    getPrimaryVideoTrack: vi.fn(async () => {
      if (trackError) throw trackError;
      return video;
    }),
    getPrimaryAudioTrack: vi.fn(async () => audio),
    computeDuration: vi.fn(async () => duration),
  };
}

function unsupportedContainerError() {
  // Mirrors mediabunny's UnsupportedInputFormatError (matched by error.name,
  // so the taxonomy does not depend on importing the real class).
  const err = new Error('Input has an unsupported or unrecognizable format.');
  err.name = 'UnsupportedInputFormatError';
  return err;
}

beforeEach(() => {
  registerProresDecoder.mockReset();
  registerProresDecoder.mockImplementation(() => {});
});

describe('ingest.openInput — happy path metadata (REQ-001)', () => {
  it('opens the file via Input(BlobSource, ALL_FORMATS) and extracts full metadata', async () => {
    const { ingest, mb } = await loadIngest();
    const file = new Blob(['fake mp4 bytes']);
    const fake = fakeInput();
    useInput(mb, fake);
    mb.BlobSource.mockImplementation(function () {
      return { __blobSource: 'sentinel' };
    });

    const { input, meta } = await ingest.openInput(file);

    expect(mb.BlobSource).toHaveBeenCalledTimes(1);
    expect(mb.BlobSource).toHaveBeenCalledWith(file);
    expect(mb.Input).toHaveBeenCalledTimes(1);
    expect(mb.Input).toHaveBeenCalledWith({
      source: { __blobSource: 'sentinel' },
      formats: ['__mocked_all_formats__'],
    });
    expect(input).toBe(fake);

    expect(meta).toEqual({
      container: 'mp4',
      codec: 'avc',
      codedWidth: 1920,
      codedHeight: 1080,
      displayWidth: 1920,
      displayHeight: 1080,
      rotation: 0,
      fps: 29.97,
      duration: 12.5,
      audio: { codec: 'aac' },
    });
  });

  it('derives fps from a bounded computePacketStats sample (never an unbounded scan)', async () => {
    const { ingest, mb } = await loadIngest();
    const video = fakeVideoTrack();
    useInput(mb, fakeInput({ video }));

    const { meta } = await ingest.openInput(new Blob(['x']));

    expect(video.computePacketStats).toHaveBeenCalledTimes(1);
    const sampleArg = video.computePacketStats.mock.calls[0][0];
    expect(typeof sampleArg).toBe('number');
    expect(sampleArg).toBeLessThanOrEqual(128); // multi-GB safe: bounded scan
    expect(meta.fps).toBe(29.97);
  });

  it('registers the ProRes decoder before constructing the Input (always-register policy)', async () => {
    const { ingest, mb } = await loadIngest();
    const order = [];
    registerProresDecoder.mockImplementation(() => void order.push('prores'));
    mb.Input.mockImplementation(function () {
      order.push('input');
      return fakeInput();
    });

    await ingest.openInput(new Blob(['x']));

    expect(registerProresDecoder).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['prores', 'input']);
  });

  it('accepts a QuickTime .mov HEVC portrait file (90° rotation swaps display dims, AC-15 prep)', async () => {
    const { ingest, mb } = await loadIngest();
    // Real mediabunny applies rotation inside getDisplayWidth/Height; the fake
    // mirrors that behavior for a 3840x2160 coded frame rotated 90°.
    const video = fakeVideoTrack({
      codec: 'hevc',
      codedWidth: 3840,
      codedHeight: 2160,
      getRotation: vi.fn(async () => 90),
      getDisplayWidth: vi.fn(async () => 2160),
      getDisplayHeight: vi.fn(async () => 3840),
    });
    useInput(
      mb,
      fakeInput({ format: { name: 'QuickTime File Format' }, video }),
    );

    const { meta } = await ingest.openInput(new Blob(['x']));

    expect(meta.container).toBe('mov');
    expect(meta.codec).toBe('hevc');
    expect(meta.rotation).toBe(90);
    expect(meta.codedWidth).toBe(3840);
    expect(meta.codedHeight).toBe(2160);
    expect(meta.displayWidth).toBe(2160); // swapped vs coded
    expect(meta.displayHeight).toBe(3840);
  });

  it('reports audio: null for a silent (audio-less) file', async () => {
    const { ingest, mb } = await loadIngest();
    useInput(mb, fakeInput({ audio: null }));

    const { meta } = await ingest.openInput(new Blob(['x']));

    expect(meta.audio).toBeNull();
  });
});

describe('ingest.openInput — ProRes path (REQ-001 iPhone ProRes .mov)', () => {
  it('detects a prores codec and decodes via the registered extension', async () => {
    const { ingest, mb } = await loadIngest();
    const video = fakeVideoTrack({ codec: 'prores' });
    useInput(
      mb,
      fakeInput({ format: { name: 'QuickTime File Format' }, video }),
    );

    const { meta } = await ingest.openInput(new Blob(['x']));

    expect(registerProresDecoder).toHaveBeenCalledTimes(1);
    expect(meta.codec).toBe('prores');
  });

  it('throws prores-without-extension when the extension fails to load', async () => {
    const { ingest, mb } = await loadIngest();
    registerProresDecoder.mockImplementation(() => {
      throw new Error('CDN unreachable');
    });
    useInput(mb, fakeInput({ video: fakeVideoTrack({ codec: 'prores' }) }));

    await expect(ingest.openInput(new Blob(['x']))).rejects.toMatchObject({
      name: 'IngestError',
      code: 'prores-without-extension',
    });
  });

  it('is idempotent: repeated openInput calls register the decoder once', async () => {
    const { ingest, mb } = await loadIngest();
    useInput(mb, fakeInput());
    const file = new Blob(['x']);

    await ingest.openInput(file);
    await ingest.openInput(file);

    expect(registerProresDecoder).toHaveBeenCalledTimes(1);
  });
});

describe('ingest.openInput — error taxonomy (typed IngestError)', () => {
  it('maps an unrecognized container to unsupported-container', async () => {
    const { ingest, mb } = await loadIngest();
    useInput(mb, fakeInput({ formatError: unsupportedContainerError() }));

    const err = await ingest.openInput(new Blob(['x'])).catch(e => e);
    expect(err).toBeInstanceOf(ingest.IngestError);
    expect(err.code).toBe('unsupported-container');
    expect(err.message).toMatch(/not supported/i);
  });

  it('maps a mid-parse failure on a known container to corrupt', async () => {
    const { ingest, mb } = await loadIngest();
    useInput(
      mb,
      fakeInput({ formatError: new Error('unexpected end of box at offset 512') }),
    );

    const err = await ingest.openInput(new Blob(['x'])).catch(e => e);
    expect(err).toBeInstanceOf(ingest.IngestError);
    expect(err.code).toBe('corrupt');
  });

  it('maps track-read failures to corrupt', async () => {
    const { ingest, mb } = await loadIngest();
    useInput(mb, fakeInput({ trackError: new Error('truncated stbl atom') }));

    await expect(ingest.openInput(new Blob(['x']))).rejects.toMatchObject({
      name: 'IngestError',
      code: 'corrupt',
    });
  });

  it('throws no-video-track when the file has no video track', async () => {
    const { ingest, mb } = await loadIngest();
    useInput(mb, fakeInput({ video: null }));

    await expect(ingest.openInput(new Blob(['x']))).rejects.toMatchObject({
      name: 'IngestError',
      code: 'no-video-track',
    });
  });

  it('throws undecodable-track when track.canDecode() is false (REQ-003 hook)', async () => {
    const { ingest, mb } = await loadIngest();
    const video = fakeVideoTrack({ codec: 'hevc', canDecode: async () => false });
    useInput(mb, fakeInput({ video }));

    const err = await ingest.openInput(new Blob(['x'])).catch(e => e);
    expect(err).toBeInstanceOf(ingest.IngestError);
    expect(err.code).toBe('undecodable-track');
    expect(err.message).toMatch(/hevc/i);
  });

  it('checks ProRes registration before canDecode so guidance stays precise', async () => {
    const { ingest, mb } = await loadIngest();
    registerProresDecoder.mockImplementation(() => {
      throw new Error('offline');
    });
    const video = fakeVideoTrack({ codec: 'prores', canDecode: async () => false });
    useInput(mb, fakeInput({ video }));

    await expect(ingest.openInput(new Blob(['x']))).rejects.toMatchObject({
      code: 'prores-without-extension',
    });
  });
});

describe('metaFromTracks — pure metadata assembly', () => {
  it('assembles MediaMeta from track APIs without an Input', async () => {
    const { ingest } = await loadIngest();
    const video = fakeVideoTrack({
      codec: 'vp9',
      codedWidth: 1280,
      codedHeight: 720,
      getRotation: vi.fn(async () => 90),
      getDisplayWidth: vi.fn(async () => 720),
      getDisplayHeight: vi.fn(async () => 1280),
    });
    const audio = fakeAudioTrack('opus');

    const meta = await ingest.metaFromTracks(video, audio, 42.5, 'webm');

    expect(meta).toEqual({
      container: 'webm',
      codec: 'vp9',
      codedWidth: 1280,
      codedHeight: 720,
      displayWidth: 720,
      displayHeight: 1280,
      rotation: 90,
      fps: 29.97,
      duration: 42.5,
      audio: { codec: 'opus' },
    });
    // Display dims must come from the rotation-applied track APIs, not the
    // coded dimensions (ADR-9: display-oriented coordinates post-ingest).
    expect(video.getDisplayWidth).toHaveBeenCalledTimes(1);
    expect(video.getDisplayHeight).toHaveBeenCalledTimes(1);
    expect(video.getRotation).toHaveBeenCalledTimes(1);
  });

  it('passes audio through as null for silent sources', async () => {
    const { ingest } = await loadIngest();
    const meta = await ingest.metaFromTracks(fakeVideoTrack(), null, 3, 'mp4');
    expect(meta.audio).toBeNull();
  });
});

describe('containerTag — format name to short container tag', () => {
  it.each([
    ['MP4', 'mp4'],
    ['QuickTime File Format', 'mov'],
    ['WebM', 'webm'],
    ['Matroska', 'mkv'],
    ['Ogg', 'ogg'],
    ['MPEG Transport Stream', 'mpeg-transport-stream'],
    [null, 'unknown'],
  ])('maps %j → %j', async (formatName, expected) => {
    // containerTag is sync and pure — module registration state is irrelevant.
    const { ingest } = await loadIngest();
    expect(ingest.containerTag(formatName)).toBe(expected);
  });
});
