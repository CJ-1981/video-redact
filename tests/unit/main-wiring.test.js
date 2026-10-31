/**
 * Unit tests for the pure parts of the app shell (src/main.js, T-602).
 *
 * main.js is split so everything testable in node is exported:
 *   - deriveStep / stepperModel  — the stepper state machine
 *   - formatBytes / formatEta / formatClock — display formatters
 *   - mapExportErrorToMessage    — REQ-021 export stage → recovery message
 *   - describeIngestFailure      — REQ-001/021 ingest failure → message
 *   - renderProbeRows / metaSummaryRows — capability-report view models
 *   - parseDebugFlag / formatDiagLine / DIAG_KEY_ORDER — ?debug=1 runtime
 *     diagnostics (v1.8.2 support)
 * mountApp() itself is the thin DOM wiring and stays untested (no DOM here).
 *
 * Importing src/main.js in node must stay side-effect free (the auto-mount
 * is guarded by `typeof document`) — that property is asserted too, because
 * tests/unit/scaffold.test.js imports the same module in the node env.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import * as main from '../../src/main.js';
import { PIXEL_STRENGTHS } from '../../src/redact.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// v1.9.0 node harness mocks (file-wide): the mountApp integration tests below
// drive the REAL wiring through a fake document; ingest/analyze are the two
// modules that can only work against real media bytes, so they resolve
// instantly here. Nothing else in this file touches them.
// ---------------------------------------------------------------------------

const { FAKE_META, FAKE_INPUT, runAnalyzeMock } = vi.hoisted(() => ({
  FAKE_META: {
    container: 'mp4',
    codec: 'avc1',
    codedWidth: 64,
    codedHeight: 64,
    displayWidth: 64,
    displayHeight: 64,
    rotation: 0,
    fps: 30,
    duration: 4,
    audio: null,
  },
  FAKE_INPUT: {
    getPrimaryVideoTrack: async () => ({
      codec: 'avc1',
      canDecode: async () => true,
      displayWidth: 64,
      displayHeight: 64,
      computePacketStats: async () => ({ averagePacketRate: 30 }),
    }),
    getAudioTracks: async () => [],
  },
  // v1.10.0: controllable analyze seam — the merge-across-analyze integration
  // test resolves the pass WITH auto tracks (mockResolvedValueOnce); the
  // default stays the v1.9.0 shape (0 tracks, 1 frame, webgpu, not cancelled).
  runAnalyzeMock: vi.fn(async () => ({
    tracks: [],
    frameCount: 1,
    effectiveEp: 'webgpu',
    cancelled: false,
  })),
}));

vi.mock('../../src/ingest.js', () => ({
  openInput: async () => ({ input: FAKE_INPUT, meta: FAKE_META }),
}));

vi.mock('../../src/analyze.js', () => ({
  runAnalyze: runAnalyzeMock,
  sampleFrameAt: async () => {
    throw new Error('unused in unit tests');
  },
}));

// v1.17.0 REQ-129: the export button IS exercised below (startExport's
// settings must carry pixelStrength), so the exporter runs behind a mock —
// the burn-in itself is exporter.test.js's territory.
const { runExportMock, FakeExportError } = vi.hoisted(() => {
  /** Minimal ExportError stand-in (main.js only does instanceof + .stage). */
  class FakeExportError extends Error {
    constructor(stage, message) {
      super(message ?? `export failed at ${stage}`);
      this.name = 'ExportError';
      this.stage = stage;
    }
  }
  return { runExportMock: vi.fn(async () => ({ bytes: 1 })), FakeExportError };
});

vi.mock('../../src/exporter.js', () => ({
  ExportError: FakeExportError,
  discardExportTemp: vi.fn(async () => true),
  runExport: runExportMock,
}));

const CAPS_FIXTURE = {
  secureContext: true,
  engine: 'chromium',
  epPolicy: 'webgpu',
  probes: [
    { kind: 'video-decode', ok: true, codec: 'avc1', width: 1920, height: 1080, detail: 'avc1 1920x1080 @ 30fps — decodable' },
    { kind: 'audio-decode', ok: true, codec: 'mp4a.40.2', detail: 'mp4a.40.2 — decodable' },
    { kind: 'video-encode-avc', ok: false, codec: 'avc', width: 1920, height: 1080, detail: 'avc encode unsupported at 1920x1080 (tried levels 4.2–5.2)' },
    { kind: 'video-encode-vp9', ok: true, codec: 'vp09.00.10.08', width: 1920, height: 1080, detail: 'vp9 (vp09.00.10.08) 1920x1080' },
  ],
  canAnalyze: true,
  canExport: true,
  warnings: ['HDR source may shift colors after export.'],
};

const META_FIXTURE = {
  container: 'mp4',
  codec: 'avc1',
  codedWidth: 1920,
  codedHeight: 1080,
  displayWidth: 1920,
  displayHeight: 1080,
  rotation: 90,
  fps: 29.97,
  duration: 183.4,
  audio: { codec: 'aac' },
};

describe('main-wiring: deriveStep state machine', () => {
  it('walks the full legal path gate → ready → analyzing → review → exporting → done', () => {
    let step = 'gate';
    step = main.deriveStep(step, 'FILE_OPENED');
    expect(step).toBe('ready');
    step = main.deriveStep(step, 'ANALYZE_START');
    expect(step).toBe('analyzing');
    step = main.deriveStep(step, 'ANALYZE_FINISH');
    expect(step).toBe('review');
    step = main.deriveStep(step, 'EXPORT_START');
    expect(step).toBe('exporting');
    step = main.deriveStep(step, 'EXPORT_DONE');
    expect(step).toBe('done');
  });

  it('supports cancel, failure, and re-entry transitions', () => {
    // Export failure returns to review so the user can retry (REQ-021).
    expect(main.deriveStep('exporting', 'EXPORT_FAIL')).toBe('review');
    // Opening another file from review goes back to ready (fresh AppState).
    expect(main.deriveStep('review', 'FILE_OPENED')).toBe('ready');
    // Re-analyze is legal from review and done (e.g. dashcam toggle changed).
    expect(main.deriveStep('review', 'ANALYZE_START')).toBe('analyzing');
    expect(main.deriveStep('done', 'ANALYZE_START')).toBe('analyzing');
    // Re-export is legal from done.
    expect(main.deriveStep('done', 'EXPORT_START')).toBe('exporting');
    // Analyze failure falls back to ready (file still open, retry possible).
    expect(main.deriveStep('analyzing', 'ANALYZE_FAIL')).toBe('ready');
  });

  it('rejects illegal transitions with null (guards Analyze/Export preconditions)', () => {
    // No Analyze before ready; no Export without review state.
    expect(main.deriveStep('gate', 'ANALYZE_START')).toBeNull();
    expect(main.deriveStep('gate', 'EXPORT_START')).toBeNull();
    expect(main.deriveStep('ready', 'EXPORT_START')).toBeNull();
    expect(main.deriveStep('ready', 'ANALYZE_FINISH')).toBeNull();
    expect(main.deriveStep('analyzing', 'EXPORT_START')).toBeNull();
    expect(main.deriveStep('analyzing', 'EXPORT_DONE')).toBeNull();
    expect(main.deriveStep('exporting', 'ANALYZE_START')).toBeNull();
    expect(main.deriveStep('done', 'ANALYZE_FINISH')).toBeNull();
    // Unknown states and events never transition.
    expect(main.deriveStep('nonsense-state', 'FILE_OPENED')).toBeNull();
    expect(main.deriveStep('review', 'NONSENSE_EVENT')).toBeNull();
  });
});

describe('main-wiring: stepperModel', () => {
  it('maps every app state to its stepper current/done entries', () => {
    expect(main.stepperModel('gate')).toEqual({ current: 'step-gate', done: [] });
    expect(main.stepperModel('ready')).toEqual({ current: 'step-analyze', done: ['step-gate'] });
    expect(main.stepperModel('analyzing')).toEqual({ current: 'step-analyze', done: ['step-gate'] });
    expect(main.stepperModel('review')).toEqual({
      current: 'step-review',
      done: ['step-gate', 'step-analyze'],
    });
    expect(main.stepperModel('exporting')).toEqual({
      current: 'step-export',
      done: ['step-gate', 'step-analyze', 'step-review'],
    });
    expect(main.stepperModel('done')).toEqual({
      current: null,
      done: ['step-gate', 'step-analyze', 'step-review', 'step-export'],
    });
    // Unknown state → inert stepper (never crashes).
    expect(main.stepperModel('bogus')).toEqual({ current: null, done: [] });
  });
});

describe('main-wiring: formatters', () => {
  it('formatBytes renders binary units with one decimal and guards bad input', () => {
    expect(main.formatBytes(0)).toBe('0 B');
    expect(main.formatBytes(512)).toBe('512 B');
    expect(main.formatBytes(1024)).toBe('1.0 KB');
    expect(main.formatBytes(2048)).toBe('2.0 KB');
    expect(main.formatBytes(232589)).toBe('227.1 KB'); // YuNet model size
    expect(main.formatBytes(7835770)).toBe('7.5 MB'); // YOLOv9-t model size
    expect(main.formatBytes(1610612736)).toBe('1.5 GB');
    expect(main.formatBytes(NaN)).toBe('—');
    expect(main.formatBytes(-5)).toBe('—');
  });

  it('formatEta renders seconds/minutes and — for unknown', () => {
    expect(main.formatEta(null)).toBe('—');
    expect(main.formatEta(NaN)).toBe('—');
    expect(main.formatEta(-1)).toBe('—');
    expect(main.formatEta(0)).toBe('0s');
    expect(main.formatEta(42.6)).toBe('43s');
    expect(main.formatEta(90)).toBe('1m 30s');
    expect(main.formatEta(754)).toBe('12m 34s');
  });

  it('formatClock renders m:ss.d and never rolls over into :60.0', () => {
    expect(main.formatClock(0)).toBe('0:00.0');
    expect(main.formatClock(5)).toBe('0:05.0');
    expect(main.formatClock(83.4)).toBe('1:23.4');
    expect(main.formatClock(600)).toBe('10:00.0');
    expect(main.formatClock(59.96)).toBe('1:00.0');
    expect(main.formatClock(NaN)).toBe('0:00.0');
  });
});

describe('main-wiring: mapExportErrorToMessage (REQ-021)', () => {
  it('maps every ExportError stage to a distinct, actionable message', () => {
    const stages = ['encode-avc', 'encode-avc-software', 'encode-vp9', 'mux', 'io', 'cancelled'];
    const messages = stages.map((stage) => main.mapExportErrorToMessage(stage));
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(20); // readable, not a bare code
    }
    expect(new Set(messages).size).toBe(stages.length); // every stage distinct
    expect(main.mapExportErrorToMessage('io')).toMatch(/disk space/i);
    expect(main.mapExportErrorToMessage('mux')).toMatch(/report/i);
    expect(main.mapExportErrorToMessage('cancelled')).toMatch(/cancelled/i);
    expect(main.mapExportErrorToMessage('encode-avc')).toMatch(/retry/i);
  });

  it('falls back to a generic message for unknown stages', () => {
    const generic = main.mapExportErrorToMessage('some-new-stage');
    expect(generic).toContain('no output file was delivered');
    expect(generic).not.toBe(main.mapExportErrorToMessage('io'));
  });
});

describe('main-wiring: describeIngestFailure (REQ-001/021)', () => {
  it('passes typed IngestError messages through verbatim (already actionable)', () => {
    const err = Object.assign(new Error('This file’s container is not supported.'), {
      name: 'IngestError',
      code: 'unsupported-container',
    });
    expect(main.describeIngestFailure(err)).toBe('This file’s container is not supported.');
  });

  it('wraps non-ingest errors in an explicit fallback', () => {
    expect(main.describeIngestFailure(new Error('boom'))).toBe('Could not open this file: boom');
    expect(main.describeIngestFailure('weird')).toBe('Could not open this file: weird');
    expect(main.describeIngestFailure(undefined)).toContain('unknown error');
  });
});

describe('main-wiring: renderProbeRows view model', () => {
  it('maps probe kinds to labels and preserves ok/detail order', () => {
    const vm = main.renderProbeRows(CAPS_FIXTURE);
    expect(vm.engine).toBe('chromium');
    expect(vm.epPolicy).toBe('webgpu');
    expect(vm.canAnalyze).toBe(true);
    expect(vm.canExport).toBe(true);
    expect(vm.rows.map((r) => r.label)).toEqual([
      'Video decode',
      'Audio decode',
      'H.264 encode',
      'VP9 encode',
    ]);
    expect(vm.rows.map((r) => r.ok)).toEqual([true, true, false, true]);
    expect(vm.rows[0].detail).toContain('decodable');
    // Unknown probe kinds degrade to the raw kind, never crash.
    const weird = main.renderProbeRows({
      ...CAPS_FIXTURE,
      probes: [{ kind: 'video-encode-av1', ok: false, detail: 'nope' }],
    });
    expect(weird.rows[0].label).toBe('video-encode-av1');
  });

  it('returns an inert view model for missing/invalid reports', () => {
    for (const caps of [null, undefined, {}]) {
      const vm = main.renderProbeRows(caps);
      expect(vm.rows).toEqual([]);
      expect(vm.canAnalyze).toBe(false);
      expect(vm.canExport).toBe(false);
      expect(vm.engine).toBe('unknown');
    }
  });
});

describe('main-wiring: inferenceRow (AC-17 inference-provider notice)', () => {
  it('renders the WebGPU policy line when the report says webgpu', () => {
    expect(main.inferenceRow(CAPS_FIXTURE)).toEqual({
      label: 'Inference',
      value: 'WebGPU accelerated',
    });
  });

  it('renders the honest WASM line with the WebKit policy reason', () => {
    expect(main.inferenceRow({ engine: 'webkit', epPolicy: 'wasm' })).toEqual({
      label: 'Inference',
      value: 'CPU (WASM) — WebGPU unavailable on this browser',
    });
  });

  it('renders the plain fallback reason on non-WebKit engines', () => {
    expect(main.inferenceRow({ engine: 'chromium', epPolicy: 'wasm' })).toEqual({
      label: 'Inference',
      value: 'CPU (WASM) — WebGPU unavailable',
    });
  });

  it('returns null (no row) for a missing report or unknown policy', () => {
    expect(main.inferenceRow(null)).toBeNull();
    expect(main.inferenceRow(undefined)).toBeNull();
    expect(main.inferenceRow({})).toBeNull();
    expect(main.inferenceRow({ engine: 'chromium', epPolicy: 'exotic' })).toBeNull();
  });
});

