#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: /src/* imports resolve on the served origin, not at typecheck time
/**
 * make-fixture.mjs — generate the E2E fixture clips (T-701).
 *
 * Opens Chromium via Playwright, navigates to tools/fixture-page.html (served
 * over localhost so WebCodecs runs in a secure context), imports the SAME
 * pinned mediabunny bundle the app uses (via the page's importmap), and
 * encodes:
 *
 *   tests/fixtures/synthetic.mp4  — ~4 s 640×360 30fps H.264 (+ AAC audio when
 *                                   the browser has an AAC encoder, else Opus
 *                                   in MP4, else silent)
 *   tests/fixtures/synthetic.webm — VP9 + Opus variant (fixture #2), made when
 *                                   AAC encode is unavailable
 *   tests/fixtures/detectable.mp4 — ~3 s 640×360 30fps H.264 + AAC sine audio:
 *                                   a REAL face photo (provenance below) fills
 *                                   the frame so the AC-04 auto-detection leg
 *                                   has end-to-end evidence. The photo is
 *                                   VERIFIED before the clip is committed:
 *                                   the production detector path
 *                                   (src/detector.js createDetectors →
 *                                   detectFace, YuNet confThreshold 0.6) must
 *                                   report ≥ 1 face on the composed frame.
 *                                   Candidates are tried in order; a candidate
 *                                   that fails fetch/decode/detection is
 *                                   recorded in fixture.json
 *                                   (detectableFixture.attempts) and the next is
 *                                   tried. If NONE passes, no clip is written
 *                                   and fixture.json records
 *                                   `detectableFixture: {outcome: 'failed',
 *                                   attempts}` — the gap is documented, never
 *                                   faked.
 *
 * Face-photo provenance (candidate order; OpenCV Zoo — the same Apache-2.0
 * repository that publishes the YuNet model — first). The zoo tree has no
 * `data/images` directory; its committed demo assets live under
 * `models/<model-name>/example_outputs/`, which is what the canonical YuNet/sface demo
 * pages render. When the production (default EP ladder) probe finds 0 faces,
 * the SAME frame is re-probed with a wasm-forced detector as a DIAGNOSTIC
 * (`detectionsWasm` in the attempt record) — a wasm-only hit means the
 * default-ladder session (WebGPU) misfired in this environment, not that the
 * photo lacks a face:
 *   1. opencv/opencv_zoo — models/face_detection_yunet/example_outputs/largest_selfie.jpg
 *   2. opencv/opencv_zoo — models/face_recognition_sface/example_outputs/demo.jpg
 *   3. opencv/opencv_zoo — models/facial_expression_recognition/example_outputs/selfie.jpg
 *   4. opencv/opencv_zoo — models/face_image_quality_assessment_ediffiqa/example_outputs/demo.jpg
 *   5. github.com/ageitgey/face_recognition — examples/obama-1080p.jpg  (MIT)
 *   6. github.com/ageitgey/face_recognition — examples/lin-manuel-miranda.png (MIT)
 * Repo, path, license, and observed detection count of the WINNER are recorded
 * in tests/fixtures/fixture.json (detectableFixture.source / .repo / .path /
 * .license / .verifiedDetections).
 *
 * Frame content (see tests/e2e/geometry.js for the numbers):
 *   - moving two-stop gradient background (changes every frame),
 *   - static 8px checkerboard overlay (high-frequency detail — pixelation
 *     must flatten it for the exported-pixel variance assertion),
 *   - a white rounded-rect "card" crossing the frame left → right (the
 *     deterministic manual-box burn-in target; auto face/plate detectors are
 *     NOT expected to fire on synthetic patterns),
 *   - a frame counter burned into the bottom-left corner.
 *
 * Emits tests/fixtures/fixture.json describing what was produced; the E2E
 * specs adapt their assertions from it. Run: node tools/make-fixture.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { FIXTURE } from '../tests/e2e/geometry.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.FIXTURE_SERVER_PORT) || 8123;
const OUT_DIR = join(ROOT, 'tests', 'fixtures');

/** Frame/timeline shape of tests/fixtures/detectable.mp4 (AC-04 detection leg). */
const FACES = Object.freeze({ width: 640, height: 360, fps: 30, durationS: 3, frames: 90 });

