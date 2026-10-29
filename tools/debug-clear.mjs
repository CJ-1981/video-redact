#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-clear.mjs — v1.6.0 clear-all probe (header "✕ Clear" button).
 *
 * Desktop viewport: loads tests/fixtures/detectable.mp4, waits for ready,
 * analyzes (models may download — warm-cache timeout 240 s), waits for the
 * review state, deliberately dirties the sensitivity sliders, then clicks
 * #clear-file and asserts the full teardown checklist:
 *   - stepper back to the capability gate (① aria-current)
 *   - track list emptied
 *   - #file-input value reset to '' (same-file re-select re-fires change)
 *   - capability report hidden
 *   - sliders restored to 0.60 / 0.25
 *   - #clear-file inert at the gate (hidden)
 *   - workspace hidden / drop zone back (landing view)
 *   - "Cleared — ready for the next video." toast shown
 * Then re-selects the SAME fixture file and asserts ready state returns
 * (proving the input reset works end-to-end).
 * Run: node tools/debug-clear.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8193;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  // Landing: the Clear button must be inert before anything is loaded.
  check(
    'clear button hidden at the gate (landing)',
    await page.locator('#clear-file').isHidden(),
    'nothing to clear before a file is opened',
  );

  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  check(
    'clear button visible once a file is loaded',
    await page.locator('#clear-file').isVisible(),
    'ready state',
  );

  await page.click('#analyze-button');
  await page.waitForSelector('#track-list li.track-row', { timeout: 240000 });
  const preRows = await page.locator('#track-list li.track-row').count();
  check('review state reached', preRows > 0, `${preRows} track row(s) before clear`);

  // Dirty the state so the reset assertions are meaningful: move BOTH
  // sensitivity sliders off their defaults + check dashcam mode.
  await page.locator('#conf-face').evaluate((el) => {
    el.value = '0.30';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#conf-plate').evaluate((el) => {
    el.value = '0.45';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#dashcam-toggle').check();

  await page.click('#clear-file');
  await page.waitForSelector('#workspace', { state: 'hidden', timeout: 10000 });

  const gateCurrent = await page
    .locator('#stepper li#step-gate')
    .getAttribute('aria-current');
  check(
    'stepper back to capability gate (① current)',
    gateCurrent === 'step',
    `aria-current=${String(gateCurrent)}`,
  );

  const postRows = await page.locator('#track-list li.track-row').count();
  check('track list emptied', postRows === 0, `${postRows} track row(s) after clear`);

  const inputValue = await page.locator('#file-input').inputValue();
  check(
    "file input value reset to '' (same-file re-select re-fires change)",
    inputValue === '',
    `value=${JSON.stringify(inputValue)}`,
  );

  const capHidden = await page.locator('#cap-report').isHidden();
  check('capability report hidden', capHidden, 'landing view has no report');

  const sliders = await page.evaluate(() => ({
    face: Number(document.querySelector('#conf-face')?.value),
    plate: Number(document.querySelector('#conf-plate')?.value),
    faceOut: document.querySelector('#conf-face-out')?.textContent ?? '',
    plateOut: document.querySelector('#conf-plate-out')?.textContent ?? '',
    dashcam: document.querySelector('#dashcam-toggle')?.checked ?? null,
  }));
  check(
    'sensitivity sliders back at defaults (0.60 / 0.25), readouts following',
    sliders.face === 0.6 &&
      sliders.plate === 0.25 &&
      sliders.faceOut === '0.60' &&
      sliders.plateOut === '0.25',
    `face=${sliders.face} ("${sliders.faceOut}"), plate=${sliders.plate} ("${sliders.plateOut}")`,
  );
  check('dashcam mode unchecked', sliders.dashcam === false, `checked=${sliders.dashcam}`);

  check(
    'clear button inert at the gate after clear',
    await page.locator('#clear-file').isHidden(),
    'hidden (nothing left to clear)',
  );

  const workspaceHidden = await page.locator('#workspace').isHidden();
  const dropZoneVisible = await page.locator('#drop-zone').isVisible();
  check(
    'landing view restored (workspace hidden, drop zone visible)',
    workspaceHidden && dropZoneVisible,
    `workspace hidden=${workspaceHidden}, drop zone visible=${dropZoneVisible}`,
  );

  const toastText = await page.locator('#toast-region .toast').last().textContent();
  check(
    'confirmation toast shown',
    /Cleared — ready for the next video\./.test(toastText ?? ''),
    JSON.stringify(toastText),
  );

  // Re-select the SAME file: only possible because the input was reset.
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  const reRows = await page.locator('#track-list li.track-row').count();
  const reClearVisible = await page.locator('#clear-file').isVisible();
  check(
    'ready state returns after re-selecting the SAME file (input reset works)',
    reRows === 0 && reClearVisible,
    `analyze enabled, ${reRows} track row(s) (fresh state), clear visible=${reClearVisible}`,
  );
} catch (err) {
  failures += 1;
  console.log(`FAIL  probe aborted  ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
