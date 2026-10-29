# Codemap: Pipeline (data flow)

All boxes/coordinates are display-oriented native pixels after ingest (ADR-9). Seconds-keyed time everywhere (ADR-3). No user media bytes ever touch the network — only pinned CDN code/weights.

```
 File (user pick/drop)
   │  never uploaded
   ▼
 ┌──────────────┐  meta: container/codec/res/fps/duration/audio/rotation
 │ ingest.js    │  openInput(file) → { input, meta }   (+ ProRes decoder registration)
 └──────┬───────┘
        ▼
 ┌───────────────┐  CapabilityReport: decode probes (per track) + avc/vp9 encode probes
 │ capability.js │  probeCapabilities(input) → guidance(report)   [blocks or gates before Analyze]
 └──────┬────────┘
        ▼  Analyze (REQ-009 loop, cancellable, per-frame progress)
 ┌────────────────────────────────────────────────────────────────────┐
 │ analyze.js  runAnalyze: VideoSampleSink.samples() presentation    │
 │   order; reusable canvas; faces every frame, plates every 2nd;    │
 │   settings.confFace / confPlate gate EVERY detect call            │
 │   (REQ-113; defaults detector.DEFAULT_CONF_FACE 0.6 /             │
 │   DEFAULT_CONF_PLATE 0.25); dashcam mode adds a tiled pass —      │
 │   tileGrid splits along the DOMINANT axis (columns for landscape/ │
 │   square, stacked rows for portrait, REQ-107) → mergeTiles keeps  │
 │   ONE display coordinate space (ADR-9)                            │
 │   ┌──────────────┐   ┌───────────────┐   ┌────────────┐           │
 │   │ detector.js  │   │ detector.js   │   │ tracker.js │           │
 │   │ detectFace   │──▶│ detectPlate   │──▶│ Tracker    │           │
 │   │ (YuNet 640²) │   │ (YOLOv9-t 640²)│  │ update(t)  │           │
 │   └──────┬───────┘   └───────────────┘   └─────┬──────┘           │
 │          │ Detection[] (display space)         │ finalize(pad)    │
 │          │  models.js: ensureModel → ORT       ▼                  │
 │          │  (IndexedDB cache, WebGPU→WASM)   Track[] (dense       │
 │          │                                   keyframes, ±pad span)│
 └──────────┼────────────────────────────────────┼───────────────────┘
            │                                    │
            │  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
            │    THRESHOLD COMPARE SIDE-FLOW (REQ-114 — Analyze
            │    panel "Compare thresholds", before/instead of a
            │    full analyze)
            │  │                                                 │
            │    analyze.sampleFrameAt(input, t)  ← decodes ONE frame
            │  │        │                                        │
            │        └─▶ detectFaceRaw / detectPlateRaw — ONE
            │  │            inference per model, undecoded outputs │
            │        └─▶ decodeYunetOutputs / parsePlateRows
            │  │            re-decode the SAME inference at each    │
            │            fixed level 0.15 / 0.30 / 0.45 / 0.60 / 0.75
            │  │        └─▶ main.buildThresholdPanels → five side-  │
            │            by-side panels (faces teal, plates violet,
            │  │            per-panel count caption)                │
            │        └─▶ panel click: applyThresholdLevel → BOTH
            │  │            sensitivity sliders (REQ-113)           │
            │  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
            ▼                                    ▼
 ┌────────────────────────────────────────────────────────────────────┐
 │ editor.js + redact.js  REVIEW (pixel-truthful preview)             │
 │   <video> + overlay canvas: pixelateFrame(tracksAt(t)) burn-through│
 │   (per-track style dispatch: 'pixelate' or 'solid', REQ-101)       │
 │   timeline chips (renderTimeline/hitTestTimeline, chip-edge trim   │
 │   zones ±6 px / ±14 px coarse), toggleTrack, trimTrack (chip drag  │
 │   OR per-row clock inputs, REQ-108), setTrackStyle, manualTrack-   │
 │   FromBox (full-span fixed box, palette color) → Track[] (user-    │
 │   final states); transport bar + fullscreen/zoom overlay controls  │
 └──────────┬─────────────────────────────────────────────────────────┘
            ▼  Export (REQ-017..019, cancellable, streamed)
 ┌────────────────────────────────────────────────────────────────────┐
 │ exporter.js  runExport: mediabunny Conversion.init({ video:        │
 │   { process } }) — process(sample) = draw + redact.pixelateFrame   │
 │   for tracksAt(t) → BURNED-IN pixels (forces video transcode)      │
 │   audio: no config → packet-copied (AAC→MP4, Opus/Vorbis→WebM)     │
 │   ladder: avc hw → avc software → vp9/WebM (probe + runtime retry) │
 │   output: StreamTarget(chunked) → OPFS staging → save picker /     │
 │   Blob download → temp cleanup (discardExportTemp crash sweep;     │
 │   the same sweep runs on an explicit CLEAR, v1.6.0)                │
 └──────────┬─────────────────────────────────────────────────────────┘
            ▼
     Redacted MP4/WebM file (redaction burned in, original audio)
```

Shared seams: `redact.pixelateFrame` is used by BOTH the review preview and the export process callback (pixel-truthful preview, AC-04) — one implementation dispatching per-track `pixelate`/`solid` styles (REQ-101/102). `models.ensureModel` feeds ORT sessions; after first run all weights come from IndexedDB (zero network). The threshold compare reuses the analyze loop's decode seam (`sampleFrameAt`) and the detector decode functions, so panel detections behave exactly like analyze-pass detections at the same level.
