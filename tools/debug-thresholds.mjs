#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-thresholds.mjs — v1.5.0 REQ-113/114 verification probe (one-shot).
 *
 * Opens dist at a desktop viewport, loads tests/fixtures/detectable.mp4
 * (verified-detectable: 1 face, YuNet conf ≥ 0.6), sets the compare frame
 * time to ~1.0 s, clicks "Compare thresholds", then asserts:
 *   • exactly 5 panels rendered (#threshold-panels .threshold-panel);
 *   • at least one panel's caption reports ≥ 1 face;
 *   • every panel canvas carries the frame pixels (non-blank raster);
 *   • clicking a panel sets BOTH sensitivity sliders + readouts to its level.
 * Wall time click→panels is measured on a COLD click (first use: model
 * download + ORT session create + inference) and a WARM click (inference
 * only) — expectations: < 2 s WebGPU, < 8 s WASM (headless).
 * Run: node tools/debug-thresholds.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8193;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');
const FACE_BUDGET_MS = process.env.WEBGPU ? 2000 : 8000; // < 2s WebGPU / < 8s WASM headless

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

/** Click Compare, wait for the panels, return wall ms + DOM facts. */
async function runCompare() {
  const t0 = Date.now();
  await page.click('#compare-button');
  await page.waitForSelector('#threshold-panels .threshold-panel', { timeout: 60000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#threshold-panels .threshold-panel').length === 5,
    { timeout: 60000 },
  );
  const ms = Date.now() - t0;
  return {
    ms,
    ...(await page.evaluate(() => {
      const panels = [...document.querySelectorAll('#threshold-panels .threshold-panel')];
      const caption = (p) => p.querySelector('.caption')?.textContent ?? '';
      const facesIn = (text) => Number((/(\d+) faces?/.exec(text) ?? [0, 0])[1]);
      const maxFaces = Math.max(0, ...panels.map((p) => facesIn(caption(p))));
      const canvases = panels.map((p) => {
        const c = p.querySelector('canvas');
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let nonBlack = 0;
        for (let i = 0; i < d.length; i += 40) if (d[i] + d[i + 1] + d[i + 2] > 30) nonBlack++;
        return { w: c.width, h: c.height, nonBlackSamples: nonBlack };
      });
      return {
        captions: panels.map(caption),
        maxFaces,
        canvases,
        face: Number(document.getElementById('conf-face')?.value),
        plate: Number(document.getElementById('conf-plate')?.value),
        faceOut: document.getElementById('conf-face-out')?.textContent ?? '',
        plateOut: document.getElementById('conf-plate-out')?.textContent ?? '',
        status: document.getElementById('compare-status')?.textContent ?? '',
        buttonLabel: document.getElementById('compare-button')?.textContent ?? '',
      };
    })),
  };
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });

  const gpu = await page.evaluate(() => typeof navigator.gpu === 'object');
  console.log(`navigator.gpu present: ${gpu} (ORT still decides the EP per its ladder)`);

  // REQ-113 defaults straight from the markup.
  const defaults = await page.evaluate(() => ({
    face: document.getElementById('conf-face')?.value,
    plate: document.getElementById('conf-plate')?.value,
    faceOut: document.getElementById('conf-face-out')?.textContent,
    plateOut: document.getElementById('conf-plate-out')?.textContent,
    timeMax: document.getElementById('compare-time')?.max,
    timeValue: document.getElementById('compare-time')?.value,
  }));
  check('face slider default', defaults.face === '0.6' && defaults.faceOut === '0.60', JSON.stringify(defaults));
  check('plate slider default', defaults.plate === '0.25' && defaults.plateOut === '0.25', `${defaults.plate}/${defaults.plateOut}`);

  // REQ-114: frame time ~1.0 s (fixture is 3 s — default round(3·0.1) = 0.3).
  await page.fill('#compare-time', '1');
  const seeded = await page.evaluate(() => ({
    value: document.getElementById('compare-time')?.value,
    max: document.getElementById('compare-time')?.max,
  }));
  check('frame-time input seeded', seeded.value === '1' && Number(seeded.max) > 3 && Number(seeded.max) < 3.2, JSON.stringify(seeded));

  console.log('--- cold compare (model download + session create + inference) ---');
  const cold = await runCompare();
  console.log(`cold wall: ${cold.ms} ms · status: "${cold.status}" · button: "${cold.buttonLabel}"`);
  check('5 panels rendered', cold.captions.length === 5, JSON.stringify(cold.captions));
  check('a panel reports ≥1 face (fixture is verified-detectable)', cold.maxFaces >= 1, `max faces ${cold.maxFaces}`);
  check(
    'panel canvases carry the frame (≈30% panel width, non-blank)',
    cold.canvases.every((c) => c.w >= 90 && c.h >= 45 && c.nonBlackSamples > 10),
    JSON.stringify(cold.canvases),
  );

  console.log('--- warm compare (inference only) ---');
  const warm = await runCompare();
  console.log(`warm wall: ${warm.ms} ms · captions: ${JSON.stringify(warm.captions)}`);
  check('warm 5 panels again', warm.captions.length === 5, `${warm.captions.length} panels`);
  check(`warm wall < ${FACE_BUDGET_MS} ms (REQ-114 ~2s WebGPU / ~8s WASM)`, warm.ms < FACE_BUDGET_MS, `${warm.ms} ms`);

  // Panel click → BOTH sliders (REQ-114 apply mapping). Click the 3rd panel (0.45).
  await page.locator('#threshold-panels .threshold-panel').nth(2).click();
  const applied = await page.evaluate(() => ({
    face: document.getElementById('conf-face')?.value,
    plate: document.getElementById('conf-plate')?.value,
    faceOut: document.getElementById('conf-face-out')?.textContent,
    plateOut: document.getElementById('conf-plate-out')?.textContent,
  }));
  check(
    'panel click applies its level to BOTH sliders + readouts',
    applied.face === '0.45' && applied.plate === '0.45' && applied.faceOut === '0.45' && applied.plateOut === '0.45',
    JSON.stringify(applied),
  );

  // The configured thresholds must reach the analyze pass: settings flow is
  // unit-tested (analyze.test.js), here we verify the live readout seam.
  await page.evaluate(() => {
    const el = document.getElementById('conf-face');
    el.value = '0.3';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const readout = await page.evaluate(() => document.getElementById('conf-face-out')?.textContent);
  check('slider input updates its readout live', readout === '0.30', `readout ${readout}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
