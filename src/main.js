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
 *   muteGlyph(muted)                   mute/unmute glyph (v1.8.0)
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
 *   parseDebugFlag(search)             ?debug=1 support-diagnostics flag (v1.8.2)
 *   formatDiagLine(snapshot)           diag snapshot → compact JSON line (v1.8.2)
 *   DIAG_KEY_ORDER                     canonical [diag] line key order (v1.8.2)
 *   focusLabel(activeEl)               focused element → "TAG#id" (v1.9.0 diag)
 *   mountEditorSafe(mount, els, hooks, onFail)
 *                                      editor mount with the throw contained —
 *                                      on failure: onFail(err) + null instead of
 *                                      a dead app shell (v1.9.0 hardening)
 *   mergeManualTracks(existing, analyzed)
 *                                      analyze-completion merge (v1.10.0):
 *                                      manual regions drawn pre-analyze survive
 *                                      the fresh auto tracks; colliding auto
 *                                      ids are re-assigned past every existing
 *                                      id; returns {tracks, manualNextId}
 *   RAIL_MIN_WIDTH_PX / RAIL_MAX_WIDTH_PX / DEFAULT_RAIL_WIDTH_PX /
 *   RAIL_WIDTH_STEP_PX / clampRailWidth(px) / nextRailWidth(px, delta) /
 *   dragRailWidth(startX, clientX, startW)
 *                                      rail-split handle model (v1.12.0 REQ-118)
 *   THEME_STORAGE_KEY / loadTheme(storage) / saveTheme(storage, theme) /
 *   nextTheme(current) / themeGlyph(theme)
 *                                      light-theme toggle model (v1.12.0 REQ-124)
 *   fileInfoRows(file, meta) / formatFileDate(ms)
 *                                      #file-info view model (v1.12.0 REQ-119)
 *   SIZE_FILTER_VALUES / sizeFilterState(current, clicked) /
 *   sizeFilterPressed(selected)        min-size filter model (v1.12.0 REQ-120)
 *   DOWNSCALE_VALUES / normalizeDownscale(value)
 *                                      processing-downscale model (v1.12.0 REQ-117)
 *   SEEK_STEP_S                        keyboard seek step ±5 s (v1.12.0 REQ-122)
 *   setAllTrackStyles(tracks, style)   bulk restyle model (v1.13.0): every
 *                                      track → 'solid' | 'pixelate' in a NEW
 *                                      array (invalid style → unchanged)
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

/**
 * v1.8.2 shared diagnostics counters (`?debug=1` remote support): main.js's
 * `timeupdate` listener bumps `tu`, the editor's rVFC-DELIVERED tick bumps
 * `vfc` (see editor.js tick — the rAF fallback never counts); the `?debug=1`
 * log tick reads and RESETS `tu`/`vfc` (and the v1.9.0 counters below) every
 * 2 s. The object exists unconditionally — one `++` per media/frame event is
 * the entire always-on cost; without the flag nothing ever reads or logs it.
 * Shared via `globalThis.__VR_DIAG` so editor.js (imported before this module
 * body runs) can reach it at runtime without an import cycle.
 *
 * v1.9.0 additions (the unreproducible field failure made every diag line
 * inconclusive — these make the NEXT report conclusive):
 *   tickErr — editor per-tick exceptions (editor.js noteTickFailure);
 *   tued    — the EDITOR's own timeupdate listener firings; `tu > 0` with
 *             `tued === 0` pins a dead editor listener (wiring), while both
 *             at 0 pins a dead media event stream;
 *   errs    — window 'error' + 'unhandledrejection' count SINCE THE LAST
 *             diag line (always-on listeners in mountApp);
 *   lastErr — first 80 chars of the most recent error message (sticky —
 *             survives lines until a newer error replaces it).
 * @type {{tu: number, vfc: number, tickErr: number, tued: number,
 *         errs: number, lastErr: string | null}}
 */
const VR_DIAG = (globalThis.__VR_DIAG = globalThis.__VR_DIAG ?? {
  tu: 0,
  vfc: 0,
  tickErr: 0,
  tued: 0,
  errs: 0,
  lastErr: null,
});

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
  // v1.10.0: 'ready' carries a LIVE editor (mounted at file-open) — playback,
  // scrub and manual-box drawing all work here; Export stays gated to the
  // post-analyze states (review/done) so nothing ships before an analysis ran.
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
// Rail-split width model (pure; v1.12.0 REQ-118)
// ---------------------------------------------------------------------------

/** Lower clamp bound for the side-rail width, CSS px (REQ-118). */
export const RAIL_MIN_WIDTH_PX = 240;
/** Upper clamp bound for the side-rail width, CSS px (REQ-118). */
export const RAIL_MAX_WIDTH_PX = 480;
/** Default / double-click-reset rail width, CSS px (REQ-118). */
export const DEFAULT_RAIL_WIDTH_PX = 320;
/** Keyboard step (ArrowLeft / ArrowRight on the focused rail handle), CSS px. */
export const RAIL_WIDTH_STEP_PX = 24;

/**
 * Clamp a desired side-rail width to the REQ-118 bounds as an integer. PURE.
 * A non-finite `px` degrades to the default width (320) before clamping —
 * the same degradation shape as clampStageHeight.
 *
 * @param {number} px Desired rail width, CSS px.
 * @returns {number} Clamped integer rail width (240–480).
 */
export function clampRailWidth(px) {
  if (!Number.isFinite(px)) return DEFAULT_RAIL_WIDTH_PX;
  return Math.min(RAIL_MAX_WIDTH_PX, Math.max(RAIL_MIN_WIDTH_PX, Math.round(px)));
}

/**
 * One rail-width step (REQ-118 keyboard parity: ArrowLeft/ArrowRight ±24 px)
 * — `px` moved by `deltaPx`, then clamped by clampRailWidth. PURE.
 *
 * @param {number} px Current rail width, CSS px.
 * @param {number} deltaPx Signed step (+ = wider rail), CSS px.
 * @returns {number} New clamped integer rail width.
 */
export function nextRailWidth(px, deltaPx) {
  const step = Number.isFinite(deltaPx) ? deltaPx : 0;
  const from = Number.isFinite(px) ? px : DEFAULT_RAIL_WIDTH_PX;
  return clampRailWidth(from + step);
}

/**
 * Pointer-drag rail width (v1.12.0 REQ-118): the handle is the rail's LEFT
 * edge, so it follows the pointer — moving the pointer RIGHT (clientX >
 * startX) widens the rail. PURE; the caller clamps via the apply path.
 *
 * @param {number} startX Pointer X at drag start (CSS px).
 * @param {number} clientX Current pointer X (CSS px).
 * @param {number} startW Rail width at drag start (CSS px).
 * @returns {number} Unclamped new rail width.
 */
export function dragRailWidth(startX, clientX, startW) {
  const dx = Number.isFinite(clientX) && Number.isFinite(startX) ? clientX - startX : 0;
  const from = Number.isFinite(startW) ? startW : DEFAULT_RAIL_WIDTH_PX;
  return from + dx;
}

// ---------------------------------------------------------------------------
// Light-theme toggle model (pure; v1.12.0 REQ-124)
// ---------------------------------------------------------------------------

/**
 * localStorage key the theme choice persists under (REQ-124; Agent-HTML
 * contract). 'light' | 'dark', dark is the default when absent/invalid.
 * @type {string}
 */
export const THEME_STORAGE_KEY = 'video-redact-theme';

/**
 * Read the persisted theme choice. PURE against the injected `storage`
 * (localStorage-like: getItem may throw — private-mode Safari, disabled
 * storage, node); anything but a stored 'light'/'dark' degrades to null and
 * the caller keeps the default theme.
 *
 * @param {{getItem?: (k: string) => string | null} | null | undefined} storage
 * @returns {'light' | 'dark' | null}
 */
