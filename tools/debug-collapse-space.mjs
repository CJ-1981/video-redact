#!/usr/bin/env node
// @ts-nocheck
/**
 * debug-collapse-space.mjs — mobile layout audit for the field report:
 * "when capability report collapsed, big empty space underneath on mobile".
 *
 * Opens the dist at 390x844 (landing state), collapses the Capability report
 * details, then measures the height chain (details, #intake-panel, #app-main,
 * body scrollHeight) and reports which element's box exceeds the sum of its
 * visible children. Run: node tools/debug-collapse-space.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8173;
const BASE = `http://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, [resolve(ROOT, 'tools', 'serve.mjs')], {
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

try {
  await page.goto(`${BASE}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  const measure = (label) =>
    page.evaluate((label) => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { h: Math.round(r.height), bottom: Math.round(r.bottom) };
      };
      const capDetails = document.querySelector('#intake-panel details.panel-collapse');
      const kids = capDetails ? [...capDetails.children].map((c) => ({ tag: c.tagName, hidden: c.hidden, h: Math.round(c.getBoundingClientRect().height) })) : null;
      return {
        label,
        scrollH: document.documentElement.scrollHeight,
        innerH: window.innerHeight,
        capDetails: pick('#intake-panel details.panel-collapse'),
        capDetailsOpen: capDetails?.open,
        capDetailsKids: kids,
        intake: pick('#intake-panel'),
        appMain: pick('#app-main'),
        body: { h: Math.round(document.body.getBoundingClientRect().height) },
        footer: pick('#keyboard-hints'),
        models: pick('#model-attribution'),
      };
    }, label);

  const before = await measure('before-collapse');
  console.log(JSON.stringify(before, null, 1));

  // collapse the capability report
  const summary = page.locator('#intake-panel details.panel-collapse > summary');
  await summary.click();
  await page.waitForTimeout(300);
  const after = await measure('after-collapse');
  console.log(JSON.stringify(after, null, 1));

  const growth = after.scrollH - before.scrollH;
  console.log(`scrollHeight before=${before.scrollH} after=${after.scrollH} delta=${growth}`);

  // ---- Phase 2: LOADED state (ready) — the real field scenario ----
  await page.setInputFiles('#file-input', join(ROOT, 'tests', 'fixtures', 'detectable.mp4'));
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 60000 });
  await page.waitForTimeout(400);
  // collapse cap report if open
  const capOpen = await page.evaluate(() => document.querySelector('#intake-panel details.panel-collapse')?.open ?? false);
  if (capOpen) await summary.click();
  await page.waitForTimeout(300);
  const loaded = await measure('loaded-collapsed');
  console.log(JSON.stringify(loaded, null, 1));
  const offenders2 = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('#app-main, #app-main *, #below-timeline, #below-timeline *')) {
      const r = el.getBoundingClientRect();
      if (r.height > window.innerHeight * 0.9 && el.id !== 'timeline-thumb') {
        out.push({ sel: el.id ? '#' + el.id : el.tagName + '.' + (el.className || '').toString().slice(0, 24), h: Math.round(r.height), top: Math.round(r.top) });
      }
    }
    return out.slice(0, 12);
  });
  console.log('LOADED OFFENDERS (>90% viewport):', JSON.stringify(offenders2, null, 1));
  const dz = await page.evaluate(() => {
    const el = document.querySelector('#drop-zone');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { h: Math.round(r.height), top: Math.round(r.top), display: style.display, visible: r.height > 0 };
  });
  console.log('DROP ZONE in loaded state:', JSON.stringify(dz));
  const deep = await page.evaluate(() => {
    const panel = document.querySelector('#intake-panel');
    const st = getComputedStyle(panel);
    const dump = (el, depth) => {
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      const row = { d: depth, sel: el.id ? '#' + el.id : el.tagName + (el.className ? '.' + String(el.className).split(' ')[0] : ''), h: Math.round(r.height), display: c.display, hidden: el.hidden };
      if (Number.parseFloat(c.paddingTop) || Number.parseFloat(c.paddingBottom)) row.pad = c.paddingTop + '/' + c.paddingBottom;
      if (Number.parseFloat(c.marginTop) || Number.parseFloat(c.marginBottom)) row.mar = c.marginTop + '/' + c.marginBottom;
      const out = [row];
      if (depth < 2) for (const ch of el.children) out.push(...dump(ch, depth + 1));
      return out;
    };
    return { panelPad: st.paddingTop + '/' + st.paddingBottom, panelGap: st.gap, tree: dump(panel, 0) };
  });
  console.log('INTAKE DEEP:', JSON.stringify(deep, null, 1));
  const exact = await page.evaluate(() => {
    const panel = document.querySelector('#intake-panel');
    const st = getComputedStyle(panel);
    const out = { panelH: Math.round(panel.getBoundingClientRect().height), panelTop: Math.round(panel.getBoundingClientRect().top), panelBottom: Math.round(panel.getBoundingClientRect().bottom), height: st.height, flex: st.flex, alignSelf: st.alignSelf, minHeight: st.minHeight, display: st.display };
    for (const ch of panel.children) {
      const r = ch.getBoundingClientRect();
      out[ch.id || ch.tagName] = { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
    }
    return out;
  });
  console.log('EXACT:', JSON.stringify(exact, null, 1));
  const intakeKids = await page.evaluate(() => [...document.querySelectorAll('#intake-panel > *')].map((el) => ({
    sel: el.id ? '#' + el.id : el.tagName, h: Math.round(el.getBoundingClientRect().height), hidden: el.hidden,
  })));
  console.log('INTAKE CHILDREN:', JSON.stringify(intakeKids, null, 1));
  if (after.scrollH > after.innerH + 40) {
    // find the deepest offender: walk children of app-main and intake
    const offenders = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#app-main, #app-main *')) {
        const r = el.getBoundingClientRect();
        if (r.height > window.innerHeight && el.tagName !== 'HTML' && el.tagName !== 'BODY') {
          out.push({ sel: el.id ? '#' + el.id : el.tagName + '.' + (el.className || '').toString().slice(0, 20), h: Math.round(r.height) });
        }
      }
      return out.slice(0, 10);
    });
    console.log('OFFENDERS (>viewport height):', JSON.stringify(offenders, null, 1));
  }
} finally {
  await browser.close();
  server.kill();
}
