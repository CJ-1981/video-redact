#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-handles.mjs — empirical comparison of the TWO width handles:
 *   #intake-resize (capability panel | preview)  → --intake-w
 *   #rail-resize   (preview | right rail)        → --rail-w
 * For each: drag +150px and −150px, record the CSS var, the panel widths,
 * the preview stage width, and whether the handle itself follows the
 * pointer. Prints a comparison table.
 * Run: node tools/debug-handles.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8167;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');

let failures = 0;
const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  storageState: 'test-results/regression-probe-profile/state.json',
}).catch(() => browser.newContext({ viewport: { width: 1440, height: 900 } }));
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const snapshot = (page, handleSel) =>
  page.evaluate((sel) => {
    const h = document.querySelector(sel);
    const ws = document.querySelector('#workspace');
    const stage = document.querySelector('#preview-stage');
    const intake = document.querySelector('#intake-panel');
    const rail = document.querySelector('#right-rail');
    const hr = h.getBoundingClientRect();
    return {
      handleX: Math.round(hr.x + hr.width / 2),
      intakeW: Math.round(intake.getBoundingClientRect().width),
      railW: Math.round(rail.getBoundingClientRect().width),
      stageW: Math.round(stage.getBoundingClientRect().width),
      railVar: ws.style.getPropertyValue('--rail-w'),
      intakeVar: ws.style.getPropertyValue('--intake-w') || '(unset)',
    };
  }, handleSel);

async function drag(page, sel, dx) {
  const h = await page.locator(sel).boundingBox();
  const y = h.y + h.height / 2;
  const x0 = h.x + h.width / 2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  await page.mouse.move(x0 + dx, y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

try {
  await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', { timeout: 240000 });
  console.log('--- review reached ---');
  console.log('--- review reached ---');

  // v1.28.1: header icon-duplication audit (field report on iOS)
  const iconAudit = await page.evaluate(() => {
    const out = [];
    for (const sel of ['#project-save', '#project-load', '#change-file']) {
      const el = document.querySelector(sel);
      const textHasEmoji = /\p{Extended_Pictographic}/u.test(el.textContent);
      const beforeContent = getComputedStyle(el, '::before').content;
      out.push({ sel, text: el.textContent.trim().slice(0, 24), textHasEmoji, beforeContent });
    }
    return out;
  });
  console.log('HEADER ICON AUDIT:', JSON.stringify(iconAudit, null, 1));
  for (const r of iconAudit) {
    const ok = !r.textHasEmoji;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.sel}: text="${r.text}" ::before=${r.beforeContent}`);
    if (!ok) failures += 1;
  }

  for (const [sel, name] of [['#intake-resize', 'LEFT (intake)'], ['#rail-resize', 'RIGHT (rail)']]) {
    console.log(`\n=== ${name} handle ===`);
    const before = await snapshot(page, sel);
    await drag(page, sel, 150);
    const afterR = await snapshot(page, sel);
    await drag(page, sel, -300); // back past start
    const afterL = await snapshot(page, sel);
    console.log(`before    : ${JSON.stringify(before)}`);
    console.log(`after +150: ${JSON.stringify(afterR)}`);
    console.log(`after -150: ${JSON.stringify(afterL)}`);
    const handleFollowsR = afterR.handleX > before.handleX;
    const handleFollowsL = afterL.handleX < before.handleX;
    console.log(`handle follows pointer: right-drag ${handleFollowsR ? 'YES' : 'NO'} · left-drag ${handleFollowsL ? 'YES' : 'NO'}`);
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(`SUMMARY: ${failures} failure(s)`);
