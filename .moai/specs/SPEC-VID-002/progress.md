# Progress: SPEC-VID-002

- created_at: 2026-10-29 (v1.1.0 iteration from field feedback on v1.0.0)
- requirement_source: user field report (undetected driver in portrait phone video) + explicit feature list
- miss_analysis: portrait 540x960 frame; driver face ~40-60px through glass, wheel-occluded, angled -> below YuNet conf 0.6 at full-frame 640 scale; horizontal-only dashcam tiling yields k=1 for portrait (no mitigation); detector fired at ~0:10 when face filled frame
- implementation: 3 parallel agents, disjoint files — (A) REQ-107 portrait row tiling in detector.js [landscape bit-identical; 540x960 -> 3 rows of 540x320, ~1.8x model scale]; (B) REQ-101/102 track.style pixelate|solid through types/tracker/redact/exporter [manual default solid, auto default pixelate, pixelateFrame shared-seam dispatch, exporter unchanged via seam]; (C) REQ-103..106 review UX in editor/main/index [full-span manual regions + chip-edge trim (6px zones), style dropdown, transport bar (jump/frame-step/play-pause/speed 0.25-4x/timecode), fullscreen + preview-zoom fallback, discoverability hint]; version 1.1.0 (package.json, CHANGELOG, README)
- verification: unit 360/360 (12 files) · gate exit 0 (lint 0, tsc 0, dist 138.2 KiB) · E2E 6/6 in 37.9s
- acceptance: AC-101..105 covered by unit + journey E2E; AC-106 covered by detector unit geometry tests (portrait rows) + live detection journey unchanged
- status: implemented (2026-10-29), pending deploy via push
