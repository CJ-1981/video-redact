# Technical Design: SPEC-VID-001 — Client-Side Video Redaction Web App

## 1. Architecture Overview

```
┌──────────────────────────── index.html (single file, dark editor shell) ───────────────────────────┐
│                                                                                                    │
│  ┌─ Stepper: ① Capability check → ② Analyze → ③ Review → ④ Export ─────────────────────────────┐   │
│  │                                                                                              │   │
│  │  ┌──────────────────────────────┐   ┌────────────────────────────────────────────────────┐   │   │
│  │  │ Preview stage                │   │ Right rail                            │   │   │
│  │  │  <video> (playback)          │   │  capability report / analyze progress │   │   │
│  │  │  <canvas> overlay (boxes,    │   │  track list (toggle, color, label)    │   │   │
│  │  │   pixel-truthful pixelate,   │   │  export settings + progress           │   │   │
│  │  │   manual-box drawing)        │   │  model/attribution panel              │   │   │
│  │  └──────────────────────────────┘   └────────────────────────────────────────────────────┘   │   │
│  │  ┌──────────────────────────────────────────────────────────────────────────────────────┐    │   │
│  │  │ Timeline: playhead · per-track colored chips (span = redacted range) · scrub/zoom    │    │   │
│  │  └──────────────────────────────────────────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────────────────────────────────────────┘   │
│  importmap → mediabunny@1.63.0 · onnxruntime-web@1.31.1 (pinned, CDN)                              │
└────────────────────────────────────────────────────────────────────────────────────────────────────┘
        │ ingest/capability            │ detector (ORT)              │ exporter (mediabunny Conversion)
  File → Input(BlobSource) ──frames──→ YuNet 640² / YOLOv9-t 640² ──→ burn-in process() ──→ MP4(H.264)+copied audio
        └ metadata/rotation            └ detections → tracker.js ──→ Track[] ──→ editor overlay + export
```

Data never leaves the page except: pinned CDN fetches (libraries, model weights — code/weights only, never user data).

## 2. Data Model

```ts
/** All boxes in DISPLAY-oriented native pixels (rotation applied by mediabunny). */
interface Box { x: number; y: number; w: number; h: number }

interface Detection {
  t: number;            // seconds (presentation time)
  box: Box;
  cls: 'face' | 'plate';
  conf: number;
  pass: 'full' | 'tile';// which pass produced it (tile merges back to full coords)
}

interface Track {
  id: number;                       // stable, assignment order
  cls: 'face' | 'plate' | 'manual';
  label: string;                    // "Face #1", "Plate #4", "Manual #2"
  color: string;                    // categorical palette slot
  keyframes: Map<number, Box>;      // seconds → box (detected + interpolated-filled)
  start: number;  end: number;      // redacted span = [start − pad, end + pad] materialized
  enabled: boolean;                 // true = redact; false = keep visible (user toggle)
  source: 'auto' | 'manual';
}

interface AppState {
  step: 'gate' | 'ready' | 'analyzing' | 'review' | 'exporting' | 'done';
  file: File | null;
  meta: MediaMeta | null;           // container/codec/res/fps/duration/rotation/audio
  caps: CapabilityReport | null;    // decode/encode probes per REQ-002
  tracks: Track[];
  settings: { dashcamMode: boolean; padSeconds: number; quality: 'high'|'balanced' };
}
```

Invariant (privacy): a box exists for every (track, t) in its redacted span — `keyframes` is dense after interpolation; export asks only `tracksAt(t)` and never re-derives.

## 3. Module Contracts (`src/*.js`)

