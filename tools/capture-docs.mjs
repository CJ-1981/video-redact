#!/usr/bin/env node
/**
 * capture-docs.mjs — documentation screenshots (docs/screenshots/).
 *
 * Drives the REAL built app (dist/index.html) in headless Chromium through
 * the full user journey and captures four PNGs at 1280×800 (2x device scale):
 *
 *   01-landing.png     fresh intake: stepper + drop zone + footer version badge
 *   02-capability.png  detectable.mp4 opened: capability report + Analyze enabled
 *   03-review.png      analyze (dashcam OFF) done: overlay box, timeline chips, track list
 *   04-export.png      export done: "Exported" status + done stepper
 *
 * Interaction patterns mirror tests/e2e/auto-detect.spec.js (same selectors
 * and completion waits — this script is NOT a test, it must not invent new
 * ones). Cold profile downloads the ONNX models (~36 MB) and headless WASM
 * inference on the 90-frame clip takes minutes — every wait is generous.
 *
 * Usage: node tools/capture-docs.mjs   (PORT env overrides the default 8123)
 *
 * Each shot is retried once; failures are reported honestly at the end and
 * the process exits non-zero if any shot is missing.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs', 'screenshots');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');
const PORT = Number(process.env.PORT) || 8123;
const BASE = `http://127.0.0.1:${PORT}`;
const MIN_BYTES = 30 * 1024; // a real 2560×1600 UI shot is far above this

// ---------------------------------------------------------------------------
// Static server (same zero-dependency server the dev/E2E flow uses)
// ---------------------------------------------------------------------------

function startServer() {
  const child = spawn(process.execPath, ['tools/serve.mjs'], {
    cwd: ROOT,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
    stdio: 'ignore',
  });
  return child;
}

async function waitUntilUp(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet — poll again */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`dev server did not come up at ${url} (is port ${PORT} taken? set PORT=...)`);
}

// ---------------------------------------------------------------------------
// Shot helpers
// ---------------------------------------------------------------------------

/** Capture one shot with a single retry; returns {name, bytes} or throws. */
async function captureShot(page, name, prepare) {
  const path = join(OUT_DIR, name);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await prepare();
      await page.screenshot({ path });
      const bytes = statSync(path).size;
      if (bytes < MIN_BYTES) throw new Error(`suspiciously small PNG (${bytes} bytes)`);
      console.log(`captured ${name}: ${(bytes / 1024).toFixed(1)} KiB`);
      return { name, bytes };
    } catch (err) {
      lastErr = err;
      console.warn(`attempt ${attempt} failed for ${name}: ${err instanceof Error ? err.message : String(err)}`);
      await page.waitForTimeout(2_000); // let transient UI settle before retry
    }
  }
  return { name, error: lastErr instanceof Error ? lastErr.message : String(lastErr) };
}

/** Wait for a predicate inside the page (polls on an interval). */
async function waitForPage(page, predicateFn, timeoutMs, label) {
  try {
    await page.waitForFunction(predicateFn, null, { timeout: timeoutMs, polling: 500 });
  } catch {
    throw new Error(`timeout waiting for ${label}`);
  }
}

/** Remove any live toasts so a shot shows steady-state UI (docs cleanliness). */
async function clearToasts(page) {
  await page.evaluate(() => {
    document.querySelectorAll('#toast-region .toast').forEach((el) => el.remove());
  });
}

