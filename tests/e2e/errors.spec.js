/**
 * errors.spec.js — AC-13 corrupt-input branch (REQ-021 pattern) + recovery.
 *
 * A file of random bytes must produce a readable ingest error (toast +
 * capability guidance), never a crash, and the app must return to a state
 * where opening a good file works.
 */
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));

test('corrupt file: readable ingest error, no crash, new file can be opened', async ({ sharedPage: page }) => {
  await page.goto('/dist/index.html', { waitUntil: 'load' });
  await expect(page.locator('#stepper li#step-gate')).toHaveAttribute('aria-current', 'step');

  // 64 KiB of deterministic random-ish bytes — no container magic anywhere.
  const corrupt = Buffer.from(
    Array.from({ length: 64 * 1024 }, (_, i) => (i * 37 + 11) & 0xff),
  );
  await page
    .locator('#file-input')
    .setInputFiles({ name: 'corrupt.mp4', mimeType: 'video/mp4', buffer: corrupt });

  // Readable, typed ingest error in the toast region (REQ-021).
  const errorToast = page.locator('#toast-region .toast.error', {
    hasText: /not supported|could not be read|Could not open/i,
  });
  await expect(errorToast.first()).toBeVisible();

  // The capability guidance records the failure too — note it lives INSIDE
  // #cap-report, which the failure path intentionally closes (the toast is
  // the visible surface), so assert the recorded text, not visibility.
  await expect(page.locator('#cap-guidance')).toHaveText(/not supported|could not be read/i);

  // No crash: the state machine fell back to the intake gate.
  await expect(page.locator('#stepper li#step-gate')).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#drop-zone')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();

  // Recovery: opening a valid file afterwards works normally.
  await page
    .locator('#file-input')
    .setInputFiles(`${FIXTURE_ROOT}synthetic.mp4`);
  await expect(page.locator('#workspace')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#analyze-button')).toBeEnabled();
  await expect(page.locator('#cap-report')).toContainText('avc');
});