describe('main-wiring: epLabel (AC-17 effective provider suffix)', () => {
  it('labels the EP the analyze pass actually ran on', () => {
    expect(main.epLabel('webgpu')).toBe('WebGPU');
    expect(main.epLabel('wasm')).toBe('CPU (WASM)');
  });

  it('returns null for unknown/missing EP (never an invented claim)', () => {
    expect(main.epLabel(null)).toBeNull();
    expect(main.epLabel(undefined)).toBeNull();
    expect(main.epLabel('')).toBeNull();
    expect(main.epLabel('tensorrt')).toBeNull();
  });
});

describe('main-wiring: metaSummaryRows view model (AC-02)', () => {
  it('summarizes container, codec, resolution+rotation, fps, duration, audio', () => {
    const rows = main.metaSummaryRows(META_FIXTURE);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Container']).toBe('mp4');
    expect(byLabel['Video codec']).toBe('avc1');
    expect(byLabel['Resolution']).toBe('1920×1080 (rotated 90°)');
    expect(byLabel['Frame rate']).toBe('29.97 fps');
    expect(byLabel['Duration']).toBe('3:03.4');
    expect(byLabel['Audio']).toBe('aac');
  });

  it('omits the rotation annotation at 0°, reports silent audio as none, guards fps', () => {
    const rows = main.metaSummaryRows({ ...META_FIXTURE, rotation: 0, audio: null, fps: 0 });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel['Resolution']).toBe('1920×1080');
    expect(byLabel['Audio']).toBe('none');
    expect(byLabel['Frame rate']).toBe('unknown');
    // No meta at all → no rows (report section stays hidden).
    expect(main.metaSummaryRows(null)).toEqual([]);
  });
});

describe('main-wiring: threshold compare view model (v1.5.0 REQ-113/114)', () => {
  const FACES = [
    { conf: 0.9 },
    { conf: 0.55 },
    { conf: 0.2 },
  ];
  const PLATES = [{ conf: 0.7 }, { conf: 0.3 }];

  it('THRESHOLD_LEVELS are exactly the five fixed compare levels', () => {
    expect(main.THRESHOLD_LEVELS).toEqual([0.15, 0.3, 0.45, 0.6, 0.75]);
  });

  it('slider ranges match REQ-113 (face 0.10–0.90, plate 0.05–0.90, step 0.05, baked defaults)', () => {
    expect(main.THRESHOLD_FACE_RANGE).toEqual({ min: 0.1, max: 0.9, step: 0.05, default: 0.6 });
    expect(main.THRESHOLD_PLATE_RANGE).toEqual({ min: 0.05, max: 0.9, step: 0.05, default: 0.25 });
  });

  it('buildThresholdPanels counts faces/plates at or above each level', () => {
    const panels = main.buildThresholdPanels(main.THRESHOLD_LEVELS, FACES, PLATES);
    expect(panels.map((p) => p.level)).toEqual([0.15, 0.3, 0.45, 0.6, 0.75]);
    expect(panels.map((p) => p.faces)).toEqual([3, 2, 2, 1, 1]);
    expect(panels.map((p) => p.plates)).toEqual([2, 2, 1, 1, 0]); // 0.7 < 0.75
  });

  it('level boundaries are inclusive (conf == level counts)', () => {
    const panels = main.buildThresholdPanels([0.55, 0.9], [{ conf: 0.55 }], [{ conf: 0.9 }]);
    expect(panels.map((p) => p.faces)).toEqual([1, 0]);
    expect(panels.map((p) => p.plates)).toEqual([1, 1]);
  });

  it('guards missing levels/detections (inert panels, never a crash)', () => {
    expect(main.buildThresholdPanels(null, FACES, PLATES)).toEqual([]);
    expect(main.buildThresholdPanels([0.5], undefined, null)).toEqual([
      { level: 0.5, faces: 0, plates: 0 },
    ]);
    expect(main.buildThresholdPanels([0.5], [{ conf: NaN }], [{}])).toEqual([
      { level: 0.5, faces: 0, plates: 0 },
    ]);
  });

  it('formatThresholdCaption renders "≥level · N faces · M plates" with plurals', () => {
    expect(main.formatThresholdCaption({ level: 0.15, faces: 2, plates: 1 })).toBe(
      '≥0.15 · 2 faces · 1 plate',
    );
    expect(main.formatThresholdCaption({ level: 0.6, faces: 1, plates: 0 })).toBe(
      '≥0.60 · 1 face · 0 plates',
    );
    expect(main.formatThresholdCaption({ level: 0.3, faces: 0, plates: 3 })).toBe(
      '≥0.30 · 0 faces · 3 plates',
    );
  });

  it('applyThresholdLevel maps a panel level onto BOTH sliders, clamped per range', () => {
    expect(main.applyThresholdLevel(0.45)).toEqual({ confFace: 0.45, confPlate: 0.45 });
    // A level below the face slider's min clamps to 0.10 but keeps 0.05 on plate.
    expect(main.applyThresholdLevel(0.05)).toEqual({ confFace: 0.1, confPlate: 0.05 });
    expect(main.applyThresholdLevel(1.2).confFace).toBe(0.9);
  });

  it('applyThresholdLevel preserves other settings and ignores invalid levels', () => {
    const next = main.applyThresholdLevel(0.6, { dashcamMode: true, confFace: 0.2 });
    expect(next).toEqual({ dashcamMode: true, confFace: 0.6, confPlate: 0.6 });
    expect(main.applyThresholdLevel('bogus', { a: 1 })).toEqual({ a: 1 });
    expect(main.applyThresholdLevel(undefined)).toEqual({});
  });
});

describe('main-wiring: CLEAR transition (v1.6.0 clear-all)', () => {
  const STEPS = ['gate', 'ready', 'analyzing', 'review', 'exporting', 'done'];

  it("deriveStep: CLEAR lands on 'gate' from every legal step", () => {
    for (const step of STEPS) {
      expect(main.deriveStep(step, 'CLEAR')).toBe('gate');
    }
  });

  it('CLEAR is total — no step can escape the machine via it, and gate re-arms FILE_OPENED only', () => {
    for (const step of STEPS) {
      const next = main.deriveStep(step, 'CLEAR');
      expect(next).toBe('gate');
      // The landing step renders as the gate stepper entry…
      expect(main.stepperModel(next).current).toBe('step-gate');
      // …and only FILE_OPENED / CLEAR are legal from there.
      expect(main.deriveStep(next, 'ANALYZE_START')).toBeNull();
      expect(main.deriveStep(next, 'EXPORT_START')).toBeNull();
    }
  });

  it('CLEAR from an unknown state still derives null (machine stays closed)', () => {
    expect(main.deriveStep('bogus', 'CLEAR')).toBeNull();
  });

  it('CLEAR is a legal transition from every step the reducer knows about', () => {
    // Structural guard: every step listed in the reducer carries CLEAR — a
    // future step added without it fails here instead of trapping users in
    // a state the Clear button cannot leave.
    for (const step of STEPS) {
      expect(main.deriveStep(step, 'CLEAR'), step).toBe('gate');
    }
  });
});

describe('main-wiring: DEFAULT_SETTINGS factory (v1.6.0)', () => {
  it('returns the baked defaults: face 0.60, plate 0.25, dashcam off, plateStride unset', () => {
    expect(main.DEFAULT_SETTINGS()).toEqual({
      confFace: 0.6,
      confPlate: 0.25,
      dashcamMode: false,
      plateStride: undefined,
    });
  });

  it('returns a FRESH object per call — the shared default can never be mutated', () => {
    const a = main.DEFAULT_SETTINGS();
    const b = main.DEFAULT_SETTINGS();
    expect(a).not.toBe(b);
    a.confFace = 0.9;
    a.dashcamMode = true;
    expect(main.DEFAULT_SETTINGS()).toEqual({
      confFace: 0.6,
      confPlate: 0.25,
      dashcamMode: false,
      plateStride: undefined,
    });
  });

  it('agrees with the slider-range defaults (single source of truth, REQ-113)', () => {
    const s = main.DEFAULT_SETTINGS();
    expect(s.confFace).toBe(main.THRESHOLD_FACE_RANGE.default);
    expect(s.confPlate).toBe(main.THRESHOLD_PLATE_RANGE.default);
  });
});

describe('main-wiring: fileInputNeedsReset (v1.6.0)', () => {
  it('flags a populated input (same-file re-select would not fire change)', () => {
    expect(main.fileInputNeedsReset('video.mp4')).toBe(true);
  });

  it('accepts an already-empty input and non-string values', () => {
    expect(main.fileInputNeedsReset('')).toBe(false);
    expect(main.fileInputNeedsReset(undefined)).toBe(false);
    expect(main.fileInputNeedsReset(null)).toBe(false);
  });
});

