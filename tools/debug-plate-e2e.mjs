#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-plate-e2e.mjs — END-TO-END plate proof on the USER'S REAL FRAMES:
 * production path only — /src/detector.js createDetectors() → detectPlate
 * (frameToTensor RGB 0-1 → real session → parsePlateRows). Asserts the
 * plate in frame-6s.png (user's IMG_5019.MOV t=6s, plate "GG LP 180 E" at
 * display [330..660]x[910..980]) is detected with conf >= 0.5 and the box
 * lands within 15% of the expected display rect. Also reports frame-5s.
 *
 * Run: node tools/debug-plate-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8175;
const BASE = `http://127.0.0.1:${PORT}`;
const FRAMES = [
  { url: '/test-results/plate-frames/frame-6s.png', expectPlate: [330, 910, 660, 980] },
  { url: '/test-results/plate-frames/frame-5s.png', expectPlate: null },
];

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

  const results = await page.evaluate(async (frames) => {
    const det = await import('/src/detector.js');
    const detectors = await det.createDetectors({ epPolicy: ['wasm'] });
    const out = [];
    try {
      for (const f of frames) {
        const img = await new Promise((res, rej) => {
          const image = new Image();
          image.crossOrigin = 'anonymous';
          image.onload = () => {
            const c = document.createElement('canvas');
            c.width = image.naturalWidth;
            c.height = image.naturalHeight;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(image, 0, 0);
            res(ctx.getImageData(0, 0, c.width, c.height));
          };
          image.onerror = () => rej(new Error('load failed'));
          image.src = f.url;
        });
        const raw = await detectors.detectPlateRaw(img);
        const t = raw.rows ?? Object.values(raw)[0];
        let dims = null, top = null;
        if (t && t.dims) {
          dims = t.dims;
          const data = t.data;
          const cols = dims[dims.length - 1];
          const n = dims[dims.length - 2];
          const scored = [];
          for (let i = 0; i < n; i++) scored.push({ sc: data[i * cols + cols - 1], raw: Array.from(data.slice(i * cols, i * cols + cols)).map((v) => +v.toFixed(2)) });
          scored.sort((a, b) => b.sc - a.sc);
          top = scored.slice(0, 3).map((e) => e.raw);
        }
        const dets = await detectors.detectPlate(img);
        out.push({ url: f.url, w: img.width, h: img.height, dims, top, dets: dets.map((d) => ({
          box: { x: +d.box.x.toFixed(1), y: +d.box.y.toFixed(1), w: +d.box.w.toFixed(1), h: +d.box.h.toFixed(1) },
          conf: +d.conf.toFixed(3),
        })) });
      }
    } finally {
      await detectors.close();
    }
    return out;
  }, FRAMES);

  for (const r of results) {
    console.log(`${r.url} (${r.w}x${r.h}): ${r.dets.length} plate detection(s)`);
    for (const d of r.dets) console.log('   ', JSON.stringify(d));
  }

  // assertion on frame-6s: the known plate must be detected with conf >= 0.5
  const f6 = results.find((r) => r.url.endsWith('frame-6s.png'));
  check('frame-6s: plate detected', f6 && f6.dets.length >= 1, JSON.stringify(f6?.dets ?? []));
  const best = f6?.dets?.slice().sort((a, b) => b.conf - a.conf)[0];
  check('frame-6s: confidence >= 0.5', !!best && best.conf >= 0.5, `conf=${best?.conf}`);
  if (best) {
    // expected display rect [330, 910, 660, 980]; allow 15% of frame diagonal-ish tolerance
    const exp = { x: 330, y: 910, w: 330, h: 70 };
    const cx = best.box.x + best.box.w / 2;
    const cy = best.box.y + best.box.h / 2;
    const ecx = exp.x + exp.w / 2;
    const ecy = exp.y + exp.h / 2;
    const distOk = Math.hypot(cx - ecx, cy - ecy) < 120;
    check('frame-6s: box center within 120px of the real plate', distOk, `center=(${cx.toFixed(0)},${cy.toFixed(0)}) expected≈(${ecx},${ecy})`);
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
