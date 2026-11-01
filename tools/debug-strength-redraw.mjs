#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-strength-redraw.mjs — field report (v1.38.1): "when pixelation
 * strength changed, preview doesn't apply it instantly. i need to press
 * peek once then it applies."
 *
 * Root cause hypothesis: the strength click called editor.refresh() —
 * chips/rows DOM only, NOT the canvas. While the video is PAUSED the rVFC
 * loop never fires (rVFC delivers only on PRESENTED frames) and timeupdate
 * is silent, so nothing redrew the overlay canvas until Peek's release
 * path drew it explicitly.
 *
 * Reproduction: dist → detectable.mp4 → analyze → review → pause → find a
 * timestamp where redaction actually covers pixels (peek raw ≠ redacted
 * hash) → hash #overlay-canvas → click a strength segment → hash again.
 * Before the fix the hash is UNCHANGED (stale canvas); after it flips
 * immediately. Same oracle for the bulk restyle buttons.
 *
 * Run: node tools/debug-strength-redraw.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8175;
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

// Emulate the reporting machine exactly (v1.8.1 field report): rVFC is
// PRESENT (the editor takes the rVFC path) but NEVER delivers — "the loop
// registered but never fired". While the video is paused, no rVFC frame,
// no timeupdate → the only draws are seeked + explicit redraws, which is
// the world where the stale-canvas bug lives. Desktop headless Chromium
// otherwise keeps presenting frames while paused and masks the bug.
await page.addInitScript(() => {
  HTMLMediaElement.prototype.requestVideoFrameCallback = function () {
    return 1; // registered, never invoked
  };
});

try {
  await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 240000 });
  console.log('--- review reached ---');

  // In-page helpers: pause, seek, and a cheap canvas content hash.
  const hashAndSeek = await page.evaluate(async () => {
    const video = document.querySelector('video');
    const canvas = document.querySelector('#overlay-canvas');
    if (!video || !canvas) return { error: 'missing video/canvas' };
    video.pause();
    const hash = () => {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let h = 0;
      for (let i = 0; i < d.length; i += 997) h = (h * 31 + d[i]) | 0;
      return h;
    };
    window.__hash = hash;
    const seek = (t) =>
      new Promise((res) => {
        const done = () => setTimeout(res, 120); // settle after seeked
        video.addEventListener('seeked', done, { once: true });
        video.currentTime = t;
      });
    window.__seek = seek;
    return { paused: video.paused, w: canvas.width, h: canvas.height };
  });
  console.log('canvas:', JSON.stringify(hashAndSeek));
  if (hashAndSeek.error) throw new Error(hashAndSeek.error);

  // Find a timestamp where redaction actually covers pixels:
  // peek (raw) hash ≠ released (redacted) hash proves tracks paint there.
  const findTrackedTime = await page.evaluate(async () => {
    const video = document.querySelector('video');
    const peek = document.querySelector('#peek-button');
    const down = () => {
      peek.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    };
    const up = () => {
      peek.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
      peek.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
    };
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const t of [2.0, 1.5, 2.5, 1.0, 3.0, 0.8]) {
      if (t >= video.duration - 0.2) continue;
      await window.__seek(t);
      down();
      await settle(120);
      const raw = window.__hash();
      up();
      await settle(120);
      const redacted = window.__hash();
      if (raw !== redacted) return { t, raw, redacted };
    }
    return null;
  });
  if (!findTrackedTime) throw new Error('no timestamp with visible redaction found');
  console.log(`tracked time: t=${findTrackedTime.t} (raw=${findTrackedTime.raw} redacted=${findTrackedTime.redacted})`);

  // THE FIELD SCENARIO: paused at a tracked frame, click a strength segment.
  // The canvas must change WITHOUT any peek/seek/play in between.
  await page.evaluate((t) => window.__seek(t), findTrackedTime.t);
  await page.waitForTimeout(150);
  const baseline = await page.evaluate(() => window.__hash());

  // Environment sanity: with rVFC emulated dead and the video paused, an
  // IDLE canvas must not drift — drift here means the frame loop is still
  // delivering and this probe cannot reproduce the stale-canvas world.
  const drift = await page.evaluate(async () => {
    const a = window.__hash();
    const vfcBefore = globalThis.__VR_DIAG?.vfc ?? 0;
    await new Promise((r) => setTimeout(r, 600));
    const b = window.__hash();
    return { drift: a !== b, a, b, vfcDelta: (globalThis.__VR_DIAG?.vfc ?? 0) - vfcBefore,
             vfcType: typeof document.querySelector('video').requestVideoFrameCallback };
  });
  console.log('idle-drift:', JSON.stringify(drift));
  check('idle paused canvas is stable (emulation holds)', !drift.drift, `a=${drift.a} b=${drift.b} vfcΔ=${drift.vfcDelta} rVFC=${drift.vfcType}`);

  await page.click('.strength-btn[data-strength="coarse"]');
  await page.waitForTimeout(200);
  const afterCoarse = await page.evaluate(() => window.__hash());
  check(
    'strength click redraws instantly (paused)',
    afterCoarse !== baseline,
    `baseline=${baseline} afterCoarse=${afterCoarse}`,
  );

  // Bulk restyle rides the same refreshTrackUi path — same oracle.
  await page.click('#bulk-solid');
  await page.waitForTimeout(200);
  const afterSolid = await page.evaluate(() => window.__hash());
  check(
    'bulk-solid redraws instantly (paused)',
    afterSolid !== afterCoarse,
    `afterCoarse=${afterCoarse} afterSolid=${afterSolid}`,
  );

  // Per-row style select (onSetStyle hook): flip the first row back to pixelate.
  await page.evaluate(async () => {
    const sel = document.querySelector('#track-list .style-select');
    sel.value = 'pixelate';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  });
  const afterRowPixelate = await page.evaluate(() => window.__hash());
  check(
    'per-row style change redraws instantly (paused)',
    afterRowPixelate !== afterSolid,
    `afterSolid=${afterSolid} afterRowPixelate=${afterRowPixelate}`,
  );
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exitCode = failures === 0 ? 0 : 1;
