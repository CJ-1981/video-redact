/**
 * Unit tests for src/project.js (v1.17.0 REQ-130 — project save/load).
 *
 * serializeProject / parseProject / validateVideoMatch are pure logic, so
 * these tests need no browser seams: in-memory Maps stand in for live
 * track keyframes and plain objects stand in for File.
 *
 * Coverage: round-trip fidelity (settings verbatim, trims, tracks with Map
 * keyframes → sorted JSON pairs → Map restored), typed parse errors
 * (bad-json / bad-structure per-field / unsupported-version), video-match
 * validation (exact name + size identity, lastModified never fails), and
 * the empty-tracks/trims + array-shape-keyframes edges.
 */
import { describe, it, expect } from 'vitest';
import {
  PROJECT_FORMAT_VERSION,
  serializeProject,
  parseProject,
  validateVideoMatch,
} from '../../src/project.js';

/** @returns a fully-populated project input with Map keyframes. */
function makeProjectInput(overrides = {}) {
  return {
    version: PROJECT_FORMAT_VERSION,
    settings: { confFace: 0.6, confPlate: 0.25, pixelStrength: 'normal' },
    trims: [
      { start: 1.5, end: 4 },
      { start: 10, end: 12.25 },
    ],
    tracks: [
      {
        id: 't1',
        label: 'Face 1',
        color: '#2DD4BF',
        enabled: true,
        style: 'pixelate',
        keyframes: new Map([
          [2.5, { x: 10, y: 20, w: 30, h: 40 }],
          [0.5, { x: 11, y: 21, w: 31, h: 41 }],
          [1.25, { x: 12, y: 22, w: 32, h: 42 }],
        ]),
      },
      { id: 't2', label: 'Plate 1', style: 'solid', enabled: true },
    ],
    meta: { videoName: 'clip.mp4', videoSize: 123456, videoLastModified: 1700000000000 },
    ...overrides,
  };
}

describe('serializeProject', () => {
  it('stamps PROJECT_FORMAT_VERSION ("1") on the output regardless of input version', () => {
    const json = serializeProject(makeProjectInput({ version: '9' }));
    expect(JSON.parse(json).version).toBe('1');
    expect(PROJECT_FORMAT_VERSION).toBe('1');
  });

  it('emits pretty (2-space indented) JSON', () => {
    const json = serializeProject(makeProjectInput());
    expect(json).toContain('\n  "version": "1"');
    expect(json.endsWith('}')).toBe(true);
  });

  it('serializes Map keyframes as [seconds, box] pairs sorted by time', () => {
    const { tracks } = JSON.parse(serializeProject(makeProjectInput()));
    expect(tracks[0].keyframes).toEqual([
      [0.5, { x: 11, y: 21, w: 31, h: 41 }],
      [1.25, { x: 12, y: 22, w: 32, h: 42 }],
      [2.5, { x: 10, y: 20, w: 30, h: 40 }],
    ]);
  });

  it('passes settings through verbatim and records video meta', () => {
    const parsed = JSON.parse(serializeProject(makeProjectInput()));
    expect(parsed.settings).toEqual({ confFace: 0.6, confPlate: 0.25, pixelStrength: 'normal' });
    expect(parsed.meta).toEqual({
      videoName: 'clip.mp4',
      videoSize: 123456,
      videoLastModified: 1700000000000,
    });
  });
});

describe('parseProject — round trip', () => {
  it('restores settings, trims and scalar track fields deep-equal to the input', () => {
    const input = makeProjectInput();
    const result = parseProject(serializeProject(input));
    expect(result.ok).toBe(true);
    expect(result.project.settings).toEqual(input.settings);
    expect(result.project.trims).toEqual(input.trims);
    expect(result.project.version).toBe('1');
    expect(result.project.meta).toEqual(input.meta);
    expect(result.project.tracks[0].id).toBe('t1');
    expect(result.project.tracks[0].style).toBe('pixelate');
  });

  it('restores keyframes as a Map with the sorted entries', () => {
    const result = parseProject(serializeProject(makeProjectInput()));
    expect(result.ok).toBe(true);
    const kf = result.project.tracks[0].keyframes;
    expect(kf).toBeInstanceOf(Map);
    expect([...kf.entries()]).toEqual([
      [0.5, { x: 11, y: 21, w: 31, h: 41 }],
      [1.25, { x: 12, y: 22, w: 32, h: 42 }],
      [2.5, { x: 10, y: 20, w: 30, h: 40 }],
    ]);
  });

  it('handles empty trims and tracks arrays', () => {
    const result = parseProject(serializeProject(makeProjectInput({ trims: [], tracks: [] })));
    expect(result.ok).toBe(true);
    expect(result.project.trims).toEqual([]);
    expect(result.project.tracks).toEqual([]);
  });
});

