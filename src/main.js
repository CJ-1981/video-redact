/**
 * main.js — app entry point (design.md §3): stepper state machine, DOM
 * wiring, crash-recovery sweep, keyboard routing (SPEC-VID-001 T-602).
 *
 * Architecture: the pure parts of the app shell are exported for unit tests
 * (tests/unit/main-wiring.test.js runs in node, no DOM):
 *
 *   deriveStep(step, event)            stepper state machine reducer
 *   stepperModel(step)                 state → { current, done } stepper VM
 *   formatBytes(n) / formatEta(s) / formatClock(s)   display formatters
 *   mapExportErrorToMessage(stage)     REQ-021 export stage → recovery text
 *   describeIngestFailure(err)         REQ-001/021 ingest failure → text
 *   renderProbeRows(caps)              capability probes → table view model
 *   metaSummaryRows(meta)              MediaMeta → table view model
 *   inferenceRow(caps)                 EP policy → AC-17 "Inference" row
 *   epLabel(ep)                        effective EP → status suffix label
 *   formatVersionBadge({version, buildDate})  footer version badge text
 *   clampStageHeight(px, viewportH, reservedH)
 *                                      stage-height clamp (v1.2.0 handle;
 *                                      v1.6.1 REG-3 adds the reserved-space
 *                                      fit bound)
 *   nextStageHeight(px, delta, vh)     handle keyboard step (v1.2.0)
 *   dragStageHeight(startY, y, startH) pointer-drag height (v1.3.1 direction fix)
 *   transportGlyph(paused)             play/pause glyph (v1.4.0 REQ-111)
 *   normalizePlaybackRate(rate)        rate clamp to finite > 0 (v1.4.0)
 *   SHORTCUT_TYPING_SELECTOR / shortcutEnabledFor(focusEl, opts)
 *                                      doc-shortcut focus gating — typing
 *                                      surfaces only (v1.6.1 REG-2)
 *   OVERLAY_HIDE_MS                    overlay auto-hide delay (v1.4.0 REQ-111)
 *   THRESHOLD_LEVELS / THRESHOLD_FACE_RANGE / THRESHOLD_PLATE_RANGE /
 *   THRESHOLD_PANEL_FRACTION           compare constants (v1.5.0 REQ-113/114)
 *   buildThresholdPanels(levels, faceDets, plateDets)
 *                                      per-level detection counts (REQ-114)
 *   formatThresholdCaption(panel)      "≥0.60 · 2 faces · 1 plate" (REQ-114)
 *   applyThresholdLevel(level, settings)
 *                                      panel click → both slider values (REQ-114)
 *   DEFAULT_SETTINGS()                 fresh default-settings factory (v1.6.0):
 *                                      the single source of truth used by BOTH
 *                                      the initial mount state and clearAll
 *   fileInputNeedsReset(value)         true when a file input still carries a
 *                                      selection (v1.6.0 — clearing it lets
 *                                      re-selecting the SAME file re-fire
 *                                      the input's `change` event)
 *
 * mountApp(document) owns ALL DOM access and stays untested (node has no
 * DOM); it runs automatically in the browser and is a no-op import in node.
 * It never mutates module behavior — modules are integrated as-is.
 *
 * v1.6.0 wiring: the header #clear-file button ("✕ Clear") calls clearAll() —
 * aborts any in-flight analyze/export, bumps the generation counter so stale
 * callbacks drop, destroys the editor (cancels rVFC/rAF loops), revokes the
 * preview blob URL, unloads the video element (decoder free), disposes the
 * mediabunny Input, sweeps leftover OPFS export temps, resets the file input
 * (re-selecting the same file re-fires `change`), and restores every panel to
 * the landing view via the stepper's 'CLEAR' transition (every step → gate).
 * The model cache (IndexedDB), the stage height and the version badge SURVIVE.
 *
 * SPEC-VID-002 wiring (all DOM-side, untested in node like the rest of
 * mountApp): REQ-103 trim hooks (editor chip-edge drag → trimTrack),
 * REQ-101 style hooks (track-row select → setTrackStyle), REQ-105 transport
 * bar (jump/frame-step/play-pause/speed/timecode driven by video media
 * events) and REQ-106 fullscreen preview (requestFullscreen with a
 * `.preview-zoom` in-page fallback + editor.redraw() resize kicks).
 *
 * v1.4.0 wiring (REQ-111): the transport actions live in small shared
 * functions (togglePlay / stepFrame / setSpeed / exitPreview) called by BOTH
 * the bottom transport bar and the in-stage overlay control bar
 * (.stage-overlay-controls — shown only in fullscreen/zoom, auto-hidden after
 * OVERLAY_HIDE_MS of no pointer/touch activity on the stage, re-shown on
 * activity and on enter). The overlay uses distinct ov-* ids so every
 * existing #transport-bar E2E selector keeps working.
 *
 * v1.2.0 wiring: the #stage-resize-handle between the preview stage and the
 * transport bar — pointer drag / ArrowUp / ArrowDown resize the stage via the
 * `--stage-h` custom property (clamped 220 px – 75vh), double-click resets;
 * every height change kicks editor.redraw() so the overlay re-scales to the
 * new layout × devicePixelRatio (the same seam as fullscreen/zoom).
 *
 * NOTE: the string 'video-redact dev shell' (set on <body data-app-shell>)
 * is asserted by tests/unit/scaffold.test.js against the built artifact.
 */
import { secureContextInfo, guidance, probeCapabilities } from './capability.js';
import { MODELS } from './models.js';
import { manualTrackFromBox, mountEditor, setTrackStyle, toggleTrack, trimTrack } from './editor.js';
import { openInput } from './ingest.js';
import { runAnalyze, sampleFrameAt } from './analyze.js';
import { createDetectors, decodeYunetOutputs, parsePlateRows } from './detector.js';
import { ExportError, discardExportTemp, runExport } from './exporter.js';
import './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * OPFS staging directory + temp-file prefix for the AC-14 crash-recovery
 * sweep. Mirrors the (unexported) constants in exporter.js — kept literal
 * here so the sweep can LIST leftovers without exporting them there.
 */
const STAGING_DIR = 'exports';
const STAGING_PREFIX = 'redact-export-';

/** Probe kind → capability-report row label. */
const PROBE_LABELS = {
  'video-decode': 'Video decode',
  'audio-decode': 'Audio decode',
  'video-encode-avc': 'H.264 encode',
  'video-encode-vp9': 'VP9 encode',
};

/** MODELS registry key → display name (license attribution panel). */
const MODEL_DISPLAY_NAMES = {
  yunet: 'YuNet face detection',
  'plate-yolov9t': 'YOLOv9-t license plates',
};

/**
 * Build-time stamps (v1.0.0 formal semver start). tools/inline.mjs injects
 * real values via esbuild `define` on the `globalThis.*` member expressions,
 * so the bundled dist shows the shipped version + build UTC date; unbundled
 * dev mode (npm run dev) falls back to the 'dev' badge.
 */
const APP_VERSION = globalThis.__APP_VERSION__ ?? 'dev';
const BUILD_DATE = globalThis.__BUILD_DATE__ ?? '';

// ---------------------------------------------------------------------------
// Stepper state machine: gate → ready → analyzing → review → exporting → done
// ---------------------------------------------------------------------------

/**
 * Legal transitions. Any (state, event) pair not listed is ILLEGAL and
 * derives to null — callers must ignore the event (guards "no Analyze
 * before ready; no Export without review state"). Cancellation is modeled
 * as the success event carrying a cancelled flag (AC-03 partial review;
 * export cancel is an EXPORT_FAIL with a cancelled marker at the callsite).
 *
 * v1.6.0: 'CLEAR' (the header ✕ Clear button) is legal from EVERY step and
 * always lands on 'gate' — the app shell resets to the landing view; the
 * DOM-side clearAll() owns the teardown (abort, editor destroy, media
 * unload, panel reset) that makes the state jump safe.
 */
const STEP_TRANSITIONS = {
  gate: {
    FILE_OPENED: 'ready',
    CLEAR: 'gate',
  },
  ready: {
    ANALYZE_START: 'analyzing',
    FILE_OPENED: 'ready',
    CLEAR: 'gate',
  },
  analyzing: {
    ANALYZE_FINISH: 'review',
    ANALYZE_FAIL: 'ready',
    CLEAR: 'gate',
  },
  review: {
    ANALYZE_START: 'analyzing', // re-analyze (e.g. dashcam toggle changed)
    EXPORT_START: 'exporting',
    FILE_OPENED: 'ready',
    CLEAR: 'gate',
  },
  exporting: {
    EXPORT_DONE: 'done',
    EXPORT_FAIL: 'review',
    CLEAR: 'gate',
  },
  done: {
    ANALYZE_START: 'analyzing',
    EXPORT_START: 'exporting', // re-export after tweaking tracks
    FILE_OPENED: 'ready',
    CLEAR: 'gate',
  },
};

/**
 * Pure reducer: current step + event name → next step, or null when the
 * transition is illegal in the current state.
 *
 * @param {import('./types.js').AppState['step']} step
 * @param {'FILE_OPENED'|'ANALYZE_START'|'ANALYZE_FINISH'|'ANALYZE_FAIL'|
 *          'EXPORT_START'|'EXPORT_DONE'|'EXPORT_FAIL'|'CLEAR'} event
 * @returns {import('./types.js').AppState['step'] | null}
 */
export function deriveStep(step, event) {
  return STEP_TRANSITIONS[step]?.[event] ?? null;
}

/** App state → which stepper entries are finished / current. */
const STEPPER_CURRENT = {
  gate: 'step-gate',
  ready: 'step-analyze',
  analyzing: 'step-analyze',
  review: 'step-review',
  exporting: 'step-export',
  done: null,
};
const STEPPER_DONE = {
  gate: [],
  ready: ['step-gate'],
  analyzing: ['step-gate'],
  review: ['step-gate', 'step-analyze'],
  exporting: ['step-gate', 'step-analyze', 'step-review'],
  done: ['step-gate', 'step-analyze', 'step-review', 'step-export'],
};

/**
 * Stepper view model for one app state (element ids in index.html).
 *
 * @param {import('./types.js').AppState['step']} step
 * @returns {{current: string | null, done: string[]}}
 */
export function stepperModel(step) {
  return { current: STEPPER_CURRENT[step] ?? null, done: STEPPER_DONE[step] ?? [] };
}

// ---------------------------------------------------------------------------
// Display formatters (pure)
// ---------------------------------------------------------------------------

/**
 * Bytes → compact human size (binary units, one decimal above 1 KiB).
 * Non-finite/negative → '—'.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 'B';
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * Seconds → short ETA ("42s", "1m 30s"); unknown (null/NaN/negative) → '—'.
 *
 * @param {number | null} sec
 * @returns {string}
 */
export function formatEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 90) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Seconds → m:ss.d timecode ("1:23.4"); never rolls over into ":60.0".
 *
 * @param {number} sec
 * @returns {string}
 */
