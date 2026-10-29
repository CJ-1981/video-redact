/**
 * Unit tests for src/capability.js (SPEC-VID-001 REQ-002/003/004).
 *
 * The real mediabunny package is never imported here: probeCapabilities()
 * duck-types the injected `Input` (getPrimaryVideoTrack / getAudioTracks /
 * canDecode / computePacketStats) and reaches WebCodecs through the
 * globalThis.VideoEncoder seam, so plain objects + vi.stubGlobal stand in
 * for the browser stack. The engine sniff is driven through the
 * `opts.userAgent` param seam (falling back to navigator.userAgent).
 *
 * Coverage targets: AC-01 (serve gate), AC-02 (capability report + avc
 * level ladder), AC-11 (HEVC guidance exactness), ADR-5 engine/EP policy,
 * design.md §4.8 4K level probe (4K → 5.1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  secureContextInfo,
  probeCapabilities,
  guidance,
  sniffEngine,
} from '../../src/capability.js';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const EDGE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68';

/** @returns mediabunny-duck-typed primary video track mock. */
function makeVideoTrack(overrides = {}) {
  return {
    codec: 'avc',
    displayWidth: 1920,
    displayHeight: 1080,
    canDecode: vi.fn(() => true),
    computePacketStats: vi.fn(async () => ({ averagePacketRate: 30 })),
    ...overrides,
  };
}

/** @returns mediabunny-duck-typed audio track mock. */
function makeAudioTrack(overrides = {}) {
  return { codec: 'aac', canDecode: vi.fn(() => true), ...overrides };
}

/** @returns mediabunny-duck-typed Input mock. */
function makeInput({ video = makeVideoTrack(), audio = [makeAudioTrack()] } = {}) {
  return {
    getPrimaryVideoTrack: vi.fn(async () => video),
    getAudioTracks: vi.fn(async () => audio),
  };
}

/**
 * A stand-in for the WebCodecs VideoEncoder constructor: only the static
 * isConfigSupported() surface is needed for encode probing.
 */
function fakeEncoderClass(supportsFn) {
  return class FakeVideoEncoder {
    static calls = [];
    static async isConfigSupported(config) {
      this.calls.push(config);
      return { supported: supportsFn(config), config };
    }
  };
}

/** Accepts vp9 always; accepts avc only at level 5.1+ (like real 4K hardware). */
const supportsAvcAt51Plus = (config) =>
  config.codec.startsWith('vp09') ||
  config.codec === 'avc1.640033' ||
  config.codec === 'avc1.640034';

beforeEach(() => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('location', { protocol: 'https:' });
  vi.stubGlobal('navigator', { userAgent: CHROME_UA });
  vi.stubGlobal('VideoEncoder', fakeEncoderClass(() => true));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('secureContextInfo (REQ-004 / AC-01)', () => {
  it('reports a secure context with empty instructions on https/localhost', () => {
    const info = secureContextInfo();
    expect(info.secure).toBe(true);
    expect(info.protocol).toBe('https:');
    expect(info.instructions).toEqual([]);
  });

  it('returns copy-paste serve commands when opened from file://', () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('location', { protocol: 'file:' });

    const info = secureContextInfo();
    expect(info.secure).toBe(false);
    expect(info.protocol).toBe('file:');
    expect(info.instructions).toEqual(['python3 -m http.server 8000', 'npx serve']);
  });
});

describe('sniffEngine (ADR-5 engine sniff)', () => {
  it('classifies a Safari (WebKit, non-Chrome) UA as webkit', () => {
    expect(sniffEngine(SAFARI_UA)).toBe('webkit');
  });

  it('classifies a Chrome UA (AppleWebKit + Chrome) as chromium', () => {
    expect(sniffEngine(CHROME_UA)).toBe('chromium');
  });

  it('classifies an Edge UA as chromium', () => {
    expect(sniffEngine(EDGE_UA)).toBe('chromium');
  });

  it('falls back to chromium for an empty/unknown UA', () => {
    expect(sniffEngine('')).toBe('chromium');
  });
});

