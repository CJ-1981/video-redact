# Acceptance Criteria: SPEC-VID-001 — Client-Side Video Redaction Web App

Full REQ → AC mapping: REQ-001/002 → AC-02 · REQ-003 → AC-11 · REQ-004 → AC-01 · REQ-005/016/017 → AC-04 · REQ-006/007 → AC-05 · REQ-008 → AC-09 · REQ-009 → AC-03 · REQ-010 → AC-17 · REQ-011 → AC-10 · REQ-012/013 → AC-18 · REQ-014 → AC-06 · REQ-015 → AC-07 · REQ-018/019 → AC-14 · REQ-020 → AC-19 · REQ-021 → AC-12; AC-08/13/15/16 cover cross-cutting audio/error/edge flows. Privacy-critical scenarios are marked **[PRIVACY-BLOCKING]** — the run phase may not declare the SPEC implemented while any of them fails.

## 1. Normal-Flow Scenarios

### AC-01 — Secure-context gate (REQ-004)
- **Given** the app is opened from `file://`
- **When** the page loads
- **Then** the UI shows serve-over-localhost instructions (copy-paste commands) and all processing actions are disabled; no storage or network calls are attempted.

### AC-02 — Capability report before processing (REQ-001, REQ-002)
- **Given** a supported browser served over `http://localhost`
- **When** the user opens an H.264 MP4 file
- **Then** the UI shows container, video codec, resolution, fps, duration, audio codec, and rotation, plus a decode ✓ / encode ✓ capability report before the Analyze step is enabled.

### AC-03 — Analyze pass with progress and cancellation (REQ-009)
- **Given** an analyzed-eligible video
- **When** the user starts Analyze and later presses Cancel
- **Then** progress (frame count, fps, ETA, track count) is displayed while running; after Cancel the app shows the tracks found so far in the Review editor with no partial-file residue. (Export progress monotonicity is bound by perf gate P-3 and exercised in AC-12/AC-14 flows.)

### AC-04 — Face detected, pixelated, burned in **[PRIVACY-BLOCKING]** (REQ-005, REQ-016, REQ-017)
- **Given** a fixture clip containing a clearly visible synthetic face patch
- **When** Analyze completes and the user exports
- **Then** the exported file's frames show a pixelated region covering the patch (block-level variance ≈ 0 inside the region), the pixelation is present in the encoded pixels (verified by re-decoding the output in-test), and no overlay/metadata-only redaction exists.

### AC-05 — Temporal padding: no unredacted leak frame **[PRIVACY-BLOCKING]** (REQ-006, REQ-007)
- **Given** a fixture clip where a face is detectable on frames 100–200 but turns away on 150–152
- **When** Analyze completes
- **Then** the track spans (first detection − padding) to (last detection + padding), interpolation covers the dropout frames, and stepping the preview frame-by-frame across 95–205 shows no frame where the face patch is simultaneously visible and unredacted.

### AC-06 — Track toggle: keep visible (REQ-014, REQ-017)
- **Given** an analyzed clip with ≥ 2 face tracks
- **When** the user toggles one track to "keep visible" and exports
- **Then** the excluded track appears unredacted in the output while all other tracks remain pixelated.

### AC-07 — Manual region (REQ-015)
- **Given** the Review editor on any frame
- **When** the user draws a manual box and sets a time span
- **Then** the manual track renders as a timeline chip, is pixelated in preview and export, and can be toggled like detected tracks.

### AC-08 — Audio preserved without re-encoding (REQ-017)
- **Given** a source with an AAC audio track
- **When** export completes
- **Then** the output contains an AAC audio track with the original packets (same codec string, duration within 1 frame period of source) and A/V sync is preserved (audio event at t aligns with video frame at t ± ½ frame period).

### AC-09 — Dashcam mode tiled pass (REQ-008)
- **Given** a high-resolution fixture frame containing a small synthetic plate patch (below single-pass effective size) 
- **When** Analyze runs with Dashcam mode ON
- **Then** the plate is detected and tracked; with Dashcam mode OFF the same input yields no plate track (detection threshold unchanged between runs).

### AC-10 — Model cache offline reuse (REQ-011)
- **Given** a successful first run that downloaded models
- **When** the app is reloaded with network requests to model CDNs blocked
- **Then** Analyze works entirely from the IndexedDB cache with no model network traffic. (First-run counterpart: the initial download displays byte progress per model.)

## 2. Error-Flow Scenarios