describe('main-wiring: module import safety', () => {
  it('imports in node without touching the DOM (no auto-mount side effects)', async () => {
    // Re-import resolves the same namespace; assert the pure surface exists.
    const mod = await import('../../src/main.js');
    for (const name of [
      'deriveStep',
      'stepperModel',
      'formatBytes',
      'formatEta',
      'formatClock',
      'mapExportErrorToMessage',
      'describeIngestFailure',
      'renderProbeRows',
      'metaSummaryRows',
      'inferenceRow',
      'epLabel',
      'buildThresholdPanels',
      'formatThresholdCaption',
      'applyThresholdLevel',
      'DEFAULT_SETTINGS',
      'fileInputNeedsReset',
      'mountApp',
    ]) {
      expect(typeof mod[name], `main.${name}`).toBe('function');
    }
    // mountApp without a DOM (node) resolves to null without throwing.
    await expect(mod.mountApp(null)).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v1.6.1 REG-2 — doc-shortcut focus gating (shortcutEnabledFor)
// ---------------------------------------------------------------------------

/** Minimal focus-target stub: `closest` mirrors the Element API the handler
 * relies on; `isTyping` decides whether the stub matches the surfaces. */
function focusStub(isTyping) {
  return {
    closest: (selector) => (isTyping ? { matched: selector } : null),
  };
}

describe('shortcutEnabledFor — typing-surface exclusion (v1.6.1 REG-2)', () => {

  it('enables shortcuts for a BUTTON focus (the regression: clicked controls)', () => {
    expect(main.shortcutEnabledFor(focusStub(false))).toBe(true);
  });

  it('enables shortcuts for a missing/dead target (body, event retargeted)', () => {
    expect(main.shortcutEnabledFor(null)).toBe(true);
    expect(main.shortcutEnabledFor(undefined)).toBe(true);
    expect(main.shortcutEnabledFor({})).toBe(true); // no closest() → enabled
  });

  it('disables shortcuts inside input / select / textarea / contenteditable', () => {
    expect(main.shortcutEnabledFor(focusStub(true))).toBe(false);
  });

  it('keeps the exclusion for a focused track-row time input (.span-input)', () => {
    // The REQ-108 time fields are text inputs — typing "m:ss.s" must never
    // frame-step the video, so they stay excluded.
    const spanInput = focusStub(true);
    expect(main.shortcutEnabledFor(spanInput, {
      exclude: main.SHORTCUT_TYPING_SELECTOR,
    })).toBe(false);
  });

  it('honors an explicit exclude override', () => {
    expect(main.shortcutEnabledFor(focusStub(true), { exclude: 'textarea' })).toBe(false);
    expect(main.shortcutEnabledFor(focusStub(false), { exclude: 'textarea' })).toBe(true);
    // non-string exclude falls back to the typing-surface selector
    expect(main.shortcutEnabledFor(focusStub(true), { exclude: 42 })).toBe(false);
  });

  it('the default selector covers every typing surface and NO buttons', () => {
    expect(main.SHORTCUT_TYPING_SELECTOR).toBe('input, select, textarea, [contenteditable]');
    expect(main.SHORTCUT_TYPING_SELECTOR).not.toContain('button');
  });

  it('the export surface grew with the v1.6.1 helpers', () => {
    expect(typeof main.shortcutEnabledFor).toBe('function');
    expect(typeof main.SHORTCUT_TYPING_SELECTOR).toBe('string');
  });
});

describe('main-wiring: ?debug=1 runtime diagnostics (v1.8.2)', () => {
  it('parseDebugFlag accepts debug=1 and debug=true anywhere in the query', () => {
    expect(main.parseDebugFlag('?debug=1')).toBe(true);
    expect(main.parseDebugFlag('?v=2&debug=1&x=y')).toBe(true); // &debug=1 mid-query
    expect(main.parseDebugFlag('?debug=true')).toBe(true);
    expect(main.parseDebugFlag('?a=b&debug=true')).toBe(true);
    expect(main.parseDebugFlag('debug=1')).toBe(true); // missing leading '?' tolerated
  });

  it('parseDebugFlag is deterministically OFF for everything else', () => {
    expect(main.parseDebugFlag('')).toBe(false);
    expect(main.parseDebugFlag('?foo=1')).toBe(false);
    expect(main.parseDebugFlag('?debug')).toBe(false); // bare flag, no value
    expect(main.parseDebugFlag('?debug=')).toBe(false);
    expect(main.parseDebugFlag('?debug=0')).toBe(false);
    expect(main.parseDebugFlag('?debug=false')).toBe(false);
    expect(main.parseDebugFlag('?debug=on')).toBe(false);
    expect(main.parseDebugFlag('?Debug=1')).toBe(false); // name is case-sensitive
    expect(main.parseDebugFlag('?debug=1&debug=0')).toBe(true); // first value wins
  });

  it('formatDiagLine emits keys in the canonical DIAG_KEY_ORDER', () => {
    const line = main.formatDiagLine({ vfc: 7, tracks: 0, tu: 3, step: 'ready', v: '1.9.0' });
    expect(line.startsWith('{"v"')).toBe(true); // identity leads
    expect(line.indexOf('"tu"')).toBeLessThan(line.indexOf('"vfc"'));
    expect(line.indexOf('"step"')).toBeLessThan(line.indexOf('"tracks"'));
    expect(JSON.parse(line)).toEqual({ v: '1.9.0', step: 'ready', tu: 3, vfc: 7, tracks: 0 });
  });

  it('formatDiagLine finite-guards numbers and keeps undefined keys as null', () => {
    expect(main.formatDiagLine({ dur: NaN })).toBe('{"dur":null}');
    expect(main.formatDiagLine({ t: Infinity })).toBe('{"t":null}');
    expect(main.formatDiagLine({ t: -Infinity })).toBe('{"t":null}');
    expect(main.formatDiagLine({ pin: undefined })).toBe('{"pin":null}');
    expect(main.formatDiagLine({ tu: 0, vfc: 0 })).toBe('{"tu":0,"vfc":0}');
  });

  it('formatDiagLine serializes a full support snapshot compactly (round-trip)', () => {
    const line = main.formatDiagLine({
      v: '1.12.0', build: '2026-10-30', secure: true, step: 'review',
      t: 3.14159, dur: NaN, paused: false, rate: 1, muted: false,
      tu: 12, vfc: 0, tued: 12, errs: 1, lastErr: 'probe-boom',
      drag: false, pin: false, pinMs: 0, thumbLeft: '12.5%',
      focus: 'BODY', tracks: 2, webgpu: true, theme: 'dark',
    });
    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      v: '1.12.0', build: '2026-10-30', secure: true, step: 'review',
      // no rounding here — the snapshot's toFixed(2) owns that, this only finite-guards
      t: 3.14159, dur: null, paused: false, rate: 1, muted: false,
      tu: 12, vfc: 0, tued: 12, errs: 1, lastErr: 'probe-boom',
      drag: false, pin: false, pinMs: 0, thumbLeft: '12.5%',
      focus: 'BODY', tracks: 2, webgpu: true, theme: 'dark',
    });
    expect(Object.keys(parsed)).toEqual(main.DIAG_KEY_ORDER);
    expect(line).not.toContain(' '); // compact — stays one console line
  });

  it('v1.9.0 diag keys: every new evidence field exists, in the documented order', () => {
    // The v1.9.0 additions — the unreproducible field failure demanded a
    // conclusive line: page exceptions (errs/lastErr), the editor's own
    // timeupdate path (tued), and the editor gesture state (drag/pin/pinMs).
    // v1.12.0 appends `theme` (REQ-124) after the review facts.
    expect(main.DIAG_KEY_ORDER).toEqual([
      'v', 'build', 'secure', 'step', 't', 'dur', 'paused', 'rate', 'muted',
      'tu', 'vfc', 'tued', 'errs', 'lastErr', 'drag', 'pin', 'pinMs',
      'thumbLeft', 'focus', 'tracks', 'webgpu', 'theme',
    ]);
    const line = main.formatDiagLine({
      tu: 1, vfc: 2, tued: 3, errs: 4, lastErr: 'e', drag: true,
      pin: true, pinMs: 120, thumbLeft: '5%', focus: 'BUTTON#analyze-button',
    });
    expect(line.indexOf('"tu"')).toBeLessThan(line.indexOf('"vfc"'));
    expect(line.indexOf('"vfc"')).toBeLessThan(line.indexOf('"tued"'));
    expect(line.indexOf('"tued"')).toBeLessThan(line.indexOf('"errs"'));
    expect(line.indexOf('"errs"')).toBeLessThan(line.indexOf('"lastErr"'));
    expect(line.indexOf('"lastErr"')).toBeLessThan(line.indexOf('"drag"'));
    expect(line.indexOf('"drag"')).toBeLessThan(line.indexOf('"pin"'));
    expect(line.indexOf('"pin"')).toBeLessThan(line.indexOf('"pinMs"'));
    expect(line.indexOf('"pinMs"')).toBeLessThan(line.indexOf('"thumbLeft"'));
    expect(line.indexOf('"thumbLeft"')).toBeLessThan(line.indexOf('"focus"'));
    const parsed = JSON.parse(line);
    expect(parsed.pinMs).toBe(120);
    expect(parsed.focus).toBe('BUTTON#analyze-button');
  });

  it('formatDiagLine tolerates missing/non-object input', () => {
    expect(main.formatDiagLine()).toBe('{}');
    expect(main.formatDiagLine(null)).toBe('{}');
    expect(main.formatDiagLine(42)).toBe('{}');
  });

  it('diag counters are wired: main shares __VR_DIAG, editor bumps vfc in its rVFC tick', () => {
    const mainSrc = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
    // Shared counter object exists (module scope) + a timeupdate bump in mountApp.
    expect(mainSrc).toContain('globalThis.__VR_DIAG = globalThis.__VR_DIAG ?? {');
    for (const key of ['tu: 0', 'vfc: 0', 'tickErr: 0', 'tued: 0', 'errs: 0', 'lastErr: null']) {
      expect(mainSrc, `__VR_DIAG field ${key}`).toContain(key);
    }
    expect(mainSrc).toContain("addEventListener('timeupdate'");
    // v1.9.0: the runtime error listeners are ALWAYS on (not behind ?debug=1).
    expect(mainSrc).toContain("addEventListener('error'");
    expect(mainSrc).toContain("addEventListener('unhandledrejection'");
    // editor.js counts ONLY the rVFC-delivered tick (guarded by usingVFC).
    const editorSrc = readFileSync(join(ROOT, 'src', 'editor.js'), 'utf8');
    expect(editorSrc).toMatch(/if \(usingVFC && globalThis\.__VR_DIAG\) globalThis\.__VR_DIAG\.vfc \+= 1/);
    // v1.9.0: the editor counts its own timeupdate path + per-tick failures.
    expect(editorSrc).toContain('tued');
    expect(editorSrc).toContain('tickErr');
    expect(editorSrc).toContain("[editor-tick-error]");
  });

  it('v1.9.0 reorder contract: keyboard wiring precedes the isolated editor mount', () => {
    const src = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
    // First doc keydown listener = the transport shortcuts (moved early in
    // v1.9.0); the Escape-zoom handler registers later.
    const keyboardAt = src.indexOf("doc.addEventListener('keydown', (e) => {");
    const mountCallAt = src.indexOf('(mountEditorSafe('); // cast line (v1.9.0)
    expect(keyboardAt).toBeGreaterThan(-1);
    expect(mountCallAt).toBeGreaterThan(keyboardAt);
    // The mount runs through the isolated seam, and its failure toast exists.
    expect(src).toContain('export function mountEditorSafe(');
    expect(src).toContain('Editor failed to start: ${message} — please report');
    // Shortcuts handler sits before the analyze section (the first code path
    // that can ever reach an editor mount).
    const analyzeAt = src.indexOf('// --- Analyze pass');
    expect(keyboardAt).toBeLessThan(analyzeAt);
  });
});

// ---------------------------------------------------------------------------
// focusLabel (v1.9.0 diag focus field)
// ---------------------------------------------------------------------------

describe('focusLabel (v1.9.0 diag focus field)', () => {
  it('renders TAG#id and bare TAG', () => {
    expect(main.focusLabel({ tagName: 'BUTTON', id: 'analyze-button' })).toBe(
      'BUTTON#analyze-button',
    );
    expect(main.focusLabel({ tagName: 'BODY', id: '' })).toBe('BODY');
    expect(main.focusLabel({ tagName: 'DIV' })).toBe('DIV');
  });

  it('degrades missing/dead elements to null (never throws, never empty)', () => {
    expect(main.focusLabel(null)).toBeNull();
    expect(main.focusLabel(undefined)).toBeNull();
    expect(main.focusLabel({})).toBeNull();
    expect(main.focusLabel({ tagName: '', id: 'x' })).toBeNull();
    expect(main.focusLabel({ tagName: 42, id: 'x' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mountEditorSafe (v1.9.0 editor-mount exception isolation)
// ---------------------------------------------------------------------------

describe('mountEditorSafe (v1.9.0 editor-mount exception isolation)', () => {
  it('passes the handle through and forwards els/hooks on success', () => {
    const seen = {};
    const handle = { destroy() {} };
    const mount = (els, hooks) => {
      seen.els = els;
      seen.hooks = hooks;
      return handle;
    };
    const onFail = () => {
      throw new Error('onFail must not run on success');
    };
    const out = main.mountEditorSafe(mount, { a: 1 }, { b: 2 }, onFail);
    expect(out).toBe(handle);
    expect(seen.els).toEqual({ a: 1 });
    expect(seen.hooks).toEqual({ b: 2 });
  });

  it('a throwing mount → null + onFail with the RAW error, never propagates', () => {
    const boom = new Error('boom-editor');
    const seen = [];
    const out = main.mountEditorSafe(() => {
      throw boom;
    }, {}, {}, (err) => seen.push(err));
    expect(out).toBeNull();
    expect(seen).toEqual([boom]);
  });

  it('degenerate seams are safe: non-function → null; missing onFail → silent null', () => {
    expect(main.mountEditorSafe(null, {}, {})).toBeNull();
    expect(main.mountEditorSafe(undefined, {}, {})).toBeNull();
    expect(() => main.mountEditorSafe(() => { throw new Error('x'); }, {}, {})).not.toThrow();
    expect(main.mountEditorSafe(() => { throw new Error('x'); }, {}, {})).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// v1.9.0 mountApp node harness — the field-failure hardening, proven end to
// end in node against a fake document (no jsdom). mountApp takes a `doc` and
// injectable seams, so the REAL wiring runs here: a throwing mountEditor
// seam simulates the field failure and the doc-level keyboard must still be
// registered AND still toggle playback afterwards; window error listeners
// must be ALWAYS on (no ?debug=1) and feed errs/lastErr.
// ---------------------------------------------------------------------------

/** CSSStyleDeclaration-ish fake: plain properties + setProperty/getPropertyValue. */
function makeFakeStyle() {
  const s = {};
  s.setProperty = (k, v) => {
    s[k] = String(v);
  };
  s.getPropertyValue = (k) => (k in s ? String(s[k]) : '');
  return s;
}

/** Minimal DOM-element fake good enough for mountApp's guarded wiring. */
function makeFakeEl(tag = 'DIV') {
  const listeners = new Map();
  const classes = new Set();
  const el = {
    tagName: tag,
    style: makeFakeStyle(),
    dataset: {},
    attrs: {},
    children: [],
    listeners,
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    title: '',
    className: '',
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, event = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn({ target: el, ...event });
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    append(...kids) {
      el.children.push(...kids);
    },
    replaceChildren(...kids) {
      el.children = kids;
    },
    remove() {},
    setAttribute(k, v) {
      el.attrs[k] = String(v);
    },
    getAttribute(k) {
      return el.attrs[k] ?? null;
    },
    blur() {},
    // v1.17.0: the project-save path clicks a created anchor; the
    // #pixel-strength delegation resolves buttons via closest(sel).
    click() {
      el.clicked = (el.clicked || 0) + 1;
    },
    closest(selector) {
      if (typeof selector !== 'string' || selector.length === 0) return null;
      if (selector.startsWith('.')) return classes.has(selector.slice(1)) ? el : null;
      if (selector.startsWith('#')) return el.attrs.id === selector.slice(1) ? el : null;
      return null;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    // v1.12.0: functional class list — the F-key zoom-toggle test asserts the
    // .preview-zoom class actually lands on #preview-stage.
    classList: {
      add(...names) {
        for (const n of names) classes.add(n);
      },
      remove(...names) {
        for (const n of names) classes.delete(n);
      },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      contains: (n) => classes.has(n),
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    },
  };
  return el;
}

/** Fake document + view with listener recorders and per-id element stubs. */
function makeFakeEnv() {
  const viewListeners = new Map();
  const fakeView = {
    isSecureContext: true,
    innerHeight: 800,
    scrollY: 0,
    navigator: { userAgent: 'node-fake' },
    addEventListener(type, fn) {
      if (!viewListeners.has(type)) viewListeners.set(type, new Set());
      viewListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      viewListeners.get(type)?.delete(fn);
    },
    /** Test-side dispatch: run every registered view listener for `type`. */
    __dispatch(type, event = {}) {
      for (const fn of [...(viewListeners.get(type) ?? [])]) fn(event);
    },
  };
  const docListeners = new Map();
  const elsById = new Map();
  const createdEls = [];
  const fakeDoc = {
    body: { dataset: {} },
    activeElement: null,
    fullscreenElement: null,
    readyState: 'complete',
    defaultView: fakeView,
    // v1.17.0: created elements are recorded (the project-save test asserts
    // the download anchor's .download + click).
    createElement(tag) {
      const el = makeFakeEl(String(tag).toUpperCase());
      createdEls.push(el);
      return el;
    },
    __createdEls: createdEls,
    getElementById(id) {
      if (!elsById.has(id)) {
        if (id === 'preview-video') {
          const video = makeFakeEl('VIDEO');
          video.paused = true;
          video.currentTime = 0;
          video.duration = Number.NaN;
          video.playbackRate = 1;
          video.muted = false;
          video.playsPlayed = 0;
          video.play = () => {
            video.paused = false;
            video.playsPlayed += 1;
            return Promise.resolve();
          };
          video.pause = () => {
            video.paused = true;
          };
          video.load = () => {};
          video.removeAttribute = () => {};
          video.src = '';
          elsById.set(id, video);
        } else if (id === 'file-input') {
          const input = makeFakeEl('INPUT');
          input.files = [
            Object.assign(new Blob([new Uint8Array([1, 2, 3])], { type: 'video/mp4' }), {
              name: 'clip.mp4',
            }),
          ];
          elsById.set(id, input);
        } else {
          elsById.set(id, makeFakeEl('DIV'));
        }
      }
      return elsById.get(id);
    },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      docListeners.get(type)?.delete(fn);
    },
    /** Test-side dispatch: run every registered doc listener for `type`. */
    __dispatch(type, event = {}) {
      for (const fn of [...(docListeners.get(type) ?? [])]) fn(event);
    },
    __docListeners: docListeners,
  };
  return { fakeDoc, fakeView, viewListeners, docListeners, elsById, createdEls };
}

/** MountApp wiring is async; the analyze path resolves on the macrotask queue. */
async function flushApp() {
  for (let i = 0; i < 12; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Drive the REAL wiring through file-open → analyze → (failing) editor mount. */
async function openAndAnalyze(fakeDoc) {
  fakeDoc.getElementById('file-input').dispatch('change');
  await flushApp(); // openInput + probeCapabilities + handleFile continuation
  fakeDoc.getElementById('analyze-button').dispatch('click');
  await flushApp(); // runAnalyze promise → enterReview → (failing) mount
}

/** Flatten the toast region into its text messages. */
function toastTexts(fakeDoc) {
  return fakeDoc
    .getElementById('toast-region')
    .children.map((toast) => toast.children?.[0]?.textContent ?? '');
}

describe('mountApp (v1.9.0): an editor-mount failure cannot kill the keyboard', () => {
  /** Save/restore the two globals mountApp reads in node. */
  const saved = {};

  function armGlobals(fakeView) {
    saved.isSecureContext = globalThis.isSecureContext;
    saved.window = globalThis.window;
    globalThis.isSecureContext = true; // capability.secureContextInfo seam
    globalThis.window = fakeView; // the bare `window` resize listener
  }

  function restoreGlobals() {
    if ('isSecureContext' in saved) {
      if (saved.isSecureContext === undefined) delete globalThis.isSecureContext;
      else globalThis.isSecureContext = saved.isSecureContext;
    }
    if ('window' in saved) {
      if (saved.window === undefined) delete globalThis.window;
      else globalThis.window = saved.window;
    }
  }

  it('end-to-end: throwing mountEditor → review state + toast + diag error, and Space STILL toggles play', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    globalThis.__VR_DIAG.errs = 0;
    globalThis.__VR_DIAG.lastErr = null;
    try {
      await main.mountApp(fakeDoc, {
        mountEditor: () => {
          throw new Error('boom-editor');
        },
      });
      // Keyboard registered during mount, before any editor could mount.
      const keydownCount = fakeDoc.__docListeners.get('keydown')?.size ?? 0;
      expect(keydownCount).toBeGreaterThanOrEqual(1);
      await openAndAnalyze(fakeDoc);

      // State still entered review (the failure happened AFTER the transition).
      expect(fakeDoc.getElementById('analyze-button').textContent).toBe('Re-analyze');
      // The failure is user-readable and machine-recorded.
      expect(toastTexts(fakeDoc)).toContain(
        'Editor failed to start: boom-editor — please report',
      );
      expect(globalThis.__VR_DIAG.errs).toBeGreaterThanOrEqual(1);
      expect(globalThis.__VR_DIAG.lastErr).toBe('boom-editor');

      // THE CONTRACT: Space still toggles playback after the editor died.
      const video = fakeDoc.getElementById('preview-video');
      video.paused = true;
      video.playsPlayed = 0;
      const prevented = [];
      // Dispatch through every registered doc keydown handler (the shortcuts
      // handler + the Escape-zoom handler; only the shortcuts path acts on
      // Space) — the SAME path a real keydown takes through the document.
      fakeDoc.__dispatch('keydown', {
        key: ' ',
        target: null,
        preventDefault: () => prevented.push(' '),
      });
      expect(prevented).toContain(' ');
      expect(video.playsPlayed).toBe(1);
      expect(video.paused).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  it('window error listeners are ALWAYS on (no ?debug=1) and feed errs/lastErr', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    globalThis.__VR_DIAG.errs = 0;
    globalThis.__VR_DIAG.lastErr = null;
    try {
      await main.mountApp(fakeDoc); // REAL mountEditor seam — never invoked here
      // The diag interval is OFF (no ?debug=1) yet the listeners exist.
      fakeView.__dispatch('error', { message: 'first boom' });
      expect(globalThis.__VR_DIAG.errs).toBe(1);
      expect(globalThis.__VR_DIAG.lastErr).toBe('first boom');
      const long = new Error(`second boom — ${'x'.repeat(120)}`);
      fakeView.__dispatch('unhandledrejection', { reason: long });
      expect(globalThis.__VR_DIAG.errs).toBe(2);
      expect(globalThis.__VR_DIAG.lastErr).toBe(long.message.slice(0, 80));
      // A non-Error rejection reason degrades to a string, never throws.
      fakeView.__dispatch('unhandledrejection', { reason: 42 });
      expect(globalThis.__VR_DIAG.errs).toBe(3);
      expect(globalThis.__VR_DIAG.lastErr).toBe('42');
    } finally {
      restoreGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// v1.10.0 — the timeline must work BEFORE analysis. The editor mounts at
// READY (file loaded), analysis completion only merges fresh auto tracks
// into the live editor's state (manual regions drawn pre-analyze survive),
// and the doc shortcuts toggle playback whenever the preview is visible.
// ---------------------------------------------------------------------------

/** Minimal auto Track (the shape tracker.js emits; only id/source matter to
 * the merge — the editor re-renders from the array identity). */
function autoTrack(id, overrides = {}) {
  return {
    id,
    cls: 'face',
    label: `Face #${id}`,
    color: '#2DD4BF',
    keyframes: new Map(),
    start: 0.5,
    end: 3,
    enabled: true,
    source: 'auto',
    style: 'pixelate',
    ...overrides,
  };
}

/** Minimal manual Track (manualTrackFromBox's shape). */
function manualTrack(id, overrides = {}) {
  return {
    id,
    cls: 'manual',
    label: `Manual #${id}`,
    color: '#A78BFA',
    keyframes: new Map(),
    start: 0,
    end: 10,
    enabled: true,
    source: 'manual',
    style: 'solid',
    ...overrides,
  };
}

describe('main-wiring: mergeManualTracks (v1.10.0 manual regions survive analysis)', () => {
  it('keeps manual tracks and appends analyzed autos when no ids collide', () => {
    const manual = manualTrack(5);
    const a1 = autoTrack(1);
    const a2 = autoTrack(2);
    const merged = main.mergeManualTracks([manual], [a1, a2]);
    expect(merged.tracks.map((t) => t.id)).toEqual([5, 1, 2]);
    expect(merged.tracks[0]).toBe(manual); // kept verbatim
    expect(merged.tracks[1]).toBe(a1); // verbatim (no collision → no re-id)
    expect(merged.tracks[2]).toBe(a2);
    expect(merged.manualNextId).toBe(6); // past every merged id
  });

  it('re-assigns colliding auto ids past EVERY existing id (manual + auto)', () => {
    const merged = main.mergeManualTracks([manualTrack(1)], [autoTrack(1), autoTrack(2)]);
    const ids = merged.tracks.map((t) => t.id);
    expect(ids[0]).toBe(1); // manual keeps its id
    expect(new Set(ids).size).toBe(ids.length); // collision-free
    expect(ids).toContain(2); // non-colliding auto untouched
    // The colliding auto was re-issued past max(existing) — never re-used.
    expect(ids.filter((id) => id !== 1 && id !== 2)).toHaveLength(1);
    expect(ids.filter((id) => id !== 1 && id !== 2)[0]).toBeGreaterThan(2);
    expect(merged.manualNextId).toBe(Math.max(...ids) + 1);
  });

  it('re-analyze replaces the previous AUTO set (only manuals survive)', () => {
    const oldAuto = autoTrack(1, { stale: true });
    const keep = manualTrack(2);
    const fresh1 = autoTrack(1);
    const fresh3 = autoTrack(3);
    const merged = main.mergeManualTracks([oldAuto, keep], [fresh1, fresh3]);
    expect(merged.tracks).toEqual([keep, fresh1, fresh3]); // old auto gone
    expect(merged.tracks.some((t) => t.stale)).toBe(false);
  });

  it('guards degenerate inputs and never mutates its arguments', () => {
    expect(main.mergeManualTracks(null, null)).toEqual({ tracks: [], manualNextId: 1 });
    expect(main.mergeManualTracks(undefined, [])).toEqual({ tracks: [], manualNextId: 1 });
    expect(main.mergeManualTracks([], null)).toEqual({ tracks: [], manualNextId: 1 });
    // Null entries in the analyzed array are dropped, not kept.
    const merged = main.mergeManualTracks([manualTrack(3)], [null, autoTrack(4)]);
    expect(merged.tracks.map((t) => t.id)).toEqual([3, 4]);
    expect(merged.manualNextId).toBe(5);

    // Inputs stay untouched: arrays, track objects, ids.
    const existing = [manualTrack(1)];
    const analyzed = [autoTrack(1)];
    const analyzedCopy = { id: analyzed[0].id, source: analyzed[0].source };
    main.mergeManualTracks(existing, analyzed);
    expect(existing.map((t) => t.id)).toEqual([1]);
    expect(analyzed.map((t) => ({ id: t.id, source: t.source }))).toEqual([analyzedCopy]);
  });

  it('is exposed on the module surface (typed pure seam)', () => {
    expect(typeof main.mergeManualTracks).toBe('function');
  });
});

describe('main-wiring: deriveStep v1.10.0 — ready carries a live editor, export stays post-analyze', () => {
  it('ready legally supports the live editor: analyze is reachable, playback state is stable', () => {
    expect(main.deriveStep('ready', 'ANALYZE_START')).toBe('analyzing');
    expect(main.deriveStep('ready', 'FILE_OPENED')).toBe('ready');
    // Analyze failure lands back on ready — the editor there is LIVE now.
    expect(main.deriveStep('analyzing', 'ANALYZE_FAIL')).toBe('ready');
  });

  it('export can never run pre-analyze: no path from gate/ready/analyzing to exporting', () => {
    expect(main.deriveStep('gate', 'EXPORT_START')).toBeNull();
    expect(main.deriveStep('ready', 'EXPORT_START')).toBeNull();
    expect(main.deriveStep('analyzing', 'EXPORT_START')).toBeNull();
    // And the landing states stay clean: from ready, CLEAR still resets.
    expect(main.deriveStep('ready', 'CLEAR')).toBe('gate');
  });
});

describe('mountApp (v1.10.0): the editor mounts at READY — analysis merges, never mounts', () => {
  /** Save/restore the two globals mountApp reads in node. */
  const saved = {};

  function armGlobals(fakeView) {
    saved.isSecureContext = globalThis.isSecureContext;
    saved.window = globalThis.window;
    globalThis.isSecureContext = true;
    globalThis.window = fakeView;
  }

  function restoreGlobals() {
    if ('isSecureContext' in saved) {
      if (saved.isSecureContext === undefined) delete globalThis.isSecureContext;
      else globalThis.isSecureContext = saved.isSecureContext;
    }
    if ('window' in saved) {
      if (saved.window === undefined) delete globalThis.window;
      else globalThis.window = saved.window;
    }
  }

  /** Inert editor handle for seam fakes that must not throw. */
  const inertHandle = () => ({
    destroy() {},
    refresh() {},
    redraw() {},
    getGestureState: () => ({ dragging: false, pinRemainingMs: 0 }),
  });

  async function openFile(fakeDoc) {
    fakeDoc.getElementById('file-input').dispatch('change');
    await flushApp();
  }

  it('file-open mounts the editor at ready with 0 tracks; export stays gated pre-analyze', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const mounts = [];
      await main.mountApp(fakeDoc, {
        mountEditor: (els, hooks) => {
          mounts.push({ els, hooks });
          return inertHandle();
        },
      });
      await openFile(fakeDoc);

      // The mount happened ONCE, at READY — before any analyze.
      expect(mounts).toHaveLength(1);
      // The shared DOM handles are wired through.
      expect(mounts[0].els.video).toBe(fakeDoc.getElementById('preview-video'));
      expect(mounts[0].els.timeline).toBe(fakeDoc.getElementById('timeline'));
      expect(mounts[0].els.chipsContainer).toBe(fakeDoc.getElementById('track-chips'));
      expect(mounts[0].els.playhead).toBe(fakeDoc.getElementById('playhead'));
      // The editor reads the live state: 0 tracks + the meta duration.
      const st = mounts[0].hooks.getState();
      expect(st.tracks).toEqual([]);
      expect(st.duration).toBe(FAKE_META.duration);
      // Ready state: analyze offered, export still gated (post-analyze only).
      expect(fakeDoc.getElementById('analyze-button').textContent).toBe('Analyze');
      expect(fakeDoc.getElementById('export-button').disabled).toBe(true);
    } finally {
      restoreGlobals();
    }
  });

  it('v1.12.0 REQ-122: Space toggles playback at ready; ←/→ seek ±5 s, Shift+←/→ frame-step', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => null });
      await openFile(fakeDoc);
      const video = fakeDoc.getElementById('preview-video');
      video.paused = true;
      video.playsPlayed = 0;

      const prevented = [];
      fakeDoc.__dispatch('keydown', {
        key: ' ',
        target: null,
        preventDefault: () => prevented.push('space'),
      });
      expect(prevented).toEqual(['space']);
      expect(video.playsPlayed).toBe(1);
      expect(video.paused).toBe(false);

      // ←/→ are now a ±5 s SEEK (REQ-122), legal wherever Space is — at
      // ready too. The fake video's duration is NaN → the cap is open-ended.
      video.currentTime = 2;
      const arrowPrevented = [];
      fakeDoc.__dispatch('keydown', {
        key: 'ArrowRight',
        target: null,
        preventDefault: () => arrowPrevented.push('arrow'),
      });
      expect(arrowPrevented).toEqual(['arrow']);
      expect(video.currentTime).toBe(7); // 2 + 5

      // Shift+←/→ carry the OLD ±1-frame semantics (fps 30 from FAKE_META).
      fakeDoc.__dispatch('keydown', {
        key: 'ArrowRight',
        shiftKey: true,
        target: null,
        preventDefault: () => {},
      });
      expect(video.currentTime).toBeCloseTo(7 + 1 / 30, 10);
      fakeDoc.__dispatch('keydown', {
        key: 'ArrowLeft',
        shiftKey: true,
        target: null,
        preventDefault: () => {},
      });
      expect(video.currentTime).toBeCloseTo(7, 10);

      // ← seeks back 5 s; a seek never pauses (unlike the frame step).
      fakeDoc.__dispatch('keydown', {
        key: 'ArrowLeft',
        target: null,
        preventDefault: () => {},
      });
      expect(video.currentTime).toBeCloseTo(2, 10);
    } finally {
      restoreGlobals();
    }
  });

  it('v1.12.0 REQ-122: F toggles the enlarged preview, M toggles mute (at ready)', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => null });
      await openFile(fakeDoc);
      const video = fakeDoc.getElementById('preview-video');
      const stage = fakeDoc.getElementById('preview-stage');

      // M toggles video.muted (the glyph sync rides volumechange — not fired
      // by the fake, the muted STATE is the contract here).
      video.muted = false;
      fakeDoc.__dispatch('keydown', { key: 'm', target: null, preventDefault: () => {} });
      expect(video.muted).toBe(true);
      fakeDoc.__dispatch('keydown', { key: 'M', target: null, preventDefault: () => {} });
      expect(video.muted).toBe(false);

      // F enters the in-page zoom fallback (the fake stage has no
      // requestFullscreen) and F again leaves it — the SAME path as ⛶.
      fakeDoc.__dispatch('keydown', { key: 'f', target: null, preventDefault: () => {} });
      expect(stage.classList.contains('preview-zoom')).toBe(true);
      fakeDoc.__dispatch('keydown', { key: 'F', target: null, preventDefault: () => {} });
      expect(stage.classList.contains('preview-zoom')).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  it('manual boxes drawn pre-analyze SURVIVE analysis (merge in the live editor, no remount)', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const mounts = [];
      await main.mountApp(fakeDoc, {
        mountEditor: (els, hooks) => {
          mounts.push({ els, hooks });
          return inertHandle();
        },
      });
      // The pass returns FRESH auto tracks whose id space collides with the
      // manual region the user drew first (tracker ids restart at 1).
      runAnalyzeMock.mockResolvedValueOnce({
        tracks: [autoTrack(1), autoTrack(2)],
        frameCount: 24,
        effectiveEp: 'webgpu',
        cancelled: false,
      });
      await openFile(fakeDoc);
      expect(mounts).toHaveLength(1); // the ready mount

      // Draw a manual region PRE-analyze through the live editor's hooks.
      mounts[0].hooks.onManualBox({ x: 4, y: 4, w: 8, h: 8 }, 1.25);
      let st = mounts[0].hooks.getState();
      expect(st.tracks).toHaveLength(1);
      expect(st.tracks[0]).toMatchObject({ id: 1, source: 'manual', label: 'Manual #1' });

      fakeDoc.getElementById('analyze-button').dispatch('click');
      await flushApp();

      // NO remount on completion — the ready editor was refreshed in place.
      expect(mounts).toHaveLength(1);
      expect(fakeDoc.getElementById('analyze-button').textContent).toBe('Re-analyze');
      // MERGE: manual first, then the analyzed autos; ids collision-free.
      st = mounts[0].hooks.getState();
      expect(st.tracks.map((t) => t.source)).toEqual(['manual', 'auto', 'auto']);
      const ids = st.tracks.map((t) => t.id);
      expect(ids[0]).toBe(1); // the pre-analyze manual region kept its id
      expect(new Set(ids).size).toBe(ids.length);
      // The counter advanced past the merge — another box cannot collide.
      mounts[0].hooks.onManualBox({ x: 0, y: 0, w: 2, h: 2 }, 0.5);
      st = mounts[0].hooks.getState();
      const ids2 = st.tracks.map((t) => t.id);
      expect(new Set(ids2).size).toBe(ids2.length);
      expect(st.tracks[st.tracks.length - 1]).toMatchObject({
        source: 'manual',
        label: 'Manual #4',
      });
    } finally {
      restoreGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// v1.12.0 — pure models for the new controls (REQ-117/118/119/120/124)
// ---------------------------------------------------------------------------

describe('main-wiring: rail width model (v1.12.0 REQ-118)', () => {
  it('clampRailWidth bounds the split to 240–480 and rounds', () => {
    expect(main.clampRailWidth(320)).toBe(320);
    expect(main.clampRailWidth(200)).toBe(240);
    expect(main.clampRailWidth(-5)).toBe(240);
    expect(main.clampRailWidth(1000)).toBe(480);
    expect(main.clampRailWidth(300.7)).toBe(301);
  });

  it('clampRailWidth degrades non-finite input to the default 320', () => {
    expect(main.clampRailWidth(NaN)).toBe(320);
    expect(main.clampRailWidth(Infinity)).toBe(320);
    expect(main.clampRailWidth(-Infinity)).toBe(320);
    expect(main.clampRailWidth(undefined)).toBe(320);
  });

  it('nextRailWidth steps ±24 px inside the clamp', () => {
    expect(main.nextRailWidth(320, 24)).toBe(344);
    expect(main.nextRailWidth(320, -24)).toBe(296);
    expect(main.nextRailWidth(480, 24)).toBe(480); // upper bound holds
    expect(main.nextRailWidth(240, -24)).toBe(240); // lower bound holds
    expect(main.nextRailWidth(NaN, 24)).toBe(344); // default 320 + step
    expect(main.nextRailWidth(320, NaN)).toBe(320); // dead step
  });

  it('dragRailWidth pins the direction: the rail LEFT edge follows the pointer (pointer RIGHT = narrower rail)', () => {
    expect(main.dragRailWidth(300, 420, 320)).toBe(200); // right = narrower (v1.14.0 fix)
    expect(main.dragRailWidth(300, 250, 320)).toBe(370); // left = wider
    // Degradations: non-finite pointer coords → no movement; bad start → default.
    expect(main.dragRailWidth(NaN, 420, 320)).toBe(320);
    expect(main.dragRailWidth(300, NaN, 320)).toBe(320);
    expect(main.dragRailWidth(300, 420, NaN)).toBe(200); // default 320 - 120
  });

  it('dragIntakeWidth pins the direction: the intake RIGHT edge follows the pointer (pointer RIGHT = wider panel)', () => {
    expect(main.dragIntakeWidth(300, 420, 320)).toBe(440);
    expect(main.dragIntakeWidth(300, 250, 320)).toBe(270); // left = narrower
    expect(main.dragIntakeWidth(NaN, 420, 320)).toBe(320);
    expect(main.dragIntakeWidth(300, NaN, 320)).toBe(320);
  });
});

describe('main-wiring: theme model (v1.12.0 REQ-124)', () => {
  it('themeGlyph shows the CURRENT theme icon: ☀️ dark, 🌙 light', () => {
    expect(main.themeGlyph('dark')).toBe('☀️');
    expect(main.themeGlyph('light')).toBe('🌙');
    // Unknown/absent = dark default.
    expect(main.themeGlyph(null)).toBe('☀️');
    expect(main.themeGlyph(undefined)).toBe('☀️');
  });

  it('nextTheme toggles dark ↔ light (unknown degrades to dark → light)', () => {
    expect(main.nextTheme('dark')).toBe('light');
    expect(main.nextTheme('light')).toBe('dark');
    expect(main.nextTheme(null)).toBe('light');
    expect(main.nextTheme('bogus')).toBe('light');
  });

  it('loadTheme accepts only stored light/dark and never throws', () => {
    expect(main.loadTheme({ getItem: () => 'light' })).toBe('light');
    expect(main.loadTheme({ getItem: () => 'dark' })).toBe('dark');
    expect(main.loadTheme({ getItem: () => 'blue' })).toBeNull();
    expect(main.loadTheme({ getItem: () => null })).toBeNull();
    expect(main.loadTheme({ getItem: () => { throw new Error('denied'); } })).toBeNull();
    expect(main.loadTheme(null)).toBeNull();
    expect(main.loadTheme({})).toBeNull(); // no getItem
  });

  it('saveTheme persists under the canonical key and reports failures', () => {
    const writes = [];
    expect(main.saveTheme({ setItem: (k, v) => writes.push([k, v]) }, 'light')).toBe(true);
    expect(writes).toEqual([['video-redact-theme', 'light']]);
    expect(main.saveTheme({ setItem: (k, v) => writes.push([k, v]) }, 'dark')).toBe(true);
    expect(writes[1]).toEqual(['video-redact-theme', 'dark']);
    expect(writes[1][0]).toBe(main.THEME_STORAGE_KEY);
    // Failures degrade to false — never throw.
    expect(main.saveTheme({ setItem: () => { throw new Error('quota'); } }, 'light')).toBe(false);
    expect(main.saveTheme(null, 'light')).toBe(false);
    expect(main.saveTheme({}, 'light')).toBe(false);
  });
});

describe('main-wiring: file-info view model (v1.12.0 REQ-119)', () => {
  it('formatFileDate renders a locale string and nulls invalid timestamps', () => {
    const shown = main.formatFileDate(Date.UTC(2026, 0, 15, 12, 0, 0));
    expect(typeof shown).toBe('string');
    expect(shown.length).toBeGreaterThan(0);
    expect(main.formatFileDate(0)).toBeNull();
    expect(main.formatFileDate(-5)).toBeNull();
    expect(main.formatFileDate(NaN)).toBeNull();
    expect(main.formatFileDate(undefined)).toBeNull();
  });

  it('fileInfoRows renders name/size/modified/type with the container fallback', () => {
    const lastModified = Date.UTC(2026, 0, 15, 12, 0, 0);
    const rows = main.fileInfoRows(
      { name: 'clip.mp4', size: 2048, lastModified, type: 'video/mp4' },
      { container: 'mp4' },
    );
    expect(rows.map((r) => r.label)).toEqual(['Name', 'Size', 'Modified', 'Type']);
    expect(rows[0].value).toBe('clip.mp4');
    expect(rows[1].value).toBe('2.0 KB');
    expect(rows[2].value).toBe(main.formatFileDate(lastModified));
    expect(rows[3].value).toBe('video/mp4');

    // No MIME type → the meta container answers the Type row.
    const fallback = main.fileInfoRows({ name: 'x.mkv', size: 1 }, { container: 'mkv' });
    expect(fallback.find((r) => r.label === 'Type').value).toBe('mkv');
    // Missing lastModified → the row is omitted, never an invented date.
    const noDate = main.fileInfoRows({ name: 'x.mp4', size: 1 }, null);
    expect(noDate.map((r) => r.label)).toEqual(['Name', 'Size', 'Type']);
    expect(noDate.find((r) => r.label === 'Type').value).toBe('unknown');
  });

  it('fileInfoRows returns null for a missing file (block stays hidden)', () => {
    expect(main.fileInfoRows(null, null)).toBeNull();
    expect(main.fileInfoRows(undefined, { container: 'mp4' })).toBeNull();
    expect(main.fileInfoRows('not-an-object', null)).toBeNull();
  });
});

describe('main-wiring: size filter + downscale models (v1.12.0 REQ-120/117)', () => {
  it('sizeFilterState: a valid data-size click wins; invalid keeps current; both invalid → 0', () => {
    expect(main.sizeFilterState(0, 48)).toBe(48);
    expect(main.sizeFilterState(24, 96)).toBe(96);
    expect(main.sizeFilterState(24, 99)).toBe(24); // not a group value
    expect(main.sizeFilterState(24, NaN)).toBe(24);
    expect(main.sizeFilterState(NaN, NaN)).toBe(0); // full degrade → Any
    expect(main.sizeFilterState(undefined, 96)).toBe(96);
  });

  it('sizeFilterPressed maps the selection onto exactly one pressed button', () => {
    expect(main.sizeFilterPressed(0)).toEqual([true, false, false, false]);
    expect(main.sizeFilterPressed(24)).toEqual([false, true, false, false]);
    expect(main.sizeFilterPressed(48)).toEqual([false, false, true, false]);
    expect(main.sizeFilterPressed(96)).toEqual([false, false, false, true]);
    expect(main.sizeFilterPressed(NaN)).toEqual([false, false, false, false]);
    expect(main.sizeFilterPressed(99)).toEqual([false, false, false, false]);
  });

  it('SIZE_FILTER_VALUES match the REQ-120 button order and data-size strings', () => {
    expect(main.SIZE_FILTER_VALUES).toEqual([0, 24, 48, 96]);
  });

  it('normalizeDownscale passes the legal options through and degrades to full', () => {
    expect(main.normalizeDownscale('full')).toBe('full');
    expect(main.normalizeDownscale('1080p')).toBe('1080p');
    expect(main.normalizeDownscale('720p')).toBe('720p');
    expect(main.normalizeDownscale('4k')).toBe('full');
    expect(main.normalizeDownscale('')).toBe('full');
    expect(main.normalizeDownscale(undefined)).toBe('full');
    expect(main.normalizeDownscale(null)).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// v1.12.0 — wiring integration through the REAL mountApp (fake DOM)
// ---------------------------------------------------------------------------

describe('mountApp (v1.12.0): theme, rail, size filter, cancel, file-info', () => {
  const saved = {};

  function armGlobals(fakeView) {
    saved.isSecureContext = globalThis.isSecureContext;
    saved.window = globalThis.window;
    globalThis.isSecureContext = true;
    globalThis.window = fakeView;
  }

  function restoreGlobals() {
    if ('isSecureContext' in saved) {
      if (saved.isSecureContext === undefined) delete globalThis.isSecureContext;
      else globalThis.isSecureContext = saved.isSecureContext;
    }
    if ('window' in saved) {
      if (saved.window === undefined) delete globalThis.window;
      else globalThis.window = saved.window;
    }
  }

  async function openFile(fakeDoc) {
    fakeDoc.getElementById('file-input').dispatch('change');
    await flushApp();
  }

  it('REQ-124: the toggle glyph follows the theme and swaps on click', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => null });
      const toggle = fakeDoc.getElementById('theme-toggle');
      expect(toggle.textContent).toBe('☀️'); // dark default
      expect(toggle.attrs['aria-pressed']).toBe('false');
      toggle.dispatch('click');
      expect(toggle.textContent).toBe('🌙');
      expect(toggle.attrs['aria-pressed']).toBe('true');
      toggle.dispatch('click');
      expect(toggle.textContent).toBe('☀️');
      expect(toggle.attrs['aria-pressed']).toBe('false');
    } finally {
      restoreGlobals();
    }
  });

  it('REQ-118: pointer drag / dblclick / Arrow keys drive --rail-w on #workspace', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => null });
      const handle = fakeDoc.getElementById('rail-resize');
      const workspace = fakeDoc.getElementById('workspace');
      // Initial application: the CSS var exists before any interaction.
      expect(workspace.style['--rail-w']).toBe('320px');

      handle.dispatch('pointerdown', {
        button: 0, clientX: 300, pointerId: 1, preventDefault: () => {},
      });
      handle.dispatch('pointermove', { clientX: 420, pointerId: 1 });
      expect(workspace.style['--rail-w']).toBe('240px'); // v1.14.0: right = narrower, floor-clamped at 240
      handle.dispatch('pointermove', { clientX: -100, pointerId: 1 });
      expect(workspace.style['--rail-w']).toBe('480px'); // far left = clamped wider
      handle.dispatch('pointerup', { pointerId: 1 });
      expect(workspace.style['--rail-w']).toBe('480px'); // final clamp holds

      handle.dispatch('dblclick');
      expect(workspace.style['--rail-w']).toBe('320px'); // reset

      handle.dispatch('keydown', {
        key: 'ArrowRight', preventDefault: () => {}, stopPropagation: () => {},
      });
      expect(workspace.style['--rail-w']).toBe('344px');
      handle.dispatch('keydown', {
        key: 'ArrowLeft', preventDefault: () => {}, stopPropagation: () => {},
      });
      expect(workspace.style['--rail-w']).toBe('320px');
    } finally {
      restoreGlobals();
    }
  });

  it('REQ-120/117: a size-filter click sets aria-pressed + minSizePx, and the analyze pass carries minSizePx + downscale', async () => {
    const { fakeDoc, fakeView, elsById } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      // Pre-seed the button group + select before mountApp wires them.
      const filter = makeFakeEl('DIV');
      const buttons = ['0', '24', '48', '96'].map((size) => {
        const btn = makeFakeEl('BUTTON');
        btn.setAttribute('data-size', size);
        return btn;
      });
      filter.querySelectorAll = () => buttons;
      elsById.set('size-filter', filter);
      const select = makeFakeEl('SELECT');
      elsById.set('downscale-select', select);

      await main.mountApp(fakeDoc, { mountEditor: () => null });
      // Defaults applied at mount: Any pressed, select shows 'full'.
      expect(buttons.map((b) => b.attrs['aria-pressed'])).toEqual(
        ['true', 'false', 'false', 'false'],
      );
      expect(select.value).toBe('full');

      select.value = '1080p';
      select.dispatch('change');
      buttons[2].dispatch('click'); // data-size "48"
      expect(buttons.map((b) => b.attrs['aria-pressed'])).toEqual(
        ['false', 'false', 'true', 'false'],
      );

      await openFile(fakeDoc);
      // Per-file reset: back to Any / Full (consistent with the panel).
      expect(buttons[2].attrs['aria-pressed']).toBe('false');
      expect(buttons[0].attrs['aria-pressed']).toBe('true');
      expect(select.value).toBe('full');

      // Re-apply, then run the pass: settings must carry both values.
      select.value = '720p';
      select.dispatch('change');
      buttons[1].dispatch('click'); // data-size "24"
      fakeDoc.getElementById('analyze-button').dispatch('click');
      await flushApp();

      const call = runAnalyzeMock.mock.calls.at(-1)?.[0];
      expect(call.settings.minSizePx).toBe(24);
      expect(call.settings.downscale).toBe('720p');
    } finally {
      restoreGlobals();
    }
  });

  it('REQ-115: the cancel control reads "Stop analysis", enabled while analyzing', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => null });
      const cancel = fakeDoc.getElementById('analyze-cancel');
      // Not analyzing: hidden and disabled.
      expect(cancel.hidden).toBe(true);
      expect(cancel.disabled).toBe(true);

      runAnalyzeMock.mockReturnValueOnce(new Promise(() => {})); // pending pass
      await openFile(fakeDoc);
      fakeDoc.getElementById('analyze-button').dispatch('click');
      await flushApp();

      expect(cancel.hidden).toBe(false);
      expect(cancel.disabled).toBe(false);
      expect(cancel.textContent).toBe('Stop analysis');
    } finally {
      restoreGlobals();
    }
  });

  it('REQ-119: #file-info renders from the File on open and hides on Clear', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => null });
      const info = fakeDoc.getElementById('file-info');
      expect(info.hidden).toBe(true);

      await openFile(fakeDoc);
      expect(info.hidden).toBe(false);
      // The fake File is a 3-byte mp4 Blob named clip.mp4 (no lastModified —
      // the Modified row is omitted, never an invented date). Label/value
      // spans land FLAT in the two-column grid (index.html contract).
      const byLabel = {};
      for (let i = 0; i + 1 < info.children.length; i += 2) {
        byLabel[info.children[i].textContent] = info.children[i + 1].textContent;
      }
      expect(byLabel.Name).toBe('clip.mp4');
      expect(byLabel.Size).toBe('3 B');
      expect(byLabel.Type).toBe('video/mp4');

      fakeDoc.getElementById('clear-file').dispatch('click');
      expect(info.hidden).toBe(true);
      expect(info.children).toHaveLength(0);
    } finally {
      restoreGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// v1.13.0 — bulk track style (#bulk-solid / #bulk-pixelate): the pure model
// plus the real wiring through the fake-DOM mountApp harness.
// ---------------------------------------------------------------------------

describe('main-wiring: setAllTrackStyles (v1.13.0 bulk restyle model)', () => {
  it('returns a NEW array with every track flipped to solid / pixelate', () => {
    const tracks = [manualTrack(1), autoTrack(2)];
    const solid = main.setAllTrackStyles(tracks, 'solid');
    expect(solid).not.toBe(tracks); // new array
    expect(solid.map((t) => t.style)).toEqual(['solid', 'solid']);
    expect(solid.map((t) => t.id)).toEqual([1, 2]);
    const pixelate = main.setAllTrackStyles(tracks, 'pixelate');
    expect(pixelate.map((t) => t.style)).toEqual(['pixelate', 'pixelate']);
  });

  it('is non-mutating: input array and track objects stay untouched', () => {
    const tracks = [manualTrack(1, { style: 'pixelate' }), autoTrack(2)];
    const snapshot = tracks.map((t) => ({ ...t, keyframes: new Map(t.keyframes) }));
    const out = main.setAllTrackStyles(tracks, 'solid');
    expect(tracks.map((t) => ({ ...t, keyframes: new Map(t.keyframes) }))).toEqual(snapshot);
    // The changed tracks are copies — the originals keep their identity.
    expect(out[0]).not.toBe(tracks[0]);
    expect(tracks[0].style).toBe('pixelate');
    expect(tracks[1].style).toBe('pixelate');
  });

  it('mixed manual + auto tracks ALL get the style (style-blind bulk action)', () => {
    const tracks = [
      manualTrack(1, { style: 'pixelate' }),
      autoTrack(2, { style: 'solid' }),
      manualTrack(3, { style: 'pixelate', enabled: false }),
    ];
    const out = main.setAllTrackStyles(tracks, 'pixelate');
    expect(out).toHaveLength(3);
    expect(out.every((t) => t.style === 'pixelate')).toBe(true);
    // Everything except the style survives verbatim.
    expect(out[2].enabled).toBe(false);
    expect(out.map((t) => t.source)).toEqual(['manual', 'auto', 'manual']);
  });

  it('invalid style → unchanged content (still a new array, originals shared)', () => {
    const tracks = [manualTrack(1, { style: 'solid' }), autoTrack(2, { style: 'pixelate' })];
    const out = main.setAllTrackStyles(tracks, 'blur');
    expect(out).not.toBe(tracks);
    expect(out[0]).toBe(tracks[0]); // untouched object identity
    expect(out[1]).toBe(tracks[1]);
    expect(out.map((t) => t.style)).toEqual(['solid', 'pixelate']);
    // Degenerate inputs degrade to empty, never throw.
    expect(main.setAllTrackStyles([], 'solid')).toEqual([]);
    expect(main.setAllTrackStyles(null, 'solid')).toEqual([]);
    expect(main.setAllTrackStyles(undefined, 'pixelate')).toEqual([]);
  });
});

describe('mountApp (v1.13.0): #bulk-solid / #bulk-pixelate wiring', () => {
  const saved = {};

  function armGlobals(fakeView) {
    saved.isSecureContext = globalThis.isSecureContext;
    saved.window = globalThis.window;
    globalThis.isSecureContext = true;
    globalThis.window = fakeView;
  }

  function restoreGlobals() {
    if ('isSecureContext' in saved) {
      if (saved.isSecureContext === undefined) delete globalThis.isSecureContext;
      else globalThis.isSecureContext = saved.isSecureContext;
    }
    if ('window' in saved) {
      if (saved.window === undefined) delete globalThis.window;
      else globalThis.window = saved.window;
    }
  }

  async function openFile(fakeDoc) {
    fakeDoc.getElementById('file-input').dispatch('change');
    await flushApp();
  }

  /** Editor handle that counts refresh() calls (the bulk click must refresh). */
  function refreshCountingHandle(refreshes) {
    return {
      destroy() {},
      refresh: () => {
        refreshes.push('refresh');
      },
      redraw() {},
      getGestureState: () => ({ dragging: false, pinRemainingMs: 0 }),
    };
  }

  it('#bulk-solid click → every track style becomes solid + editor refresh', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      let hooks = null;
      await main.mountApp(fakeDoc, {
        mountEditor: (_els, editorHooks) => {
          hooks = editorHooks;
          return refreshCountingHandle(refreshes);
        },
      });
      await openFile(fakeDoc);
      hooks.onManualBox({ x: 1, y: 1, w: 4, h: 4 }, 1); // solid (manual default)
      hooks.onManualBox({ x: 2, y: 2, w: 4, h: 4 }, 2);
      hooks.onSetStyle(1, 'pixelate'); // make the starting styles mixed
      const before = hooks.getState().tracks;
      expect(before.map((t) => t.style)).toEqual(['pixelate', 'solid']);

      const solidBtn = fakeDoc.getElementById('bulk-solid');
      solidBtn.dispatch('click');
      const st = hooks.getState();
      expect(st.tracks).toHaveLength(2);
      expect(st.tracks.every((t) => t.style === 'solid')).toBe(true);
      expect(refreshes.length).toBeGreaterThanOrEqual(1);
      expect(solidBtn.disabled).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  it('#bulk-pixelate click → every track style becomes pixelate + editor refresh', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      let hooks = null;
      await main.mountApp(fakeDoc, {
        mountEditor: (_els, editorHooks) => {
          hooks = editorHooks;
          return refreshCountingHandle(refreshes);
        },
      });
      await openFile(fakeDoc);
      hooks.onManualBox({ x: 1, y: 1, w: 4, h: 4 }, 1); // solid (manual default)
      const pixelateBtn = fakeDoc.getElementById('bulk-pixelate');
      pixelateBtn.dispatch('click');
      const st = hooks.getState();
      expect(st.tracks).toHaveLength(1);
      expect(st.tracks[0].style).toBe('pixelate');
      expect(refreshes.length).toBeGreaterThanOrEqual(1);
    } finally {
      restoreGlobals();
    }
  });

  it('#bulk-solid flips a MIXED manual/auto set (styles land on every track)', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      let hooks = null;
      await main.mountApp(fakeDoc, {
        mountEditor: (_els, editorHooks) => {
          hooks = editorHooks;
          return refreshCountingHandle(refreshes);
        },
      });
      await openFile(fakeDoc);
      hooks.onManualBox({ x: 1, y: 1, w: 4, h: 4 }, 1); // manual → solid
      runAnalyzeMock.mockResolvedValueOnce({
        tracks: [autoTrack(1, { style: 'pixelate' })], // id collides → re-issued
        frameCount: 4,
        effectiveEp: 'webgpu',
        cancelled: false,
      });
      fakeDoc.getElementById('analyze-button').dispatch('click');
      await flushApp();
      const before = hooks.getState().tracks;
      expect(before.map((t) => t.source)).toEqual(['manual', 'auto']);

      fakeDoc.getElementById('bulk-solid').dispatch('click');
      const st = hooks.getState();
      expect(st.tracks).toHaveLength(2);
      expect(st.tracks.every((t) => t.style === 'solid')).toBe(true);
    } finally {
      restoreGlobals();
    }
  });

  it('buttons are disabled with zero tracks and enable once a track exists', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      let hooks = null;
      await main.mountApp(fakeDoc, {
        mountEditor: (_els, editorHooks) => {
          hooks = editorHooks;
          return refreshCountingHandle(refreshes);
        },
      });
      const solidBtn = fakeDoc.getElementById('bulk-solid');
      const pixelateBtn = fakeDoc.getElementById('bulk-pixelate');
      // At the gate (0 tracks): disabled, never hidden.
      expect(solidBtn.disabled).toBe(true);
      expect(pixelateBtn.disabled).toBe(true);
      expect(solidBtn.hidden).toBe(false);

      await openFile(fakeDoc); // still 0 tracks at ready
      expect(solidBtn.disabled).toBe(true);

      hooks.onManualBox({ x: 1, y: 1, w: 4, h: 4 }, 1); // first track
      expect(solidBtn.disabled).toBe(false);
      expect(pixelateBtn.disabled).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  it('zero tracks + a forced click degrades to the "No tracks to restyle." toast', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      await main.mountApp(fakeDoc, {
        mountEditor: () => refreshCountingHandle(refreshes),
      });
      fakeDoc.getElementById('bulk-solid').dispatch('click');
      expect(toastTexts(fakeDoc)).toContain('No tracks to restyle.');
      expect(refreshes).toEqual([]); // no refresh without tracks
    } finally {
      restoreGlobals();
    }
  });

  it('blur-after-click is registered on both bulk buttons', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => refreshCountingHandle([]) });
      const blurred = [];
      for (const id of ['bulk-solid', 'bulk-pixelate']) {
        const btn = fakeDoc.getElementById(id);
        btn.blur = () => blurred.push(id);
      }
      fakeDoc.getElementById('bulk-solid').dispatch('click');
      fakeDoc.getElementById('bulk-pixelate').dispatch('click');
      expect(blurred).toEqual(['bulk-solid', 'bulk-pixelate']);
    } finally {
      restoreGlobals();
    }
  });
});


// ---------------------------------------------------------------------------
// v1.15.0 REQ-125/126 — trim mode toggle, trim hooks, resets
// ---------------------------------------------------------------------------

describe('mountApp (v1.15.0): #trim-toggle + trim hooks + resets', () => {
  const saved = {};

  function armGlobals(fakeView) {
    saved.isSecureContext = globalThis.isSecureContext;
    saved.window = globalThis.window;
    globalThis.isSecureContext = true;
    globalThis.window = fakeView;
  }

  function restoreGlobals() {
    if ('isSecureContext' in saved) {
      if (saved.isSecureContext === undefined) delete globalThis.isSecureContext;
      else globalThis.isSecureContext = saved.isSecureContext;
    }
    if ('window' in saved) {
      if (saved.window === undefined) delete globalThis.window;
      else globalThis.window = saved.window;
    }
  }

  async function openFile(fakeDoc) {
    fakeDoc.getElementById('file-input').dispatch('change');
    await flushApp();
  }

  function inertHandle(refreshes) {
    return {
      destroy() {},
      refresh: () => {
        refreshes.push('refresh');
      },
      redraw() {},
      getGestureState: () => ({ dragging: false, pinRemainingMs: 0 }),
    };
  }

  /** Mount + open the fixture file (the editor mounts on file-open — the
   * hooks do not exist before that), returning the captured editor hooks. */
  async function mountWithHooks(fakeDoc, refreshes) {
    let hooks = null;
    await main.mountApp(fakeDoc, {
      mountEditor: (_els, editorHooks) => {
        hooks = editorHooks;
        return inertHandle(refreshes);
      },
    });
    await openFile(fakeDoc);
    return hooks;
  }

  it('#trim-toggle flips trimMode + aria-pressed and refreshes the editor', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      await main.mountApp(fakeDoc, { mountEditor: () => inertHandle(refreshes) });
      const btn = fakeDoc.getElementById('trim-toggle');
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      await openFile(fakeDoc); // the editor mounts here — refreshes flow after
      const before = refreshes.length;

      btn.dispatch('click');
      expect(btn.getAttribute('aria-pressed')).toBe('true');
      expect(btn.classList.contains('trim-mode')).toBe(true);
      expect(refreshes.length).toBeGreaterThan(before);

      btn.dispatch('click');
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.classList.contains('trim-mode')).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  it('onTrimAdd inserts sorted regions through getState().trims and refreshes', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      const hooks = await mountWithHooks(fakeDoc, refreshes);
      // FAKE_META.duration = 4 — all fixtures stay inside it.
      hooks.onTrimAdd(3, 3.5);
      hooks.onTrimAdd(1, 2);
      const st = hooks.getState();
      // Ids follow ASSIGNMENT order (nextTrimId counter); the array is
      // sorted by start.
      expect(st.trims).toEqual([
        { id: 2, start: 1, end: 2 },
        { id: 1, start: 3, end: 3.5 },
      ]);
      expect(st.trimMode).toBe(false);
      expect(refreshes.length).toBeGreaterThanOrEqual(2);

      // Rejected (fully covered) insert: no region, no id bump.
      const before = refreshes.length;
      hooks.onTrimAdd(3.1, 3.3);
      expect(hooks.getState().trims).toHaveLength(2);
      hooks.onTrimAdd(0.5, 3.75); // would swallow region 2 → rejected
      expect(hooks.getState().trims).toHaveLength(2);
      hooks.onTrimAdd(2.5, 2.8); // next insert still gets id 3
      expect(hooks.getState().trims.find((r) => r.id === 3)).toEqual({ id: 3, start: 2.5, end: 2.8 });
      expect(refreshes.length).toBeGreaterThan(before);
    } finally {
      restoreGlobals();
    }
  });

  it('onTrimEdge moves edges through the clamped model (never past a neighbor)', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      const hooks = await mountWithHooks(fakeDoc, refreshes);
      hooks.onTrimAdd(3, 3.5);
      hooks.onTrimAdd(1, 2);

      // Assignment order: id 1 = [3, 3.5], id 2 = [1, 2].
      hooks.onTrimEdge(1, 'start', 0.5); // previous region (id 2) ends at 2 → clamps
      expect(hooks.getState().trims.find((r) => r.id === 1).start).toBe(2);
      hooks.onTrimEdge(1, 'end', 99); // clamps to the duration (4 s meta)
      expect(hooks.getState().trims.find((r) => r.id === 1).end).toBe(4);
    } finally {
      restoreGlobals();
    }
  });

  it('onTrimRemove drops the region (✕ / double-click path)', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      const hooks = await mountWithHooks(fakeDoc, refreshes);
      hooks.onTrimAdd(2, 4);
      hooks.onTrimRemove(1);
      expect(hooks.getState().trims).toEqual([]);
    } finally {
      restoreGlobals();
    }
  });

  it('Clear resets regions, trim mode and the toggle UI', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      const hooks = await mountWithHooks(fakeDoc, refreshes);
      hooks.onTrimAdd(2, 4);
      const btn = fakeDoc.getElementById('trim-toggle');
      btn.dispatch('click'); // trimMode on
      expect(hooks.getState().trimMode).toBe(true);
      expect(hooks.getState().trims).toHaveLength(1);

      fakeDoc.getElementById('clear-file').dispatch('click');
      const st = hooks.getState();
      expect(st.trims).toEqual([]);
      expect(st.trimMode).toBe(false);
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.classList.contains('trim-mode')).toBe(false);
    } finally {
      restoreGlobals();
    }
  });

  it('a fresh file load resets the trim state too', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const refreshes = [];
      const hooks = await mountWithHooks(fakeDoc, refreshes);
      hooks.onTrimAdd(2, 4);
      fakeDoc.getElementById('trim-toggle').dispatch('click');
      expect(hooks.getState().trims).toHaveLength(1);

      await openFile(fakeDoc); // re-open (the fresh AppState path)
      const st = hooks.getState();
      expect(st.trims).toEqual([]);
      expect(st.trimMode).toBe(false);
    } finally {
      restoreGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// v1.17.0 REQ-128 — describeCompareContext (compare status-line suffix)
// ---------------------------------------------------------------------------

describe('main-wiring: describeCompareContext (v1.17.0 REQ-128)', () => {
  it('joins every non-default setting in order: dashcam · min · downscale', () => {
    expect(
      main.describeCompareContext({ dashcamMode: true, minSizePx: 24, downscale: '720p' }),
    ).toBe('dashcam ON · min ≥24px · 720p');
  });

  it('omits off/default parts; nothing applies → empty string', () => {
    expect(main.describeCompareContext({})).toBe('');
    expect(main.describeCompareContext(null)).toBe('');
    expect(main.describeCompareContext(undefined)).toBe('');
    expect(
      main.describeCompareContext({ dashcamMode: false, minSizePx: 0, downscale: 'full' }),
    ).toBe('');
  });

  it('renders each part alone, rounds fractional min sizes, and guards junk', () => {
    expect(main.describeCompareContext({ dashcamMode: true })).toBe('dashcam ON');
    expect(main.describeCompareContext({ minSizePx: 48 })).toBe('min ≥48px');
    expect(main.describeCompareContext({ minSizePx: 24.4 })).toBe('min ≥24px');
    expect(main.describeCompareContext({ downscale: '1080p' })).toBe('1080p');
    // Invalid values never render a bogus threshold/preset.
    expect(main.describeCompareContext({ minSizePx: Number.NaN })).toBe('');
    expect(main.describeCompareContext({ minSizePx: 'bogus' })).toBe('');
    expect(main.describeCompareContext({ downscale: 'bogus' })).toBe(''); // → full
  });
});

// ---------------------------------------------------------------------------
// v1.17.0 REQ-129 — pixelation strength model (normalizePixelStrength /
// PIXEL_STRENGTH_VALUES / pixelStrengthPressed)
// ---------------------------------------------------------------------------

describe('main-wiring: normalizePixelStrength (v1.17.0 REQ-129)', () => {
  it('passes the four legal options through', () => {
    expect(main.normalizePixelStrength('fine')).toBe('fine');
    expect(main.normalizePixelStrength('normal')).toBe('normal');
    expect(main.normalizePixelStrength('coarse')).toBe('coarse');
    expect(main.normalizePixelStrength('max')).toBe('max');
  });

  it('degrades everything else to normal (missing attr, project junk, case)', () => {
    for (const v of [undefined, null, '', 'bogus', 'FINE', 2, {}]) {
      expect(main.normalizePixelStrength(v)).toBe('normal');
    }
  });

  it('PIXEL_STRENGTH_VALUES match the button order AND redact.PIXEL_STRENGTHS keys', () => {
    expect(main.PIXEL_STRENGTH_VALUES).toEqual(['fine', 'normal', 'coarse', 'max']);
    expect(main.PIXEL_STRENGTH_VALUES).toEqual(Object.keys(PIXEL_STRENGTHS));
  });

  it('pixelStrengthPressed maps the selection onto exactly one pressed button', () => {
    expect(main.pixelStrengthPressed('fine')).toEqual([true, false, false, false]);
    expect(main.pixelStrengthPressed('normal')).toEqual([false, true, false, false]);
    expect(main.pixelStrengthPressed('coarse')).toEqual([false, false, true, false]);
    expect(main.pixelStrengthPressed('max')).toEqual([false, false, false, true]);
    // Invalid → the normalized default ('normal') is pressed.
    expect(main.pixelStrengthPressed('bogus')).toEqual([false, true, false, false]);
  });
});

// ---------------------------------------------------------------------------
// v1.17.0 REQ-130 — project-load pure models (adoptTracks /
// clampTracksToDuration / videoBaseName)
// ---------------------------------------------------------------------------

describe('main-wiring: adoptTracks (v1.17.0 REQ-130 project load)', () => {
  const box = { x: 1, y: 2, w: 3, h: 4 };

  it('accepts unique-id tracks as-is; manualNextId lands past the max', () => {
    const a = { ...manualTrack(3), keyframes: new Map([[1, box]]) };
    const b = { ...autoTrack(7), keyframes: new Map([[1, box]]) };
    const { tracks, manualNextId } = main.adoptTracks([a, b]);
    expect(tracks).toEqual([a, b]);
    expect(manualNextId).toBe(8);
  });

  it('revives [seconds, box] keyframe pairs to a Map (the .vrproj JSON shape)', () => {
    const { tracks } = main.adoptTracks([
      { ...autoTrack(1), keyframes: [[0.5, box], [1.5, box]] },
    ]);
    expect(tracks[0].keyframes).toBeInstanceOf(Map);
    expect(tracks[0].keyframes.get(0.5)).toBe(box);
    expect(tracks[0].keyframes.get(1.5)).toBe(box);
  });

  it('disables keyframe-less enabled tracks (density invariant) instead of failing the preview closed', () => {
    const { tracks } = main.adoptTracks([{ ...autoTrack(1), enabled: true, keyframes: [] }]);
    expect(tracks[0].enabled).toBe(false);
    // A deliberately disabled track stays disabled (no flip back on).
    const { tracks: off } = main.adoptTracks([
      { ...autoTrack(2), enabled: false, keyframes: [] },
    ]);
    expect(off[0].enabled).toBe(false);
  });

  it('repairs duplicate ids past the max and guards degenerate inputs', () => {
    const { tracks, manualNextId } = main.adoptTracks([manualTrack(2), manualTrack(2)]);
    const ids = tracks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(2);
    expect(ids.filter((id) => id !== 2)[0]).toBeGreaterThan(2);
    expect(manualNextId).toBe(Math.max(...ids) + 1);
    expect(main.adoptTracks(null)).toEqual({ tracks: [], manualNextId: 1 });
    expect(main.adoptTracks('nope')).toEqual({ tracks: [], manualNextId: 1 });
  });
});

describe('main-wiring: clampTracksToDuration (v1.17.0 REQ-130 project load)', () => {
  const box = { x: 0, y: 0, w: 2, h: 2 };

  it('clamps the span end, drops keyframes beyond the duration, and counts the edit', () => {
    const track = {
      ...autoTrack(1),
      start: 1,
      end: 6,
      keyframes: new Map([[1, box], [2, box], [5, box]]),
    };
    const { tracks, clamped } = main.clampTracksToDuration([track], 4);
    expect(tracks[0].end).toBe(4);
    expect([...tracks[0].keyframes.keys()]).toEqual([1, 2]); // 5 > 4 → dropped
    expect(clamped).toBe(1);
  });

  it('drops tracks entirely past the duration; untouched tracks keep their identity', () => {
    const inside = {
      ...autoTrack(1),
      start: 0.5,
      end: 2,
      keyframes: new Map([[1, box]]),
    };
    const { tracks, clamped } = main.clampTracksToDuration(
      [inside, { ...inside, id: 2, start: 9, end: 10 }],
      4,
    );
    expect(tracks.map((t) => t.id)).toEqual([1]);
    expect(tracks[0]).toBe(inside);
    expect(clamped).toBe(1); // the dropped one
  });

  it('guards degenerate input: non-finite duration → untouched; invalid spans pass through', () => {
    const tracks = [{ ...autoTrack(1), start: 1, end: 6, keyframes: new Map() }];
    const out = main.clampTracksToDuration(tracks, Number.NaN);
    expect(out.tracks).toEqual(tracks);
    expect(out.clamped).toBe(0);
    expect(main.clampTracksToDuration(null, 4)).toEqual({ tracks: [], clamped: 0 });
    const weird = { ...autoTrack(3), start: 'x', end: 'y', keyframes: new Map() };
    const r = main.clampTracksToDuration([weird], 2);
    expect(r.tracks).toEqual([weird]);
    expect(r.clamped).toBe(0);
  });
});

describe('main-wiring: videoBaseName (v1.17.0 REQ-130 download name)', () => {
  it('strips the extension; keeps multi-dot stems; degrades safely', () => {
    expect(main.videoBaseName('clip.mp4')).toBe('clip');
    expect(main.videoBaseName('my.video.take3.mov')).toBe('my.video.take3');
    expect(main.videoBaseName('noext')).toBe('noext');
    expect(main.videoBaseName('.mp4')).toBe('.mp4'); // all-extension name kept whole
    expect(main.videoBaseName('')).toBe('video');
    expect(main.videoBaseName(undefined)).toBe('video');
  });
});

// ---------------------------------------------------------------------------
// v1.17.0 — mountApp wiring through the fake DOM (REQ-129 strength clicks,
// REQ-130 project save/load)
// ---------------------------------------------------------------------------

describe('mountApp (v1.17.0): #pixel-strength wiring + strength in the seams', () => {
  const saved = {};

  function armGlobals(fakeView) {
    saved.isSecureContext = globalThis.isSecureContext;
    saved.window = globalThis.window;
    globalThis.isSecureContext = true;
    globalThis.window = fakeView;
  }

  function restoreGlobals() {
    if ('isSecureContext' in saved) {
      if (saved.isSecureContext === undefined) delete globalThis.isSecureContext;
      else globalThis.isSecureContext = saved.isSecureContext;
    }
    if ('window' in saved) {
      if (saved.window === undefined) delete globalThis.window;
      else globalThis.window = saved.window;
    }
  }

  async function openFile(fakeDoc) {
    fakeDoc.getElementById('file-input').dispatch('change');
    await flushApp();
  }

  /** Seed the #pixel-strength group with its four .strength-btn buttons. */
  function seedStrengthGroup(elsById) {
    const group = makeFakeEl('DIV');
    const buttons = ['fine', 'normal', 'coarse', 'max'].map((s) => {
      const b = makeFakeEl('BUTTON');
      b.setAttribute('data-strength', s);
      b.classList.add('strength-btn');
      return b;
    });
    group.querySelectorAll = () => buttons;
    elsById.set('pixel-strength', group);
    return { group, buttons };
  }

  function hooksHandle(refreshes, sink) {
    return (_els, editorHooks) => {
      sink.hooks = editorHooks;
      return {
        destroy() {},
        refresh: () => refreshes.push('refresh'),
        redraw() {},
        getGestureState: () => ({ dragging: false, pinRemainingMs: 0 }),
      };
    };
  }

  it('REQ-129: a strength click sets the normalized setting, swaps aria-pressed, refreshes the editor', async () => {
    const { fakeDoc, fakeView, elsById } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const { group, buttons } = seedStrengthGroup(elsById);
      const refreshes = [];
      const sink = {};
      await main.mountApp(fakeDoc, { mountEditor: hooksHandle(refreshes, sink) });
      await openFile(fakeDoc); // the editor (and its hooks) mounts at ready

      // Mount default: 'normal' pressed (the shipped default), state normal.
      expect(buttons.map((b) => b.attrs['aria-pressed'])).toEqual(
        ['false', 'true', 'false', 'false'],
      );
      expect(sink.hooks.getState().pixelStrength).toBe('normal');

      group.dispatch('click', { target: buttons[3] }); // data-strength="max"
      expect(buttons.map((b) => b.attrs['aria-pressed'])).toEqual(
        ['false', 'false', 'false', 'true'],
      );
      expect(sink.hooks.getState().pixelStrength).toBe('max');
      expect(refreshes.length).toBeGreaterThanOrEqual(1); // preview re-render

      // A click on a non-button target is a no-op; an invalid data-strength
      // degrades to 'normal' (button states still swapped).
      group.dispatch('click', { target: { closest: () => null } });
      expect(sink.hooks.getState().pixelStrength).toBe('max');
      buttons[2].setAttribute('data-strength', 'bogus');
      group.dispatch('click', { target: buttons[2] });
      expect(sink.hooks.getState().pixelStrength).toBe('normal');
      expect(buttons.map((b) => b.attrs['aria-pressed'])).toEqual(
        ['false', 'true', 'false', 'false'],
      );
    } finally {
      restoreGlobals();
    }
  });

  it('REQ-129: the strength resets to normal on file load and on Clear', async () => {
    const { fakeDoc, fakeView, elsById } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const { group, buttons } = seedStrengthGroup(elsById);
      const sink = {};
      await main.mountApp(fakeDoc, { mountEditor: hooksHandle([], sink) });
      await openFile(fakeDoc); // hooks live from ready
      group.dispatch('click', { target: buttons[3] }); // max
      expect(sink.hooks.getState().pixelStrength).toBe('max');

      await openFile(fakeDoc); // per-file reset
      expect(sink.hooks.getState().pixelStrength).toBe('normal');
      expect(buttons.map((b) => b.attrs['aria-pressed'])).toEqual(
        ['false', 'true', 'false', 'false'],
      );

      group.dispatch('click', { target: buttons[2] }); // coarse
      fakeDoc.getElementById('clear-file').dispatch('click');
      expect(sink.hooks.getState().pixelStrength).toBe('normal');
    } finally {
      restoreGlobals();
    }
  });

  it('REQ-129: getState().pixelStrength is what editor.drawPreview passes into pixelateFrame', async () => {
    const { fakeDoc, fakeView, elsById } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const { group, buttons } = seedStrengthGroup(elsById);
      const sink = {};
      await main.mountApp(fakeDoc, { mountEditor: hooksHandle([], sink) });
      await openFile(fakeDoc);
      group.dispatch('click', { target: buttons[2] }); // coarse
      expect(sink.hooks.getState().pixelStrength).toBe('coarse');

      // drawPreview (no DOM here) — the source wires the shared seam with the
      // state value, so preview and export resolve the same block sizes.
      const editorSrc = readFileSync(join(ROOT, 'src', 'editor.js'), 'utf8');
      expect(editorSrc).toContain('strength: state.pixelStrength');
    } finally {
      restoreGlobals();
    }
  });

  it('REQ-129: startExport carries settings.pixelStrength into runExport', async () => {
    const { fakeDoc, fakeView, elsById } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const { group, buttons } = seedStrengthGroup(elsById);
      await main.mountApp(fakeDoc, { mountEditor: () => null });
      await openFile(fakeDoc);
      group.dispatch('click', { target: buttons[2] }); // coarse
      fakeDoc.getElementById('analyze-button').dispatch('click');
      await flushApp(); // → review
      fakeDoc.getElementById('export-button').dispatch('click');
      await flushApp();

      expect(runExportMock).toHaveBeenCalledTimes(1);
      const call = runExportMock.mock.calls[0][0];
      expect(call.settings.pixelStrength).toBe('coarse');
    } finally {
      restoreGlobals();
    }
  });
});

