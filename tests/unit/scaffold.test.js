/**
 * M1 scaffold tests (SPEC-VID-001).
 *
 * Verifies the deliverables of the scaffold milestone:
 *  (a) tools/inline.mjs bundles ./src/main.js into dist/index.html with zero ./src/ references;
 *  (b) index.html importmap pins mediabunny@1.63.0 and onnxruntime-web@1.31.1;
 *  (c) src/types.js documents the §2 data model and every src stub module exposes the
 *      design.md §3 contract exports.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('M1 scaffold: tools/inline.mjs single-file build', () => {
  it('produces dist/index.html containing the bundled main.js and zero ./src/ references', () => {
    execFileSync('node', ['tools/inline.mjs'], { cwd: ROOT, stdio: 'pipe' });

    const distPath = join(ROOT, 'dist', 'index.html');
    expect(existsSync(distPath), 'dist/index.html should exist after build').toBe(true);

    const dist = readFileSync(distPath, 'utf8');
    // The dev entry module's content must be inlined.
    expect(dist).toContain('video-redact dev shell');
    // No dev-mode module paths may survive into the single-file artifact.
    expect(dist).not.toContain('./src/');
    expect(dist).not.toContain('src/main.js');
    // The importmap (CDN bare specifiers) must survive the inlining.
    expect(dist).toContain('type="importmap"');
  });
});

describe('M1 scaffold: index.html importmap pins', () => {
  const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');

  it('maps mediabunny to the pinned CDN URL (1.63.0)', () => {
    expect(indexHtml).toContain('mediabunny@1.63.0');
  });

  it('maps onnxruntime-web to the pinned CDN URL (1.31.1)', () => {
    expect(indexHtml).toContain('onnxruntime-web@1.31.1');
  });

  it('declares a CSP meta tag and loads the dev entry module', () => {
    expect(indexHtml).toContain('http-equiv="Content-Security-Policy"');
    expect(indexHtml).toContain('<script type="module" src="./src/main.js"></script>');
  });
});

describe('M1 scaffold: src/types.js data-model typedefs (design.md §2)', () => {
  const typesSrc = readFileSync(join(ROOT, 'src', 'types.js'), 'utf8');

  for (const typedef of ['Box', 'Detection', 'Track', 'AppState', 'MediaMeta', 'CapabilityReport']) {
    it(`documents @typedef ${typedef}`, () => {
      expect(typesSrc).toContain(`@typedef {object} ${typedef}`);
    });
  }
});

describe('M1 scaffold: stub modules expose design.md §3 contract exports', () => {
  it('capability.js: secureContextInfo, probeCapabilities, guidance', async () => {
    const m = await import(join(ROOT, 'src', 'capability.js'));
    expect(typeof m.secureContextInfo).toBe('function');
    expect(typeof m.probeCapabilities).toBe('function');
    expect(typeof m.guidance).toBe('function');
  });

  it('ingest.js: openInput', async () => {
    const m = await import(join(ROOT, 'src', 'ingest.js'));
    expect(typeof m.openInput).toBe('function');
  });

  it('models.js: MODELS registry + ensureModel', async () => {
    const m = await import(join(ROOT, 'src', 'models.js'));
    expect(typeof m.MODELS).toBe('object');
    expect(m.MODELS).not.toBeNull();
    for (const entry of Object.values(m.MODELS)) {
      for (const field of ['name', 'url', 'version', 'bytes', 'license', 'source']) {
        expect(entry, `registry entry field ${field}`).toHaveProperty(field);
      }
    }
    expect(typeof m.ensureModel).toBe('function');
  });

  it('detector.js: createDetectors, letterbox, unletterbox, decodeYunetOutputs, nms, parsePlateRows, tileGrid, mergeTiles', async () => {
    const m = await import(join(ROOT, 'src', 'detector.js'));
    for (const name of [
      'createDetectors',
      'letterbox',
      'unletterbox',
      'decodeYunetOutputs',
      'nms',
      'parsePlateRows',
      'tileGrid',
      'mergeTiles',
    ]) {
      expect(typeof m[name], `detector.${name}`).toBe('function');
    }
  });

  it('tracker.js: Tracker, interpolate, iou, KalmanCV', async () => {
    const m = await import(join(ROOT, 'src', 'tracker.js'));
    expect(typeof m.Tracker).toBe('function');
    expect(typeof m.interpolate).toBe('function');
    expect(typeof m.iou).toBe('function');
    expect(typeof m.KalmanCV).toBe('function');
    expect(typeof m.Tracker.prototype.update).toBe('function');
    expect(typeof m.Tracker.prototype.finalize).toBe('function');
  });

  it('analyze.js: runAnalyze (M4 module, design.md §4.6)', async () => {
    const m = await import(join(ROOT, 'src', 'analyze.js'));
    expect(typeof m.runAnalyze).toBe('function');
  });

  it('redact.js: dilate, tracksAt, applyPixelation, drawOverlay', async () => {
    const m = await import(join(ROOT, 'src', 'redact.js'));
    expect(typeof m.dilate).toBe('function');
    expect(typeof m.tracksAt).toBe('function');
    expect(typeof m.applyPixelation).toBe('function');
    expect(typeof m.drawOverlay).toBe('function');
  });

  it('editor.js: mountEditor, renderTimeline, hitTestTimeline, toggleTrack, beginManualBox', async () => {
    const m = await import(join(ROOT, 'src', 'editor.js'));
    for (const name of ['mountEditor', 'renderTimeline', 'hitTestTimeline', 'toggleTrack', 'beginManualBox']) {
      expect(typeof m[name], `editor.${name}`).toBe('function');
    }
  });

  it('exporter.js: runExport + ExportError', async () => {
    const m = await import(join(ROOT, 'src', 'exporter.js'));
    expect(typeof m.runExport).toBe('function');
    expect(typeof m.ExportError).toBe('function');
  });

  it('main.js is importable as the dev entry module', async () => {
    await expect(import(join(ROOT, 'src', 'main.js'))).resolves.toBeDefined();
  });
});
