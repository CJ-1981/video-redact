/**
 * editor.js — REQ-012/013/014/015 (design.md §3, §4.7). @MX:ANCHOR
 * (preview burns through the SAME redact.pixelateFrame the export burn-in
 * uses — pixel-truthful preview, REQ-016 / AC-04).
 *
 * Review-editor module, split in two halves:
 *
 *   1. PURE timeline model functions (fully unit-tested in
 *      tests/unit/timeline.test.js — no DOM, run in the node environment):
 *        renderTimeline()      → chips view model + playhead percentage
 *        hitTestTimeline()     → { track } | null for a timeline point
 *        toggleTrack()         → immutable enabled-flip (REQ-014)
 *        tracksAtForView()     → thin wrapper over redact.tracksAt
 *        manualTrackFromBox()  → manual Track factory (REQ-015)
 *
 *   2. Thin DOM adapters (guarded, NOT unit-tested — node has no DOM):
 *        mountEditor()    → wire playback/overlay sync + timeline events
 *        beginManualBox() → pointer-drag rectangle on the overlay canvas
 *
 * The editor NEVER owns AppState: it reads via `hooks.getState()` and emits
 * mutations via `hooks.onToggle / onSeek / onManualBox` (main.js's stepper
 * state machine persists them).
 *
 * ---------------------------------------------------------------------------
 * INTERACTION MAP (review step; design-direction "signature element")
 * ---------------------------------------------------------------------------
 *
 *   Timeline (#timeline strip, single-lane chips):
 *     click            → onSeek(time under pointer)      — chip or bare rail
 *     dblclick on chip → hitTestTimeline → onToggle(id, !enabled)
 *                        (the two preceding clicks also seek — harmless)
 *
 *   Track list (#track-list rows, rendered by the editor):
 *     checkbox change  → onToggle(trackId, checked)
 *     row click        → onSeek(track.start clamped)     — checkbox excluded
 *
 *   Preview stage (manual region, REQ-015 — keyboard "B" is wired by main.js,
 *   which then calls beginManualBox or routes into onManualBox on commit):
 *     drag on #overlay-canvas → rubber band → onManualBox(box, t)
 *                             (box in native display px; t = video.currentTime)
 *     Escape           → cancel the in-progress drag
 *
 *   Playback sync: one loop via requestVideoFrameCallback (rAF fallback):
 *     per presented frame → draw the video frame into the overlay canvas,
 *     pixelateFrame (the shared export burn-in seam) for every enabled
 *     tracksAt hit, drawOverlay for ALL tracks (enabled solid strokes +
 *     disabled dashed "visible"), then move the playhead. Scrub → 'seeked'
 *     event redraws once.
 *
 * IMPORT-TIME SAFETY: no DOM access at import time (vitest imports this file
 * in the node environment). Every DOM access inside the adapters is guarded —
 * mountEditor(null, null) and beginManualBox(null, null) are no-ops.
 */
import './types.js';
import { tracksAt, pixelateFrame, drawOverlay } from './redact.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum redacted span for a manually drawn region, seconds. A quick drag
 * still yields a meaningful, editable span (the caller can extend it).
 * @type {number}
 */
export const MIN_MANUAL_SPAN_S = 0.5;

/** Manual regions render alert red everywhere (design-direction.md). */
const ALERT_RED = '#E5484D';
/** "Keep visible" chips (design-direction.md safe green). */
const SAFE_GREEN = '#3ECF8E';
/** Drags smaller than this (canvas px) are clicks, not boxes. */
const MIN_DRAG_PX = 2;

// ---------------------------------------------------------------------------
// PURE: renderTimeline — chips view model + playhead (REQ-013, AC-18)
// ---------------------------------------------------------------------------

/**
 * Compute the timeline view model: one chip per track spanning its redacted
 * range as percentages of `durationSec`, plus the playhead percentage.
 * PURE — no DOM, no mutation; the caller maps chips onto #track-chips.
 *
 * Chips keep the track's categorical `color` even when disabled; renderers
 * use `enabled === false` to apply the safe-green/dimmed state instead
 * (design-direction.md: safe green = keep visible).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} durationSec Video duration (> 0; 0/NaN → everything at 0%).
 * @param {number} currentTimeSec Playhead position (clamped to [0, duration]).
 * @returns {{chips: Array<{track: import('./types.js').Track,
 *                            startPct: number, endPct: number,
 *                            color: string, enabled: boolean}>,
 *            playheadPct: number}}
 *     Chip spans are clamped to [0, durationSec]; zero/negative duration puts
 *     every percentage at 0 (never NaN/Infinity).
 */
