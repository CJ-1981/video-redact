#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-freeze-emulated.mjs — deterministic thumb-follow probe. The headless
 * media clock is unreliable, so we DRIVE the clock: set video.currentTime
 * step-by-step (each fires real seeked+timeupdate) and assert the thumb
 * follows. Phases:
 *
 *   P0   PRE-ANALYZE timeline (v1.10.0 regression probe; runs FIRST, in the
 *        READY state, BEFORE any analysis): play → thumb must track, Space
 *        must toggle playback, thumb drag 25%→50% must scrub, a manual box
 *        drag must create a track. FAILS on ≤ v1.9.0 builds (the editor only
 *        mounted after the first analyze, so the whole workspace was dead
 *        markup pre-analyze — the field report "it happens only before
 *        analysis is made").
 *   P-A  no prior thumb interaction: step 0 -> dur  -> thumb must track
 *   P-B  thumb drag first (arms the v1.8.0 release pin), then step -> thumb
 *        must track (a frozen thumb here = the pin latched = the field bug)
 *   P-C  with a manual SOLID region (the user workflow)
 *
 * Run: node tools/debug-freeze-emulated.mjs
 */
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8196;
// Preferred: the user's own clip (as in debug-freeze-repro.mjs); fall back to
// the committed synthetic fixture when it is absent (fresh checkout / CI).
const FIXTURE = existsSync(join(ROOT, 'test-results', 'local-user-clip.mp4'))
  ? join(ROOT, 'test-results', 'local-user-clip.mp4')
  : join(ROOT, 'tests', 'fixtures', 'synthetic.mp4');

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
  const expBtn = await page.evaluate(() => ({
    text: document.querySelector('#export-button')?.textContent ?? null,
    cls: document.querySelector('#export-button')?.className ?? null,
    disabled: document.querySelector('#export-button')?.disabled ?? null,
  }));
  console.log(`P0 EXPORT at ready: text="${expBtn.text}" cls="${expBtn.cls}" disabled=${expBtn.disabled}`);

  // Error capture from the very start (covers P0, not just P-C).
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  /** Thumb center as % of the chips axis (the axis the editor positions in). */
  const thumbPct = () =>
    page.evaluate(() => {
      const thumb = document.querySelector('#timeline-thumb');
      const track = document.querySelector('#track-chips');
      const s = track.getBoundingClientRect();
      const b = thumb.getBoundingClientRect();
      return ((b.x + b.width / 2 - s.x) / s.width) * 100;
    });
  const driveTo = async (p) =>
    page.evaluate((frac) => {
      const v = document.querySelector('#preview-video');
      v.pause();
      v.currentTime = v.duration * frac;
    }, p);

  // ── P0: PRE-ANALYZE timeline — READY state, NO analysis yet ────────────────
  console.log('--- P0: pre-analyze timeline (READY, before any analysis) ---');

  // P0a — play ~1.2 s: the thumb must follow the media clock. If the headless
  // media clock is starved (currentTime never advances), drive a seek to 25%
  // instead — the editor must follow that too (v1.9.0 dist: dead markup, the
  // thumb never leaves its CSS-default 0% either way).
  const played = await page.evaluate(async () => {
    const v = document.querySelector('#preview-video');
    try {
      await v.play();
    } catch {
      return { played: false, t: v.currentTime };
    }
    await new Promise((r) => setTimeout(r, 1200));
    v.pause();
    return { played: true, t: v.currentTime };
  });
  const dur = await page.evaluate(() => document.querySelector('#preview-video').duration);
  let pct = await thumbPct();
  if (!played.played || !(played.t > 0.3)) {
    await driveTo(0.25);
    await page.waitForTimeout(300);
    pct = await thumbPct();
    check(
      'P0a pre-analyze thumb tracks (clock starved — driven seek)',
      Math.abs(pct - 25) < 6,
      `thumb=${pct.toFixed(1)}% expected=25%`,
    );
  } else {
    const expected = (played.t / dur) * 100;
    check(
      'P0a pre-analyze play: thumb tracks',
      Math.abs(pct - expected) < 6,
      `t=${played.t.toFixed(2)} thumb=${pct.toFixed(1)}% expected=${expected.toFixed(1)}%`,
    );
  }

  // P0b — Space toggles playback pre-analyze (v1.9.0: dead — review-only gating).
  await driveTo(0);
  await page.waitForTimeout(200);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const playing = await page.evaluate(() => !document.querySelector('#preview-video').paused);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const pausedAgain = await page.evaluate(() => document.querySelector('#preview-video').paused);
  check(
    'P0b pre-analyze Space toggles playback',
    playing && pausedAgain,
    `play=${playing} re-pause=${pausedAgain}`,
  );

  // P0c — thumb drag 25% → 50%: scrub works pre-analyze.
  await driveTo(0.25);
  await page.waitForTimeout(300);
  const thumbBox = await page.locator('#timeline-thumb').boundingBox();
  const chips = await page.locator('#track-chips').boundingBox();
  await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + thumbBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(chips.x + chips.width * 0.5, thumbBox.y + thumbBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  pct = await thumbPct();
  const tAfter = await page.evaluate(() => document.querySelector('#preview-video').currentTime);
  check(
    'P0c pre-analyze thumb drag scrubs (25% → 50%)',
    Math.abs(pct - 50) < 6 && Math.abs(tAfter - dur * 0.5) < Math.max(0.35, dur * 0.03),
    `thumb=${pct.toFixed(1)}% t=${tAfter.toFixed(2)} expected≈${(dur * 0.5).toFixed(2)}`,
  );

  // P0d — draw a manual box pre-analyze: a Manual chip + row must appear.
  const vid = await page.locator('#preview-video').boundingBox();
  const cx = vid.x + vid.width * 0.35;
  const cy = vid.y + vid.height * 0.3;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 90, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const manualChips = await page.locator('#track-chips div[title^="Manual"]').count();
  const manualRows = await page
    .locator('#track-list li.track-row', { hasText: 'Manual' })
    .count();
  check(
    'P0d pre-analyze manual box creates a track',
    manualChips >= 1 && manualRows >= 1,
    `chips=${manualChips} rows=${manualRows}`,
  );
  check('P0 no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

  // VR_P0_ONLY=1: regression-check just the pre-analyze phase (no model
  // downloads — the post-analyze phases need a cold-cache ORT fetch).
  if (process.env.VR_P0_ONLY === '1') {
    console.log('VR_P0_ONLY=1 — skipping the post-analyze phases');
    throw new Error('__P0_ONLY_STOP__');
  }

  // ── P-A/P-B/P-C: post-analyze phases (unchanged) ───────────────────────────
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
  const thumbBox2 = await page.locator('#timeline-thumb').boundingBox();
  const track = await page.locator('#track-chips').boundingBox();
  await page.mouse.move(thumbBox2.x + thumbBox2.width / 2, thumbBox2.y + thumbBox2.height / 2);
  await page.mouse.down();
  await page.mouse.move(track.x + track.width * 0.3, thumbBox2.y + thumbBox2.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  await trackFollows('P-B post-drag tracks');

  console.log('--- P-C: with a manual SOLID region (the user workflow) ---');
  // draw a manual box on the video canvas (user workflow: "drag a box").
  // NOTE: the P0 box drawn pre-analyze must SURVIVE analysis (v1.10.0 merge),
  // so at least 2 manual rows exist here.
  const vid2 = await page.locator('#preview-video').boundingBox();
  const cx2 = vid2.x + vid2.width * 0.35;
  const cy2 = vid2.y + vid2.height * 0.3;
  await page.mouse.move(cx2, cy2);
  await page.mouse.down();
  await page.mouse.move(cx2 + 120, cy2 + 90, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const manualRows2 = await page.locator('#track-list li.track-row').count();
  console.log(`  manual box drawn; track rows now ${manualRows2} (≥2: P0's pre-analyze region survives the merge)`);
  check('P-C pre-analyze manual region survives analysis', manualRows2 >= 2, `rows=${manualRows2}`);
  await trackFollows('P-C manual-region tracks');
  if (pageErrors.length) {
    check('P-C no page errors', false, pageErrors.slice(0, 3).join(' | '));
  } else {
    check('P-C no page errors', true, '');
  }
} catch (err) {
  // VR_P0_ONLY=1 stops here ON PURPOSE (clean summary, no stack noise).
  if (err?.message !== '__P0_ONLY_STOP__') throw err;
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
