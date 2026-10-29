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
 *   clampStageHeight(px, viewportH)    stage-height clamp (v1.2.0 handle)
 *   nextStageHeight(px, delta, vh)     handle keyboard step (v1.2.0)
 *   dragStageHeight(startY, y, startH) pointer-drag height (v1.3.1 direction fix)
 *
 * mountApp(document) owns ALL DOM access and stays untested (node has no
 * DOM); it runs automatically in the browser and is a no-op import in node.
 * It never mutates module behavior — modules are integrated as-is.
 *
 * SPEC-VID-002 wiring (all DOM-side, untested in node like the rest of
 * mountApp): REQ-103 trim hooks (editor chip-edge drag → trimTrack),
 * REQ-101 style hooks (track-row select → setTrackStyle), REQ-105 transport
 * bar (jump/frame-step/play-pause/speed/timecode driven by video media
 * events) and REQ-106 fullscreen preview (requestFullscreen with a
 * `.preview-zoom` in-page fallback + editor.redraw() resize kicks).
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
import { runAnalyze } from './analyze.js';
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
 */
const STEP_TRANSITIONS = {
  gate: {
    FILE_OPENED: 'ready',
  },
  ready: {
    ANALYZE_START: 'analyzing',
    FILE_OPENED: 'ready',
  },
  analyzing: {
    ANALYZE_FINISH: 'review',
    ANALYZE_FAIL: 'ready',
  },
  review: {
    ANALYZE_START: 'analyzing', // re-analyze (e.g. dashcam toggle changed)
    EXPORT_START: 'exporting',
    FILE_OPENED: 'ready',
  },
  exporting: {
    EXPORT_DONE: 'done',
    EXPORT_FAIL: 'review',
  },
  done: {
    ANALYZE_START: 'analyzing',
    EXPORT_START: 'exporting', // re-export after tweaking tracks
    FILE_OPENED: 'ready',
  },
};

/**
 * Pure reducer: current step + event name → next step, or null when the
 * transition is illegal in the current state.
 *
 * @param {import('./types.js').AppState['step']} step
 * @param {'FILE_OPENED'|'ANALYZE_START'|'ANALYZE_FINISH'|'ANALYZE_FAIL'|
 *          'EXPORT_START'|'EXPORT_DONE'|'EXPORT_FAIL'} event
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
 * Clamp a desired preview-stage height into [220, round(0.75·viewportH)] as
 * an integer. PURE. The 75vh bound is recomputed against the CURRENT
 * viewport on every call, so a window resize re-clamps on the next drag /
 * key step. Degradations: a non-finite `px` falls back to the default height
 * before clamping; a non-finite/≤ 0 `viewportH` drops the upper bound (min
 * still enforced) — a tiny viewport can never push the max below the min.
 *
 * @param {number} px Desired stage height, CSS px.
 * @param {number} viewportH Viewport height, CSS px (window.innerHeight).
 * @returns {number} Clamped integer stage height.
 */
