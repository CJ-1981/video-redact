#!/usr/bin/env node
// @ts-nocheck -- in-page runtime script: DOM access pattern-matched at runtime, not typecheck time
/**
 * debug-thumb-mouse.mjs — v1.8.0 DESKTOP MOUSE scrub-handle probe (companion
 * to tools/debug-touch-timeline.mjs). That probe exercises the timeline with
 * TOUCHSCREEN input only — the field report "timeline scrub handle doesn't
 * work on PC browser" was never covered. This probe closes the gap: a real
 * desktop mouse (page.mouse) drags the thumb, in BOTH playback states plus
 * the realistic desktop drag conditions (grab at the half-clipped 0% position,
 * fast fling, overshoot past the axis, vertical drift off the thumb, instant
 * re-grab, and a post-release snap-back watch).
 *
 * Loads the REAL dist artifact (spawn tools/serve.mjs, load
 * tests/fixtures/detectable.mp4, analyze — the persistent profile caches the
 * models per origin/profile — and draw a manual box so a full-span chip
 * exists), instruments the thumb (pointer event trace, capture success, video
 * seek/seeked events, style-writes observer) and asserts:
 *
 *   M0  mouse CLICK at the axis's 25% parks the playhead there (pointerup
 *       seek guard — the baseline every drag is measured from).
 *   M1  PAUSED: mouse.down on the thumb center → 6 move steps to the axis's
 *       50% → up. Assert currentTime followed mid-drag (t advanced past the
 *       grab point AND thumb cx advanced) AND landed at 0.5·dur at release,
 *       AND the thumb never snapped BACK after release (a stale frame must
 *       not yank the handle off the release point while the seek completes).
 *   M1b grab at 0% (fresh-load position: the disc is half-clipped by
 *       #timeline-track's overflow:hidden) → drag to 50%.
 *   M1c FAST FLING: two ~10 ms-apart moves 25% → 90% (the pointer outruns
 *       the thumb — dead without pointer capture).
 *   M1d OVERSHOOT: drag past the axis's right edge (120%) → clamps to dur.
 *   M1e VERTICAL DRIFT: same drag but the pointer slides 30 px below the
 *       strip mid-drag (the capture sentinel: moves must keep arriving).
 *   M1f RE-GRAB: two drags back-to-back with no settle between (drag-state
 *       residue would freeze the second gesture).
 *   M2  PLAYING (the field reporter likely drags while playing): same drag
 *       while playback runs; video paused immediately after release. Assert
 *       the same mid-drag follow + release position (± playback epsilon).
 *   M3  v1.8.0 mute button: #mute-button and #ov-mute both toggle
 *       video.muted (NOT volume), glyphs + aria-pressed stay in sync, an
 *       EXTERNAL mute flip is mirrored by the volumechange wiring, and
 *       clearAll resets to unmuted.
 *
 * BROWSER=chromium|firefox selects the engine (default chromium; the "PC
 * browser" is unknown, so firefox is the cross-check sentinel). Chromium
 * shares the touch probe's profile dir → warm model cache; firefox keeps its
 * own profile (storage formats differ) → first run downloads models.
 *
 * PASS = every check prints PASS. Run:
 *   node tools/debug-thumb-mouse.mjs
 *   BROWSER=firefox node tools/debug-thumb-mouse.mjs
 *   WITH_MUTE=1 node tools/debug-thumb-mouse.mjs   (M3 needs the v1.8.0 build)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium, firefox } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = (process.env.BROWSER || 'chromium').toLowerCase();
const WITH_MUTE = process.env.WITH_MUTE === '1'; // M3 needs the v1.8.0 build
const PORT = process.env.PROBE_PORT || 8199; // SAME origin as the other probes
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');
// Chromium SHARES the touch probe's profile (warm model cache); firefox gets
// its own (its storage format is incompatible with chromium's).
const PROFILE =
  BROWSER === 'firefox'
    ? join(ROOT, 'test-results', 'regression-probe-profile-ff')
    : join(ROOT, 'test-results', 'regression-probe-profile');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browserType = BROWSER === 'firefox' ? firefox : chromium;
/** @type {Record<string, unknown>} desktop mouse context — NO touch */
const ctxOpts = { viewport: { width: 1280, height: 800 } };
if (BROWSER === 'firefox') {
  // Allow (un)muted autoplay for the PLAYING drag scenario.
  ctxOpts.firefoxUserPrefs = { 'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0 };
} else {
  ctxOpts.args = ['--autoplay-policy=no-user-gesture-required'];
}
const browser = await browserType.launchPersistentContext(PROFILE, ctxOpts);
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

// --- Thumb instrumentation (attach once) -------------------------------------
// __evt: chronological pointer/seek trace; __cap: capture bookkeeping;
// __styleWrites: every thumb style.left write with the value + timestamp (a
// drag should OWN the position — non-drag writes while thumbDrag is live are
// exactly the "something stomps the thumb" failure mode).
const instrument = () =>
  page.evaluate(() => {
    if (window.__mouseInstr) return;
    window.__mouseInstr = true;
    const reset = () => {
      window.__evt = [];
      window.__cap = { got: 0, lost: 0 };
      window.__styleWrites = [];
    };
    reset();
    window.__mouseReset = reset;
    const thumb = document.getElementById('timeline-thumb');
    const video = document.getElementById('preview-video');
    const tag = (ev, extra) =>
      window.__evt.push({ ev, x: extra?.x, pid: extra?.pid, t: extra?.t, at: performance.now() });
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
      thumb.addEventListener(type, (e) => tag(type, { x: Math.round(e.clientX), pid: e.pointerId }), true);
    }
    thumb.addEventListener('gotpointercapture', () => { window.__cap.got += 1; });
    thumb.addEventListener('lostpointercapture', () => { window.__cap.lost += 1; });
    video.addEventListener('seek', () => tag('video-seek', { t: video.currentTime }));
    video.addEventListener('seeked', () => tag('video-seeked', { t: video.currentTime }));
    new MutationObserver(() => {
      window.__styleWrites.push({ left: thumb.style.left, at: performance.now() });
    }).observe(thumb, { attributes: true, attributeFilter: ['style'] });
  });
