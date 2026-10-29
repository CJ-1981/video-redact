#!/usr/bin/env node
/**
 * debug-export.mjs — reproduce the E2E export-ladder failure outside Playwright.
 * Spawns tools/serve.mjs, opens dist/index.html with console/pageerror capture,
 * opens tests/fixtures/synthetic.mp4, analyzes with dashcam OFF, exports, and
 * prints every console message + the final #export-status text.
 * Run: node tools/debug-export.mjs   (kills the spawned server on exit)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8189;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'synthetic.mp4');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (m) => console.log(`[console.${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('download', (d) => console.log('[download]', d.suggestedFilename()));

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });
  console.log('--- ready; starting analyze (dashcam OFF) ---');
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 240000 });
  console.log('--- review reached; starting export ---');
  await page.click('#export-button');
  const status = await page
    .waitForFunction(
      () => document.querySelector('#export-status')?.textContent?.length > 0,
      null,
      { timeout: 180000 },
    )
    .then(() => page.textContent('#export-status'))
    .catch((e) => `WAIT-FAILED: ${e.message.split('\n')[0]}`);
  console.log('--- final #export-status:', JSON.stringify(status));
  console.log('--- stepper:', await page.getAttribute('#stepper li#step-export', 'class'));
  await page.waitForTimeout(1500);
} finally {
  await browser.close();
  server.kill();
}
