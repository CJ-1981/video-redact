# Docs

Screenshots of the shipped app (captured from the real `dist/index.html` in headless Chromium at 1280×800 @2x by `tools/capture-docs.mjs`):

| File | Shows |
| --- | --- |
| [01-landing.png](screenshots/01-landing.png) | Fresh intake: stepper at ① Capability check, drop zone, footer version badge, header theme toggle + Save/Load project buttons, keyboard-shortcut legend, Models panel below the footer (the ✕ Clear / Open another file header actions appear once a file is loaded) |
| [02-capability.png](screenshots/02-capability.png) | File opened: file-info block + capability report (container/codec/resolution/fps/audio, decode + encode probes, inference provider), Analyze panel with dashcam toggle, detection-sensitivity sliders (face/plate), minimum-object-size filter, detection-detail selector, export settings (quality / resolution / audio), transport bar + timeline with the ✂ Trim toggle and pixel-strength group |
| [03-review.png](screenshots/03-review.png) | After analyze: pixel-truthful preview with detected track overlay, timeline chip, track row with span inputs + style dropdown + toggle |
| [04-export.png](screenshots/04-export.png) | After export: "Exported — download started" confirmation with the success toast, export settings (quality / resolution / Include audio), Tracks panel with All solid / All pixelate, compare-thresholds section below (the stepper is out of frame in this scrolled view) |

The visual flow and captions live in the root [README.md](../README.md).
