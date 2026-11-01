#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-mobile-export.mjs — MOBILE-context export probe (field report:
 * "on mobile export fails with 'Writing the export file failed...'").
 *
 * Runs the REAL runExport on a mobile-context browser (hasTouch + isMobile)
 * against detectable.mp4, capturing the exact failing stage/cause. Then
 * reports capability facts: does this mobile browser support OPFS
 * createWritable / showSaveFilePicker at all?
 *
 * Run: node tools/debug-mobile-export.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8165;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
// REAL mobile context: Playwright's device descriptors emulate mobile Chrome
const { devices } = await import('@playwright/test');
const context = await browser.newContext({ ...devices['Pixel 7'] });
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

  // capability facts from the mobile context
  const caps = await page.evaluate(async () => {
    const root = await navigator.storage?.getDirectory?.().then(
      (r) => r,
      () => null,
    );
    let dir = null, fileHandle = null, createWritableType = 'missing', syncType = 'missing';
    if (root) {
      try {
        dir = await root.getDirectoryHandle('probe', { create: true });
        fileHandle = await dir.getFileHandle('probe.txt', { create: true });
        createWritableType = typeof fileHandle.createWritable;
        syncType = typeof fileHandle.createSyncAccessHandle;
      } catch { /* recorded below */ }
    }
    return {
      ua: navigator.userAgent,
      opfsRoot: !!root,
      dir: !!dir,
      createWritableType,
      syncType,
      savePicker: typeof window.showSaveFilePicker,
      storagePersist: !!navigator.storage?.persist,
    };
  });
  console.log('MOBILE CAPS:', JSON.stringify(caps, null, 1));

  // Now the REAL runExport on the mobile context.
  const result = await page.evaluate(async (fixtureUrl) => {
    const resp = await fetch(fixtureUrl);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const exporter = await import('/src/exporter.js');
    const mb = await import('mediabunny');
    const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
    const out = { attempts: [] };
    try {
      const r = await exporter.runExport({
        input,
        tracks: [],
        settings: { outputMode: 'stream', quality: 'high' },
        onProgress: (p) => out.attempts.push({ progress: p }),
      });
      out.ok = true;
      out.bytes = r.bytes;
      out.blobType = r.blob?.type;
      out.handle = !!r.handle;
    } catch (err) {
      out.ok = false;
      out.stage = err.stage;
      out.message = err.message;
      out.cause = String(err.cause?.message ?? err.cause ?? '');
    }
    return out;
  }, '/test-results/local-user-clip.mp4').catch((e) => ({ probeError: e.message }));

  console.log('RUNEXPORT RESULT:', JSON.stringify(result, null, 1));
  if (result.ok) {
    check('mobile stream export', true, `bytes=${result.bytes}`);
  } else {
    check('mobile stream export', false, `stage=${result.stage} ${result.message}`);
    console.log('>>> REPRODUCED: mobile export fails. Root cause evidence above.');
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : 'SUMMARY: has failures');