export function loadTheme(storage) {
  try {
    const raw = storage?.getItem?.(THEME_STORAGE_KEY);
    return raw === 'light' || raw === 'dark' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Persist the theme choice. PURE against the injected `storage`; every
 * failure (quota, disabled storage, missing setItem) degrades to false —
 * the toggle still applies for the session.
 *
 * @param {{setItem?: (k: string, v: string) => void} | null | undefined} storage
 * @param {'light' | 'dark' | null | undefined} theme
 * @returns {boolean} True when the write succeeded.
 */
export function saveTheme(storage, theme) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(THEME_STORAGE_KEY, theme === 'light' ? 'light' : 'dark');
    return true;
  } catch {
    return false;
  }
}

/**
 * Theme toggle (REQ-124): dark ↔ light. Anything non-'light' counts as dark
 * (the default), so an unknown current state still toggles INTO light.
 * PURE.
 *
 * @param {'light' | 'dark' | null | undefined} current
 * @returns {'light' | 'dark'}
 */
export function nextTheme(current) {
  return current === 'light' ? 'dark' : 'light';
}

/**
 * Toggle-button glyph showing the CURRENT theme's icon (REQ-124 wiring
 * contract): '☀️' while dark (clicking switches to light), '🌙' while light.
 * PURE.
 *
 * @param {'light' | 'dark' | null | undefined} theme
 * @returns {'☀️'|'🌙'}
 */
export function themeGlyph(theme) {
  return theme === 'light' ? '🌙' : '☀️';
}

// ---------------------------------------------------------------------------
// File-information view model (pure; v1.12.0 REQ-119)
// ---------------------------------------------------------------------------

/**
 * File last-modified timestamp → "date time" in the user's locale. PURE.
 * A missing/invalid timestamp (0, negative, NaN, out-of-range) degrades to
 * null — the row is omitted rather than shown as an invented date.
 *
 * @param {number | undefined} ms File.lastModified (ms since epoch).
 * @returns {string | null}
 */
export function formatFileDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

/**
 * File object (+ optional MediaMeta) → the #file-info rows (REQ-119: name,
 * size, last-modified date, type). PURE; node-safe against plain objects
 * (no File instance required — only name/size/lastModified/type are read).
 * Returns null for a missing file (the block stays hidden). The type row
 * prefers the File MIME type and falls back to the container from meta.
 *
 * @param {{name?: unknown, size?: unknown, lastModified?: unknown,
 *          type?: unknown} | null | undefined} file
 * @param {import('./types.js').MediaMeta | null | undefined} meta
 * @returns {Array<{label: string, value: string}> | null}
 */
export function fileInfoRows(file, meta) {
  if (!file || typeof file !== 'object') return null;
  const name = typeof file.name === 'string' && file.name.length > 0 ? file.name : 'unknown';
  const rows = [
    { label: 'Name', value: name },
    { label: 'Size', value: formatBytes(Number(file.size)) },
  ];
  const modified = formatFileDate(/** @type {number} */ (file.lastModified));
  if (modified) rows.push({ label: 'Modified', value: modified });
  const mime = typeof file.type === 'string' && file.type.length > 0 ? file.type : '';
  const container = meta?.container != null ? String(meta.container) : '';
  rows.push({ label: 'Type', value: mime || container || 'unknown' });
  return rows;
}

// ---------------------------------------------------------------------------
// Detection min-size filter + processing downscale (pure; v1.12.0 REQ-120/117)
// ---------------------------------------------------------------------------

/**
 * The REQ-120 button-group values, in button order (Any / ≥24px / ≥48px /
 * ≥96px — minimum box dimension in display px). @type {number[]}
 */
export const SIZE_FILTER_VALUES = [0, 24, 48, 96];

/**
 * Size-filter click resolution (REQ-120). PURE: a clicked `data-size` that is
 * one of SIZE_FILTER_VALUES wins; an invalid click keeps the current value
 * (itself falling back to 0 = Any when also invalid) — the group can never
 * enter an undefined state.
 *
 * @param {number | null | undefined} current Currently selected min px.
 * @param {number | null | undefined} clicked The clicked button's data-size.
 * @returns {number} The new selected min-px value.
 */
export function sizeFilterState(current, clicked) {
  const cur = Number(current);
  const click = Number(clicked);
  if (SIZE_FILTER_VALUES.includes(click)) return click;
  if (SIZE_FILTER_VALUES.includes(cur)) return cur;
  return 0;
}

/**
 * Selected min-px → the aria-pressed booleans for the button group, aligned
 * with SIZE_FILTER_VALUES (REQ-120: exactly one button pressed). PURE; an
 * invalid selection presses nothing (the wiring never produces one).
 *
 * @param {number | null | undefined} selected Currently selected min px.
 * @returns {boolean[]}
 */
export function sizeFilterPressed(selected) {
  const v = Number(selected);
  return SIZE_FILTER_VALUES.map((value) => value === v);
}

/**
 * The REQ-117 processing-downscale options. @type {string[]}
 */
export const DOWNSCALE_VALUES = ['full', '1080p', '720p'];

/**
 * Normalize a #downscale-select value to a legal REQ-117 option. PURE;
 * anything unknown (missing select, hand-edited DOM) degrades to 'full' —
 * no downscale is the safe default.
 *
 * @param {unknown} value Raw select value.
 * @returns {'full' | '1080p' | '720p'}
 */
