#!/usr/bin/env node
// @ts-nocheck -- probe: runtime console capture, not a typecheck surface
/**
 * debug-diag.mjs — v1.8.2 `?debug=1` runtime diagnostics probe (single run).
 *
 * Loads dist/index.html?debug=1 at a DESKTOP viewport, opens the detectable
 * fixture, starts playback, and captures the console `[diag]` lines for ~5 s
 * (headless may starve rVFC — that is fine: the line must print and `tu`
 * must tick either way). Asserts the support contract:
 *   P1  a `[diag]` JSON line prints every ~2 s (interval ± 700 ms)
 *   P2  every line carries the RUNNING bundle identity: v === '1.8.2'
 *   P3  every line carries the signal counters: tu + vfc keys present
 *   P4  WITHOUT ?debug=1: zero [diag] lines (silent by default)
 * Run: node tools/debug-diag.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8193;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');
const DIAG_MS = 5500;   // capture window → expect lines at ~2s and ~4s
const SILENT_MS = 3000; // negative check window (no flag)
const GAP_MS = 2000;
const GAP_TOL_MS = 700;

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

/** Console [diag] JSON lines on `page` from now, for `ms` (offset = ms since t0). */
async function captureDiag(page, ms, t0) {
  const lines = [];
  const onConsole = (msg) => {
    const text = msg.text();
    if (text.startsWith('[diag] ')) lines.push({ at: Date.now() - t0, text });
  };
  page.on('console', onConsole);
  await page.waitForTimeout(ms);
  page.off('console', onConsole);
  return lines;
}

try {
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html?debug=1`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });
  // Start playback (trusted click → user gesture; playing OR paused, the
  // [diag] line must print every ~2 s regardless).
  await page.click('#transport-play').catch(() => {});

  const t0 = Date.now();
  const lines = await captureDiag(page, DIAG_MS, t0);
  const diag = lines.filter((l) => l.text.startsWith('[diag] {'));
  console.log(`captured ${diag.length} [diag] JSON line(s) in ${DIAG_MS}ms (from fixture ready):`);
  for (const d of diag) console.log(`  +${d.at}ms  ${d.text}`);

  check('P1 line every ~2s', diag.length >= 2, `${diag.length} lines in ${DIAG_MS}ms`);
  for (let i = 1; i < diag.length; i++) {
    const gap = diag[i].at - diag[i - 1].at;
    check(`P1 gap ${i}→${i + 1}`, Math.abs(gap - GAP_MS) <= GAP_TOL_MS, `${gap}ms (target ${GAP_MS}±${GAP_TOL_MS})`);
  }

  const bodies = diag.map((d) => {
    try { return JSON.parse(d.text.slice('[diag] '.length)); } catch { return null; }
  });
  check('P2 v "1.8.2" on every line',
    bodies.length > 0 && bodies.every((b) => b && b.v === '1.8.2'),
    bodies.map((b) => b && b.v).join(','));
  check('P3 tu/vfc keys present',
    bodies.length > 0 && bodies.every((b) => b && 'tu' in b && 'vfc' in b),
    'tu+vfc');
  if (bodies.length > 0) {
    const last = bodies[bodies.length - 1];
    console.log(
      `last line: step=${last.step} t=${last.t} dur=${last.dur} paused=${last.paused} ` +
      `tu=${last.tu} vfc=${last.vfc} thumbLeft=${JSON.stringify(last.thumbLeft)} tracks=${last.tracks}`,
    );
  }

  // P4: without the flag the page stays silent.
  const page2 = await context.newPage();
  await page2.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page2.waitForSelector('#serve-gate', { state: 'hidden' });
  const silent = (await captureDiag(page2, SILENT_MS, Date.now()))
    .filter((l) => l.text.startsWith('[diag]'));
  check('P4 silent without ?debug=1', silent.length === 0, `${silent.length} lines in ${SILENT_MS}ms`);
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