export function renderTimeline(tracks, durationSec, currentTimeSec) {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0;
  /** Clamp a seconds value into [0, dur] and express it as a percentage. */
  const pct = (sec) => {
    if (dur <= 0 || !Number.isFinite(sec)) return 0;
    const clamped = Math.min(Math.max(sec, 0), dur);
    return (clamped / dur) * 100;
  };
  const chips = (Array.isArray(tracks) ? tracks : []).map((track) => ({
    track,
    startPct: pct(track.start),
    endPct: pct(track.end),
    color: track.color,
    enabled: track.enabled,
  }));
  return { chips, playheadPct: pct(currentTimeSec) };
}

// ---------------------------------------------------------------------------
// PURE: hitTestTimeline — chip under a timeline point (REQ-013, AC-18)
// ---------------------------------------------------------------------------

/**
 * Hit-test a timeline pointer position against track chips: x → time → the
 * track whose (clamped) redacted span contains it. `y` is accepted for
 * call-site symmetry but unused — the v1 timeline is single-lane.
 *
 * Overlap rule: the SMALLEST span wins ("topmost" for precise selection —
 * a short chip crossing a long one is picked inside the crossing). Exact
 * ties resolve to the earlier track in array order. Span edges are inclusive
 * (mirrors redact.tracksAt).
 *
 * @param {number} x Pointer x within the strip, CSS px.
 * @param {number} y Pointer y within the strip (unused, single lane).
 * @param {number} width Strip width, CSS px (same space as `x`).
 * @param {import('./types.js').Track[]} tracks
 * @param {number} durationSec Video duration (> 0).
 * @returns {{track: import('./types.js').Track} | null}
 */
export function hitTestTimeline(x, y, width, tracks, durationSec) {
  void y;
  if (!(width > 0) || !(durationSec > 0)) return null;
  const t = (x / width) * durationSec;
  let best = null;
  let bestSpan = Infinity;
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const start = Math.max(0, track.start); // clamp to the rendered window
    const end = Math.min(durationSec, track.end);
    if (t < start || t > end) continue;
    const span = end - start;
    if (span < bestSpan) {
      bestSpan = span;
      best = track;
    }
  }
  return best ? { track: best } : null;
}

// ---------------------------------------------------------------------------
// PURE: toggleTrack — immutable enabled flip (REQ-014, AC-06)
// ---------------------------------------------------------------------------

/**
 * Set one track's enabled flag and return a NEW array (input never mutated;
 * only the target track object is copied). The caller persists the result via
 * its state owner. Toggling OFF removes the track from redact.tracksAt output
 * everywhere — preview AND export (REQ-014).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} trackId
 * @param {boolean} enabled
 * @returns {import('./types.js').Track[]} New array; unknown id → unchanged
 *     content (still a new array).
 */
export function toggleTrack(tracks, trackId, enabled) {
  return (Array.isArray(tracks) ? tracks : []).map((track) =>
    track.id === trackId ? { ...track, enabled } : track,
  );
}

// ---------------------------------------------------------------------------
// PURE: tracksAtForView — view-side lookup (REQ-012/016 seam)
// ---------------------------------------------------------------------------

/**
 * Thin wrapper over redact.tracksAt for the preview path. Kept as a named
 * export so the DOM adapter and main.js ask ONE question with ONE answer.
 * The density-invariant throw propagates UNCHANGED — an enabled track
 * covering t with zero keyframes is a tracker bug and must fail loudly,
 * never render an unredacted frame (design §2 invariant).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} t Seconds.
 * @returns {Array<{track: import('./types.js').Track, box: import('./types.js').Box}>}
 */
export function tracksAtForView(tracks, t) {
  return tracksAt(tracks, t);
}

// ---------------------------------------------------------------------------
// PURE: manualTrackFromBox — manual region factory (REQ-015, AC-07)
// ---------------------------------------------------------------------------

