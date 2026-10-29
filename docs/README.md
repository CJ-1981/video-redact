# Docs

Screenshots of the shipped app (captured from the real `dist/index.html` in headless Chromium at 1280×800 @2x by `tools/capture-docs.mjs`):

| File | Shows |
| --- | --- |
| [01-landing.png](screenshots/01-landing.png) | Fresh intake: stepper at ① Capability check, drop zone, footer version badge |
| [02-capability.png](screenshots/02-capability.png) | File opened: capability report (container/codec/resolution/fps/audio, decode + encode probes, inference provider) with Analyze enabled |
| [03-review.png](screenshots/03-review.png) | After analyze: pixel-truthful preview with detected track overlay, timeline chip, track list with toggles |
| [04-export.png](screenshots/04-export.png) | After export: "Exported — download started" confirmation, all four stepper steps done |

The visual flow and captions live in the root [README.md](../README.md).