/** Seek the preview video and resolve after the editor has redrawn the frame. */
async function seekPreview(page, time) {
  await page.evaluate(async (t) => {
    const v = document.getElementById('preview-video');
    if (!(v instanceof HTMLVideoElement)) throw new Error('#preview-video missing');
    await new Promise((resolveSeeked) => {
      if (Math.abs(v.currentTime - t) < 0.01 && v.readyState >= 2) return resolveSeeked();
      const done = () => {
        v.removeEventListener('seeked', done);
        resolveSeeked();
      };
      v.addEventListener('seeked', done);
      v.pause();
      v.currentTime = t;
    });
    // Two rAFs: the overlay redraw is driven by the editor's frame loop.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, time);
  await page.waitForTimeout(300); // overlay paint + compositor settle
}

// ---------------------------------------------------------------------------
// Journey
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const server = startServer();
  const results = [];
  let downloadTmp = '';

  try {
    await waitUntilUp(`${BASE}/dist/index.html`);
    const browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);

    // ── Shot 1: fresh landing (stepper + drop zone + footer version badge) ──
    results.push(await captureShot(page, '01-landing.png', async () => {
      await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load', timeout: 60_000 });
      await page.locator('#serve-gate').waitFor({ state: 'hidden', timeout: 20_000 });
      await page.locator('#drop-zone').waitFor({ state: 'visible', timeout: 20_000 });
      await waitForPage(
        page,
        () => /v\d+\.\d+\.\d+ · built \d{4}-\d{2}-\d{2}|dev build/.test(
          document.getElementById('app-version')?.textContent ?? '',
        ),
        10_000,
        'footer #app-version badge text',
      );
      const badge = await page.locator('#app-version').textContent();
      console.log(`  version badge reads: "${badge}"`);
    }));

    // ── Open the verified-detectable fixture → Shot 2: capability report ────
    results.push(await captureShot(page, '02-capability.png', async () => {
      await page.locator('#file-input').setInputFiles(FIXTURE);
      await page.locator('#cap-report').waitFor({ state: 'visible', timeout: 60_000 });
      await waitForPage(
        page,
        () => Boolean(document.querySelector('#cap-report td.cap-ok')),
        30_000,
        'capability probe ok rows',
      );
      await waitForPage(
        page,
        () => {
          const b = document.querySelector('#analyze-button');
          return b instanceof HTMLButtonElement && !b.disabled;
        },
        30_000,
        'Analyze button enabled',
      );
      await clearToasts(page);
      await page.waitForTimeout(400); // table layout settle
    }));

    // ── Analyze (dashcam OFF) — mirrors auto-detect.spec.js ──────────────────
    let analyzed = true;
    try {
      const dashcam = page.locator('#dashcam-toggle');
      if (await dashcam.isChecked()) await dashcam.uncheck();
      await page.locator('#analyze-button').click();
      await waitForPage(
        page,
        () => document.getElementById('step-review')?.getAttribute('aria-current') === 'step',
        280_000, // cold model download (~36 MB) + 90 WASM-inferred frames
        'analyze completion (step-review current)',
      );
      await waitForPage(
        page,
        () => document.querySelectorAll('#track-list li.track-row').length >= 1,
        30_000,
        'track list rows',
      );
    } catch (err) {
      analyzed = false;
      console.error(`analyze step failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (analyzed) {
      // ── Shot 3: review — overlay box + timeline chips + right-rail tracks ──
      results.push(await captureShot(page, '03-review.png', async () => {
        await seekPreview(page, 1.0); // mid-clip: face composed cover-top is on screen
        await waitForPage(
          page,
          () => document.querySelectorAll('#track-chips div[title]').length >= 1,
          15_000,
          'timeline track chips',
        );
        await clearToasts(page);
        await page.waitForTimeout(300);
      }));
    } else {
      results.push({ name: '03-review.png', error: 'analyze step failed — no review state' });
    }

    // ── Export → Shot 4: done state + "Exported" status/toast ───────────────
    let exported = analyzed;
    if (analyzed) {
      try {
        const alreadyDone = (await page.locator('#export-status').textContent())?.includes('Exported');
        if (!alreadyDone) {
          const downloadPromise = page.waitForEvent('download', { timeout: 240_000 });
          await page.locator('#export-button').click();
          const download = await downloadPromise; // headless → Blob-download fallback
          downloadTmp = join(tmpdir(), `video-redact-docs-export-${Date.now()}.mp4`);
          await download.saveAs(downloadTmp);
        }
        await waitForPage(
          page,
          () => (document.getElementById('export-status')?.textContent ?? '').includes('Exported'),
          240_000,
          '"Exported" export status',
        );
        await waitForPage(
          page,
          () => document.getElementById('step-export')?.classList.contains('done') === true,
          30_000,
          'export step done',
        );
      } catch (err) {
        exported = false;
        console.error(`export step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (exported) {
      // Capture promptly so the "Exported" ok-toast (5 s auto-dismiss) is in frame.
      results.push(await captureShot(page, '04-export.png', async () => {
        await waitForPage(
          page,
          () => (document.getElementById('export-status')?.textContent ?? '').includes('Exported'),
          30_000,
          '"Exported" export status',
        );
        await page.waitForTimeout(300);
      }));
    } else {
      results.push({ name: '04-export.png', error: 'export step failed or analyze never completed' });
    }

    await browser.close();
  } finally {
    server.kill();
    if (downloadTmp) rmSync(downloadTmp, { force: true });
  }

  // ── Honest summary ─────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.error);
  console.log('\n=== capture-docs summary ===');
  for (const r of results) {
    if (r.error) console.log(`FAILED ${r.name}: ${r.error}`);
    else console.log(`OK     ${r.name} (${(r.bytes / 1024).toFixed(1)} KiB)`);
  }
  if (failed.length > 0) {
    console.error(`${failed.length} shot(s) failed`);
    process.exitCode = 1;
  } else {
    console.log('all 4 shots captured');
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
