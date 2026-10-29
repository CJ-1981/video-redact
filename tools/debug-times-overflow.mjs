#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-times-overflow.mjs — element-level audit of track-row time fields on
 * a phone-size viewport (REQ: "time fields overflow in the track in mobile view").
 *
 * Opens dist at 390x844, loads a fixture, analyzes, waits for a track, then
 * measures every element in each .track-row: does any child's box exceed the
 * row's content box (right/bottom), and does any .span-input clip its text
 * (scrollWidth > clientWidth)? Prints a compact table + PASS/FAIL summary.
 * Run: node tools/debug-times-overflow.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8191;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });
  await page.click('#analyze-button');
  await page.waitForSelector('#track-list li.track-row', { timeout: 240000 });
  console.log('--- track row present; measuring ---');

  const report = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#track-list li.track-row')];
    const out = { rowCount: rows.length, rows: [], viewport: document.documentElement.clientWidth };
    for (const row of rows) {
      const rr = row.getBoundingClientRect();
      const rowInfo = {
        label: row.querySelector('.label')?.textContent ?? '?',
        rowRight: Math.round(rr.right),
        rowWidth: Math.round(rr.width),
        overflows: [],
        clippedInputs: [],
      };
      for (const el of row.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        const overRight = b.right - (rr.right - 10); // 10px row padding
        if (overRight > 1) {
          rowInfo.overflows.push({
            cls: el.className, overRight: Math.round(overRight),
            w: Math.round(b.width),
          });
        }
        if (el.matches('input.span-input') && el.scrollWidth > el.clientWidth + 1) {
          rowInfo.clippedInputs.push({
            value: el.value, scrollW: el.scrollWidth, clientW: el.clientWidth,
          });
        }
      }
      const times = row.querySelector('.times');
      if (times) {
        const tb = times.getBoundingClientRect();
        rowInfo.times = { w: Math.round(tb.width), right: Math.round(tb.right) };
      }
      out.rows.push(rowInfo);
    }
    return out;
  });

  console.log(`viewport ${report.viewport}px, rows ${report.rowCount}`);
  for (const r of report.rows) {
    console.log(
      `row "${r.label}" width=${r.rowWidth} right=${r.rowRight} times=${JSON.stringify(r.times)}`,
    );
    for (const o of r.overflows) check(`  child <${o.cls}>`, false, `overflows row by ${o.overRight}px (w=${o.w})`);
    for (const c of r.clippedInputs) check(`  input "${c.value}"`, false, `text clipped scrollW=${c.scrollW} > clientW=${c.clientW}`);
    if (r.overflows.length === 0 && r.clippedInputs.length === 0) {
      check(`  row "${r.label}" children`, true, 'no overflow, no clipped inputs');
    }
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