| Module | Exports (summary) | Depends on |
|---|---|---|
| `capability.js` | `secureContextInfo()`, `probeCapabilities(input)` → `CapabilityReport`, `guidance(report)` | mediabunny, WebCodecs (seamed for mocks) |
| `ingest.js` | `openInput(file)` → `{ input, meta }` (codec, displayWidth/Height, rotation, fps, duration, audio codec); registers `@mediabunny/prores` for ProRes `.mov` | mediabunny (+prores extension) |
| `models.js` | `MODELS` registry (name, url, version, bytes, license, source), `ensureModel(name, onProgress)` → ArrayBuffer, cache in IndexedDB (`model@version` key) | IndexedDB, fetch |
| `detector.js` | `createDetectors()` → `{ detectFace(frameCanvas), detectPlate(frameCanvas), close() }`; `letterbox()`, `unletterbox()`, `decodeYunetOutputs()`, `nms()`, `parsePlateRows()`, `tileGrid()`, `mergeTiles()` | onnxruntime-web, models.js |
| `tracker.js` | `Tracker` class: `update(detections, t)`, `finalize(padSeconds)` → `Track[]`; `interpolate()`, `iou()`, `KalmanCV` | — |
| `redact.js` | `dilate(box, factor)`, `tracksAt(tracks, t)`, `applyPixelation(ctx, box, opts)`, `drawOverlay(ctx, tracks, t)` | — |
| `editor.js` | preview lifecycle, timeline render + hit-testing, toggle handlers, manual-box drawing; emits state mutations | redact.js, tracker output |
| `exporter.js` | `runExport({ input, tracks, settings, onProgress, signal })` → `{ blob?!, handle }` + fallback-ladder errors | mediabunny Conversion, redact.js, OPFS/FS Access |
| `main.js` | stepper state machine, DOM wiring, keyboard | all |

## 4. Key Algorithms

### 4.1 Letterbox (model space ⇄ display space)
Scale display frame to fit 640×640 preserving aspect; pad the short side. Store `{ratio, dw, dh}` per frame size (constant per file); `unletterbox(v) = (v − pad) / ratio`. Dashcam tiles: split display frame into `k` horizontal tiles (k from aspect: 4K16:9 → 3 tiles of ~1280×2160 display px each → letterboxed independently); merge-back scales tile-local boxes into full-frame coordinates before tracking (never after — tracking sees one coordinate space).

### 4.2 YuNet decode (per research-verified tensor spec)
Input `[1,3,640,640]` float32 RGB. Outputs at strides 8/16/32: `cls_8 [1,6400,1]`, `obj_8`, `bbox_8 [1,·,4]`, `kps_*` (ignored). score = `sigmoid(cls·obj)` per anchor; distance2bbox via anchor grid (80²/40²/20²); NMS IoU 0.3; confidence threshold default 0.6 (configurable). Landmark outputs discarded (detection-only product).

### 4.3 Plate decode (end-to-end)
Rows `[x1,y1,x2,y2,class_id,score]` in letterboxed coords; filter `score ≥ 0.25`; un-letterbox; convert to `Box`. No JS-side NMS (graph-embedded).

### 4.4 Tracking (IoU + constant-velocity Kalman)
Per class: predicted boxes from Kalman CV (x, y, w, h, dx, dy); IoU-gated association (greedy on IoU, gate 0.3); unmatched high-conf detections open tentative tracks (confirmed after 2 hits — suppresses one-frame ghosts); unmatched tracks coast ≤ `maxCoast` (default 0.5 s) then close. `finalize()` fills gaps by linear interpolation between surrounding keyframes and materializes `start/end` with ±`padSeconds` (default 5 frame periods). Manual tracks bypass the tracker (direct keyframes).

### 4.5 Pixelation (the only redaction style)
Region is dilated 15% (±7.5% per side, clamped). Block size: `block = max(12, round(min(boxW, boxH) / 10))` native px — guarantees ≥ ~10 blocks across the smallest dimension so the region is unrecoverable at a glance. Render: draw the clipped region to a scratch canvas at `1/block` scale with smoothing on, then draw back upscaled with `imageSmoothingEnabled = false`. Preview and export share this exact function (pixel-truthful preview, REQ-016).

### 4.6 Analyze loop
`Input` → primary video track → `VideoSampleSink.samples()` (presentation order, seconds-keyed timestamps). Per sample: draw to reusable OffscreenCanvas at analysis scale (full frame; 640 letterbox happens in `detector`), run face detector (every frame), plate detector (every 2nd frame; dashcam mode adds tiled plate+face pass), `tracker.update()`, `sample.close()` immediately, yield to the event loop every frame (`await microtask`/rAF) to keep Cancel/progress alive (P-5). Cancellation = AbortSignal checked per frame; `finalize()` still runs so partial tracks are usable.

### 4.7 Review playback
`<video>` element with Blob URL plays the original file; overlay canvas + pixelation drawn per `requestVideoFrameCallback`/rAF using `tracksAt(tracks, video.currentTime)`. Chips hit-testing from the same track map. Scrub sets `video.currentTime`; frame-step = ±1/fps.

