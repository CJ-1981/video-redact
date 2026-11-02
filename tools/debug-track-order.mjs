#!/usr/bin/env node
// @ts-nocheck
/** debug-track-order.mjs — field report: "when track unchecked, it jumps to
 *  top of the tracks list, shall stay current position." Reproduces the row
 *  order before/after each checkbox toggle. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8183;
const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const order = () => page.evaluate(() =>
  [...document.querySelectorAll('#track-list li.track-row')].map(
    (r) => `${r.dataset.trackId}:${r.querySelector('.label')?.textContent.trim() ?? '?'}:${r.querySelector('input[type=checkbox]')?.checked ? 'ON' : 'off'}`,
  ).join(' | '));
try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', join(ROOT, 'tests', 'fixtures', 'detectable.mp4'));
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  // Draw a manual region BEFORE analyze (real UI: B + canvas drag) so the
  // review list has TWO rows (merge keeps manual first, appends analyzed).
  await page.keyboard.press('b');
  const canvas = await page.locator('#overlay-canvas').boundingBox();
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 240000 });
  console.log('initial :', await order());

  // Three more manual regions (post-analysis draws append to the array).
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('b');
    await page.mouse.move(cx + 10 + i * 5, cy + 10);
    await page.mouse.down();
    await page.mouse.move(cx + 70 + i * 5, cy + 50, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  console.log('5 rows  :', await order());

  // Uncheck the MIDDLE row, then the FIRST row.
  await page.locator('#track-list li.track-row').nth(2).locator('input[type=checkbox]').click();
  await page.waitForTimeout(250);
  console.log('mid off :', await order());
  await page.locator('#track-list li.track-row').first().locator('input[type=checkbox]').click();
  await page.waitForTimeout(250);
  console.log('first off:', await order());

  // Uncheck via the CHIP DOUBLE-CLICK surface (same hook from the timeline).
  // A real Playwright dblclick fights the live re-render (click 1 toggles →
  // refresh replaces the element) — dispatch the event with real coordinates.
  await page.evaluate(() => {
    const chip = document.querySelectorAll('#track-chips div[data-track-id]')[3];
    const r = chip.getBoundingClientRect();
    chip.dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
  });
  await page.waitForTimeout(250);
  console.log('dblclick:', await order());

  // Toggle while a class FILTER is active (filter = Manual), then All.
  await page.locator('#track-filter .filter-btn[data-filter="manual"]').click();
  await page.waitForTimeout(250);
  console.log('filtered:', await order());
  await page.locator('#track-list li.track-row').first().locator('input[type=checkbox]').click();
  await page.waitForTimeout(250);
  console.log('filt off:', await order());
  await page.locator('#track-filter .filter-btn[data-filter="all"]').click();
  await page.waitForTimeout(250);
  console.log('all again:', await order());

  // Uncheck the LAST row (Manual #2) via its checkbox.
  await page.locator('#track-list li.track-row').last().locator('input[type=checkbox]').click();
  await page.waitForTimeout(300);
  console.log('after LAST off:', await order());

  // Uncheck the FIRST row (Face #1) too.
  await page.locator('#track-list li.track-row').first().locator('input[type=checkbox]').click();
  await page.waitForTimeout(300);
  console.log('after FIRST off:', await order());

  // Re-check both (the flip back path).
  await page.locator('#track-list li.track-row').first().locator('input[type=checkbox]').click();
  await page.waitForTimeout(300);
  console.log('after FIRST on :', await order());
  await page.locator('#track-list li.track-row').last().locator('input[type=checkbox]').click();
  await page.waitForTimeout(300);
  console.log('after LAST on :', await order());

  // ── v1.40.3: scrolled-list uncheck must NOT reset scrollTop ─────────────
  // Field report (11+ plate tracks): unchecking a track snapped the list to
  // the top — the old renderer MOVED every row on every render and the
  // pluck-and-reinsert transiently shrank the scrollable content, so the
  // browser clamped scrollTop. Shrink the list, scroll to the bottom,
  // uncheck the bottom row: the scroll position must stay.
  let failures = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
    if (!ok) failures += 1;
  };
  await page.evaluate(() => {
    document.querySelector('#track-list').style.maxHeight = '120px';
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const list = document.querySelector('#track-list');
    list.scrollTop = list.scrollHeight; // bottom
  });
  await page.waitForTimeout(200);
  const atBottom = await page.evaluate(() => document.querySelector('#track-list').scrollTop);
  await page.locator('#track-list li.track-row').last().locator('input[type=checkbox]').click();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => ({
    st: document.querySelector('#track-list').scrollTop,
    bottomRow: [...document.querySelectorAll('#track-list li.track-row')].pop().dataset.trackId,
  }));
  check(
    'unchecking a bottom row keeps the list scroll position',
    Math.abs(after.st - atBottom) <= 2,
    `scrollTop ${atBottom} → ${after.st}`,
  );
  check('bottom row stays at the bottom', after.bottomRow === '5', `last=${after.bottomRow}`);
  console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally { await browser.close(); server.kill(); }
