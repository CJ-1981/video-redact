#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-export-settings.mjs — REAL end-to-end verification of the v1.16.0
 * export settings (field report: "export resolution and audio removal are
 * not working, exported file still same").
 *
 * Flow: dist → load detectable.mp4 → analyze (warm profile) → review →
 * set #export-resolution = 720p → uncheck #export-audio → export → capture
 * the download bytes → open them as a mediabunny Input IN THE PAGE →
 * report: video display dims (expect 720 long edge) + audio track count
 * (expect 0). Also dumps the captured #export-resolution value at click
 * time for wiring sanity.
 *
 * Run: node tools/debug-export-settings.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8171;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = join(ROOT, 'test-results', 'big-clip.mp4'); // 2560x1440 + AAC — 720p genuinely scales

const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  storageState: 'test-results/regression-probe-profile/state.json',
}).catch(() => browser.newContext({ viewport: { width: 1280, height: 800 } }));
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

try {
  await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  const badge = await page.textContent('#app-version');
  console.log('badge:', badge);

  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 240000 });
  console.log('--- review reached ---');

  // Sanity: the controls exist and hold the values we set.
  await page.selectOption('#export-resolution', '720p');
  await page.uncheck('#export-audio');
  const selVal = await page.inputValue('#export-resolution');
  const audioChecked = await page.isChecked('#export-audio');
  check('controls set', selVal === '720p' && audioChecked === false, `sel=${selVal} audioChecked=${audioChecked}`);

  // Export (720p + no audio).
  const downloadPromise = page.waitForEvent('download', { timeout: 280000 });
  await page.locator('#export-button').click();
  await expectExported(page);
  const download = await downloadPromise;
  const outPath = await download.path();
  console.log('downloaded:', download.suggestedFilename());

  // Measure the output IN THE PAGE with real mediabunny.
  const b64 = (await import('node:fs')).readFileSync(outPath).toString('base64');
  const report = await page.evaluate(async (b64) => {
    const mb = await import('mediabunny');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const input = new mb.Input({
      source: new mb.BufferSource(bytes),
      formats: mb.ALL_FORMATS,
    });
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getAudioTracks();
    const dim = (t) =>
      typeof t.displayWidth === 'function' ? t.displayWidth() : t.displayWidth;
    const dimH = (t) =>
      typeof t.displayHeight === 'function' ? t.displayHeight() : t.displayHeight;
    return {
      w: await dim(v),
      h: await dimH(v),
      codec: v.codec,
      audioTracks: a.length,
      audioCodec: a[0]?.codec ?? null,
      duration: await input.computeDuration(),
    };
  }, b64);
  console.log('OUTPUT:', JSON.stringify(report));

  const longEdge = Math.max(report.w, report.h);
  check('resolution: long edge = 1280 (720p)', longEdge === 1280, `${report.w}x${report.h} (long ${longEdge})`);
  check('audio removed: 0 audio tracks', report.audioTracks === 0, `tracks=${report.audioTracks}`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);

async function expectExported(page) {
  await page.waitForFunction(
    () => /Exported/i.test(document.querySelector('#export-status')?.textContent ?? ''),
    null,
    { timeout: 280000 },
  );
}
