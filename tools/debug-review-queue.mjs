#!/usr/bin/env node
// @ts-nocheck
/** debug-review-queue.mjs — v1.41.0 triage aids: class group rows + the
 *  review queue (playhead walks each redacting track's span; A/S/D decide). */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8185;
const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failures += 1; };
const order = () => page.evaluate(() => [...document.querySelectorAll('#track-list li.track-row')].map((r) => `${r.dataset.trackId}:${r.querySelector('input[type=checkbox]')?.checked ? 'ON' : 'off'}`).join(' | '));
try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', join(ROOT, 'tests', 'fixtures', 'detectable.mp4'));
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.keyboard.press('b');
  const canvas = await page.locator('#overlay-canvas').boundingBox();
  await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvas.x + canvas.width / 2 + 90, canvas.y + canvas.height / 2 + 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 240000 });

  // Group rows: Faces (1) + Manual (1) with both actions.
  const groups = await page.evaluate(() =>
    [...document.querySelectorAll('#track-groups .track-group')].map((g) => ({
      name: g.querySelector('.group-name')?.textContent,
      actions: [...g.querySelectorAll('.group-btn')].map((b) => b.dataset.action),
    })));
  check('group rows render per class', JSON.stringify(groups) === JSON.stringify([
    { name: 'Faces (1)', actions: ['redact', 'visible'] },
    { name: 'Manual (1)', actions: ['redact', 'visible'] },
  ]), JSON.stringify(groups));

  // Group toggle: Manual (1) → Keep visible.
  await page.locator('#track-groups .track-group', { hasText: 'Manual' }).locator('.group-btn[data-action="visible"]').click();
  await page.waitForTimeout(300);
  const afterGroup = await order();
  check('Manual → Keep visible disables only manuals', afterGroup === '1:off | 2:ON', afterGroup);

  // Review queue: button label reflects the 1 remaining redaction.
  const btnText = await page.textContent('#review-queue-button');
  check('review button counts enabled tracks', btnText.trim() === 'Review 1 redaction', btnText);

  // Re-enable manuals, start the queue.
  await page.locator('#track-groups .track-group', { hasText: 'Manual' }).locator('.group-btn[data-action="redact"]').click();
  await page.waitForTimeout(250);
  await page.click('#review-queue-button');
  await page.waitForTimeout(400);
  const cardState = await page.evaluate(() => ({
    hidden: document.querySelector('#review-queue-card').hidden,
    count: document.querySelector('#review-queue-count')?.textContent,
    label: document.querySelector('#review-queue-label')?.textContent,
    playing: !document.querySelector('video').paused,
  }));
  check('queue card presents track 1/2 and plays', !cardState.hidden && cardState.count === '1 / 2' && cardState.playing, JSON.stringify(cardState));

  // S = keep visible → advance to track 2.
  await page.keyboard.press('s');
  await page.waitForTimeout(400);
  const midState = await page.evaluate(() => ({
    count: document.querySelector('#review-queue-count')?.textContent,
    hidden: document.querySelector('#review-queue-card').hidden,
  }));
  check('S keeps visible and advances', midState.count === '2 / 2' && !midState.hidden, JSON.stringify(midState));

  // A = keep → queue completes; toast summarizes.
  await page.keyboard.press('a');
  await page.waitForTimeout(500);
  const endState = await page.evaluate(() => ({
    hidden: document.querySelector('#review-queue-card').hidden,
    toast: [...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' | '),
    row0: document.querySelector('#track-list li.track-row input[type=checkbox]')?.checked,
  }));
  check('A keeps + queue completes with summary toast',
    endState.hidden && /Review complete — 1 kept redacting, 1 kept visible/.test(endState.toast) && endState.row0 === false,
    JSON.stringify(endState));

  // Esc closes a restarted queue; group order still intact.
  await page.click('#review-queue-button');
  await page.waitForTimeout(250);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const closed = await page.evaluate(() => document.querySelector('#review-queue-card').hidden);
  check('Esc closes the queue', closed === true, `hidden=${closed}`);
  console.log('final order:', await order());
} finally { await browser.close(); server.kill(); }
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
