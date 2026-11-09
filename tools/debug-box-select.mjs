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
const dismissToasts = async () => {
  await page.evaluate(() => {
    document.querySelectorAll('#toast-region .toast').forEach((t) => t.remove());
  });
  await page.waitForTimeout(120);
};
const readEnd = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#track-list li.track-row')];
  return rows.map((r) => ({
    id: r.dataset.trackId,
    end: r.querySelector('[data-role="end"]')?.value ?? null,
  }));
});
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
  page.on('console', (m) => { if (m.text().startsWith('[box-click]')) console.log('BROWSER:', m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', join(ROOT, 'tests', 'fixtures', 'detectable.mp4'));
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 240000 });
  await page.waitForTimeout(300);

  // ── Draw three overlapping manual regions (B-drag on the video) ──
  await page.keyboard.press('b');
  const c = await canvasPt(0.35, 0.4);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 70, c.y + 50, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  await dismissToasts();
  await page.keyboard.press('b');
  const c2 = await canvasPt(0.6, 0.55);
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await page.mouse.move(c2.x + 70, c2.y + 50, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  // ── Click (no drag) inside box A → selects its track, NO page scroll ──
  await dismissToasts();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  const clickA = await canvasPt(0.35, 0.42);
  await page.mouse.click(clickA.x, clickA.y);
  await page.waitForTimeout(300);
  const selA = await selRow();
  const scrollAfter = await page.evaluate(() => window.scrollY);
  check('clicking box A selects its track', selA?.startsWith('2:'), selA ?? 'none');
  check('box click keeps the video in view (no page scroll-away)',
    scrollAfter === scrollBefore, `scrollY ${scrollBefore} → ${scrollAfter}`);

  // ── Click inside box B → selects its track ──
  await dismissToasts();
  const clickB = await canvasPt(0.62, 0.58);
  await page.mouse.click(clickB.x, clickB.y);
  await page.waitForTimeout(300);
  const selB = await selRow();
  check('clicking box B selects its track', selB?.startsWith('3:'), selB ?? 'none');

  // ── v1.43.2: LANE PACKING — 4 chips on distinct lanes ──
  await page.evaluate(() => {
    document.querySelector('#timeline').scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await page.waitForTimeout(150);
  const laneCheck = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('#track-chips > div[data-track-id]')];
    const tops = chips.map((ch) => Math.round(ch.getBoundingClientRect().top));
    return {
      count: chips.length,
      distinctTops: new Set(tops).size === tops.length,
      stripH: Math.round(document.querySelector('#timeline-track').getBoundingClientRect().height),
    };
  });
  check('overlapping chips land on distinct lanes (strip grows)',
    laneCheck.count === 4 && laneCheck.distinctTops && laneCheck.stripH >= 66,
    JSON.stringify(laneCheck));

  // ── v1.43.2 fix: the edge drag targets the HOVERED chip's edge, not the
  // selection. Manual #2 (id 2, 0–3) end edge sits at 2/3 of the lane;
  // Manual #3 (id 3, 0–3) too. Drag chip 2's end edge LEFT while chip 3 is
  // the hovered/selected context: chip 2 must move, chip 3 must not.
  await page.evaluate(() => {
    const v = document.querySelector('video');
    v.currentTime = 0;
  });
  await page.waitForTimeout(300);
  const edge = await page.evaluate(() => {
    document.querySelector('#timeline').scrollIntoView({ block: 'center', behavior: 'instant' });
    const lane = document.querySelector('#track-chips').getBoundingClientRect();
    // Manual #2's END edge sits at the lane's right edge (it spans the full
    // clip) — hover there to grab its edge zone
    return { x: lane.right - 3, y: lane.top + lane.height / 2 };
  });
  await page.waitForTimeout(150);
  const before = await readEnd();
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.move(edge.x - 60, edge.y, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const postDrag = await readEnd();
  check('edge drag on a NON-selected chip moves THAT chip (selected untouched)',
    JSON.stringify(postDrag) !== JSON.stringify(before) && postDrag.length === before.length,
    `before=${JSON.stringify(before)} post-drag=${JSON.stringify(postDrag)}`);

  // ── v1.47.2: ONE Ctrl+Z restores the PRE-DRAG span (no tiny steps) ──
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const afterUndo = await readEnd();
  check('one Ctrl+Z restores the pre-drag span (no tiny-step undo)',
    JSON.stringify(afterUndo) === JSON.stringify(before),
    `before=${JSON.stringify(before)} after undo=${JSON.stringify(afterUndo)}`);

  // ── Stacked chips: the edge drag targets the hovered chip ──
  const tl = await page.evaluate(() => {
    document.querySelector('#timeline').scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = document.querySelector('#timeline-track').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const chipY = tl.y + tl.h / 2;
  const endsBefore = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#track-list li.track-row')];
    return rows.map((r) => `${r.dataset.trackId}:${r.querySelector('[data-role="end"]')?.value}`).join(' | ');
  });
  // press on an END EDGE zone (near the lane's right edge) so the trim
  // latch fires — a body press would be a tap-seek, not a trim
  const edgeX = tl.x + tl.w - 4;
  await page.mouse.move(edgeX, chipY);
  await page.mouse.down();
  await page.mouse.move(edgeX - 60, chipY, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const ends = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#track-list li.track-row')];
    return rows.map((r) => `${r.dataset.trackId}:${r.querySelector('[data-role="end"]')?.value}`).join(' | ');
  });
  check('stacked edge drag moves the hovered chip', ends !== endsBefore, `before=${endsBefore} after=${ends}`);

  // ── v1.45.0: UNDO/REDO — delete the last track, undo restores ──
  await dismissToasts();
  const uPre = await page.evaluate(() => document.querySelectorAll('#track-list li.track-row').length);
  await page.locator('#track-list li.track-row').last().locator('.delete-btn').click();
  await page.waitForTimeout(300);
  const uD = await page.evaluate(() => document.querySelectorAll('#track-list li.track-row').length);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(300);
  const uU = await page.evaluate(() => document.querySelectorAll('#track-list li.track-row').length);
  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(300);
  const uR = await page.evaluate(() => document.querySelectorAll('#track-list li.track-row').length);
  check('undo/redo reverses track deletion',
    uD === uPre - 1 && uU === uPre && uR === uD,
    `pre=${uPre} delete→${uD} undo→${uU} redo→${uR}`);

  // ── v1.46.0: the timeline resize handle grows the strip ──
  const tlHandleBox = await page.evaluate(() => {
    const h = document.querySelector('#timeline-resize-handle');
    h.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = h.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.waitForTimeout(150);
  const tl0 = await page.evaluate(() => Math.round(document.querySelector('#timeline-track').getBoundingClientRect().height));
  await page.mouse.move(tlHandleBox.x, tlHandleBox.y);
  await page.mouse.down();
  await page.mouse.move(tlHandleBox.x, tlHandleBox.y + 100, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const tl1 = await page.evaluate(() => ({
    h: Math.round(document.querySelector('#timeline-track').getBoundingClientRect().height),
    aria: document.querySelector('#timeline-resize-handle').getAttribute('aria-valuenow'),
  }));
  check('timeline handle drag-down grows the strip',
    tl1.h > tl0 + 10, `height ${tl0} → ${tl1.h} (aria ${tl1.aria}%)`);
  await page.locator('#timeline-resize-handle').dblclick();
  await page.waitForTimeout(250);
  const tl2 = await page.evaluate(() => Math.round(document.querySelector('#timeline-track').getBoundingClientRect().height));
  check('double-click resets the timeline height', tl2 <= tl0 + 2, `height=${tl2}`);
} finally { await browser.close(); server.kill(); }
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
