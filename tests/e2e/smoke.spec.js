/**
 * smoke.spec.js — AC-19 (single-file artifact) + dev-shell boot.
 *
 * The built dist/index.html must boot over localhost with the pinned
 * importmap, no module fetches into dev sources, and the serve gate silent
 * (http://127.0.0.1 is a secure context). The dev index.html must boot too.
 */
import { test, expect } from './fixtures.js';

const PINNED_MEDIABUNNY = 'mediabunny@1.63.0';
const PINNED_ORT = 'onnxruntime-web@1.31.1';

test.describe('smoke — artifact boots (AC-19)', () => {
  test('dist/index.html boots self-contained with pinned CDN imports', async ({ sharedPage: page }) => {
    /** @type {string[]} */
    const requests = [];
    page.on('request', (req) => requests.push(req.url()));

    await page.goto('/dist/index.html', { waitUntil: 'load' });

    // Serve gate stays hidden over http://127.0.0.1 (secure context, REQ-004).
    const serveGate = page.locator('#serve-gate');
    await expect(serveGate).toBeHidden();

    // Workflow stepper rendered by the mounted app shell.
    await expect(page.locator('#stepper')).toBeVisible();
    await expect(page.locator('#stepper li#step-gate')).toHaveAttribute('aria-current', 'step');
    await expect(page.locator('#drop-zone')).toBeVisible();
    // Build marker stamped by mountApp (asserted by unit scaffold test too).
    await expect(page.locator('body')).toHaveAttribute('data-app-shell', 'video-redact dev shell');

    // Single-file guarantee: no runtime fetch into dev sources.
    const srcRequests = requests.filter((url) => /\/src\//.test(url));
    expect(srcRequests, `dist must not reference /src/ (${srcRequests.join(', ')})`).toEqual([]);

    // Importmap pins survive into the served artifact.
    const html = await (await page.request.get('/dist/index.html')).text();
    expect(html).toContain(PINNED_MEDIABUNNY);
    expect(html).toContain(PINNED_ORT);

    // The CDN libraries actually loaded through the pinned importmap (the
    // bundle boots only when its mediabunny import resolves).
    const mediabunnyLoaded = await page.evaluate(async () => {
      try {
        const M = await import('mediabunny');
        return typeof M.Output === 'function';
      } catch {
        return false;
      }
    });
    expect(mediabunnyLoaded).toBe(true);
  });

  test('dev index.html boots and pulls ./src/main.js', async ({ sharedPage: page }) => {
    /** @type {string[]} */
    const requests = [];
    page.on('request', (req) => requests.push(req.url()));

    await page.goto('/index.html', { waitUntil: 'load' });

    await expect(page.locator('#serve-gate')).toBeHidden();
    await expect(page.locator('#stepper')).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute('data-app-shell', 'video-redact dev shell');

    const mainRequested = requests.some((url) => /\/src\/main\.js/.test(url));
    expect(mainRequested, 'dev shell must load ./src/main.js').toBe(true);
  });
});
