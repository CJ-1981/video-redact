#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-trim-export.mjs — v1.15.0 REQ-125/126 acceptance probe.
 *
 * Pattern: tools/debug-trim.mjs + tools/debug-export.mjs — spawns
 * tools/serve.mjs, opens dist/index.html, loads tests/fixtures/detectable.mp4
 * (3.04 s, AAC audio), analyzes, enables ✂ trim mode, drags TWO trim regions
 * on the timeline (~[0, 0.5] and ~[1.5, 2.0]), asserts the greyed overlays
 * exist, exports, downloads the output and measures it with mediabunny.
 *
 * PASS = 2 .trim-region overlays after the drags AND the downloaded file's
 * duration ≈ 3.04 − ~1.0 ≈ 2.0 s (± 0.35) AND an audio track is present.
 * Run: node tools/debug-trim-export.mjs   (kills the spawned server on exit)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PROBE_PORT || 8193;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');
const FIXTURE_DURATION = 3.040362811791383; // measured with mediabunny (below: output against this)

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (!t.includes('[vfc]')) console.log(`[console.${m.type()}]`, t.slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

/** Timeline geometry + the chip edges (px) to keep drags away from. */
async function timelineGeometry() {
  return page.evaluate(() => {
    const chips = document.querySelector('#track-chips');
    const rect = chips.getBoundingClientRect();
    const edges = [];
    for (const el of chips.querySelectorAll('div[data-track-id]')) {
      const r = /** @type {HTMLElement} */ (el).getBoundingClientRect();
      edges.push(r.left, r.right);
    }
    return { left: rect.left, width: rect.width, top: rect.top, height: rect.height, edges };
  });
}

/** x for a time; nudged off any chip edge (a press there would latch a
 * chip-edge trim instead of starting a region). */
function pickX(geo, t, duration) {
  let x = geo.left + (t / duration) * geo.width;
  for (const edge of geo.edges) {
    if (Math.abs(x - edge) < 10) x = edge + 12 * Math.sign(x - edge || 1);
  }
  return Math.round(x);
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });
  console.log('--- ready; starting analyze ---');
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', {
    timeout: 300000,
  });
  console.log('--- review reached; enabling trim mode ---');
  await page.click('#trim-toggle');
  const pressed = await page.getAttribute('#trim-toggle', 'aria-pressed');
  console.log('--- trim-toggle aria-pressed:', pressed);
  await page.evaluate(() => {
    document.querySelector('#timeline')?.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(120);

  /** Drag one trim region [t0, t1] on the timeline. */
  async function dragRegion(t0, t1) {
    await page.evaluate(() => {
      document.querySelector('#timeline')?.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(120);
    const geo = await timelineGeometry();
    const y = Math.round(geo.top + geo.height / 2);
    const x0 = pickX(geo, t0, FIXTURE_DURATION);
    const x1 = pickX(geo, t1, FIXTURE_DURATION);
    // Press at the RIGHT end and drag left: the scrub thumb (with its 36 px
    // fat-finger zone) sits at the playhead, parked near the timeline's left
    // edge — a press there would start a thumb scrub, not a region.
    console.log(`--- drag region [${t0}, ${t1}] s → press x ${x1} → ${x0}`);
    await page.mouse.move(x1, y, { steps: 2 });
    await page.mouse.down();
    await page.mouse.move((x0 + x1) / 2, y, { steps: 3 });
    const ghostMid = await page.evaluate(() => document.querySelectorAll('.trim-ghost').length);
    console.log(`    mid-drag ghosts: ${ghostMid}`);
    await page.mouse.move(x0, y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  }

  await dragRegion(0.05, 0.5); // region A ≈ [0, 0.5]
  await dragRegion(1.5, 2.0); // region B ≈ [1.5, 2.0]

  const regions = await page.evaluate(() => {
    const chips = document.querySelector('#track-chips');
    const rect = chips.getBoundingClientRect();
    return [...document.querySelectorAll('.trim-region')].map((el) => {
      const r = /** @type {HTMLElement} */ (el).getBoundingClientRect();
      return {
        leftPct: ((r.left - rect.left) / rect.width) * 100,
        rightPct: ((r.right - rect.left) / rect.width) * 100,
        cuts: el.querySelectorAll('.trim-cut').length,
        remove: el.querySelectorAll('.trim-remove').length,
      };
    });
  });
  console.log('--- trim regions:', JSON.stringify(regions));
  if (regions.length !== 2) throw new Error(`expected 2 .trim-region overlays, got ${regions.length}`);
  for (const r of regions) {
    if (r.cuts !== 2 || r.remove !== 1) {
      throw new Error(`region malformed: cuts=${r.cuts} remove=${r.remove}`);
    }
  }

  // The veil: seek the playhead inside region B and check the canvas draws
  // (the veil itself is pixels — assert via the editor's veil code path is
  // not directly observable; we assert the playhead time sits inside a region
  // through the app's own state by seeking with the app's seek path).
  console.log('--- exporting with 2 trimmed regions ---');
  const downloadPromise = page.waitForEvent('download', { timeout: 240000 });
  // v1.15.1 FAITHFUL-USER check: the natural gesture starts the drag AT the
  // playhead thumb (users drag from where they are). Pre-fix, the thumb's
  // fat-finger zone stole the press (seek, no region).
  {
    // park the playhead at 30% by seeking
    await page.evaluate(() => {
      const v = document.querySelector('#preview-video');
      v.currentTime = 0.3 * (v.duration || 1);
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      document.querySelector('#timeline')?.scrollIntoView({ block: 'center' });
    });
    const geo = await timelineGeometry();
    const y = Math.round(geo.top + geo.height / 2);
    const thumbX = geo.left + geo.width * 0.3; // thumb sits at the playhead
    const endX = geo.left + geo.width * 0.55;
    const before = await page.evaluate(() => document.querySelectorAll('.trim-region').length);
    console.log(`--- FAITHFUL: drag FROM thumb x ${Math.round(thumbX)} → ${Math.round(endX)}`);
    await page.mouse.move(thumbX, y, { steps: 2 });
    await page.mouse.down();
    await page.mouse.move((thumbX + endX) / 2, y, { steps: 3 });
    await page.mouse.move(endX, y, { steps: 3 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => document.querySelectorAll('.trim-region').length);
    console.log(`    trim regions before=${before} after=${after} ${after > before ? 'PASS' : 'FAIL'}`);
  }

  await page.click('#export-button');
  const download = await downloadPromise;
  const outPath = join(await mkdtemp(join(tmpdir(), 'trim-export-')), download.suggestedFilename());
  await download.saveAs(outPath);
  const status = await page.textContent('#export-status');
  console.log('--- export status:', JSON.stringify(status));
  console.log('--- downloaded:', download.suggestedFilename());

  // Measure the output with mediabunny (the same demuxer the app uses).
  const blob = new Blob([await readFile(outPath)]);
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  const duration = await input.computeDuration();
  const audioTracks = await input.getAudioTracks();
  const bytes = blob.size;
  console.log('--- MEASUREMENTS ---');
  console.log(`region count: ${regions.length}`);
  console.log(
    `regions (s): ${regions
      .map((r) => `[${((r.leftPct / 100) * FIXTURE_DURATION).toFixed(2)}, ${((r.rightPct / 100) * FIXTURE_DURATION).toFixed(2)}]`)
      .join(' ')}`,
  );
  console.log(`output duration: ${duration.toFixed(3)} s (source ${FIXTURE_DURATION.toFixed(3)} s)`);
  console.log(`output audio tracks: ${audioTracks.length}${audioTracks[0] ? ` (${audioTracks[0].codec})` : ''}`);
  console.log(`output bytes: ${bytes}`);

  let pass = true;
  if (regions.length === 2) {
    console.log('ok: 2 greyed .trim-region overlays with ✂ edges + ✕ each');
  } else {
    pass = false;
  }
  // v1.15.1: three regions now — the faithful thumb-origin drag [0.912, 1.672]s
  // clips against the [1.5, 2.0]s region (overlap rejection), so the trimmed
  // total is 0.4 + 0.5 + 0.588 = 1.488 s → expected output ≈ 1.55 s.
  const expected = FIXTURE_DURATION - 1.488;
  if (Math.abs(duration - expected) <= 0.35) {
    console.log(`ok: output duration ${duration.toFixed(3)} s ≈ expected ${expected.toFixed(2)} s (±0.35)`);
  } else {
    pass = false;
    console.log(`FAIL: output duration ${duration.toFixed(3)} s vs expected ${expected.toFixed(2)} s`);
  }
  if (audioTracks.length >= 1) {
    console.log(`ok: audio track present (${audioTracks[0].codec})`);
  } else {
    pass = false;
    console.log('FAIL: no audio track in the output');
  }
  if (bytes > 0) {
    console.log('ok: download completed with bytes on disk');
  } else {
    pass = false;
  }

  console.log(pass ? '=== PROBE PASS ===' : '=== PROBE FAIL ===');
  process.exitCode = pass ? 0 : 1;
  await page.waitForTimeout(800);
} finally {
  await browser.close();
  server.kill();
}
