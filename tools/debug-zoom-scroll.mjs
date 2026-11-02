#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-zoom-scroll.mjs — field report (v1.40.0 cycle): "when timeline
 * zoomed in after analysis, scrolling doesn't work to move to beginning.
 * also position of marked track seems to be off in timeline."
 *
 * Measures the zoomed-strip geometry ground truth:
 *   P1  zoom in → lane (#track-chips) width vs strip (#timeline-track);
 *       every chip's ACTUAL pixel span vs its EXPECTED span from the
 *       track's [start,end] through the lane (full-clip percent);
 *   P2  the full-span manual ("marked") chip must cover the whole lane;
 *   P3  scroll: can strip.scrollLeft reach 0 (beginning) and max? does a
 *       horizontal wheel scroll over the strip move it? does anything
 *       fight the scroll (scroll glue)?
 *   P4  playhead/thumb position vs time through the lane;
 *   P5  tap-seek mapping at a scrolled position (pointer→time correctness).
 * Run: node tools/debug-zoom-scroll.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8179;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser
  .newContext({
    viewport: { width: 1280, height: 800 },
    storageState: 'test-results/regression-probe-profile/state.json',
  })
  .catch(() => browser.newContext({ viewport: { width: 1280, height: 800 } }));
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

try {
  await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 240000 });
  console.log('--- review reached ---');

  // Draw a manual ("marked") region through the real UI: B arms draw mode,
  // a drag on the preview canvas commits the box (full-clip span by default).
  await page.keyboard.press('b');
  const canvas = await page.locator('#overlay-canvas').boundingBox();
  const cx = canvas.x + canvas.width / 2;
  const cy = canvas.y + canvas.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 60, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const manualCount = await page.evaluate(
    () => document.querySelectorAll('#track-chips [data-track-id]').length,
  );
  console.log('chips before zoom (incl. manual):', manualCount);

  // Zoom in twice (1.5^2 = 2.25x) via the real buttons.
  await page.click('#zoom-in');
  await page.click('#zoom-in');
  await page.waitForTimeout(400);

  const geom = await page.evaluate(() => {
    const strip = document.querySelector('#timeline-track');
    const lane = document.querySelector('#track-chips');
    const stripR = strip.getBoundingClientRect();
    const laneR = lane.getBoundingClientRect();
    const playhead = document.querySelector('#playhead');
    const thumb = document.querySelector('#timeline-thumb');
    const dur = Number(document.querySelector('#timeline-duration')?.textContent ?? '');
    return {
      durText: dur,
      strip: { left: stripR.left, width: stripR.width, scrollLeft: strip.scrollLeft, scrollWidth: strip.scrollWidth, clientWidth: strip.clientWidth },
      lane: { left: laneR.left, width: laneR.width, minWidthCss: getComputedStyle(lane).minWidth },
      playheadLeftPx: playhead.getBoundingClientRect().left - stripR.left,
      thumbLeftPx: thumb.getBoundingClientRect().left - stripR.left,
      chips: [...lane.querySelectorAll('[data-track-id]')].map((el) => ({
        id: el.dataset.trackId,
        title: el.title,
        leftInStrip: el.getBoundingClientRect().left - stripR.left,
        widthPx: el.getBoundingClientRect().width,
      })),
    };
  });
  console.log('GEOM:', JSON.stringify(geom, null, 1));

  // Track times from the app state — read via the track rows' span inputs.
  const trackTimes = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#track-list li.track-row')];
    return rows.map((row) => ({
      id: Number(row.dataset.trackId),
      label: row.querySelector('.label')?.textContent ?? '',
      start: row.querySelector('[data-role="start"]')?.value ?? '',
      end: row.querySelector('[data-role="end"]')?.value ?? '',
    }));
  });
  console.log('TRACKS:', JSON.stringify(trackTimes));

  // P1/P2: chip pixel spans vs expected through the lane (full-clip percent).
  const chipCheck = await page.evaluate(() => {
    const strip = document.querySelector('#timeline-track');
    const lane = document.querySelector('#track-chips');
    const stripR = strip.getBoundingClientRect();
    const laneR = lane.getBoundingClientRect();
    // parse "m:ss.d" span inputs is overkill here — derive expected spans
    // from chip times via the row inputs in the caller instead; here only
    // the MANUAL full-span chip is asserted structurally.
    const manual = [...lane.querySelectorAll('[data-track-id]')].find((el) =>
      (el.title || '').includes('Manual'),
    );
    if (!manual) return { manualFound: false };
    const mr = manual.getBoundingClientRect();
    return {
      manualFound: true,
      coversLaneLeft: Math.abs(mr.left - laneR.left) < 4,
      coversLaneWidth: Math.abs(mr.width - laneR.width) / laneR.width < 0.02,
      manual: { leftDelta: mr.left - laneR.left, widthRatio: mr.width / laneR.width },
      stripLeftDelta: mr.left - stripR.left,
    };
  });
  console.log('MANUAL CHIP:', JSON.stringify(chipCheck));
  check(
    'P2 manual (marked) chip covers the whole zoomed lane',
    chipCheck.manualFound && chipCheck.coversLaneLeft && chipCheck.coversLaneWidth,
    JSON.stringify(chipCheck.manual ?? chipCheck),
  );

  // P1.5: PARTIAL chip position — trim the Face track's start to 1.0s via
  // its row span input, then verify the chip's pixel left/width through the
  // lane (full-clip percent). This is what the v1.31.0 view-relative math
  // got wrong by the zoom factor ("position of marked track seems off").
  const partial = await page.evaluate(async () => {
    const lane = document.querySelector('#track-chips');
    const row = document.querySelector('#track-list li.track-row:not([data-track-id="2"])');
    const startInput = row.querySelector('[data-role="start"]');
    startInput.value = '1.0';
    startInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    const laneR = lane.getBoundingClientRect();
    const chip = lane.querySelector('[data-track-id="1"]');
    const cr = chip.getBoundingClientRect();
    return {
      laneLeft: laneR.left,
      laneW: laneR.width,
      chipLeftInLane: cr.left - laneR.left,
      chipW: cr.width,
      // expected: start 1.0 of ~3.1s total
      expectedLeftInLane: (1.0 / 3.1) * laneR.width,
    };
  });
  console.log('PARTIAL CHIP:', JSON.stringify(partial));
  const posTol = Math.max(6, partial.laneW * 0.02);
  check(
    'P1.5 partial chip positions at full-clip percent in the lane',
    Math.abs(partial.chipLeftInLane - partial.expectedLeftInLane) < posTol,
    `left=${partial.chipLeftInLane.toFixed(1)} expected=${partial.expectedLeftInLane.toFixed(1)} (lane ${partial.laneW.toFixed(0)}px)`,
  );

  // Dismiss any toast (the warm probe profile's autosave-restore offer sits
  // over the strip and would swallow the wheel + tap interactions below).
  await page.evaluate(() => {
    const toasts = [...document.querySelectorAll('#toast-region .toast')];
    const texts = toasts.map((t) => t.textContent.slice(0, 40));
    toasts.forEach((t) => t.remove());
    if (texts.length) console.log('dismissed toasts:', JSON.stringify(texts));
  });
  await page.waitForTimeout(150);

  // P3: scroll to the beginning + max, and wheel-scroll the strip.
  const scroll = await page.evaluate(async () => {
    const strip = document.querySelector('#timeline-track');
    const max = strip.scrollWidth - strip.clientWidth;
    strip.scrollLeft = max;
    await new Promise((r) => setTimeout(r, 120));
    const atMax = strip.scrollLeft;
    strip.scrollLeft = 0;
    await new Promise((r) => setTimeout(r, 120));
    const atZero = strip.scrollLeft;
    return { max, atMax, atZero, scrollable: max > 0 };
  });
  console.log('SCROLL(setter):', JSON.stringify(scroll));
  check('P3a strip is horizontally scrollable when zoomed', scroll.scrollable, `max=${scroll.max}`);
  check('P3b scrollLeft reaches 0 (beginning)', scroll.atZero === 0, `atZero=${scroll.atZero}`);

  // Wheel-scroll over the strip (horizontal via shift+wheel → deltaX path).
  const stripBox = await page.locator('#timeline-track').boundingBox();
  await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
  const beforeWheel = await page.evaluate(() => document.querySelector('#timeline-track').scrollLeft);
  await page.keyboard.down('Shift');
  await page.mouse.wheel(0, 240);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
  const afterWheel = await page.evaluate(() => document.querySelector('#timeline-track').scrollLeft);
  check(
    'P3c wheel over the strip scrolls it',
    afterWheel > beforeWheel,
    `before=${beforeWheel} after=${afterWheel}`,
  );

  // P5: tap-seek mapping at the scrolled position (pointer → time).
  const seek = await page.evaluate(async () => {
    const strip = document.querySelector('#timeline-track');
    strip.scrollLeft = Math.max(0, strip.scrollWidth - strip.clientWidth); // far right
    await new Promise((r) => setTimeout(r, 150));
    return { scrollLeft: strip.scrollLeft };
  });
  console.log('P5 setup scrollLeft:', JSON.stringify(seek));
  await page.evaluate(() => {
    window.__seekLog = [];
    const video = document.querySelector('video');
    video.addEventListener('seeked', () => window.__seekLog.push(video.currentTime));
    video.addEventListener('seeking', () => window.__seekLog.push('seeking→' + video.currentTime));
    window.__evLog = [];
    for (const type of ['pointerdown', 'pointerup']) {
      document.addEventListener(type, (e) => window.__evLog.push(type + '@' + (e.target.id || e.target.className || e.target.tagName)), true);
    }
  });
  await page.mouse.click(stripBox.x + stripBox.width * 0.5, stripBox.y + stripBox.height / 2);
  await page.waitForTimeout(500);
  const tapTime = await page.evaluate(() => ({
    timeText: document.querySelector('#timeline-current')?.textContent ?? '',
    currentTime: document.querySelector('video')?.currentTime ?? null,
    seekLog: window.__seekLog,
    evLog: window.__evLog,
    scrollLeft: document.querySelector('#timeline-track').scrollLeft,
    laneLeft: document.querySelector('#track-chips').getBoundingClientRect().left,
  }));
  console.log('P5 tap at scrolled mid:', JSON.stringify(tapTime));

  console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await browser.close();
  server.kill();
}
