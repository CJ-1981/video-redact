/**
 * mobile-ui.test.js — v1.4.0 REQ-111/112 pure helpers + static index.html
 * contract (same split as stage-resize.test.js: the DOM wiring itself lives
 * in mountApp() and stays untested in node; the wiring's CONTRACTS are
 * asserted against index.html and the exported pure helpers).
 *
 * REQ-111 — overlay control bar: markup lives INSIDE #preview-stage, hidden
 *   by default, display:flex only under :fullscreen / .preview-zoom, faded
 *   out via the .controls-idle class after ~3 s idle.
 * REQ-112 — mobile layout: one @media (max-width: 820px) block collapsing to
 *   a single column, ≥ 40 px touch targets, smaller default stage.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  OVERLAY_HIDE_MS,
  transportGlyph,
  normalizePlaybackRate,
} from '../../src/main.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HTML = readFileSync(join(ROOT, 'index.html'), 'utf8');

/** Extract the @media (max-width: 820px) block source (balanced-brace scan). */
function mediaBlock() {
  const marker = '@media (max-width: 820px)';
  const start = HTML.indexOf(marker);
  if (start < 0) return '';
  const bodyStart = HTML.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < HTML.length; i++) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') {
      depth -= 1;
      if (depth === 0) return HTML.slice(start, i + 1);
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// REQ-111: overlay control bar contract
// ---------------------------------------------------------------------------

describe('REQ-111: .stage-overlay-controls lives inside #preview-stage', () => {
  it('the overlay bar markup sits between #preview-stage and the resize handle', () => {
    // Source-order containment: the bar must be a child of the stage div
    // (before the stage closes at #stage-resize-handle), not a sibling.
    // Match the class ATTRIBUTE (markup) — '.stage-overlay-controls' alone
    // also matches the CSS selector earlier in the file.
    const stage = HTML.indexOf('id="preview-stage"');
    const bar = HTML.indexOf('class="stage-overlay-controls"');
    const after = HTML.indexOf('id="stage-resize-handle"');
    expect(stage).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(stage);
    expect(after).toBeGreaterThan(bar);
  });

  it('exposes the five ov-* controls with distinct ids (E2E selectors untouched)', () => {
    for (const id of ['ov-back', 'ov-play', 'ov-fwd', 'ov-speed', 'ov-exit']) {
      expect(HTML).toContain(`id="${id}"`);
    }
    // The bottom transport bar ids that the E2E suite uses are all still there.
    for (const id of [
      'transport-start',
      'transport-back',
      'transport-play',
      'transport-fwd',
      'transport-speed',
      'export-button',
    ]) {
      expect(HTML).toContain(`id="${id}"`);
    }
  });

  it('overlay speed select offers the same options as the bottom bar', () => {
    const speeds = ['value="0.25"', 'value="0.5"', 'value="1"', 'value="2"', 'value="4"'];
    const bar = HTML.slice(HTML.indexOf('id="transport-speed"'), HTML.indexOf('</select>', HTML.indexOf('id="transport-speed"')));
    const ov = HTML.slice(HTML.indexOf('id="ov-speed"'), HTML.indexOf('</select>', HTML.indexOf('id="ov-speed"')));
    for (const s of speeds) {
      expect(bar).toContain(s);
      expect(ov).toContain(s);
    }
  });

  it('hidden by default; display:flex only under :fullscreen / .preview-zoom', () => {
    const ruleStart = HTML.indexOf('.stage-overlay-controls {');
    const base = HTML.slice(ruleStart, HTML.indexOf('}', ruleStart));
    expect(base).toContain('display: none');
    expect(HTML).toContain('#preview-stage:fullscreen .stage-overlay-controls');
    expect(HTML).toContain('#preview-stage.preview-zoom .stage-overlay-controls');
    const flexRule = HTML.indexOf(
      '#preview-stage:fullscreen .stage-overlay-controls,',
    );
    const flexBody = HTML.slice(flexRule, HTML.indexOf('}', flexRule));
    expect(flexBody).toContain('display: flex');
  });

  it('auto-hide contract: .controls-idle fades the bar and drops pointer events', () => {
    const rule = HTML.indexOf('#preview-stage.controls-idle .stage-overlay-controls');
    expect(rule).toBeGreaterThan(-1);
    const body = HTML.slice(rule, HTML.indexOf('}', rule));
    expect(body).toContain('opacity: 0');
    expect(body).toContain('pointer-events: none');
  });
});

describe('REQ-111: overlay pure helpers (src/main.js)', () => {
  it('OVERLAY_HIDE_MS is the documented ~3 s idle delay', () => {
    expect(OVERLAY_HIDE_MS).toBe(3000);
  });

  it('transportGlyph: ▶ when paused, ⏸ while playing (both bars share it)', () => {
    expect(transportGlyph(true)).toBe('▶');
    expect(transportGlyph(false)).toBe('⏸');
  });

  it('normalizePlaybackRate clamps to finite > 0 with a 1× fallback', () => {
    expect(normalizePlaybackRate('1')).toBe(1);
    expect(normalizePlaybackRate('0.25')).toBe(0.25);
    expect(normalizePlaybackRate('4')).toBe(4);
    expect(normalizePlaybackRate(2)).toBe(2);
    expect(normalizePlaybackRate('0')).toBe(1);
    expect(normalizePlaybackRate('-2')).toBe(1);
    expect(normalizePlaybackRate('NaN')).toBe(1);
    expect(normalizePlaybackRate(undefined)).toBe(1);
    expect(normalizePlaybackRate('')).toBe(1);
    expect(normalizePlaybackRate('1e1')).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// REQ-112: mobile layout contract
// ---------------------------------------------------------------------------

describe('REQ-112: @media (max-width: 820px) mobile block', () => {
  it('the 820px media query exists (the old 900px breakpoint is replaced)', () => {
    expect(mediaBlock()).not.toBe('');
    expect(HTML).not.toContain('@media (max-width: 900px)');
  });

  it('collapses #workspace to a single column (right rail below the timeline)', () => {
    const block = mediaBlock();
    expect(block).toContain('#workspace');
    expect(block).toMatch(/#workspace\s*{[^}]*grid-template-columns:\s*1fr/);
    expect(block).toContain('#app-main');
  });

  it('shrinks the default stage to 48vh via the --stage-h var override', () => {
    expect(mediaBlock()).toMatch(/--stage-h:\s*48vh/);
    // The desktop rule still owns the height via the same var (fallback path).
    expect(HTML).toMatch(/height:\s*var\(--stage-h/);
  });

  it('gives buttons/selects/inputs ≥ 40px touch targets', () => {
    const block = mediaBlock();
    expect(block).toMatch(/button,\s*select\s*{[^}]*min-height:\s*40px/);
    expect(block).toMatch(/input\.span-input\s*{[^}]*min-height:\s*40px/);
  });

  it('makes the track-row .times inputs flexible width (rows wrap)', () => {
    const block = mediaBlock();
    expect(block).toMatch(/\.track-row \.times input\.span-input\s*{[^}]*flex:\s*1 1 64px/);
  });

  it('hides the footer keyboard hints and wraps header/stepper/transport', () => {
    const block = mediaBlock();
    expect(block).toContain('#keyboard-hints .hints');
    expect(block).toMatch(/flex-wrap/);
  });
});