export function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.0';
  const m = Math.floor(sec / 60);
  const s = Math.round((sec - m * 60) * 10) / 10;
  if (s >= 60) return `${m + 1}:00.0`;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/**
 * Version + build date → footer badge text (#app-version). The shipped
 * artifact stamps both at build time (tools/inline.mjs esbuild `define`);
 * dev mode runs unbundled and shows the fallback badge.
 *
 *   {version: '1.0.0', buildDate: '2026-10-29'} → 'v1.0.0 · built 2026-10-29'
 *   {version: '1.0.0', buildDate: ''}           → 'v1.0.0'
 *   {version: 'dev'} / missing                  → 'dev build (unbuilt)'
 *
 * @param {{version?: string | null, buildDate?: string | null}} [parts]
 * @returns {string}
 */
export function formatVersionBadge({ version, buildDate } = {}) {
  const v = String(version ?? '').trim();
  if (v.length === 0 || v === 'dev') return 'dev build (unbuilt)';
  const d = String(buildDate ?? '').trim();
  return d.length > 0 ? `v${v} · built ${d}` : `v${v}`;
}

// ---------------------------------------------------------------------------
// Preview-stage height model (pure; v1.2.0 drag handle)
// ---------------------------------------------------------------------------

/** Historical/default preview-stage height, CSS px (index.html fallback). */
export const DEFAULT_STAGE_HEIGHT_PX = 320;
/** Lower clamp bound — a stage below this is useless for review. */
export const STAGE_MIN_HEIGHT_PX = 220;
/** Keyboard step (ArrowUp / ArrowDown on the focused handle), CSS px. */
export const STAGE_HEIGHT_STEP_PX = 24;
/** Upper clamp bound as a fraction of the viewport height (75vh). */
const STAGE_MAX_VIEWPORT_FRACTION = 0.75;

/**
 * Clamp a desired preview-stage height to the usable viewport as an integer.
 * PURE. The bound is the SMALLER of:
 *   - the classic 75vh fraction (round(0.75·viewportH)), and
 *   - the fit bound `viewportH − reservedH` (v1.6.1 REG-3), so the stage can
 *     never push the transport bar and timeline into/past the footer on
 *     short viewports. The 75vh bound is recomputed against the CURRENT
 *     viewport on every call, so a window resize re-clamps on the next drag /
 *     key step.
 *
 * `reservedH` is everything around the stage that must stay visible —
 * header + footer + #app-main vertical padding + every #stage-column child
 * except the stage itself (handle, transport, hint, timeline + flex gaps);
 * mountApp measures it live (stageReservedHeight). Degradations: a non-finite
 * `px` falls back to the default height before clamping; a non-finite/≤ 0
 * `viewportH` drops BOTH upper bounds (min still enforced); a non-finite/≤ 0
 * `reservedH` drops just the fit bound (plain 75vh clamp). The lower clamp
 * always wins: a tiny viewport can never push the max below the min — below
 * that point overlap is accepted by design (a 220 px stage is the last
 * usable review size).
 *
 * @param {number} px Desired stage height, CSS px.
 * @param {number} viewportH Viewport height, CSS px (window.innerHeight).
 * @param {number} [reservedH] Vertical space around the stage that must stay
 *     visible, CSS px (0 = unknown → plain 75vh clamp).
 * @returns {number} Clamped integer stage height.
 */
export function clampStageHeight(px, viewportH, reservedH = 0) {
  let max = Infinity;
  if (Number.isFinite(viewportH) && viewportH > 0) {
    let cap = Math.round(viewportH * STAGE_MAX_VIEWPORT_FRACTION);
    if (Number.isFinite(reservedH) && reservedH > 0) {
      cap = Math.min(cap, Math.floor(viewportH - reservedH));
    }
    max = Math.max(cap, STAGE_MIN_HEIGHT_PX);
  }
  const desired = Number.isFinite(px) ? Math.round(px) : DEFAULT_STAGE_HEIGHT_PX;
  return Math.min(Math.max(desired, STAGE_MIN_HEIGHT_PX), max);
}

/**
 * One stage-height step (v1.2.0 keyboard parity: ArrowUp/ArrowDown ±24 px)
 * — `px` moved by `deltaPx`, then clamped by clampStageHeight. PURE.
 *
 * @param {number} px Current stage height, CSS px.
 * @param {number} deltaPx Signed step (+ = taller), CSS px.
 * @param {number} viewportH Viewport height, CSS px.
 * @param {number} [reservedH] Reserved space around the stage (v1.6.1 REG-3).
 * @returns {number} New clamped integer stage height.
 */
export function nextStageHeight(px, deltaPx, viewportH, reservedH = 0) {
  const step = Number.isFinite(deltaPx) ? deltaPx : 0;
  const from = Number.isFinite(px) ? px : DEFAULT_STAGE_HEIGHT_PX;
  return clampStageHeight(from + step, viewportH, reservedH);
}

/**
 * Pointer-drag height (v1.3.1 direction fix): the handle is the stage's
 * BOTTOM edge, so it follows the pointer — moving the pointer DOWN
 * (clientY > startY) grows the stage.PURE; the caller clamps via
 * applyStageHeight (live 75vh bound). Direction is pinned by unit test.
 *
 * @param {number} startY Pointer Y at drag start (CSS px).
 * @param {number} clientY Current pointer Y (CSS px).
 * @param {number} startH Stage height at drag start (CSS px).
 * @returns {number} Unclamped new stage height.
 */
export function dragStageHeight(startY, clientY, startH) {
  const dy = Number.isFinite(clientY) && Number.isFinite(startY) ? clientY - startY : 0;
  const from = Number.isFinite(startH) ? startH : DEFAULT_STAGE_HEIGHT_PX;
  return from + dy;
}

// ---------------------------------------------------------------------------
// Overlay control-bar view model (pure; v1.4.0 REQ-111)
// ---------------------------------------------------------------------------

/**
 * Auto-hide delay for the in-stage overlay control bar (REQ-111): controls
 * re-appear on any pointer/touch activity inside the stage and fade after
 * this much idle time — the standard video-player behavior.
 * @type {number}
 */
export const OVERLAY_HIDE_MS = 3000;

/**
 * Play/pause glyph for a paused state — '▶' when paused, '⏸' while playing.
 * PURE; shared by the bottom transport bar and the fullscreen overlay bar so
 * both always show the same glyph for the same state.
 *
 * @param {boolean} paused Whether the video is paused.
 * @returns {'▶'|'⏸'}
 */
export function transportGlyph(paused) {
  return paused ? '▶' : '⏸';
}

/**
 * Clamp a playback-rate input to a usable rate: finite and > 0, else 1×.
 * PURE; every speed selector (bottom bar + overlay) routes through this so
 * a bogus value can never silence or stall playback.
 *
 * @param {unknown} rate Raw selector value (string) or number.
 * @returns {number} Positive finite playback rate.
 */
export function normalizePlaybackRate(rate) {
  const r = Number(rate);
  return Number.isFinite(r) && r > 0 ? r : 1;
}

// ---------------------------------------------------------------------------
// Threshold compare view model (pure; v1.5.0 REQ-113/114)
// ---------------------------------------------------------------------------

/**
 * The five FIXED levels the single-frame threshold comparison renders one
 * panel per (REQ-114). @type {number[]}
 */
export const THRESHOLD_LEVELS = [0.15, 0.3, 0.45, 0.6, 0.75];

/** Face sensitivity slider bounds (REQ-113): 0.10–0.90 step 0.05, default 0.60. */
export const THRESHOLD_FACE_RANGE = { min: 0.1, max: 0.9, step: 0.05, default: 0.6 };

/** Plate sensitivity slider bounds (REQ-113): 0.05–0.90 step 0.05, default 0.25. */
export const THRESHOLD_PLATE_RANGE = { min: 0.05, max: 0.9, step: 0.05, default: 0.25 };

/** Compare-panel canvas width as a fraction of the analyze panel width. */
export const THRESHOLD_PANEL_FRACTION = 0.3;

/**
 * Per-level detection counts for the compare panels (REQ-114). PURE: one
 * decode at threshold 0 upstream, then each panel counts detections with
 * `conf >= level` — order-equivalent to decoding at each level, because NMS
 * suppresses a box only via a HIGHER-conf box (any box kept at `level` is
 * also kept at 0), and the plate head's NMS is graph-embedded upstream.
 *
 * @param {number[] | null | undefined} levels The fixed panel levels.
 * @param {Array<{conf: number, [k: string]: unknown}> | null | undefined} faceDets
 *     Full decoded face list (post-NMS, lowest threshold).
 * @param {Array<{conf: number, [k: string]: unknown}> | null | undefined} plateDets
 *     Full decoded plate list.
 * @returns {Array<{level: number, faces: number, plates: number}>}
 */
export function buildThresholdPanels(levels, faceDets, plateDets) {
  const faces = Array.isArray(faceDets) ? faceDets : [];
  const plates = Array.isArray(plateDets) ? plateDets : [];
  return (Array.isArray(levels) ? levels : []).map((level) => ({
    level,
    faces: faces.filter((d) => Number(d?.conf) >= level).length,
    plates: plates.filter((d) => Number(d?.conf) >= level).length,
  }));
}

/**
 * Panel view model → caption text: "≥0.15 · 2 faces · 1 plate" (REQ-114).
 * PURE; correct singular/plural; invalid level renders as "≥—".
 *
 * @param {{level: number, faces: number, plates: number} | null | undefined} panel
 * @returns {string}
 */
export function formatThresholdCaption(panel) {
  const level = Number(panel?.level);
  const faces = Number(panel?.faces) || 0;
  const plates = Number(panel?.plates) || 0;
  const lvl = Number.isFinite(level) ? level.toFixed(2) : '—';
  return `≥${lvl} · ${faces} face${faces === 1 ? '' : 's'} · ${plates} plate${plates === 1 ? '' : 's'}`;
}

/**
 * Panel-click → BOTH sensitivity sliders (REQ-114: activating a panel
 * applies that level to face AND plate). PURE: clamps to each slider's
 * range (the face slider starts at 0.10, the plate slider at 0.05) and
 * preserves every other settings field; an invalid level leaves the
 * settings untouched.
 *
 * @param {number} level The clicked panel's threshold level.
 * @param {Record<string, unknown>} [settings] Current settings to merge into.
 * @returns {Record<string, unknown>} New settings with confFace + confPlate set.
 */
export function applyThresholdLevel(level, settings = {}) {
  const v = Number(level);
  if (!Number.isFinite(v)) return { ...settings };
  const clamp = (x, r) => Math.min(r.max, Math.max(r.min, x));
  return {
    ...settings,
    confFace: clamp(v, THRESHOLD_FACE_RANGE),
    confPlate: clamp(v, THRESHOLD_PLATE_RANGE),
  };
}

// ---------------------------------------------------------------------------
// Clear/reset settings model (pure; v1.6.0)
// ---------------------------------------------------------------------------

/**
 * Fresh default analysis settings (v1.6.0). PURE factory — a NEW object per
 * call so the shared default can never be mutated by a caller. The SINGLE
 * source of truth for both the initial mount state and clearAll's reset:
 * the analyze-panel controls are always restored from here, never from
 * hand-copied literals. Values are the pre-1.5.0 baked gates (face 0.60,
 * plate 0.25 — THRESHOLD_*__RANGE defaults), dashcam off, plateStride left
 * undefined so analyze.js applies its own DEFAULT_PLATE_STRIDE.
 *
 * @returns {{confFace: number, confPlate: number, dashcamMode: boolean,
 *            plateStride: number | undefined}}
 */
export function DEFAULT_SETTINGS() {
  return {
    confFace: THRESHOLD_FACE_RANGE.default,
    confPlate: THRESHOLD_PLATE_RANGE.default,
    dashcamMode: false,
    plateStride: undefined,
  };
}

