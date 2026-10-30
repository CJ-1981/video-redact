#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-freeze-emulated.mjs — deterministic thumb-follow probe. The headless
 * media clock is unreliable, so we DRIVE the clock: set video.currentTime
 * step-by-step (each fires real seeked+timeupdate) and assert the thumb
 * follows. Two phases:
 *
 *   P-A  no prior thumb interaction: step 0 -> dur  -> thumb must track
 *   P-B  thumb drag first (arms the v1.8.0 release pin), then step -> thumb
 *        must track (a frozen thumb here = the pin latched = the field bug)
 *
 * Run: node tools/debug-freeze-emulated.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8196;
const FIXTURE = join(ROOT, 'test-results', 'local-user-clip.mp4');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 300000 });
  await page.evaluate(() => document.querySelector('#preview-video').pause());

  /** Step currentTime to p (0..1), let events settle, return thumbPct vs expectedPct. */
  const stepTo = async (p) =>
    page.evaluate(
      async (p) => {
        const video = document.querySelector('#preview-video');
        const thumb = document.querySelector('#timeline-thumb');
        const track = document.querySelector('#track-chips');
        const t = p * video.duration;
        video.currentTime = t;
        await new Promise((r) => {
          const done = () => setTimeout(r, 30);
          video.addEventListener('seeked', done, { once: true });
          setTimeout(done, 800); // settle fallback
        });
        const s = track.getBoundingClientRect();
        const b = thumb.getBoundingClientRect();
        const pct = ((b.x + b.width / 2 - s.x) / s.width) * 100;
        return { p, t: +video.currentTime.toFixed(2), pct: +pct.toFixed(1) };
      },
      p,
    );

  const trackFollows = async (label) => {
    let all = true;
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const s = await stepTo(p);
      const ok = Math.abs(s.pct - p * 100) < 6;
      console.log(`  ${label} t=${s.t} thumb=${s.pct}% expected=${p * 100}% ${ok ? 'OK' : 'DRIFT'}`);
      all = all && ok;
    }
    check(label, all, '');
  };

  console.log('--- P-A: baseline (no thumb interaction) ---');
  await trackFollows('P-A baseline tracks');

  console.log('--- P-B: after a thumb drag (release pin armed) ---');
  const thumbBox = await page.locator('#timeline-thumb').boundingBox();
  const track = await page.locator('#track-chips').boundingBox();
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.3, thumbBox.y + thumbBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await trackFollows('P-B post-drag tracks');

  console.log('--- P-C: with a manual SOLID region (the user workflow) ---');
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // draw a manual box on the video canvas (user workflow: "drag a box")
  const vid = await page.locator('#preview-video').boundingBox();
  const cx = vid.x + vid.width * 0.35;
  const cy = vid.y + vid.height * 0.3;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 90, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const manualRows = await page.locator('#track-list li.track-row').count();
  console.log(`  manual box drawn; track rows now ${manualRows}`);
  await trackFollows('P-C manual-region tracks');
  if (pageErrors.length) {
    check('P-C no page errors', false, pageErrors.slice(0, 3).join(' | '));
  } else {
    check('P-C no page errors', true, '');
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
