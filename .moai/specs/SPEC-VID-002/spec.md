---
id: SPEC-VID-002
title: "Review UX & Manual Redaction Enhancements (v1.1.0)"
version: "1.1.0"
status: implemented
created: 2026-10-29
updated: 2026-10-29
author: MoAI
priority: P1
phase: "v1.1.0"
module: "index.html"
lifecycle: spec-anchored
tags: "redaction, manual-region, solid-style, transport-controls, fullscreen, playback-speed, portrait-tiling"
---

# SPEC-VID-002: Review UX & Manual Redaction Enhancements (v1.1.0)

## HISTORY

- v1.1.0 (2026-10-29): Created from user field feedback on SPEC-VID-001 v1.0.0. Real-world miss: driver's face in a portrait phone video (small, through-glass, wheel-occluded) not detected; dashcam tiling ineffective on portrait; manual-region span/style gaps; preview lacked transport controls, fullscreen, speed. Requirements below approved implicitly by the user's explicit feature request list.

## 1. Overview

v1.1.0 iterates the review experience of SPEC-VID-001: a solid-black redaction style (per track), manual regions that span the whole video with draggable trim handles, visible transport controls with playback speed, fullscreen preview, and portrait-aware dashcam tiling fixing the real-world miss class.

## 2. Requirements (GEARS)

### M1 — Redaction styles (extends SPEC-VID-001 M3/M4)

- **REQ-101** — The system shall support two redaction styles per track — `pixelate` and `solid` (opaque black box) — stored as `track.style`, with `pixelate` as the default for auto-detected tracks and `solid` as the default for manual tracks; the user shall be able to change a track's style from the track list at any time before export.
- **REQ-102** — The system shall burn each track's chosen style into the exported pixels using the same shared render seam used by the preview (preview == export for both styles).

### M2 — Manual region spans ("fixed box for a period")

- **REQ-103** — When the user draws a manual region, it shall by default span the entire video duration, and the user shall be able to trim its start and end by dragging the edges of its timeline chip (≤ 6 px edge hit zones) or by numeric inputs in the track row.
- **REQ-104** — While a manual region is selected in the track list, the preview shall highlight the region's box with a distinct outline so the user can verify placement before export.

### M3 — Transport & preview (extends SPEC-VID-001 M3)

- **REQ-105** — The preview panel shall expose visible transport controls: jump-to-start, frame-step back, play/pause toggle, frame-step forward, and a playback-speed selector (0.25×, 0.5×, 1×, 2×, 4×) that sets the preview playback rate; keyboard shortcuts remain functional.
- **REQ-106** — The preview panel shall offer a fullscreen/enlarge control; where the Fullscreen API is unavailable (iOS Safari), the system shall fall back to an in-page enlarged mode covering the viewport, with an always-visible way to exit.

### M4 — Portrait-aware detection (extends SPEC-VID-001 M2)

- **REQ-107** — The dashcam tiled pass shall split frames along the dominant axis: landscape frames tile horizontally (existing behavior), portrait frames tile vertically into stacked rows, so that a small face/plate in a portrait frame lands in a tile at ≥ ~2× the model-input scale it would have in a single full-frame pass; `mergeTiles` behavior (single display coordinate space) is unchanged.

## 3. Acceptance Criteria

- **AC-101** — A manual region defaults to spanning the full video; dragging its chip edges trims the span; export redacts exactly the trimmed span (Given/When/Then in acceptance.md).
- **AC-102** — A solid-style track exports opaque black over the region in every frame of its span, in both preview and output pixels (shared seam verified).
- **AC-103** — Style change from the track list (pixelate ↔ solid) is reflected immediately in preview and in the exported file.
- **AC-104** — Transport buttons perform play/pause/jump/frame-step; speed selector changes playback rate; keyboard shortcuts still work.
- **AC-105** — Fullscreen enlarges the preview stage and exits cleanly; the fallback path activates where `requestFullscreen` is unavailable.
- **AC-106** — A portrait frame (e.g. 540×960) with dashcam mode ON produces ≥ 2 vertical tiles, and a synthetic small face visible only at tile scale is detected with dashcam ON and missed with it OFF (unit-level geometry; live detection covered by the existing detectable fixture journey).

## 4. Exclusions (unchanged from SPEC-VID-001 + additions)

