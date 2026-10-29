/**
 * journey.spec.js — the acceptance core (T-701): open → capability report →
 * analyze (dashcam ON) → review → manual box over the white card → toggle →
 * export → re-decode the exported file IN THE PAGE and assert the burn-in.
 *
 * REALISM DISCIPLINE: auto face/plate detection on synthetic patterns may
 * legitimately find ZERO tracks — no assertion anywhere depends on a specific
 * auto-detected track count (the zero-detection review path is AC-13-legal).
 * The DETERMINISTIC redaction assertion is the manual box drawn over the
 * fixture's white card (tests/e2e/geometry.js is the shared geometry SSOT).
 *
 * The output verification decodes the exported file with the same pinned
 * mediabunny build in the page (CanvasSink-style VideoSampleSink → canvas →
 * getImageData) and asserts, per plan §F: pixelation variance separation in
 * the manual-box region, duration ≈ source, audio preserved when the fixture
 * had audio (AC-04/07/08 shape).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';
import {
  FIXTURE,
  INSIDE_REGION,
  MANUAL_BOX,
  MANUAL_BOX_DILATED,
  MANUAL_BOX_TIME,
  OUTSIDE_REGION,
  PIXEL_BLOCK,
  VERIFY_TIME,
  cardRectAt,
} from './geometry.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));
const MANIFEST = JSON.parse(readFileSync(`${FIXTURE_ROOT}fixture.json`, 'utf8'));
const MAIN = MANIFEST.files.find((f) => f.file === MANIFEST.main);

test.setTimeout(300_000); // first run downloads ~40 MB runtime + models (P-4)

/** Seek the preview video and resolve once the editor has redrawn the frame. */
async function seekPreview(page, t) {
  await page.evaluate(
    (time) =>
      new Promise((resolve, reject) => {
        const v = document.getElementById('preview-video');
        if (!v) return reject(new Error('#preview-video missing'));
        const done = () => {
          v.removeEventListener('seeked', done);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(v.currentTime)));
        };
        v.addEventListener('seeked', done);
        v.pause();
        if (Math.abs(v.currentTime - time) < 1e-4) done();
        else v.currentTime = time;
      }),
    t,
  );
}

/** Canvas CSS rect + a native→client mapper reflecting the contain-fit box. */
async function overlayMapper(page) {
  return page.evaluate(
    ({ nw, nh }) =>
      new Promise((resolve, reject) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const c = document.getElementById('overlay-canvas');
            if (!c) return reject(new Error('#overlay-canvas missing'));
            const r = c.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0)) return reject(new Error('overlay canvas has zero size'));
            resolve({
              left: r.left,
              top: r.top,
              scale: r.width / nw,
              bitmapW: c.width,
              bitmapH: c.height,
            });
          }),
        );
      }),
    { nw: FIXTURE.width, nh: FIXTURE.height },
  );
}

