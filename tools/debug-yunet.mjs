#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: /src/* imports resolve on the served origin, not at typecheck time
/**
 * debug-yunet.mjs — SPEC-VID-001 detection-path diagnosis (dev tool).
 *
 * Symptom: the PRODUCTION detector path (src/detector.js createDetectors →
 * detectFace, confThreshold 0.6) reports 0 faces on composed frames of two
 * known-clear portraits (fixture.json detectableFace.attempts — 8 attempts,
 * 0 detections, both EP ladders). Unit tests are circular (synthetic tensors
 * crafted to match the implementation), so this script probes the REAL model
 * end-to-end and tries the four preprocessing variants most likely to
 * diverge, plus the three grid-indexing interpretations:
 *
 *   tensor variants  : rgb-0-1 (production frameToTensor) · bgr-0-1 ·
 *                      rgb-0-255 · bgr-0-255
 *   anchor indexing  : rowmajor (idx = r·G + c, production) · colmajor
 *                      (idx = c·G + r) · axesswap (rowmajor idx, x/y decode
 *                      axes swapped)
 *
 * Per variant+stride it reports raw cls/obj value ranges (tells whether the
 * model applies sigmoid in-graph), the max sigmoid(cls)·sigmoid(obj) score,
 * the count ≥ 0.05, and decoded display-space boxes at 0.05 per indexing
 * interpretation. It ALSO cross-checks the real decodeYunetOutputs on the
 * production tensors (0.6 and 0.05) and simulates the candidate fix on the
 * winning variant. Prints one JSON diagnosis and exits 0.
 *
 * Run: node tools/debug-yunet.mjs   (downloads the YuNet model + ORT wasm on
 * first run; serve.mjs is spawned on port 8178 and killed on exit)
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8178;
const BASE = `http://127.0.0.1:${PORT}`;
const PHOTO_URL =
  'https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama-1080p.jpg';

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
  throw new Error(`debug server did not come up at ${url}`);
}

/**
 * The whole diagnosis runs in ONE page evaluate (same origin as /src/*.js).
 * Session config replicates createDetectors exactly: wasmPaths pin,
 * numThreads 1, EP ladder ['webgpu','wasm'] with retry.
 * @param {string} photoUrl
 */