- No motion-tracking of manual regions (a manual region is a FIXED box — it does not follow the object across frames).
- No Gaussian blur style (pixelate + solid only).
- No automatic sensitivity/threshold UI (future work).

## 5. References

- Miss analysis (2026-10-29 field report): portrait 540×960 frame, driver face ~40-60 px through glass, wheel-occluded → below conf 0.6 at full-frame 640 scale; horizontal-only tiling yields k=1 for portrait → no mitigation; detector fired at ~0:10 when face filled frame.
- SPEC-VID-001 (base requirements; all still in force except where REQ-103/101 extend them).

## Amendments — v1.3.0 (2026-10-29, field feedback round 2)

- **REQ-108** — The track list shall expose per-track independent time editing: editable start/end inputs (clock format, committed on change/blur) that trim the track via the same trim path as chip dragging, updating preview, chips, and export span immediately.
- **REQ-109** — Manual tracks shall receive distinct categorical palette colors (same TRACK_COLORS sequence as auto tracks) instead of a shared fixed color; manual identity remains distinguishable (outline/label), not by color collision.
- **REQ-110** — During a chip-edge trim drag the chip's rendered length shall update live (and the row span readout with it); the operation must be visually self-evident. [Bug: v1.1.0/v1.2.0 trim drag updated the span but not the rendered chip.]

## Amendments — v1.4.0 (2026-10-29, field feedback round 3)

- **REQ-111** — In fullscreen and enlarged (zoom) preview modes, transport controls (play/pause, frame step, speed, and an exit control) shall remain reachable via an overlay control bar rendered inside the preview stage, shown only in those modes and auto-hiding after ~3 s of interaction idle (reappears on pointer/touch activity).
- **REQ-112** — The UI shall be mobile-friendly: at narrow viewport widths (≤ ~820 px) the layout collapses to a single column (right rail below the timeline), controls meet ~40 px touch-target sizing, timeline chip edge zones widen on coarse pointers, and no horizontal overflow occurs at 390 px width.

## Amendments — v1.5.0 (2026-10-29, field feedback round 4)

- **REQ-113** — Detection confidence thresholds shall be user-configurable per class (face default 0.6, plate default 0.25) via sliders in the Analyze panel; the configured values drive the analyze pass (and any re-analysis).
- **REQ-114** — Before running a full analysis, the user shall be able to run a single-frame threshold comparison: the system decodes one frame at a user-chosen time, runs each model exactly once, and renders side-by-side preview panels at fixed threshold levels (0.15/0.30/0.45/0.60/0.75) with per-panel detection counts (faces teal, plates violet); activating a panel applies that level to the sensitivity sliders. Single-frame decode and inference must complete within ~2 s on the WASM path.

## Amendments — v1.12.0 (2026-10-31, field feedback round 5)

- **REQ-115** — The analysis-abort control (existing #analyze-cancel) shall be visually prominent (danger styling, large) so users can stop slow passes.
- **REQ-116** — The threshold-compare section and the track list shall render UNDER the preview timeline (bottom flow), with compare panels laid out horizontally in a scrollable strip; the right rail shrinks to capability/export/other panels.
- **REQ-117** — An optional processing-downscale setting (Full / 1080p / 720p) shall cap the frame size used during analyze; detections shall be rescaled to native display coordinates before tracking (ADR-9 space unchanged downstream).
- **REQ-118** — A draggable vertical handle between the preview column and the side panel shall adjust their width split (clamped, persisted per session).
- **REQ-119** — A file-information block (name, size, last-modified date, type) shall render above the capability report.
- **REQ-120** — A detection minimum-size filter shall be selectable via BUTTONS (Any / ≥24px / ≥48px / ≥96px, min box dimension in display px); smaller detections are skipped before tracking.
- **REQ-121** — The compare frame-time input shall not truncate (full value visible/scrollable).
- **REQ-122** — Keyboard: ←/→ jump ±5 s; Shift+←/→ frame-step; F toggles fullscreen/enlarged preview; M toggles mute (Space/B unchanged); shortcuts active whenever the preview is visible.
- **REQ-123** — The Models/attribution panel shall render under the capability report (left column), out of the right rail.
- **REQ-124** — A light theme shall be available via a toggle (dark default, choice persisted in localStorage), implemented as a CSS custom-property set swap with no component changes.
