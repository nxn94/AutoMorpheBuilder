// .github/scripts/__tests__/prune-old-releases.test.js
'use strict';

// Tests for the pure `selectTagsToDelete` helper in prune-old-releases.js.
// We exercise the selection logic only; the env-dependent
// `gh release list` / `gh release delete` calls are integration-tested
// by the workflow itself.

const { selectTagsToDelete } = require('../prune-old-releases');

const makeRelease = (tagName, publishedAt) => ({ tagName, publishedAt });

describe('selectTagsToDelete', () => {
  test('returns an empty array when no releases match the app prefix', () => {
    const releases = [
      makeRelease('reddit-v2025.02.17-v1.24.0-dev.8', '2024-12-02T10:00:00Z'),
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'nzb360', 2)).toEqual([]);
  });

  test('returns an empty array when fewer than keepCount+1 releases match', () => {
    const releases = [
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 2)).toEqual([]);
  });

  test('returns an empty array when exactly keepCount releases match', () => {
    const releases = [
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
      makeRelease('youtube-v20.43.10-v1.24.0-dev.7', '2024-11-15T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 2)).toEqual([]);
  });

  test('returns the oldest N - keepCount tags when more than keepCount match', () => {
    const releases = [
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
      makeRelease('youtube-v20.43.10-v1.24.0-dev.7', '2024-11-15T10:00:00Z'),
      makeRelease('youtube-v20.42.5-v1.24.0-dev.6', '2024-10-01T10:00:00Z'),
      makeRelease('youtube-v20.41.0-v1.23.0', '2024-09-01T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 2)).toEqual([
      'youtube-v20.41.0-v1.23.0',
      'youtube-v20.42.5-v1.24.0-dev.6',
    ]);
  });

  test('does not touch other apps\' releases even when their tags share a prefix', () => {
    // Defensive case: a future app named 'youtube-music' would have tags
    // starting with 'youtube-music-v'. ^youtube-v (the -v separator is
    // required) does not match that, so we keep the prefix boundary
    // strict.
    const releases = [
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
      makeRelease('youtube-v20.43.10-v1.24.0-dev.7', '2024-11-15T10:00:00Z'),
      makeRelease('youtube-v20.42.5-v1.24.0-dev.6', '2024-10-01T10:00:00Z'),
      makeRelease('youtube-music-v8.44.54-v1.24.0-dev.8', '2024-12-02T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 2)).toEqual([
      'youtube-v20.42.5-v1.24.0-dev.6',
    ]);
  });

  test('honours a custom keepCount', () => {
    const releases = [
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
      makeRelease('youtube-v20.43.10-v1.24.0-dev.7', '2024-11-15T10:00:00Z'),
      makeRelease('youtube-v20.42.5-v1.24.0-dev.6', '2024-10-01T10:00:00Z'),
      makeRelease('youtube-v20.41.0-v1.23.0', '2024-09-01T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 3)).toEqual([
      'youtube-v20.41.0-v1.23.0',
    ]);
  });

  test('orders deletions oldest-first regardless of input order', () => {
    // Input is deliberately unsorted to prove the function sorts
    // internally. With 4 matching releases and keepCount=2, the two
    // oldest (by publishedAt) come out in ascending order so a
    // partial run deletes the oldest garbage first.
    const releases = [
      makeRelease('youtube-v20.41.0-v1.23.0', '2024-09-01T10:00:00Z'),
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
      makeRelease('youtube-v20.42.5-v1.24.0-dev.6', '2024-10-01T10:00:00Z'),
      makeRelease('youtube-v20.43.10-v1.24.0-dev.7', '2024-11-15T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 2)).toEqual([
      'youtube-v20.41.0-v1.23.0',
      'youtube-v20.42.5-v1.24.0-dev.6',
    ]);
  });

  test('uses tagName as a deterministic tiebreak when publishedAt is identical', () => {
    const releases = [
      makeRelease('youtube-v20.41.0-v1.23.0', '2024-09-01T10:00:00Z'),
      makeRelease('youtube-v20.43.10-v1.24.0-dev.7', '2024-09-01T10:00:00Z'),
      makeRelease('youtube-v20.42.5-v1.24.0-dev.6', '2024-09-01T10:00:00Z'),
    ];
    // Tie on publishedAt. After the (no-op) publishedAt sort, tagName
    // descending is the secondary key: 20.43, 20.42, 20.41. Keep top
    // 2 → delete just 'youtube-v20.41.0-v1.23.0'.
    expect(selectTagsToDelete(releases, 'youtube', 2)).toEqual([
      'youtube-v20.41.0-v1.23.0',
    ]);
  });

  test('treats a missing publishedAt as the oldest possible timestamp', () => {
    // RFC3339 lexicographic comparison: '' sorts before any non-empty
    // string, which means the empty-publishedAt entry goes to the end
    // of the desc list (the "oldest" of the matched set) and is
    // therefore deleted first.
    const releases = [
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
      makeRelease('youtube-v20.43.10-v1.24.0-dev.7', '2024-11-15T10:00:00Z'),
      makeRelease('youtube-v20.42.5-v1.24.0-dev.6', ''),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 2)).toEqual([
      'youtube-v20.42.5-v1.24.0-dev.6',
    ]);
  });

  test('escapes regex metacharacters in the app name', () => {
    // A future app whose name contains a regex metacharacter (e.g.
    // 'a.b') must be matched literally. Construct tags that share a
    // wildcard-friendly prefix and verify only the literal match wins.
    const releases = [
      makeRelease('a.b-v1.0', '2024-12-01T10:00:00Z'),
      makeRelease('a.b-v2.0', '2024-12-02T10:00:00Z'),
      makeRelease('a.b-v3.0', '2024-12-03T10:00:00Z'),
      // With an unescaped '.', 'a.b' as a regex would match 'aXb-v...'
      // (because '.' is the regex wildcard). The escape must prevent
      // that — this tag should never be considered for the 'a.b' app.
      makeRelease('aXb-v1.0', '2024-12-04T10:00:00Z'),
    ];
    const toDelete = selectTagsToDelete(releases, 'a.b', 1);
    expect(toDelete).toEqual([
      'a.b-v1.0',
      'a.b-v2.0',
    ]);
    expect(toDelete).not.toContain('aXb-v1.0');
  });

  test('keepCount of 0 deletes every matching release, oldest first', () => {
    const releases = [
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-01T10:00:00Z'),
      makeRelease('youtube-v20.43.10-v1.24.0-dev.7', '2024-11-15T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 0)).toEqual([
      'youtube-v20.43.10-v1.24.0-dev.7',
      'youtube-v20.44.38-v1.24.0-dev.8',
    ]);
  });

  test('skips entries with non-string tagName without throwing', () => {
    // Defensive against an unexpected payload shape from `gh release
    // list`. The filter must not crash on null / number tagNames.
    const releases = [
      { tagName: null, publishedAt: '2024-12-01T10:00:00Z' },
      { tagName: 42, publishedAt: '2024-12-02T10:00:00Z' },
      makeRelease('youtube-v20.44.38-v1.24.0-dev.8', '2024-12-03T10:00:00Z'),
    ];
    expect(selectTagsToDelete(releases, 'youtube', 0)).toEqual([
      'youtube-v20.44.38-v1.24.0-dev.8',
    ]);
  });

  test('returns an empty array for an empty release list', () => {
    expect(selectTagsToDelete([], 'youtube', 2)).toEqual([]);
  });
});