/**
 * True when a file input still carries a selection (v1.6.0). An input with a
 * non-empty value will NOT fire another `change` event if the user re-selects
 * the SAME file — the classic pitfall clearAll must defeat. Trivial, but
 * exported so the contract is pinned by a unit test.
 *
 * @param {unknown} value A file input's `.value`.
 * @returns {boolean}
 */
export function fileInputNeedsReset(value) {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// Doc-shortcut focus gating (pure; v1.6.1 REG-2)
// ---------------------------------------------------------------------------

/**
 * Focus surfaces the transport shortcuts must yield to (v1.6.1 REG-2): the
 * places where keystrokes MEAN typing or native widget behavior — text inputs
 * (track-row time fields), selects (open dropdowns, option arrows),
 * textareas, contenteditable. PURE — unit-tested via shortcutEnabledFor.
 *
 * Buttons are deliberately NOT excluded: excluding them stranded the
 * shortcuts whenever focus stayed on a clicked control (a focused button made
 * Space RE-ACTIVATE THE BUTTON — re-stepping frames, exiting fullscreen —
 * instead of toggling playback). Focused buttons are safe now: pointer
 * activation blurs them (mountApp wiring), and the Space branch preventDefaults
 * the browser's key-activation so exactly one toggle happens.
 * @type {string}
 */
export const SHORTCUT_TYPING_SELECTOR = 'input, select, textarea, [contenteditable]';

/**
 * Whether the document-level transport shortcuts may run for a keydown whose
 * target is `focusEl` (v1.6.1 REG-2). PURE: enabled when the element is
 * missing/dead (body) or NOT inside the typing surfaces; disabled inside
 * input/select/textarea/[contenteditable] — the track-row time inputs keep
 * their exclusion (typing m:ss.s must never frame-step the video).
 *
 * @param {Element | null | undefined} focusEl The keydown event's target
 *     (the focused element).
 * @param {{exclude?: string}} [opts] Override selector for callers that need
 *     a narrower/wider exclusion (defaults to SHORTCUT_TYPING_SELECTOR).
 * @returns {boolean} True when the shortcuts should fire.
 */
export function shortcutEnabledFor(focusEl, opts = {}) {
  const selector = typeof opts.exclude === 'string' ? opts.exclude : SHORTCUT_TYPING_SELECTOR;
  if (!focusEl || typeof /** @type {{closest?: unknown}} */ (focusEl).closest !== 'function') {
    return true;
  }
  return /** @type {Element} */ (focusEl).closest(selector) == null;
}

// ---------------------------------------------------------------------------
// REQ-021 error mapping tables (pure)
// ---------------------------------------------------------------------------

/**
 * ExportError.stage → readable message with recovery hint (REQ-021). The
 * exporter's internal ladder (avc-hw → avc-sw → vp9/WebM) has ALREADY been
 * exhausted when a rung stage surfaces here, so the hints say what the user
 * can still do — never a silent corrupt file.
 */
const EXPORT_ERROR_MESSAGES = {
  'encode-avc':
    'H.264 hardware encoding failed and no fallback produced a file. Close other GPU-heavy tabs, lower the quality, or try a shorter clip, then retry.',
  'encode-avc-software':
    'Software H.264 encoding failed and the WebM fallback did not produce a file. Close other tabs to free memory, then retry.',
  'encode-vp9':
    'VP9/WebM encoding failed — no encode path remains in this browser. Try Chrome or Edge, or report the issue if it persists.',
  mux:
    'Assembly of the exported file failed after encoding — no output was delivered. This may be a bug; please report it with your browser, OS, and file details.',
  io:
    'Writing the export file failed. Check free disk space and that the save location is writable, then retry.',
  cancelled:
    'Export cancelled — no file was written.',
};
const GENERIC_EXPORT_ERROR =
  'Export failed unexpectedly — no output file was delivered. Please retry.';

/**
 * @param {string} stage ExportError stage ('encode-avc' | 'encode-avc-software'
 *     | 'encode-vp9' | 'mux' | 'io' | 'cancelled') or anything else.
 * @returns {string} User-facing message (REQ-021).
 */
export function mapExportErrorToMessage(stage) {
  return EXPORT_ERROR_MESSAGES[stage] ?? GENERIC_EXPORT_ERROR;
}

/**
 * Ingest failure → readable, actionable message (REQ-021 pattern). Typed
 * IngestError messages from ingest.js are already stage + recovery shaped,
 * so they pass through verbatim; anything else gets an explicit fallback.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeIngestFailure(err) {
  const coded = err && typeof err === 'object' &&
    (/** @type {Error} */ (err).name === 'IngestError' ||
      typeof /** @type {{code?: unknown}} */ (err).code === 'string');
  if (coded) return String(/** @type {Error} */ (err).message);
  const detail = err instanceof Error ? err.message : String(err ?? 'unknown error');
  return `Could not open this file: ${detail}`;
}

// ---------------------------------------------------------------------------
// Capability / meta table view models (pure)
// ---------------------------------------------------------------------------

/**
 * Capability report → view model for the #cap-report probe table.
 *
 * @param {import('./types.js').CapabilityReport | null | undefined} caps
 * @returns {{engine: string, epPolicy: string | null, canAnalyze: boolean,
 *            canExport: boolean, rows: Array<{kind: string, label: string,
 *            detail: string, ok: boolean}>}}
 */
export function renderProbeRows(caps) {
  const probes = Array.isArray(caps?.probes) ? caps.probes : [];
  return {
    engine: caps?.engine ?? 'unknown',
    epPolicy: caps?.epPolicy ?? null,
    canAnalyze: caps?.canAnalyze === true,
    canExport: caps?.canExport === true,
    rows: probes.map((p) => ({
      kind: p.kind,
      label: PROBE_LABELS[p.kind] ?? p.kind,
      detail: String(p.detail ?? ''),
      ok: p.ok === true,
    })),
  };
}

/**
 * MediaMeta → view model for the #cap-report summary rows (AC-02: container,
 * codec, resolution, fps, duration, audio; container rotation annotated on
 * the resolution row when non-zero).
 *
 * @param {import('./types.js').MediaMeta | null | undefined} meta
 * @returns {Array<{label: string, value: string}>}
 */
export function metaSummaryRows(meta) {
  if (!meta) return [];
  const fps = Number(meta.fps);
  const rotation = Number(meta.rotation) || 0;
  const resolution =
    `${meta.displayWidth}×${meta.displayHeight}` +
    (rotation ? ` (rotated ${rotation}°)` : '');
  return [
    { label: 'Container', value: String(meta.container ?? 'unknown') },
    { label: 'Video codec', value: String(meta.codec ?? 'unknown') },
    { label: 'Resolution', value: resolution },
    { label: 'Frame rate', value: fps > 0 ? `${Math.round(fps * 100) / 100} fps` : 'unknown' },
    { label: 'Duration', value: formatClock(Number(meta.duration)) },
    { label: 'Audio', value: meta.audio ? String(meta.audio.codec ?? 'audio') : 'none' },
  ];
}

/**
 * Capability report → the AC-17 inference-provider row for #cap-report:
 * which ORT execution-provider policy the analyze pass will run under, with
 * the honest reason whenever it is the CPU fallback. null when the policy is
 * unknown (missing report) — no row is rendered in that case.
 *
 * @param {import('./types.js').CapabilityReport | null | undefined} caps
 * @returns {{label: string, value: string} | null}
 */
export function inferenceRow(caps) {
  const ep = caps?.epPolicy;
  if (ep === 'webgpu') return { label: 'Inference', value: 'WebGPU accelerated' };
  if (ep === 'wasm') {
    const reason =
      caps?.engine === 'webkit'
        ? 'WebGPU unavailable on this browser'
        : 'WebGPU unavailable';
    return { label: 'Inference', value: `CPU (WASM) — ${reason}` };
  }
  return null;
}

/**
 * Effective ORT execution provider (createDetectors' resolve value, plumbed
 * through runAnalyze) → short label for the #analyze-status suffix (AC-17):
 * the provider analyze ACTUALLY ran on. Unknown EP → null (no suffix, no
 * invented claim).
 *
 * @param {string | null | undefined} ep
 * @returns {string | null}
 */
export function epLabel(ep) {
  if (ep === 'webgpu') return 'WebGPU';
  if (ep === 'wasm') return 'CPU (WASM)';
  return null;
}

// ---------------------------------------------------------------------------
// mountApp — the thin DOM shell (browser only; never runs in node)
// ---------------------------------------------------------------------------

/**
 * Wire the whole application. Insecure context (REQ-004): shows the serve
 * gate with copy-paste instructions and wires NOTHING else.
 *
 * @param {Document | null} [doc] Defaults to the global document.
 * @returns {Promise<null | void>} null when the serve gate blocked wiring.
 */
