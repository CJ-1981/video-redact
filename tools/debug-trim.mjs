#!/usr/bin/env node
/**
 * debug-trim.mjs — REQ-110 acceptance probe: chip-edge trim drag must update
 * the chip's rendered length LIVE (each pointermove) and the track-list span
 * text with it.
 *
 * Pattern: tools/debug-export.mjs — spawns tools/serve.mjs, opens dist/index.html
 * with console/pageerror capture, loads tests/fixtures/detectable.mp4, analyzes,
 * locates the widest chip in #track-chips, pointer-drags one of its edges and
 * measures the chip's rendered width before / mid / after the drag, plus the
 * track-list row span text.
 *
 * PASS = chip width changes ≥ 20 px mid-drag AND the row span text updates.
 * Run: node tools/debug-trim.mjs   (kills the spawned server on exit)
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PROBE_PORT || 8191;
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'detectable.mp4');

const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs')], {
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (!t.includes('[vfc]')) console.log(`[console.${m.type()}]`, t.slice(0, 300));
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

/** Chip geometry + row span text for one track id (or the widest chip). */
async function measure(trackId) {
  return page.evaluate((id) => {
    const container = document.querySelector('#track-chips');
    const cRect = container.getBoundingClientRect();
    let chip = id
      ? /** @type {HTMLElement | null} */ (
          container.querySelector(`div[data-track-id="${id}"]`)
        )
      : null;
    if (!chip) {
      let best = null;
      for (const el of container.querySelectorAll('div[data-track-id]')) {
        const elH = /** @type {HTMLElement} */ (el);
        if (
          !best ||
          elH.getBoundingClientRect().width >
            /** @type {HTMLElement} */ (best).getBoundingClientRect().width
        ) {
          best = elH;
        }
      }
      chip = best;
    }
    if (!chip) return null;
    const r = chip.getBoundingClientRect();
    const row = document.querySelector(
      `#track-list .track-row[data-track-id="${chip.dataset.trackId}"] .span`,
    );
    return {
      trackId: chip.dataset.trackId,
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      containerWidth: cRect.width,
      containerLeft: cRect.left,
      spanText: row ? row.textContent : null,
      title: chip.title,
    };
  }, trackId ?? null);
}