### 4.8 Export
Mediabunny `Conversion.init({ input, output, video: { process } , ...})` — `process(sample)` draws the sample to canvas, applies `applyPixelation` for `tracksAt(t)`, returns the canvas (forces video transcode). Audio: always packet-copy (no `audio` config) — the output container is selected to host the source audio codec (AAC/MP4 primary; Opus/Vorbis follows the WebM fallback path), so no audio re-encode path exists. Output: `Mp4OutputFormat` → `StreamTarget(chunked:true)` → OPFS `FileSystemWritableFileStream` (all engines) or `showSaveFilePicker` writable (Chromium). Video codec ladder: `avc` (level probed for resolution, e.g. 4K → 5.1) → on any encode failure: retry `hardwareAcceleration:'prefer-software'` → `vp9` + `WebMOutputFormat`. Progress: `onProgress` 0–1 → UI; cancel via `conversion.cancel()` + temp-file cleanup (REQ-019, AC-14).

## 5. Runtime & Storage

- **EP policy (REQ-010)**: engine sniff `navigator.userAgent` WebKit check → WebKit: `executionProviders:['wasm']` (loads WASM-only asset set); else `['webgpu','wasm']` with session-create retry on failure. `numThreads = 1` (no COOP/COEP requirement on the static server).
- **Model cache (REQ-011)**: IndexedDB object store `models`, key `${name}@${version}`, value ArrayBuffer; first run streams with progress; `navigator.storage.persist()` requested after first successful analyze.
- **Secure-context gate (REQ-004)**: `!isSecureContext` → full-screen instructions; all handlers no-op.
- **CSP**: `<meta http-equiv="Content-Security-Policy">` allowing `connect-src` only to the pinned CDNs (jsdelivr, huggingface.co, github.com release assets) + `blob:`/OPFS; no other egress — user media bytes never leave via network APIs.

## 6. ADR Register

| ADR | Decision | Alternatives rejected (why) |
|---|---|---|
| ADR-1 | Dev ES modules + `tools/inline.mjs` → single `dist/index.html` | Pure inline-only source (untestable by vitest → breaks TDD mandate); full bundler (vite/rollup — heavier than needed, "no build" spirit) |
| ADR-2 | mediabunny 1.63.0 for all container work | mp4box.js + muxer glue (demux-only, .mov flaky, 3 libs to sync); ffmpeg.wasm (no HW accel, memory ceiling) |
| ADR-3 | Tracks keyframed in seconds, not frame indices | Frame-index keys (breaks under VFR sources; sink timestamps are authoritative) |
| ADR-4 | `<video>`-element playback for Review | Re-decode via CanvasSink during review (CPU cost, scrubbing complexity for zero user benefit) |
| ADR-5 | WebGPU EP only off WebKit; WASM on Safari | Universal WebGPU (ort#26827 WebKit blowup — closed stale); WebGL EP (deprecated) |
| ADR-6 | Pixelate-only redaction | Gaussian (Safari <18 silent no-op = redaction failure), solid (destroys more context than needed) — user decision, safety-aligned |
| ADR-7 | Export avc/MP4 primary, vp9/WebM fallback, audio packet-copy | HEVC encode (unreliable outside WebKit); audio re-encode (quality loss, AAC-encode gaps e.g. Linux Chrome) |
| ADR-8 | IndexedDB byte-cache for models | Cache API (fine, but byte-level control + version keying simpler in IDB); no cache (30 MB/redownload every session — unacceptable) |
| ADR-9 | Display-oriented coordinates everywhere post-ingest | Native-encoded coordinates (every consumer re-applies rotation; portrait bug class eliminated at the boundary) |

## 7. Security & Privacy Notes

- Threat model: untrusted media files (decoder errors surfaced, never trusted metadata for layout); untrusted CDN code mitigated only by version pinning + documented self-host swap; the privacy product invariant is the burn-in (AC-04) — preview equals output.
- No telemetry, no analytics, no fonts, no accounts. All network egress enumerated in CSP.
- Pixelate is obfuscation, not cryptography — minimum block-size rule (4.5) keeps regions practically unreadable; stated in UI copy.
- MX:WARN zones: frame-lifecycle leaks (exporter), EP fallback order (detector), cache-key versioning (models).
