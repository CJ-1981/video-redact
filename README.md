# Video Redact

Local, in-browser video redaction: faces and license plates are detected automatically, reviewed on a timeline, and pixelated **burned into the exported pixels** — nothing is ever uploaded. There is no server; the shipped artifact is a single self-contained `index.html`.

**Live app**: <https://cj-1981.github.io/video-redact/> (served over HTTPS, so it runs directly in the browser — every push to `main` rebuilds and redeploys it via GitHub Actions; the footer badge shows the version + build date).

| Landing | Capability report + Analyze panel |
| --- | --- |
| ![Landing — drop zone and stepper](docs/screenshots/01-landing.png) | ![Capability report before analyze](docs/screenshots/02-capability.png) |

| Review | Export |
| --- | --- |
| ![Review — pixel-truthful preview, transport bar, timeline chips, track list](docs/screenshots/03-review.png) | ![Export — download started, all steps done](docs/screenshots/04-export.png) |

1. **Landing** — drop a video; the four-step stepper (Capability check → Analyze → Review → Export), the header action cluster (light/dark theme toggle; Open new video and ✕ Clear appear once a video is loaded, 💾 Save project enables once loaded, 📂 Load project is always available) and the footer version badge (`v1.39.3 · built <build date>`).
2. **Capability** — after opening a file, the app reports container/codec/resolution/fps/audio plus decode and encode probes *before* Analyze is offered. Undecodable files are blocked here, with guidance. The Analyze panel carries the detection-sensitivity sliders with per-class Face/Plate on/off checkboxes (uncheck a class to skip that model entirely — a single-class pass costs one inference instead of two), a minimum-object-size filter (Any / ≥24 / ≥48 / ≥96 px), a detection-detail selector (analysis speed only), and a single-frame "Compare thresholds" preview. The Face/Plate checkboxes keep at least one detector on — unchecking the last remaining one snaps back with an explanation.
3. **Review** — detected tracks render as colored chips over their redacted span; the preview is pixel-truthful (it draws the exact redaction the export burns in). Toggle any track, switch its style (pixelate/solid, or restyle all at once), trim its span, scrub with the transport bar, draw manual regions (`B`), keyframe a selected manual region so it follows the subject (draw, then `K` at the playhead — preview and export interpolate between keyframes), re-scan an auto track's span at a lower threshold from its row, or mark trim regions (✂) to delete from the export. An audio waveform strip rides under the timeline (decoded at file load; click or drag it to seek).
4. **Export** — re-encoded H.264/MP4 (VP9/WebM fallback) with redactions burned in; original audio is packet-copied bit-for-bit, or dropped entirely via the "Include audio" checkbox; export resolution is Full (match source) / 1080p / 720p / 480p (v1.18.0 added the 480p option — long edge 854, the smallest/fastest choice); resolution and audio choices persist across repeated exports — they reset only on file load and Clear (v1.17.1).

## Quick start

Requires Node >= 20 and a Chromium-based browser.

```sh
npm install
npm run build        # bundles src/ into the single-file dist/index.html
npm run dev          # serves the repo root at http://127.0.0.1:8000
```

Then open <http://localhost:8000/dist/index.html>. Or skip the local setup entirely and use the hosted page: <https://cj-1981.github.io/video-redact/>.

**Serve over localhost — never `file://`.** The app needs secure-context APIs (WebCodecs, IndexedDB, OPFS, WASM); under `file://` it deliberately blocks all processing and shows serve instructions (`python3 -m http.server 8000`, `npx serve`). `python3 -m http.server 8000` or `npx serve` from the repo root work just as well — and the GitHub Pages deployment is already HTTPS, so it is a secure context by default.

## What it does