export async function mountApp(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc.getElementById !== 'function') return null;

  const $ = (id) => doc.getElementById(id);
  const els = {
    serveGate: $('serve-gate'),
    stepper: $('stepper'),
    appMain: $('app-main'),
    stageColumn: $('stage-column'),
    keyboardHints: $('keyboard-hints'),
    intakePanel: $('intake-panel'),
    dropZone: $('drop-zone'),
    fileInput: /** @type {HTMLInputElement | null} */ ($('file-input')),
    capReport: $('cap-report'),
    capTable: $('cap-report-body'),
    capGuidance: $('cap-guidance'),
    workspace: $('workspace'),
    previewStage: $('preview-stage'),
    video: /** @type {HTMLVideoElement | null} */ ($('preview-video')),
    overlayCanvas: /** @type {HTMLCanvasElement | null} */ ($('overlay-canvas')),
    fullscreenButton: /** @type {HTMLButtonElement | null} */ ($('preview-fullscreen')),
    stageResizeHandle: /** @type {HTMLElement | null} */ ($('stage-resize-handle')),
    transportStart: /** @type {HTMLButtonElement | null} */ ($('transport-start')),
    transportBack: /** @type {HTMLButtonElement | null} */ ($('transport-back')),
    transportPlay: /** @type {HTMLButtonElement | null} */ ($('transport-play')),
    transportFwd: /** @type {HTMLButtonElement | null} */ ($('transport-fwd')),
    transportSpeed: /** @type {HTMLSelectElement | null} */ ($('transport-speed')),
    transportTime: $('transport-time'),
    ovBack: /** @type {HTMLButtonElement | null} */ ($('ov-back')),
    ovPlay: /** @type {HTMLButtonElement | null} */ ($('ov-play')),
    ovFwd: /** @type {HTMLButtonElement | null} */ ($('ov-fwd')),
    ovSpeed: /** @type {HTMLSelectElement | null} */ ($('ov-speed')),
    ovExit: /** @type {HTMLButtonElement | null} */ ($('ov-exit')),
    timelineCurrent: $('timeline-current'),
    timelineDuration: $('timeline-duration'),
    timeline: $('timeline'),
    chips: $('track-chips'),
    playhead: $('playhead'),
    trackList: $('track-list'),
    trackListEmpty: $('track-list-empty'),
    analyzeButton: /** @type {HTMLButtonElement | null} */ ($('analyze-button')),
    analyzeCancel: /** @type {HTMLButtonElement | null} */ ($('analyze-cancel')),
    analyzeStatus: $('analyze-status'),
    analyzeBar: $('analyze-progress-bar'),
    analyzeFrames: $('analyze-frames'),
    analyzeTotal: $('analyze-total'),
    analyzeFps: $('analyze-fps'),
    analyzeEta: $('analyze-eta'),
    dashcamToggle: /** @type {HTMLInputElement | null} */ ($('dashcam-toggle')),
    analyzePanel: $('analyze-panel'),
    confFace: /** @type {HTMLInputElement | null} */ ($('conf-face')),
    confFaceOut: /** @type {HTMLOutputElement | null} */ ($('conf-face-out')),
    confPlate: /** @type {HTMLInputElement | null} */ ($('conf-plate')),
    confPlateOut: /** @type {HTMLOutputElement | null} */ ($('conf-plate-out')),
    compareTime: /** @type {HTMLInputElement | null} */ ($('compare-time')),
    compareButton: /** @type {HTMLButtonElement | null} */ ($('compare-button')),
    compareStatus: $('compare-status'),
    thresholdPanels: $('threshold-panels'),
    quality: /** @type {HTMLSelectElement | null} */ ($('export-quality')),
    exportBar: $('export-progress-bar'),
    exportButton: /** @type {HTMLButtonElement | null} */ ($('export-button')),
    exportCancel: /** @type {HTMLButtonElement | null} */ ($('export-cancel')),
    exportStatus: $('export-status'),
    attribution: $('model-attribution'),
    toastRegion: $('toast-region'),
    changeFile: /** @type {HTMLButtonElement | null} */ ($('change-file')),
    clearFile: /** @type {HTMLButtonElement | null} */ ($('clear-file')),
    appVersion: $('app-version'),
  };

  // --- REQ-004 secure-context gate: block everything, wire nothing --------
  const ctxInfo = secureContextInfo();
  if (!ctxInfo.secure) {
    if (els.serveGate) {
      els.serveGate.hidden = false;
      renderServeInstructions(doc, els.serveGate, ctxInfo.instructions);
    }
    return null;
  }

  // Marker string asserted by tests/unit/scaffold.test.js on the built
  // single-file artifact (body attribute only — no visual effect).
  if (doc.body) doc.body.dataset.appShell = 'video-redact dev shell';

  // --- AppState (types.js §2) — mutated only through the handlers below ---
  /** @type {{step: import('./types.js').AppState['step'], file: File | null,
   *          input: object | null, meta: import('./types.js').MediaMeta | null,
   *          caps: import('./types.js').CapabilityReport | null,
   *          tracks: import('./types.js').Track[], gen: number,
   *          manualNextId: number, objectUrl: string | null}} */
  const app = {
    step: 'gate',
    file: null,
    input: null,
    meta: null,
    caps: null,
    tracks: [],
    gen: 0, // generation counter — stale async completions are dropped
    manualNextId: 1,
    objectUrl: null,
  };
  let editor = /** @type {ReturnType<typeof mountEditor> | null} */ (null);
  let analyzeCtl = /** @type {AbortController | null} */ (null);
  let exportCtl = /** @type {AbortController | null} */ (null);
  let persisted = false;

  // --- Small DOM utilities --------------------------------------------------

  function toast(message, { kind = '', timeoutMs = 5000, actions = null } = {}) {
    if (!els.toastRegion) return;
    const el = doc.createElement('div');
    el.className = kind ? `toast ${kind}` : 'toast';
    el.style.pointerEvents = 'auto'; // toast-region itself is pointer-events:none
    const text = doc.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (Array.isArray(actions) && actions.length > 0) {
      for (const action of actions) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.textContent = action.label;
        btn.addEventListener('click', () => {
          el.remove();
          try {
            action.onClick?.();
          } catch {
            /* action failures surface via their own toasts */
          }
        });
        el.appendChild(btn);
      }
    } else if (timeoutMs > 0) {
      setTimeout(() => el.remove(), timeoutMs);
    }
    els.toastRegion.appendChild(el);
  }

  /** Progress bar; ratio null/NaN → indeterminate (dimmed full bar). */
  function setBar(bar, ratio) {
    if (!bar) return;
    if (ratio == null || !Number.isFinite(ratio)) {
      bar.style.width = '100%';
      bar.style.opacity = '0.35';
    } else {
      bar.style.opacity = '1';
      const clamped = Math.min(1, Math.max(0, ratio));
      bar.style.width = `${Math.round(clamped * 1000) / 10}%`;
    }
  }

  // --- v1.6.1 REG-2: pointer-activated controls release focus --------------
  //
  // Browsers focus a control on mousedown and LEAVE it focused after the
  // click. With the old T-602 exclusion (any `button`/`select` target
  // disabled the doc-level shortcuts), every clicked control then silently
  // ate Space/←/→: Space re-ACTIVATED the focused button instead (re-stepped
  // frames, exited fullscreen) — the field-reported dead keyboard transport.
  // Two-part fix: (1) these helpers blur transport/overlay/fullscreen/handle/
  // style-select/action controls after POINTER activation so focus returns to
  // <body> (keyboard activation keeps focus — Enter/Space still run the
  // focused control for a11y), and (2) the doc handler now excludes only the
  // typing surfaces (shortcutEnabledFor) and preventDefaults Space so a
  // focused button can never double-fire.

  /** Blur `el` after a pointer click (buttons — not selects, not the handle). */
  function blurAfterClick(el) {
    if (el && typeof el.blur === 'function') {
      el.addEventListener('click', () => el.blur());
    }
  }

  /** Blur `el` after a committed choice (selects — blur-to-open would close
   * the native dropdown before any option could be picked). */
  function blurAfterChange(el) {
    if (el && typeof el.blur === 'function') {
      el.addEventListener('change', () => el.blur());
    }
  }

  function applyStepper() {
    if (!els.stepper) return;
    const { current, done } = stepperModel(app.step);
    for (const li of els.stepper.querySelectorAll('li[data-step]')) {
      if (current === li.id) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
      li.classList.toggle('done', done.includes(li.id));
    }
  }

  /** Single source of button enable/disable — re-derived from the machine. */
  function updateButtons() {
    const analyzing = app.step === 'analyzing';
    const exporting = app.step === 'exporting';
    if (els.analyzeButton) {
      els.analyzeButton.hidden = analyzing;
      els.analyzeButton.disabled =
        app.caps?.canAnalyze !== true ||
        exporting ||
        deriveStep(app.step, 'ANALYZE_START') == null;
      els.analyzeButton.textContent = app.step === 'gate' || app.step === 'ready' ? 'Analyze' : 'Re-analyze';
    }
    if (els.analyzeCancel) els.analyzeCancel.hidden = !analyzing;
    if (els.exportButton) {
      els.exportButton.disabled =
        exporting || deriveStep(app.step, 'EXPORT_START') == null;
    }
    if (els.exportCancel) els.exportCancel.hidden = !exporting;
    if (els.changeFile) els.changeFile.hidden = app.step === 'gate';
    // v1.6.0: the Clear button mirrors #change-file — hidden at the gate
    // step (nothing to clear), shown whenever a file is loaded so a click
    // can also abort an in-flight analyze/export.
    if (els.clearFile) els.clearFile.hidden = app.step === 'gate';
  }

  function showIntake() {
    if (els.intakePanel) {
      els.intakePanel.hidden = false;
      els.intakePanel.style.flex = '1 1 100%';
    }
    if (els.dropZone) els.dropZone.hidden = false;
    if (els.workspace) els.workspace.hidden = true;
  }

  /** Capability rail narrows once the workspace (preview + rails) shows. */
  function showWorkspace() {
    if (els.intakePanel) {
      els.intakePanel.hidden = false;
      els.intakePanel.style.flex = '0 0 320px';
    }
    if (els.dropZone) els.dropZone.hidden = true;
    if (els.workspace) els.workspace.hidden = false;
  }

  function refreshTrackUi() {
    editor?.refresh();
    if (els.trackListEmpty) els.trackListEmpty.hidden = app.tracks.length > 0;
  }

  function resetAnalyzeUi() {
    setBar(els.analyzeBar, 0);
    if (els.analyzeFrames) els.analyzeFrames.textContent = '0';
    if (els.analyzeTotal) els.analyzeTotal.textContent = '0';
    if (els.analyzeFps) els.analyzeFps.textContent = '0.0';
    if (els.analyzeEta) els.analyzeEta.textContent = '—';
    if (els.analyzeStatus) els.analyzeStatus.textContent = '';
  }

  function resetExportUi() {
    setBar(els.exportBar, 0);
    if (els.exportStatus) els.exportStatus.textContent = '';
  }

  function requestPersistentStorage() {
    if (persisted) return;
    persisted = true; // first successful analyze only; best-effort
    try {
      const p = globalThis.navigator?.storage?.persist?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* storage manager unavailable — best-effort by design */
    }
  }

  // --- Startup renders --------------------------------------------------------

  renderAttribution();
  renderVersionBadge();
  applyStepper();
  updateButtons();
  // v1.6.0: the analyze-panel controls start from the SAME factory clearAll
  // restores them with — one source of truth for the default settings.
  applySettings(DEFAULT_SETTINGS());
  showIntake();
  void sweepExportTemps();

  function renderAttribution() {
    if (!els.attribution) return;
    const ul = els.attribution.querySelector('ul');
    if (!ul) return;
    ul.textContent = '';
    for (const model of Object.values(MODELS)) {
      const li = doc.createElement('li');
      const display = MODEL_DISPLAY_NAMES[model.name] ?? model.name;
      li.textContent = `${display} (${model.version}, ${formatBytes(model.bytes)}) — ${model.license} — ${model.source}`;
      ul.appendChild(li);
    }
  }

  /**
   * Footer version badge (#app-version) + the once-per-boot console echo for
   * support diagnostics — the exact shipped build, copied verbatim from the
   * badge into bug reports.
   */
  function renderVersionBadge() {
    const badge = formatVersionBadge({ version: APP_VERSION, buildDate: BUILD_DATE });
    if (els.appVersion) els.appVersion.textContent = badge;
    console.info(`video-redact ${badge} — all processing stays on this device`);
  }

  /** AC-14 crash-recovery sweep: offer deletion of orphaned export temps. */
  async function sweepExportTemps() {
    /** @type {string[]} */
    let names = [];
    try {
      const root = await globalThis.navigator?.storage?.getDirectory?.();
      if (!root) return;
      const dir = await root.getDirectoryHandle(STAGING_DIR);
      if (typeof dir.entries !== 'function') return;
      // Runtime entries() yields [name, kind-string]; lib.dom types the
      // second slot as FileSystemHandle — align the iteration with runtime.
      for await (const [name, kind] of /** @type {AsyncIterableIterator<[string, string]>} */ (dir.entries())) {
        if (kind === 'file' && String(name).startsWith(STAGING_PREFIX)) names.push(String(name));
      }
    } catch {
      return; // no OPFS or no exports/ dir — nothing to recover
    }
    if (names.length === 0) return;
    toast(`Found ${names.length} unfinished export file(s) from a previous session.`, {
      kind: 'error',
      timeoutMs: 0, // dismissible only via its buttons
      actions: [
        {
          label: 'Delete',
          onClick: () => {
            void (async () => {
              let removed = 0;
              for (const name of names) {
                try {
                  if (await discardExportTemp(`${STAGING_DIR}/${name}`)) removed += 1;
                } catch (err) {
                  toast(
                    `Could not delete ${name}: ${err instanceof Error ? err.message : String(err)}`,
                    { kind: 'error', timeoutMs: 8000 },
                  );
                }
              }
              toast(`Deleted ${removed} leftover export file(s).`, { kind: 'ok' });
            })();
          },
        },
        { label: 'Dismiss', onClick: () => {} },
      ],
    });
  }

  // --- Capability report render -------------------------------------------------

  function renderCapReport(meta, caps) {
    if (!els.capReport) return;
    const summary = metaSummaryRows(meta);
    // AC-17: the inference-provider policy row (Inference: WebGPU accelerated
    // / CPU (WASM) — reason) sits between the file summary and the probes.
    const inference = inferenceRow(caps);
    const probes = renderProbeRows(caps).rows;
    const rows = [...summary, ...(inference ? [inference] : []), ...probes];
    if (rows.length === 0) {
      els.capReport.hidden = true;
      if (els.capTable) els.capTable.textContent = '';
      return;
    }
    els.capReport.hidden = false;
    if (!els.capTable) return;
    els.capTable.textContent = '';
    for (const row of rows) {
      const tr = doc.createElement('tr');
      const tdLabel = doc.createElement('td');
      tdLabel.textContent = row.label;
      const tdValue = doc.createElement('td');
      tdValue.textContent = 'ok' in row ? row.detail : row.value;
      if ('ok' in row) tdValue.classList.add(row.ok ? 'cap-ok' : 'cap-block');
      tr.append(tdLabel, tdValue);
      els.capTable.appendChild(tr);
    }
  }

  function renderGuidance(g, caps) {
    if (!els.capGuidance) return;
    const lines = [...(g?.messages ?? []), ...(caps?.warnings ?? [])];
    if (lines.length === 0) {
      els.capGuidance.hidden = true;
      els.capGuidance.textContent = '';
      return;
    }
    els.capGuidance.hidden = false;
    els.capGuidance.style.whiteSpace = 'pre-line';
    els.capGuidance.textContent = lines.join('\n');
  }

  // --- File intake (REQ-001; fresh AppState per file) ---------------------------

  async function handleFile(file) {
    // Opening a new file aborts any in-flight pass; its callbacks are
    // dropped by the generation check.
    if (app.step === 'analyzing') analyzeCtl?.abort();
    if (app.step === 'exporting') exportCtl?.abort();
    const gen = ++app.gen;

    // Fresh AppState: tear down the editor, revoke the old preview URL.
    editor?.destroy();
    editor = null;
    if (app.objectUrl) URL.revokeObjectURL(app.objectUrl);
    app.file = file;
    app.input = null;
    app.meta = null;
    app.caps = null;
    app.tracks = [];
    app.manualNextId = 1;
    // Transport resets with the fresh file (load() resets playbackRate; the
    // selectors must follow or they would show a rate the video no longer has).
    if (els.video) els.video.playbackRate = 1;
    syncSpeedSelects();
    resetAnalyzeUi();
    resetExportUi();
    refreshTrackUi();

    if (!els.fileInput) return;
    try {
      const { input, meta } = await openInput(file);
      if (gen !== app.gen) return;
      const caps = await probeCapabilities(input);
      if (gen !== app.gen) return;
      app.input = input;
      app.meta = meta;
      app.caps = caps;

      // REQ-114: default the compare frame time to round(duration·0.1),
      // bounded by the (new) duration; stale panels from a previous file go.
      if (els.compareTime) {
        const dur = Number.isFinite(meta.duration) && meta.duration > 0 ? meta.duration : 0;
        els.compareTime.max = String(dur);
        els.compareTime.value = String(Math.round(dur * 0.1 * 10) / 10);
      }
      if (els.thresholdPanels) els.thresholdPanels.replaceChildren();
      if (els.compareStatus) els.compareStatus.textContent = '';

      // Blob preview source (media-src blob: is CSP-allowed; bytes stay local).
      if (els.video) {
        app.objectUrl = URL.createObjectURL(file);
        els.video.src = app.objectUrl;
        els.video.load();
      }

      renderCapReport(meta, caps);
      const g = guidance(caps);
      renderGuidance(g, caps);

      const next = deriveStep(app.step, 'FILE_OPENED') ?? 'ready';
      app.step = next;
      applyStepper();
      updateButtons();
      showWorkspace();
      toast(
        `Opened ${file.name} — ${meta.container}, ${meta.displayWidth}×${meta.displayHeight}` +
          (caps.canAnalyze ? '' : ' — video decode unavailable, see capability report'),
        { kind: caps.canAnalyze ? 'ok' : 'error', timeoutMs: 6000 },
      );
    } catch (err) {
      if (gen !== app.gen) return;
      const message = describeIngestFailure(err);
      app.input = null;
      app.meta = null;
      app.caps = null;
      renderCapReport(null, null);
      renderGuidance({ messages: [message] }, null);
      toast(message, { kind: 'error', timeoutMs: 8000 });
      // Previous state was already cleared — fall back to the intake gate.
      app.step = 'gate';
      applyStepper();
      updateButtons();
      showIntake();
    }
  }

  if (els.dropZone) {
    els.dropZone.addEventListener('click', () => els.fileInput?.click());
    els.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        els.fileInput?.click();
      }
    });
    els.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.dropZone?.classList.add('dragover');
    });
    els.dropZone.addEventListener('dragleave', () => els.dropZone?.classList.remove('dragover'));
    els.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.dropZone?.classList.remove('dragover');
      const file = /** @type {DragEvent} */ (e).dataTransfer?.files?.[0];
      if (file) void handleFile(file);
    });
  }
  if (els.fileInput) {
    // Programmatic .click() from the drop zone bubbles — stop it or loop.
    els.fileInput.addEventListener('click', (e) => e.stopPropagation());
    els.fileInput.addEventListener('change', () => {
      const file = els.fileInput?.files?.[0];
      if (file) void handleFile(file);
      if (els.fileInput) els.fileInput.value = '';
    });
  }
  els.changeFile?.addEventListener('click', () => els.fileInput?.click());
  blurAfterClick(els.changeFile);

  // --- Clear (v1.6.0): full unload & reset back to the landing view ----------
  //
  // Teardown checklist (in order):
  //   a. abort in-flight analyze/export + bump app.gen (stale callbacks drop);
  //   b. editor.destroy() — cancels the rVFC/rAF preview loop, removes every
  //      editor listener (timeline, track list, canvas drag, Escape);
  //   c. media unload — revoke the blob URL, video.removeAttribute('src') +
  //      video.load() (frees the decoder, currentTime → 0), dispose the
  //      mediabunny Input, drop app.file/input/meta/caps/tracks references;
  //   d. OPFS hygiene — sweep leftover exports/redact-export-* temps;
  //   e. #file-input.value = '' — re-selecting the SAME file re-fires change;
  //   f. UI reset — stepper → gate ('CLEAR' transition), capability report,
  //      analyze panel (sliders via DEFAULT_SETTINGS, dashcam, progress,
  //      status, compare), track list + timeline, export panel, transport,
  //      fullscreen/zoom, toasts, back to the intake view;
  //   g. confirmation toast.
  //   SURVIVES: the model cache (IndexedDB — clearModelCache is deliberately
  //   NOT used), the preview-stage height, the version badge, the model
  //   attribution panel.

  /**
   * OPFS hygiene for an explicit clear (v1.6.0): silently delete any leftover
   * `exports/redact-export-*` temp — the AC-14 crash sweep's delete path
   * without the prompt (REQ-019 hygiene applies on clear too).
   */
  async function purgeExportTemps() {
    try {
      const root = await globalThis.navigator?.storage?.getDirectory?.();
      if (!root) return;
      const dir = await root.getDirectoryHandle(STAGING_DIR);
      if (typeof dir.entries !== 'function') return;
      for await (const [name, kind] of /** @type {AsyncIterableIterator<[string, string]>} */ (dir.entries())) {
        if (kind !== 'file' || !String(name).startsWith(STAGING_PREFIX)) continue;
        try {
          await discardExportTemp(`${STAGING_DIR}/${name}`);
        } catch {
          /* a stuck temp must never block a clear */
        }
      }
    } catch {
      /* no OPFS or no exports/ dir — nothing to clean */
    }
  }

  /**
   * Push a settings object into the analyze-panel controls (sliders, live
   * readouts, dashcam toggle). DOM-side helper shared by the initial mount
   * state and clearAll — both start from DEFAULT_SETTINGS().
   * @param {{confFace: number, confPlate: number, dashcamMode: boolean}} settings
   */
  function applySettings(settings) {
    if (els.confFace) els.confFace.value = String(settings.confFace);
    if (els.confPlate) els.confPlate.value = String(settings.confPlate);
    if (els.dashcamToggle) els.dashcamToggle.checked = settings.dashcamMode === true;
    syncThresholdReadouts();
  }

  function clearAll() {
    // (a) In-flight work dies FIRST: abort the passes, then bump the
    // generation so every stale async completion (analyze, export, compare)
    // drops silently instead of touching the reset UI.
    if (app.step === 'analyzing') analyzeCtl?.abort();
    if (app.step === 'exporting') exportCtl?.abort();
    analyzeCtl = null;
    exportCtl = null;
    app.gen += 1;

    // (b) Editor teardown: cancels the preview frame loop and detaches every
    // editor-side listener before the media element is unloaded.
    editor?.destroy();
    editor = null;

    // (c) Media unload: free the decoder + the blob, drop all file state.
    if (app.objectUrl) {
      URL.revokeObjectURL(app.objectUrl);
      app.objectUrl = null;
    }
    const v = els.video;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load(); // empty resource selection: frees the decoder, resets time
      v.playbackRate = 1;
    }
    // mediabunny Input.dispose() cancels in-flight reads and closes decoders
    // (verified in node_modules/mediabunny .d.ts); degrade to a plain
    // reference drop if a future build drops the method.
    const input = /** @type {{dispose?: () => void} | null} */ (app.input);
    if (input && typeof input.dispose === 'function') {
      try {
        input.dispose();
      } catch {
        /* already disposed / racing the abort — the drop is what matters */
      }
    }
    app.input = null;
    app.file = null;
    app.meta = null;
    app.caps = null;
    app.tracks = [];
    app.manualNextId = 1;

    // (d) OPFS hygiene (REQ-019/AC-14 on explicit clear).
    void purgeExportTemps();

    // (e) Without this, re-selecting the SAME file never fires `change`.
    if (els.fileInput && fileInputNeedsReset(els.fileInput.value)) {
      els.fileInput.value = '';
    }

    // (f) UI reset — the exact landing view.
    app.step = deriveStep(app.step, 'CLEAR') ?? 'gate';
    applyStepper();
    updateButtons();
    applySettings(DEFAULT_SETTINGS());
    resetAnalyzeUi();
    resetExportUi();
    if (els.trackList) els.trackList.textContent = '';
    if (els.chips) els.chips.replaceChildren();
    if (els.playhead) els.playhead.style.left = '0%';
    refreshTrackUi(); // the "No tracks yet" hint returns
    renderCapReport(null, null); // hides + empties the capability report
    renderGuidance({ messages: [] }, null); // hides + empties the guidance
    if (els.thresholdPanels) els.thresholdPanels.replaceChildren();
    if (els.compareStatus) els.compareStatus.textContent = '';
    if (els.compareTime) {
      els.compareTime.max = '0';
      els.compareTime.value = '0';
    }
    syncSpeedSelects();
    updateTransportUi(); // pause glyph, 1× selectors, 0:00.0 timecodes
    exitPreview(); // leave fullscreen/zoom if the stage was enlarged
    if (els.toastRegion) els.toastRegion.replaceChildren();
    showIntake();

    // (g) Confirmation. The model attribution panel is untouched.
    toast('Cleared — ready for the next video.', { kind: 'ok' });
  }

  els.clearFile?.addEventListener('click', () => clearAll());
  blurAfterClick(els.clearFile);

  // --- Analyze pass (REQ-009 / AC-03) --------------------------------------------

  function startAnalyze() {
    if (deriveStep(app.step, 'ANALYZE_START') == null || !app.input || !app.meta) return;
    const gen = ++app.gen;

    // Re-analyze replaces the review state (tracks + editor).
    editor?.destroy();
    editor = null;
    app.tracks = [];
    if (els.trackList) els.trackList.textContent = '';
    refreshTrackUi();
    resetAnalyzeUi();
    resetExportUi();
    app.step = 'analyzing';
    applyStepper();
    updateButtons();

    // REQ-113: the sensitivity sliders drive the analyze pass (and every
    // re-analyze); absent/invalid sliders → omitted → detector defaults.
    const settings = { dashcamMode: els.dashcamToggle?.checked === true };
    const confFace = Number(els.confFace?.value);
    const confPlate = Number(els.confPlate?.value);
    if (Number.isFinite(confFace)) settings.confFace = confFace;
    if (Number.isFinite(confPlate)) settings.confPlate = confPlate;
    // epPolicy seam (ADR-5): force ['wasm'] when the capability report says
    // so (WebKit); otherwise OMIT so detector.js keeps its full webgpu→wasm
    // ladder (AC-17) instead of a single-entry override.
    if (app.caps?.epPolicy === 'wasm') settings.epPolicy = ['wasm'];

    const ctl = new AbortController();
    analyzeCtl = ctl;
    let lastPaint = 0;
    // A FAILED run does not bump app.gen (only starting the NEXT run does),
    // so late model-progress callbacks from this same run would pass the
    // generation check below and overwrite the terminal "Analysis failed"
    // status. `settled` freezes progress rendering once the run resolves.
    let settled = false;

    runAnalyze({
      input: app.input,
      meta: app.meta,
      settings,
      signal: ctl.signal,
      onProgress: (evt) => {
        if (settled || gen !== app.gen || !evt) return;
        const now = Date.now();
        if (now - lastPaint < 100) return; // events fire per frame — throttle UI
        lastPaint = now;
        if (evt.phase === 'models') {
          setBar(els.analyzeBar, null);
          if (els.analyzeStatus) {
            const model = typeof evt.model === 'string' ? evt.model : 'models';
            const pct = Number.isFinite(evt.fraction) ? ` ${Math.round(evt.fraction * 100)}%` : '';
            els.analyzeStatus.textContent = `Loading model: ${model}${pct}`;
          }
        } else if (evt.phase === 'analyze') {
          setBar(els.analyzeBar, evt.totalFrames ? evt.frameCount / evt.totalFrames : null);
          if (els.analyzeFrames) els.analyzeFrames.textContent = String(evt.frameCount);
          if (els.analyzeTotal) {
            els.analyzeTotal.textContent = evt.totalFrames != null ? String(evt.totalFrames) : '—';
          }
          if (els.analyzeFps) {
            els.analyzeFps.textContent = evt.analyzeFps != null ? evt.analyzeFps.toFixed(1) : '—';
          }
          if (els.analyzeEta) els.analyzeEta.textContent = formatEta(evt.etaSec);
          if (els.analyzeStatus) {
            els.analyzeStatus.textContent = `${evt.trackCount} track(s) found`;
          }
        }
      },
    })
      .then((result) => {
        settled = true;
        if (gen !== app.gen) return;
        requestPersistentStorage();
        enterReview(result);
      })
      .catch((err) => {
        settled = true;
        if (gen !== app.gen) return;
        app.step = deriveStep('analyzing', 'ANALYZE_FAIL') ?? 'ready';
        applyStepper();
        updateButtons();
        const message = `Analysis failed: ${err instanceof Error ? err.message : String(err)}`;
        if (els.analyzeStatus) els.analyzeStatus.textContent = message;
        toast(message, { kind: 'error', timeoutMs: 8000 });
      })
      .finally(() => {
        if (gen === app.gen) analyzeCtl = null;
      });
  }

  /** Enter review: mount the editor, render tracks (AC-03 includes partial). */
  function enterReview(result) {
    if (app.step !== 'analyzing') return;
    app.tracks = Array.isArray(result?.tracks) ? result.tracks : [];
    // Manual ids must never collide with tracker-assigned auto ids.
    app.manualNextId = app.tracks.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0) + 1;

    const next = deriveStep('analyzing', 'ANALYZE_FINISH');
    if (next == null) return;
    app.step = next;
    applyStepper();
    updateButtons();

    editor?.destroy();
    editor = mountEditor(
      {
        video: els.video,
        overlayCanvas: els.overlayCanvas,
        timeline: els.timeline,
        chipsContainer: els.chips,
        playhead: els.playhead,
        trackList: els.trackList,
      },
      {
        getState: () => ({ tracks: app.tracks, currentTime: els.video?.currentTime ?? 0 }),
        onToggle: (trackId, enabled) => {
          app.tracks = toggleTrack(app.tracks, trackId, enabled);
          refreshTrackUi();
        },
        onSeek: (t) => {
          const v = els.video;
          if (!v) return;
          const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
          v.currentTime = Math.min(Math.max(0, t), dur);
        },
        onManualBox: (box, t) => {
          const track = manualTrackFromBox(app.manualNextId, t, box, app.meta?.duration);
          app.manualNextId += 1;
          app.tracks = [...app.tracks, track];
          refreshTrackUi();
        },
        onTrimTrack: (trackId, start, end) => {
          // REQ-103: chip-edge drag → model trim, clamped to the video
          // duration with the 0.1 s minimum span enforced by the model.
          app.tracks = trimTrack(app.tracks, trackId, start, end, app.meta?.duration);
          refreshTrackUi();
        },
        onSetStyle: (trackId, style) => {
          // REQ-101: per-track redaction style; the shared burn-in seam
          // (redact.pixelateFrame) dispatches on it for preview AND export.
          app.tracks = setTrackStyle(app.tracks, trackId, style);
          refreshTrackUi();
        },
        // v1.7.0: the timeline scrub thumb's ←/→ keys step ±1 frame through the
        // SAME stepFrame math as the transport buttons (source fps via app.meta).
        onStepFrame: stepFrame,
      },
    );
    refreshTrackUi();

    // AC-17: surface the ACTIVE provider (createDetectors' effective EP —
    // honest post-fallback fact) as the status-line suffix.
    const ep = epLabel(result?.effectiveEp);
    const summary =
      `${app.tracks.length} track(s) from ${result?.frameCount ?? 0} frames` +
      (ep ? ` · ${ep}` : '');
    if (els.analyzeStatus) {
      els.analyzeStatus.textContent = result?.cancelled ? `Cancelled — ${summary}` : summary;
    }
    toast(
      result?.cancelled
        ? `Analysis cancelled — showing ${app.tracks.length} track(s) found so far.`
        : `Analysis complete — ${app.tracks.length} track(s) found.`,
      { kind: result?.cancelled ? '' : 'ok' },
    );
  }

  els.analyzeButton?.addEventListener('click', () => startAnalyze());
  blurAfterClick(els.analyzeButton);
  els.analyzeCancel?.addEventListener('click', () => analyzeCtl?.abort());
  blurAfterClick(els.analyzeCancel);

  // --- Detection sensitivity + single-frame threshold compare (REQ-113/114) ----

  /** Live numeric readouts for the two sensitivity sliders. */
  function syncThresholdReadouts() {
    const fmt = (slider, out, range) => {
      if (!slider || !out) return;
      const v = Number(slider.value);
      out.textContent = Number.isFinite(v) ? v.toFixed(2) : range.default.toFixed(2);
    };
    fmt(els.confFace, els.confFaceOut, THRESHOLD_FACE_RANGE);
    fmt(els.confPlate, els.confPlateOut, THRESHOLD_PLATE_RANGE);
  }
  els.confFace?.addEventListener('input', syncThresholdReadouts);
  els.confPlate?.addEventListener('input', syncThresholdReadouts);
  syncThresholdReadouts();

  /**
   * Apply a clicked panel's level to BOTH sliders (REQ-114), readouts
   * following. The pure mapping (applyThresholdLevel) clamps per range.
   */
  function applyLevelToSliders(level) {
    const next = applyThresholdLevel(level);
    if (els.confFace) els.confFace.value = String(next.confFace);
    if (els.confPlate) els.confPlate.value = String(next.confPlate);
    syncThresholdReadouts();
  }

  /**
   * Render the 5 compare panels from ONE decode per model: counts via the
   * pure buildThresholdPanels view model, boxes drawn in display coords
   * scaled to each panel canvas (faces teal, plates violet — the app's
   * track-1/track-2 palette).
   */
  function renderThresholdPanels({ outputs, geom, rows, dims, sample }) {
    if (!els.thresholdPanels) return;
    const faces = decodeYunetOutputs(outputs, undefined, geom, { confThreshold: 0 });
    const plates = parsePlateRows(rows, dims, geom, { confThreshold: 0 });
    const panels = buildThresholdPanels(THRESHOLD_LEVELS, faces, plates);

    const dispW = Number(sample.width) || 1;
    const dispH = Number(sample.height) || 1;
    const panelW = Math.max(
      60,
      Math.round((els.analyzePanel?.clientWidth ?? 320) * THRESHOLD_PANEL_FRACTION),
    );
    const panelH = Math.max(1, Math.round((panelW * dispH) / dispW));

    // Scratch raster at the sampled size; each panel drawImage-scales it.
    const scratchCanvas = doc.createElement('canvas');
    scratchCanvas.width = dispW;
    scratchCanvas.height = dispH;
    const sctx = scratchCanvas.getContext('2d');
    sctx?.putImageData(/** @type {ImageData} */ (sample.imageDataLike), 0, 0);

    const frag = doc.createDocumentFragment();
    for (const vm of panels) {
      const canvas = doc.createElement('canvas');
      canvas.width = panelW;
      canvas.height = panelH;
      const cctx = canvas.getContext('2d');
      if (cctx) {
        cctx.drawImage(scratchCanvas, 0, 0, panelW, panelH);
        const sx = panelW / dispW;
        const sy = panelH / dispH;
        cctx.lineWidth = 2;
        cctx.strokeStyle = '#2DD4BF'; // teal — faces (track palette slot 1)
        for (const d of faces) {
          if (d.conf < vm.level) continue;
          cctx.strokeRect(d.box.x * sx, d.box.y * sy, d.box.w * sx, d.box.h * sy);
        }
        cctx.strokeStyle = '#A78BFA'; // violet — plates (track palette slot 2)
        for (const d of plates) {
          if (d.conf < vm.level) continue;
          cctx.strokeRect(d.box.x * sx, d.box.y * sy, d.box.w * sx, d.box.h * sy);
        }
      }
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'threshold-panel';
      item.title = `Use ≥${vm.level.toFixed(2)} for both sensitivity sliders`;
      const cap = doc.createElement('span');
      cap.className = 'caption';
      cap.textContent = formatThresholdCaption(vm);
      item.append(canvas, cap);
      item.addEventListener('click', () => applyLevelToSliders(vm.level));
      // v1.6.1 REG-2: the panel is a <button> — release focus after the click
      // so the doc-level transport shortcuts keep working.
      item.addEventListener('click', () => item.blur());
      frag.appendChild(item);
    }
    els.thresholdPanels.replaceChildren(frag);
  }

  let comparing = false;

  /**
   * Single-frame threshold comparison (REQ-114): decode ONE sample at the
   * chosen time (sampleFrameAt), run each model EXACTLY once (raw
   * accessors), render the fixed-level panels. Progress/busy state on the
   * button; failures surface via toast (REQ-021 pattern).
   */
  async function runThresholdCompare() {
    if (comparing || !app.input || !app.meta) return;
    const gen = app.gen; // drop stale results if the file changes mid-compare
    const dur = Number(app.meta.duration);
    const raw = Number(els.compareTime?.value);
    const requested = Number.isFinite(raw) ? raw : 0;
    const max = Number.isFinite(dur) && dur > 0 ? dur : Math.max(0, requested);
    const t = Math.min(Math.max(0, requested), max);

    comparing = true;
    const btn = els.compareButton;
    const label = btn?.textContent ?? 'Compare thresholds';
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Comparing…';
    }
    if (els.compareStatus) els.compareStatus.textContent = 'Decoding one frame…';
    try {
      const sample = await sampleFrameAt(app.input, t);
      if (gen !== app.gen) return;
      if (els.compareStatus) els.compareStatus.textContent = 'Running the models once…';
      const detectors = await createDetectors(
        app.caps?.epPolicy === 'wasm' ? { epPolicy: ['wasm'] } : {},
      );
      try {
        const { outputs, geom } = await detectors.detectFaceRaw(sample.imageDataLike);
        const { rows, dims } = await detectors.detectPlateRaw(sample.imageDataLike);
        if (gen !== app.gen) return;
        renderThresholdPanels({ outputs, geom, rows, dims, sample });
        if (els.compareStatus) {
          els.compareStatus.textContent =
            `Frame at ${formatClock(sample.t)} — click a level to apply it to both sliders.`;
        }
      } finally {
        detectors.close();
      }
    } catch (err) {
      if (gen !== app.gen) return;
      const message = `Threshold comparison failed: ${err instanceof Error ? err.message : String(err)}`;
      if (els.compareStatus) els.compareStatus.textContent = 'Comparison failed — see the notice.';
      toast(message, { kind: 'error', timeoutMs: 8000 });
    } finally {
      comparing = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }
  els.compareButton?.addEventListener('click', () => void runThresholdCompare());
  blurAfterClick(els.compareButton);

  // --- Export (REQ-017/018/019/021) -----------------------------------------------

  function startExport() {
    if (deriveStep(app.step, 'EXPORT_START') == null || !app.input) return;
    const gen = ++app.gen;
    resetExportUi();
    app.step = 'exporting';
    applyStepper();
    updateButtons();

    const ctl = new AbortController();
    exportCtl = ctl;
    runExport({
      input: app.input,
      tracks: app.tracks,
      settings: {
        quality: els.quality?.value === 'balanced' ? 'balanced' : 'high',
        outputMode: 'stream', // OPFS staging; delivery handled inside runExport
      },
      signal: ctl.signal,
      onProgress: (p) => {
        if (gen !== app.gen || !p) return;
        setBar(els.exportBar, p.ratio);
        if (els.exportStatus && Number.isFinite(p.bytesWritten)) {
          els.exportStatus.textContent = `${formatBytes(p.bytesWritten)} written`;
        }
      },
    })
      .then((result) => {
        if (gen !== app.gen) return;
        const next = deriveStep('exporting', 'EXPORT_DONE');
        if (next == null) return;
        app.step = next;
        applyStepper();
        updateButtons();
        setBar(els.exportBar, 1);
        const detail = result?.handle?.name
          ? `saved as ${result.handle.name}`
          : result?.blob
            ? `download started (${formatBytes(result.bytes)})`
            : `done (${formatBytes(result?.bytes)})`;
        if (els.exportStatus) els.exportStatus.textContent = `Exported — ${detail}`;
        toast(`Exported — ${detail}`, { kind: 'ok' });
      })
      .catch((err) => {
        if (gen !== app.gen) return;
        const next = deriveStep('exporting', 'EXPORT_FAIL') ?? 'review';
        app.step = next;
        applyStepper();
        updateButtons();
        const cancelled = (err instanceof ExportError && err.stage === 'cancelled') || ctl.signal.aborted;
        setBar(els.exportBar, 0);
        if (cancelled) {
          if (els.exportStatus) els.exportStatus.textContent = 'Export cancelled.';
          toast('Export cancelled — no file was written.', {});
        } else {
          // REQ-021 observability: the friendly message hides the underlying
          // cause — always keep it in the console for diagnosis/support.
          console.error('[export-failed]', err instanceof ExportError ? err.stage : 'unknown', err);
          const message = err instanceof ExportError
            ? mapExportErrorToMessage(err.stage)
            : `Export failed: ${err instanceof Error ? err.message : String(err)}`;
          if (els.exportStatus) els.exportStatus.textContent = message;
          toast(message, { kind: 'error', timeoutMs: 8000 });
        }
      })
      .finally(() => {
        if (gen === app.gen) exportCtl = null;
      });
  }

  els.exportButton?.addEventListener('click', () => startExport());
  blurAfterClick(els.exportButton);
  els.exportCancel?.addEventListener('click', () => exportCtl?.abort());
  blurAfterClick(els.exportCancel);

  // --- Transport (SPEC-VID-002 REQ-105 / AC-104; v1.4.0 REQ-111) ---------------

  /**
   * One transport UI refresh from the live video element: play/pause glyph
   * swap (BOTH bars — bottom transport + fullscreen overlay), speed selectors
   * synced to the live rate, and current/total timecode (formatClock). Driven
   * by the media events below so it works in EVERY workspace state (editor
   * mount is review-only).
   */
  function updateTransportUi() {
    const v = els.video;
    if (!v) return;
    const paused = v.paused;
    const glyph = transportGlyph(paused);
    if (els.transportPlay) {
      els.transportPlay.textContent = glyph;
      els.transportPlay.title = paused ? 'Play (space)' : 'Pause (space)';
      els.transportPlay.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    }
    if (els.ovPlay) {
      els.ovPlay.textContent = glyph;
      els.ovPlay.title = paused ? 'Play (space)' : 'Pause (space)';
      els.ovPlay.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    }
    syncSpeedSelects();
    const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (els.transportTime) els.transportTime.textContent = `${formatClock(cur)} / ${formatClock(dur)}`;
    if (els.timelineCurrent) els.timelineCurrent.textContent = formatClock(cur);
    if (els.timelineDuration) els.timelineDuration.textContent = formatClock(dur);
  }

  /** Keep BOTH speed selectors on the video's live playbackRate. */
  function syncSpeedSelects() {
    const rate = normalizePlaybackRate(els.video ? els.video.playbackRate : 1);
    const value = String(rate);
    if (els.transportSpeed) els.transportSpeed.value = value;
    if (els.ovSpeed) els.ovSpeed.value = value;
  }

  /** Shared play/pause toggle — bottom bar, overlay bar and Space all call it. */
  function togglePlay() {
    const v = els.video;
    if (!v) return;
    if (v.paused) {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      v.pause();
    }
  }

  /** Frame-step ±1 source frame (same semantics as the ← / → shortcuts). */
  function stepFrame(direction) {
    const v = els.video;
    if (!v) return;
    const fps = Number(app.meta?.fps);
    const dt = direction / (fps > 0 ? fps : 30);
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    v.pause();
    v.currentTime = Math.min(Math.max(0, v.currentTime + dt), dur);
  }

  /** Shared speed set — both selectors route here and re-sync together. */
  function setSpeed(rate) {
    const v = els.video;
    if (!v) return;
    v.playbackRate = normalizePlaybackRate(rate);
    syncSpeedSelects();
  }

  els.transportStart?.addEventListener('click', () => {
    const v = els.video;
    if (v) v.currentTime = 0;
  });
  els.transportBack?.addEventListener('click', () => stepFrame(-1));
  els.transportFwd?.addEventListener('click', () => stepFrame(1));
  els.transportPlay?.addEventListener('click', () => togglePlay());
  els.transportSpeed?.addEventListener('change', () => setSpeed(els.transportSpeed?.value));
  // v1.4.0 REQ-111: the overlay bar calls the SAME shared actions.
  els.ovBack?.addEventListener('click', () => stepFrame(-1));
  els.ovFwd?.addEventListener('click', () => stepFrame(1));
  els.ovPlay?.addEventListener('click', () => togglePlay());
  els.ovSpeed?.addEventListener('change', () => setSpeed(els.ovSpeed?.value));
  els.ovExit?.addEventListener('click', () => exitPreview());
  // v1.6.1 REG-2: every transport/overlay control releases focus after pointer
  // activation (buttons on click, selects on the committed change) so the
  // doc-level shortcuts keep working after clicking ANY control.
  blurAfterClick(els.transportStart);
  blurAfterClick(els.transportBack);
  blurAfterClick(els.transportFwd);
  blurAfterClick(els.transportPlay);
  blurAfterChange(els.transportSpeed);
  blurAfterClick(els.ovBack);
  blurAfterClick(els.ovFwd);
  blurAfterClick(els.ovPlay);
  blurAfterChange(els.ovSpeed);
  blurAfterClick(els.ovExit);
  for (const ev of ['play', 'pause', 'timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'ratechange']) {
    els.video?.addEventListener(ev, updateTransportUi);
  }
  updateTransportUi();

  // --- Fullscreen / enlarge preview (SPEC-VID-002 REQ-106 / AC-105;
  //     v1.4.0 REQ-111 in-stage overlay controls) --------------------------------

  const isNativeFullscreen = () => doc.fullscreenElement === els.previewStage;
  const isZoomFallback = () =>
    !!els.previewStage && els.previewStage.classList.contains('preview-zoom');

  function updateFullscreenButton() {
    if (!els.fullscreenButton) return;
    const active = isNativeFullscreen() || isZoomFallback();
    els.fullscreenButton.textContent = active ? '✕' : '⛶';
    els.fullscreenButton.title = active ? 'Exit enlarged preview (Esc)' : 'Enlarge preview';
    els.fullscreenButton.setAttribute('aria-label', active ? 'Exit enlarged preview' : 'Enlarge preview');
  }

  /** Kick the editor's resize path: overlay canvas → new display size × DPR. */
  function triggerPreviewResize() {
    if (editor && typeof editor.redraw === 'function') editor.redraw();
  }

  function enterZoomFallback() {
    // iOS Safari & co: no Fullscreen API for elements — cover the viewport
    // in-page instead (REQ-106). The overlay bar (REQ-111) carries the exit.
    els.previewStage?.classList.add('preview-zoom');
    updateFullscreenButton();
    triggerPreviewResize();
    showOverlayControls(); // enter → visible, idle timer starts
  }

  /** Exit fullscreen / turn the zoom fallback off (shared exit path). */
  function exitPreview() {
    if (isNativeFullscreen()) {
      const p = doc.exitFullscreen?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      els.previewStage?.classList.remove('preview-zoom');
      updateFullscreenButton();
      triggerPreviewResize();
    }
    hideOverlayControls(); // reset: next enter re-shows from scratch
  }

  // --- Overlay control-bar auto-hide (REQ-111): the .stage-overlay-controls
  //     bar is display:flex only in fullscreen/zoom (index.html CSS); the
  //     .controls-idle class fades it out after OVERLAY_HIDE_MS of no
  //     pointer/touch activity inside the stage. Any pointerdown/enter/move
  //     or touchstart on the stage removes it again (and the bar itself
  //     re-shows on interaction because idle sets pointer-events:none).

  /** @type {ReturnType<typeof setTimeout> | null} */
  let overlayHideTimer = null;

  /** True while the stage fills the screen (either enlarge mode). */
  const overlayActive = () => isNativeFullscreen() || isZoomFallback();

  /** Re-show the overlay bar and restart the ~3 s idle timer. */
  function showOverlayControls() {
    if (!els.previewStage) return;
    els.previewStage.classList.remove('controls-idle');
    if (overlayHideTimer !== null) {
      clearTimeout(overlayHideTimer);
      overlayHideTimer = null;
    }
    if (!overlayActive()) return; // bar not displayed — nothing to auto-hide
    overlayHideTimer = setTimeout(() => {
      overlayHideTimer = null;
      els.previewStage?.classList.add('controls-idle');
    }, OVERLAY_HIDE_MS);
  }

  /** Hide the bar now and stop the timer (exit path / re-arm on next enter). */
  function hideOverlayControls() {
    if (overlayHideTimer !== null) {
      clearTimeout(overlayHideTimer);
      overlayHideTimer = null;
    }
    els.previewStage?.classList.add('controls-idle');
  }

  // Player-style activity surface: the bar fades only while the pointer is
  // still and reappears on ANY interaction with the enlarged stage. The
  // listeners are attached unconditionally — outside fullscreen/zoom the bar
  // is display:none, so the class toggle has no visual effect.
  for (const ev of ['pointerenter', 'pointermove', 'pointerdown', 'touchstart']) {
    els.previewStage?.addEventListener(ev, showOverlayControls);
  }

  els.fullscreenButton?.addEventListener('click', () => {
    if (isNativeFullscreen() || isZoomFallback()) {
      exitPreview();
      return;
    }
    const stage = els.previewStage;
    if (stage && typeof /** @type {any} */ (stage).requestFullscreen === 'function') {
      const p = /** @type {any} */ (stage).requestFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => enterZoomFallback());
    } else {
      enterZoomFallback();
    }
  });
  // v1.6.1 REG-2: do NOT blur here unconditionally — inside NATIVE fullscreen,
  // focus must stay within the fullscreen element (blurring to <body> is
  // blocked/unfocusable), and the button is the fullscreen tree's focus anchor.
  // The Space path is safe instead: the doc handler preventDefaults Space so
  // the focused button can never re-activate (no accidental exit).
  if (els.fullscreenButton) {
    els.fullscreenButton.addEventListener('click', () => {
      if (!isNativeFullscreen()) els.fullscreenButton?.blur(); // zoom fallback + plain view → body
    });
  }
  doc.addEventListener('fullscreenchange', () => {
    updateFullscreenButton();
    triggerPreviewResize();
    // REQ-111: entering fullscreen re-shows the controls with a fresh idle
    // timer; leaving resets them (hidden until the next enter/activity).
    if (overlayActive()) showOverlayControls();
    else hideOverlayControls();
  });
  window.addEventListener('resize', () => {
    // v1.2.0: re-clamp the stage against the new viewport (75vh bound) —
    // applyStageHeight ends in the same redraw kick as before.
    applyStageHeight(stageHeight);
  });
  // Escape exits the in-page fallback (native fullscreen gets it for free).
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isZoomFallback()) exitPreview();
  });
  updateFullscreenButton();

  // --- Stage height resize (v1.2.0 #stage-resize-handle) -------------------------

  /**
   * Viewport height the 75vh clamp runs against; 0 (→ unbounded max inside
   * clampStageHeight) when innerHeight is unavailable.
   */
  function stageViewportH() {
    const h = doc.defaultView ? doc.defaultView.innerHeight : NaN;
    return Number.isFinite(h) && h > 0 ? h : 0;
  }

  /**
   * v1.6.1 REG-3: vertical space AROUND the stage that must stay visible —
   * everything ABOVE the stage in the document (header, intake/capability
   * panel on the stacked mobile layout, #app-main top padding — captured by
   * the stage's document-relative top), everything BELOW it inside the stage
   * column (resize handle, transport bar, manual hint, timeline, flex gaps =
   * columnHeight − stageHeight, stable while dragging because the growth
   * cancels out), plus the footer and the bottom #app-main padding. The old
   * clamp only knew 75vh, so dragging to max on short viewports pushed the
   * transport bar and the timeline into/past the footer (field report: "footer
   * overlaps the timeline when the preview is enlarged").
   *
   * Returns 0-safe partials when elements are missing; at the gate step
   * (workspace hidden) the stage rect is 0 and only real chrome is reserved.
   *
   * @returns {number} Reserved height, CSS px (≥ 0).
   */
  function stageReservedHeight() {
    const stageH = els.previewStage ? els.previewStage.offsetHeight : 0;
    const columnH = els.stageColumn ? els.stageColumn.offsetHeight : 0;
    const footerH = els.keyboardHints ? els.keyboardHints.offsetHeight : 0;
    const view = doc.defaultView;
    let stageTopDoc = 0;
    if (els.previewStage && view && typeof els.previewStage.getBoundingClientRect === 'function') {
      // Document-relative top: rect.top is viewport-relative and the page may
      // be scrolled (stacked mobile layout) — scrollY corrects that.
      stageTopDoc = els.previewStage.getBoundingClientRect().top + (view.scrollY || 0);
    }
    let padBottom = 0;
    if (els.appMain && view && typeof view.getComputedStyle === 'function') {
      padBottom = parseFloat(view.getComputedStyle(els.appMain).paddingBottom) || 0;
    }
    return Math.max(0, stageTopDoc) + Math.max(0, columnH - stageH) + footerH + padBottom;
  }

  /** Live stage height (source of truth once the user first resizes). */
  let stageHeight = DEFAULT_STAGE_HEIGHT_PX;

  /**
   * Single stage-height mutation path: clamp → apply the `--stage-h` custom
   * property on #preview-stage (index.html sizes the stage with it; video +
   * overlay canvas keep their absolute fill) → aria-valuenow → editor
   * redraw() so the overlay re-scales to the new layout × DPR.
   */
  function applyStageHeight(px) {
    stageHeight = clampStageHeight(px, stageViewportH(), stageReservedHeight());
    if (els.previewStage) {
      els.previewStage.style.setProperty('--stage-h', `${stageHeight}px`);
    }
    if (els.stageResizeHandle) {
      els.stageResizeHandle.setAttribute('aria-valuenow', String(stageHeight));
    }
    triggerPreviewResize();
  }

  const resizeHandle = els.stageResizeHandle;
  if (resizeHandle) {
    /** Live pointer drag: pointerdown anchor + height at anchor. */
    let drag = /** @type {{startY: number, startH: number} | null} */ (null);

    resizeHandle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { startY: e.clientY, startH: stageHeight };
      try {
        resizeHandle.setPointerCapture(e.pointerId);
      } catch {
        /* detached handle — capture is best-effort */
      }
      e.preventDefault();
    });
    resizeHandle.addEventListener('pointermove', (e) => {
      if (!drag) return;
      // Direct manipulation: the handle IS the stage's bottom edge, so the
      // edge follows the pointer — drag DOWN = taller. clampStageHeight
      // recomputes the 75vh bound per move.
      applyStageHeight(dragStageHeight(drag.startY, e.clientY, drag.startH));
    });
    const endDrag = (e) => {
      if (!drag) return;
      drag = null;
      try {
        resizeHandle.releasePointerCapture(e.pointerId);
      } catch {
        /* never captured or already released */
      }
      applyStageHeight(stageHeight); // drag end: final clamp + redraw kick
    };
    resizeHandle.addEventListener('pointerup', endDrag);
    resizeHandle.addEventListener('pointercancel', endDrag);
    // v1.6.1 REG-2: after a POINTER drag, release focus so the doc-level
    // transport shortcuts keep working (keyboard activation keeps focus —
    // the ArrowUp/ArrowDown resize path below depends on it).
    resizeHandle.addEventListener('pointerup', () => {
      if (resizeHandle.blur) resizeHandle.blur();
    });
    resizeHandle.addEventListener('dblclick', () => {
      applyStageHeight(DEFAULT_STAGE_HEIGHT_PX);
    });
    resizeHandle.addEventListener('keydown', (e) => {
      const step =
        e.key === 'ArrowUp'
          ? STAGE_HEIGHT_STEP_PX
          : e.key === 'ArrowDown'
            ? -STAGE_HEIGHT_STEP_PX
            : 0;
      if (step === 0) return;
      e.preventDefault();
      // Stop the doc-level shortcuts: ArrowUp/Down would otherwise ALSO
      // frame-step the video in review/done (the handle is not a button).
      e.stopPropagation();
      applyStageHeight(nextStageHeight(stageHeight, step, stageViewportH(), stageReservedHeight()));
    });
  }

  // --- Keyboard (design-direction: space / ← / → / B in review states) ------
  //
  // v1.6.1 REG-2: exclusion is limited to the TYPING surfaces
  // (shortcutEnabledFor — input/select/textarea/[contenteditable]; the
  // track-row time inputs keep it). Buttons are no longer excluded: focus
  // remaining on a clicked control used to make Space RE-ACTIVATE that
  // button (re-step a frame, exit fullscreen) instead of toggling playback.
  // The Space branch preventDefaults, so a button focused despite the
  // blur-on-click wiring (keyboard users, native-fullscreen focus anchoring)
  // toggles the video EXACTLY ONCE — the browser's key-activation click on
  // the focused button is cancelled.

  doc.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement | null} */ (/** @type {unknown} */ (e.target));
    if (!shortcutEnabledFor(target)) return;
    if (!(app.step === 'review' || app.step === 'done')) return;
    if (!els.video) return; // togglePlay/stepFrame guard internally too
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      stepFrame(e.key === 'ArrowRight' ? 1 : -1);
    } else if (e.key === 'b' || e.key === 'B') {
      // Manual-box mode: the canvas drag is live (editor's interaction map);
      // B just tells the user what to do next.
      toast('Drag on the video to draw a manual redaction box — Escape cancels the drag.', { timeoutMs: 4000 });
    }
  });

  return null;
}

/** @param {Document} doc @param {HTMLElement} gateEl @param {string[]} instructions */
function renderServeInstructions(doc, gateEl, instructions) {
  const card = gateEl.querySelector('.gate-card');
  if (!card || !Array.isArray(instructions)) return;
  for (const code of card.querySelectorAll('code')) code.remove();
  for (const line of instructions) {
    const el = doc.createElement('code');
    el.textContent = line;
    card.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Auto-mount (browser only; skipped under node/vitest)
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void mountApp();
    });
  } else {
    void mountApp();
  }
}