try {
  await page.goto(`http://127.0.0.1:${PORT}/dist/index.html`, { waitUntil: 'load' });
  await page.waitForSelector('#serve-gate', { state: 'hidden' });

  if (process.env.TRIM_DIAG) {
    // Capture-phase pointer-event log + setPointerCapture wrap (root-cause
    // diagnostics for the trim gesture; off by default).
    await page.evaluate(() => {
      const w = /** @type {any} */ (window);
      w.__ptrLog = [];
      const log = (m) => w.__ptrLog.push(m);
      for (const sel of ['#timeline', '#timeline-track', '#track-chips']) {
        const el = document.querySelector(sel);
        if (!el) { log(`MISSING ${sel}`); continue; }
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) {
          el.addEventListener(type, (e) => {
            if (type === 'pointermove' && w.__ptrLog.length > 40) return;
            const ev = /** @type {PointerEvent} */ (e);
            const t = /** @type {Element} */ (ev.target);
            log(`${sel} ${type} target=${t.id || t.tagName} x=${ev.clientX.toFixed(0)} btn=${ev.button} def=${ev.defaultPrevented}`);
          }, true);
        }
      }
      const proto = /** @type {any} */ (Element).prototype;
      const orig = proto.setPointerCapture;
      if (orig && !orig.__wrapped) {
        proto.setPointerCapture = function (id) {
          log(`setPointerCapture(${id}) on ${this.id || this.tagName}`);
          try { return orig.call(this, id); } catch (err) { log(`setPointerCapture THREW: ${err.message}`); throw err; }
        };
        proto.setPointerCapture.__wrapped = true;
      }
    });
  }

  await page.setInputFiles('#file-input', FIXTURE);
  await page.waitForSelector('#analyze-button:not([disabled])', { timeout: 30000 });
  console.log('--- ready; starting analyze ---');
  await page.click('#analyze-button');
  await page.waitForSelector('#stepper li#step-review[aria-current="step"]', {
    timeout: 300000,
  });
  console.log('--- review reached ---');

  /** One chip-edge drag: grab at |offset| px relative to the chip's end
   * edge (negative = inward, 0 = exactly ON the edge, positive = outward),
   * drag dx px in the shrink/grow direction, sampling width mid-drag. */
  async function dragEdge(offsetPx) {
    const before = await measure();
    if (!before) throw new Error('no chip rendered after analyze');
    const id = before.trackId;
    const edgeX = Math.round(before.left + before.width);
    const y = Math.round(before.top + before.height / 2);
    const grow = before.containerLeft + before.containerWidth - edgeX > 30;
    const dx = grow ? 90 : -90;
    const grabX = offsetPx <= 0
      ? Math.max(before.containerLeft + 1, edgeX + offsetPx) // inward / ON edge
      : edgeX + offsetPx; // outward (strip padding side)
    console.log(`--- drag: grab at x=${grabX} (${offsetPx === 0 ? 'ON' : offsetPx > 0 ? `${offsetPx}px outside` : `${-offsetPx}px inside`} end edge at ${edgeX}), ${grow ? 'grow' : 'shrink'} by ${Math.abs(dx)}px`);
    await page.mouse.move(grabX, y, { steps: 2 });
    await page.mouse.down();
    await page.mouse.move(grabX + dx / 3, y, { steps: 3 });
    const mid1 = await measure(id);
    console.log('    MID 1/3:', JSON.stringify(mid1));
    await page.mouse.move(grabX + dx, y, { steps: 3 });
    const mid2 = await measure(id);
    console.log('    MID 2/3:', JSON.stringify(mid2));
    await page.mouse.up();
    const after = await measure(id);
    console.log('    AFTER:', JSON.stringify(after));
    const deltaMid = Math.abs(Math.min(mid1.width, mid2.width) - before.width);
    const deltaAfter = Math.abs(after.width - before.width);
    const spanChanged = after.spanText !== before.spanText;
    return { deltaMid, deltaAfter, spanChanged, before, after };
  }

  let pass = true;

  // REQ-110 acceptance: grab exactly ON the end-edge boundary pixel — the
  // v1.1/v1.2 dead zone (the pointerdown hit-tested to #timeline there and
  // the gesture never started). Must move the chip LIVE now.
  const onEdge = await dragEdge(0);
  if (onEdge.deltaMid >= 20) {
    console.log(`ok: ON-edge grab — chip width changed mid-drag by ${onEdge.deltaMid.toFixed(1)}px`);
  } else {
    pass = false;
    console.log(`FAIL: ON-edge grab — width changed only ${onEdge.deltaMid.toFixed(1)}px mid-drag`);
  }
  if (onEdge.deltaAfter >= 20 && onEdge.spanChanged) {
    console.log(`ok: ON-edge grab — width changed ${onEdge.deltaAfter.toFixed(1)}px after drag; span text updated`);
  } else {
    pass = false;
    console.log(`FAIL: ON-edge grab after-drag (width Δ=${onEdge.deltaAfter.toFixed(1)}, span changed=${onEdge.spanChanged})`);
  }

  // Outward grab: 4px past the (new) end edge, in the strip padding — must
  // still start the trim (hitTestTimeline outward zones).
  const outside = await dragEdge(4);
  if (outside.deltaMid >= 20 && outside.spanChanged) {
    console.log(`ok: outward grab — width changed mid-drag by ${outside.deltaMid.toFixed(1)}px, span text updated`);
  } else {
    pass = false;
    console.log(`FAIL: outward grab (width Δ mid=${outside.deltaMid.toFixed(1)}, span changed=${outside.spanChanged})`);
  }

  // REQ-108 smoke: the row's end-time input commits through the trim path.
  // Pick a valid target deterministically: parse the video duration and the
  // current end from the readouts, then aim for 1s (or 2s when the end is
  // already below 1.5s) — always inside the duration, always a real change.
  const afterInputs = await measure();
  const trackId = afterInputs.trackId;
  const inputSel = `#track-list .track-row[data-track-id="${trackId}"] input.span-input[data-role="end"]`;
  const toSec = (clock) => {
    const m = /(\d+):(\d+(?:\.\d+)?)/.exec(clock);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  const durationText = await page.textContent('#timeline-duration');
  const durationSec = toSec(durationText ?? '');
  const endSec = toSec((afterInputs.spanText ?? '').split('–')[1] ?? '');
  const targetSec = endSec > 1.5 ? 1 : Math.min(2, Math.max(0, durationSec - 0.5));
  await page.fill(inputSel, ''); // clear, then type a clock value
  await page.type(inputSel, `${Math.floor(targetSec / 60)}:${(targetSec % 60).toFixed(1)}`);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const afterInput = await measure(trackId);
  const inputChanged = afterInput.width !== afterInputs.width &&
    afterInput.spanText !== afterInputs.spanText;
  if (inputChanged) {
    console.log(`ok: span input commit — span "${afterInputs.spanText}" → "${afterInput.spanText}", width ${afterInputs.width.toFixed(0)} → ${afterInput.width.toFixed(0)}px`);
  } else {
    pass = false;
    console.log(`FAIL: span input commit did not update the chip/readout`);
  }

  console.log(pass ? '=== PROBE PASS ===' : '=== PROBE FAIL ===');
  process.exitCode = pass ? 0 : 1;
  await page.waitForTimeout(800);
} finally {
  await browser.close();
  server.kill();
}
