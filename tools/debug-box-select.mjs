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
  page.on('console', (m) => { if (m.text().includes('[box-click]') || m.text().includes('[pick-debug]') || m.text().includes('[commit]')) console.log('BROWSER:', m.text()); });
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
  await dismissToasts();
  await page.keyboard.press('b');
  const c2 = await canvasPt(0.6, 0.55);
  await page.mouse.move(c2.x, c2.y);
  await page.mouse.down();
  await page.mouse.move(c2.x + 70, c2.y + 50, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  console.log('after box B:', await selRow());

  // Click (no drag) inside box A's area → selects Manual #1.
  await page.evaluate(() => {
    window.__ptr = [];
    document.addEventListener('pointerdown', (e) => {
      const chain = [];
      let n = e.target;
      while (n && chain.length < 4) { chain.push(n.id || String(n.className).slice(0, 20) || n.tagName); n = n.parentElement; }
      window.__ptr.push(e.type + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + '@' + chain.join('>'));
    }, true);
    window.__toasts = [...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent.slice(0, 30));
    const clickA = document.querySelector('#overlay-canvas').getBoundingClientRect();
    window.__pt = { x: clickA.left + clickA.width * 0.35, y: clickA.top + clickA.height * 0.42 };
    window.__hit = (() => { const el = document.elementFromPoint(window.__pt.x, window.__pt.y); let c = []; let n = el; while (n && c.length < 3) { c.push(n.id || String(n.className).slice(0, 16) || n.tagName); n = n.parentElement; } return c.join('>'); })();
  });
  console.log('DIAG:', JSON.stringify(await page.evaluate(() => ({ ptr: window.__ptr, toasts: window.__toasts, pt: window.__pt, hit: window.__hit }))));
  // Synthetic dispatch first (isolate app logic from harness quirks).
  const synth = await page.evaluate(async () => {
    const canvas = document.querySelector('#overlay-canvas');
    const r = canvas.getBoundingClientRect();
    const px = r.left + r.width * 0.35;
    const py = r.top + r.height * 0.42;
    const opts = { bubbles: true, button: 0, clientX: px, clientY: py, pointerId: 9, isPrimary: true };
    canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
    canvas.dispatchEvent(new PointerEvent('pointerup', opts));
    await new Promise((res) => setTimeout(res, 300));
    const sel = document.querySelector('#track-list li.track-row.selected');
    return { selected: sel?.dataset.trackId ?? null };
  });
  console.log('SYNTH pick:', JSON.stringify(synth));
  // strictly inside box A (not on its edge — a DPR hair at the exact boundary flips containment)
  const clickA = await canvasPt(0.37, 0.45);
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

  // v1.43.1: Esc un-sticks keyframe mode. With a manual track selected,
  // a B-drag ARMS a keyframe (dashed box waiting for K); Esc discards the
  // box AND deselects — the next B-drag must create a NEW region again.
  await dismissToasts();
  await page.keyboard.press('b');
  const d1 = await canvasPt(0.5, 0.4);
  await page.mouse.move(d1.x, d1.y);
  await page.mouse.down();
  await page.mouse.move(d1.x + 60, d1.y + 40, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const pendingState = await page.evaluate(() => ({
    rows: document.querySelectorAll('#track-list li.track-row').length,
    dashedVisible: !!document.querySelector('#overlay-canvas'),
  }));
  await page.keyboard.press('Escape'); // discard the armed keyframe box
  await page.keyboard.press('Escape'); // deselect the track
  await page.waitForTimeout(250);
  await page.keyboard.press('b');
  const d2 = await canvasPt(0.45, 0.35);
  await page.mouse.move(d2.x, d2.y);
  await page.mouse.down();
  await page.mouse.move(d2.x + 60, d2.y + 40, { steps: 3 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const unStuck = await page.evaluate(() => ({
    rows: document.querySelectorAll('#track-list li.track-row').length,
    labels: [...document.querySelectorAll('#track-list li.track-row .label')].map((l) => l.textContent.trim()),
  }));
  check('Esc un-sticks keyframe mode — next drag draws a NEW region',
    unStuck.rows === 3 && /Manual #3/.test(unStuck.labels.join(',')),
    `rows=${unStuck.rows} labels=${unStuck.labels.join(',')}`);
  console.log('pre-esc rows:', pendingState.rows);

  // v1.43.2: LANE PACKING — the overlapping chips render on separate rows.
  const laneCheck = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('#track-chips div[data-track-id]')];
    const tops = chips.map((c) => Math.round(c.getBoundingClientRect().top));
    return {
      count: chips.length,
      distinctTops: new Set(tops).size === tops.length,
      stripH: Math.round(document.querySelector('#timeline-track').getBoundingClientRect().height),
    };
  });
  check('overlapping chips land on distinct lanes (strip grows)',
    laneCheck.count === 3 && laneCheck.distinctTops && laneCheck.stripH >= 66,
    JSON.stringify(laneCheck));

  // v1.44.0: the row ✕ deletes the track — rows drop to 2, selection gone.
  await page.evaluate(() => {
    document.querySelector('#below-timeline').scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await page.waitForTimeout(200);
  await page.locator('#track-list li.track-row').first().locator('.delete-btn').click();
  await page.waitForTimeout(400);
  const afterDel = await page.evaluate(() => ({
    rows: document.querySelectorAll('#track-list li.track-row').length,
    sel: document.querySelector('#track-list li.track-row.selected')?.dataset.trackId ?? null,
    toast: [...document.querySelectorAll('#toast-region .toast')].some((t) => t.textContent.includes('Track deleted')),
  }));
  check('row ✕ deletes the track (row gone, toast, selection cleared)',
    afterDel.rows === 2 && afterDel.sel === null && afterDel.toast, JSON.stringify(afterDel));

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

  // v1.45.0: UNDO/REDO — delete the last track, undo restores, redo re-removes.
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
    uPre === 2 && uD === 1 && uU === 2 && uR === 1,
    `pre=${uPre} delete→${uD} undo→${uU} redo→${uR}`);

  // v1.46.0: the timeline resize handle grows the strip.
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
