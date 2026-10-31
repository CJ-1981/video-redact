/**
 * project.js — REQ-130 (v1.17.0): project save/load.
 *
 * The user saves the current work (settings, trims, tracks) as a .vrproj
 * JSON file and loads it later to continue. The VIDEO IS NOT STORED — on
 * load the user re-opens the video file and it is validated against the
 * project's recorded metadata (name + size; lastModified is recorded for
 * provenance but never hard-fails, because it drifts across re-downloads).
 *
 * Contracts (wired by main.js — Agent-PROJECT / Agent-COMPARE / Agent-MAIN):
 *  - serializeProject({version, settings, trims, tracks, meta}) → string
 *      pretty JSON, version stamped PROJECT_FORMAT_VERSION ('1').
 *  - parseProject(jsonText) →
 *      { ok: true,  project: {version, settings, trims, tracks, meta} } |
 *      { ok: false, code: 'bad-json' | 'bad-structure' | 'unsupported-version', message }
 *  - validateVideoMatch(project, file) →
 *      { ok: true } | { ok: false, code: 'name-mismatch' | 'size-mismatch', message }
 *
 * Track keyframes: JSON has no Map, so on serialize a track's Map keyframes
 * become a sorted array of [seconds, box] pairs; on parse the array shape is
 * restored to a Map (an in-memory Map shape is also accepted on parse so the
 * same normalizer handles both).
 *
 * No DOM, no browser seams — pure logic, node-testable.
 */

/** Format version stamped into every serialized project (parse accepts exactly this). */
export const PROJECT_FORMAT_VERSION = '1';

/**
 * Serialize a project to pretty-printed JSON.
 *
 * `settings` passes through verbatim (main.js normalizes on apply); `trims`
 * is an array of {start, end}; `tracks` is an array passed through as-is
 * except that any Map `keyframes` on a track is serialized to a
 * time-sorted array of [seconds, box] pairs. The output version is always
 * stamped PROJECT_FORMAT_VERSION regardless of the caller-supplied
 * `version` field (the parameter exists so call sites can pass their live
 * state object straight through).
 *
 * @param {{version?: unknown, settings: object, trims: Array, tracks: Array,
 *          meta: {videoName: string, videoSize: number, videoLastModified: number}}} input
 * @returns {string} pretty JSON (2-space indent)
 */
export function serializeProject(input) {
  /** @type {Record<string, any>} */
  const src = /** @type {any} */ (input ?? {});
  /** @type {Record<string, any>} */
  const meta = /** @type {any} */ (src.meta ?? {});
  return JSON.stringify(
    {
      version: PROJECT_FORMAT_VERSION,
      settings: src.settings ?? {},
      trims: Array.isArray(src.trims) ? src.trims : [],
      tracks: (Array.isArray(src.tracks) ? src.tracks : []).map(serializeTrack),
      meta: {
        videoName: meta.videoName ?? '',
        videoSize: typeof meta.videoSize === 'number' ? meta.videoSize : 0,
        videoLastModified:
          typeof meta.videoLastModified === 'number' ? meta.videoLastModified : 0,
      },
    },
    null,
    2,
  );
}

/**
 * Serialize one track: keyframes Map → sorted [seconds, box] pairs
 * (JSON has no Map); every other field passes through untouched.
 */
function serializeTrack(track) {
  if (!track || typeof track !== 'object') return track;
  const kf = track.keyframes;
  if (kf instanceof Map) {
    return {
      ...track,
      keyframes: [...kf.entries()]
        .map(([seconds, box]) => [seconds, box])
        .sort((a, b) => a[0] - b[0]),
    };
  }
  // Already array-shaped (or absent) — pass through verbatim.
  return track;
}

/**
 * Parse and validate a .vrproj JSON document.
 *
 * Failure modes (all typed, messages readable per REQ-021 style):
 *  - 'bad-json'            — JSON.parse throws (corrupt/truncated file)
 *  - 'bad-structure'       — not a plain object, or a required field is
 *                            missing/wrong-typed (message names the field)
 *  - 'unsupported-version' — a version is present but !== '1' (message
 *                            includes the found version)
 *
 * Track keyframes accept BOTH shapes on parse: an in-memory Map (converted
 * to Map unchanged) or a JSON array of [seconds, box] pairs (restored to a
 * Map, entries left in file order — serialize wrote them sorted).
 *
 * @param {string|object} jsonText raw file contents, or an already-parsed
 *   project object (an in-memory Map keyframes shape can only exist there —
 *   JSON.stringify reduces a Map to {}, so the object path is how the Map
 *   shape actually reaches the normalizer)
 * @returns {{ok: true, project: object} | {ok: false, code: string, message: string}}
 */