describe('parseProject — typed errors', () => {
  it('bad-json: corrupt / truncated JSON names the parse failure', () => {
    for (const text of ['{not json', '{"version": "1"', '']) {
      const result = parseProject(text);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('bad-json');
      expect(typeof result.message).toBe('string');
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('bad-json: valid JSON that is not an object (array / string / number)', () => {
    for (const text of ['[1,2,3]', '"a string"', '42', 'null']) {
      const result = parseProject(text);
      expect(result.ok).toBe(false);
      expect(result.code).toBe('bad-structure');
    }
  });

  it('bad-structure: each missing field is named in the message', () => {
    const cases = [
      [{ settings: {}, trims: [], tracks: [], meta: {} }, 'version'],
      [{ version: '1', trims: [], tracks: [], meta: {} }, 'settings'],
      [{ version: '1', settings: {}, tracks: [], meta: {} }, 'trims'],
      [{ version: '1', settings: {}, trims: [], meta: {} }, 'tracks'],
      [{ version: '1', settings: {}, trims: [], tracks: [] }, 'meta'],
    ];
    for (const [doc, field] of cases) {
      const result = parseProject(JSON.stringify(doc));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('bad-structure');
      expect(result.message).toContain(field);
    }
  });

  it('bad-structure: wrong-typed fields (settings object, trims/tracks arrays)', () => {
    for (const doc of [
      { version: '1', settings: [], trims: [], tracks: [], meta: {} },
      { version: '1', settings: {}, trims: {}, tracks: [], meta: {} },
      { version: '1', settings: {}, trims: [], tracks: {}, meta: {} },
    ]) {
      const result = parseProject(JSON.stringify(doc));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('bad-structure');
    }
  });

  it('unsupported-version: future version "2" reports the found version', () => {
    const doc = { version: '2', settings: {}, trims: [], tracks: [], meta: {} };
    const result = parseProject(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported-version');
    expect(result.message).toContain('2');
  });

  it('unsupported-version: non-numeric version "abc" also reports unsupported', () => {
    const doc = { version: 'abc', settings: {}, trims: [], tracks: [], meta: {} };
    const result = parseProject(JSON.stringify(doc));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('unsupported-version');
    expect(result.message).toContain('abc');
  });
});

describe('parseProject — keyframe shape tolerance', () => {
  it('accepts array-shaped keyframes (from JSON) and restores a Map', () => {
    const doc = {
      version: '1',
      settings: {},
      trims: [],
      tracks: [
        {
          id: 't1',
          keyframes: [
            [1, { x: 1, y: 2, w: 3, h: 4 }],
            [0.5, { x: 5, y: 6, w: 7, h: 8 }],
          ],
        },
      ],
      meta: { videoName: 'v.mp4', videoSize: 1, videoLastModified: 0 },
    };
    const result = parseProject(JSON.stringify(doc));
    expect(result.ok).toBe(true);
    expect(result.project.tracks[0].keyframes).toBeInstanceOf(Map);
    expect(result.project.tracks[0].keyframes.get(1)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(result.project.tracks[0].keyframes.get(0.5)).toEqual({ x: 5, y: 6, w: 7, h: 8 });
  });

  it('accepts in-memory Map keyframes (already-parsed object pass-through)', () => {
    const doc = {
      version: '1',
      settings: {},
      trims: [],
      tracks: [{ id: 't1', keyframes: new Map([[3, { x: 0, y: 0, w: 1, h: 1 }]]) }],
      meta: { videoName: 'v.mp4', videoSize: 1, videoLastModified: 0 },
    };
    // JSON.stringify reduces a Map to {}, so the Map shape only reaches the
    // parser via the already-parsed-object input path.
    const result = parseProject(doc);
    expect(result.ok).toBe(true);
    expect(result.project.tracks[0].keyframes).toBeInstanceOf(Map);
    expect(result.project.tracks[0].keyframes.get(3)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('validateVideoMatch', () => {
  const project = parseProject(serializeProject(makeProjectInput())).project;
  const matchingFile = { name: 'clip.mp4', size: 123456 };

  it('accepts an exact name + size match (identity check)', () => {
    expect(validateVideoMatch(project, matchingFile)).toEqual({ ok: true });
  });

  it('accepts a matching file even when lastModified drifted (never hard-fails on it)', () => {
    expect(
      validateVideoMatch(project, { name: 'clip.mp4', size: 123456, lastModified: 999 }),
    ).toEqual({ ok: true });
  });

  it('name-mismatch: different file name fails with a readable message', () => {
    const result = validateVideoMatch(project, { name: 'other.mp4', size: 123456 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('name-mismatch');
    expect(result.message).toContain('other.mp4');
    expect(result.message).toContain('clip.mp4');
  });

  it('size-mismatch: same name but different bytes (re-encoded copy) fails', () => {
    const result = validateVideoMatch(project, { name: 'clip.mp4', size: 654321 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('size-mismatch');
    expect(result.message).toContain('654321');
    expect(result.message).toContain('123456');
  });

  it('name is checked before size (a wrong file reports the name problem)', () => {
    const result = validateVideoMatch(project, { name: 'other.mp4', size: 654321 });
    expect(result.code).toBe('name-mismatch');
  });
});