export function normalizeDownscale(value) {
  const v = String(value ?? '');
  return /** @type {'full' | '1080p' | '720p'} */ (
    DOWNSCALE_VALUES.includes(v) ? v : 'full'
  );
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
 * Keyboard seek step in seconds (v1.12.0 REQ-122): ←/→ jump ±5 s;
 * Shift+←/→ keeps the ±1-frame step.
 * @type {number}
 */
export const SEEK_STEP_S = 5;

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
 * Mute glyph for a muted state — '🔇' when muted, '🔊' when audible (v1.8.0).
 * PURE; shared by the bottom transport bar (#mute-button) and the fullscreen
 * overlay bar (#ov-mute) so both always show the same glyph for the same
 * state.
 *
 * @param {boolean} muted Whether the video is muted.
 * @returns {'🔇'|'🔊'}
 */
export function muteGlyph(muted) {
  return muted ? '🔇' : '🔊';
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
// Runtime diagnostics (pure; v1.8.2 ?debug=1 remote support)
// ---------------------------------------------------------------------------

/**
 * Canonical key order of the `[diag]` console line (v1.8.2; v1.9.0 grows the
 * evidence set). formatDiagLine emits keys in THIS order regardless of the
 * snapshot's construction order, so two diag lines — or two machines' lines —
 * diff by eye. Identity first (v/build: WHICH bundle is actually running),
 * then transport state, then the signal counters that prove which listener
 * paths fire on the reporting machine (`tu`/`vfc` media+frame, `tued` the
 * editor's own timeupdate listener), then runtime health (`errs`/`lastErr`
 * window error counters), then the editor gesture state (`drag`/`pin`/`pinMs`
 * — v1.9.0: the release pin is now OBSERVABLE via getGestureState, no longer
 * an always-null honest unknown), position (`thumbLeft`), where focus sits
 * (`focus` — a held focus is the classic "Space is dead" cause), the review
 * facts (`tracks`/`webgpu`), and the active theme (`theme` — v1.12.0 REQ-124;
 * a "dark styles on light theme" report needs the running theme in the line).
 * @type {string[]}
 */
export const DIAG_KEY_ORDER = [
  'v', 'build', 'secure', 'step', 't', 'dur', 'paused', 'rate', 'muted',
  'tu', 'vfc', 'tued', 'errs', 'lastErr', 'drag', 'pin', 'pinMs',
  'thumbLeft', 'focus', 'tracks', 'webgpu', 'theme',
];

/**
 * Parse the `?debug=1` support-diagnostics URL flag (v1.8.2). PURE. Accepts
 * `debug=1` or `debug=true`, position-independent (`?debug=1`, `&debug=1`,
 * a missing leading '?' is tolerated). Everything else is deterministically
 * OFF — flag absent, bare `?debug`, `debug=0`/`debug=false`, any case
 * variation — so support can dictate ONE exact URL with no ambiguity
 * (duplicate `debug` keys: the first value wins, URLSearchParams semantics).
 *
 * @param {string} search `location.search` ('' or '?a=b&debug=1').
 * @returns {boolean}
 */
export function parseDebugFlag(search) {
  const value = new URLSearchParams(search).get('debug');
  return value === '1' || value === 'true';
}

/**
 * Focused element → compact "TAG#id" label for the `[diag]` line (v1.9.0).
 * PURE. A stale/stranded focus is the classic "Space is dead" cause, so each
 * diag line carries WHERE focus sits; non-element input degrades to null
 * (never throws, never an empty string).
 *
 * @param {Element | null | undefined} activeEl document.activeElement.
 * @returns {string | null} e.g. "BUTTON#analyze-button", "BODY", or null.
 */
export function focusLabel(activeEl) {
  const el = /** @type {{tagName?: unknown, id?: unknown} | null | undefined} */ (activeEl);
  if (!el || typeof el.tagName !== 'string' || el.tagName.length === 0) return null;
  const id = typeof el.id === 'string' && el.id.length > 0 ? `#${el.id}` : '';
  return `${el.tagName}${id}`;
}

/**
 * Editor mount with the throw contained (v1.9.0 hardening). PURE — mountApp
 * runs its real seam through this; node tests run fakes. On success the
 * editor handle passes through unchanged; on throw `onFail(err)` is invoked
 * (toast + diag counters at the callsite) and null is returned — the app
 * shell keeps mounting, the review step stays reachable, and the doc-level
 * keyboard (wired BEFORE any editor mount in mountApp) stays live. This is
 * the containment for the field-failure theory: one exception during editor
 * mount must never take unrelated wiring down with it.
 *
 * @param {unknown} mountFn The mountEditor implementation to call.
 * @param {object} els Editor DOM handles (passed straight through).
 * @param {object} hooks Editor hooks (passed straight through).
 * @param {(err: unknown) => void} [onFail] Called with the RAW error on throw.
 * @returns {unknown} The editor handle, or null on failure / non-function seam.
 */
export function mountEditorSafe(mountFn, els, hooks, onFail) {
  if (typeof mountFn !== 'function') return null;
  try {
    return mountFn(els, hooks);
  } catch (err) {
    if (typeof onFail === 'function') onFail(err);
    return null;
  }
}

/**
 * Merge freshly analyzed auto tracks with the tracks that already exist
 * (v1.10.0). PURE — the analyze pass returns a FRESH track array (tracker
 * output, auto ids from its own counter); since the editor now lives from the
 * ready state, the user may have drawn MANUAL regions before (or during) the
 * pass and those must survive it: keep every `source === 'manual'` track
 * verbatim, then append the analyzed tracks. Auto ids that would collide with
 * a kept manual id are re-assigned past EVERY existing id (manual + auto) —
 * ids are per-track identity only (chips/rows/toggle dispatch on them), so a
 * remap is side-effect free. Non-manual existing tracks do NOT survive: a
 * re-analyze legitimately replaces the previous auto set.
 *
 * Track order: manuals first (creation order — they existed before the pass),
 * then the analyzed tracks in tracker order. `manualNextId` comes back as
 * max(merged ids) + 1 so main's manual-id/palette counter can never collide.
 *
 * Degradations (never throws): non-array inputs → []; null/invalid entries
 * are dropped from the kept set; tracks without a finite id pass through
 * unmapped (they cannot collide).
 *
 * @param {import('./types.js').Track[] | null | undefined} existingTracks
 *     The app's current tracks (may hold manual regions).
 * @param {import('./types.js').Track[] | null | undefined} analyzedTracks
 *     The fresh runAnalyze output (auto tracks).
 * @returns {{tracks: import('./types.js').Track[], manualNextId: number}}
 *     The merged array and the next free manual id.
 */
export function mergeManualTracks(existingTracks, analyzedTracks) {
  const existing = Array.isArray(existingTracks) ? existingTracks : [];
  const analyzed = Array.isArray(analyzedTracks) ? analyzedTracks : [];
  const manual = existing.filter(
    (t) => !!t && /** @type {{source?: unknown}} */ (/** @type {unknown} */ (t)).source === 'manual',
  );
  const autos = analyzed.filter(Boolean);
  const manualIds = new Set(
    manual.map((t) => Number(t.id)).filter((id) => Number.isFinite(id)),
  );
  let nextId = 0;
  for (const t of [...manual, ...autos]) {
    const id = Number(t?.id);
    if (Number.isFinite(id)) nextId = Math.max(nextId, id);
  }
  nextId += 1;
  const mergedAutos = autos.map((t) => {
    const id = Number(t?.id);
    if (!Number.isFinite(id) || !manualIds.has(id)) return t;
    const fresh = nextId;
    nextId += 1;
    return /** @type {import('./types.js').Track} */ ({ ...t, id: fresh });
  });
  const tracks = [...manual, ...mergedAutos];
  const manualNextId =
    tracks.reduce((m, t) => Math.max(m, Number(t?.id) || 0), 0) + 1;
  return { tracks, manualNextId };
}

/**
 * Bulk-restyle EVERY track to one redaction style (v1.13.0 — #bulk-solid /
 * #bulk-pixelate). PURE: returns a NEW array; the input array and its track
 * objects are never mutated (each track is copied only when its style
 * changes, so enabled/keyframes/timings stay shared). Only the two contract
 * literals are accepted — any other style leaves the content unchanged (the
 * redaction must never degrade to an unrenderable style, same rule as
 * editor.setTrackStyle).
 *
 * @param {import('./types.js').Track[] | null | undefined} tracks
 *     The app's current tracks (manual + auto alike — the bulk action is
 *     deliberately style-blind).
 * @param {'solid'|'pixelate'} style Target style for every track.
 * @returns {import('./types.js').Track[]} New array; empty/degenerate input
 *     → empty; invalid style → unchanged content (still a new array).
 */
export function setAllTrackStyles(tracks, style) {
  const valid = style === 'pixelate' || style === 'solid';
  const source = Array.isArray(tracks) ? tracks : [];
  return source.map((track) =>
    valid && track?.style !== style
      ? /** @type {import('./types.js').Track} */ ({ ...track, style })
      : track,
  );
}

/**
 * Diagnostics snapshot → the compact one-line JSON body of the `[diag]`
 * console line (v1.8.2). PURE. Keys emit in DIAG_KEY_ORDER first (unknown /
 * future keys follow in their own insertion order); numbers are
 * finite-guarded (NaN/±Infinity → null — an unloaded video's NaN duration
 * must never break the log line) and `undefined` becomes an explicit null
 * so the key always survives serialization.
 *
 * @param {Record<string, unknown> | null | undefined} [snapshot]
 * @returns {string} Compact JSON — '{"v":"1.8.2",…}', no spaces.
 */
export function formatDiagLine(snapshot) {
  const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const keys = [
    ...DIAG_KEY_ORDER,
    ...Object.keys(src).filter((k) => !DIAG_KEY_ORDER.includes(k)),
  ];
  /** @type {Record<string, unknown>} */
  const ordered = {};
  for (const key of keys) {
    if (!Object.hasOwn(src, key)) continue;
    const value = src[key];
    if (typeof value === 'number' && !Number.isFinite(value)) ordered[key] = null;
    else ordered[key] = value === undefined ? null : value;
  }
  return JSON.stringify(ordered);
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
 * v1.9.0 ORDERING + ISOLATION CONTRACT (the unreproducible field failure —
 * editor thumb + doc keyboard dead while the timecode advanced — fits one
 * exception taking down every wiring step after the editor mount):
 *   1. the doc-level keyboard handler is wired EARLY, before any code path
 *      that can mount the editor, so an editor-mount failure can never kill
 *      the shortcuts;
 *   2. the editor mount itself runs through mountEditorSafe — a throw
 *      becomes a readable toast + diag counters, never a dead review step;
 *   3. window 'error'/'unhandledrejection' listeners are ALWAYS on, so the
 *      next report carries the machine-readable evidence.
 *
 * @param {Document | null} [doc] Defaults to the global document.
 * @param {{mountEditor?: typeof mountEditor}} [deps] Injectable seams — the
 *     node tests run mountApp with a throwing mountEditor to prove the
 *     keyboard wiring survives an editor-mount failure.
 * @returns {Promise<null | void>} null when the serve gate blocked wiring.
 */
export async function mountApp(
  doc = typeof document !== 'undefined' ? document : null,
  { mountEditor: mountEditorFn = mountEditor } = {},
) {
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
    // v1.8.0: audio mute on BOTH bars (transport + fullscreen overlay).
    muteButton: /** @type {HTMLButtonElement | null} */ ($('mute-button')),
    ovJump: /** @type {HTMLButtonElement | null} */ ($('ov-jump')),
    ovBack: /** @type {HTMLButtonElement | null} */ ($('ov-back')),
    ovPlay: /** @type {HTMLButtonElement | null} */ ($('ov-play')),
    ovFwd: /** @type {HTMLButtonElement | null} */ ($('ov-fwd')),
    ovMute: /** @type {HTMLButtonElement | null} */ ($('ov-mute')),
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
    compareUsePreview: /** @type {HTMLButtonElement | null} */ ($('compare-use-preview')),
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
    // v1.12.0 wiring (REQ-117/118/119/120/124). Every ref is null-guarded at
    // its use — the markup may not carry the element (Agent-HTML lands
    // separately) and the wiring must degrade to a no-op.
    railResize: /** @type {HTMLElement | null} */ ($('rail-resize')),
    themeToggle: /** @type {HTMLButtonElement | null} */ ($('theme-toggle')),
    fileInfo: $('file-info'),
    sizeFilter: $('size-filter'),
    downscaleSelect: /** @type {HTMLSelectElement | null} */ ($('downscale-select')),
    // v1.13.0: bulk track-style buttons. Every ref is null-guarded at its
    // use — the markup may not carry the element yet (Agent-HTML lands
    // separately) and the wiring must degrade to a no-op.
    bulkSolid: /** @type {HTMLButtonElement | null} */ ($('bulk-solid')),
    bulkPixelate: /** @type {HTMLButtonElement | null} */ ($('bulk-pixelate')),
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
   *          manualNextId: number, objectUrl: string | null,
   *          settings: {minSizePx: number, downscale: 'full' | '1080p' | '720p'}}} */
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
    // v1.12.0: the analyze-pass settings driven by the #size-filter button
    // group (REQ-120) and #downscale-select (REQ-117); reset per file load
    // and Clear (resetSizeFilter / resetDownscale).
    settings: { minSizePx: 0, downscale: 'full' },
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

  // --- v1.9.0 runtime-error capture (ALWAYS on, not gated on ?debug=1) -----
  //
  // The field failure was "errorless" because nothing LISTENED. A page
  // exception now bumps the shared errs/lastErr counters even on a plain
  // support URL; the next [diag] line (?debug=1 tick) carries them. Cheap:
  // two listeners + one counter bump per actual error.

  /**
   * Record one runtime error into the shared diag counters (v1.9.0).
   * @param {unknown} err Error, ErrorEvent message, or rejection reason.
   */
  function noteRuntimeError(err) {
    VR_DIAG.errs = (VR_DIAG.errs || 0) + 1;
    const message = err instanceof Error
      ? err.message
      : typeof err === 'string' && err.length > 0
        ? err
        : String(err ?? 'unknown error');
    VR_DIAG.lastErr = message.slice(0, 80);
  }

  const bootView = doc.defaultView;
  if (bootView && typeof bootView.addEventListener === 'function') {
    bootView.addEventListener('error', (e) => {
      const evt = /** @type {ErrorEvent} */ (/** @type {unknown} */ (e));
      noteRuntimeError(evt?.message ?? evt?.error ?? 'window error');
    });
    bootView.addEventListener('unhandledrejection', (e) => {
      const evt = /** @type {PromiseRejectionEvent} */ (/** @type {unknown} */ (e));
      noteRuntimeError(evt?.reason ?? 'unhandled rejection');
    });
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
    // v1.12.0 REQ-115 wiring: while analyzing the abort control is live and
    // reads "Stop analysis"; otherwise it is hidden (and disabled, so it can
    // never be tabbed into between updateButtons calls). The danger/large
    // STYLING is Agent-HTML's (index.html); main.js owns only the state.
    if (els.analyzeCancel) {
      els.analyzeCancel.hidden = !analyzing;
      els.analyzeCancel.disabled = !analyzing;
      if (analyzing) els.analyzeCancel.textContent = 'Stop analysis';
    }
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
    // v1.13.0: the bulk restyle buttons are only meaningful with tracks —
    // disabled (never hidden) while the tracks list is empty.
    if (els.bulkSolid) els.bulkSolid.disabled = app.tracks.length === 0;
    if (els.bulkPixelate) els.bulkPixelate.disabled = app.tracks.length === 0;
  }

  function showIntake() {
    if (els.intakePanel) {
      els.intakePanel.hidden = false;
      // v1.13.1: class-based sizing (inline flex-basis broke mobile — see
      // index.html .intake-mode/.workspace-mode).
      els.intakePanel.classList.add('intake-mode');
      els.intakePanel.classList.remove('workspace-mode');
      els.intakePanel.style.flex = '';
    }
    if (els.dropZone) els.dropZone.hidden = false;
    if (els.workspace) els.workspace.hidden = true;
  }

  /** Capability rail narrows once the workspace (preview + rails) shows. */
  function showWorkspace() {
    if (els.intakePanel) {
      els.intakePanel.hidden = false;
      els.intakePanel.classList.add('workspace-mode');
      els.intakePanel.classList.remove('intake-mode');
      els.intakePanel.style.flex = '';
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

  // --- v1.12.0 REQ-124: light theme (dark default, choice persisted) ---------
  //
  // Init at mount: read localStorage (guarded — private mode / disabled
  // storage / node must never throw), apply documentElement[data-theme] +
  // the toggle glyph, and persist on every click. The CSS custom-property
  // swap itself is Agent-HTML's; main.js owns only the state + attributes.

  /** localStorage seam; null when unavailable (never throws). */
  function themeStorage() {
    try {
      const s = globalThis.localStorage;
      return s && typeof s.getItem === 'function' ? s : null;
    } catch {
      return null;
    }
  }

  let currentTheme = loadTheme(themeStorage()) ?? 'dark';

  /** Apply the theme: documentElement dataset + the toggle glyph/aria state. */
  function applyTheme(theme) {
    const root = doc.documentElement;
    if (root && root.dataset) root.dataset.theme = theme;
    if (els.themeToggle) {
      els.themeToggle.textContent = themeGlyph(theme);
      // The markup ships aria-pressed on the toggle — keep it honest
      // (pressed = the non-default light theme is active).
      els.themeToggle.setAttribute('aria-pressed', String(theme === 'light'));
    }
  }

  applyTheme(currentTheme);
  els.themeToggle?.addEventListener('click', () => {
    currentTheme = nextTheme(currentTheme);
    applyTheme(currentTheme);
    saveTheme(themeStorage(), currentTheme);
  });
  blurAfterClick(els.themeToggle);

  // --- Startup renders --------------------------------------------------------

  renderAttribution();
  renderVersionBadge();
  applyStepper();
  updateButtons();
  // v1.6.0: the analyze-panel controls start from the SAME factory clearAll
  // restores them with — one source of truth for the default settings.
  applySettings(DEFAULT_SETTINGS());
  // v1.12.0: the REQ-117/120 controls start from their defaults too (and
  // app.settings with them); the REQ-119 file-info block stays hidden until
  // a file actually loads.
  resetSizeFilter();
  resetDownscale();
  hideFileInfo();
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

  // --- v1.12.0 REQ-119: file-information block (#file-info) --------------------

  /** Hide + empty the #file-info block (Clear / failed open / new file). */
  function hideFileInfo() {
    if (!els.fileInfo) return;
    els.fileInfo.hidden = true;
    els.fileInfo.replaceChildren();
  }

  /**
   * Render the REQ-119 rows (name, size, last-modified date, type) from the
   * loaded File (+ the meta container as the type fallback) and show the
   * block. Label/value spans land FLAT in #file-info — the block is a
   * two-column grid (index.html: #file-info .label / .value), no row wrapper.
   */
  function renderFileInfo(file, meta) {
    if (!els.fileInfo) return;
    els.fileInfo.replaceChildren();
    const rows = fileInfoRows(file, meta);
    if (!rows) {
      els.fileInfo.hidden = true;
      return;
    }
    for (const row of rows) {
      const label = doc.createElement('span');
      label.className = 'label';
      label.textContent = row.label;
      const value = doc.createElement('span');
      value.className = 'value';
      value.textContent = row.value;
      els.fileInfo.append(label, value);
    }
    els.fileInfo.hidden = false;
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
    // selectors must follow or they would show a rate the video no longer
    // has). v1.8.0: a fresh file also starts UNMUTED — mute is a per-video
    // listening choice, never a property of the next one.
    if (els.video) {
      els.video.playbackRate = 1;
      els.video.muted = false;
    }
    syncSpeedSelects();
    resetAnalyzeUi();
    resetExportUi();
    refreshTrackUi();
    // v1.12.0: the REQ-117/120 analyze settings reset per file (consistent
    // with the other analyze-panel controls), and the REQ-119 file-info
    // block hides until THIS file's metadata lands.
    resetSizeFilter();
    resetDownscale();
    hideFileInfo();

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
      selectedCompareLevel = null; // v1.11.0: cleared panels clear the selection
      if (els.compareStatus) els.compareStatus.textContent = '';

      // Blob preview source (media-src blob: is CSP-allowed; bytes stay local).
      if (els.video) {
        app.objectUrl = URL.createObjectURL(file);
        els.video.src = app.objectUrl;
        els.video.load();
      }

      renderCapReport(meta, caps);
      renderFileInfo(file, meta); // v1.12.0 REQ-119
      const g = guidance(caps);
      renderGuidance(g, caps);

      const next = deriveStep(app.step, 'FILE_OPENED') ?? 'ready';
      app.step = next;
      applyStepper();
      updateButtons();
      showWorkspace();
      // v1.10.0: the workspace UI is live the moment a file is open — mount
      // the editor HERE (ready, 0 tracks), not after the first analyze. The
      // Blob URL + video src are already assigned above, so the timeline,
      // scrub thumb, transport Space and manual-box drawing all work
      // pre-analyze. A mount failure stays contained (mountEditorLive →
      // mountEditorSafe): readable toast, everything else keeps working.
      mountEditorLive();
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
      hideFileInfo(); // v1.12.0: nothing to describe — the block goes away
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
      v.muted = false; // v1.8.0 teardown checklist: reset to unmuted
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
    resetSizeFilter(); // v1.12.0 REQ-120: back to Any
    resetDownscale(); // v1.12.0 REQ-117: back to Full
    hideFileInfo(); // v1.12.0 REQ-119: the file-info block goes away
    resetAnalyzeUi();
    resetExportUi();
    if (els.trackList) els.trackList.textContent = '';
    if (els.chips) els.chips.replaceChildren();
    if (els.playhead) els.playhead.style.left = '0%';
    refreshTrackUi(); // the "No tracks yet" hint returns
    renderCapReport(null, null); // hides + empties the capability report
    renderGuidance({ messages: [] }, null); // hides + empties the guidance
    if (els.thresholdPanels) els.thresholdPanels.replaceChildren();
    selectedCompareLevel = null; // v1.11.0: cleared panels clear the selection
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

  // --- Keyboard (design-direction: space / ← / → / B in review states) ------
  //
  // v1.9.0 ORDERING CONTRACT: this handler is wired EARLY in mountApp —
  // before any code path that can mount the editor (the v1.10.0 ready-mount
  // lives below in SOURCE order, and only RUNS on a file open, long after
  // mountApp finished wiring; the mount itself is additionally isolated via
  // mountEditorSafe). The field failure (thumb + keyboard dead while the
  // transport timecode stayed alive) fits ONE exception killing every wiring
  // step after the editor mount; registering the shortcuts FIRST makes that
  // failure mode unable to take the keyboard down with it.
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
  //
  // v1.10.0: the editor is live from READY (mounted at file-open), so Space
  // toggles playback and the B hint fire whenever the preview is visible —
  // the user expectation pre-analyze, where the workspace already shows.
  //
  // v1.12.0 REQ-122: the shortcuts are active whenever the preview is
  // visible (ready/review/done — the same states Space already ran in) and
  // grow to the full transport set:
  //   ←/→            seek ∓/±5 s (clamped to 0..duration) — no shift
  //   Shift+←/→      frame-step ±1 (the old ←/→ semantics, now shifted)
  //   F              toggle fullscreen / enlarged preview (same path as ⛶)
  //   M              toggle mute
  //   Space / B      unchanged (play-pause / manual-box hint)

  doc.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement | null} */ (/** @type {unknown} */ (e.target));
    if (!shortcutEnabledFor(target)) return;
    if (!els.video) return; // togglePlay/stepFrame guard internally too
    const reviewGated = app.step === 'review' || app.step === 'done';
    const playbackLive = reviewGated || app.step === 'ready';
    if (!playbackLive) return;
    if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const forward = e.key === 'ArrowRight';
      if (e.shiftKey) stepFrame(forward ? 1 : -1);
      else seekBySeconds(forward ? SEEK_STEP_S : -SEEK_STEP_S);
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      togglePreviewEnlarge();
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      toggleMute();
    } else if (e.key === 'b' || e.key === 'B') {
      // Manual-box mode: the canvas drag is live (editor's interaction map,
      // from ready since v1.10.0); B just tells the user what to do next.
      toast('Drag on the video to draw a manual redaction box — Escape cancels the drag.', { timeoutMs: 4000 });
    }
  });

  // --- Editor mount at ready (v1.10.0) ----------------------------------------
  //
  // The workspace (preview, transport, timeline, thumb) is visible the moment
  // a file is open — the editor must be too. Through v1.9.0 the mount only
  // ran when the first analyze completed (enterReview), so pre-analyze the
  // timeline/thumb were dead markup and Space did nothing: the field report
  // "it happens only before analysis is made". mountEditorLive() owns the
  // (re)mount: handleFile's success path calls it at READY with 0 tracks;
  // analyze completion only refreshes the live editor. It sits BELOW the
  // doc-keyboard registration in source order (the v1.9.0 contract) and runs
  // through mountEditorSafe — a mount throw becomes a readable toast + diag
  // counters, never a dead workspace, and the shortcuts can never go down
  // with it.

  /**
   * (Re-)mount the editor with the shared els + hooks (v1.10.0). Called on
   * every successful file-open; `enterReview` deliberately does NOT mount —
   * it sets tracks + refreshes so the live editor never drops a beat between
   * ready and review.
   */
  function mountEditorLive() {
    editor?.destroy();
    editor = /** @type {ReturnType<typeof mountEditor> | null} */ (mountEditorSafe(
      mountEditorFn,
      {
        video: els.video,
        overlayCanvas: els.overlayCanvas,
        timeline: els.timeline,
        chipsContainer: els.chips,
        playhead: els.playhead,
        trackList: els.trackList,
      },
      {
        // v1.8.1: `duration` is the editor's fallback when video.duration is
        // NaN/≤0 (late metadata) — the meta value is set once at load and
        // never a stale playback capture.
        getState: () => ({
          tracks: app.tracks,
          currentTime: els.video?.currentTime ?? 0,
          duration: app.meta?.duration,
        }),
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
          // v1.13.0: the first track enables the bulk restyle buttons
          // (their disabled state is re-derived from the tracks length).
          updateButtons();
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
      // v1.9.0 onFail: surface the mount failure three ways — readable toast
      // (support can act on it), shared diag counters (errs/lastErr reach the
      // next [diag] line), console stays clean (mountEditorSafe swallowed the
      // throw; the toast text carries the message).
      (err) => {
        noteRuntimeError(err);
        const message = err instanceof Error ? err.message : String(err);
        toast(`Editor failed to start: ${message} — please report`, {
          kind: 'error',
          timeoutMs: 8000,
        });
      },
    ));
    refreshTrackUi();
  }

  // --- Analyze pass (REQ-009 / AC-03) --------------------------------------------

  function startAnalyze() {
    if (deriveStep(app.step, 'ANALYZE_START') == null || !app.input || !app.meta) return;
    const gen = ++app.gen;

    // v1.10.0: the editor stays LIVE through the pass (mounted at ready) —
    // no destroy, no track reset. Existing tracks — manual regions drawn
    // pre-analyze or during review — stay rendered and enforced in the
    // preview while analyzing, and enterReview MERGES them with the fresh
    // auto tracks (mergeManualTracks) instead of replacing the array.
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
    // v1.12.0 (REQ-117/120): the processing downscale + min-size filter ride
    // along on every pass. Always passed — analyze.js owns the defaults and
    // rescales detections to display coordinates before tracking.
    settings.minSizePx = Number(app.settings.minSizePx) || 0;
    settings.downscale = normalizeDownscale(app.settings.downscale);
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

  /**
   * Analysis complete (AC-03 includes partial): merge the fresh auto tracks
   * with the surviving manual ones and refresh the LIVE editor. v1.10.0: the
   * editor mounted at ready is already driving the workspace, so this path
   * deliberately does NOT mount (or destroy) anything — set tracks, refresh,
   * step → review. Re-mounting here used to be the reason the whole workspace
   * stayed dead until the first analyze finished.
   */
  function enterReview(result) {
    if (app.step !== 'analyzing') return;
    const next = deriveStep('analyzing', 'ANALYZE_FINISH');
    if (next == null) return;

    // MERGE (v1.10.0): runAnalyze returns a FRESH auto-only track array.
    // Manual regions drawn before/during the pass (the editor is live from
    // ready) survive it; auto ids that collide with a kept manual id are
    // re-assigned past every existing id, and manualNextId follows the merge.
    const merged = mergeManualTracks(app.tracks, result?.tracks);
    app.tracks = merged.tracks;
    app.manualNextId = merged.manualNextId;

    app.step = next;
    applyStepper();
    updateButtons();
    refreshTrackUi(); // editor.refresh() re-renders chips + rows + playhead

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

  // --- v1.12.0 REQ-120: detection min-size filter button group ----------------
  //
  // #size-filter holds .size-btn buttons (data-size "0"|"24"|"48"|"96");
  // exactly one is aria-pressed at a time. The click maps the string
  // data-size onto app.settings.minSizePx (number, display px) via the pure
  // sizeFilterState/sizeFilterPressed pair; analyze.js filters detections
  // with min(box.w, box.h) ≥ minSizePx BEFORE tracking.

  /** Set the selection (normalized) + sync the group's aria-pressed states. */
  function applySizeFilter(selectedPx) {
    app.settings.minSizePx = sizeFilterState(app.settings.minSizePx, selectedPx);
    const pressed = sizeFilterPressed(app.settings.minSizePx);
    if (!els.sizeFilter) return;
    let index = 0;
    for (const btn of els.sizeFilter.querySelectorAll('.size-btn')) {
      btn.setAttribute('aria-pressed', String(pressed[index] === true));
      index += 1;
    }
  }

  /** Back to Any (0) — file load + Clear (per-file setting by design). */
  function resetSizeFilter() {
    applySizeFilter(0);
  }

  if (els.sizeFilter) {
    for (const btn of els.sizeFilter.querySelectorAll('.size-btn')) {
      btn.addEventListener('click', () => {
        // getAttribute (not .dataset): the buttons arrive typed as Element.
        applySizeFilter(Number(btn.getAttribute?.('data-size')));
      });
      blurAfterClick(btn);
    }
  }

  // --- v1.12.0 REQ-117: processing-downscale select ---------------------------
  //
  // #downscale-select ("full"|"1080p"|"720p") caps the analyze frame size;
  // analyze.js rescales detections back to native display coordinates before
  // tracking (ADR-9 space unchanged downstream). Reset per file load + Clear.

  function applyDownscale(value) {
    app.settings.downscale = normalizeDownscale(value);
    if (els.downscaleSelect) els.downscaleSelect.value = app.settings.downscale;
  }

  /** Back to Full — file load + Clear (consistent with the size filter). */
  function resetDownscale() {
    applyDownscale('full');
  }

  els.downscaleSelect?.addEventListener('change', () => {
    applyDownscale(els.downscaleSelect?.value);
  });
  blurAfterChange(els.downscaleSelect);

  // --- v1.13.0: bulk track-style buttons (#bulk-solid / #bulk-pixelate) ------
  //
  // One click restyles EVERY track (manual + auto alike) to 'solid' or
  // 'pixelate' via the pure setAllTrackStyles model, then refreshTrackUi()
  // re-renders the list + preview through editor.refresh(). The disabled
  // state (empty tracks list) lives in updateButtons; a click with zero
  // tracks (race between render and state) still degrades to a readable
  // toast instead of a silent no-op.

  /** Apply one style to all tracks; empty list → subtle toast, no-op. */
  function applyAllTrackStyles(style) {
    if (app.tracks.length === 0) {
      toast('No tracks to restyle.');
      return;
    }
    app.tracks = setAllTrackStyles(app.tracks, style);
    refreshTrackUi();
  }

  if (els.bulkSolid) {
    els.bulkSolid.addEventListener('click', () => applyAllTrackStyles('solid'));
  }
  if (els.bulkPixelate) {
    els.bulkPixelate.addEventListener('click', () => applyAllTrackStyles('pixelate'));
  }
  // REG-2 (v1.6.1): pointer-activated controls release focus.
  blurAfterClick(els.bulkSolid);
  blurAfterClick(els.bulkPixelate);

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
      item.className = 'threshold-panel' + (vm.level === selectedCompareLevel ? ' selected' : '');
      item.title = `Use ≥${vm.level.toFixed(2)} for both sensitivity sliders`;
      item.setAttribute('aria-pressed', String(vm.level === selectedCompareLevel));
      const cap = doc.createElement('span');
      cap.className = 'caption';
      cap.textContent = formatThresholdCaption(vm);
      item.append(canvas, cap);
      item.addEventListener('click', () => {
        // v1.11.0: the clicked level stays visually selected (aria-pressed +
        // .selected class) until another level wins or the panels re-render.
        selectedCompareLevel = vm.level;
        for (const el of els.thresholdPanels?.children ?? []) {
          const isSel = el === item;
          el.classList.toggle('selected', isSel);
          if (el instanceof doc.defaultView.HTMLButtonElement) el.setAttribute('aria-pressed', String(isSel));
        }
        applyLevelToSliders(vm.level);
      });
      // v1.6.1 REG-2: the panel is a <button> — release focus after the click
      // so the doc-level transport shortcuts keep working.
      item.addEventListener('click', () => item.blur());
      frag.appendChild(item);
    }
    els.thresholdPanels.replaceChildren(frag);
  }

  // v1.11.0: the compare level the user last clicked — drives the .selected
  // visual state on the panels. Reset on file change and Clear (wherever the
  // panels themselves are cleared).
  let selectedCompareLevel = /** @type {number | null} */ (null);
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
  // v1.11.0: one-click sync from the preview playhead — the field takes the
  // video's current position (1 decimal, same step as the input), clamped to
  // the loaded duration. No-op before a file is loaded (max=0).
  els.compareUsePreview?.addEventListener('click', () => {
    const v = els.video;
    const input = els.compareTime;
    if (!v || !input) return;
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    const t = Math.min(Math.max(0, v.currentTime), dur);
    input.value = String(Math.round(t * 10) / 10);
  });
  blurAfterClick(els.compareUsePreview);

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
   * swap (BOTH bars — bottom transport + fullscreen overlay), mute glyph +
   * aria-pressed (BOTH bars, v1.8.0), speed selectors synced to the live
   * rate, and current/total timecode (formatClock). Driven by the media
   * events below so it works in EVERY workspace state (the editor is live
   * from ready since v1.10.0) — `volumechange` keeps external mute flips in
   * sync too.
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
    syncMuteButtons(v.muted === true);
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

  /**
   * Keep BOTH mute buttons on the given muted state (v1.8.0): muteGlyph,
   * aria-pressed (a toggle button's contract) and the title/aria-label swap.
   * Called from updateTransportUi (which `volumechange` drives) so an
   * EXTERNAL mute flip (browser media keys/controls) is mirrored too.
   * @param {boolean} muted
   */
  function syncMuteButtons(muted) {
    const glyph = muteGlyph(muted);
    for (const btn of [els.muteButton, els.ovMute]) {
      if (!btn) continue;
      btn.textContent = glyph;
      btn.title = muted ? 'Unmute' : 'Mute';
      btn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
      btn.setAttribute('aria-pressed', String(muted));
    }
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

  /**
   * Shared audio mute toggle (v1.8.0) — bottom bar, overlay bar. Flips
   * `video.muted` (NEVER volume: muting must not destroy the user's volume),
   * and the glyph/aria sync rides the `volumechange` event this fires.
   */
  function toggleMute() {
    const v = els.video;
    if (!v) return;
    v.muted = !v.muted;
  }

  /** Frame-step ±1 source frame (same semantics as the Shift+← / → shortcuts). */
  function stepFrame(direction) {
    const v = els.video;
    if (!v) return;
    const fps = Number(app.meta?.fps);
    const dt = direction / (fps > 0 ? fps : 30);
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    v.pause();
    v.currentTime = Math.min(Math.max(0, v.currentTime + dt), dur);
  }

  /**
   * Seek by `delta` seconds, clamped to 0..duration (v1.12.0 REQ-122 ←/→).
   * Unlike stepFrame this does NOT pause — a seek while playing keeps
   * playing, matching player conventions.
   */
  function seekBySeconds(delta) {
    const v = els.video;
    if (!v) return;
    const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
    const d = Number.isFinite(delta) ? delta : 0;
    v.currentTime = Math.min(Math.max(0, cur + d), dur);
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
  blurAfterClick(els.transportStart);
  // v1.11.0: the fullscreen overlay carries the same jump-to-start control.
  els.ovJump?.addEventListener('click', () => {
    const v = els.video;
    if (v) v.currentTime = 0;
  });
  blurAfterClick(els.ovJump);
  els.transportBack?.addEventListener('click', () => stepFrame(-1));
  els.transportFwd?.addEventListener('click', () => stepFrame(1));
  els.transportPlay?.addEventListener('click', () => togglePlay());
  els.transportSpeed?.addEventListener('change', () => setSpeed(els.transportSpeed?.value));
  // v1.8.0: both mute buttons route through the SAME shared toggle.
  els.muteButton?.addEventListener('click', () => toggleMute());
  // v1.4.0 REQ-111: the overlay bar calls the SAME shared actions.
  els.ovBack?.addEventListener('click', () => stepFrame(-1));
  els.ovFwd?.addEventListener('click', () => stepFrame(1));
  els.ovPlay?.addEventListener('click', () => togglePlay());
  els.ovMute?.addEventListener('click', () => toggleMute());
  els.ovSpeed?.addEventListener('change', () => setSpeed(els.ovSpeed?.value));
  els.ovExit?.addEventListener('click', () => exitPreview());
  // v1.6.1 REG-2: every transport/overlay control releases focus after pointer
  // activation (buttons on click, selects on the committed change) so the
  // doc-level shortcuts keep working after clicking ANY control.
  blurAfterClick(els.transportStart);
  blurAfterClick(els.transportBack);
  blurAfterClick(els.transportFwd);
  blurAfterClick(els.transportPlay);
  blurAfterClick(els.muteButton);
  blurAfterChange(els.transportSpeed);
  blurAfterClick(els.ovBack);
  blurAfterClick(els.ovFwd);
  blurAfterClick(els.ovPlay);
  blurAfterClick(els.ovMute);
  blurAfterChange(els.ovSpeed);
  blurAfterClick(els.ovExit);
  // volumechange (v1.8.0): drives the mute glyph/aria sync so external mute
  // flips (browser media controls) and toggleMute() both stay in sync.
  for (const ev of ['play', 'pause', 'timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'ratechange', 'volumechange']) {
    els.video?.addEventListener(ev, updateTransportUi);
  }
  updateTransportUi();
  // v1.8.2: unconditional timeupdate counter — the ?debug=1 log tick reads
  // and resets it (one `++` per event is the entire cost when the flag is
  // absent). Kept separate from updateTransportUi so the diagnostics signal
  // can never be entangled with UI refresh behavior.
  els.video?.addEventListener('timeupdate', () => {
    VR_DIAG.tu += 1;
  });

  // --- ?debug=1 runtime diagnostics (remote support; v1.8.2 + v1.9.0) --------
  //
  // Field problem: on a remote report we cannot see WHICH dist bundle the
  // browser cached, nor whether its timeupdate / rVFC signals fire at all
  // (the v1.8.1 thumb-freeze condition) — nor, after v1.9.0's unreproducible
  // "thumb + keyboard dead" report, whether ANY page exception or editor
  // gesture ever happened. With `?debug=1` in the URL, mountApp logs ONE
  // compact JSON line to the console every 2 s (10-minute lifetime cap — a
  // support session must never flood the log). Each line carries:
  //   v/build  — the RUNNING bundle identity (same stamps as the footer
  //              badge; a stale cached bundle is immediately identifiable),
  //   tu       — timeupdate events since the previous line (main.js listener),
  //   vfc      — rVFC-DELIVERED frame ticks since the previous line (counted
  //              in editor.js's tick ONLY — the rAF fallback never counts).
  //              Playing with `vfc: 0` while `tu > 0` proves frame
  //              presentation is dead on that machine and timeupdate is
  //              carrying — exactly the split v1.8.1 fixed.
  //   tued     — the EDITOR's own timeupdate listener firings (v1.9.0):
  //              `tu > 0, tued: 0` pins a dead editor listener (wiring),
  //              both 0 pins a dead media event stream.
  //   errs     — window 'error' + 'unhandledrejection' since the previous
  //              line; `lastErr` — first 80 chars of the last message
  //              (sticky). v1.9.0: ALWAYS-ON listeners, so even a plain
  //              URL without the flag records errors for the next line.
  //   drag     — thumb drag live (editor getGestureState, v1.9.0),
  //   pin      — release pin currently holding (v1.8.2 carried null: the pin
  //              was closure-private; v1.9.0 makes it observable),
  //   pinMs    — ms left before the pin self-expires (frozen-thumb
  //              signature: a pinMs that never reaches 0 while playing).
  //   plus     secure/step/t/dur/paused/rate/muted/thumbLeft/focus/tracks/
  //              webgpu (`focus` = document.activeElement "TAG#id" — a held
  //              focus is the classic "Space is dead" cause).
  // Without the flag: no interval, no logging — zero overhead (the error
  // listeners above stay on: two counters per actual error).
  // (Runs only past the secure-context gate: a gated page wires nothing.)

  /** Log cadence + lifetime cap for the [diag] line (v1.8.2). */
  const DIAG_INTERVAL_MS = 2000;
  const DIAG_MAX_LIFETIME_MS = 10 * 60 * 1000;

  /** One [diag] snapshot → console line; reads + resets the shared counters. */
  function logDiagTick() {
    const v = els.video;
    const view = doc.defaultView;
    const thumb = typeof doc.getElementById === 'function'
      ? doc.getElementById('timeline-thumb')
      : null;
    const tu = VR_DIAG.tu;
    const vfc = VR_DIAG.vfc;
    const tued = VR_DIAG.tued || 0;
    const errs = VR_DIAG.errs || 0;
    VR_DIAG.tu = 0;
    VR_DIAG.vfc = 0;
    VR_DIAG.tued = 0;
    VR_DIAG.errs = 0;
    // Gesture state: observable only while an editor is actually mounted
    // (mountEditorSafe may have failed — drag/pin/pinMs stay honest nulls).
    const gesture = editor && typeof editor.getGestureState === 'function'
      ? editor.getGestureState()
      : null;
    console.info('[diag]', formatDiagLine({
      v: APP_VERSION,
      build: BUILD_DATE || null,
      secure: view ? view.isSecureContext === true : null,
      step: app.step,
      t: v ? +Number(v.currentTime).toFixed(2) : null,
      dur: v ? +Number(v.duration).toFixed(2) : null, // NaN (no metadata) → null
      paused: v ? v.paused === true : null,
      rate: v ? +Number(v.playbackRate).toFixed(2) : null,
      muted: v ? v.muted === true : null,
      tu,
      vfc,
      tued,
      errs,
      lastErr: VR_DIAG.lastErr ?? null, // sticky until a newer error replaces it
      drag: gesture ? gesture.dragging : null,
      pin: gesture ? gesture.pinRemainingMs > 0 : null,
      pinMs: gesture ? gesture.pinRemainingMs : null,
      thumbLeft: thumb && thumb.style ? thumb.style.left : null,
      focus: focusLabel(doc.activeElement),
      tracks: app.tracks.length,
      webgpu: view ? 'gpu' in view.navigator : null,
      theme: currentTheme, // v1.12.0 REQ-124: the active theme rides the line
    }));
  }

  if (parseDebugFlag(doc.defaultView?.location?.search ?? '')) {
    console.info('[diag] enabled (?debug=1) — one line every 2s, auto-stops after 10min');
    const diagStartedAt = Date.now();
    /** @type {ReturnType<typeof setInterval>} */
    const diagTimer = setInterval(() => {
      if (Date.now() - diagStartedAt >= DIAG_MAX_LIFETIME_MS) {
        clearInterval(diagTimer);
        console.info('[diag] stopped — 10-minute lifetime cap');
        return;
      }
      logDiagTick();
    }, DIAG_INTERVAL_MS);
  }

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

  /**
   * Toggle fullscreen / enlarged preview (v1.12.0 REQ-122 KeyF + the ⛶
   * button share this exact path): active → exit, else request native
   * fullscreen with the in-page zoom fallback on rejection/unavailability.
   */
  function togglePreviewEnlarge() {
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
  }

  els.fullscreenButton?.addEventListener('click', () => {
    togglePreviewEnlarge();
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

  // --- Rail-split resize (v1.12.0 REQ-118 #rail-resize) -------------------------
  //
  // Same pattern as the stage-height handle above: pointer capture drag,
  // double-click reset, ArrowLeft/ArrowRight ±24 px on the focused handle.
  // The split is persisted per SESSION only (the `--rail-w` custom property
  // on #workspace — no localStorage; Clear and reloads reset it).

  let railWidth = DEFAULT_RAIL_WIDTH_PX;

  /**
   * Single rail-width mutation path: clamp → apply `--rail-w` on #workspace
   * (index.html sizes the side panel with it).
   */
  function applyRailWidth(px) {
    railWidth = clampRailWidth(px);
    if (els.workspace) els.workspace.style.setProperty('--rail-w', `${railWidth}px`);
  }

  const railHandle = els.railResize;
  if (railHandle) {
    /** Live pointer drag: pointerdown anchor + rail width at anchor. */
    let railDrag = /** @type {{startX: number, startW: number} | null} */ (null);

    railHandle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      railDrag = { startX: e.clientX, startW: railWidth };
      try {
        railHandle.setPointerCapture(e.pointerId);
      } catch {
        /* detached handle — capture is best-effort */
      }
      e.preventDefault();
    });
    railHandle.addEventListener('pointermove', (e) => {
      if (!railDrag) return;
      // The handle is the rail's LEFT edge: drag RIGHT = wider rail
      // (dragRailWidth is direction-pinned by unit test).
      applyRailWidth(dragRailWidth(railDrag.startX, e.clientX, railDrag.startW));
    });
    const endRailDrag = (e) => {
      if (!railDrag) return;
      railDrag = null;
      try {
        railHandle.releasePointerCapture(e.pointerId);
      } catch {
        /* never captured or already released */
      }
      applyRailWidth(railWidth); // drag end: final clamp
    };
    railHandle.addEventListener('pointerup', endRailDrag);
    railHandle.addEventListener('pointercancel', endRailDrag);
    // v1.6.1 REG-2 pattern: after a POINTER drag, release focus so the
    // doc-level transport shortcuts keep working.
    railHandle.addEventListener('pointerup', () => {
      if (railHandle.blur) railHandle.blur();
    });
    railHandle.addEventListener('dblclick', () => {
      applyRailWidth(DEFAULT_RAIL_WIDTH_PX);
    });
    railHandle.addEventListener('keydown', (e) => {
      const step =
        e.key === 'ArrowRight'
          ? RAIL_WIDTH_STEP_PX
          : e.key === 'ArrowLeft'
            ? -RAIL_WIDTH_STEP_PX
            : 0;
      if (step === 0) return;
      e.preventDefault();
      // Stop the doc-level shortcuts: the rail handle's ←/→ must NOT also
      // seek the video (the handle is not a button).
      e.stopPropagation();
      applyRailWidth(nextRailWidth(railWidth, step));
    });
    // Initial application so the CSS var exists even before the first drag
    // (a no-op when index.html already carries the same default).
    applyRailWidth(railWidth);
  }

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
