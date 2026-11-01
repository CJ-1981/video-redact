#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-watermark-summary.mjs — v1.22.0 Wave 3 probe (ONE run, 420 s
 * budget): desktop Chromium against the built dist, detectable.mp4 warm.
 *
 *   1. REQ-133 watermark: set text "CONFIDENTIAL" corner br + 720p, export,
 *      re-decode the output IN THE PAGE next to the source and assert the
 *      bottom-right strip gained bright/near-white pixels vs the same strip
 *      of the scaled source (present + white + corner-localized).
 *   2. REQ-137 summary card: the #export-summary rows render at the export
 *      click (before the export finishes) with non-empty duration/tracks/
 *      audio values.
 *   3. REQ-138 autosave: a manual box marks the session dirty → the 10 s
 *      tick snapshots it → after a page reload + re-open of the SAME video
 *      the "Unsaved session found" toast appears.
 *
 * Run: npm run build && node tools/debug-watermark-summary.mjs
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8181;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');

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

try {
  await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  // Warm the file → ready, then analyze → review (export needs review).
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60_000 });
  await page.locator('#analyze-button').click();
  await page.waitForFunction(
    () => {
      const s = document.querySelector('#analyze-status');
      return !!s && s.textContent.trim().length > 0;
    },
    { timeout: 120_000 },
  );
  const statusText = await page.evaluate(() =>
    document.querySelector('#analyze-status').textContent.trim(),
  );
  check('analyze completed into review', !/failed/i.test(statusText), statusText);

  // ── REQ-133/137: watermark inputs + 720p, then export ────────────────────
  await page.fill('#watermark-text', 'CONFIDENTIAL');
  await page.selectOption('#watermark-corner', 'br');
  await page.selectOption('#export-resolution', '720p');

  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 });
  await page.locator('#export-button').click();

  // ── Check 2: the summary card rendered at the click, before completion ───
  try {
    await page.waitForSelector('#export-summary:not([hidden])', { timeout: 10_000 });
    const rows = await page.evaluate(() => {
      const out = {};
      for (const row of document.querySelectorAll('#export-summary .export-summary-row')) {
        const cells = row.querySelectorAll('span');
        out[row.dataset.summaryLabel ?? cells[0]?.textContent ?? ''] =
          cells[1]?.textContent ?? '';
      }
      return out;
    });
    const needed = ['Output duration', 'Tracks', 'Audio'];
    const nonEmpty = needed.every((k) => (rows[k] ?? '').length > 0);
    check(
      'REQ-137 export summary rows render at the click (duration/tracks/audio non-empty)',
      nonEmpty,
      JSON.stringify(rows),
    );
  } catch (err) {
    check('REQ-137 export summary rows render at the click', false, String(err).split('\n')[0]);
  }

  const download = await downloadPromise;
  await page.waitForFunction(
    () => (document.querySelector('#export-status')?.textContent ?? '').includes('Exported'),
    { timeout: 240_000 },
  );
  const outPath = await download.path();
  check('REQ-133 export completed (720p + watermark settings accepted)', true, outPath);

  // ── Check 1: re-decode output vs source in the page; br strip gained white
  const outB64 = readFileSync(outPath).toString('base64');
  const wm = await page.evaluate(async ({ b64, fixtureUrl }) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

    /** Decode one frame of a video URL at t, drawn at outW×outH. */
    async function framePixels(src, t, outW, outH) {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = src;
      await new Promise((res, rej) => {
        video.onloadeddata = () => res();
        video.onerror = () => rej(new Error(`video decode failed: ${src}`));
      });
      const target = Math.min(t, Math.max(0.1, (video.duration || 1) / 2));
      await new Promise((res) => {
        video.onseeked = () => res();
        video.currentTime = target;
      });
      await new Promise((r) => setTimeout(r, 150)); // let the frame settle
      const w = outW || video.videoWidth;
      const h = outH || video.videoHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      video.removeAttribute('src');
      video.load();
      return { data: img.data, w, h };
    }

    const outUrl = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    const srcUrl = URL.createObjectURL(await (await fetch(fixtureUrl)).blob());
    const out = await framePixels(outUrl, 0.5);
    const src = await framePixels(srcUrl, 0.5, out.w, out.h); // scale source to output dims

    /** Count "gained bright" pixels in a strip: output brighter than the
     *  source by > 50 luminance; of those, how many are WHITE-BLENDED — the
     *  overlay draws white at the spec-default opacity 0.5, so over the
     *  fixture's dark background a text pixel blends to ~0.5·255 + bg ≈ 135+
     *  with LOW saturation (channels stay near-equal). Truly near-white
     *  (>180 min-channel) would require opacity 1 — a half-transparent
     *  white overlay can never produce it. */
    function strip(srcData, outData, x0, x1, y0, y1) {
      let mask = 0;
      let white = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * outData.w + x) * 4;
          const lumS =
            0.2126 * srcData.data[i] + 0.7152 * srcData.data[i + 1] + 0.0722 * srcData.data[i + 2];
          const lumO =
            0.2126 * outData.data[i] + 0.7152 * outData.data[i + 1] + 0.0722 * outData.data[i + 2];
          if (lumO - lumS > 50) {
            mask += 1;
            const r = outData.data[i];
            const g = outData.data[i + 1];
            const b = outData.data[i + 2];
            const minCh = Math.min(r, g, b);
            const sat = Math.max(r, g, b) - minCh;
            if (minCh > 110 && sat < 70) white += 1;
          }
        }
      }
      return { mask, white };
    }

    const w = out.w;
    const h = out.h;
    const x0 = Math.floor(w * 0.72);
    const x1 = Math.floor(w * 0.995);
    const stripH = Math.floor(h * 0.07);
    const br = strip(src, out, x0, x1, h - 2 - stripH, h - 2); // bottom-right band
    const tl = strip(src, out, x0, x1, 2, 2 + stripH); // mirrored top band (no watermark)
    URL.revokeObjectURL(outUrl);
    URL.revokeObjectURL(srcUrl);
    return {
      dims: `${w}×${h}`,
      br,
      tl,
      whiteRatio: br.mask > 0 ? br.white / br.mask : 0,
      localization: tl.mask > 0 ? br.mask / tl.mask : br.mask > 0 ? Infinity : 0,
    };
  }, { b64: outB64, fixtureUrl: `${BASE}/tests/fixtures/detectable.mp4` }).catch((err) => ({ error: String(err) }));

  if (wm.error) {
    check('REQ-133 watermark pixels in the br corner', false, wm.error.split('\n')[0]);
  } else {
    check(
      'REQ-133 watermark: br strip gained bright pixels vs source (text present)',
      wm.br.mask > 250,
      `dims=${wm.dims} brMask=${wm.br.mask} tlMask=${wm.tl.mask}`,
    );
    check(
      'REQ-133 watermark: gained pixels are white-blended (legible overlay)',
      wm.whiteRatio > 0.5,
      `whiteRatio=${wm.whiteRatio.toFixed(3)} white=${wm.br.white}`,
    );
    check(
      'REQ-133 watermark: localized to the chosen br corner',
      wm.localization > 4,
      `br/tl mask ratio=${wm.localization.toFixed(2)}`,
    );
  }

  // ── Check 3: autosave → reload → restore toast (REQ-138) ─────────────────
  try {
    // A manual box marks the session dirty (refreshTrackUi hook).
    const overlay = page.locator('#overlay-canvas');
    const ob = await overlay.boundingBox();
    await page.mouse.move(ob.x + ob.width * 0.2, ob.y + ob.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(ob.x + ob.width * 0.5, ob.y + ob.height * 0.5, { steps: 5 });
    await page.mouse.up();
    await page.waitForSelector('#track-chips div[data-track-id]', { timeout: 10_000 });
    // The 10 s interval tick snapshots the dirty session (11 s > 10 s).
    await page.waitForTimeout(11_000);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#serve-gate', { state: 'hidden' });
    await page.setInputFiles('#file-input', FIXTURE);
    await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60_000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('#toast-region .toast span')].some((el) =>
          (el.textContent ?? '').includes('Unsaved session found'),
        ),
      { timeout: 15_000 },
    );
    const actions = await page.evaluate(() => {
      const toast = [...document.querySelectorAll('#toast-region .toast')].find((el) =>
        (el.textContent ?? '').includes('Unsaved session found'),
      );
      return [...(toast?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    });
    check(
      'REQ-138 restore toast after reload with Restore/Discard actions',
      actions.includes('Restore') && actions.includes('Discard'),
      `actions=${JSON.stringify(actions)}`,
    );
  } catch (err) {
    check('REQ-138 restore toast after reload', false, String(err).split('\n')[0]);
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
