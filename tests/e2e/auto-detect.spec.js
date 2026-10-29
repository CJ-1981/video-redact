/**
 * auto-detect.spec.js — AC-04 auto-detection on a VERIFIED-detectable fixture.
 *
 * journey.spec.js deliberately never asserts an auto-detected track count:
 * on its synthetic checkerboard pattern zero detections is an AC-13-legal
 * outcome. This spec is the complement: tests/fixtures/detectable.mp4 is
 * rendered from a portrait sample the production YuNet detector path verified
 * as detectable (provenance + detection count recorded in
 * tests/fixtures/fixture.json under `detectable.faces`), so a run that finds
 * ZERO face tracks here is a REAL regression signal, not flakiness.
 *
 * Flow (mirrors journey.spec.js exactly — same selectors, waits, export and
 * download handling; no novel interactions):
 *   open → intake + capability report → analyze (dashcam OFF) → review →
 *   assert ≥ 1 "Face #" row in #track-list → toggle it off/on via its list
 *   checkbox (disabled state: `enabled-off` row + "(visible)" title +
 *   safe-green chip) → export → download event fires and completes.
 *
 * In headless Chromium there is no saveHandle / showSaveFilePicker, so the
 * export takes exporter.js's Blob-download fallback — asserted via the page
 * `download` event + the "Exported" status, same as the journey.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
const DETECTABLE_VIDEO = `${FIXTURE_ROOT}detectable.mp4`;
const MANIFEST = JSON.parse(readFileSync(`${FIXTURE_ROOT}fixture.json`, 'utf8'));

/** Fixture-adaptivity guard: run only when the detectable fixture exists AND
 *  its manifest entry records a verified detection (outcome 'ok' — the
 *  generator documents failure as detectableFace.outcome 'failed' and writes
 *  no clip). Keeps the suite green if fixture.json is regenerated without the
 *  detectable entry. */
const faceEntry = MANIFEST.detectableFace;
const detectableReady =
  existsSync(DETECTABLE_VIDEO) &&
  Boolean(faceEntry) &&
  faceEntry.outcome === 'ok' &&
  Number(faceEntry.verifiedDetections) > 0;

test.describe('AC-04 auto-detection', () => {
  test.setTimeout(240_000); // models are cache-warm by earlier specs (workers=1)

  test('analyze detectable fixture → face track appears → toggle → export', async ({
    sharedPage: page,
  }) => {
    test.skip(
      !detectableReady,
      'tests/fixtures/detectable.mp4 (with a verified detectableFace entry in fixture.json) was not generated',
    );
    test.info().annotations.push({ type: 'fixture', description: 'detectable.mp4' });

    await page.goto('/dist/index.html', { waitUntil: 'load' });
    await expect(page.locator('#serve-gate')).toBeHidden();

    // ── 1. Intake + capability report (same waits as journey) ─────────────────
    await page.locator('#file-input').setInputFiles(DETECTABLE_VIDEO);

    const capReport = page.locator('#cap-report');
    await expect(capReport).toBeVisible();
    const decodeRow = capReport.locator('tr', { hasText: 'Video decode' });
    await expect(decodeRow.locator('td.cap-ok').first()).toBeVisible();
    await expect(page.locator('#analyze-button')).toBeEnabled();

    // ── 2. Analyze with dashcam OFF (single-pass detection, no tile sweep) ────
    // Fresh page + no `checked` attribute ⇒ the toggle starts unchecked;
    // uncheck() is idempotent, so mirror journey's pre-analyze toggle line.
    const dashcamToggle = page.locator('#dashcam-toggle');
    await expect(dashcamToggle).not.toBeChecked();
    await dashcamToggle.uncheck();
    await page.locator('#analyze-button').click();

    // Review state: editor mounted (same completion condition as journey).
    await expect(page.locator('#stepper li#step-review')).toHaveAttribute('aria-current', 'step', {
      timeout: 180_000,
    });
    await expect(page.locator('#analyze-status')).toContainText(/track\(s\)/);

    // ── 3. At least one auto-detected face track (AC-04) ──────────────────────
    // Track rows are li.track-row in #track-list whose .label reads "Face #N"
    // (src/editor.js render(); labels per src/types.js). Zero detections here
    // FAILS BY DESIGN — the fixture is verified-detectable.
    const faceRows = page.locator('#track-list li.track-row', { hasText: 'Face #' });
    await expect(faceRows.first(), 'verified-detectable fixture must produce ≥ 1 face track').toBeVisible();
    const faceCount = await faceRows.count();
    expect(faceCount, 'face track count from the verified-detectable fixture').toBeGreaterThan(0);
    test.info().annotations.push({ type: 'face-tracks', description: String(faceCount) });

    // ── 4. Toggle the first face track via its list checkbox (journey flow) ───
    const faceRow = faceRows.first();
    const checkbox = faceRow.locator('input[type="checkbox"]');
    await checkbox.uncheck();
    await expect(faceRow).toHaveClass(/enabled-off/);
    await expect(faceRow).toContainText('(visible)');
    // Exactly the toggled chip flips to the disabled "(visible)" title and the
    // safe-green "kept visible" color (src/editor.js render()).
    const visibleChip = page.locator('#track-chips div[title$="(visible)"]');
    await expect(visibleChip).toHaveCount(1);
    const safeGreen = 'rgb(62, 207, 142)'; // --safe
    await expect(visibleChip).toHaveCSS('background-color', safeGreen);

    await checkbox.check();
    await expect(faceRow).not.toHaveClass(/enabled-off/);
    await expect(page.locator('#track-chips div[title$="(visible)"]')).toHaveCount(0);
    await expect(page.locator('#track-chips div[title^="Face #"]').first()).not.toHaveCSS(
      'background-color',
      safeGreen,
    );

    // ── 5. Export: Blob-download path in headless (journey flow) ──────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await page.locator('#export-button').click();
    await expect(page.locator('#export-status')).toContainText('Exported', { timeout: 120_000 });
    const download = await downloadPromise;
    test.info().annotations.push({ type: 'download', description: download.suggestedFilename() });
    await expect(page.locator('#stepper li#step-export')).toHaveClass(/done/);
    await download.path(); // resolves only once the blob download has landed
  });
});
