#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-mb-semantics.mjs — isolate mediabunny 1.63.0 semantics from our code:
 *   E1  audio discard: Conversion with audio:{discard:true} → count output audio tracks
 *   E2  resolution: process returns a SCALED canvas (+processedWidth/Height) → output dims
 * Run: node tools/debug-mb-semantics.mjs  (big-clip.mp4 2560x1440 + AAC)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8169;
const BASE = `http://127.0.0.1:${PORT}`;
const CLIP = '/test-results/big-clip.mp4';

const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({
  storageState: 'test-results/regression-probe-profile/state.json',
}).catch(() => browser.newContext());
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

try {
  await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  const report = await page.evaluate(async (clipUrl) => {
    const mb = await import('mediabunny');
    const res = await fetch(clipUrl);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mkInput = () =>
      new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });

    const scaledProcess = (sample) => {
      const c = new OffscreenCanvas(640, 360);
      const ctx = c.getContext('2d');
      sample.draw(ctx, 0, 0, 640, 360);
      return c;
    };
    async function run(label, videoExtra, rootExtra) {
      const input = mkInput();
      const target = new mb.BufferTarget();
      const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
      const opts = {
        input,
        output,
        video: { codec: 'avc', process: scaledProcess, ...videoExtra },
        ...rootExtra,
      };
      const conversion = await mb.Conversion.init(opts);
      await conversion.execute();
      // measure OUTPUT via a second Input over the produced buffer
      const outBytes = new Uint8Array(target.buffer.buffer ?? target.buffer);
      const outInput = new mb.Input({ source: new mb.BufferSource(outBytes), formats: mb.ALL_FORMATS });
      const ov = await outInput.getPrimaryVideoTrack();
      const oa = await outInput.getAudioTracks();
      const dw = typeof ov.displayWidth === 'function' ? await ov.displayWidth() : ov.displayWidth;
      const dh = typeof ov.displayHeight === 'function' ? await ov.displayHeight() : ov.displayHeight;
      const dur = await outInput.computeDuration();
      return { label, valid: conversion.isValid, outW: dw, outH: dh, audio: oa.length, dur: +dur.toFixed(2) };
    }

    const out = [];
    out.push(await run('E1 audio discard', {}, { audio: { discard: true } }));
    out.push(await run('E2 scale canvas', { processedWidth: 640, processedHeight: 360 }, {}));
    out.push(await run('E3 both', { processedWidth: 640, processedHeight: 360 }, { audio: { discard: true } }));
    return out;
  }, CLIP);

  for (const r of report) console.log(JSON.stringify(r));
} finally {
  await browser.close();
  server.kill();
}