describe('probeCapabilities (REQ-002 / AC-02)', () => {
  it('returns the full happy-path report: decode ok, audio ok, both encode probes, chromium/webgpu', async () => {
    const report = await probeCapabilities(makeInput());

    expect(report.secureContext).toBe(true);
    expect(report.engine).toBe('chromium');
    expect(report.epPolicy).toBe('webgpu');
    expect(report.canAnalyze).toBe(true);
    expect(report.canExport).toBe(true);

    const kinds = report.probes.map((p) => p.kind);
    expect(kinds).toContain('video-decode');
    expect(kinds).toContain('audio-decode');
    expect(kinds).toContain('video-encode-avc');
    expect(kinds).toContain('video-encode-vp9');

    for (const probe of report.probes) {
      expect(probe).toHaveProperty('ok');
      expect(probe).toHaveProperty('detail');
      expect(typeof probe.detail).toBe('string');
    }
    expect(report.warnings).toEqual([]);
  });

  it('video-decode detail carries codec, display resolution and fps', async () => {
    const report = await probeCapabilities(makeInput());
    const vd = report.probes.find((p) => p.kind === 'video-decode');
    expect(vd.ok).toBe(true);
    expect(vd.codec).toBe('avc');
    expect(vd.detail).toContain('avc');
    expect(vd.detail).toContain('1920x1080');
    expect(vd.detail).toContain('30fps');
  });

  it('AC-02: walks the avc level ladder in order and reports the first supported level', async () => {
    const Fake = fakeEncoderClass(supportsAvcAt51Plus);
    vi.stubGlobal('VideoEncoder', Fake);

    const report = await probeCapabilities(makeInput());
    const avc = report.probes.find((p) => p.kind === 'video-encode-avc');

    expect(avc.ok).toBe(true);
    expect(avc.detail).toContain('5.1');

    const avcAttempts = Fake.calls.map((c) => c.codec).filter((c) => c.startsWith('avc1'));
    expect(avcAttempts).toEqual(['avc1.64002A', 'avc1.640032', 'avc1.640033']);

    // vp9 fallback probe is issued alongside the ladder.
    expect(Fake.calls.some((c) => c.codec.startsWith('vp09'))).toBe(true);
    expect(report.probes.find((p) => p.kind === 'video-encode-vp9').ok).toBe(true);
  });

  it('reports both encode probes as failed when the encoder supports nothing', async () => {
    vi.stubGlobal('VideoEncoder', fakeEncoderClass(() => false));

    const report = await probeCapabilities(makeInput());
    expect(report.canExport).toBe(false);
    expect(report.probes.find((p) => p.kind === 'video-encode-avc').ok).toBe(false);
    expect(report.probes.find((p) => p.kind === 'video-encode-vp9').ok).toBe(false);
    expect(
      report.probes.find((p) => p.kind === 'video-encode-avc').detail,
    ).toContain('unsupported');
  });

  it('degrades honestly when WebCodecs VideoEncoder is unavailable', async () => {
    vi.stubGlobal('VideoEncoder', undefined);

    const report = await probeCapabilities(makeInput());
    expect(report.canExport).toBe(false);
    const avc = report.probes.find((p) => p.kind === 'video-encode-avc');
    expect(avc.ok).toBe(false);
    expect(avc.detail).toMatch(/unavailable/i);
  });

  it('4K source probes up to level 5.1 (design §4.8) and reports the resolution', async () => {
    const Fake = fakeEncoderClass(supportsAvcAt51Plus);
    vi.stubGlobal('VideoEncoder', Fake);

    const report = await probeCapabilities(
      makeInput({ video: makeVideoTrack({ displayWidth: 3840, displayHeight: 2160 }) }),
    );
    const avc = report.probes.find((p) => p.kind === 'video-encode-avc');
    expect(avc.ok).toBe(true);
    expect(avc.detail).toContain('5.1');
    expect(avc.detail).toContain('3840x2160');
  });

  it('skips the audio-decode probe when the input has no audio track', async () => {
    const report = await probeCapabilities(makeInput({ audio: [] }));
    expect(report.probes.some((p) => p.kind === 'audio-decode')).toBe(false);
    expect(report.canAnalyze).toBe(true);
  });

  it('reports an undecodable audio track without blocking analyze', async () => {
    const report = await probeCapabilities(
      makeInput({ audio: [makeAudioTrack({ canDecode: () => false })] }),
    );
    const ad = report.probes.find((p) => p.kind === 'audio-decode');
    expect(ad.ok).toBe(false);
    expect(ad.codec).toBe('aac');
    expect(report.canAnalyze).toBe(true);
  });

  it('AC-11 setup: an undecodable HEVC track yields video-decode ok:false and canAnalyze:false', async () => {
    const report = await probeCapabilities(
      makeInput({ video: makeVideoTrack({ codec: 'hevc', canDecode: () => false }) }),
    );
    const vd = report.probes.find((p) => p.kind === 'video-decode');
    expect(vd.ok).toBe(false);
    expect(vd.codec).toBe('hevc');
    expect(report.canAnalyze).toBe(false);
  });

  it('carries secureContext:false into the report on file://', async () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('location', { protocol: 'file:' });

    const report = await probeCapabilities(makeInput());
    expect(report.secureContext).toBe(false);
  });

  it('uses the opts.userAgent seam: Safari UA gets webkit engine + wasm EP policy', async () => {
    const report = await probeCapabilities(makeInput(), { userAgent: SAFARI_UA });
    expect(report.engine).toBe('webkit');
    expect(report.epPolicy).toBe('wasm');
  });

  it('contains canDecode() rejections as a failed probe instead of throwing', async () => {
    const report = await probeCapabilities(
      makeInput({ video: makeVideoTrack({ canDecode: () => { throw new Error('codec unavailable'); } }) }),
    );
    const vd = report.probes.find((p) => p.kind === 'video-decode');
    expect(vd.ok).toBe(false);
    expect(report.canAnalyze).toBe(false);
  });

  it('handles an input with no video track: no decode/encode probes, nothing viable', async () => {
    const report = await probeCapabilities(makeInput({ video: null, audio: [] }));
    expect(report.probes).toEqual([]);
    expect(report.canAnalyze).toBe(false);
    expect(report.canExport).toBe(false);
  });
});

