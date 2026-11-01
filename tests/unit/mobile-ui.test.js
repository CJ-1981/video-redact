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
  // Grouped selectors ("a,\n b {") — find the selector name followed by a
  // comma or a brace, so shared rules resolve for every selector in the group.
  const patterns = [`${selector} {`, `${selector},`];
  let start = -1;
  for (const pat of patterns) {
    const idx = HTML.indexOf(pat);
    if (idx >= 0 && (start < 0 || idx < start)) start = idx;
  }
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

// ---------------------------------------------------------------------------
// v1.12.0 REQ-116: below-timeline bottom flow
// ---------------------------------------------------------------------------

describe('v1.12.0 REQ-116: #below-timeline bottom flow (compare + tracks)', () => {
  it('the section sits AFTER #timeline and holds #tracks-panel before #threshold-compare (v1.14.0: compare under tracks)', () => {
    const timeline = HTML.indexOf('id="timeline"');
    const below = HTML.indexOf('id="below-timeline"');
    expect(timeline).toBeGreaterThan(-1);
    expect(below).toBeGreaterThan(timeline);
    const region = HTML.slice(below, HTML.indexOf('</main>', below));
    const compare = region.indexOf('id="threshold-compare"');
    const tracks = region.indexOf('id="tracks-panel"');
    expect(compare).toBeGreaterThan(-1);
    expect(tracks).toBeGreaterThan(-1);
    expect(tracks).toBeLessThan(compare); // tracks first, compare UNDER tracks
  });

  it('lives INSIDE the preview column (v1.18.1: follows the timeline with no gap)', () => {
    const stage = HTML.indexOf('id="stage-column"');
    const timeline = HTML.indexOf('id="timeline"');
    const below = HTML.indexOf('id="below-timeline"');
    const railResize = HTML.indexOf('id="rail-resize"');
    expect(stage).toBeGreaterThan(-1);
    expect(timeline).toBeGreaterThan(stage);
    expect(below).toBeGreaterThan(timeline);
    // it closes BEFORE the rail-resize handle (still inside #stage-column)
    expect(railResize).toBeGreaterThan(below);
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

  it('stacked single column flow (v1.14.0: compare under tracks); no grid placement since v1.18.1', () => {
    const rule = cssRule('#below-timeline');
    expect(rule).not.toContain('grid-column'); // plain block inside the column
    expect(rule).toMatch(/margin-top:\s*16px/);
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

  it('both width handles share identical visual states (v1.19.0 field report)', () => {
    const railRule = cssRule('#rail-resize');
    const intakeRule = cssRule('#intake-resize');
    // ONE shared base rule covers both handles.
    expect(railRule).toContain('width: 10px');
    expect(intakeRule).toContain('width: 10px');
    expect(HTML).toMatch(/#rail-resize:hover,\s*#intake-resize:hover\s*{[^}]*background:\s*var\(--line\)/);
    expect(HTML).toMatch(/#rail-resize:focus-visible,\s*#intake-resize:focus-visible\s*{[^}]*outline:\s*2px solid var\(--accent\)/);
    expect(HTML).toMatch(/#rail-resize::before,[\s\S]*?#intake-resize::before/);
  });

  it('mobile ≤820px: handle hidden, workspace back to a single column', () => {
    const block = mediaBlock();
    expect(block).toMatch(/#rail-resize,\s*#intake-resize\s*{[^}]*display:\s*none/);
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

  // REQ-123 (v1.12.0 placement: intake column) was superseded in v1.13.0 —
  // #model-attribution moved BELOW the footer; see the v1.13.0 describe.
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

// ---------------------------------------------------------------------------
// v1.13.0 item 1: #model-attribution below the footer
// ---------------------------------------------------------------------------

describe('v1.13.0: #model-attribution is a full-width section below the footer', () => {
  it('sits AFTER the </footer> element in DOM order', () => {
    const footerEnd = HTML.indexOf('</footer>');
    const attribution = HTML.indexOf('id="model-attribution"');
    expect(footerEnd).toBeGreaterThan(-1);
    expect(attribution).toBeGreaterThan(footerEnd);
  });

  it('no longer lives inside #intake-panel', () => {
    const intake = HTML.slice(
      HTML.indexOf('id="intake-panel"'),
      HTML.indexOf('id="workspace"'),
    );
    expect(intake).not.toContain('id="model-attribution"');
  });

  it('keeps the ID contract (main.js populates the <ul> inside it)', () => {
    const at = HTML.indexOf('id="model-attribution"');
    const block = HTML.slice(at, HTML.indexOf('</details>', at));
    expect(block).toContain('<ul>');
    expect(HTML.split('id="model-attribution"').length - 1).toBe(1);
  });

  it('carries its own panel chrome CSS (styled like a panel)', () => {
    const rule = cssRule('#model-attribution');
    expect(rule).toContain('background: var(--bg-panel)');
    expect(rule).toContain('border: 1px solid var(--line)');
    expect(rule).toContain('border-radius: var(--radius)');
  });
});

// ---------------------------------------------------------------------------
// v1.13.0 item 2: #bulk-style segmented buttons in #tracks-panel
// ---------------------------------------------------------------------------

describe('v1.13.0: #bulk-style bulk track-style buttons', () => {
  const trackStart = HTML.indexOf('id="tracks-panel"');
  const trackBlock = HTML.slice(trackStart, HTML.indexOf('</details>', trackStart));

  it('lives inside #tracks-panel, above #track-list', () => {
    expect(trackBlock).toContain('id="bulk-style"');
    expect(trackBlock.indexOf('id="bulk-style"')).toBeLessThan(trackBlock.indexOf('id="track-list"'));
  });

  it('exposes the two contract button IDs with the right labels', () => {
    const group = HTML.slice(
      HTML.indexOf('id="bulk-style"'),
      HTML.indexOf('</div>', HTML.indexOf('id="bulk-style"')),
    );
    expect(group).toContain('id="bulk-solid"');
    expect(group).toContain('id="bulk-pixelate"');
    expect(group).toContain('All solid');
    expect(group).toContain('All pixelate');
    expect(group).toContain('role="group"');
    expect(group).toContain('aria-label="Set all tracks style"');
    expect(HTML.split('id="bulk-solid"').length - 1).toBe(1);
    expect(HTML.split('id="bulk-pixelate"').length - 1).toBe(1);
  });

  it('is styled like the size-btn segmented control (joined, small, subtle)', () => {
    const rule = cssRule('#bulk-style button');
    expect(rule).toContain('flex: 1 1 0');
    expect(rule).toContain('margin-left: -1px');
    expect(rule).toContain('border-radius: 0');
    expect(cssRule('#bulk-style')).toContain('display: flex');
  });
});

// ---------------------------------------------------------------------------
// v1.17.0: #bulk-style moves to its own full-width row above #track-list;
// #pixel-strength segmented group joins #trim-toggle inside #trim-bar
// ---------------------------------------------------------------------------

describe('v1.17.0: #bulk-style is its own row between the summary and #track-list', () => {
  const trackStart = HTML.indexOf('id="tracks-panel"');
  const trackEnd = HTML.indexOf('</details>', trackStart);
  const trackBlock = HTML.slice(trackStart, trackEnd);

  it('DOM order inside #tracks-panel: summary → #bulk-style → #track-list → empty note', () => {
    const summaryEnd = trackBlock.indexOf('</summary>');
    const bulk = trackBlock.indexOf('id="bulk-style"');
    const list = trackBlock.indexOf('id="track-list"');
    const empty = trackBlock.indexOf('id="track-list-empty"');
    expect(summaryEnd).toBeGreaterThan(-1);
    expect(bulk).toBeGreaterThan(summaryEnd);
    expect(list).toBeGreaterThan(bulk);
    expect(empty).toBeGreaterThan(list);
  });

  it('no #trim-bar wrapper is left inside #tracks-panel (v1.15 leftover removed)', () => {
    expect(trackBlock).not.toContain('id="trim-bar"');
  });

  it('is a full-width row: no 320px cap, top+bottom margins own the spacing', () => {
    const rule = cssRule('#bulk-style');
    expect(rule).toContain('display: flex');
    expect(rule).toContain('max-width: none');
    expect(rule).not.toContain('max-width: 320px');
  });

  it('the v1.15 "#trim-bar #bulk-style" override is gone from the CSS', () => {
    expect(HTML).not.toMatch(/#trim-bar\s+#bulk-style/);
  });

  it('the two contract button IDs survive exactly once each', () => {
    expect(HTML.split('id="bulk-solid"').length - 1).toBe(1);
    expect(HTML.split('id="bulk-pixelate"').length - 1).toBe(1);
  });
});

describe('v1.17.0: #pixel-strength segmented group inside #trim-bar', () => {
  // The single #trim-bar instance is the one wrapping #trim-toggle.
  const barStart = HTML.indexOf('id="trim-bar"');
  const barEnd = HTML.indexOf('</div>', HTML.indexOf('id="trim-hint"', barStart));
  const bar = HTML.slice(barStart, barEnd);

  it('exactly one #trim-bar exists and it holds #trim-toggle + #pixel-strength', () => {
    expect(HTML.split('id="trim-bar"').length - 1).toBe(1);
    expect(bar).toContain('id="trim-toggle"');
    expect(bar).toContain('id="pixel-strength"');
    // #bulk-style moved out — it is NOT a trim-bar child anymore.
    expect(bar).not.toContain('id="bulk-style"');
    expect(HTML.split('id="pixel-strength"').length - 1).toBe(1);
  });

  it('is a labeled group with the pixel-block tooltip', () => {
    const at = HTML.indexOf('id="pixel-strength"');
    const tag = HTML.slice(HTML.lastIndexOf('<div', at), HTML.indexOf('>', at) + 1);
    expect(tag).toContain('role="group"');
    expect(tag).toContain('aria-label="Pixelation strength"');
    expect(tag).toContain('title="Pixel block size for redaction — larger blocks hide more"');
  });

  it('offers 4 data-strength segments in order: fine/normal/coarse/max', () => {
    const start = HTML.indexOf('id="pixel-strength"');
    const group = HTML.slice(start, HTML.indexOf('</div>', start));
    const strengths = [...group.matchAll(/data-strength="([^"]+)"/g)].map((m) => m[1]);
    expect(strengths).toEqual(['fine', 'normal', 'coarse', 'max']);
    for (const label of ['Fine', 'Normal', 'Coarse', 'Max']) {
      expect(group).toContain(`>${label}</button>`);
    }
    expect(group.split('class="strength-btn"').length - 1).toBe(4);
  });

  it("'normal' is the default pressed segment; the others are not", () => {
    const start = HTML.indexOf('id="pixel-strength"');
    const group = HTML.slice(start, HTML.indexOf('</div>', start));
    const pressed = [...group.matchAll(/data-strength="([^"]+)" aria-pressed="([^"]+)"/g)].map(
      (m) => `${m[1]}=${m[2]}`,
    );
    expect(pressed).toEqual(['fine=false', 'normal=true', 'coarse=false', 'max=false']);
    expect(group).toContain('data-strength="normal" aria-pressed="true"');
    for (const s of ['fine', 'coarse', 'max']) {
      expect(group).toContain(`data-strength="${s}" aria-pressed="false"`);
    }
  });

  it('segmented CSS mirrors #size-filter (joined borders, accent pressed fill)', () => {
    const group = cssRule('#pixel-strength');
    expect(group).toContain('display: flex');
    const btn = cssRule('.strength-btn');
    expect(btn).toContain('flex: 1 1 0');
    expect(btn).toContain('margin-left: -1px');
    expect(btn).toContain('border-radius: 0');
    const pressed = cssRule(".strength-btn[aria-pressed='true']");
    expect(pressed).toContain('background: var(--accent)');
    expect(pressed).toContain('border-color: var(--accent)');
    expect(pressed).toContain('color: #14100A');
    expect(cssRule('.strength-btn:focus-visible')).toContain('outline: 2px solid var(--accent)');
  });
});

// ---------------------------------------------------------------------------
// v1.13.0 item 3: collapsible panels (native details.panel-collapse)
// ---------------------------------------------------------------------------

describe('v1.13.0: collapsible panels (details.panel-collapse, open by default)', () => {
  // [panel id, summary text] — summary replaces the old h2/h3 heading.
  const CASES = [
    ['threshold-compare', 'Compare thresholds'],
    ['tracks-panel', 'Tracks'],
    ['sensitivity', 'Detection settings'],
    ['export-panel', 'Export'],
    ['model-attribution', 'Models'],
  ];

  function openTagOf(id) {
    const at = HTML.indexOf(`id="${id}"`);
    return HTML.slice(HTML.lastIndexOf('<details', at), HTML.indexOf('>', at) + 1);
  }

  it.each(CASES)('#%s is a details.panel-collapse with summary "%s"', (id, summaryText) => {
    const tag = openTagOf(id);
    expect(tag).toContain('<details');
    expect(tag).toContain('class="panel-collapse"');
    expect(tag).toMatch(/\bopen\b/);
    const summary = HTML.slice(
      HTML.indexOf('<summary>', HTML.indexOf(`id="${id}"`)),
      HTML.indexOf('</summary>', HTML.indexOf(`id="${id}"`)),
    );
    expect(summary).toContain(summaryText);
  });

  it('the #cap-report wrapper is a details.panel-collapse; the dynamic section inside is untouched', () => {
    const capAt = HTML.indexOf('id="cap-report"');
    const wrapAt = HTML.lastIndexOf('<details', capAt);
    const tag = HTML.slice(wrapAt, HTML.indexOf('>', capAt) + 1);
    expect(tag).toContain('class="panel-collapse"');
    expect(tag).toMatch(/\bopen\b/);
    expect(HTML.slice(wrapAt, capAt)).toContain('<summary>Capability report</summary>');
    // Inner dynamic ids survive exactly once (main.js re-render targets).
    expect(HTML.split('id="cap-report-body"').length - 1).toBe(1);
    expect(HTML.split('id="cap-guidance"').length - 1).toBe(1);
    // #file-info is NOT collapsible (too small).
    const infoAt = HTML.indexOf('id="file-info"');
    expect(HTML.slice(infoAt, HTML.indexOf('>', infoAt) + 1)).not.toContain('<details');
  });

  it('the old headings are gone (the summaries replaced them)', () => {
    expect(HTML).not.toContain('<h2>Capability report</h2>');
    expect(HTML).not.toContain('<h2>Tracks</h2>');
    expect(HTML).not.toContain('<h2>Export</h2>');
    expect(HTML).not.toContain('<h2>Models</h2>');
    expect(HTML).not.toContain('<h3>Compare thresholds</h3>');
  });

  it('summary styling exists: no UA marker, pointer cursor, ▸/▾ rotation', () => {
    const rule = cssRule('details.panel-collapse > summary');
    expect(rule).toContain('list-style: none');
    expect(rule).toContain('cursor: pointer');
    expect(HTML).toContain('details.panel-collapse > summary::-webkit-details-marker');
    expect(cssRule('details.panel-collapse > summary::before')).toContain("content: '▸'");
    expect(HTML).toMatch(
      /details\.panel-collapse\[open\] > summary::before\s*{[^}]*rotate\(90deg\)/,
    );
  });
});

// ---------------------------------------------------------------------------
// v1.13.0 item 4: detection-detail wording (option VALUES unchanged)
// ---------------------------------------------------------------------------

describe('v1.13.0: "Detection detail (analysis only)" wording', () => {
  it('renames the "Processing resolution" h3', () => {
    expect(HTML).toContain('<h3>Detection detail (analysis only)</h3>');
    expect(HTML).not.toContain('<h3>Processing resolution</h3>');
  });

  it('ships the new option labels with UNCHANGED values full/1080p/720p', () => {
    const sel = HTML.slice(
      HTML.indexOf('id="downscale-select"'),
      HTML.indexOf('</select>', HTML.indexOf('id="downscale-select"')),
    );
    expect(sel).toContain('<option value="full" selected>Full detail (slowest)</option>');
    expect(sel).toContain('<option value="1080p">Balanced — 1080p</option>');
    expect(sel).toContain('<option value="720p">Fast — 720p (lower detail)</option>');
  });

  it('adds the one-line analysis-only hint under the select', () => {
    const selEnd = HTML.indexOf('</select>', HTML.indexOf('id="downscale-select"'));
    const after = HTML.slice(selEnd, HTML.indexOf('</details>', selEnd));
    expect(after).toContain(
      '<p class="stat-line">Affects analysis speed only — the export always uses the full-resolution source.</p>',
    );
  });
});

// ---------------------------------------------------------------------------
// v1.22.0 REQ-204/205/206: zoom controls, peek button, waveform strip
// ---------------------------------------------------------------------------

describe('v1.22.0 REQ-204: timeline zoom controls in the transport bar', () => {
  it('ships #zoom-out / #zoom-in / #zoom-fit inside #transport-bar', () => {
    const bar = HTML.slice(
      HTML.indexOf('id="transport-bar"'),
      HTML.indexOf('</div>', HTML.indexOf('id="transport-bar"')),
    );
    expect(bar).toContain('id="zoom-out"');
    expect(bar).toContain('id="zoom-in"');
    expect(bar).toContain('id="zoom-fit"');
  });

  it('the zoom buttons carry accessible names + zoom hints', () => {
    expect(HTML).toContain('aria-label="Zoom in timeline"');
    expect(HTML).toContain('aria-label="Zoom out timeline"');
    expect(HTML).toContain('aria-label="Fit timeline view"');
    expect(HTML).toContain('ctrl+wheel zooms at the cursor');
  });
});

describe('v1.22.0 REQ-205: hold-to-peek button contract', () => {
  it('ships #peek-button with a hold instruction', () => {
    expect(HTML).toContain('id="peek-button"');
    expect(HTML).toContain('Hold to peek at the raw, unredacted frame');
  });

  it('the .peeking held-state styling exists (accent fill)', () => {
    expect(HTML).toContain('#peek-button.peeking');
  });

  it('the footer keyboard hints teach the A hold', () => {
    expect(HTML).toContain('<kbd>A</kbd> hold = peek raw');
  });
});

describe('v1.22.0 REQ-206: waveform strip contract', () => {
  it('ships a hidden #waveform canvas between the timeline and #below-timeline', () => {
    const start = HTML.indexOf('id="timeline"');
    const wave = HTML.indexOf('id="waveform"');
    const below = HTML.indexOf('id="below-timeline"');
    expect(start).toBeGreaterThan(-1);
    expect(wave).toBeGreaterThan(start);
    expect(below).toBeGreaterThan(wave);
    const tag = HTML.slice(wave - 8, wave + 120); // '<canvas ' is 8 chars
    expect(tag).toMatch(/<canvas id="waveform"[^>]*hidden/);
  });

  it('the #waveform CSS rule exists (strip styling + hidden state)', () => {
    expect(HTML).toContain('#waveform {');
    expect(HTML).toContain('#waveform[hidden]');
  });
});