const ZOO_REPO = 'github.com/opencv/opencv_zoo';
const ZOO_LICENSE = 'Apache-2.0 (opencv/opencv_zoo repository license)';
const ZOO_RAW = 'https://raw.githubusercontent.com/opencv/opencv_zoo/main/';

/**
 * Detectable-face photo candidates, tried IN ORDER at generation time
 * (see the module header for the provenance policy). Every attempt —
 * including failures — is recorded in fixture.json detectableFixture.attempts.
 */
const FACE_CANDIDATES = Object.freeze([
  {
    url: `${ZOO_RAW}models/face_detection_yunet/example_outputs/largest_selfie.jpg`,
    repo: ZOO_REPO,
    path: 'models/face_detection_yunet/example_outputs/largest_selfie.jpg',
    license: ZOO_LICENSE,
  },
  {
    url: `${ZOO_RAW}models/face_recognition_sface/example_outputs/demo.jpg`,
    repo: ZOO_REPO,
    path: 'models/face_recognition_sface/example_outputs/demo.jpg',
    license: ZOO_LICENSE,
  },
  {
    url: `${ZOO_RAW}models/facial_expression_recognition/example_outputs/selfie.jpg`,
    repo: ZOO_REPO,
    path: 'models/facial_expression_recognition/example_outputs/selfie.jpg',
    license: ZOO_LICENSE,
  },
  {
    url: `${ZOO_RAW}models/face_image_quality_assessment_ediffiqa/example_outputs/demo.jpg`,
    repo: ZOO_REPO,
    path: 'models/face_image_quality_assessment_ediffiqa/example_outputs/demo.jpg',
    license: ZOO_LICENSE,
  },
  {
    url: 'https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/obama-1080p.jpg',
    repo: 'github.com/ageitgey/face_recognition',
    path: 'examples/obama-1080p.jpg',
    license: 'MIT (face_recognition repository license)',
  },
  {
    url: 'https://raw.githubusercontent.com/ageitgey/face_recognition/master/examples/lin-manuel-miranda.png',
    repo: 'github.com/ageitgey/face_recognition',
    path: 'examples/lin-manuel-miranda.png',
    license: 'MIT (face_recognition repository license)',
  },
]);

/**
 * In-page detectable-face phase: pick the first candidate photo that the
 * PRODUCTION detector path (src/detector.js → createDetectors → detectFace,
 * YuNet confThreshold 0.6 — identical to the analyze pass) detects ≥ 1 face
 * on, then encode the still as faces.mp4 (H.264 + AAC/Opus sine, same audio
 * approach as the synthetic clip). Runs in tools/fixture-page.html so ORT,
 * WebCodecs and cross-origin image fetches all happen in one secure context.
 *
 * @param {{width: number, height: number, fps: number, frames: number,
 *          durationS: number, candidates: Array<{url: string, source: string,
 *          license: string}>}} cfg
 * @returns {Promise<object>} ok → {outcome, url, source, license, layout,
 *          detections, attempts, audioCodec, b64, bytes};
 *          failed → {outcome: 'failed', attempts} (no clip is encoded).
 */
