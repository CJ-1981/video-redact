/**
 * Unit tests for the pure parts of the app shell (src/main.js, T-602).
 *
 * main.js is split so everything testable in node is exported:
 *   - deriveStep / stepperModel  — the stepper state machine
 *   - formatBytes / formatEta / formatClock — display formatters
 *   - mapExportErrorToMessage    — REQ-021 export stage → recovery message
 *   - describeIngestFailure      — REQ-001/021 ingest failure → message
 *   - renderProbeRows / metaSummaryRows — capability-report view models
 * mountApp() itself is the thin DOM wiring and stays untested (no DOM here).
 *
 * Importing src/main.js in node must stay side-effect free (the auto-mount
 * is guarded by `typeof document`) — that property is asserted too, because
 * tests/unit/scaffold.test.js imports the same module in the node env.
 */
import { describe, it, expect } from 'vitest';
import * as main from '../../src/main.js';

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