export function parseProject(jsonText) {
  let data;
  try {
    data = typeof jsonText === 'string' ? JSON.parse(jsonText) : jsonText;
  } catch (err) {
    return {
      ok: false,
      code: 'bad-json',
      message: `This file is not valid JSON, so it can't be opened as a project (${err.message}). Re-save the project and try again.`,
    };
  }
  return normalizeProject(data);
}

/** Structure check + keyframe restoration for an already-parsed value. */
/** @returns {{ok: true, project: any} | {ok: false, code: string, message: string}} */
function normalizeProject(data) {
  if (!isPlainObject(data)) {
    return {
      ok: false,
      code: 'bad-structure',
      message: 'This project file does not contain a project object — it may be from another app.',
    };
  }

  if (typeof data.version === 'undefined') {
    return badStructure('version');
  }
  if (data.version !== PROJECT_FORMAT_VERSION) {
    return {
      ok: false,
      code: 'unsupported-version',
      message: `This project uses format version "${String(data.version)}", but this app only supports version "${PROJECT_FORMAT_VERSION}". Re-save the project with the current app.`,
    };
  }
  if (!isPlainObject(data.settings)) return badStructure('settings (expected an object)');
  if (!Array.isArray(data.trims)) return badStructure('trims (expected an array)');
  if (!Array.isArray(data.tracks)) return badStructure('tracks (expected an array)');
  if (!isPlainObject(data.meta)) return badStructure('meta (expected an object)');

  return {
    ok: true,
    project: {
      version: data.version,
      settings: data.settings,
      trims: data.trims,
      tracks: data.tracks.map(normalizeTrack),
      meta: data.meta,
    },
  };
}

/** Restore one track's keyframes to a Map from either supported shape. */
function normalizeTrack(track) {
  if (!track || typeof track !== 'object') return track;
  const kf = track.keyframes;
  if (kf instanceof Map) return track; // in-memory shape — already a Map
  if (Array.isArray(kf)) {
    return { ...track, keyframes: new Map(kf.map((entry) => [entry[0], entry[1]])) };
  }
  // Absent or unexpected shape — pass through; main.js owns track defaults.
  return track;
}

/** Typed bad-structure failure naming the offending field. */
/** @returns {{ok: false, code: 'bad-structure', message: string}} */
function badStructure(field) {
  return {
    ok: false,
    code: 'bad-structure',
    message: `This project file is missing or has an invalid "${field}" field — it may be corrupted or incomplete.`,
  };
}

/** True for non-null, non-array objects (the JSON "object" shape). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a re-opened video file against the project's recorded metadata.
 *
 * Identity check = exact name match + exact byte-size match. lastModified
 * is recorded in the project but deliberately NOT compared here — it
 * drifts across re-downloads and re-saves, so hard-failing on it would
 * reject the user's genuine file.
 *
 * @param {{meta?: {videoName?: string, videoSize?: number}}} project parsed project
 * @param {{name: string, size: number}} file the re-opened File
 * @returns {{ok: true} | {ok: false, code: 'name-mismatch'|'size-mismatch', message: string}}
 */
export function validateVideoMatch(project, file) {
  const meta = project && typeof project === 'object' ? project.meta : undefined;
  const savedName = meta ? meta.videoName : undefined;
  const savedSize = meta ? meta.videoSize : undefined;

  if (file.name !== savedName) {
    return {
      ok: false,
      code: 'name-mismatch',
      message: `The selected video "${file.name}" doesn't match the video saved in this project ("${savedName ?? 'unknown'}"). Open the original video file to continue.`,
    };
  }
  if (file.size !== savedSize) {
    return {
      ok: false,
      code: 'size-mismatch',
      message: `The selected video's size (${file.size} bytes) doesn't match the video saved in this project (${savedSize} bytes) — it may be a different or re-encoded copy of "${savedName}".`,
    };
  }
  return { ok: true };
}