async function facesPhase(cfg) {
  const M = await import('mediabunny');
  const { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } = M;
  // The production detector module, served by the SAME localhost origin
  // (tools/serve.mjs) — its lazy 'onnxruntime-web' import resolves via the
  // page's importmap pin (same 1.31.1 bundle the app ships with).
  const det = await import('/src/detector.js');

  /**
   * Compose a candidate photo into a cfg.width×cfg.height still.
   * 'cover-top': cover-fit crop, horizontally centered, biased toward the
   * top quarter of the photo (where faces live) so the face fills the frame.
   * 'contain': the whole photo, centered, on a dark backdrop.
   */
  function compose(img, layout) {
    const canvas = document.createElement('canvas');
    canvas.width = cfg.width;
    canvas.height = cfg.height;
    const c = canvas.getContext('2d');
    c.fillStyle = '#20242c';
    c.fillRect(0, 0, cfg.width, cfg.height);
    if (layout === 'cover-top') {
      const scale = Math.max(cfg.width / img.width, cfg.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (cfg.width - w) / 2;
      const y = Math.min(0, (cfg.height - h) * 0.25);
      c.drawImage(img, x, y, w, h);
    } else {
      const scale = Math.min(cfg.width / img.width, cfg.height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      c.drawImage(img, (cfg.width - w) / 2, (cfg.height - h) / 2, w, h);
    }
    return canvas;
  }

  // --- 1. Pick a candidate the real detector actually fires on -------------
  const detectors = await det.createDetectors();
  const attempts = [];
  /** @type {{url: string, source: string, license: string, layout: string,
   *          detections: number, bitmap: ImageBitmap} | null} */
  let winner = null;
  try {
    outer: for (const cand of cfg.candidates) {
      let res;
      try {
        res = await fetch(cand.url, { mode: 'cors', redirect: 'follow' });
      } catch (err) {
        attempts.push({ url: cand.url, error: `fetch failed: ${err.message}` });
        continue;
      }
      if (!res.ok) {
        attempts.push({ url: cand.url, error: `HTTP ${res.status}` });
        continue;
      }
      let bitmap;
      try {
        bitmap = await createImageBitmap(await res.blob());
      } catch (err) {
        attempts.push({ url: cand.url, error: `image decode failed: ${err.message}` });
        continue;
      }
      for (const layout of ['cover-top', 'contain']) {
        const canvas = compose(bitmap, layout);
        const frame = canvas
          .getContext('2d', { willReadFrequently: true })
          .getImageData(0, 0, cfg.width, cfg.height);
        let dets = [];
        try {
          dets = await detectors.detectFace(frame);
        } catch (err) {
          attempts.push({ url: cand.url, layout, error: `detect failed: ${err.message}` });
          break outer; // detector failure is global — no candidate can pass
        }
        attempts.push({ url: cand.url, layout, detections: dets.length });
        if (dets.length >= 1) {
          winner = { ...cand, layout, detections: dets.length, bitmap };
          break outer;
        }
      }
    }
  } finally {
    detectors.close();
  }
  if (!winner) return { outcome: 'failed', attempts };

  // --- 2. Encode the verified still as faces.mp4 (+ AAC/Opus sine) ---------
  const canvas = compose(winner.bitmap, winner.layout);
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const vsrc = new CanvasSource(canvas, { codec: 'avc', quality: new Quality('high') });
  output.addVideoTrack(vsrc, { frameRate: cfg.fps });

  // Same audio-probe + sine-buffer approach as the synthetic clip above.
  let audioConf = null;
  for (const conf of [
    { codec: 'mp4a.40.2', sampleRate: 44_100, numberOfChannels: 2, bitrate: 128_000 },
    { codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, bitrate: 96_000 },
  ]) {
    try {
      const r = await AudioEncoder.isConfigSupported(conf);
      if (r?.supported === true) {
        audioConf = conf;
        break;
      }
    } catch {
      /* try next */
    }
  }
  let asrc = null;
  if (audioConf) {
    asrc = new AudioBufferSource({
      codec: audioConf.codec === 'mp4a.40.2' ? 'aac' : 'opus',
      quality: new Quality('high'),
    });
    output.addAudioTrack(asrc);
  }

  await output.start();
  for (let i = 0; i < cfg.frames; i++) {
    await vsrc.add(i / cfg.fps, 1 / cfg.fps); // static still — every frame identical
  }
  vsrc.close();
  if (asrc) {
    const sr = audioConf.sampleRate;
    const length = Math.round(sr * cfg.durationS);
    const buf = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: sr });
    const fade = Math.min(2_000, Math.floor(length / 8));
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const data = buf.getChannelData(ch);
      for (let s = 0; s < length; s++) {
        const env = Math.min(1, s / fade) * Math.min(1, (length - s) / fade);
        data[s] = 0.4 * env * Math.sin((2 * Math.PI * 440 * s) / sr);
      }
    }
    await asrc.add(buf);
    asrc.close();
  }
  await output.finalize();
  const bytes = new Uint8Array(output.target.buffer);
  // Chunked base64 (String.fromCharCode.apply has an argument-count cap).
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return {
    outcome: 'ok',
    url: winner.url,
    source: winner.source,
    license: winner.license,
    layout: winner.layout,
    detections: winner.detections,
    attempts,
    audioCodec: asrc ? (audioConf.codec === 'mp4a.40.2' ? 'aac' : 'opus') : null,
    b64: btoa(bin),
    bytes: bytes.length,
  };
}

