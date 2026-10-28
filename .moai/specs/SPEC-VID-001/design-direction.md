# Design Direction: SPEC-VID-001 — Client-Side Video Redaction App

Phase 7 artifact (Intent-First). `.moai/design/system.md` does not exist — Intent-First process executed fresh.

## Intent statement

- **Who is this human?** A creator, journalist, dashcam owner, or consultant who holds footage containing bystanders' faces and license plates and must share the video without exposing private data. They are typically non-technical about codecs/models; they care that the result is *actually* anonymous, not that it looks clever.
- **What must they accomplish?** Drop in a video → see every face/plate found and blurred → quickly review the timeline for misses → toggle/adjust → export a clean file. Fast and bounded (performance gates in acceptance.md), not open-ended waiting.
- **What should this feel like?** A calm, precise, offline "Swiss privacy tool". Dark, quiet, deliberate. The app conveys: *nothing leaves your machine, and the machine is checking every frame so you don't have to.* Trust through visible thoroughness (frame counts, track list, coverage) — not through marketing copy.

## Domain concepts and vocabulary

1. **Source** — the opened video file; capability-checked (decode? encode?) before anything else happens.
2. **Pass (Analyze)** — the detection sweep: frames decoded, models run, boxes produced. Shows honest progress (frame N of M, fps, ETA).
3. **Track** — one persistent real-world object across time (`Face #1`, `Plate #4`); the unit the user reasons about, toggles, and trusts. Colored consistently everywhere it appears.
4. **Region / Redaction style** — how a track is masked: pixelate (v1's single, deterministic style), applied with 15% dilation, burned into pixels at export.
5. **Review** — the scrub-and-verify step: timeline chips, per-track enable/disable, manual box drawing for misses.
6. **Export** — re-encode with redactions burned in, original audio preserved, streamed to disk.
7. **Capability check** — the upfront honesty moment: "this browser can decode your HEVC but can't encode H.264 at 4K" *before* work starts.

## Color world exploration

- **Graphite (chosen base)**: near-black slate `#111418` canvas, `#1A1F26` panels — editor-standard, makes video content the brightest thing on screen.
- **Signal amber `#F5A623`**: the privacy accent — progress, "redacting" state. Reads as caution/privacy, not as generic SaaS blue.
- **Track palette (categorical, max ~8 then repeat hues)**: teal, violet, coral, lime… assigned per track_id, used identically on boxes, timeline chips, and list rows — the user learns "violet = Face #2" once.
- **Safe green `#3ECF8E`**: track toggled to "keep visible" (excluded from redaction).
- **Alert red `#E5484D`**: undetected-but-manual regions, export failures, capability blockers.
- **Neutral ink `#9AA4B2`**: secondary text; never used for state.

## Signature element

**The track timeline**: a scrub bar where each detected object renders as a colored chip spanning its lifetime. A wall of chips = "the machine saw everything"; a gap the user fills with a manual region = visible, deliberate human control. Clicking a chip scrubs to it and toggles its redaction — the single interaction the whole product hangs on.

## Defaults to avoid (generic patterns rejected)

1. **Generic SaaS blue/purple + glassmorphism** — signals marketing site, not a precision tool; also date-stamps the UI.
2. **Config-first wizard** ("choose model → choose quality → …" before showing anything) — the video and its detected tracks must be the first content on screen; options live in a collapsible drawer.
3. **Cloud-upload mental model** (progress spinner uploading, "processing on our servers") — the entire value proposition is local processing; copy and UI must say "on this device" explicitly, with a visible offline/capability state.
4. **Metadata-overlay export illusion** — never render redaction as a live overlay that isn't burned in; the export preview must be pixel-truthful.

## Application to v1

- Single dark screen: preview canvas (top, with box overlay), track timeline (bottom), right rail = pass status + per-track list + export quality controls (pixelation is always-on for active tracks — no style picker).
- Three-state app flow surfaced as a simple stepper: **Analyze → Review → Export**, with the capability check gate in front.
- Keyboard: space = play/pause, ←/→ = frame step, B = draw manual box.
- Typography: system UI stack (no webfont download — single-file, offline-friendly); mono numerals for timecodes.
