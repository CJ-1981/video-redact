#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: /src/* imports resolve on the served origin, not at typecheck time
/**
 * probe-synthetic.mjs (v3) — TEMPORARY diagnosis: pinpoints WHICH call in
 * the dashcam analyze loop emits garbage face detections. Replicates
 * analyze.js's per-frame sequence with ONE createDetectors instance and the
 * shared scratch, printing per-call detection counts + top boxes:
 *   face(full) -> [plate(full)] -> face(tile0) -> [plate(tile0)] ->
 *   face(tile1) -> [plate(tile1)]
 * Run: node tools/probe-synthetic.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8179;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});

async function waitForServer(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`probe server did not come up at ${url}`);
}

async function inPageProbe() {
  const { ALL_FORMATS, BlobSource, Input, VideoSampleSink } = await import('mediabunny');
  const det = await import('/src/detector.js');
  const { tileGrid } = det;

  const clip = await fetch('/tests/fixtures/synthetic.mp4').then((r) => r.blob());
  const input = new Input({ source: new BlobSource(clip), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  const sink = new VideoSampleSink(track);

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const fmt = (d) => d.map((x) => ({ conf: +x.conf.toFixed(3), box: {
    x: +x.box.x.toFixed(1), y: +x.box.y.toFixed(1), w: +x.box.w.toFixed(1), h: +x.box.h.toFixed(1),
  } }));

  // Config flag: whether the plate detector runs between face calls (A vs B).
  const withPlates = true;

  const detectors = await det.createDetectors();
  const tiles = tileGrid({ width: 640, height: 360 });
  const out = { tiles: tiles.map((t) => ({ x: t.x, w: t.w })), frames: [] };

  let frameIdx = 0;
  for await (const sample of sink.samples()) {
    if (frameIdx >= 3) break;
    sample.draw(ctx, 0, 0, 640, 360);
    const frame = ctx.getImageData(0, 0, 640, 360);
    const calls = [];
    const f1 = await detectors.detectFace(frame);
    calls.push({ call: 'face(full)', n: f1.length, top: fmt(f1.slice(0, 3)) });
    if (withPlates) {
      const p1 = await detectors.detectPlate(frame);
      calls.push({ call: 'plate(full)', n: p1.length });
    }
    const tileDets = [];
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const raster = ctx.getImageData(tile.x, tile.y, tile.w, tile.h);
      const d = await detectors.detectFace(raster);
      calls.push({ call: `face(tile${i})`, n: d.length, top: fmt(d.slice(0, 3)) });
      tileDets.push(...d);
      if (withPlates) {
        const p = await detectors.detectPlate(raster);
        calls.push({ call: `plate(tile${i})`, n: p.length });
      }
    }
    out.frames.push({ frame: frameIdx, calls, tileDetsTotal: tileDets.length });
    sample.close();
    frameIdx += 1;
  }

  // Control: same detectors instance, clean full-frame call AFTER the loop.
  const post = await detectors.detectFace(ctx.getImageData(0, 0, 640, 360));
  out.postLoopFaceFull = { n: post.length, top: fmt(post.slice(0, 3)) };
  // Control 2: FRESH instance, tile call.
  const fresh = await det.createDetectors();
  const postTile = await fresh.detectFace(ctx.getImageData(0, 0, 320, 360));
  out.freshInstanceTile = { n: postTile.length, top: fmt(postTile.slice(0, 3)) };
  fresh.close();
  detectors.close();
  return out;
}

let browser;
try {
  await waitForServer(`${BASE}/tools/fixture-page.html`);
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`[pageerror] ${e?.message ?? e}`));
  await page.goto(`${BASE}/tools/fixture-page.html`, { waitUntil: 'load', timeout: 60_000 });
  const report = await Promise.race([
    page.evaluate(inPageProbe),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('probe timed out after 150s')), 150_000);
      t.unref?.();
    }),
  ]);
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
}
process.exit(0);