describe('guidance (REQ-003 / AC-11)', () => {
  it('AC-11: HEVC decode failure produces the exact actionable guidance', async () => {
    const report = await probeCapabilities(
      makeInput({ video: makeVideoTrack({ codec: 'hevc', canDecode: () => false }) }),
    );
    const g = guidance(report);

    expect(g.canAnalyze).toBe(false);
    expect(g.canExport).toBe(true);

    const browserAdvice = g.messages.find((m) => m.includes('hardware HEVC'));
    expect(browserAdvice).toBeTruthy();
    expect(browserAdvice).toContain('Chrome');

    const reRecordAdvice = g.messages.find((m) => m.includes('Most Compatible'));
    expect(reRecordAdvice).toBeTruthy();
    expect(reRecordAdvice).toContain('Settings → Camera → Formats');
  });

  it('treats the hvc1 container tag the same as hevc', async () => {
    const report = await probeCapabilities(
      makeInput({ video: makeVideoTrack({ codec: 'hvc1', canDecode: () => false }) }),
    );
    const g = guidance(report);
    expect(g.canAnalyze).toBe(false);
    expect(g.messages.some((m) => m.includes('Most Compatible'))).toBe(true);
  });

  it('uses a generic blocked message for a non-HEVC undecodable codec', async () => {
    const report = await probeCapabilities(
      makeInput({ video: makeVideoTrack({ codec: 'vp9', canDecode: () => false }) }),
    );
    const g = guidance(report);
    expect(g.canAnalyze).toBe(false);
    expect(g.messages.some((m) => m.includes('blocked'))).toBe(true);
    expect(g.messages.some((m) => m.includes('Most Compatible'))).toBe(false);
  });

  it('includes serve-over-localhost instructions when the context is insecure', async () => {
    vi.stubGlobal('isSecureContext', false);
    vi.stubGlobal('location', { protocol: 'file:' });

    const report = await probeCapabilities(makeInput());
    const g = guidance(report);
    const serveMsg = g.messages.find((m) => m.includes('secure context'));
    expect(serveMsg).toBeTruthy();
    expect(serveMsg).toContain('python3 -m http.server 8000');
    expect(serveMsg).toContain('npx serve');
  });

  it('notes the WebM/VP9 fallback when only vp9 encoding is viable', async () => {
    vi.stubGlobal('VideoEncoder', fakeEncoderClass((config) => config.codec.startsWith('vp09')));

    const report = await probeCapabilities(makeInput());
    expect(report.canExport).toBe(true);
    const g = guidance(report);
    expect(g.canExport).toBe(true);
    const fallbackMsg = g.messages.find((m) => m.includes('VP9'));
    expect(fallbackMsg).toBeTruthy();
    expect(fallbackMsg).toContain('WebM');
  });

  it('notes large streamed output for a 4K source with avc encode available', async () => {
    const report = await probeCapabilities(
      makeInput({ video: makeVideoTrack({ displayWidth: 3840, displayHeight: 2160 }) }),
    );
    const g = guidance(report);
    const fourKMsg = g.messages.find((m) => m.includes('4K'));
    expect(fourKMsg).toBeTruthy();
  });

  it('stays quiet (no advisories) for a fully capable 1080p source', async () => {
    const report = await probeCapabilities(makeInput());
    const g = guidance(report);
    expect(g.canAnalyze).toBe(true);
    expect(g.canExport).toBe(true);
    expect(g.messages).toEqual([]);
  });

  it('warns when decode works but no encode target exists', async () => {
    vi.stubGlobal('VideoEncoder', fakeEncoderClass(() => false));

    const report = await probeCapabilities(makeInput());
    const g = guidance(report);
    expect(g.canExport).toBe(false);
    expect(g.messages.some((m) => m.includes('export is unavailable'))).toBe(true);
  });

  it('reports canAnalyze:false when the report has no video-decode probe at all', () => {
    const g = guidance({
      secureContext: true,
      engine: 'chromium',
      epPolicy: 'webgpu',
      probes: [{ kind: 'video-encode-avc', ok: true, codec: 'avc', width: 1920, height: 1080, detail: 'x' }],
      canAnalyze: false,
      canExport: true,
      warnings: [],
    });
    expect(g.canAnalyze).toBe(false);
    expect(g.canExport).toBe(true);
  });
});
