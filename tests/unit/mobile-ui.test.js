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
 * v1.12.0 — REQ-115/116/118..121/123/124 markup+CSS contracts: below-timeline
 *   bottom flow, rail resize handle, size-filter segmented control, file-info
 *   block, analyze-cancel danger styling, compare-time input sizing, light
 *   theme token swap, theme toggle, updated footer hints.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  OVERLAY_HIDE_MS,
  transportGlyph,
  muteGlyph,
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

  it('v1.8.0 mute buttons exist on BOTH bars (transport + overlay), unmuted default', () => {
    for (const id of ['mute-button', 'ov-mute']) {
      const at = HTML.indexOf(`id="${id}"`);
      expect(at).toBeGreaterThan(-1);
      // Toggle-button contract ships in the markup: aria-pressed starts false
      // and the audible glyph is the initial text.
      const tag = HTML.slice(HTML.lastIndexOf('<button', at), HTML.indexOf('</button>', at));
      expect(tag).toContain('aria-pressed="false"');
      expect(tag).toContain('🔊');
      expect(tag).toContain('type="button"');
    }
    // Each bar owns exactly one of them (ids are unique).
    expect(HTML.split('id="mute-button"').length - 1).toBe(1);
    expect(HTML.split('id="ov-mute"').length - 1).toBe(1);
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

  it('muteGlyph: 🔇 when muted, 🔊 when audible (v1.8.0, both bars share it)', () => {
    expect(muteGlyph(true)).toBe('🔇');
    expect(muteGlyph(false)).toBe('🔊');
    // Non-boolean truthiness maps by the same rule (muted is read as `=== true`
    // at the call site; the pure helper normalizes the same way).
    expect(muteGlyph(1)).toBe('🔇');
    expect(muteGlyph(0)).toBe('🔊');
    expect(muteGlyph(undefined)).toBe('🔊');
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

  it('keeps the track-row .times inputs fitting the row on mobile (v1.4.1: no 64px basis in the media block)', () => {
    // v1.4.1: flexible width moved to the BASE rule (flex: 1 1 0 + min-width 0);
    // the media block must NOT reintroduce a fixed 64px flex basis.
    const block = mediaBlock();
    expect(block).not.toMatch(/\.track-row \.times input\.span-input\s*{[^}]*flex:\s*1 1 64px/);
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).toMatch(/\.track-row \.times\s*{[^}]*flex:\s*0 0 100%;[^}]*min-width:\s*0/);
    expect(html).toMatch(/input\.span-input\s*{[^}]*flex:\s*1 1 0;[^}]*min-width:\s*0/);
  });

  it('hides the footer keyboard hints and wraps header/stepper/transport', () => {
    const block = mediaBlock();
    expect(block).toContain('#keyboard-hints .hints');
    expect(block).toMatch(/flex-wrap/);
  });
});

// ---------------------------------------------------------------------------
// v1.12.0 helpers
// ---------------------------------------------------------------------------

/** Extract a CSS rule body by its exact `selector {` opening (balanced scan). */
function cssRule(selector) {
  const start = HTML.indexOf(`${selector} {`);
  if (start < 0) return '';
  const bodyStart = HTML.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < HTML.length; i++) {
    if (HTML[i] === '{') depth += 1;
    else if (HTML[i] === '}') {
      depth -= 1;
      if (depth === 0) return HTML.slice(bodyStart + 1, i);
    }
  }
  return '';
}

