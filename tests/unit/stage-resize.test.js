/**
 * stage-resize.test.js — v1.2.0 preview-stage height model (pure) + the
 * static wiring of the #stage-resize-handle in index.html.
 *
 * Covers the two pure helpers main.js exports for the drag handle:
 *   clampStageHeight(px, viewportH)   → clamped integer height
 *                                      [220, round(0.75·viewportH)]
 *   nextStageHeight(px, delta, vh)    → keyboard step (±24 px), then clamp
 * plus the index.html contract main.js's DOM wiring relies on: the handle
 * element (separator semantics, focusable, labelled, aria-valuemin bound)
 * sits between #preview-stage and #transport-bar, and the stage height is
 * driven by the --stage-h custom property (fullscreen/zoom reset it).
 *
 * The pointer/keyboard handlers themselves are DOM wiring inside mountApp()
 * and stay untested here (node has no DOM) — same split as main-wiring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_STAGE_HEIGHT_PX,
  STAGE_HEIGHT_STEP_PX,
  STAGE_MIN_HEIGHT_PX,
  clampStageHeight,
  nextStageHeight,
} from '../../src/main.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('clampStageHeight (v1.2.0 drag-handle clamp)', () => {
  it('clamps below the 220 px minimum up to the bound', () => {
    expect(clampStageHeight(0, 1080)).toBe(220);
    expect(clampStageHeight(50, 1080)).toBe(220);
    expect(clampStageHeight(219.4, 1080)).toBe(220); // rounds up into the min
  });

  it('clamps above the 75vh maximum down to the bound', () => {
    // 75% of 1080 = 810
    expect(clampStageHeight(810.4, 1080)).toBe(810);
    expect(clampStageHeight(1200, 1080)).toBe(810);
    expect(clampStageHeight(50000, 2160)).toBe(1620); // 75% of 2160
  });

  it('keeps exact edge values unchanged (edges are inclusive)', () => {
    expect(clampStageHeight(STAGE_MIN_HEIGHT_PX, 1080)).toBe(STAGE_MIN_HEIGHT_PX);
    expect(clampStageHeight(810, 1080)).toBe(810); // exactly round(0.75·1080)
    expect(clampStageHeight(450, 1080)).toBe(450); // free mid-range value
  });

  it('returns an integer even for fractional input', () => {
    expect(Number.isInteger(clampStageHeight(300.7, 1080))).toBe(true);
    expect(clampStageHeight(300.7, 1080)).toBe(301);
    expect(clampStageHeight(299.2, 1080)).toBe(299);
  });

  it('recomputes the 75vh bound as the viewport varies', () => {
    expect(clampStageHeight(2000, 800)).toBe(600); // 75% of 800
    expect(clampStageHeight(2000, 300)).toBe(225); // 75% of 300
    expect(clampStageHeight(2000, 400)).toBe(300);
    expect(clampStageHeight(100, 400)).toBe(220); // min still wins down here
  });

  it('never lets the viewport max fall below the minimum (tiny viewports)', () => {
    // 75% of 280 rounds to 210 < 220 → the max floor keeps 220 reachable.
    expect(clampStageHeight(2000, 280)).toBe(220);
    expect(clampStageHeight(2000, 1)).toBe(220);
    expect(clampStageHeight(2000, 293)).toBe(220); // round(219.75) = 220 exactly
  });

  it('drops the upper bound when the viewport is unknown, min still enforced', () => {
    for (const viewportH of [0, -5, NaN, Infinity]) {
      expect(clampStageHeight(5000, viewportH)).toBe(5000);
      expect(clampStageHeight(100, viewportH)).toBe(220);
    }
  });

  it('degrades non-finite heights to the default, still clamped', () => {
    expect(clampStageHeight(NaN, 1080)).toBe(DEFAULT_STAGE_HEIGHT_PX);
    // Infinity is non-finite → degrades to the default (320), which is in range.
    expect(clampStageHeight(Infinity, 1080)).toBe(DEFAULT_STAGE_HEIGHT_PX);
    expect(clampStageHeight(NaN, 280)).toBe(220); // tiny viewport clamps it
    expect(Number.isInteger(clampStageHeight(NaN, 1080))).toBe(true);
  });

  it('keeps the documented constants consistent with the clamp', () => {
    expect(STAGE_MIN_HEIGHT_PX).toBe(220);
    expect(DEFAULT_STAGE_HEIGHT_PX).toBe(320);
    expect(STAGE_HEIGHT_STEP_PX).toBe(24);
    expect(clampStageHeight(DEFAULT_STAGE_HEIGHT_PX, 1080)).toBe(DEFAULT_STAGE_HEIGHT_PX);
  });
});

describe('nextStageHeight (v1.2.0 keyboard step, ±24 px)', () => {
  it('steps up and down by exactly STAGE_HEIGHT_STEP_PX in free range', () => {
    expect(nextStageHeight(320, 24, 1080)).toBe(344);
    expect(nextStageHeight(320, -24, 1080)).toBe(296);
    expect(nextStageHeight(320, STAGE_HEIGHT_STEP_PX, 1080)).toBe(
      320 + STAGE_HEIGHT_STEP_PX,
    );
  });

  it('clamps the step at both bounds', () => {
    expect(nextStageHeight(230, -24, 1080)).toBe(220); // would go below min
    expect(nextStageHeight(800, 24, 1080)).toBe(810); // 824 → 75vh max 810
    expect(nextStageHeight(800, -24, 1080)).toBe(776); // free room below
    expect(nextStageHeight(220, -24, 1080)).toBe(220); // pinned at min
    expect(nextStageHeight(810, 24, 1080)).toBe(810); // pinned at max
  });

  it('follows viewport variation (75vh recomputed per step)', () => {
    expect(nextStageHeight(500, 24, 400)).toBe(300); // 524 → max 300
    expect(nextStageHeight(500, -24, 400)).toBe(300); // 476 still above max → clamped
    expect(nextStageHeight(500, 24, 280)).toBe(220); // tiny viewport floor
    expect(nextStageHeight(500, -1000, 400)).toBe(220); // deep below → min
  });

  it('degrades non-finite input without crashing', () => {
    expect(nextStageHeight(NaN, 24, 1080)).toBe(344); // default 320 + 24
    expect(nextStageHeight(320, NaN, 1080)).toBe(320); // no-op step
    expect(nextStageHeight(320, Infinity, 1080)).toBe(320); // non-finite step → no-op
  });

  it('always returns integers', () => {
    expect(Number.isInteger(nextStageHeight(319.5, 24, 1080))).toBe(true);
    expect(nextStageHeight(319.5, 24, 1080)).toBe(344);
  });
});

describe('stage-resize-handle static wiring (index.html contract)', () => {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

  it('hosts a focusable separator handle with the documented a11y attributes', () => {
    expect(html).toContain('id="stage-resize-handle"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="horizontal"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Resize preview height"');
    // aria-valuemin mirrors the pure clamp bound (main.js STAGE_MIN_HEIGHT_PX).
    expect(html).toContain(`aria-valuemin="${STAGE_MIN_HEIGHT_PX}"`);
  });

  it('sits between the preview stage and the transport bar (outside all existing pointer paths)', () => {
    const stageIdx = html.indexOf('id="preview-stage"');
    const handleIdx = html.indexOf('id="stage-resize-handle"');
    const transportIdx = html.indexOf('id="transport-bar"');
    expect(stageIdx).toBeGreaterThan(-1);
    expect(handleIdx).toBeGreaterThan(stageIdx);
    expect(transportIdx).toBeGreaterThan(handleIdx);
    // A sibling element — never a child of the stage (overlay drags and the
    // fullscreen button must not hit it).
    expect(html.slice(stageIdx, handleIdx)).not.toContain('stage-resize-handle');
  });

  it('sizes the stage through the --stage-h custom property with the 320 px fallback', () => {
    expect(html).toContain('height: var(--stage-h, 320px)');
    // Fullscreen/zoom modes must release the fixed height (UA/inset sizing).
    expect(html).toMatch(/#preview-stage:fullscreen\s*\{[^}]*height: auto;/);
    expect(html).toMatch(/#preview-stage\.preview-zoom\s*\{[^}]*height: auto;/);
  });
});
