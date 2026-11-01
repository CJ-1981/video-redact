#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-zoom-peek-wave.mjs — v1.22.0 REQ-204/205/206 probe (ONE run, 420 s
 * budget): desktop Chromium against the built dist, detectable.mp4 warm.
 *
 *   1. ctrl+wheel zoom on the timeline strip → chip positions change
 *      consistently (view-window mapping; everything stays in [0, 100]%).
 *   2. shift+drag pan moves the zoomed window (bonus orthogonality check).
 *   3. #zoom-fit resets the view (chips return to the full-clip numbers).
 *   4. hold-to-peek: with a manual redaction on screen, the paused preview
 *      canvas differs (byte sum) redacted vs peeked beyond a threshold and
 *      restores on release.
 *   5. waveform strip: visible with non-zero bars after the review entry,
 *      click seeks.
 *
 * Run: npm run build && node tools/debug-zoom-peek-wave.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8179;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

/** @type {Array<{name: string, ok: boolean, detail: string}>} */
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` :: ${detail}` : ''}`);
}

/** Sum the canvas RGB bytes (a cheap frame fingerprint for the peek diff). */
const canvasSum = (sel) =>
  page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c || !c.width) return null;
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
    return sum;
  }, sel);

/** First chip's left/width percentages (view-window mapping readout). */
const chipPct = () =>
  page.evaluate(() => {
    // The NARROWEST chip is the sensitive readout: a full-span manual chip
    // correctly CLIPS to {left: 0, width: 100} under any view, so it can
    // never witness a zoom. Auto Face/Plate chips do.
    const chips = [...document.querySelectorAll('#track-chips div[data-track-id]')];
    if (!chips.length) return null;
    let best = chips[0];
    for (const el of chips) {
      if (parseFloat(el.style.width) < parseFloat(best.style.width)) best = el;
    }
    return { left: parseFloat(best.style.left), width: parseFloat(best.style.width) };
  });

/** The playhead's left percentage (time → view mapping readout). */
const playheadPct = () =>
  page.evaluate(() => parseFloat(document.querySelector('#playhead').style.left));

/** Dispatch a ctrl+wheel with the given deltaY at the strip's center. */
const ctrlWheel = (deltaY) =>
  page.evaluate((deltaY) => {
    const el = document.querySelector('#timeline-track');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new WheelEvent('wheel', {
        ctrlKey: true,
        deltaY,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, deltaY);

try {
  await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  // Warm the file → ready (editor mounted live).
  await page.setInputFiles('#file-input', join(ROOT, 'tests', 'fixtures', 'detectable.mp4'));
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60_000 });

  // Guarantee a chip + a visible redaction for the peek check: draw a manual
  // region (ready state, the editor is live) — a solid black burn over ~15%
  // of the frame for the whole clip.
  const overlay = page.locator('#overlay-canvas');
  const ob = await overlay.boundingBox();
  await page.mouse.move(ob.x + ob.width * 0.3, ob.y + ob.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(ob.x + ob.width * 0.65, ob.y + ob.height * 0.65, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('#track-chips div[data-track-id]', { timeout: 10_000 });

  // Analyze → review entry (also triggers the lazy waveform decode). The
  // MANUAL row already exists pre-analyze, so the REVIEW signal is the
  // analyze-status summary (set only by enterReview) — not the rows.
  await page.locator('#analyze-button').click();
  await page.waitForFunction(
    () => {
      const s = document.querySelector('#analyze-status');
      return !!s && s.textContent.trim().length > 0;
    },
    { timeout: 300_000 },
  );
  const statusText = await page.evaluate(() =>
    document.querySelector('#analyze-status').textContent.trim(),
  );
  check('analyze completed into review', !/failed/i.test(statusText), statusText);

  // Park the playhead OFF-center: a zoom anchored at the strip center must
  // move it (the time→view pct grows when the window shrinks around 50%).
  await page.evaluate(() => {
    const v = document.querySelector('#preview-video');
    v.currentTime = Math.min(0.4, v.duration / 4);
  });
  await page.waitForTimeout(400);
  const ph0 = await playheadPct();

  // ── Check 1: ctrl+wheel zoom ─────────────────────────────────────────────
  const full = await chipPct();
  await ctrlWheel(-120); // one notch in (1.2×)
  await page.waitForTimeout(150);
  const z1 = await chipPct();
  const ph1 = await playheadPct();
  await ctrlWheel(-120);
  await page.waitForTimeout(150);
  const z2 = await chipPct();
  const consistent =
    full && z1 && z2 &&
    ((z1.left !== full.left || z1.width !== full.width) ||
      (ph1 > ph0 + 1 || ph1 < ph0 - 1)) &&
    z2.width >= z1.width - 0.01 &&
    z2.left >= -0.01 &&
    z2.left + z2.width <= 100.01;
  check(
    'REQ-204 ctrl+wheel zoom changes chips/playhead consistently (in-bounds)',
    consistent,
    `full=${JSON.stringify(full)} z1=${JSON.stringify(z1)} z2=${JSON.stringify(z2)} ph0=${ph0?.toFixed(1)} ph1=${ph1?.toFixed(1)}`,
  );

  // ── Check 2: shift+drag pans the zoomed window ──────────────────────────
  const strip = page.locator('#timeline-track');
  const sb = await strip.boundingBox();
  await page.keyboard.down('Shift');
  await page.mouse.move(sb.x + sb.width * 0.7, sb.y + sb.height / 2);
  await page.mouse.down();
  await page.mouse.move(sb.x + sb.width * 0.3, sb.y + sb.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  const panned = await chipPct();
  const phPanned = await playheadPct();
  check(
    'REQ-204 shift+drag pans the zoomed window',
    (panned && z2 && (panned.left !== z2.left || panned.width !== z2.width)) ||
      (phPanned != null && ph1 != null && Math.abs(phPanned - ph1) > 1),
    `z2=${JSON.stringify(z2)} panned=${JSON.stringify(panned)} ph1=${ph1?.toFixed(1)} phPanned=${phPanned?.toFixed(1)}`,
  );

  // ── Check 3: zoom-fit resets ─────────────────────────────────────────────
  await page.locator('#zoom-fit').click();
  await page.waitForTimeout(150);
  const fitted = await chipPct();
  const fitOk =
    fitted && full && Math.abs(fitted.left - full.left) < 0.5 && Math.abs(fitted.width - full.width) < 0.5;
  check('REQ-204 zoom-fit resets to the full clip', fitOk, `fitted=${JSON.stringify(fitted)} full=${JSON.stringify(full)}`);

  // ── Check 4: hold-to-peek ────────────────────────────────────────────────
  // Play briefly (the REQ-205 hold rides playback), then pause for a
  // deterministic frame comparison (a moving video would diff every frame).
  await page.locator('#transport-play').click();
  await page.waitForTimeout(400);
  await page.locator('#transport-play').click(); // pause
  await page.waitForTimeout(300);
  const redacted = await canvasSum('#overlay-canvas');
  await page.locator('#peek-button').dispatchEvent('pointerdown');
  await page.waitForTimeout(300);
  const peeked = await canvasSum('#overlay-canvas');
  const peekRel = Math.abs(redacted - peeked) / Math.max(1, Math.max(redacted, peeked));
  await page.locator('#peek-button').dispatchEvent('pointerup');
  await page.waitForTimeout(300);
  const restored = await canvasSum('#overlay-canvas');
  const restRel = Math.abs(redacted - restored) / Math.max(1, Math.max(redacted, restored));
  check(
    'REQ-205 hold-to-peek draws the RAW frame and release restores it',
    peekRel > 0.02 && restRel < 0.005,
    `redacted=${redacted} peeked=${peeked} relDiff=${peekRel.toFixed(4)} restRelDiff=${restRel.toFixed(5)}`,
  );

  // ── Check 5: waveform strip ──────────────────────────────────────────────
  try {
    await page.waitForSelector('#waveform:not([hidden])', { timeout: 45_000 });
    const wave = await page.evaluate(() => {
      const c = document.querySelector('#waveform');
      const ctx = c.getContext('2d');
      const { data } = ctx.getImageData(0, 0, c.width, c.height);
      let painted = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) painted += 1;
      return { painted, w: c.width, h: c.height };
    });
    check('REQ-206 waveform strip renders non-zero bars', wave.painted > 50, JSON.stringify(wave));

    const t0 = await page.evaluate(() => document.querySelector('#preview-video').currentTime);
    const wb = await page.locator('#waveform').boundingBox();
    await page.mouse.click(wb.x + wb.width * 0.8, wb.y + wb.height / 2);
    await page.waitForTimeout(250);
    const t1 = await page.evaluate(() => document.querySelector('#preview-video').currentTime);
    check('REQ-206 waveform click seeks', Math.abs(t1 - t0) > 0.05, `t0=${t0.toFixed(2)} t1=${t1.toFixed(2)}`);
  } catch (err) {
    check('REQ-206 waveform strip visible + seekable', false, String(err).split('\n')[0]);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  console.log(`\nSUMMARY: ${results.length - failed.length}/${results.length} checks passed`);
  console.log(JSON.stringify(results, null, 1));
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('PROBE ERROR:', err);
  console.log(JSON.stringify(results, null, 1));
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