/**
 * Build a manual Track from a user-drawn box at time `t` (design §4.4:
 * manual tracks bypass the tracker — direct keyframes). PURE: the box is
 * copied, the caller's object is untouched.
 *
 * Divergence from tracker.beginManualTrack (intentional): that skeleton
 * assigns a palette slot and a zero-length span via the Tracker instance's
 * counters; this factory is standalone (main.js owns the id counter across
 * analyze runs), forces the design-direction ALERT RED for manual regions,
 * labels from the same counter, and materializes a usable minimum span
 * [t, t + MIN_MANUAL_SPAN_S] clamped to `durationSec` (end never < start).
 *
 * @param {number} trackIdCounter Id AND label number for the new track
 *     ("Manual #<trackIdCounter>"); caller increments its counter on accept.
 * @param {number} t Presentation time, seconds (the drawn frame).
 * @param {import('./types.js').Box} box Box in native display px.
 * @param {number} [durationSec] Video duration; clamps the span end when given.
 * @returns {import('./types.js').Track}
 */
export function manualTrackFromBox(trackIdCounter, t, box, durationSec) {
  const start = Number.isFinite(t) ? t : 0;
  let end = start + MIN_MANUAL_SPAN_S;
  if (Number.isFinite(durationSec) && durationSec > 0) {
    end = Math.min(end, durationSec);
  }
  end = Math.max(end, start); // never inverted, even for t beyond duration
  return {
    id: trackIdCounter,
    cls: 'manual',
    label: `Manual #${trackIdCounter}`,
    color: ALERT_RED,
    keyframes: new Map([[start, { ...box }]]),
    start,
    end,
    enabled: true,
    source: 'manual',
  };
}

// ---------------------------------------------------------------------------
// PURE: scaleTracksToCanvas — native-px boxes → preview-canvas px (AC-04)
// ---------------------------------------------------------------------------

/**
 * Copy tracks with every keyframe box uniformly scaled by `scale` (PURE —
 * the input objects and their Maps are never touched). redact.pixelateFrame
 * consumes tracks whose boxes live in the ctx's pixel space; preview boxes
 * are authored in native display px, so the shared burn-in seam runs against
 * this scaled copy. Uniform scaling COMMUTES with the seam: dilate grows a
 * box by a fraction of its own size and clamps it into `frameSize`, and
 * scaling boxes + frameSize by the same factor scales the clamped result
 * exactly — so canvas-px composition == scaled native-px composition and
 * preview pixels match export pixels (REQ-016 / AC-04).
 *
 * @param {import('./types.js').Track[]} tracks
 * @param {number} scale Canvas px per native px (> 0).
 * @returns {import('./types.js').Track[]} New track objects sharing
 *     everything but `keyframes` (new Map, new scaled boxes).
 */
export function scaleTracksToCanvas(tracks, scale) {
  return (Array.isArray(tracks) ? tracks : []).map((track) => ({
    ...track,
    keyframes: new Map(
      Array.from(track.keyframes, ([kt, box]) => [
        kt,
        { x: box.x * scale, y: box.y * scale, w: box.w * scale, h: box.h * scale },
      ]),
    ),
  }));
}

// ---------------------------------------------------------------------------
// DOM ADAPTER: beginManualBox — pointer-draw a region (REQ-015)
// ---------------------------------------------------------------------------

/**
 * Wire manual-box drawing on the preview canvas: pointerdown starts a drag,
 * pointermove reports the rubber band, pointerup commits. Boxes are reported
 * in CANVAS BITMAP pixels (0..canvas.width/height space); mountEditor maps
 * them into native display px before calling hooks. Negative drags are
 * normalized to a min-corner box clamped into the canvas.
 *
 * @param {HTMLCanvasElement} overlayCanvas #overlay-canvas.
 * @param {(box: import('./types.js').Box, t: number) => void} onCommit
 *     Called with the normalized canvas-space box and `getTime()`.
 * @param {{getTime?: () => number,
 *          onPendingChange?: (box: import('./types.js').Box | null) => void,
 *     }} [opts]
 *     `getTime` supplies the commit time (default () => 0; mountEditor passes
 *     video.currentTime). `onPendingChange` streams the live rubber band
 *     (null on cancel/commit) so the host can preview it above the frame.
 * @returns {() => void} Detach all handlers and cancel any in-flight drag.
 */
