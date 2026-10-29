/**
 * fixtures.js — shared Playwright test fixtures for the E2E suite (T-701).
 *
 * One browser context is shared across the whole worker (workers: 1 in
 * playwright.config.js), so the IndexedDB model cache and the HTTP cache are
 * warm for every spec after the first download — the offline-models spec
 * (AC-10) depends on models being cached by earlier specs, and reruns after a
 * retry don't re-pay the ~40 MB first-run download (perf gate P-4).
 *
 * Import { test, expect } from this file in every spec.
 */
import { test as base, expect } from '@playwright/test';

export { expect };

export const test = base.test.extend({
  /** Worker-scoped shared browser context (IndexedDB + HTTP cache persist). */
  sharedContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],

  /** Long-lived page inside the shared context; each test navigates itself. */
  sharedPage: [
    async ({ sharedContext }, use) => {
      const page = await sharedContext.newPage();
      await use(page);
      await page.close();
    },
    { scope: 'worker' },
  ],
});
