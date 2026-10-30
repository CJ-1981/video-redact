#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-touch-timeline.mjs — v1.6.2 touch-device timeline probe (pattern:
 * tools/debug-regressions.mjs). TOUCH context: viewport 390×844, hasTouch,
 * isMobile — real touch input through CDP Input.dispatchTouchEvent plus
 * page.touchscreen.tap, so the browser's gesture handling (scroll takeover,
 * pointercancel) is exercised exactly as on a phone.
 *
 * Loads the REAL dist artifact (spawn tools/serve.mjs, load
 * tests/fixtures/detectable.mp4, analyze — the persistent profile caches the
 * models per origin — and draw a manual box so a full-span chip always
 * exists), then instruments #timeline with pointercancel/pointerdown/up
 * counters and asserts:
 *
 *   T1  plain touchscreen.tap at the STRIP's 50% → |t − 0.5·dur| < 0.15 s
 *       (also reports whether a pointercancel fired — pre-fix evidence)
 *   T2  JITTER tap (touch down, ~5 px finger drift, up — how real fingertips
 *       tap) at the AXIS's 25% → |t − 0.25·dur| < 0.15 s. Without
 *       touch-action: none the drift starts a page scroll → pointercancel →
 *       no click → no seek (the v1.6.1 field report).
 *   T2c DESKTOP GUARD: a mouse click at the strip's 50% still seeks after the
 *       pointerup-seek rework (the click path is gone; the pointer path must
 *       serve both pointer kinds).
 *   T3  chip-edge TOUCH drag (finger down on the widest chip's end edge, drag
 *       left 60 px, up) → chip width shrinks ≥ 20 px (trim still works).
 *   T-thumb v1.7.0 scrub handle: after parking the playhead at the axis's 25%
 *       (a plain tap — the thumb must follow), TOUCH-drag the thumb
 *       (touchStart on the disc, touchMove to the axis's 50%, touchEnd) →
 *       |t − 0.5·dur| < 0.15 s after release AND currentTime followed the
 *       move (mid-drag sample: t past the 25% grab point, thumb x advanced).
 *   T-play v1.8.1 scrub-thumb playback following: with NO interaction after
 *       video.play(), the thumb must track the playhead — moved ≥ 15% of the
 *       strip width from its start AND thumb x ≈ currentTime/duration ±5%.
 *       (Field defect: rVFC starved on some desktops → thumb frozen at its
 *       CSS-default 0% for a whole clip; reports the rVFC frame count so a
 *       pass reads either "loop healthy" or "loop starved, timeupdate carried
 *       it". Phase B emulates the playback event stream ONLY when the browser
 *       has a dead media clock — play() fulfills but time never advances.)
 *   T4  Clear button is styled alert red (text rgb(229,72,77), alert-tinted
 *       border, white-on-red :hover rule in the CSSOM) AND remains
 *       functional: clicking it returns the stepper to the gate step.
 *
 * PASS = every check prints PASS. Run: node tools/debug-touch-timeline.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PROBE_PORT || 8199; // SAME origin as the regression probe → shared warm model cache
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');
const PROFILE = join(ROOT, 'test-results', 'regression-probe-profile');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launchPersistentContext(PROFILE, {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (!t.includes('[vfc]')) console.log(`[console.${m.type()}]`, t.slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const cdp = await page.context().newCDPSession(page);

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

// --- #timeline gesture counters (attach ONCE; read/reset around each check) --
const instrument = () =>
  page.evaluate(() => {
    if (window.__tlInstr) return;
    window.__tlInstr = true;
    window.__pc = 0; // pointercancel count on the strip
    window.__pd = 0; // pointerdown count
    window.__pu = 0; // pointerup count
    const tl = document.getElementById('timeline');
    tl.addEventListener('pointercancel', () => { window.__pc += 1; });
    tl.addEventListener('pointerdown', () => { window.__pd += 1; });
    tl.addEventListener('pointerup', () => { window.__pu += 1; });
  });
const stats0 = () => page.evaluate(() => ({ pc: window.__pc, pd: window.__pd, pu: window.__pu }));
const statsDelta = async (s0) => {
  const s1 = await page.evaluate(() => ({ pc: window.__pc, pd: window.__pd, pu: window.__pu }));
  return { dpc: s1.pc - s0.pc, dpd: s1.pd - s0.pd, dpu: s1.pu - s0.pu };
};

/** Reset the video to a paused t=0 baseline and settle. */
const toZero = () =>
  page.evaluate(() => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.currentTime = 0;
  });

/**
 * A real touch gesture through the browser input pipeline: touchStart at
 * points[0], touchMove through the rest, touchEnd. `holdMs` per step keeps
 * each segment a distinct gesture tick (so the browser can decide scroll).
 */
async function touchSeq(points, holdMs = 40) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [points[0]] });
  await page.waitForTimeout(holdMs);
  for (const p of points.slice(1)) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
    await page.waitForTimeout(holdMs);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** A realistic fingertip tap: down, ~5 px of finger drift, up. */
const jitterTap = (x, y) => touchSeq([{ x, y }, { x: x + 1, y: y + 5 }], 45);

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  // ---- load + analyze (real models; the persistent profile caches them) ----
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });
  console.log('--- file ready; analyzing (downloads models on first run) ---');
  await page.click('#analyze-button');
  try {
    await page.waitForSelector('#track-list li.track-row', { timeout: 330000 });
  } catch {
    console.log('--- no auto tracks (legal); manual box below still mounts the editor ---');
  }

  // Deterministic full-span chip: draw a manual box on the preview canvas.
  const box = await page.evaluate(() => {
    const c = document.getElementById('overlay-canvas');
    const b = c.getBoundingClientRect();
    return { cx: b.left + b.width / 2, cy: b.top + b.height / 2, w: b.width, h: b.height };
  });
  const d = Math.min(40, box.w / 4, box.h / 4);
  await page.mouse.move(box.cx - d, box.cy - d);
  await page.mouse.down();
  await page.mouse.move(box.cx + d, box.cy + d, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector('#track-list li.track-row', { timeout: 10000 });
  // A real phone user SCROLLS the timeline into view before tapping it (on
  // 390×844 the strip sits ~1170px down the single-column layout). Scroll it
  // to mid-viewport like a finger would — and leave scroll room above/below
  // so a scroll takeover (the pointercancel path) is actually reachable.
  await page.evaluate(() => {
    document.getElementById('timeline').scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  console.log('--- review ready (manual full-span chip drawn); touch context armed ---');

  const layout0 = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) };
    };
    return {
      scrollY: Math.round(window.scrollY),
      docH: document.documentElement.scrollHeight,
      intake: { hidden: document.getElementById('intake-panel')?.hidden, rect: r('#intake-panel') },
      stage: r('#preview-stage'),
      timeline: r('#timeline'),
      axis: r('#timeline-track'),
    };
  });
  console.log('--- layout (post scrollIntoView) ---');
  console.log(JSON.stringify(layout0));

  await instrument();

  const dur = await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    return Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  });
  if (!(dur > 0)) throw new Error(`video duration not usable: ${dur}`);
  const strip = layout0.timeline;
  const axis = layout0.axis;

  // ======================================================================
  // T1 — plain touchscreen.tap at the strip's 50%
  // ======================================================================
  console.log('--- T1: plain touchscreen.tap at strip 50% ---');
  await toZero();
  await page.waitForTimeout(250);
  const s0a = await stats0();
  await page.touchscreen.tap(strip.left + strip.w * 0.5, strip.top + strip.h / 2);
  await page.waitForTimeout(400);
  const t1 = await page.evaluate(() => document.getElementById('preview-video').currentTime);
  const g1 = await statsDelta(s0a);
  check(
    'T1 plain tap at strip 50% seeks to 0.5·dur',
    Math.abs(t1 - 0.5 * dur) < 0.15,
    `t=${t1.toFixed(3)} expected ${(0.5 * dur).toFixed(3)} (dur=${dur.toFixed(2)}) ` +
      `[pointerdown=${g1.dpd} up=${g1.dpu} CANCEL=${g1.dpc}]`,
  );

  // ======================================================================
  // T2 — jitter tap (realistic fingertip) at the axis's 25%
  // ======================================================================
  console.log('--- T2: jitter tap at axis 25% (finger drift → scroll takeover?) ---');
  await toZero();
  await page.waitForTimeout(250);
  const scroll0 = await page.evaluate(() => window.scrollY);
  const s0b = await stats0();
  await jitterTap(axis.left + axis.w * 0.25, axis.top + axis.h / 2);
  await page.waitForTimeout(400);
  const t2 = await page.evaluate(() => document.getElementById('preview-video').currentTime);
  const g2 = await statsDelta(s0b);
  const scrolled = (await page.evaluate(() => window.scrollY)) - scroll0;
  check(
    'T2 jitter tap at axis 25% seeks to 0.25·dur',
    Math.abs(t2 - 0.25 * dur) < 0.15,
    `t=${t2.toFixed(3)} expected ${(0.25 * dur).toFixed(3)} ` +
      `[pointerdown=${g2.dpd} up=${g2.dpu} CANCEL=${g2.dpc} pageScrolled=${scrolled}px]`,
  );

  // ======================================================================
  // T2c — desktop guard: mouse click still seeks (pointerup path, both kinds)
  // ======================================================================
  console.log('--- T2c: mouse click at strip 50% (desktop path guard) ---');
  await toZero();
  await page.waitForTimeout(250);
  await page.mouse.click(strip.left + strip.w * 0.5, strip.top + strip.h / 2);
  await page.waitForTimeout(400);
  const t2c = await page.evaluate(() => document.getElementById('preview-video').currentTime);
  check(
    'T2c mouse click at strip 50% seeks to 0.5·dur',
    Math.abs(t2c - 0.5 * dur) < 0.15,
    `t=${t2c.toFixed(3)} expected ${(0.5 * dur).toFixed(3)}`,
  );

  // ======================================================================
  // T3 — chip-edge TOUCH drag still trims
  // ======================================================================
  console.log('--- T3: chip-edge touch drag trims ---');
  const before = await page.evaluate(() => {
    const container = document.getElementById('track-chips');
    const chips = [...container.querySelectorAll('div[data-track-id]')];
    let best = null;
    for (const el of chips) {
      if (!best || el.getBoundingClientRect().width > best.getBoundingClientRect().width) best = el;
    }
    if (!best) return null;
    const b = best.getBoundingClientRect();
    return { id: best.dataset.trackId, chipW: b.width, endX: b.right, y: b.top + b.height / 2 };
  });
  if (!before) throw new Error('no chip to trim — manual box draw failed');
  const s0c = await stats0();
  const dragY = before.y;
  const steps = [];
  for (let i = 1; i <= 6; i++) steps.push({ x: before.endX - (60 * i) / 6, y: dragY });
  await touchSeq([{ x: before.endX, y: dragY }, ...steps], 45);
  await page.waitForTimeout(300);
  const afterW = await page.evaluate((id) => {
    const el = document.querySelector(`#track-chips div[data-track-id="${id}"]`);
    return el ? el.getBoundingClientRect().width : -1;
  }, before.id);
  const g3 = await statsDelta(s0c);
  check(
    'T3 chip-edge touch drag shrinks the chip live',
    before.chipW - afterW >= 20,
    `chip#${before.id} before=${before.chipW.toFixed(0)}px after=${afterW.toFixed(0)}px ` +
      `[pointerdown=${g3.dpd} up=${g3.dpu} CANCEL=${g3.dpc}]`,
  );

  // ======================================================================
  // T-thumb — v1.7.0 scrub handle: touchscreen DRAG 25% → 50% (+ follow)
  // ======================================================================
  console.log('--- T-thumb: touchscreen drag of #timeline-thumb 25% → 50% ---');
  await toZero();
  await page.waitForTimeout(250);
  // Fresh axis rect (T1–T3 may have scrolled/toasted; never trust stale coords).
  const axisNow = await page.evaluate(() => {
    const b = document.getElementById('timeline-track').getBoundingClientRect();
    return { left: b.left, top: b.top, w: b.width, h: b.height };
  });
  // Park the playhead at the axis's 25% with a plain tap — this also exercises
  // the playhead-follow rendering (the thumb must ride along to 25%).
  await page.touchscreen.tap(axisNow.left + axisNow.w * 0.25, axisNow.top + axisNow.h / 2);
  await page.waitForTimeout(400);
  const thumbAt25 = await page.evaluate(() => {
    const el = document.getElementById('timeline-thumb');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { cx: b.left + b.width / 2, cy: b.top + b.height / 2 };
  });
  const parkedT = await page.evaluate(() => document.getElementById('preview-video').currentTime);
  const parkedOk =
    !!thumbAt25 &&
    Math.abs(parkedT - 0.25 * dur) < 0.15 &&
    Math.abs(thumbAt25.cx - (axisNow.left + axisNow.w * 0.25)) < 8;
  check(
    'T-thumba thumb rides the playhead: parked at axis 25% after a 25% tap',
    !!parkedOk,
    `t=${parkedT.toFixed(3)} expected ${(0.25 * dur).toFixed(3)} thumbCx=${
      thumbAt25 ? thumbAt25.cx.toFixed(1) : 'MISSING'
    } expected ${(axisNow.left + axisNow.w * 0.25).toFixed(1)}`,
  );
  // TOUCH-drag the thumb from 25% to the axis's 50% through 4 move steps,
  // sampling the video time + thumb x mid-drag (the throttled live scrub).
  const targetX = axisNow.left + axisNow.w * 0.5;
  let midSample = null;
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: thumbAt25.cx, y: thumbAt25.cy }],
  });
  await page.waitForTimeout(60);
  for (let i = 1; i <= 4; i++) {
    const x = thumbAt25.cx + ((targetX - thumbAt25.cx) * i) / 4;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: thumbAt25.cy }] });
    await page.waitForTimeout(60);
    if (i === 2) {
      midSample = await page.evaluate(() => ({
        t: document.getElementById('preview-video').currentTime,
        thumbCx: (() => {
          const b = document.getElementById('timeline-thumb').getBoundingClientRect();
          return b.left + b.width / 2;
        })(),
      }));
    }
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  const tThumb = await page.evaluate(() => document.getElementById('preview-video').currentTime);
  const followedOk =
    !!midSample && midSample.t > 0.25 * dur && midSample.thumbCx > thumbAt25.cx + 4;
  check(
    'T-thumbb touch-drag 25%→50% seeks to 0.5·dur (time followed mid-drag)',
    Math.abs(tThumb - 0.5 * dur) < 0.15 && !!followedOk,
    `t=${tThumb.toFixed(3)} expected ${(0.5 * dur).toFixed(3)} ` +
      `mid={t=${midSample ? midSample.t.toFixed(3) : 'n/a'}, thumbCx=${midSample ? midSample.thumbCx.toFixed(0) : 'n/a'}}`,
  );

  // ======================================================================
  // T-play — v1.8.1: the thumb FOLLOWS PLAYBACK with no interaction at all.
  // Field defect: the editor's position updates rode solely on the rVFC/rAF
  // frame loop; when rVFC never fires during playback (compositor starved),
  // the thumb sat at its CSS-default 0% while the transport timecode
  // (timeupdate-driven) stayed live. The v1.8.1 fix adds a timeupdate
  // fallback in editor.js; this check plays the video untouched and reads
  // the thumb, plus counts delivered rVFC frames for the evidence trail.
  // Phase A is a real video.play(); SOME CI/headless Chromium builds have a
  // dead media clock (play() fulfills, `playing` fires, currentTime never
  // advances — observed on this machine in headless AND headful). There,
  // Phase B emulates exactly the media-event stream real playback emits
  // (currentTime advances + `timeupdate`) and asserts the same contract.
  // ======================================================================
  console.log('--- T-play: thumb follows playback (no interaction) ---');
  // Wrap rVFC with a passive counter (editor.js looks the method up per call,
  // so the wrapper is transparent to it) and reset for the play window.
  await page.evaluate(() => {
    if (!window.__vfcWrapped) {
      window.__vfcWrapped = true;
      const orig = HTMLVideoElement.prototype.requestVideoFrameCallback;
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (cb) {
        return orig.call(this, (...args) => {
          window.__vfcCount = (window.__vfcCount || 0) + 1;
          return cb(...args);
        });
      };
    }
    window.__vfcCount = 0;
  });
  const readThumbState = () =>
    page.evaluate(() => {
      const v = document.getElementById('preview-video');
      const b = document.getElementById('timeline-track').getBoundingClientRect();
      const tb = document.getElementById('timeline-thumb').getBoundingClientRect();
      return {
        t: v.currentTime,
        thumbCx: tb.left + tb.width / 2,
        axisLeft: b.left,
        axisW: b.width,
        vfc: window.__vfcCount || 0,
      };
    });
  await toZero();
  await page.waitForTimeout(250);
  const thumbStart = await readThumbState();
  // Long enough for ≥15% of the strip on ANY fixture, 1.2 s minimum.
  const playMs = Math.min(3000, Math.max(1200, Math.ceil(0.18 * dur * 1000)));
  const playOk = await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    v.currentTime = 0;
    return v.play().then(
      () => true,
      (err) => {
        console.warn('play() rejected:', String(err));
        return false;
      },
    );
  });
  await page.waitForTimeout(playMs);
  let playSample = await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    const st = { t: v.currentTime, playing: !v.paused, vfc: window.__vfcCount || 0 };
    v.pause();
    return st;
  });
  let mode = 'real playback';
  // Phase B — only when the real media clock is dead (t never advanced).
  if (playSample.t < 0.15) {
    mode = 'timeupdate emulation (media clock stalled in this browser)';
    console.log(`--- T-play: media clock stalled (t=${playSample.t.toFixed(3)} after ${playMs}ms, playing=${playSample.playing}) — emulating the playback event stream ---`);
    await toZero();
    await page.waitForTimeout(250);
    await page.evaluate(
      (steps) => {
        const v = document.getElementById('preview-video');
        let i = 0;
        const step = () => {
          if (i >= steps.length) return;
          v.currentTime = steps[i];
          i += 1;
          v.dispatchEvent(new Event('timeupdate')); // the media event playback emits
          setTimeout(step, 150);
        };
        step();
      },
      [0, dur * 0.125, dur * 0.25, dur * 0.375, dur * 0.5],
    );
    await page.waitForTimeout(150 * 6);
    playSample = await readThumbState();
  } else {
    playSample = { ...playSample, ...(await readThumbState()) };
  }
  const expectedX = playSample.axisLeft + (playSample.t / dur) * playSample.axisW;
  const movedPct = ((playSample.thumbCx - thumbStart.thumbCx) / playSample.axisW) * 100;
  check(
    'T-playa thumb advanced ≥15% of the strip during untouched playback',
    playOk && movedPct >= 15,
    `moved=${movedPct.toFixed(1)}% of strip (thumbCx ${thumbStart.thumbCx.toFixed(0)} → ${
      playSample.thumbCx.toFixed(0)
    }, axisW=${playSample.axisW.toFixed(0)}, mode=${mode}) ` +
      `[rVFC frames delivered=${playSample.vfc}${playSample.vfc === 0 && mode === 'real playback' ? ' — LOOP STARVED, timeupdate carried it' : ''}]`,
  );
  check(
    'T-playb thumb x ≈ currentTime/duration ±5% after playback',
    Math.abs(playSample.thumbCx - expectedX) <= 0.05 * playSample.axisW,
    `t=${playSample.t.toFixed(3)}s dur=${dur.toFixed(2)} thumbCx=${playSample.thumbCx.toFixed(1)} expectedX=${expectedX.toFixed(1)} (±${(0.05 * playSample.axisW).toFixed(0)}px) mode=${mode}`,
  );

  // ======================================================================
  // T4 — Clear button: alert red + still functional (click → back to gate)
  // ======================================================================
  console.log('--- T4: Clear button red + functional ---');
  const clearStyle = await page.evaluate(() => {
    const el = document.getElementById('clear-file');
    if (!el) return null;
    const cs = getComputedStyle(el);
    let hover = null;
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.includes('#clear-file:hover')) {
          hover = r.style ? r.style.cssText : r.cssText;
        }
      }
    }
    const b = el.getBoundingClientRect();
    return { color: cs.color, border: cs.borderColor, bg: cs.backgroundColor, hover, visible: b.width > 0 && b.height > 0 };
  });
  const colorOk = clearStyle && clearStyle.color === 'rgb(229, 72, 77)';
  const borderOk = clearStyle && /rgba?\(229, 72, 77/.test(clearStyle.border);
  check(
    'T4a #clear-file text is alert red rgb(229,72,77)',
    !!colorOk,
    `color=${clearStyle ? clearStyle.color : 'none'} border=${clearStyle ? clearStyle.border : 'none'} bg=${clearStyle ? clearStyle.bg : 'none'}`,
  );
  check(
    'T4b #clear-file border is alert-tinted',
    !!borderOk,
    `border=${clearStyle ? clearStyle.border : 'none'}`,
  );
  check(
    'T4c #clear-file has a hover fill rule (white text on red)',
    !!(clearStyle && clearStyle.hover && /255, 255, 255|white/i.test(clearStyle.hover) && /229, 72, 77|#e5484d/i.test(clearStyle.hover)),
    `hoverCss=${clearStyle ? clearStyle.hover : 'none'}`,
  );
  await page.click('#clear-file');
  await page.waitForTimeout(400);
  const gateBack = await page.evaluate(() => ({
    gate: document.getElementById('step-gate')?.getAttribute('aria-current') === 'step',
    workspaceHidden: document.getElementById('workspace')?.hidden === true,
  }));
  check(
    'T4d clicking #clear-file returns to the gate step',
    gateBack.gate && gateBack.workspaceHidden,
    `gateCurrent=${gateBack.gate} workspaceHidden=${gateBack.workspaceHidden}`,
  );
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
