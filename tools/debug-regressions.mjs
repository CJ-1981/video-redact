#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-regressions.mjs — v1.6.1 field-regression probe (ONE combined probe,
 * pattern: tools/debug-times-overflow.mjs / tools/debug-trim.mjs).
 *
 * Asserts, on the REAL dist artifact (spawn tools/serve.mjs, load
 * tests/fixtures/detectable.mp4, analyze, draw a manual box so a full-span
 * chip always exists):
 *
 *   REG-1 timeline click-to-seek
 *     a. click #timeline at 50% width → |currentTime − 0.5·duration| < 0.1 s
 *     b. click the #timeline-track axis at 25% → seeks ~0.25·duration (the
 *        strip-rect mapping skew made clicks land far from the target)
 *     c. click a chip BODY → seeks
 *     d. pointerdown in a chip-edge zone + pointercancel, then click → the
 *        click must NOT be swallowed by a latched suppressClick flag
 *         (touch scroll over the strip pointercancels easily — after that,
 *         every later tap was dead)
 *     e. chip-edge trim drag still works and the click AFTER it is suppressed
 *        exactly once (next click seeks)
 *
 *   REG-2 keyboard shortcuts after clicking controls
 *     f. click #transport-play (plays) → press Space → paused, exactly ONE
 *        extra toggle, focus back on <body>
 *     g. focus #transport-fwd (a NON-play control) → Space must toggle the
 *        VIDEO (pre-fix the focused button swallowed/re-activated instead)
 *     h. click #preview-fullscreen → Space toggles play AND stays enlarged
 *     i. a focused track-row time input (.span-input) KEEPS its exclusion:
 *        Space types into it and must not toggle the video
 *
 *   REG-3 footer vs timeline overlap at max stage height
 *     j. drag #stage-resize-handle to the bottom at 1280×800 → no bounding-box
 *        intersection between #keyboard-hints and #timeline / #transport-bar
 *     k. viewport 390×844 (resize re-clamp fires) + drag again → same
 *
 * PASS = every check prints PASS. Run: node tools/debug-regressions.mjs
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PROBE_PORT || 8199;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');
// Persistent profile: the model cache (IndexedDB, per origin) survives across
// runs so repeat probes skip the CDN model download.
const PROFILE = join(ROOT, 'test-results', 'regression-probe-profile');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launchPersistentContext(PROFILE, { viewport: { width: 1280, height: 800 } });
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (!t.includes('[vfc]')) console.log(`[console.${m.type()}]`, t.slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

/** rects + overlap helpers, evaluated in-page */
const LAYOUT = () => {
  const r = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height };
  };
  return {
    vh: window.innerHeight,
    stage: r('#preview-stage'),
    timeline: r('#timeline'),
    track: r('#timeline-track'),
    transport: r('#transport-bar'),
    manualHint: r('#manual-hint'),
    hints: r('#keyboard-hints'),
    stageH: (document.querySelector('#preview-stage')?.style.getPropertyValue('--stage-h') || '').trim(),
  };
};
const overlaps = (a, b) =>
  !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  // ---- load + analyze (real models; the persistent profile caches them) ----
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });
  console.log('--- file ready; analyzing (downloads models on first run) ---');
  await page.click('#analyze-button');
  try {
    await page.waitForSelector('#track-list li.track-row', { timeout: 360000 });
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
  console.log('--- review ready (manual full-span chip drawn) ---');

  // Geometry + chip inventory (diagnostics for the seek/trim math below).
  const inv = await page.evaluate(() => {
    const r = (el) => {
      const b = el.getBoundingClientRect();
      return { left: Math.round(b.left), w: Math.round(b.width), top: Math.round(b.top), h: Math.round(b.height) };
    };
    return {
      timeline: r(document.getElementById('timeline')),
      track: r(document.getElementById('timeline-track')),
      chips: r(document.getElementById('track-chips')),
      labels: [...document.querySelectorAll('#track-list .track-row')].map(
        (row) => `${row.querySelector('.label')?.textContent} ${row.querySelector('.span')?.textContent}`,
      ),
      chipEls: [...document.querySelectorAll('#track-chips div[data-track-id]')].map((el) => ({
        id: el.dataset.trackId,
        title: el.title,
        ...r(el),
      })),
    };
  });
  console.log('--- inventory ---');
  console.log(JSON.stringify(inv, null, 1));

  // ======================================================================
  // REG-1 — timeline click-to-seek
  // ======================================================================
  console.log('--- REG-1: timeline click-to-seek ---');
  await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.currentTime = 0;
  });
  await page.waitForTimeout(250);
  const dur = await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    return Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  });
  if (!(dur > 0)) throw new Error(`video duration not usable: ${dur}`);

  /** Click at a fraction of a rect's width and report the resulting time. */
  async function clickAt(rect, fraction) {
    await page.mouse.click(rect.left + rect.w * fraction, rect.top + rect.h / 2);
    await page.waitForTimeout(350); // seeked + rVFC settle
    return page.evaluate(() => document.getElementById('preview-video').currentTime);
  }

  const layout0 = await page.evaluate(LAYOUT);
  // Seek expectation for a click at `fraction` of the STRIP: the time axis is
  // the chips/track rect, so the axis fraction is what matters (post-fix the
  // app maps clicks through the axis; a strip click at f lands at
  // (f·strip.w − stripToTrack)/track.w of the duration).
  const stripFracExpect = (fraction) => {
    const x = layout0.timeline.left + fraction * layout0.timeline.w;
    return ((x - layout0.track.left) / layout0.track.w) * dur;
  };
  // (a) the task's assertion: 50% of the TIMELINE STRIP (symmetric layout →
  // strip 50% ≡ axis 50%)
  const tA = await clickAt(layout0.timeline, 0.5);
  check(
    'REG-1a strip 50% click seeks',
    Math.abs(tA - 0.5 * dur) < 0.1,
    `t=${tA.toFixed(3)} expected ${(0.5 * dur).toFixed(3)} (dur=${dur.toFixed(2)})`,
  );
  // (b) 25% of the TIME AXIS (#timeline-track — where chips/playhead live)
  await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
  const tB = await clickAt(layout0.track, 0.25);
  check(
    'REG-1b track-axis 25% click lands at 0.25·dur',
    Math.abs(tB - 0.25 * dur) < 0.1,
    `t=${tB.toFixed(3)} expected ${(0.25 * dur).toFixed(3)}`,
  );
  // (c) click a chip BODY (center of the widest chip)
  const chip = await page.evaluate(() => {
    const container = document.getElementById('track-chips');
    const axis = container.getBoundingClientRect();
    let best = null;
    for (const el of container.querySelectorAll('div[data-track-id]')) {
      if (!best || el.getBoundingClientRect().width > best.getBoundingClientRect().width) best = el;
    }
    if (!best) return null;
    const b = best.getBoundingClientRect();
    return {
      x: b.left + b.width / 2,
      y: b.top + b.height / 2,
      w: b.width,
      axisFrac: (b.left + b.width / 2 - axis.left) / axis.width,
    };
  });
  if (chip && chip.w > 24) {
    await page.evaluate(() => { document.getElementById('preview-video').currentTime = 0; });
    await page.mouse.click(chip.x, chip.y);
    await page.waitForTimeout(350);
    const tC = await page.evaluate(() => document.getElementById('preview-video').currentTime);
    const expected = (chip.axisFrac) * dur; // axis-relative chip-center time
    check('REG-1c chip body click seeks', Math.abs(tC - expected) < 0.35,
      `t=${tC.toFixed(3)} expected=${expected.toFixed(3)} chipW=${chip.w.toFixed(0)}px axisFrac=${chip.axisFrac.toFixed(3)}`);
  } else {
    console.log(`SKIP  REG-1c chip body click (chip ${chip ? chip.w.toFixed(0) : 'none'}px — too narrow to be a body)`);
  }

  // (d) suppressClick latch: arm an edge trim, pointercancel it, then click —
  // the click must NOT be swallowed by a latched suppressClick flag
  // (touch scroll over the strip pointercancels easily — after that,
  // every later tap was dead). The click target is 60% of the STRIP, whose
  // axis-relative time is stripFracExpect(0.6).
  await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.currentTime = 0;
  });
  await page.evaluate(() => {
    // Synthetic arm + cancel on the full-span chip's END edge (strip boundary):
    // exactly what a touch scroll-cancel over the strip produces.
    const timeline = document.getElementById('timeline');
    const chips = document.getElementById('track-chips');
    const cr = chips.getBoundingClientRect();
    const y = cr.top + cr.height / 2;
    const opts = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: cr.right, clientY: y };
    timeline.dispatchEvent(new PointerEvent('pointerdown', opts));
    timeline.dispatchEvent(new PointerEvent('pointercancel', opts));
  });
  await page.waitForTimeout(150);
  const tD = await clickAt(layout0.timeline, 0.6);
  check(
    'REG-1d click after canceled edge-gesture seeks',
    Math.abs(tD - stripFracExpect(0.6)) < 0.1,
    `t=${tD.toFixed(3)} expected ${stripFracExpect(0.6).toFixed(3)}`,
  );

  // (e) trim drag works live AND suppresses only its own follow-up click.
  // The arm picks the smallest containing span (ties → earlier track), i.e.
  // chip id=1 when both chips are full-span — measure THAT chip, by id, not
  // "the widest" (which changes identity after the trim).
  const before = await page.evaluate(() => {
    const container = document.getElementById('track-chips');
    const chips = [...container.querySelectorAll('div[data-track-id]')];
    let best = null;
    for (const el of chips) {
      if (!best || el.getBoundingClientRect().width > best.getBoundingClientRect().width) best = el;
    }
    const b = best.getBoundingClientRect();
    return {
      id: best.dataset.trackId,
      chipW: b.width,
      endX: b.right,
      chipsLeft: chips[0] ? chips[0].getBoundingClientRect().left : b.left,
      chipsW: container.getBoundingClientRect().width,
      y: b.top + b.height / 2,
    };
  });
  await page.mouse.move(before.endX, before.y);
  await page.mouse.down();
  await page.mouse.move(before.endX - 60, before.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const afterChipW = await page.evaluate((id) => {
    const el = document.querySelector(`#track-chips div[data-track-id="${id}"]`);
    return el ? el.getBoundingClientRect().width : -1;
  }, before.id);
  check('REG-1e trim drag changes chip width live', before.chipW - afterChipW >= 20,
    `chip#${before.id} before=${before.chipW.toFixed(0)}px after=${afterChipW.toFixed(0)}px`);
  await page.waitForTimeout(150);
  const tE = await clickAt(layout0.timeline, 0.6);
  check('REG-1e trim-then-click: the NEXT click seeks (suppression is once)',
    Math.abs(tE - stripFracExpect(0.6)) < 0.1, `t=${tE.toFixed(3)} expected ${stripFracExpect(0.6).toFixed(3)}`);

  // ======================================================================
  // REG-2 — keyboard shortcuts after clicking controls
  // ======================================================================
  console.log('--- REG-2: keyboard shortcuts after clicking controls ---');
  await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    if (!window.__toggles) {
      window.__toggles = 0;
      v.addEventListener('play', () => { window.__toggles += 1; });
      v.addEventListener('pause', () => { window.__toggles += 1; });
    }
    window.__toggles = 0;
    v.pause();
    v.currentTime = Math.min(1, v.duration / 3);
  });
  await page.waitForTimeout(150);

  // (f) click play (plays) → Space → exactly one more toggle → paused, body focus
  await page.click('#transport-play');
  await page.waitForTimeout(300);
  const f1 = await page.evaluate(() => ({
    paused: document.getElementById('preview-video').paused,
    focus: document.activeElement ? document.activeElement.tagName : '?',
  }));
  check('REG-2f clicking #transport-play plays + releases focus to body',
    f1.paused === false && f1.focus === 'BODY', `paused=${f1.paused} active=${f1.focus}`);
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const f2 = await page.evaluate(() => ({
    paused: document.getElementById('preview-video').paused,
    toggles: window.__toggles,
  }));
  check('REG-2f Space after click pauses with exactly ONE toggle',
    f2.paused === true && f2.toggles === 2, `paused=${f2.paused} toggles=${f2.toggles} (click+space)`);

  // (g) focus a NON-play transport control → Space must toggle the VIDEO
  await page.evaluate(() => {
    window.__toggles = 0;
    document.getElementById('preview-video').pause();
    document.getElementById('transport-fwd').focus();
  });
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => ({
    paused: document.getElementById('preview-video').paused,
    toggles: window.__toggles,
    focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName : '?',
  }));
  check('REG-2g Space with #transport-fwd focused toggles the video',
    g.paused === false && g.toggles === 1, `paused=${g.paused} toggles=${g.toggles} active=${g.focus}`);

  // (h) click the fullscreen/enlarge control → Space toggles play, stays enlarged
  await page.click('#preview-fullscreen');
  await page.waitForTimeout(600);
  const h0 = await page.evaluate(() => ({
    enlarged: !!document.fullscreenElement || document.getElementById('preview-stage').classList.contains('preview-zoom'),
    focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName : '?',
  }));
  if (h0.enlarged) {
    await page.evaluate(() => { document.getElementById('preview-video').pause(); });
    await page.waitForTimeout(250); // let the pause event settle…
    await page.evaluate(() => { window.__toggles = 0; }); // …then zero the counter
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    const h = await page.evaluate(() => ({
      enlarged: !!document.fullscreenElement || document.getElementById('preview-stage').classList.contains('preview-zoom'),
      paused: document.getElementById('preview-video').paused,
      toggles: window.__toggles,
    }));
    check('REG-2h Space in enlarged preview toggles video, stays enlarged',
      h.enlarged && h.paused === false && h.toggles === 1,
      `enlarged=${h.enlarged} paused=${h.paused} toggles=${h.toggles}`);
  } else {
    console.log(`SKIP  REG-2h (enlarge did not engage in this headless env; active=${h0.focus})`);
    await page.keyboard.press('Escape');
  }
  // Leave enlarged mode FOR CERTAIN before the remaining measurements
  // (focus() outside the fullscreen element is browser-blocked, which would
  // poison REG-2i).
  for (let guard = 0; guard < 3; guard++) {
    const still = await page.evaluate(() =>
      !!document.fullscreenElement ||
      document.getElementById('preview-stage').classList.contains('preview-zoom'));
    if (!still) break;
    await page.click('#preview-fullscreen');
    await page.waitForTimeout(500);
  }
  const exited = await page.evaluate(() =>
    !document.fullscreenElement &&
    !document.getElementById('preview-stage').classList.contains('preview-zoom'));
  check('REG-2 setup: enlarged preview exited', exited, `exited=${exited}`);

  // (i) track-row time input KEEPS its exclusion: Space types, video untouched
  await page.evaluate(() => { document.getElementById('preview-video').pause(); });
  await page.waitForTimeout(250); // let the pause event settle…
  await page.evaluate(() => {
    window.__toggles = 0; // …then zero the counter
    const input = document.querySelector('input.span-input');
    input.focus();
    input.value = '0:01.0';
  });
  const iFocus0 = await page.evaluate(() =>
    document.activeElement ? document.activeElement.className || document.activeElement.tagName : '?');
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  const i = await page.evaluate(() => ({
    paused: document.getElementById('preview-video').paused,
    toggles: window.__toggles,
    focus: document.activeElement ? document.activeElement.className || document.activeElement.tagName : '?',
    value: document.querySelector('input.span-input').value,
  }));
  check('REG-2i Space in a focused time input is excluded (types, no toggle)',
    i.paused === true && i.toggles === 0 && String(i.focus).includes('span-input'),
    `focusBefore=${iFocus0} paused=${i.paused} toggles=${i.toggles} active=${i.focus}`);
  // restore the input so the span edit doesn't fire a bogus trim
  await page.evaluate(() => {
    const input = document.querySelector('input.span-input');
    input.value = '0:00.0';
    input.blur();
  });

  // ======================================================================
  // REG-3 — footer vs timeline overlap at max stage height
  // ======================================================================
  console.log('--- REG-3: footer overlap at max stage height ---');

  /** Drag the resize handle hard downward (past the viewport bottom). */
  async function dragHandleToMax() {
    const h = await page.evaluate(() => {
      const b = document.getElementById('stage-resize-handle').getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    });
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    await page.mouse.move(h.x, h.y + 60, { steps: 4 });
    await page.mouse.move(h.x, 5000, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
  }
  const noOverlap = (m, label) => {
    const tl = overlaps(m.hints, m.timeline);
    const tb = overlaps(m.hints, m.transport);
    const th = overlaps(m.hints, m.manualHint);
    check(`${label}: footer ∩ timeline empty`, !tl,
      `hints[${m.hints.top.toFixed(0)}..${m.hints.bottom.toFixed(0)}] timeline[${m.timeline.top.toFixed(0)}..${m.timeline.bottom.toFixed(0)}] stage=${m.stageH}`);
    check(`${label}: footer ∩ transport empty`, !tb,
      `transport[${m.transport.top.toFixed(0)}..${m.transport.bottom.toFixed(0)}]`);
    check(`${label}: footer ∩ manual-hint empty`, !th,
      `hint[${m.manualHint.top.toFixed(0)}..${m.manualHint.bottom.toFixed(0)}]`);
    check(`${label}: timeline fully above footer`, m.timeline.bottom <= m.hints.top + 1,
      `timeline.bottom=${m.timeline.bottom.toFixed(0)} hints.top=${m.hints.top.toFixed(0)} vh=${m.vh}`);
  };

  /** Deterministic layout measurement: top of page first (the mobile layout
   * scrolls; rect comparisons must share one frame). */
  const measure = async () => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    return page.evaluate(LAYOUT);
  };

  await dragHandleToMax();
  noOverlap(await measure(), 'REG-3j 1280×800 max drag');

  // (k) phone viewport: the resize listener re-clamps, then drag again
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  noOverlap(await measure(), 'REG-3k 390×844 re-clamped');
  await dragHandleToMax();
  noOverlap(await measure(), 'REG-3k 390×844 max drag');
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