### AC-11 — Undecodable codec blocked with guidance (REQ-003)
- **Given** a browser without hardware HEVC decode (simulated capability probe)
- **When** the user opens an iPhone HEVC `.mov`
- **Then** processing is blocked and the UI presents the HEVC guidance (supported browsers; iPhone "Most Compatible" re-record path) — with no partial analysis started.

### AC-12 — Export fallback ladder (REQ-017, REQ-021)
- **Given** H.264 encoding at the source resolution fails at runtime (simulated encoder error)
- **When** export runs
- **Then** the app retries with the documented fallback ladder (software encode → VP9/WebM) and produces a valid output, informing the user which path was used; if all paths fail, a readable stage-specific error is shown and no corrupt file is delivered.

### AC-13 — Corrupt / zero-detection input (REQ-001, REQ-009)
- **Given** a truncated media file, or a valid file containing no faces/plates
- **When** ingest or analyze runs
- **Then** the corrupt file yields a readable ingest error; the zero-detection file completes analysis and the Review editor states "No faces or plates found" with manual-region drawing still available.

### AC-14 — Export cancellation cleanup (REQ-018, REQ-019)
- **Given** an export in progress writing to OPFS
- **When** the user cancels mid-export
- **Then** the OPFS root contains no temporary output entry afterwards (verified by listing), and a subsequent export starts cleanly. **When** the tab crashes mid-export and the app is reloaded, the app detects the stale temporary output on startup, surfaces it, and offers explicit deletion before the next export.

## 3. Edge Cases

### AC-15 — Portrait rotation (REQ-001, REQ-005)
- **Given** an iPhone portrait video (rotation matrix metadata)
- **When** analyzed and exported
- **Then** boxes are detected and redacted in display-oriented coordinates and the exported video keeps the correct orientation with redaction aligned to visible content.

### AC-16 — WebM/VP9 source (REQ-001, REQ-017)
- **Given** a VP9/WebM source with an Opus audio track
- **When** analyzed and exported
- **Then** the export uses the VP9/WebM path (or transcodes per the fallback ladder), the Opus audio is packet-copied into the WebM output (container-follows-codec branch), and redaction semantics are preserved.

### AC-17 — Execution-provider selection and fallback (REQ-010)
- **Given** a Chromium browser with a working WebGPU adapter
- **When** detection sessions are created
- **Then** inference runs on the WebGPU EP (WASM fallback registered). **Given** a WebKit browser, sessions are created directly on the WASM EP. **Given** a simulated WebGPU session-creation failure, the system falls back to WASM and analysis still completes with a UI notice of the active provider.

### AC-18 — Overlay and timeline synchronization (REQ-012, REQ-013)
- **Given** an analyzed clip with ≥ 2 tracks of different classes
- **When** the preview plays or scrubs
- **Then** every active track under the playhead renders its box, identity label, and stable track color synchronized within one displayed frame; the timeline shows exactly one chip per track spanning that track's redacted range; clicking a chip seeks the playhead into that range.

### AC-19 — Single-file artifact (REQ-020)
- **Given** a fresh checkout
- **When** `npm run build` runs
- **Then** `dist/index.html` is produced with all `src/` modules inlined and the pinned importmap; the E2E smoke suite passes against the built `dist/index.html` served over localhost (not the dev `index.html`), and the built file contains no references to local `src/` paths.

## 4. Performance Gates (reference: Apple M-series Mac, Chrome stable, WebGPU EP)

| Gate | Criterion |
|---|---|
| P-1 Analyze throughput | 1080p H.264: ≥ 24 fps analyzed (faces every frame, plates every 2nd) |
| P-2 Export throughput | 1080p: ≥ 0.25× realtime end-to-end including mux |
| P-3 4K correctness | 4K HEVC (HW-decode available): full analyze+export completes with monotonic progress, tab remains responsive, peak JS/Surface memory bounded (no per-frame retention; heap does not grow monotonically over the run) |
| P-4 First load | ≤ 40 MB total one-time download (runtime + models), then fully cached; app interactive < 3 s on localhost (excluding model download) |
| P-5 UI responsiveness | During analyze and export, main-thread long tasks do not block Cancel/progress UI updates for more than 500 ms |

## 5. Coverage & Quality Gates

- Unit coverage ≥ 85% lines on `src/*.js` excluding `main.js` (quality.yaml `test_coverage_target: 85`).
- `/moai gate` (lint + format + type-check + tests) exits clean before run-phase completion.
- E2E suite green in Chromium (the primary supported browser); Safari/Firefox covered by capability-gate messaging, not full E2E.
