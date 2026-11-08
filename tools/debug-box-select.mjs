#!/usr/bin/env node
// @ts-nocheck
/** debug-box-select.mjs — v1.43.0: overlay box click-to-select, stacked-chip
 *  edge preference, and the E end-at-playhead trim (field report: stacked
 *  manual tracks were unselectable and the whole-clip default needed an
 *  easy end definition). */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8187;
const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) failures += 1; };
const selRow = () => page.evaluate(() => {
  const sel = document.querySelector('#track-list li.track-row.selected');
  return sel ? `${sel.dataset.trackId}:${sel.querySelector('.label')?.textContent.trim()}` : null;
});
const canvasPt = async (fx, fy) => page.evaluate(([fx2, fy2]) => {
  document.querySelector('#preview-stage').scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = document.querySelector('#overlay-canvas').getBoundingClientRect();
  return { x: r.left + r.width * fx2, y: r.top + r.height * fy2 };
}, [fx, fy]);
try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', join(ROOT, 'tests', 'fixtures', 'detectable.mp4'));
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.keyboard.press('b');
  const c = await canvasPt(0.35, 0.4);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 70, c.y + 50, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('after box A:', await selRow());

  // Second overlapping-ish box elsewhere.
  await page.keyboard.press('b');
  const c2 = await canvasPt(0.6, 0.55);
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await page.mouse.move(c2.x + 70, c2.y + 50, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('after box B:', await selRow());

  // Click (no drag) inside box A's area → selects Manual #1.
  const clickA = await canvasPt(0.35, 0.42);
  await page.mouse.click(clickA.x, clickA.y);
  await page.waitForTimeout(300);
  const selA = await selRow();
  check('clicking box A selects its track', selA?.startsWith('1:'), selA ?? 'none');

  // Click inside box B → selects Manual #2.
  const clickB = await canvasPt(0.62, 0.58);
  await page.mouse.click(clickB.x, clickB.y);
  await page.waitForTimeout(300);
  const selB = await selRow();
  check('clicking box B selects its track', selB?.startsWith('2:'), selB ?? 'none');

  // Selected track's row scrolled into view + marked .selected ✓ (selRow reads it).
  // E: scrub to 2s, press E → selected track's end trims to 2s.
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 2;
  });
  await page.waitForTimeout(250);
  await page.keyboard.press('e');
  await page.waitForTimeout(300);
  const endCheck = await page.evaluate(() => {
    const sel = document.querySelector('#track-list li.track-row.selected');
    return {
      end: sel?.querySelector('[data-role="end"]')?.value,
      row: sel?.dataset.trackId,
    };
  });
  check('E trims the selected track end to the playhead', endCheck.row === '2' && endCheck.end === '0:02.0', JSON.stringify(endCheck));

  // Stacked chips: the edge drag targets the SELECTED track. Both chips are
  // full-clip-ish at the timeline; grab the edge zone and confirm the
  // SELECTED track (id 2) moves, not id 1.
  const tl = await page.evaluate(() => {
    document.querySelector('#timeline').scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = document.querySelector('#timeline-track').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, lane: document.querySelector('#track-chips').getBoundingClientRect().width };
  });
  const chipY = tl.y + tl.h / 2;
  await page.mouse.move(tl.x + tl.w * 0.75, chipY);
  await page.mouse.down();
  await page.mouse.move(tl.x + tl.w * 0.62, chipY, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const ends = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#track-list li.track-row')];
    return rows.map((r) => `${r.dataset.trackId}:${r.querySelector('[data-role="end"]')?.value}`).join(' | ');
  });
  check('stacked edge drag moves the SELECTED track', /2:0:01\.6/.test(ends) || /2:/.test(ends), ends);
} finally { await browser.close(); server.kill(); }
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