- **Ingest** — demuxes `.mov` / MP4 / WebM locally via mediabunny 1.63.0, including iPhone HEVC `.mov` (hardware decode required) and ProRes via the `@mediabunny/prores` extension. Metadata and rotation are reported before any processing.
- **Capability gate** — per-track decode probes (`track.canDecode()`) and export-encode probes (WebCodecs `isConfigSupported`, H.264 level ladder + VP9) are shown as a report; undecodable input is blocked with actionable guidance and no partial processing.
- **Detection** — YuNet face detection (2023mar, 640×640 letterboxed) and YOLOv9-t-640 end-to-end license-plate detection, running via onnxruntime-web 1.31.1 with a WebGPU → WASM execution-provider ladder. "Dashcam mode" adds a second tiled pass for small/distant faces and plates — tiles split along the dominant axis, so portrait frames tile vertically into stacked rows. Face/plate confidence thresholds are configurable via sensitivity sliders, each class can be skipped entirely for the pass via its checkbox (skips the model's full pass and tiles — roughly halving detection cost), and a single-frame comparison shows five fixed threshold levels side by side before you commit to a full analysis — the comparison honors your dashcam-mode, minimum-object-size and detection-detail settings, so panels show what a real analyze would find.
- **Tracking** — detections are linked into persistent labeled tracks ("Face #1", "Plate #4") with IoU-gated association and a constant-velocity Kalman filter; gaps are interpolated, and every span is padded ±5 frame periods and dilated 15% (7.5% per side) so no unredacted frame of a detected object survives (privacy-critical AC-05).
- **Review** — timeline chips with draggable edge handles, per-track redact/keep-visible toggles, and a per-track redaction style (pixelate or solid black), plus a visible draggable scrub handle on the timeline (drag it to scrub — reliably with a desktop mouse too — tap the track to jump, arrow-key steppable when focused). The timeline, scrub handle and Space playback are live the moment a video is loaded — before any analysis — and manual regions drawn pre-analysis are preserved through it. The scrub thumb follows playback even where the frame loop never fires (a `timeupdate` fallback carries it), keyboard shortcuts keep working after clicking any control, and editor mount/tick failures stay isolated (a readable toast — the rest of the app keeps working). Manual regions drawn on the video (`B`) span the whole clip by default, are trimmed via chip edges or per-track start/end inputs, and can follow a subject through keyframes (select the row, draw a box, press `K` at each playhead position — interpolation is identical in preview and export). Auto-track rows show their mean detection confidence and carry a Re-scan action that re-runs detection inside the track's own span at a lowered threshold and merges the new boxes. The preview is pixel-truthful (preview and export share the same render code path) with a transport bar (frame stepping, 0.25×–4× speed, audio mute mirrored into the enlarged-preview controls), fullscreen/enlarge mode with auto-hiding overlay controls, and a draggable preview-height handle. A zoomed timeline scrolls horizontally instead of clipping chips (v1.31.0). The zoom controls (🔍− / 🔍+ / ⤢ Fit) and the 👁 hold-to-peek button sit in the trim bar, right of ✂ Trim (v1.38.0).
- **Trim (v1.15.0–v1.15.2)** — toggle ✂ Trim (timeline area) and drag on the timeline to mark regions for deletion: greyed-out overlays with draggable ✂ edges, multiple regions supported, and the export ships only the kept segments concatenated with continuous timestamps (no re-encode; no trims → unchanged single-pass export). Analysis skips frames inside trim regions entirely — large trims make the detect pass proportionally faster and keep ghost tracks out of the list.
- **Pixelation strength (v1.17.0)** — Fine / Normal / Coarse / Max block-size multiplier (×1–×4; Normal doubles the original block size), applied identically in preview and export. The selector lives in the Analyze panel's Detection settings (moved from the timeline trim bar in v1.38.0).
- **Project save/load (v1.17.0)** — 💾 Save project downloads a `.vrproj` (JSON: settings, trim regions, tracks incl. manual regions, video identity — no video bytes); 📂 Load project restores it, re-associating the video file with readable mismatch warnings and typed errors for corrupt projects.
- **Workspace layout (v1.11.0–v1.14.0)** — keyboard transport (`←`/`→` jump ±5 s, `Shift+←/→` frame-step, `F` fullscreen/enlarge, `M` mute, `Space` play/pause, `B` draw box), light theme via a header toggle (persisted), file-info block above the capability report, optional analysis downscale (Full / 1080p / 720p) for faster 4K passes, bulk "All solid" / "All pixelate" restyle buttons, collapsible panels, the Models panel under the footer, a "Use preview time" button in the compare panel, and draggable resize handles for the preview-stage height, the right rail width, and the intake-panel width (keyboard + double-click reset on each). The Tracks and Compare-thresholds panels sit directly below the timeline **inside the preview column** (v1.18.0–v1.18.1): they follow the preview-column width and keep a constant gap under the timeline no matter how tall the right rail is.
- **Mobile** — at viewport widths ≤ 820 px the app collapses to a single column with ≥ 40 px touch targets; timeline chip-edge grab zones widen on touch pointers and tap-to-seek fires on pointerup (works on iOS Safari/WebKit). Header buttons go glyph-only on narrow screens (icons come solely from CSS `::before` — no doubled icons). On iOS, exports deliver via the **Web Share API** (save to Files / share sheet — `<a download>` is ignored there, v1.29.0), and browsers without OPFS `createWritable` fall back to in-memory export staging (v1.24.0).
- **Export** — every frame is decoded, redactions burned into the pixels, and the video re-encoded (H.264/MP4 primary → software H.264 → VP9/WebM fallback ladder); audio packets are copied without re-encoding (AAC → MP4, Opus/Vorbis → WebM) or dropped entirely. Export resolution (Full / 1080p / 720p / 480p) scales the burn-in canvas, redaction boxes and encoder hints together. Output streams to disk-backed storage (OPFS / File System Access) with progress and cancellation.
- **Export before analysis (v1.35.0–v1.37.0)** — at READY (before any analysis) Export is enabled for manual-regions-only redaction — manual tracks, watermark and export settings still apply. The pre-analysis button is grey and labels itself "Export (not analyzed)" so it can't be mistaken for an analyzed export; once analysis completes it flips back to the accent "Export redacted video".
- **Clear** — the header "✕ Clear" button (styled red as a destructive action) aborts any in-flight pass, unloads the video (blob URL, decoder, export temps) and resets every panel to the landing view; the model cache and your preview-stage height survive.

## Privacy

- **Detection only** — no face recognition, no OCR, no license-plate character reading, no identity matching.
- **All processing on-device** — video bytes never leave the machine. The only network requests are the pinned CDN libraries and the two ONNX model weights on **first run** (about 8 MB of weights; ≤ 40 MB total first load); afterwards weights load from an IndexedDB cache (`video-redact-models`) with zero network traffic.
- **No telemetry, no analytics, no fonts, no accounts.** A Content-Security-Policy enumerates every allowed network host; nothing else can egress.
- **Model licenses & attribution** — YuNet ([opencv/face_detection_yunet](https://huggingface.co/opencv/face_detection_yunet), MIT) and YOLOv9-t license plates ([ankandrew/open-image-models](https://github.com/ankandrew/open-image-models), MIT repo license), shown in the app's Models panel. The plate model is fetched from a Hugging Face mirror of the upstream GitHub release asset because GitHub release assets send no CORS headers.

## Browser support

| Browser | Inference | Notes |
| --- | --- | --- |
| Chrome / Edge (recent) | WebGPU, WASM fallback | Recommended |
| Safari | WASM directly (WebKit policy) | Works; slower analyze |
| Firefox | WebGPU attempt, WASM fallback | Works; capability gate explains limits |

4K HEVC (iPhone) input requires hardware HEVC decode in the browser — the capability report tells you before any work starts, and suggests re-recording in H.264 ("Most Compatible") when unavailable.

Mobile Chrome/Edge: single-column layout; processing 4K on phones is slow — desktop recommended.

## Android recordings

Yes — modern Android camera output is the app's fully-supported path. Recorded on-device or moved to a desktop:

| Recording | Support |
| --- | --- |
| Standard camera video (MP4, H.264 + AAC) | Fully supported — hardware decode, hardware encode, audio packet-copied |
| Screen recordings (MP4/H.264, WebM/VP9) | Fully supported; VP9 input takes the WebM export branch (Opus audio copied) |
| Third-party app containers (MKV, TS) | Readable containers; codec support follows the browser's decoders |
| "High efficiency" HEVC mode (flagships) | Needs hardware HEVC decode in the browser; the capability report blocks with guidance if unavailable |
| HDR10+/HLG 10-bit | Decodes; exports tone-mapped to 8-bit SDR (HDR metadata not preserved) |
| Slow motion (120/240 fps) | Works; detection time scales linearly with frame count (a 1-min 240 fps clip ≈ 14,400 frames to sweep) |
| 8K (Samsung flagships) | H.264 export beyond probed levels is unsupported — the capability report offers VP9/WebM fallback or explains the limit |

**On-device vs. desktop.** Chrome for Android can open files, decode (including hardware HEVC on modern SoCs), and deliver exports via the download path — but 4K analysis on a phone runs for minutes and recent Android Chrome may not expose WebGPU for every device. The practical recommendation: **record on Android, process on a desktop Chrome/Edge**, where WebGPU makes analysis roughly 10–20× faster than the WASM fallback.

## Development

```sh
npm run dev           # static server on 127.0.0.1:8000 (no-store; serves src/ ES modules)
npm test              # vitest unit suite (node environment)
npm run test:coverage # v8 coverage; >= 85% line gate on the 8 logic modules
npm run test:e2e      # Playwright, Chromium, serial workers (needs: npx playwright install chromium)
npm run build         # tools/inline.mjs -> single-file dist/index.html (~352 KiB)
npm run lint          # eslint (flat config)
npm run typecheck     # tsc --noEmit (checkJs over JSDoc types)
npm run gate          # lint && typecheck && test && build
```

- **Layout** — `index.html` (dev shell: importmap pins, CSP, UI), `src/` (one module per pipeline stage; JSDoc-typed via `src/types.js`), `tools/` (dev server, inliner, fixture/screenshot/debug scripts), `tests/unit/`, `tests/e2e/`, `tests/fixtures/`, `docs/screenshots/`.
- **Single-file build** — `tools/inline.mjs` bundles `src/main.js` with esbuild (CDN bare specifiers stay external and resolve through the dist importmap), inlines the bundle into `index.html`, stamps `__APP_VERSION__`/`__BUILD_DATE__`, and fails the build if any `src/` reference leaks.
- **Testing** — TDD per module: pure logic (tracker, redact geometry + strength, timeline model incl. trims, detector decode, exporter ladder + geometry scaling, project serialize/parse) is unit-tested in node with seams/mocks; the browser stack (decode, inference, export burn-in) is covered by Playwright end-to-end tests (5 spec files, incl. an auto-detect journey with a real YuNet detection and an offline-models run).
- **Specs** — requirements and architecture live under `.moai/specs/SPEC-VID-001/` (base app) and `.moai/specs/SPEC-VID-002/` (review UX & manual redaction amendments, v1.1.0–v1.39.3, REQ-101…130).

## Versioning

Current version: **1.39.3** (see [CHANGELOG.md](CHANGELOG.md)). The version lives in `package.json` (single source of truth); `npm run build` stamps it — with the build date (UTC calendar date of the build) — into the dist bundle. At runtime it appears in the footer badge (`v1.39.3 · built <date>`) and in the console at boot; with `?debug=1` every diagnostic line also carries the running bundle identity. Dev mode (unbuilt) shows `dev build (unbuilt)`.

## Known limitations (v1)

- Pixelate and solid black are the only redaction styles (no blur) — pixelation *strength* (v1.17.0) varies the block size, not the style.
- No plate OCR / character reading and no face recognition — detection + redaction only.
- No partial audio editing; the audio track is copied as-is or dropped whole (v1.16.0 "Include audio" checkbox) — no per-region audio redaction.
- iPhone HDR/Dolby Vision footage exports tone-mapped to SDR — HDR metadata is not preserved.
- One file per session — no batch processing.
- A saved `.vrproj` project holds settings/tracks/trims and video identity only — the video file itself is re-associated on load, not embedded.
- Pixelation is obfuscation, not cryptography (the app says so; the minimum block-size rule keeps regions practically unreadable).