const resetInstr = () => page.evaluate(() => window.__mouseReset());
const traceTail = () =>
  page.evaluate(() => ({
    evt: window.__evt.slice(-14),
    cap: window.__cap,
    styleWrites: window.__styleWrites.length,
    lastStyle: window.__styleWrites.slice(-3),
  }));

/** Reset the video to a paused t=0 baseline and settle. */
const toZero = () =>
  page.evaluate(() => {
    const v = document.getElementById('preview-video');
    v.pause();
    v.currentTime = 0;
  });

const readState = () =>
  page.evaluate(() => {
    const v = document.getElementById('preview-video');
    const th = document.getElementById('timeline-thumb');
    const axis = document.getElementById('timeline-track').getBoundingClientRect();
    const b = th.getBoundingClientRect();
    return {
      t: v.currentTime,
      playing: !v.paused,
      thumbCx: b.left + b.width / 2,
      thumbCy: b.top + b.height / 2,
      axisLeft: axis.left,
      axisW: axis.width,
    };
  });

/** Reset to paused t=0, park the playhead at `frac` of the axis, settle. */
async function parkAt(frac) {
  await toZero();
  await page.waitForTimeout(250);
  const s = await readState();
  await page.mouse.click(s.axisLeft + s.axisW * frac, s.thumbCy);
  await page.waitForTimeout(400);
  return readState();
}

/**
 * The shared mouse drag: down on (x0,y), moves toward (x1,endY), up.
 * `steps` moves `holdMs` apart; samples the mid-drag state after the
 * `sampleStep`-th move. Returns { mid, release: [state@+60ms, state@+250ms] }
 * — the release samples expose a snap-back (a stale frame yanking the thumb
 * off the release point while the endpoint seek completes).
 */
async function mouseDrag(x0, y, x1, { steps = 6, holdMs = 70, sampleStep = 3, endY = null } = {}) {
  const y1 = endY == null ? y : endY;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  let mid = null;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y + ((y1 - y) * i) / steps, { steps: 1 });
    if (holdMs > 0) await page.waitForTimeout(holdMs);
    if (i === sampleStep) mid = await readState();
  }
  await page.mouse.up();
  const release = [];
  for (const delay of [60, 250]) {
    await page.waitForTimeout(delay);
    release.push(await readState());
  }
  return { mid, release };
}