/** All id="…" values inside a source slice, in order. */
function idsIn(slice) {
  return [...slice.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// v1.12.0 REQ-116: below-timeline bottom flow
// ---------------------------------------------------------------------------

describe('v1.12.0 REQ-116: #below-timeline bottom flow (compare + tracks)', () => {
  it('the section sits AFTER #timeline and holds #threshold-compare before #track-list', () => {
    const timeline = HTML.indexOf('id="timeline"');
    const below = HTML.indexOf('id="below-timeline"');
    expect(timeline).toBeGreaterThan(-1);
    expect(below).toBeGreaterThan(timeline);
    const region = HTML.slice(below, HTML.indexOf('</main>', below));
    const compare = region.indexOf('id="threshold-compare"');
    const tracks = region.indexOf('id="track-list"');
    expect(compare).toBeGreaterThan(-1);
    expect(tracks).toBeGreaterThan(compare);
  });

  it('moved OUT of the right rail — the rail keeps only sensitivity + export', () => {
    const rail = HTML.slice(
      HTML.indexOf('id="right-rail"'),
      HTML.indexOf('id="below-timeline"'),
    );
    expect(rail).not.toContain('id="threshold-compare"');
    expect(rail).not.toContain('id="track-list"');
    expect(rail).not.toContain('id="tracks-panel"');
    expect(rail).toContain('id="sensitivity"');
    expect(rail).toContain('id="export-panel"');
  });

  it('keeps every inner compare id exactly once (E2E/JS selectors untouched)', () => {
    for (const id of [
      'compare-time',
      'compare-use-preview',
      'compare-button',
      'compare-status',
      'threshold-panels',
    ]) {
      expect(HTML.split(`id="${id}"`).length - 1).toBe(1);
    }
  });

  it('#threshold-panels is a horizontal scrollable strip (never grows vertically)', () => {
    const rule = cssRule('#threshold-panels');
    expect(rule).toContain('flex-wrap: nowrap');
    expect(rule).toContain('overflow-x: auto');
    expect(rule).toContain('gap: 8px');
  });

  it('.threshold-panel keeps a fixed 240px width in the strip', () => {
    expect(cssRule('.threshold-panel')).toContain('flex: 0 0 240px');
  });

  it('side by side on wide screens (grid-column 1/-1, two columns), stacked ≤820px', () => {
    const rule = cssRule('#below-timeline');
    expect(rule).toContain('grid-column: 1 / -1');
    expect(rule).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/);
    expect(mediaBlock()).toMatch(/#below-timeline\s*{[^}]*grid-template-columns:\s*1fr/);
  });
});

// ---------------------------------------------------------------------------
// v1.12.0 REQ-118: rail resize handle
// ---------------------------------------------------------------------------

describe('v1.12.0 REQ-118: #rail-resize separator', () => {
  it('sits between the two #workspace columns in DOM order', () => {
    const stage = HTML.indexOf('id="stage-column"');
    const handle = HTML.indexOf('id="rail-resize"');
    const rail = HTML.indexOf('id="right-rail"');
    expect(handle).toBeGreaterThan(stage);
    expect(handle).toBeLessThan(rail);
  });

  it('carries the full separator markup contract (role/aria/clamps)', () => {
    const at = HTML.indexOf('id="rail-resize"');
    const tag = HTML.slice(HTML.lastIndexOf('<div', at), HTML.indexOf('>', at) + 1);
    expect(tag).toContain('role="separator"');
    expect(tag).toContain('aria-orientation="vertical"');
    expect(tag).toContain('tabindex="0"');
    expect(tag).toContain('aria-label="Adjust panel width"');
    expect(tag).toContain('aria-valuemin="240"');
    expect(tag).toContain('aria-valuemax="480"');
    expect(tag).toContain('aria-valuenow="320"'); // matches the 320px default
  });

  it('#workspace sizes the split via --rail-w and the handle CSS is a 10px col-resize grip', () => {
    expect(HTML).toMatch(
      /grid-template-columns:\s*minmax\(0, 1fr\) 10px var\(--rail-w, 320px\)/,
    );
    const rule = cssRule('#rail-resize');
    expect(rule).toContain('width: 10px');
    expect(rule).toContain('cursor: col-resize');
    expect(rule).toContain('touch-action: none');
  });

  it('mobile ≤820px: handle hidden, workspace back to a single column', () => {
    const block = mediaBlock();
    expect(block).toMatch(/#rail-resize\s*{[^}]*display:\s*none/);
    expect(block).toMatch(/#workspace\s*{[^}]*grid-template-columns:\s*1fr/);
  });
});

// ---------------------------------------------------------------------------
// v1.12.0 REQ-115 / REQ-121 / REQ-120 / REQ-119 / REQ-123
// ---------------------------------------------------------------------------

describe('v1.12.0: panel markup + styling contracts', () => {
  it('REQ-115: #analyze-cancel is danger-styled, ≥40px tall, full width', () => {
    const rule = cssRule('#analyze-cancel');
    expect(rule).toContain('color: var(--alert)');
    expect(rule).toContain('border-color: var(--alert)');
    expect(rule).toContain('min-height: 40px');
    expect(rule).toContain('width: 100%');
    const hover = cssRule('#analyze-cancel:hover');
    expect(hover).toContain('background: var(--alert)');
  });

  it('REQ-121: #compare-time gets room (flex 1 1 90px, no 9ch cap, ≥13px font)', () => {
    const rule = cssRule('#compare-time');
    expect(rule).toContain('flex: 1 1 90px');
    expect(rule).toContain('min-width: 0');
    expect(rule).toContain('max-width: none');
    expect(rule).toContain('font-size: 13px');
  });

  it('REQ-120: #size-filter is a 4-button segmented group with data-size 0/24/48/96', () => {
    const start = HTML.indexOf('id="size-filter"');
    const group = HTML.slice(start, HTML.indexOf('</div>', start));
    const sizes = [...group.matchAll(/data-size="([^"]+)"/g)].map((m) => m[1]);
    expect(sizes).toEqual(['0', '24', '48', '96']);
    // "Any" is the default pressed segment; the others are not.
    const pressed = [...group.matchAll(/data-size="[^"]+" aria-pressed="([^"]+)"/g)].map((m) => m[1]);
    expect(pressed).toEqual(['true', 'false', 'false', 'false']);
    for (const label of ['Any', '&ge;24px', '&ge;48px', '&ge;96px']) {
      expect(group).toContain(label);
    }
    expect(group).toContain('role="group"');
    expect(group).toContain('aria-label="Minimum object size"');
    expect(HTML.split('class="size-btn"').length - 1).toBe(4);
  });

  it('REQ-120: the selected segment gets the accent fill + dark text', () => {
    const rule = cssRule(".size-btn[aria-pressed='true']");
    expect(rule).toContain('background: var(--accent)');
    expect(rule).toContain('color: #14100A');
  });

  it('REQ-120: #size-filter lives inside #sensitivity after the two sliders', () => {
    const sensitivity = HTML.indexOf('id="sensitivity"');
    const size = HTML.indexOf('id="size-filter"');
    const plate = HTML.indexOf('id="conf-plate"');
    expect(size).toBeGreaterThan(sensitivity);
    expect(size).toBeGreaterThan(plate);
    expect(size).toBeLessThan(HTML.indexOf('id="analyze-cancel"'));
  });

  it('REQ-119: #file-info block renders hidden above #cap-report with a label/value grid', () => {
    const info = HTML.indexOf('id="file-info"');
    const cap = HTML.indexOf('id="cap-report"');
    expect(info).toBeGreaterThan(-1);
    expect(info).toBeLessThan(cap);
    const tag = HTML.slice(HTML.lastIndexOf('<div', info), HTML.indexOf('>', info) + 1);
    expect(tag).toContain('hidden');
    const rule = cssRule('#file-info');
    expect(rule).toContain('display: grid');
    expect(rule).toMatch(/grid-template-columns:\s*max-content 1fr/);
  });

  it('REQ-123: #model-attribution moved into the intake column, right after #cap-report', () => {
    const cap = HTML.indexOf('id="cap-report"');
    const attribution = HTML.indexOf('id="model-attribution"');
    const workspace = HTML.indexOf('id="workspace"');
    expect(attribution).toBeGreaterThan(cap);
    expect(attribution).toBeLessThan(workspace); // left column, before the workspace
    // "immediately after": between the two ids there are only cap-report's
    // own children — no other panel slipped in. (The slice ends where
    // `id="model-attribution"` starts, so the target id itself is excluded.)
    expect(idsIn(HTML.slice(cap, attribution))).toEqual([
      'cap-report',
      'cap-report-body',
      'cap-guidance',
    ]);
  });
});

// ---------------------------------------------------------------------------
// v1.12.0 REQ-124: light theme
// ---------------------------------------------------------------------------

describe('v1.12.0 REQ-124: light theme token swap + toggle', () => {
  function themeBlock() {
    const marker = ":root[data-theme='light'] {";
    const start = HTML.indexOf(marker);
    if (start < 0) return '';
    const bodyStart = HTML.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < HTML.length; i++) {
      if (HTML[i] === '{') depth += 1;
      else if (HTML[i] === '}') {
        depth -= 1;
        if (depth === 0) return HTML.slice(bodyStart + 1, i);
      }
    }
    return '';
  }

  it('overrides the core surface/ink custom properties (accents unchanged)', () => {
    const block = themeBlock();
    expect(block).toContain('--bg-base: #f5f6f8');
    expect(block).toContain('--bg-panel: #ffffff');
    expect(block).toContain('--bg-inset: #eef0f3');
    expect(block).toContain('--line: #d9dee5');
    expect(block).toContain('--ink-hi: #1a1f26');
    expect(block).toContain('--ink: #5a6472');
    expect(block).not.toContain('--accent');
    expect(block).not.toContain('--alert');
    expect(block).not.toContain('--safe');
  });

  it('color-scheme follows the theme (dark default, light via data-theme)', () => {
    expect(HTML).toMatch(/html\s*{[^}]*color-scheme:\s*dark/);
    expect(HTML).toMatch(/html\[data-theme='light'\]\s*{[^}]*color-scheme:\s*light/);
  });

  it('#theme-toggle sits in #header-actions with the sun glyph (dark default)', () => {
    const actions = HTML.slice(
      HTML.indexOf('id="header-actions"'),
      HTML.indexOf('id="stepper"'),
    );
    const at = actions.indexOf('id="theme-toggle"');
    expect(at).toBeGreaterThan(-1);
    const tag = actions.slice(actions.lastIndexOf('<button', at), actions.indexOf('</button>', at));
    expect(tag).toContain('type="button"');
    expect(tag).toContain('☀️');
    expect(tag).toContain('aria-pressed="false"');
  });
});

// ---------------------------------------------------------------------------
// v1.12.0 REQ-122 (hint text only — behavior wired by main.js)
// ---------------------------------------------------------------------------

describe('v1.12.0: footer keyboard hints', () => {
  const hints = HTML.slice(
    HTML.indexOf('class="hints"'),
    HTML.indexOf('</span>', HTML.indexOf('class="hints"')),
  ).replace(/<[^>]+>/g, ' ');

  it('documents the v1.12.0 shortcut set', () => {
    for (const fragment of [
      'jump 5s',
      'frame step',
      'play/pause',
      'fullscreen',
      'mute',
      'draw box',
    ]) {
      expect(hints).toContain(fragment);
    }
  });

  it('replaces the old hint text (manual-box wording gone)', () => {
    expect(hints).not.toContain('draw manual box');
    expect(hints).not.toContain('drag a chip edge to trim');
  });
});
