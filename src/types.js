/**
 * Shared data-model types for SPEC-VID-001 (design.md §2).
 *
 * Documentation-only module: `export {}` (below) makes this an ES module with
 * no runtime exports, so JSDoc references like `import('./types.js').Track`
 * resolve for the typechecker while the runtime import stays a no-op.
 * @typedef {import('./types.js').Track} TrackDoc
 * @example import('./types.js').Track — referenced from every src module.
 *
 * Coordinate-system invariant (ADR-9): every Box is in DISPLAY-oriented
 * native pixels — mediabunny applies container rotation at decode, so all
 * consumers (tracker, redact, editor, exporter) see the same upright space.
 */

export {};

/**
 * A rectangle in display-oriented native pixels (rotation already applied).
 * @typedef {object} Box
 * @property {number} x  Left edge, native display px.
 * @property {number} y  Top edge, native display px.
 * @property {number} w  Width, native display px (≥ 0).
 * @property {number} h  Height, native display px (≥ 0).
 */

/**
 * One raw detector output at one instant. Consumed by the tracker; never
 * rendered directly.
 * @typedef {object} Detection
 * @property {number} t       Presentation time in seconds.
 * @property {Box} box        Detection rectangle (display space).
 * @property {'face'|'plate'} cls  Which detector produced it.
 * @property {number} conf    Confidence in [0, 1].
 * @property {'full'|'tile'} pass  Producing pass; tile-local coords are
 *     merged back to full-frame coords BEFORE tracking (design §4.1).
 */

/**
 * One persistent real-world object across time — the unit the user reasons
 * about, toggles, and trusts.
 *
 * Privacy invariant (design §2): `keyframes` is DENSE over the redacted span
 * after `finalize()` interpolation — a box exists for every (track, t) in
 * [start, end]. Export asks only `tracksAt(t)` and never re-derives.
 *
 * @typedef {object} Track
 * @property {number} id                    Stable id, assigned in association order.
 * @property {'face'|'plate'|'manual'} cls  Class; 'manual' = user-drawn region.
 * @property {string} label                 Human label, e.g. "Face #1", "Plate #4", "Manual #2".
 * @property {string} color                 Categorical palette slot (CSS color).
 * @property {Map<number, Box>} keyframes   Seconds → box (detected + interpolated-filled).
 * @property {number} start                 Redacted span start, seconds.
 * @property {number} end                   Redacted span end, seconds.
 * @property {boolean} enabled              true = redact; false = keep visible (user toggle).
 * @property {'auto'|'manual'} source       Origin of the track.
 * @property {'pixelate'|'solid'} [style]   Redaction style (REQ-101): 'solid'
 *     burns an opaque black box, 'pixelate' mosaic-blurs. Default 'pixelate'
 *     for auto-detected tracks, 'solid' for manual tracks (tracker.js sets
 *     both); a missing field renders as 'pixelate' (redact.pixelateFrame
 *     dispatch). User-changeable per track until export.
 */

/**
 * Container/codec metadata extracted at ingest (design §3, ingest.js).
 * Display dimensions are the ROTATION-APPLIED frame size (ADR-9).
 * @typedef {object} MediaMeta
 * @property {string} container        Container format tag, e.g. 'mp4' | 'mov' | 'webm'.
 * @property {string} codec            Video codec string, e.g. 'avc1', 'hvc1', 'vp9'.
 * @property {number} displayWidth     Rotated (display) frame width, native px.
 * @property {number} displayHeight    Rotated (display) frame height, native px.
 * @property {number} rotation         Container rotation in degrees ∈ {0, 90, 180, 270}.
 * @property {number} fps              Average frame rate (frames per second).
 * @property {number} duration         Duration in seconds.
 * @property {{codec: string}|null} audio  Audio track info; null when silent.
 * @property {number} [codedWidth]     Pre-rotation coded frame width (metaFromTracks extra).
 * @property {number} [codedHeight]    Pre-rotation coded frame height (metaFromTracks extra).
 */

/**
 * Result of the REQ-002 decode/encode probe pass, shown in #cap-report
 * BEFORE analyze is offered (the "honesty moment"). Shape matches
 * `capability.probeCapabilities()` exactly (M5 wiring contract).
 * @typedef {object} CapabilityReport
 * @property {boolean} secureContext        false ⇒ REQ-004 gate blocks everything.
 * @property {string} [protocol]            Location protocol, e.g. 'https:' (guidance message).
 * @property {'chromium'|'webkit'} engine
 *     Sniffed browser engine; drives ORT execution-provider policy (ADR-5).
 *     (The documented 'gecko'/'unknown' values collapse into the chromium
 *     branch for v1 — see capability.js module doc.)
 * @property {'webgpu'|'wasm'} epPolicy     ADR-5 decision derived from engine.
 * @property {Array<{kind: 'video-decode'|'audio-decode'|'video-encode-avc'|
 *                   'video-encode-vp9', ok: boolean, codec?: string,
 *                   width?: number, height?: number, detail: string}>} probes
 *     Per-track decode probes (mediabunny `track.canDecode()`) and
 *     export-target encode probes (WebCodecs `isConfigSupported`, avc level
 *     ladder + vp9 fallback — ADR-7).
 * @property {boolean} canAnalyze           Primary video track decodable.
 * @property {boolean} canExport            At least one encode target viable.
 * @property {string[]} warnings            HDR/DV tone-shift and similar advisories.
 */

/**
 * Whole-application UI state (design §2). Owned by main.js; mutated only
 * through the stepper state machine / editor handlers.
 * @typedef {object} AppState
 * @property {'gate'|'ready'|'analyzing'|'review'|'exporting'|'done'} step
 * @property {File|null} file                       The opened source file.
 * @property {MediaMeta|null} meta                  From ingest.openInput().
 * @property {CapabilityReport|null} caps           From capability.probeCapabilities().
 * @property {Track[]} tracks                       Current review state.
 * @property {{dashcamMode: boolean, padSeconds: number,
 *             quality: 'high'|'balanced',
 *             confFace?: number, confPlate?: number,
 *             downscale?: 'full'|'1080p'|'720p', minSizePx?: number}} settings
 *     `confFace`/`confPlate` (v1.5.0 REQ-113): detection confidence
 *     thresholds from the Analyze-panel sensitivity sliders (face default
 *     0.6, plate 0.25); undefined → detector defaults.
 *     `downscale` (v1.12.0 REQ-117): analysis-canvas LONG-edge cap —
 *     'full' (default, native px) | '1080p' (cap 1920) | '720p' (cap 1280);
 *     detections are rescaled to display space before tracking.
 *     `minSizePx` (v1.12.0 REQ-120): minimum detection box dimension
 *     min(w, h) in display px (0 = no filter); smaller detections are
 *     dropped before the tracker.
 */
