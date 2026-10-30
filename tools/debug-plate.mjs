#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-plate.mjs — plate-path diagnostic with the USER'S REAL FRAMES
 * (test-results/plate-frames/frame-{5,15}s.png, extracted via ffmpeg from
 * IMG_5019.MOV 4K portrait HEVC). The plate path has never been validated
 * end-to-end with a real detection; this probe runs the production plate
 * session across 4 preprocessing variants (RGB/BGR x 0-1/0-255) and dumps
 * raw output shapes + score distributions per variant, per frame.
 *
 * Run: node tools/debug-plate.mjs   (model cached in the persistent profile;
 * serve.mjs spawned on 8177, killed on exit)
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8177;
const BASE = `http://127.0.0.1:${PORT}`;
const FRAMES = ['/test-results/plate-frames/plate-crop.png', '/test-results/plate-frames/frame-6s.png', '/test-results/plate-frames/frame-5s.png'];

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

  const report = await page.evaluate(async (frames) => {
    const ort = await import('onnxruntime-web');
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
    ort.env.wasm.numThreads = 1;

    // Same model URL + cache as production (src/models.js registry).
    const { ensureModel } = await import('/src/models.js');
    const bytes = await ensureModel('plate-yolov9t', () => {});
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });

    const TARGET = 640;
    const letterboxGeometry = (fw, fh) => {
      const ratio = Math.min(TARGET / fw, TARGET / fh);
      return {
        ratio,
        padX: (TARGET - fw * ratio) / 2,
        padY: (TARGET - fh * ratio) / 2,
        scaledW: fw * ratio,
        scaledH: fh * ratio,
      };
    };

    /** Build CHW tensor with a given channel order + scale from ImageData. */
    const buildTensor = (img, geom, order, scale, norm) => {
      const { width: fw, height: fh, data } = img;
      const out = new Float32Array(3 * TARGET * TARGET);
      const chan = order === 'rgb' ? [0, 1, 2] : [2, 1, 0];
      const planes = [out.subarray(0, TARGET * TARGET), out.subarray(TARGET * TARGET, 2 * TARGET * TARGET), out.subarray(2 * TARGET * TARGET)];
      for (let y = 0; y < TARGET; y++) {
        for (let x = 0; x < TARGET; x++) {
          // inverse letterbox -> source pixel
          const sx = Math.min(fw - 1, Math.max(0, Math.round((x - geom.padX) / geom.ratio)));
          const sy = Math.min(fh - 1, Math.max(0, Math.round((y - geom.padY) / geom.ratio)));
          const si = (sy * fw + sx) * 4;
          const di = y * TARGET + x;
          for (let c = 0; c < 3; c++) {
            let v = data[si + chan[c]] * scale;
            if (norm) v = (v - norm[0][c]) / norm[1][c];
            planes[c][di] = v;
          }
        }
      }
      return out;
    };

    const out = { inputNames: session.inputNames, outputNames: session.outputNames, frames: [] };
    for (const url of frames) {
      const img = await new Promise((resolveImg, reject) => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => {
          const c = document.createElement('canvas');
          c.width = image.naturalWidth;
          c.height = image.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(image, 0, 0);
          resolveImg(ctx.getImageData(0, 0, c.width, c.height));
        };
        image.onerror = () => reject(new Error('img load failed: ' + url));
        image.src = url;
      });
      const geom = letterboxGeometry(img.width, img.height);
      const frameReport = { url, w: img.width, h: img.height, variants: {} };
      const IMAGENET_MEAN = [0.485, 0.456, 0.406];
      const IMAGENET_STD = [0.229, 0.224, 0.225];
      const VARIANTS = [
        ['rgb-0-1', 'rgb', 1 / 255, null],
        ['rgb-0-255', 'rgb', 1, null],
        ['bgr-0-1', 'bgr', 1 / 255, null],
        ['rgb-imagenet', 'rgb', 1 / 255, [IMAGENET_MEAN, IMAGENET_STD]],
      ];
      for (const [key, order, scale, norm] of VARIANTS) {
        {
          const tensor = buildTensor(img, geom, order, scale, norm);
          const feed = { [session.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, TARGET, TARGET]) };
          const results = await session.run(feed);
          const variant = {};
          for (const name of session.outputNames) {
            const t = results[name];
            const dims = t.dims;
            const data = t.data;
            // dump: per-column min/max over all rows + first 5 rows raw (stride = cols)
            const [a, b] = dims.slice(-2);
            // dump: per-column min/max over all rows + first 5 rows raw (stride = cols)
            const cols = b;
            const colStats = Array.from({ length: cols }, () => ({ min: Infinity, max: -Infinity }));
            const rowsDump = [];
            const nRows = Math.min(a, 100);
            for (let i = 0; i < nRows; i++) {
              const row = [];
              for (let cIdx = 0; cIdx < cols; cIdx++) {
                const v = data[i * cols + cIdx];
                row.push(+v.toFixed(2));
                if (v < colStats[cIdx].min) colStats[cIdx].min = +v.toFixed(2);
                if (v > colStats[cIdx].max) colStats[cIdx].max = +v.toFixed(2);
              }
              if (i < 5) rowsDump.push(row);
            }
            // top-3 by score col (stride cols, score = col 6)
            const scored = [];
            for (let i = 0; i < nRows; i++) scored.push({ sc: data[i * cols + 6], row: rowsDump[Math.min(i, 4)] ?? null, raw: Array.from(data.slice(i * cols, i * cols + cols)).map((v) => +v.toFixed(2)) });
            scored.sort((x, y2) => y2.sc - x.sc);
            variant[name] = { dims: dims.join('x'), colStats, rowsDump, top3: scored.slice(0, 3).map((e) => e.raw) };
          }
          frameReport.variants[key] = variant;
        }
      }
      out.frames.push(frameReport);
    }
    return out;
  }, FRAMES);

  console.log('input:', JSON.stringify(report.inputNames), 'outputs:', JSON.stringify(report.outputNames));
  for (const f of report.frames) {
    console.log(`\n=== ${f.url} (${f.w}x${f.h}) ===`);
    for (const [variant, outputs] of Object.entries(f.variants)) {
      for (const [name, info] of Object.entries(outputs)) {
        console.log(`${variant.padEnd(10)} ${name} [${info.dims}]`);
        console.log('  colStats:', JSON.stringify(info.colStats));
        console.log('  rows5:', JSON.stringify(info.rowsDump));
        console.log('  top3 :', JSON.stringify(info.top3));
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}