describe('mountApp (v1.17.0): project save/load (REQ-130)', () => {
  const saved = {};

  function armGlobals(fakeView) {
    saved.isSecureContext = globalThis.isSecureContext;
    saved.window = globalThis.window;
    globalThis.isSecureContext = true;
    globalThis.window = fakeView;
  }

  function restoreGlobals() {
    if ('isSecureContext' in saved) {
      if (saved.isSecureContext === undefined) delete globalThis.isSecureContext;
      else globalThis.isSecureContext = saved.isSecureContext;
    }
    if ('window' in saved) {
      if (saved.window === undefined) delete globalThis.window;
      else globalThis.window = saved.window;
    }
  }

  async function openFile(fakeDoc) {
    fakeDoc.getElementById('file-input').dispatch('change');
    await flushApp();
  }

  function hooksHandle(refreshes, sink) {
    return (_els, editorHooks) => {
      sink.hooks = editorHooks;
      return {
        destroy() {},
        refresh: () => refreshes.push('refresh'),
        redraw() {},
        getGestureState: () => ({ dragging: false, pinRemainingMs: 0 }),
      };
    };
  }

  /** Build a real .vrproj body through the real serializeProject contract. */
  function projectJson(overrides = {}) {
    const box = { x: 1, y: 1, w: 8, h: 8 };
    return JSON.stringify({
      version: '1',
      settings: {
        pixelStrength: 'coarse',
        downscale: '720p',
        minSizePx: 48,
        dashcamMode: true,
        ...overrides.settings,
      },
      trims: [{ id: 1, start: 1, end: 2 }],
      tracks: [
        {
          id: 5,
          cls: 'manual',
          label: 'Manual #5',
          color: '#A78BFA',
          start: 0.5,
          end: 99, // deliberately past the fixture duration (4 s) → clamped
          enabled: true,
          source: 'manual',
          style: 'solid',
          keyframes: [[0.5, box], [3, box]],
        },
      ],
      meta: { videoName: 'clip.mp4', videoSize: 3, videoLastModified: 0 },
      ...overrides.top,
    });
  }

  async function loadProject(fakeDoc, json) {
    const loadInput = fakeDoc.getElementById('project-load-input');
    loadInput.files = [new Blob([json], { type: 'application/json' })];
    loadInput.dispatch('change');
    await flushApp();
  }

  it('#project-save: disabled until a file loads; serializes the payload and downloads <video>.vrproj', async () => {
    const { fakeDoc, fakeView, elsById, createdEls } = makeFakeEnv();
    armGlobals(fakeView);
    const createdUrls = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      createdUrls.push(blob);
      return 'blob:vrproj';
    };
    URL.revokeObjectURL = () => {};
    try {
      const sink = {};
      await main.mountApp(fakeDoc, { mountEditor: hooksHandle([], sink) });
      const saveBtn = fakeDoc.getElementById('project-save');
      expect(saveBtn.disabled).toBe(true); // nothing to save at the gate

      await openFile(fakeDoc);
      expect(saveBtn.disabled).toBe(false);

      // Give it settings + a trim + a manual track to serialize.
      sink.hooks.onManualBox({ x: 1, y: 1, w: 8, h: 8 }, 1.25);
      sink.hooks.onTrimAdd(1, 2);

      saveBtn.dispatch('click');
      const anchor = createdEls.find((el) => el.tagName === 'A');
      expect(anchor).toBeTruthy();
      expect(anchor.download).toBe('redact-project-clip.vrproj');
      expect(anchor.clicked).toBe(1);
      // The stub also captures the video preview's blob URL — select the
      // project's application/json blob.
      const projectUrls = createdUrls.filter((b) => b.type === 'application/json');
      expect(projectUrls).toHaveLength(1);

      const payload = JSON.parse(await projectUrls[0].text());
      expect(payload.version).toBe('1'); // PROJECT_FORMAT_VERSION stamped
      expect(payload.settings.pixelStrength).toBe('normal'); // app default
      expect(payload.trims).toEqual([{ id: 1, start: 1, end: 2 }]);
      expect(payload.tracks).toHaveLength(1);
      expect(payload.tracks[0].keyframes).toEqual([[0, { x: 1, y: 1, w: 8, h: 8 }]]); // Map → [s, box]
      expect(payload.meta.videoName).toBe('clip.mp4');
      expect(payload.meta.videoSize).toBe(3);

      // Confirmation names the same file the anchor carries.
      expect(toastTexts(fakeDoc)).toContain('Project saved — redact-project-clip.vrproj');
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
      restoreGlobals();
    }
  });

  it('a valid project loaded WITHOUT its video prompts for the video (expected: <name>)', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => null });
      await loadProject(fakeDoc, projectJson());
      expect(toastTexts(fakeDoc)).toContain(
        'Project loaded — now open the video it belongs to (expected: clip.mp4)',
      );
    } finally {
      restoreGlobals();
    }
  });

  it('a valid project applies when its video opens: settings, trims, tracks, clamp, review step', async () => {
    const { fakeDoc, fakeView, elsById } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      // Seed the three settings control surfaces so the applied values can
      // be observed through the same UI the clicks drive.
      const sizeFilter = makeFakeEl('DIV');
      const sizeButtons = ['0', '24', '48', '96'].map((size) => {
        const b = makeFakeEl('BUTTON');
        b.setAttribute('data-size', size);
        return b;
      });
      sizeFilter.querySelectorAll = () => sizeButtons;
      elsById.set('size-filter', sizeFilter);
      const downscaleSelect = makeFakeEl('SELECT');
      elsById.set('downscale-select', downscaleSelect);
      const strengthGroup = makeFakeEl('DIV');
      const strengthButtons = ['fine', 'normal', 'coarse', 'max'].map((s) => {
        const b = makeFakeEl('BUTTON');
        b.setAttribute('data-strength', s);
        b.classList.add('strength-btn');
        return b;
      });
      strengthGroup.querySelectorAll = () => strengthButtons;
      elsById.set('pixel-strength', strengthGroup);

      const sink = {};
      await main.mountApp(fakeDoc, { mountEditor: hooksHandle([], sink) });
      await loadProject(fakeDoc, projectJson()); // no video yet → prompt
      expect(toastTexts(fakeDoc)).toContain(
        'Project loaded — now open the video it belongs to (expected: clip.mp4)',
      );

      await openFile(fakeDoc); // the pending project applies here
      const st = sink.hooks.getState();

      // Settings merged through the normalizers + UI follows.
      expect(fakeDoc.getElementById('dashcam-toggle').checked).toBe(true);
      expect(downscaleSelect.value).toBe('720p');
      expect(sizeButtons.map((b) => b.attrs['aria-pressed'])).toEqual(
        ['false', 'false', 'true', 'false'],
      );
      expect(strengthButtons.map((b) => b.attrs['aria-pressed'])).toEqual(
        ['false', 'false', 'true', 'false'],
      );

      // Trims re-normalized; tracks adopted + clamped to the 4 s fixture.
      expect(st.trims).toEqual([{ id: 1, start: 1, end: 2 }]);
      expect(st.tracks).toHaveLength(1);
      expect(st.tracks[0]).toMatchObject({ id: 5, source: 'manual', end: 4 });
      expect([...st.tracks[0].keyframes.keys()]).toEqual([0.5, 3]);
      expect(
        toastTexts(fakeDoc).some((t) => t.includes('clamped to this video')),
      ).toBe(true); // clamp warning

      // The project's manual id space is adopted (next box cannot collide)…
      sink.hooks.onManualBox({ x: 0, y: 0, w: 2, h: 2 }, 0.5);
      const ids = sink.hooks.getState().tracks.map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(sink.hooks.getState().tracks.at(-1)).toMatchObject({ label: 'Manual #6' });

      // …and the app stepped to review (the editor is mounted).
      expect(fakeDoc.getElementById('analyze-button').textContent).toBe('Re-analyze');
    } finally {
      restoreGlobals();
    }
  });

  it('a video-identity mismatch WARNS but the project still applies', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const sink = {};
      await main.mountApp(fakeDoc, { mountEditor: hooksHandle([], sink) });
      await loadProject(fakeDoc, projectJson({ top: { meta: { videoName: 'other.mp4', videoSize: 3, videoLastModified: 0 } } }));
      await openFile(fakeDoc);

      expect(
        toastTexts(fakeDoc).some((t) =>
          t.includes('The selected video "clip.mp4" doesn\'t match the video saved in this project ("other.mp4")'),
        ),
      ).toBe(true);
      // Still proceeds: the tracks render (clamped to the fixture duration).
      expect(sink.hooks.getState().tracks).toHaveLength(1);
    } finally {
      restoreGlobals();
    }
  });

  it('typed load failures: bad-json / bad-structure / unsupported-version toasts', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      await main.mountApp(fakeDoc, { mountEditor: () => null });

      await loadProject(fakeDoc, '{not json');
      expect(toastTexts(fakeDoc).at(-1)).toContain('not valid JSON');

      await loadProject(fakeDoc, '{"version":"1","settings":{}}');
      expect(toastTexts(fakeDoc).at(-1)).toContain('missing required sections');

      await loadProject(fakeDoc, projectJson({ top: { version: '9' } }));
      expect(toastTexts(fakeDoc).at(-1)).toContain('unsupported format version');
    } finally {
      restoreGlobals();
    }
  });

  it('Clear wipes a loaded-but-unapplied project (no association survives)', async () => {
    const { fakeDoc, fakeView } = makeFakeEnv();
    armGlobals(fakeView);
    try {
      const sink = {};
      await main.mountApp(fakeDoc, { mountEditor: hooksHandle([], sink) });
      await loadProject(fakeDoc, projectJson());
      fakeDoc.getElementById('clear-file').dispatch('click');

      await openFile(fakeDoc); // NO application — the pending project is gone
      const st = sink.hooks.getState();
      expect(st.tracks).toEqual([]);
      expect(st.trims).toEqual([]);
    } finally {
      restoreGlobals();
    }
  });
});