export function clampStageHeight(px, viewportH) {
  let max = Infinity;
  if (Number.isFinite(viewportH) && viewportH > 0) {
    max = Math.max(Math.round(viewportH * STAGE_MAX_VIEWPORT_FRACTION), STAGE_MIN_HEIGHT_PX);
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
 * @returns {number} New clamped integer stage height.
 */
export function nextStageHeight(px, deltaPx, viewportH) {
  const step = Number.isFinite(deltaPx) ? deltaPx : 0;
  const from = Number.isFinite(px) ? px : DEFAULT_STAGE_HEIGHT_PX;
  return clampStageHeight(from + step, viewportH);
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
    quality: /** @type {HTMLSelectElement | null} */ ($('export-quality')),
    exportBar: $('export-progress-bar'),
    exportButton: /** @type {HTMLButtonElement | null} */ ($('export-button')),
    exportCancel: /** @type {HTMLButtonElement | null} */ ($('export-cancel')),
    exportStatus: $('export-status'),
    attribution: $('model-attribution'),
    toastRegion: $('toast-region'),
    changeFile: /** @type {HTMLButtonElement | null} */ ($('change-file')),
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
    // selector must follow or it would show a rate the video no longer has).
    if (els.transportSpeed) els.transportSpeed.value = '1';
    if (els.video) els.video.playbackRate = 1;
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

    const settings = { dashcamMode: els.dashcamToggle?.checked === true };
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
  els.analyzeCancel?.addEventListener('click', () => analyzeCtl?.abort());

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
  els.exportCancel?.addEventListener('click', () => exportCtl?.abort());

  // --- Transport bar (SPEC-VID-002 REQ-105 / AC-104) -----------------------------

  /**
   * One transport UI refresh from the live video element: play/pause glyph
   * swap + current/total timecode (formatClock). Driven by the media events
   * below so it works in EVERY workspace state (editor mount is review-only).
   */
  function updateTransportUi() {
    const v = els.video;
    if (!v) return;
    if (els.transportPlay) {
      const paused = v.paused;
      els.transportPlay.textContent = paused ? '▶' : '⏸';
      els.transportPlay.title = paused ? 'Play (space)' : 'Pause (space)';
      els.transportPlay.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    }
    const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
    if (els.transportTime) els.transportTime.textContent = `${formatClock(cur)} / ${formatClock(dur)}`;
    if (els.timelineCurrent) els.timelineCurrent.textContent = formatClock(cur);
    if (els.timelineDuration) els.timelineDuration.textContent = formatClock(dur);
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

  els.transportStart?.addEventListener('click', () => {
    const v = els.video;
    if (v) v.currentTime = 0;
  });
  els.transportBack?.addEventListener('click', () => stepFrame(-1));
  els.transportFwd?.addEventListener('click', () => stepFrame(1));
  els.transportPlay?.addEventListener('click', () => {
    const v = els.video;
    if (!v) return;
    if (v.paused) {
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      v.pause();
    }
  });
  els.transportSpeed?.addEventListener('change', () => {
    const v = els.video;
    if (!v) return;
    const rate = Number(els.transportSpeed?.value);
    v.playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  });
  for (const ev of ['play', 'pause', 'timeupdate', 'seeked', 'loadedmetadata', 'durationchange']) {
    els.video?.addEventListener(ev, updateTransportUi);
  }
  updateTransportUi();

  // --- Fullscreen / enlarge preview (SPEC-VID-002 REQ-106 / AC-105) --------------

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
    // in-page instead (REQ-106). The exit button stays visible on the stage.
    els.previewStage?.classList.add('preview-zoom');
    updateFullscreenButton();
    triggerPreviewResize();
  }

  function exitEnlarge() {
    if (isNativeFullscreen()) {
      const p = doc.exitFullscreen?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else {
      els.previewStage?.classList.remove('preview-zoom');
      updateFullscreenButton();
      triggerPreviewResize();
    }
  }

  els.fullscreenButton?.addEventListener('click', () => {
    if (isNativeFullscreen() || isZoomFallback()) {
      exitEnlarge();
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
  doc.addEventListener('fullscreenchange', () => {
    updateFullscreenButton();
    triggerPreviewResize();
  });
  window.addEventListener('resize', () => {
    // v1.2.0: re-clamp the stage against the new viewport (75vh bound) —
    // applyStageHeight ends in the same redraw kick as before.
    applyStageHeight(stageHeight);
  });
  // Escape exits the in-page fallback (native fullscreen gets it for free).
  doc.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isZoomFallback()) exitEnlarge();
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

  /** Live stage height (source of truth once the user first resizes). */
  let stageHeight = DEFAULT_STAGE_HEIGHT_PX;

  /**
   * Single stage-height mutation path: clamp → apply the `--stage-h` custom
   * property on #preview-stage (index.html sizes the stage with it; video +
   * overlay canvas keep their absolute fill) → aria-valuenow → editor
   * redraw() so the overlay re-scales to the new layout × DPR.
   */
  function applyStageHeight(px) {
    stageHeight = clampStageHeight(px, stageViewportH());
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
      applyStageHeight(nextStageHeight(stageHeight, step, stageViewportH()));
    });
  }

  // --- Keyboard (design-direction: space / ← / → / B in review states) ----------

  doc.addEventListener('keydown', (e) => {
    const target = /** @type {HTMLElement | null} */ (/** @type {unknown} */ (e.target));
    if (target && typeof target.closest === 'function' &&
        target.closest('input, select, button, textarea, [contenteditable]')) return;
    if (!(app.step === 'review' || app.step === 'done')) return;
    const v = els.video;
    if (!v) return;
    if (e.key === ' ') {
      e.preventDefault();
      if (v.paused) {
        const p = v.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } else {
        v.pause();
      }
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const fps = Number(app.meta?.fps);
      const dt = 1 / (fps > 0 ? fps : 30);
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : Infinity;
      v.pause();
      v.currentTime = Math.min(Math.max(0, v.currentTime + (e.key === 'ArrowRight' ? dt : -dt)), dur);
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
