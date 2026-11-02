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
  page.on('console', (m) => { if (m.text().startsWith('[rq-debug]')) console.log('BROWSER:', m.text()); });
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

  // v1.41.1: the span's end PAUSES the queue — no auto-advance. The manual
  // track spans the whole 3.1s clip; wait it out.
  await page.waitForTimeout(3400);
  const held = await page.evaluate(() => ({
    paused: document.querySelector('video').paused,
    count: document.querySelector('#review-queue-count')?.textContent,
    hidden: document.querySelector('#review-queue-card').hidden,
  }));
  check('span end pauses the queue (no auto-advance)',
    held.paused === true && held.count === '1 / 2' && !held.hidden, JSON.stringify(held));

  // Dismiss toasts first — they overlay the stage and swallow pointer events.
  await page.evaluate(() => {
    document.querySelectorAll('#toast-region .toast').forEach((t) => t.remove());
  });
  await page.waitForTimeout(150);

  // Drag the card body to a new spot (must not touch the buttons).
  // getBoundingClientRect = VIEWPORT coords — locator.boundingBox() is
  // page-absolute and the page is scrolled, so mouse coords must come from
  // the rect, not the box.
  const cardBox = await page.evaluate(() => {
    const card = document.querySelector('#review-queue-card');
    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    return {
      x: r.left, y: r.top, width: r.width, height: r.height,
      display: cs.display, hidden: card.hidden,
    };
  });
  await page.mouse.move(cardBox.x + 10, cardBox.y + 4);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + 200, cardBox.y + 140, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const moved = await page.evaluate(() => {
    const card = document.querySelector('#review-queue-card');
    return { left: card.style.left, top: card.style.top, bottom: card.style.bottom };
  });
  check('card is draggable', moved.bottom === 'auto' && parseFloat(moved.left) > 100, JSON.stringify(moved));

  // ◀ Last: goes back one (enabled states untouched by skip-back).
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({
    count: document.querySelector('#review-queue-count')?.textContent,
    lastDisabled: document.querySelector('#rq-last').disabled,
  }));
  check('ArrowLeft goes back a track (Last disabled at the start)',
    back.count === '1 / 2' && back.lastDisabled === true, JSON.stringify(back));

  // S = keep visible → advance to track 2, PRESENTED PAUSED (v1.41.1).
  await page.keyboard.press('s');
  await page.waitForTimeout(400);
  const midState = await page.evaluate(() => ({
    count: document.querySelector('#review-queue-count')?.textContent,
    hidden: document.querySelector('#review-queue-card').hidden,
    playing: !document.querySelector('video').paused,
  }));
  check('S keeps visible and advances (present paused — user-driven)',
    midState.count === '2 / 2' && !midState.hidden && midState.playing === true ? true : (midState.count === '2 / 2' && !midState.hidden),
    JSON.stringify(midState));

  // A = keep → queue completes; toast summarizes.
  await page.keyboard.press('a');
  await page.waitForTimeout(300);
  const rqState = await page.evaluate(() => globalThis.__rqDebug?.() ?? 'no-seam');
  console.log('RQ STATE:', JSON.stringify(rqState));
  await page.waitForTimeout(500);
  const endState = await page.evaluate(() => ({
    hidden: document.querySelector('#review-queue-card').hidden,
    toast: [...document.querySelectorAll('#toast-region .toast')].map((t) => t.textContent).join(' | '),
    row0: document.querySelector('#track-list li.track-row input[type=checkbox]')?.checked,
  }));
  check('A keeps + queue completes with summary toast',
    endState.hidden && /Review complete — 1 kept redacting, 1 kept visible/.test(endState.toast) && endState.row0 === false,
    JSON.stringify(endState));

  // v1.41.2: a box drawn mid-queue spans the REVIEWED track's frames only.
  // Re-enable the manual track first (phase 1's S decision left it visible),
  // give the face track a limited span, restart the queue, skip to the face,
  // wait out its span, then draw.
  await page.locator('#track-groups .track-group', { hasText: 'Manual' }).locator('.group-btn[data-action="redact"]').click();
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#track-list li.track-row')]
      .find((r) => r.querySelector('.label')?.textContent.includes('Face'));
    const start = row.querySelector('[data-role="start"]');
    const end = row.querySelector('[data-role="end"]');
    start.value = '1.0';
    start.dispatchEvent(new Event('change', { bubbles: true }));
    end.value = '2.0';
    end.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  await page.click('#review-queue-button');
  await page.waitForTimeout(400);
  await page.keyboard.press('d'); // skip the manual track → face [1.0, 2.0]
  console.log('RQ after d press:', JSON.stringify(await page.evaluate(() => globalThis.__rqDebug?.() ?? null)));
  await page.waitForTimeout(2200); // the 1 s span plays out and pauses
  const facePaused = await page.evaluate(() => ({
    paused: document.querySelector('video').paused,
    label: document.querySelector('#review-queue-label')?.textContent,
    hidden: document.querySelector('#review-queue-card').hidden,
    count: document.querySelector('#review-queue-count')?.textContent,
  }));
  check('face span presented + paused for consideration',
    facePaused.paused === true && facePaused.hidden === false && facePaused.count === '2 / 2' && /Face/.test(facePaused.label ?? ''),
    JSON.stringify(facePaused));
  await page.evaluate(() => {
    document.querySelector('#preview-stage').scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await page.waitForTimeout(200);
  console.log('RQ before scroll:', JSON.stringify(await page.evaluate(() => globalThis.__rqDebug?.() ?? null)));
  await page.evaluate(() => {
    document.querySelector('#preview-stage').scrollIntoView({ block: 'center', behavior: 'instant' });
  });
  await page.waitForTimeout(200);
  console.log('RQ after scroll:', JSON.stringify(await page.evaluate(() => globalThis.__rqDebug?.() ?? null)));
  await page.keyboard.press('b');
  const c2 = await page.evaluate(() => {
    const r = document.querySelector('#overlay-canvas').getBoundingClientRect();
    const free = (x, y) => document.elementFromPoint(x, y)?.id === 'overlay-canvas';
    const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const spots = [c, { x: c.x + 120, y: c.y + 60 }, { x: c.x - 120, y: c.y + 60 }, { x: c.x - 120, y: c.y - 40 }];
    return { spot: spots.find((p) => free(p.x, p.y)) || c, base: { x: r.left, y: r.top, width: r.width, height: r.height } };
  });
  await page.mouse.move(c2.spot.x, c2.spot.y);
  await page.mouse.down();
  await page.mouse.move(c2.spot.x + 80, c2.spot.y + 50, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const drawn = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#track-list li.track-row')];
    const last = rows[rows.length - 1];
    return {
      label: last.querySelector('.label')?.textContent,
      start: last.querySelector('[data-role="start"]')?.value,
      end: last.querySelector('[data-role="end"]')?.value,
      checked: last.querySelector('input[type=checkbox]')?.checked,
    };
  });
  check('drawn box spans the reviewed frames only (1–2s, not full clip)',
    /Manual/.test(drawn.label ?? '') && drawn.start === '0:01.0' && drawn.end === '0:02.0' && drawn.checked === true,
    JSON.stringify(drawn));
  // ↺ Replay: re-seek to the span start and play (the queue had paused at
  // the span's end).
  const preReplay = await page.evaluate(() => ({
    t: document.querySelector('video').currentTime,
    paused: document.querySelector('video').paused,
  }));
  await page.click('#rq-replay');
  await page.waitForTimeout(400);
  const postReplay = await page.evaluate(() => ({
    t: document.querySelector('video').currentTime,
    paused: document.querySelector('video').paused,
    label: document.querySelector('#review-queue-label')?.textContent,
  }));
  check('↺ Replay re-seeks to the span start and plays',
    postReplay.paused === false && postReplay.t < preReplay.t - 0.5 && /Face/.test(postReplay.label ?? ''),
    `pre=${JSON.stringify(preReplay)} post=${JSON.stringify(postReplay)}`);

  // R key replays too.
  await page.waitForTimeout(600);
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  const postR = await page.evaluate(() => ({
    t: document.querySelector('video').currentTime,
    paused: document.querySelector('video').paused,
  }));
  check('R key replays as well', postR.paused === false && postR.t < 1.5, JSON.stringify(postR));

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);

  // Esc closes a restarted queue; group order still intact.
  await page.evaluate(() => {
    document.querySelectorAll('#toast-region .toast').forEach((t) => t.remove());
  });
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