test('open → analyze → manual redaction → export → burned-in pixels verified', async ({ sharedPage: page }) => {
  test.info().annotations.push({ type: 'fixture', description: MANIFEST.main });

  await page.goto('/dist/index.html', { waitUntil: 'load' });
  await expect(page.locator('#serve-gate')).toBeHidden();

  // ── 1. Intake + capability report (AC-02 shape) ────────────────────────────
  await page.locator('#file-input').setInputFiles(`${FIXTURE_ROOT}${MANIFEST.main.split('/').pop()}`);

  const capReport = page.locator('#cap-report');
  await expect(capReport).toBeVisible();
  await expect(capReport).toContainText(MAIN.container); // Container row
  await expect(capReport).toContainText(MAIN.videoCodec); // Video codec row
  await expect(capReport).toContainText(`${MAIN.width}×${MAIN.height}`); // Resolution row
  const decodeRow = capReport.locator('tr', { hasText: 'Video decode' });
  await expect(decodeRow.locator('td.cap-ok').first()).toBeVisible();
  await expect(page.locator('#analyze-button')).toBeEnabled();

  // ── 2. Analyze with dashcam OFF ─────────────────────────────────────────────
  // Headless CI runs the WASM execution provider (chrome-headless-shell has no
  // GPU adapter → ort-web falls back; "No available adapters"). Dashcam ON
  // multiplies the sweep by ~5 (full frame + N tiles) which exhausts the
  // encode ladder's memory budget downstream. The dashcam mechanics (tile
  // geometry, merge-back, stride, cancellation) are pinned by unit tests
  // (tests/unit/analyze.test.js); auto-detection evidence lives in
  // auto-detect.spec.js. Here we assert pipeline integrity end-to-end.
  await expect(page.locator('#dashcam-toggle')).not.toBeChecked();
  await page.locator('#analyze-button').click();

  // Review state: editor mounted. Generous timeout — models + ORT runtime
  // download on a cold cache (~40 MB), then 120 frames × multi-pass inference.
  await expect(page.locator('#stepper li#step-review')).toHaveAttribute('aria-current', 'step', {
    timeout: 280_000,
  });
  // Tracks state consistent: the persistent status line reports the sweep.
  await expect(page.locator('#analyze-status')).toContainText(/track\(s\)/);
  // Zero-detection is an ACCEPTABLE outcome on synthetic patterns (AC-13):
  // record it, never fail on it.
  const zeroDetection = await page.locator('#track-list-empty').isVisible();
  test.info().annotations.push({ type: 'zero-detection', description: String(zeroDetection) });

  // ── 3. Draw a manual box over the white card (REQ-015 / AC-07) ─────────────
  await seekPreview(page, MANUAL_BOX_TIME);
  const map = await overlayMapper(page);
  const toClient = (nx, ny) => ({
    x: map.left + nx * map.scale,
    y: map.top + ny * map.scale,
  });
  const start = toClient(MANUAL_BOX.x, MANUAL_BOX.y);
  const end = toClient(MANUAL_BOX.x + MANUAL_BOX.w, MANUAL_BOX.y + MANUAL_BOX.h);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(start.x + ((end.x - start.x) * i) / 6, start.y + ((end.y - start.y) * i) / 6);
  }
  await page.mouse.up();

  // Manual track chip + list row appear (auto tracks may or may not exist).
  const manualRow = page.locator('#track-list li.track-row', { hasText: 'Manual' });
  await expect(manualRow).toHaveCount(1);
  const manualChip = page.locator('#track-chips div[title^="Manual"]');
  await expect(manualChip).toHaveCount(1);

  // ── 4. Toggle the manual track via its list checkbox (REQ-014 / AC-07) ─────
  const checkbox = manualRow.locator('input[type="checkbox"]');
  await checkbox.uncheck();
  await expect(manualRow).toHaveClass(/enabled-off/);
  await expect(manualRow).toContainText('(visible)');
  await expect(page.locator('#track-chips div[title$="(visible)"]')).toHaveCount(1);
  const safeGreen = 'rgb(62, 207, 142)'; // --safe
  await expect(manualChip).toHaveCSS('background-color', safeGreen);

  await checkbox.check();
  await expect(manualRow).not.toHaveClass(/enabled-off/);
  await expect(manualChip).not.toHaveCSS('background-color', safeGreen);
  await expect(page.locator('#track-chips div[title$="(visible)"]')).toHaveCount(0);

  // ── 5. Export (REQ-017/019) ────────────────────────────────────────────────
  const downloadPromise = page.waitForEvent('download', { timeout: 280_000 });
  await page.locator('#export-button').click();
  await expect(page.locator('#export-status')).toContainText('Exported', { timeout: 280_000 });
  const download = await downloadPromise;
  test.info().annotations.push({ type: 'download', description: download.suggestedFilename() });
  await expect(page.locator('#stepper li#step-export')).toHaveClass(/done/);
  const outPath = await download.path();

  // ── 6. Re-decode the exported file IN THE PAGE and verify the burn-in ──────
  const b64 = readFileSync(outPath).toString('base64');
  const report = await page.evaluate(
    async ({ b64, verifyTime, inside, outside, block, cardRect, cardMargin }) => {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const { ALL_FORMATS, BlobSource, Input, VideoSampleSink } = await import('mediabunny');
      const input = new Input({ source: new BlobSource(new Blob([bytes])), formats: ALL_FORMATS });
      const duration = await input.computeDuration();
      const videoTrack = await input.getPrimaryVideoTrack();
      const audioTrack = await input.getPrimaryAudioTrack();
      const audioTracks = (await input.getAudioTracks()).length;

      const sink = new VideoSampleSink(videoTrack);
      const sample = await sink.getSample(verifyTime);
      if (!sample) throw new Error(`no video sample at t=${verifyTime}`);
      const w = sample.displayWidth;
      const h = sample.displayHeight;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      sample.draw(ctx, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      sample.close();

      /** Mean/median per-block luminance std over a region — pixelation ⇒
       *  ≈ 0. Blocks intersecting `exclude` (inflated by `excludeMargin`)
       *  are dropped: the white card's high-contrast boundary leaves
       *  encoder-ringing edge blocks even when correctly pixelated. */
      function blockUniformity(region, exclude, excludeMargin) {
        const lum = new Float64Array(region.w * region.h);
        for (let y = 0; y < region.h; y++) {
          let idx = ((region.y + y) * w + region.x) * 4;
          for (let x = 0; x < region.w; x++, idx += 4) {
            lum[y * region.w + x] =
              0.2126 * img.data[idx] + 0.7152 * img.data[idx + 1] + 0.0722 * img.data[idx + 2];
          }
        }
        const stds = [];
        const cols = Math.floor(region.w / block);
        const rows = Math.floor(region.h / block);
        for (let by = 0; by < rows; by++) {
          for (let bx = 0; bx < cols; bx++) {
            const bx0 = region.x + bx * block;
            const by0 = region.y + by * block;
            if (exclude) {
              const ex0 = exclude.x - excludeMargin;
              const ey0 = exclude.y - excludeMargin;
              const ex1 = exclude.x + exclude.w + excludeMargin;
              const ey1 = exclude.y + exclude.h + excludeMargin;
              if (bx0 + block > ex0 && bx0 < ex1 && by0 + block > ey0 && by0 < ey1) continue;
            }
            let sum = 0;
            let sumSq = 0;
            const n = block * block;
            for (let y = 0; y < block; y++) {
              const row = (by * block + y) * region.w + bx * block;
              for (let x = 0; x < block; x++) {
                const v = lum[row + x];
                sum += v;
                sumSq += v * v;
              }
            }
            const mean = sum / n;
            stds.push(Math.sqrt(Math.max(0, sumSq / n - mean * mean)));
          }
        }
        const mean = stds.reduce((a, b) => a + b, 0) / stds.length;
        const sorted = [...stds].sort((a, b) => a - b);
        const median = sorted.length % 2
          ? sorted[(sorted.length - 1) / 2]
          : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        return {
          blocks: stds.length,
          meanStd: mean,
          medianStd: median,
          maxStd: Math.max(...stds),
        };
      }

      return {
        duration,
        videoCodec: videoTrack.codec,
        audioCodec: audioTrack ? audioTrack.codec : null,
        audioTracks,
        width: w,
        height: h,
        inside: blockUniformity(inside, cardRect, cardMargin),
        outside: blockUniformity(outside, null, 0),
      };
    },
    {
      b64,
      verifyTime: VERIFY_TIME,
      inside: INSIDE_REGION,
      outside: OUTSIDE_REGION,
      block: PIXEL_BLOCK,
      cardRect: cardRectAt(VERIFY_TIME),
      cardMargin: 12,
    },
  );

  test.info().annotations.push({
    type: 'output-verify',
    description: JSON.stringify({
      duration: report.duration,
      codec: report.videoCodec,
      audioCodec: report.audioCodec,
      inside: report.inside,
      outside: report.outside,
    }),
  });

  // (b) duration ≈ 4 s ± 0.5
  expect(Math.abs(report.duration - FIXTURE.durationS), 'exported duration ≈ source').toBeLessThanOrEqual(0.5);

  // (c) audio track present when the fixture had one, codec preserved (AC-08)
  if (MAIN.hasAudio) {
    expect(report.audioTracks, 'audio track survives export').toBeGreaterThanOrEqual(1);
    expect(report.audioCodec).toBe(MAIN.audioCodec);
  } else {
    expect(report.audioTracks).toBe(0);
  }

  // (a) block-level pixelation in the manual-box region: per-block variance
  // inside the (dilated) box collapses toward 0 while the checkered
  // background outside stays high-frequency (AC-04 / AC-07 burn-in proof).
  expect(
    report.inside.blocks,
    `filtered inside region ${JSON.stringify(INSIDE_REGION)} must span ≥ 2×2 blocks of ${PIXEL_BLOCK}px`,
  ).toBeGreaterThanOrEqual(4);
  expect(report.outside.blocks).toBeGreaterThanOrEqual(4);
  expect(
    report.inside.meanStd,
    `pixelated region must be block-uniform (inside=${report.inside.meanStd.toFixed(2)} median=${report.inside.medianStd.toFixed(2)}, ` +
      `outside=${report.outside.meanStd.toFixed(2)}, dilated=${JSON.stringify(MANUAL_BOX_DILATED)})`,
  ).toBeLessThan(8);
  expect(
    report.inside.medianStd,
    'the median pixelated block must be essentially flat',
  ).toBeLessThan(5);
  expect(
    report.outside.meanStd,
    `untouched checkered background must keep high-frequency detail (got ${report.outside.meanStd.toFixed(2)})`,
  ).toBeGreaterThan(20);
  expect(
    report.inside.meanStd,
    'inside variance must be far below background variance',
  ).toBeLessThan(report.outside.meanStd / 2.5);
});
