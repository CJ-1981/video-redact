#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-freeze-repro.mjs — reproduce the FIELD-reported thumb freeze with the
 * USER'S OWN VIDEO (test-results/local-user-clip.mp4, portrait 540x960 ~11.1s
 * — the gold-car clip), following their exact interaction order:
 *
 *   1. load file -> analyze (dashcam OFF) -> review
 *   2. BASELINE: play ~1.5s -> thumb should track currentTime
 *   3. USER GESTURE: mouse-drag the thumb forward (+25% of strip width)
 *   4. AFTER DRAG: play ~2s -> sample (currentTime, thumbLeft%) 3 times
 *      -> BUG = thumb pct stays frozen near the drag-end position while
 *         currentTime advances
 *
 * Prints a sample table + PASS/FAIL per phase. Run:
 *   node tools/debug-freeze-repro.mjs   (uses the persistent warm profile)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8197;
const FIXTURE = join(ROOT, 'test-results', 'local-user-clip.mp4');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  storageState: 'test-results/regression-probe-profile/state.json',
}).catch(async () => {
  // warm profile may not exist yet — cold context is fine (models download)
  return browser.newContext({ viewport: { width: 1280, height: 800 } });
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

/** Thumb center-x as % of the strip's inner width + video state. */
const sample = (page) =>
  page.evaluate(() => {
    const strip = document.querySelector('#timeline');
    const thumb = document.querySelector('#timeline-thumb');
    const video = document.querySelector('#preview-video');
    const s = strip.getBoundingClientRect();
    const t = thumb.getBoundingClientRect();
    return {
      t: +video.currentTime.toFixed(2),
      dur: Number.isFinite(video.duration) ? +video.duration.toFixed(2) : null,
      thumbPct: +(((t.x + t.width / 2 - s.x) / s.width) * 100).toFixed(1),
      left: thumb.style.left,
      paused: video.paused,
    };
  });

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.click('#analyze-button');
  await page.waitForSelector('#track-list li.track-row, #track-list-empty', { timeout: 300000 });
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 60000 });
  console.log('--- review reached (user clip loaded) ---');

  // ---- Phase 1: BASELINE playback tracking -------------------------------
  await page.evaluate(() => document.querySelector('#preview-video').pause());
  const base0 = await sample(page);
  await page.click('#play-toggle').catch(() => page.evaluate(() => document.querySelector('#preview-video').play()));
  await page.waitForTimeout(1500);
  const base1 = await sample(page);
  await page.evaluate(() => document.querySelector('#preview-video').pause());
  console.log(`BASELINE  t ${base0.t} -> ${base1.t}  thumbPct ${base0.thumbPct}% -> ${base1.thumbPct}%`);
  const expectedPct1 = +((base1.t / base1.dur) * 100).toFixed(1);
  check('BASELINE thumb tracks playback', Math.abs(base1.thumbPct - expectedPct1) < 6, `thumb ${base1.thumbPct}% vs expected ${expectedPct1}%`);

  // ---- Phase 2: USER GESTURE — drag the thumb forward --------------------
  const strip = await page.locator('#timeline').boundingBox();
  const thumbBox = await page.locator('#timeline-thumb').boundingBox();
  const startY = thumbBox.y + thumbBox.height / 2;
  const targetX = strip.x + strip.width * 0.3;
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, startY);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(thumbBox.x + thumbBox.width / 2 + ((targetX - thumbBox.x - thumbBox.width / 2) * i) / 6, startY, { steps: 2 });
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterDrag = await sample(page);
  console.log(`AFTER DRAG  t=${afterDrag.t} thumbPct=${afterDrag.thumbPct}% (dragged toward 30%)`);

  // ---- Phase 3: AFTER-DRAG playback (the field bug) ----------------------
  await page.click('#play-toggle').catch(() => page.evaluate(() => document.querySelector('#preview-video').play()));
  const samples = [];
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(700);
    samples.push(await sample(page));
  }
  await page.evaluate(() => document.querySelector('#preview-video').pause());
  for (const s of samples) {
    const expectedPct = +((s.t / s.dur) * 100).toFixed(1);
    const ok = Math.abs(s.thumbPct - expectedPct) < 6;
    check(`AFTER-DRAG thumb tracks playback (t=${s.t})`, ok, `thumb ${s.thumbPct}% vs expected ${expectedPct}%`);
  }
  console.log('SAMPLES', JSON.stringify(samples));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s) — reproduction confirmed`);
process.exit(failures === 0 ? 0 : 1);