export function beginManualBox(overlayCanvas, onCommit, opts = {}) {
  if (!overlayCanvas || typeof overlayCanvas.addEventListener !== 'function') {
    return () => {};
  }
  if (typeof onCommit !== 'function') return () => {};
  const getTime = typeof opts.getTime === 'function' ? opts.getTime : () => 0;
  const onPending =
    typeof opts.onPendingChange === 'function' ? opts.onPendingChange : null;

  /** @type {{x0: number, y0: number, box: import('./types.js').Box} | null} */
  let drag = null;

  /** Map a pointer event to canvas bitmap px (rect-relative, resolution-safe). */
  function toCanvasPx(e) {
    const rect = overlayCanvas.getBoundingClientRect();
    const sx = rect.width > 0 ? overlayCanvas.width / rect.width : 1;
    const sy = rect.height > 0 ? overlayCanvas.height / rect.height : 1;
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  /** Normalize a corner drag into a min-corner box clamped into the canvas. */
  function normalizedBox(x0, y0, x1, y1) {
    let box = {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
    if (box.x < 0) {
      box.w += box.x;
      box.x = 0;
    }
    if (box.y < 0) {
      box.h += box.y;
      box.y = 0;
    }
    if (box.x + box.w > overlayCanvas.width) box.w = overlayCanvas.width - box.x;
    if (box.y + box.h > overlayCanvas.height) box.h = overlayCanvas.height - box.y;
    return box;
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const p = toCanvasPx(e);
    drag = { x0: p.x, y0: p.y, box: null };
    try {
      overlayCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* detached canvas — capture is best-effort */
    }
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const p = toCanvasPx(e);
    drag.box = normalizedBox(drag.x0, drag.y0, p.x, p.y);
    if (onPending) onPending({ ...drag.box });
  }

  function finish(e, commit) {
    if (!drag) return;
    const box = drag.box;
    drag = null;
    try {
      overlayCanvas.releasePointerCapture(e.pointerId);
    } catch {
      /* Escape path or never captured */
    }
    if (onPending) onPending(null);
    if (commit && box && box.w >= MIN_DRAG_PX && box.h >= MIN_DRAG_PX) {
      onCommit(box, getTime());
    }
  }

  function onPointerUp(e) {
    finish(e, true);
  }
  function onPointerCancel(e) {
    finish(e, false);
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') finish(e, false);
  }

  overlayCanvas.addEventListener('pointerdown', onPointerDown);
  overlayCanvas.addEventListener('pointermove', onPointerMove);
  overlayCanvas.addEventListener('pointerup', onPointerUp);
  overlayCanvas.addEventListener('pointercancel', onPointerCancel);
  window.addEventListener('keydown', onKeyDown);

  return () => {
    overlayCanvas.removeEventListener('pointerdown', onPointerDown);
    overlayCanvas.removeEventListener('pointermove', onPointerMove);
    overlayCanvas.removeEventListener('pointerup', onPointerUp);
    overlayCanvas.removeEventListener('pointercancel', onPointerCancel);
    window.removeEventListener('keydown', onKeyDown);
    if (drag) {
      drag = null;
      if (onPending) onPending(null);
    }
  };
}

// ---------------------------------------------------------------------------
// DOM ADAPTER: mountEditor — preview lifecycle + timeline wiring (§4.7)
// ---------------------------------------------------------------------------

/**
 * Mount the review editor (interaction map in the module header). Guards
 * every element: missing els disable just that feature; mountEditor(null)
 * returns inert destroy/refresh.
 *
 * Preview composition per presented frame (REQ-012/016, AC-04/18) — the
 * overlay canvas becomes the pixel-truthful preview:
 *   1. contain-fit the native frame into the element box (mirrors the video's
 *      object-fit: contain) and size the canvas bitmap to the CONTENT box ×
 *      devicePixelRatio, so canvas px map to native px by ONE uniform scale;
 *   2. draw the current video frame into the canvas (it covers the <video>);
 *   3. pixelateFrame (the SAME single-seam function the export burn-in
 *      uses) against canvas-px scaled tracks — tracksAt → dilate 15% →
 *      applyPixelation, identical to export per frame (AC-04);
 *   4. drawOverlay for ALL tracks on top (enabled solid strokes + labels,
 *      disabled dashed "(visible)") with viewScale = that scale.
 * A density-invariant throw clears the canvas and re-throws (fail-closed:
 * the loop halts rather than ever showing an unredacted frame).
 *
 * @param {object} els Stable DOM handles:
 *     `{ video, overlayCanvas, timeline, chipsContainer, playhead, trackList }`.
 * @param {object} hooks Callbacks into main.js:
 *     `{ onToggle(trackId, enabled), onSeek(t), onManualBox(box, t),
 *        getState() → { tracks, currentTime } }`.
 * @returns {{destroy: () => void, refresh: () => void}} `destroy` tears all
 *     listeners/frames down on step change; `refresh` re-renders chips +
 *     track list + playhead from getState() (main calls it on state change).
 */
export function mountEditor(els, hooks) {
  const video = (els && els.video) || null;
  const canvas = (els && els.overlayCanvas) || null;
  const timeline = (els && els.timeline) || null;
  const chipsContainer = (els && els.chipsContainer) || null;
  const playhead = (els && els.playhead) || null;
  const trackList = (els && els.trackList) || null;

  const hasHook = (name) => !!(hooks && typeof hooks[name] === 'function');
  const getState = () =>
    hasHook('getState') ? hooks.getState() : { tracks: [], currentTime: 0 };
  const callToggle = (id, enabled) => {
    if (hasHook('onToggle')) hooks.onToggle(id, enabled);
  };
  const callSeek = (t) => {
    if (hasHook('onSeek')) hooks.onSeek(t);
  };

  const doc = typeof document !== 'undefined' ? document : null;

  /** Video duration in seconds; 0 until finite metadata exists. */
  const duration = () => {
    const d = video ? video.duration : NaN;
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  /** Displayed-frame time (video.currentTime), falling back to state. */
  const displayTime = () => {
    if (video && Number.isFinite(video.currentTime)) return video.currentTime;
    const st = getState();
    return Number.isFinite(st.currentTime) ? st.currentTime : 0;
  };
  const clampTime = (t) => Math.min(duration(), Math.max(0, t));

  // --- Preview loop (video frame → pixelation → overlay → playhead) -------

  const ctx =
    canvas && typeof canvas.getContext === 'function'
      ? canvas.getContext('2d')
      : null;
  let frameHandle = 0;
  let usingVFC = false;
  let closed = false;
  /** Live manual-drag rubber band (canvas bitmap px) drawn above the frame. */
  let pendingBox = null;
  /** Canvas px per native px — set by drawPreview once metadata exists. */
  let previewScale = 1;
  /**
   * Memo for tracksInCanvasPx: rebuild the scaled copy only when the state
   * array identity or the scale changes (toggle/resize), never per frame.
   * @type {{tracks: object[] | null, scale: number, scaled: object[] | null}}
   */
  let scaledMemo = { tracks: null, scale: -1, scaled: null };

  /** Memoized scaleTracksToCanvas (see the pure helper for the AC-04 math). */
  function tracksInCanvasPx(tracks, scale) {
    if (scaledMemo.tracks !== tracks || scaledMemo.scale !== scale) {
      scaledMemo = { tracks, scale, scaled: scaleTracksToCanvas(tracks, scale) };
    }
    return scaledMemo.scaled;
  }

  /** Draw the manual rubber band (dashed alert red) over the current frame. */
  function drawPending() {
    if (!ctx || !pendingBox) return;
    ctx.save();
    ctx.strokeStyle = ALERT_RED;
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeRect(pendingBox.x, pendingBox.y, pendingBox.w, pendingBox.h);
    ctx.restore();
  }

  function drawPreview() {
    if (!video || !ctx || !canvas) return;
    const nw = video.videoWidth || 0;
    const nh = video.videoHeight || 0;
    if (!nw || !nh) return;

    // Contain-fit the native frame into the element box (object-fit: contain
    // twin) and resize the bitmap to the CONTENT box × DPR, so boxes map to
    // canvas px with one uniform scale and the canvas exactly covers the
    // visible video content (no letterbox offset math anywhere else).
    const dpr =
      typeof devicePixelRatio === 'number' && devicePixelRatio > 0
        ? devicePixelRatio
        : 1;
    const ew = video.clientWidth || nw;
    const eh = video.clientHeight || nh;
    const fit = Math.min(ew / nw, eh / nh);
    const cssW = nw * fit;
    const cssH = nh * fit;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    if (canvas.style) {
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.style.left = `${(ew - cssW) / 2}px`;
      canvas.style.top = `${(eh - cssH) / 2}px`;
    }
    previewScale = bw / nw;

    if (video.readyState < 2) return; // no decoded frame yet — stay clear

    ctx.clearRect(0, 0, bw, bh);
    ctx.drawImage(video, 0, 0, bw, bh); // canvas becomes the visible preview

    const state = getState();
    const t = displayTime();
    try {
      // 1. Burn pixelation through THE shared seam (REQ-016 pixel-truthful
      //    preview): redact.pixelateFrame = tracksAt → dilate 15% →
      //    applyPixelation — the exact composition the export burn-in runs
      //    per sample, here in canvas px against scaled tracks so preview
      //    pixels equal exported pixels (AC-04). Source-rect sampling in
      //    applyPixelation is untransformed — no ctx transform anywhere.
      const tracksCanvasPx = tracksInCanvasPx(state.tracks, previewScale);
      pixelateFrame(ctx, tracksCanvasPx, t, { width: bw, height: bh });
      // 2. Outline pass for ALL tracks (enabled solid + disabled dashed),
      //    on top of the burned pixels so strokes stay crisp — same scaled
      //    boxes so strokes align with the burned regions; viewScale keeps
      //    stroke/label metrics CSS-px consistent.
      drawOverlay(ctx, tracksCanvasPx, t, previewScale);
    } catch (err) {
      // Density invariant violated (tracker bug): fail CLOSED — never leave
      // an unredacted frame on screen — and re-throw (never swallow). The
      // loop then halts because tick() schedules only after a clean draw.
      ctx.clearRect(0, 0, bw, bh);
      throw err;
    }
    drawPending();
  }

  function updatePlayhead() {
    if (!playhead) return;
    const d = duration();
    const pct = d > 0 ? (clampTime(displayTime()) / d) * 100 : 0;
    playhead.style.left = `${pct}%`;
  }

  function scheduleFrame() {
    if (closed || !video || !ctx) return;
    if (typeof video.requestVideoFrameCallback === 'function') {
      usingVFC = true;
      frameHandle = video.requestVideoFrameCallback(tick);
    } else {
      usingVFC = false;
      frameHandle = requestAnimationFrame(tick);
    }
  }

  function tick() {
    frameHandle = 0;
    drawPreview(); // may throw on invariant violation → loop halts (fail-closed)
    updatePlayhead();
    scheduleFrame();
  }

  /** Immediate redraw after a scrub (vfc may not fire while paused). */
  function onSeeked() {
    drawPreview();
    updatePlayhead();
  }

  // --- Timeline + track list DOM (chips, rows, playhead) -------------------

  /** m:ss.s timecode for list rows. */
  function fmtTime(s) {
    const sec = Number.isFinite(s) ? Math.max(0, s) : 0;
    const m = Math.floor(sec / 60);
    const r = sec - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
  }

  function render() {
    if (closed || !doc) return;
    const state = getState();
    const d = duration();
    const vm = renderTimeline(state.tracks, d, displayTime());

    if (chipsContainer) {
      chipsContainer.textContent = '';
      for (const chip of vm.chips) {
        const widthPct = chip.endPct - chip.startPct;
        if (widthPct <= 0) continue; // nothing visible inside the duration
        const el = doc.createElement('div');
        el.dataset.trackId = String(chip.track.id);
        el.title = chip.enabled
          ? chip.track.label
          : `${chip.track.label} (visible)`;
        el.style.cssText =
          'position:absolute;top:6px;bottom:6px;border-radius:4px;' +
          'min-width:2px;cursor:pointer;';
        el.style.left = `${chip.startPct}%`;
        el.style.width = `${widthPct}%`;
        el.style.background = chip.enabled ? chip.color : SAFE_GREEN;
        el.style.opacity = chip.enabled ? '1' : '0.55';
        chipsContainer.appendChild(el);
      }
    }

    if (playhead) playhead.style.left = `${vm.playheadPct}%`;

    if (trackList) {
      trackList.textContent = '';
      for (const track of state.tracks) {
        const row = doc.createElement('li');
        row.className = 'track-row' + (track.enabled ? '' : ' enabled-off');
        row.dataset.trackId = String(track.id);

        const swatch = doc.createElement('span');
        swatch.className = 'swatch';
        swatch.style.background = track.enabled ? track.color : SAFE_GREEN;

        const label = doc.createElement('span');
        label.className = 'label';
        label.textContent = track.enabled
          ? track.label
          : `${track.label} (visible)`;

        const span = doc.createElement('span');
        span.className = 'span num';
        span.textContent = `${fmtTime(track.start)}–${fmtTime(
          Number.isFinite(d) && d > 0 ? Math.min(track.end, d) : track.end,
        )}`;

        const checkbox = doc.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = !!track.enabled;
        checkbox.dataset.trackId = String(track.id);
        checkbox.title = 'Redact this track';

        row.append(swatch, label, span, checkbox);
        trackList.appendChild(row);
      }
    }
  }

  // --- Timeline events: click = seek, dblclick on chip = toggle ------------

  function timelinePos(e) {
    if (!timeline || !timeline.getBoundingClientRect) return null;
    const rect = timeline.getBoundingClientRect();
    if (!(rect.width > 0)) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, width: rect.width };
  }

  function onTimelineClick(e) {
    const p = timelinePos(e);
    if (!p) return;
    const d = duration();
    if (!(d > 0)) return;
    callSeek(clampTime((p.x / p.width) * d));
  }

  function onTimelineDblClick(e) {
    const p = timelinePos(e);
    if (!p) return;
    const d = duration();
    if (!(d > 0)) return;
    const hit = hitTestTimeline(p.x, p.y, p.width, getState().tracks, d);
    if (hit) callToggle(hit.track.id, !hit.track.enabled);
  }

  // --- Track list events: checkbox = toggle, row click = seek to span -----

  function onListChange(e) {
    const input = e.target;
    if (!input || input.type !== 'checkbox') return;
    const id = Number(input.dataset && input.dataset.trackId);
    if (Number.isFinite(id)) callToggle(id, !!input.checked);
  }

  function onListClick(e) {
    if (e.target && e.target.type === 'checkbox') return;
    const row =
      e.target && typeof e.target.closest === 'function'
        ? e.target.closest('[data-track-id]')
        : null;
    if (!row) return;
    const id = Number(row.dataset && row.dataset.trackId);
    const track = (getState().tracks || []).find((tr) => tr.id === id);
    if (track) callSeek(clampTime(track.start));
  }

  // --- Manual box: canvas-space box → native display px --------------------

  function commitManualBox(boxCanvas, t) {
    if (!hasHook('onManualBox') || !video) return;
    const nw = video.videoWidth || 0;
    const nh = video.videoHeight || 0;
    if (!nw || !nh || !(previewScale > 0)) return; // no frame to map against
    hooks.onManualBox(
      {
        x: boxCanvas.x / previewScale,
        y: boxCanvas.y / previewScale,
        w: boxCanvas.w / previewScale,
        h: boxCanvas.h / previewScale,
      },
      t,
    );
  }

  const disposeManual =
    canvas && video
      ? beginManualBox(canvas, commitManualBox, {
          getTime: () => displayTime(),
          onPendingChange: (box) => {
            pendingBox = box;
            drawPending();
          },
        })
      : null;

  // --- Wire + first paint ---------------------------------------------------

  if (video && ctx) scheduleFrame();
  if (video) {
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('loadedmetadata', render);
  }
  if (timeline) {
    timeline.addEventListener('click', onTimelineClick);
    timeline.addEventListener('dblclick', onTimelineDblClick);
  }
  if (trackList) {
    trackList.addEventListener('change', onListChange);
    trackList.addEventListener('click', onListClick);
  }
  render(); // initial chips + track list (inert in node: doc is undefined)

  function destroy() {
    closed = true;
    if (frameHandle) {
      if (usingVFC && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameHandle);
      } else {
        cancelAnimationFrame(frameHandle);
      }
      frameHandle = 0;
    }
    if (video) {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('loadedmetadata', render);
    }
    if (timeline) {
      timeline.removeEventListener('click', onTimelineClick);
      timeline.removeEventListener('dblclick', onTimelineDblClick);
    }
    if (trackList) {
      trackList.removeEventListener('change', onListChange);
      trackList.removeEventListener('click', onListClick);
    }
    if (disposeManual) disposeManual();
    pendingBox = null;
    if (ctx && canvas && canvas.width > 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  return { destroy, refresh: render };
}