/** Thumb never moves BACKWARD past the release x by more than `slack` px. */
const noSnapBack = (releaseX, release, slack = 8) =>
  release.every((s) => s.thumbCx > releaseX - slack);

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  // ---- load + analyze (real models; the persistent profile caches them) ----
  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });
  console.log(`--- file ready; analyzing (${BROWSER}; downloads models on first run) ---`);
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
  await page.evaluate(() => {
    document.getElementById('timeline').scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(300);
  console.log('--- review ready (manual full-span chip drawn); mouse context armed ---');

  await instrument();

  const dur = await page.evaluate(() => {
    const v = document.getElementById('preview-video');
    return Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
  });
  if (!(dur > 0)) throw new Error(`video duration not usable: ${dur}`);

  // ======================================================================
  // M0 — mouse click at the axis's 25% parks the playhead (baseline)
  // ======================================================================
  console.log('--- M0: mouse click at axis 25% (park baseline) ---');
  await toZero();
  await page.waitForTimeout(250);
  let st = await readState();
  await page.mouse.click(st.axisLeft + st.axisW * 0.25, st.thumbCy);
  await page.waitForTimeout(400);
  st = await readState();
  check(
    'M0 mouse click at axis 25% parks the playhead',
    Math.abs(st.t - 0.25 * dur) < 0.15 &&
      Math.abs(st.thumbCx - (st.axisLeft + st.axisW * 0.25)) < 8,
    `t=${st.t.toFixed(3)} expected ${(0.25 * dur).toFixed(3)} thumbCx=${st.thumbCx.toFixed(1)}`,
  );

  // ======================================================================
  // M1 — PAUSED mouse drag of the thumb 25% → 50% (+ snap-back watch)
  // ======================================================================
  console.log('--- M1: PAUSED mouse drag of #timeline-thumb 25% → 50% ---');
  st = await parkAt(0.25);
  const grabCx = st.thumbCx;
  const grabT = st.t;
  await resetInstr();
  const targetX = st.axisLeft + st.axisW * 0.5;
  const drag1 = await mouseDrag(grabCx, st.thumbCy, targetX, { steps: 6, sampleStep: 3 });
  await page.waitForTimeout(250);
  const end1 = await readState();
  const mid1 = drag1.mid;
  const followed1 =
    !!mid1 &&
    mid1.t > grabT + 0.05 * dur &&
    mid1.thumbCx > grabCx + 4 &&
    Math.abs(mid1.thumbCx - (st.axisLeft + st.axisW * (mid1.t / dur))) < 60;
  const landed1 = Math.abs(end1.t - 0.5 * dur) < 0.15;
  const stable1 = noSnapBack(targetX, drag1.release);
  check(
    'M1 PAUSED mouse drag 25%→50% seeks (followed mid-drag + at release, no snap-back)',
    followed1 && landed1 && stable1,
    `mid={t=${mid1 ? mid1.t.toFixed(3) : 'n/a'}, thumbCx=${mid1 ? mid1.thumbCx.toFixed(0) : 'n/a'}} ` +
      `end t=${end1.t.toFixed(3)} expected ${(0.5 * dur).toFixed(3)} ` +
      `releaseCx=[${drag1.release.map((s) => s.thumbCx.toFixed(0)).join(',')}] want>=${targetX.toFixed(0)}`,
  );
  if (!(followed1 && landed1 && stable1)) {
    const tr = await traceTail();
    console.log('  [trace]', JSON.stringify(tr).slice(0, 1200));
  }

  // ======================================================================
  // M1b — grab at 0%: the fresh-load position. The disc is HALF-CLIPPED by
  // #timeline-track's overflow:hidden (translate(-50%) puts its left half
  // outside the strip). A real user grabs the visible right half.
  // ======================================================================
  console.log('--- M1b: grab at 0% (half-clipped thumb) → drag to 50% ---');
  st = await parkAt(0);
  const grabB = st.thumbCx; // thumb center == axis left edge at 0%
  await resetInstr();
  const targetB = st.axisLeft + st.axisW * 0.5;
  // Grab the VISIBLE half (center of the clipped 10px-wide visible disc).
  const dragB = await mouseDrag(grabB + 5, st.thumbCy, targetB, { steps: 5, sampleStep: 3 });
  await page.waitForTimeout(250);
  const endB = await readState();
  const okB =
    !!dragB.mid &&
    dragB.mid.thumbCx > grabB + 4 &&
    Math.abs(endB.t - 0.5 * dur) < 0.15 &&
    noSnapBack(targetB, dragB.release);
  check(
    'M1b grab at 0% (half-clipped) drags to 50%',
    okB,
    `end t=${endB.t.toFixed(3)} expected ${(0.5 * dur).toFixed(3)} ` +
      `midCx=${dragB.mid ? dragB.mid.thumbCx.toFixed(0) : 'n/a'}`,
  );
  if (!okB) {
    const tr = await traceTail();
    console.log('  [trace]', JSON.stringify(tr).slice(0, 1200));
  }

  // ======================================================================
  // M1c — FAST FLING: two ~10 ms-apart moves 25% → 90%. The pointer outruns
  // the 20px thumb instantly; without pointer capture the drag dies mid-fling.
  // ======================================================================
  console.log('--- M1c: fast fling 25% → 90% (capture sentinel) ---');
  st = await parkAt(0.25);
  await resetInstr();
  const targetC = st.axisLeft + st.axisW * 0.9;
  const dragC = await mouseDrag(st.thumbCx, st.thumbCy, targetC, {
    steps: 2, holdMs: 10, sampleStep: 0,
  });
  await page.waitForTimeout(300);
  const endC = await readState();
  const okC =
    Math.abs(endC.t - 0.9 * dur) < 0.15 && noSnapBack(targetC, dragC.release);
  check(
    'M1c fast fling 25%→90% lands at 0.9·dur',
    okC,
    `end t=${endC.t.toFixed(3)} expected ${(0.9 * dur).toFixed(3)} ` +
      `releaseCx=[${dragC.release.map((s) => s.thumbCx.toFixed(0)).join(',')}] want>=${targetC.toFixed(0)}`,
  );
  if (!okC) {
    const tr = await traceTail();
    console.log('  [trace]', JSON.stringify(tr).slice(0, 1200));
  }

  // ======================================================================
  // M1d — OVERSHOOT: drag to 120% of the axis (past the right edge) → clamps.
  // ======================================================================
  console.log('--- M1d: overshoot drag past the right edge clamps to end ---');
  st = await parkAt(0.25);
  await resetInstr();
  const targetD = st.axisLeft + st.axisW * 1.2;
  await mouseDrag(st.thumbCx, st.thumbCy, targetD, { steps: 4, sampleStep: 0 });
  await page.waitForTimeout(300);
  const endD = await readState();
  const okD = Math.abs(endD.t - dur) < 0.15;
  check(
    'M1d overshoot past the right edge clamps to duration',
    okD,
    `end t=${endD.t.toFixed(3)} expected ~${dur.toFixed(3)}`,
  );

  // ======================================================================
  // M1e — VERTICAL DRIFT: drag to 50% while the pointer slides 30 px BELOW
  // the strip. Moves must keep arriving (pointer capture), or the drag dies
  // the moment the cursor leaves the thumb — the classic PC symptom.
  // ======================================================================
  console.log('--- M1e: vertical drift 30px below the strip (capture sentinel) ---');
  st = await parkAt(0.25);
  await resetInstr();
  const targetE = st.axisLeft + st.axisW * 0.5;
  const dragE = await mouseDrag(st.thumbCx, st.thumbCy, targetE, {
    steps: 5, sampleStep: 2, endY: st.thumbCy + 30,
  });
  await page.waitForTimeout(300);
  const endE = await readState();
  const okE =
    Math.abs(endE.t - 0.5 * dur) < 0.15 &&
    !!dragE.mid &&
    dragE.mid.thumbCx > st.thumbCx + 4 &&
    noSnapBack(targetE, dragE.release);
  check(
    'M1e drag with 30px vertical drift off the thumb still scrubs',
    okE,
    `end t=${endE.t.toFixed(3)} expected ${(0.5 * dur).toFixed(3)} ` +
      `midCx=${dragE.mid ? dragE.mid.thumbCx.toFixed(0) : 'n/a'} grabCx=${st.thumbCx.toFixed(0)}`,
  );
  if (!okE) {
    const tr = await traceTail();
    console.log('  [trace]', JSON.stringify(tr).slice(0, 1400));
  }

  // ======================================================================
  // M1f — RE-GRAB: two drags back-to-back, no settle between. Drag-state
  // residue (thumbDrag not reset, capture not re-acquirable) freezes drag 2.
  // ======================================================================
  console.log('--- M1f: immediate re-grab (25%→40%, then 40%→60%) ---');
  st = await parkAt(0.25);
  await resetInstr();
  const x40 = st.axisLeft + st.axisW * 0.4;
  const x60 = st.axisLeft + st.axisW * 0.6;
  await page.mouse.move(st.thumbCx, st.thumbCy);
  await page.mouse.down();
  await page.mouse.move(x40, st.thumbCy, { steps: 4 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  // Re-grab immediately at the thumb's NEW position (no settle).
  const regrab = await readState();
  await page.mouse.move(regrab.thumbCx, regrab.thumbCy);
  await page.mouse.down();
  await page.mouse.move(x60, regrab.thumbCy, { steps: 4 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const endF = await readState();
  const okF = Math.abs(endF.t - 0.6 * dur) < 0.15;
  check(
    'M1f immediate re-grab completes the second drag',
    okF,
    `end t=${endF.t.toFixed(3)} expected ${(0.6 * dur).toFixed(3)}`,
  );
  if (!okF) {
    const tr = await traceTail();
    console.log('  [trace]', JSON.stringify(tr).slice(0, 1200));
  }

  // ======================================================================
  // M2 — PLAYING mouse drag of the thumb (drag while playback runs)
  // ======================================================================
  console.log('--- M2: PLAYING mouse drag of #timeline-thumb 25% → 50% ---');
  st = await parkAt(0.25);
  await page.evaluate(() => document.getElementById('preview-video').play());
  await page.waitForTimeout(300);
  st = await readState();
  const playingOk = st.playing;
  const grab2Cx = st.thumbCx;
  const grab2T = st.t;
  await resetInstr();
  const target2X = st.axisLeft + st.axisW * 0.5;
  const drag2 = await mouseDrag(grab2Cx, st.thumbCy, target2X, { steps: 6, sampleStep: 3 });
  // Pause IMMEDIATELY after release so playback stops advancing the clock.
  await page.evaluate(() => document.getElementById('preview-video').pause());
  await page.waitForTimeout(250);
  const end2 = await readState();
  const mid2 = drag2.mid;
  // Playback between release and the pause can advance the clock a little;
  // allow a generous epsilon (never more than a fraction of the drag span).
  const eps = Math.max(0.3, 0.05 * dur);
  const followed2 =
    !!mid2 && mid2.thumbCx > grab2Cx + 4 && mid2.t > grab2T + 0.03 * dur;
  const landed2 = Math.abs(end2.t - 0.5 * dur) < 0.15 + eps;
  const stable2 = noSnapBack(target2X, drag2.release);
  check(
    'M2 was actually PLAYING during the drag',
    playingOk,
    `playing=${playingOk} grab t=${grab2T.toFixed(3)}`,
  );
  check(
    'M2 PLAYING mouse drag 25%→50% seeks (followed mid-drag + at release, no snap-back)',
    followed2 && landed2 && stable2,
    `mid={t=${mid2 ? mid2.t.toFixed(3) : 'n/a'}, thumbCx=${mid2 ? mid2.thumbCx.toFixed(0) : 'n/a'}} ` +
      `end t=${end2.t.toFixed(3)} expected ${(0.5 * dur).toFixed(3)} (±${eps.toFixed(2)}) ` +
      `releaseCx=[${drag2.release.map((s) => s.thumbCx.toFixed(0)).join(',')}]`,
  );
  if (!(followed2 && landed2 && stable2)) {
    const tr = await traceTail();
    console.log('  [trace]', JSON.stringify(tr).slice(0, 1200));
  } else {
    const tr = await traceTail();
    console.log(
      `  [trace] events=${JSON.stringify(tr.evt.length)} capture={got=${tr.cap.got},lost=${tr.cap.lost}} styleWrites=${tr.styleWrites}`,
    );
  }

  // ======================================================================
  // M3 — mute buttons (v1.8.0): transport bar + fullscreen overlay bar
  // ======================================================================
  if (!WITH_MUTE) {
    console.log('--- M3: skipped (WITH_MUTE=1 runs it against the v1.8.0 build) ---');
  } else {
  console.log('--- M3: mute toggle on both bars ---');
  const muteDefs = await page.evaluate(() => ({
    transport: !!document.getElementById('mute-button'),
    overlay: !!document.getElementById('ov-mute'),
  }));
  check('M3a #mute-button and #ov-mute exist', muteDefs.transport && muteDefs.overlay, JSON.stringify(muteDefs));
  if (muteDefs.transport && muteDefs.overlay) {
    // Click #mute-button → muted, 🔇 glyph, aria-pressed=true, on BOTH buttons.
    await page.click('#mute-button');
    await page.waitForTimeout(150);
    const afterOn = await page.evaluate(() => {
      const v = document.getElementById('preview-video');
      const g = (id) => document.getElementById(id)?.textContent;
      return {
        muted: v.muted,
        volume: v.volume,
        tGlyph: g('mute-button'),
        oGlyph: g('ov-mute'),
        tPressed: document.getElementById('mute-button')?.getAttribute('aria-pressed'),
        oPressed: document.getElementById('ov-mute')?.getAttribute('aria-pressed'),
      };
    });
    check(
      'M3b #mute-button click mutes (muted=true, volume untouched) + glyphs/aria on both bars',
      afterOn.muted === true &&
        Math.abs(afterOn.volume - 1) < 1e-6 &&
        afterOn.tGlyph === '🔇' &&
        afterOn.oGlyph === '🔇' &&
        afterOn.tPressed === 'true' &&
        afterOn.oPressed === 'true',
      JSON.stringify(afterOn),
    );
    // Click again → unmuted.
    await page.click('#mute-button');
    await page.waitForTimeout(150);
    const afterOff = await page.evaluate(() => {
      const v = document.getElementById('preview-video');
      const g = (id) => document.getElementById(id)?.textContent;
      return { muted: v.muted, tGlyph: g('mute-button'), oGlyph: g('ov-mute') };
    });
    check(
      'M3c second click unmutes + 🔊 glyphs on both bars',
      afterOff.muted === false && afterOff.tGlyph === '🔊' && afterOff.oGlyph === '🔊',
      JSON.stringify(afterOff),
    );
    // EXTERNAL mute flip (e.g. browser media control) mirrors via volumechange.
    await page.evaluate(() => {
      document.getElementById('preview-video').muted = true;
    });
    await page.waitForTimeout(150);
    const afterExt = await page.evaluate(() => ({
      tGlyph: document.getElementById('mute-button')?.textContent,
      oGlyph: document.getElementById('ov-mute')?.textContent,
    }));
    check(
      'M3d external muted flip mirrors into both buttons (volumechange)',
      afterExt.tGlyph === '🔇' && afterExt.oGlyph === '🔇',
      JSON.stringify(afterExt),
    );
    await page.evaluate(() => {
      document.getElementById('preview-video').muted = false;
    });
    // clearAll resets to unmuted (the teardown checklist item).
    await page.click('#mute-button'); // mute again before clear
    await page.waitForTimeout(100);
    await page.click('#clear-file');
    await page.waitForTimeout(400);
    const afterClear = await page.evaluate(() => ({
      muted: document.getElementById('preview-video').muted,
      tGlyph: document.getElementById('mute-button')?.textContent,
    }));
    check(
      'M3e clearAll resets mute state (unmuted, 🔊)',
      afterClear.muted === false && afterClear.tGlyph === '🔊',
      JSON.stringify(afterClear),
    );
  } // end if muteDefs
  } // end WITH_MUTE
} finally {
  await browser.close();
  server.kill();
}
console.log(failures === 0 ? 'SUMMARY: PASS' : `SUMMARY: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