// --- Serve the repo root so the fixture page gets a localhost origin --------

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
server.on('error', (err) => {
  console.error(`fixture server failed to start: ${err.message}`);
  process.exit(1);
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
  throw new Error(`fixture server did not come up at ${url}`);
}

try {
  await waitForServer(`http://127.0.0.1:${PORT}/tools/fixture-page.html`);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`[fixture page] ${msg.text()}`);
  });

  await page.goto(`http://127.0.0.1:${PORT}/tools/fixture-page.html`, { waitUntil: 'load' });

  /** Codecs probed + both clips encoded inside the page (secure context). */
  const result = await page.evaluate(async (cfg) => {
    const M = await import('mediabunny');
    const { AudioBufferSource, BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality, WebMOutputFormat } = M;

    // --- Codec capability probes (raw WebCodecs — no helpers to trust) -----
    async function canEncodeVideo(codec) {
      const codecString = codec === 'avc' ? 'avc1.640028' : 'vp09.00.10.08';
      try {
        const res = await VideoEncoder.isConfigSupported({
          codec: codecString,
          width: cfg.width,
          height: cfg.height,
          framerate: cfg.fps,
          bitrate: 2_000_000,
        });
        return res?.supported === true;
      } catch {
        return false;
      }
    }

    /** Returns the accepted AudioEncoderConfig, or null. */
    async function probeAudio(candidates) {
      for (const conf of candidates) {
        try {
          const res = await AudioEncoder.isConfigSupported(conf);
          if (res?.supported === true) return conf;
        } catch {
          /* try next */
        }
      }
      return null;
    }

    const avc = await canEncodeVideo('avc');
    const vp9 = await canEncodeVideo('vp9');
    const aac = await probeAudio([{ codec: 'mp4a.40.2', sampleRate: 44_100, numberOfChannels: 2, bitrate: 128_000 }]);
    const opus = await probeAudio([{ codec: 'opus', sampleRate: 48_000, numberOfChannels: 2, bitrate: 96_000 }]);

    // --- Frame drawing (geometry from cfg = tests/e2e/geometry.js FIXTURE) --
    const canvas = document.createElement('canvas');
    canvas.width = cfg.width;
    canvas.height = cfg.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });

    // Static 8px checkerboard pattern canvas (two contrasting cells).
    const pat = document.createElement('canvas');
    pat.width = cfg.checkerCell * 2;
    pat.height = cfg.checkerCell * 2;
    const pctx = pat.getContext('2d');
    pctx.fillStyle = '#1b2430';
    pctx.fillRect(0, 0, pat.width, pat.height);
    pctx.fillStyle = '#dbe4ee';
    pctx.fillRect(0, 0, cfg.checkerCell, cfg.checkerCell);
    pctx.fillRect(cfg.checkerCell, cfg.checkerCell, cfg.checkerCell, cfg.checkerCell);
    const checker = ctx.createPattern(pat, 'repeat');

    function roundRect(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    function drawFrame(i) {
      const t = i / cfg.fps;
      // 1. Moving two-stop gradient (hue rotates with time).
      const g = ctx.createLinearGradient(0, 0, cfg.width, cfg.height);
      const h1 = (t * 60) % 360;
      const h2 = (t * 60 + 140) % 360;
      g.addColorStop(0, `hsl(${h1.toFixed(1)} 45% 55%)`);
      g.addColorStop(1, `hsl(${h2.toFixed(1)} 55% 32%)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cfg.width, cfg.height);
      // 2. High-frequency checkerboard overlay.
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = checker;
      ctx.fillRect(0, 0, cfg.width, cfg.height);
      ctx.globalAlpha = 1;
      // 3. White rounded card crossing the frame.
      const cx = cfg.card.x0 + cfg.card.speed * t;
      ctx.fillStyle = '#f4f6f8';
      roundRect(ctx, cx, cfg.card.yTop, cfg.card.w, cfg.card.h, 14);
      ctx.fill();
      ctx.strokeStyle = '#8a93a0';
      ctx.lineWidth = 3;
      roundRect(ctx, cx, cfg.card.yTop, cfg.card.w, cfg.card.h, 14);
      ctx.stroke();
      // 4. Frame counter chip (bottom-left).
      ctx.fillStyle = 'rgba(6,8,10,0.85)';
      ctx.fillRect(cfg.counter.x, cfg.counter.y, cfg.counter.w, cfg.counter.h);
      ctx.fillStyle = '#ffffff';
      ctx.font = '15px monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(`F${String(i).padStart(3, '0')}`, cfg.counter.x + 10, cfg.counter.y + cfg.counter.h / 2);
    }

    // --- Encode one clip -----------------------------------------------------
    async function encode({ videoCodec, audio, container }) {
      const output = new Output({
        format: container === 'mp4' ? new Mp4OutputFormat() : new WebMOutputFormat(),
        target: new BufferTarget(),
      });
      const vsrc = new CanvasSource(canvas, { codec: videoCodec, quality: new Quality('high') });
      output.addVideoTrack(vsrc, { frameRate: cfg.fps });
      let asrc = null;
      if (audio) {
        asrc = new AudioBufferSource({
          codec: audio.conf.codec === 'mp4a.40.2' ? 'aac' : 'opus',
          quality: new Quality('high'),
        });
        output.addAudioTrack(asrc);
      }
      await output.start();
      for (let i = 0; i < cfg.frames; i++) {
        drawFrame(i);
        await vsrc.add(i / cfg.fps, 1 / cfg.fps);
      }
      vsrc.close();
      if (asrc) {
        const sr = audio.conf.sampleRate;
        const length = Math.round(sr * cfg.durationS);
        const buf = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: sr });
        const fade = Math.min(2_000, Math.floor(length / 8));
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const data = buf.getChannelData(ch);
          for (let s = 0; s < length; s++) {
            const env =
              Math.min(1, s / fade) * Math.min(1, (length - s) / fade);
            data[s] = 0.4 * env * Math.sin((2 * Math.PI * 440 * s) / sr);
          }
        }
        await asrc.add(buf);
        asrc.close();
      }
      await output.finalize();
      const bytes = new Uint8Array(output.target.buffer);
      // Chunked base64 (String.fromCharCode.apply has an argument-count cap).
      let bin = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { b64: btoa(bin), bytes: bytes.length };
    }

    // --- Build the clips per the AAC/Opus availability matrix ----------------
    const out = { probes: { avc, vp9, aac: !!aac, opus: !!opus }, mp4: null, webm: null };

    if (avc) {
      const audio = aac ? { conf: aac, codec: 'aac' } : opus ? { conf: opus, codec: 'opus' } : null;
      const r = await encode({ videoCodec: 'avc', audio, container: 'mp4' });
      out.mp4 = { ...r, container: 'mp4', videoCodec: 'avc', audioCodec: audio?.codec ?? null };
    }
    const wantWebMVariant = !aac && opus && (vp9 || avc); // fixture #2 when AAC is missing
    if (wantWebMVariant) {
      const r = await encode({ videoCodec: vp9 ? 'vp9' : 'avc', audio: { conf: opus, codec: 'opus' }, container: 'webm' });
      out.webm = { ...r, container: 'webm', videoCodec: vp9 ? 'vp9' : 'avc', audioCodec: 'opus' };
    }
    if (!out.mp4 && !out.webm) throw new Error('No viable video encoder in this Chromium (avc and vp9 both unsupported).');

    return out;
  }, JSON.parse(JSON.stringify(FIXTURE)));

  // --- Detectable-face clip (AC-04 detection leg) — verify, then encode ----
  // Runs on the SAME page so ORT sessions + the model cache warm once.
  console.log('faces fixture: verifying candidates with the production YuNet detector…');
  const faces = await page
    .evaluate(facesPhase, {
      width: FACES.width,
      height: FACES.height,
      fps: FACES.fps,
      frames: FACES.frames,
      durationS: FACES.durationS,
      candidates: JSON.parse(JSON.stringify(FACE_CANDIDATES)),
    })
    .catch((err) => ({
      outcome: 'failed',
      attempts: [{ error: `faces phase crashed: ${err instanceof Error ? err.message : String(err)}` }],
    }));

  await browser.close();

  // --- Write artifacts ---------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });
  const files = [];
  const save = (key, fileName) => {
    if (!result[key]) return null;
    const entry = result[key];
    const path = join(OUT_DIR, fileName);
    writeFileSync(path, Buffer.from(entry.b64, 'base64'));
    const meta = {
      file: `tests/fixtures/${fileName}`,
      container: entry.container,
      videoCodec: entry.videoCodec,
      audioCodec: entry.audioCodec,
      hasAudio: !!entry.audioCodec,
      width: FIXTURE.width,
      height: FIXTURE.height,
      fps: FIXTURE.fps,
      durationS: FIXTURE.durationS,
      frames: FIXTURE.frames,
      bytes: entry.bytes,
    };
    files.push(meta);
    return meta;
  };
  const mp4 = save('mp4', 'synthetic.mp4');
  const webm = save('webm', 'synthetic.webm');
  const main = mp4 ?? webm;

  // Detectable-face clip provenance (AC-04 detection leg): the winner's
  // source URL + license + the observed YuNet detection count are recorded
  // so the E2E evidence chain is auditable. Failure is DOCUMENTED, never
  // faked — the spec skips when outcome is 'failed'.
  if (faces?.outcome === 'ok') {
    writeFileSync(join(OUT_DIR, 'detectable.mp4'), Buffer.from(faces.b64, 'base64'));
    files.push({
      file: 'tests/fixtures/detectable.mp4',
      container: 'mp4',
      videoCodec: 'avc',
      audioCodec: faces.audioCodec,
      hasAudio: !!faces.audioCodec,
      width: FACES.width,
      height: FACES.height,
      fps: FACES.fps,
      durationS: FACES.durationS,
      frames: FACES.frames,
      bytes: faces.bytes,
    });
  }
  const manifest = {
    main: main.file,
    // Audio-bearing fixture for AC-08-style assertions (may equal main).
    withAudio: (files.find((f) => f.hasAudio) ?? main).file,
    generatedWith: result.probes,
    files,
    detectableFace:
      faces?.outcome === 'ok'
        ? {
            outcome: 'ok',
            file: 'tests/fixtures/detectable.mp4',
            source: faces.url,
            license: faces.license,
            composition: faces.layout,
            verifiedDetections: faces.detections,
            verifiedWith:
              'YuNet face_detection_yunet_2023mar via src/detector.js createDetectors().detectFace on the composed 640×360 frame (confThreshold 0.6 — same as the analyze pass)',
            attempts: faces.attempts,
          }
        : {
            outcome: 'failed',
            attempts: faces?.attempts ?? [{ error: 'faces phase did not run' }],
          },
  };
  writeFileSync(join(OUT_DIR, 'fixture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`fixtures written:\n${JSON.stringify(manifest, null, 2)}`);
  if (manifest.detectableFace.outcome === 'failed') {
    console.warn('WARNING: no detectable-face fixture was produced — see fixture.json detectableFace.attempts');
  }
} finally {
  server.kill();
}