async function inPageDebug(photoUrl) {
  const TARGET = 640;
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  const det = await import('/src/detector.js');
  const modelsMod = await import('/src/models.js');

  const FRAME = { width: 640, height: 360 };
  const geom = det.letterboxGeometry(FRAME, TARGET);

  // Compose the photo 'contain' into 640×360 (identical to make-fixture).
  const resp = await fetch(photoUrl, { mode: 'cors', redirect: 'follow' });
  if (!resp.ok) throw new Error(`photo fetch HTTP ${resp.status}`);
  const bmp = await createImageBitmap(await resp.blob());
  const canvas = document.createElement('canvas');
  canvas.width = FRAME.width;
  canvas.height = FRAME.height;
  const c2d = canvas.getContext('2d', { willReadFrequently: true });
  c2d.fillStyle = '#20242c';
  c2d.fillRect(0, 0, FRAME.width, FRAME.height);
  const fitScale = Math.min(FRAME.width / bmp.width, FRAME.height / bmp.height);
  const dw = bmp.width * fitScale;
  const dh = bmp.height * fitScale;
  const dx0 = (FRAME.width - dw) / 2;
  const dy0 = (FRAME.height - dh) / 2;
  c2d.drawImage(bmp, dx0, dy0, dw, dh);
  const imageData = c2d.getImageData(0, 0, FRAME.width, FRAME.height);

  const inputRGB = det.frameToTensor(imageData, geom, TARGET);
  const nPx = TARGET * TARGET;
  const chMean = (ch) => {
    let s = 0;
    for (let i = 0; i < nPx; i++) s += inputRGB[ch * nPx + i];
    return +(s / nPx).toFixed(4);
  };
  let tMin = Infinity;
  let tMax = -Infinity;
  for (let i = 0; i < inputRGB.length; i++) {
    const v = inputRGB[i];
    if (v < tMin) tMin = v;
    if (v > tMax) tMax = v;
  }

  // Session EXACTLY as createDetectors creates it.
  const ort = await import('onnxruntime-web');
  ort.env.wasm.wasmPaths = det.ORT_WASM_PATHS;
  ort.env.wasm.numThreads = 1;
  const bytes = await modelsMod.ensureModel('yunet');
  const eps = ['webgpu', 'wasm'];
  let session = null;
  let effectiveEp = null;
  const epErrors = [];
  for (let i = 0; i < eps.length && !session; i++) {
    const trial = eps.slice(i);
    try {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: trial,
        graphOptimizationLevel: 'all',
      });
      effectiveEp = trial[0];
    } catch (e) {
      epErrors.push(`${trial[0]}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  if (!session) throw new Error(`no session; EP errors: ${epErrors.join(' | ')}`);

  const inputBGR = (() => {
    const o = inputRGB.slice();
    for (let i = 0; i < nPx; i++) {
      const r = o[i];
      o[i] = o[2 * nPx + i];
      o[2 * nPx + i] = r;
    }
    return o;
  })();
  const scaleT = (t, k) => {
    const o = new Float32Array(t.length);
    for (let i = 0; i < t.length; i++) o[i] = t[i] * k;
    return o;
  };

  const pick = (outputs, token) => {
    const entries = Object.entries(outputs);
    const hit = entries.find(([k]) => k === token) ?? entries.find(([k]) => k.endsWith(token));
    if (!hit) throw new Error(`missing output "${token}" (have: ${entries.map(([k]) => k).join(', ')})`);
    return { key: hit[0], data: hit[1].data, dims: hit[1].dims };
  };

  const unlb = (v, axis) => (v - (axis === 'x' ? geom.padX : geom.padY)) / geom.ratio;

  function analyzeVariant(label, outputs, runMs) {
    const perStride = [];
    for (const stride of [8, 16, 32]) {
      const cls = pick(outputs, `cls_${stride}`);
      const obj = pick(outputs, `obj_${stride}`);
      const bb = pick(outputs, `bbox_${stride}`);
      const G = 640 / stride;
      const n = G * G;
      const planar = Array.isArray(bb.dims) && bb.dims.length === 3 && bb.dims[1] === 4 && bb.dims[2] === n;
      const at = (i, k) => (planar ? bb.data[k * n + i] : bb.data[i * 4 + k]);

      let clsMin = Infinity;
      let clsMax = -Infinity;
      let objMin = Infinity;
      let objMax = -Infinity;
      let maxProdRaw = 0;
      let maxProd = 0;
      let argI = 0;
      let cnt = 0;
      for (let i = 0; i < n; i++) {
        const cv = cls.data[i];
        const ov = obj.data[i];
        if (cv < clsMin) clsMin = cv;
        if (cv > clsMax) clsMax = cv;
        if (ov < objMin) objMin = ov;
        if (ov > objMax) objMax = ov;
        if (cv * ov > maxProdRaw) maxProdRaw = cv * ov;
        const p = sigmoid(cv) * sigmoid(ov);
        if (p > maxProd) {
          maxProd = p;
          argI = i;
        }
        if (p >= 0.05) cnt++;
      }

      // Decode under the three anchor interpretations at conf 0.05.
      const decode = (mode) => {
        const boxes = [];
        for (let i = 0; i < n; i++) {
          const p = sigmoid(cls.data[i]) * sigmoid(obj.data[i]);
          if (p < 0.05) continue;
          const rDig = Math.floor(i / G);
          const cDig = i % G;
          let cx;
          let cy;
          if (mode === 'axesswap') {
            cx = (rDig + at(i, 0)) * stride;
            cy = (cDig + at(i, 1)) * stride;
          } else {
            const cc = mode === 'colmajor' ? rDig : cDig;
            const rr = mode === 'colmajor' ? cDig : rDig;
            cx = (cc + at(i, 0)) * stride;
            cy = (rr + at(i, 1)) * stride;
          }
          const w = Math.exp(at(i, 2)) * stride;
          const h = Math.exp(at(i, 3)) * stride;
          boxes.push({
            conf: +p.toFixed(4),
            x: +unlb(cx - w / 2, 'x').toFixed(1),
            y: +unlb(cy - h / 2, 'y').toFixed(1),
            w: +(w / geom.ratio).toFixed(1),
            h: +(h / geom.ratio).toFixed(1),
          });
        }
        boxes.sort((a, b) => b.conf - a.conf);
        return { count: boxes.length, top: boxes.slice(0, 2) };
      };

      perStride.push({
        stride,
        clsDims: JSON.stringify(cls.dims),
        bboxDims: JSON.stringify(bb.dims),
        bboxLayout: planar ? 'planar[1,4,N]' : 'interleaved[1,N,4]',
        clsRange: [+clsMin.toFixed(4), +clsMax.toFixed(4)],
        objRange: [+objMin.toFixed(4), +objMax.toFixed(4)],
        maxClsTimesObjNoSigmoid: +maxProdRaw.toFixed(4),
        maxScore: +maxProd.toFixed(6),
        argmaxIdx: argI,
        argmaxRowCol: [Math.floor(argI / G), argI % G],
        countGe0_05: cnt,
        decodeAt0_05: {
          rowmajor: decode('rowmajor'),
          colmajor: decode('colmajor'),
          axesswap: decode('axesswap'),
        },
      });
    }
    return { label, runMs, perStride };
  }

  const runVariant = async (label, tensorData) => {
    const feed = { [session.inputNames[0]]: new ort.Tensor('float32', tensorData, [1, 3, TARGET, TARGET]) };
    const t0 = performance.now();
    const results = await session.run(feed);
    return analyzeVariant(label, results, +(performance.now() - t0).toFixed(1));
  };

  const variants = [];
  variants.push(await runVariant('rgb-0-1 (production frameToTensor)', inputRGB));
  variants.push(await runVariant('bgr-0-1', inputBGR));
  variants.push(await runVariant('rgb-0-255', scaleT(inputRGB, 255)));
  variants.push(await runVariant('bgr-0-255', scaleT(inputBGR, 255)));

  // Real production decode on the production tensors (cross-check + baseline).
  const prodResults = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', inputRGB, [1, 3, TARGET, TARGET]),
  });
  const prodAt0_6 = det.decodeYunetOutputs(prodResults, undefined, geom, { confThreshold: 0.6, nmsIoU: 0.3 });
  const prodAt0_05 = det.decodeYunetOutputs(prodResults, undefined, geom, { confThreshold: 0.05, nmsIoU: 0.3 });

  // Simulate the candidate fix (BGR 0-255 face input) through the real decode.
  const fixResults = await session.run({
    [session.inputNames[0]]: new ort.Tensor('float32', scaleT(inputBGR, 255), [1, 3, TARGET, TARGET]),
  });
  const fixAt0_6 = det.decodeYunetOutputs(fixResults, undefined, geom, { confThreshold: 0.6, nmsIoU: 0.3 });

  // End-to-end through the REAL production path (createDetectors → detectFace,
  // confThreshold 0.6) on the composed frame — the exact fixture-generator leg.
  const detectors = await det.createDetectors();
  let productionDetectFace;
  try {
    const dets = await detectors.detectFace(imageData);
    productionDetectFace = dets.map((d) => ({
      conf: +d.conf.toFixed(4),
      box: { x: +d.box.x.toFixed(1), y: +d.box.y.toFixed(1), w: +d.box.w.toFixed(1), h: +d.box.h.toFixed(1) },
      cls: d.cls,
      pass: d.pass,
    }));
  } finally {
    detectors.close();
  }

  return {
    photo: {
      url: photoUrl,
      srcW: bmp.width,
      srcH: bmp.height,
      layout: 'contain',
      draw: { dx0: +dx0.toFixed(1), dy0: +dy0.toFixed(1), dw: +dw.toFixed(1), dh: +dh.toFixed(1) },
    },
    geom,
    tensorRGB: { channelMeans: [chMean(0), chMean(1), chMean(2)], min: +tMin.toFixed(4), max: +tMax.toFixed(4) },
    session: { inputName: session.inputNames[0], outputNames: [...session.outputNames], effectiveEp, epErrors },
    variants,
    productionDecodeRGB01: { at0_6: prodAt0_6, at0_05count: prodAt0_05.length, at0_05top: prodAt0_05.slice(0, 3) },
    simulatedFixBGR255: { at0_6: fixAt0_6 },
    productionDetectFace,
  };
}

let browser;
try {
  await waitForServer(`${BASE}/tools/debug-yunet.html`);
  browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`[pageerror] ${e?.message ?? e}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}] ${m.text()}`);
  });
  await page.goto(`${BASE}/tools/debug-yunet.html`, { waitUntil: 'load', timeout: 60_000 });

  const diagnosis = await Promise.race([
    page.evaluate(inPageDebug, PHOTO_URL),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('in-page debug timed out after 210s')), 210_000);
      t.unref?.();
    }),
  ]);

  console.log('=== DIAGNOSIS JSON ===');
  console.log(JSON.stringify(diagnosis, null, 2));
} finally {
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
}
process.exit(0);
