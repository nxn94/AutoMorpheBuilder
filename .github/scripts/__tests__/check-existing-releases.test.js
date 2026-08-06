// .github/scripts/__tests__/check-existing-releases.test.js
'use strict';

// Tests for the pure `decide` + `buildMatrix` helpers in
// check-existing-releases.js. We exercise the decision contract only;
// the env-dependent java/gh calls are integration-tested by the
// workflow itself.

const { decide, buildMatrix } = require('../check-existing-releases');

const MATRIX = [
  {
    name: 'youtube',
    appId: 'com.google.android.youtube',
    patchRepo: 'MorpheApp/morphe-patches',
    patchBranch: 'main',
    patchSlug: 'MorpheApp-morphe-patches',
    patchTag: 'v1.24.0-dev.8',
  },
  {
    name: 'ytmusic',
    appId: 'com.google.android.apps.youtube.music',
    patchRepo: 'MorpheApp/morphe-patches',
    patchBranch: 'main',
    patchSlug: 'MorpheApp-morphe-patches',
    patchTag: 'v1.24.0-dev.8',
  },
  {
    name: 'reddit',
    appId: 'com.reddit.frontpage',
    patchRepo: 'MorpheApp/morphe-patches',
    patchBranch: 'main',
    patchSlug: 'MorpheApp-morphe-patches',
    patchTag: 'v1.24.0-dev.8',
  },
];

describe('buildMatrix', () => {
  const config = {
    patch_repos: {
      'com.google.android.youtube': {
        name: 'youtube',
        repo: 'MorpheApp/morphe-patches',
        branch: 'main',
      },
      'com.reddit.frontpage': {
        name: 'reddit',
        repo: 'MorpheApp/morphe-patches',
        branch: 'dev',
      },
    },
  };
  const repoVersions = { 'MorpheApp/morphe-patches': 'v1.24.0-dev.8' };

  test('emits one matrix entry per patch_repos key, in config order', () => {
    const m = buildMatrix(config, repoVersions);
    expect(m).toHaveLength(2);
    expect(m[0].appId).toBe('com.google.android.youtube');
    expect(m[1].appId).toBe('com.reddit.frontpage');
  });

  test('lowercases the branch and replaces slashes in the slug', () => {
    const m = buildMatrix(config, repoVersions);
    expect(m[0].patchBranch).toBe('main');
    expect(m[0].patchSlug).toBe('MorpheApp-morphe-patches');
    expect(m[1].patchBranch).toBe('dev');
  });

  test('attaches the resolved patchTag from repoVersions', () => {
    const m = buildMatrix(config, repoVersions);
    expect(m[0].patchTag).toBe('v1.24.0-dev.8');
    expect(m[1].patchTag).toBe('v1.24.0-dev.8');
  });

  test('emits an empty patchTag string when the repo has no resolved version', () => {
    const m = buildMatrix(config, {});
    expect(m[0].patchTag).toBe('');
    expect(m[1].patchTag).toBe('');
  });
});

describe('decide', () => {
  test('keeps every entry when no release exists for any of them', () => {
    const apkVersions = {
      'com.google.android.youtube': '20.44.38',
      'com.google.android.apps.youtube.music': '8.44.54',
      'com.reddit.frontpage': '2025.02.17',
    };
    const releaseExists = () => false;
    const result = decide(MATRIX, apkVersions, releaseExists);
    expect(result.matrix).toHaveLength(3);
    expect(result.skipList).toEqual([]);
    expect(result.shouldBuild).toBe(true);
  });

  test('drops the apps whose release already exists', () => {
    const apkVersions = {
      'com.google.android.youtube': '20.44.38',
      'com.google.android.apps.youtube.music': '8.44.54',
      'com.reddit.frontpage': '2025.02.17',
    };
    const existing = new Set(['youtube-v20.44.38-v1.24.0-dev.8']);
    const releaseExists = (tag) => existing.has(tag);
    const result = decide(MATRIX, apkVersions, releaseExists);
    expect(result.matrix.map((e) => e.appId)).toEqual([
      'com.google.android.apps.youtube.music',
      'com.reddit.frontpage',
    ]);
    expect(result.skipList).toEqual(['com.google.android.youtube']);
    expect(result.shouldBuild).toBe(true);
  });

  test('returns an empty matrix + shouldBuild=false when every app is current', () => {
    const apkVersions = {
      'com.google.android.youtube': '20.44.38',
      'com.google.android.apps.youtube.music': '8.44.54',
      'com.reddit.frontpage': '2025.02.17',
    };
    const releaseExists = () => true;
    const result = decide(MATRIX, apkVersions, releaseExists);
    expect(result.matrix).toEqual([]);
    expect(result.skipList).toEqual([
      'com.google.android.youtube',
      'com.google.android.apps.youtube.music',
      'com.reddit.frontpage',
    ]);
    expect(result.shouldBuild).toBe(false);
  });

  test('computes the expected release tag as <name>-v<version>-<patchTag>', () => {
    const seen = [];
    const releaseExists = (tag) => {
      seen.push(tag);
      return false;
    };
    decide(
      [MATRIX[0]],
      { 'com.google.android.youtube': '20.44.38' },
      releaseExists,
    );
    expect(seen).toEqual(['youtube-v20.44.38-v1.24.0-dev.8']);
  });

  test('honours different APK versions per app (release tag includes the version)', () => {
    const seen = [];
    const releaseExists = (tag) => {
      seen.push(tag);
      return false;
    };
    const matrix = [
      { ...MATRIX[0], name: 'youtube', appId: 'com.google.android.youtube', patchTag: 'v1.24.0-dev.8' },
      { ...MATRIX[1], name: 'ytmusic', appId: 'com.google.android.apps.youtube.music', patchTag: 'v1.24.0-dev.8' },
    ];
    decide(
      matrix,
      { 'com.google.android.youtube': '20.44.38', 'com.google.android.apps.youtube.music': '8.44.54' },
      releaseExists,
    );
    expect(seen).toEqual([
      'youtube-v20.44.38-v1.24.0-dev.8',
      'ytmusic-v8.44.54-v1.24.0-dev.8',
    ]);
  });

  test('honours different patchTag per app (release tag includes the patchTag)', () => {
    const matrix = [
      { ...MATRIX[0], name: 'youtube', patchTag: 'v1.24.0-dev.8' },
      { ...MATRIX[2], name: 'reddit', patchTag: 'v1.23.0' },
    ];
    const seen = [];
    const releaseExists = (tag) => {
      seen.push(tag);
      return false;
    };
    decide(
      matrix,
      { 'com.google.android.youtube': '20.44.38', 'com.reddit.frontpage': '2025.02.17' },
      releaseExists,
    );
    expect(seen).toEqual([
      'youtube-v20.44.38-v1.24.0-dev.8',
      'reddit-v2025.02.17-v1.23.0',
    ]);
  });

  describe('fail-open on unresolved APK versions', () => {
    test('keeps the entry when apkVersions[appId] is empty', () => {
      const releaseExists = jest.fn(() => false);
      const result = decide(
        [MATRIX[0]],
        { 'com.google.android.youtube': '' },
        releaseExists,
      );
      expect(result.matrix).toHaveLength(1);
      expect(result.skipList).toEqual([]);
      // releaseExists must NOT be called when the version is unresolved,
      // so the build never silently skips an app we couldn't version-check.
      expect(releaseExists).not.toHaveBeenCalled();
    });

    test('keeps the entry when apkVersions[appId] is missing entirely', () => {
      const result = decide([MATRIX[0]], {}, () => false);
      expect(result.matrix).toHaveLength(1);
      expect(result.skipList).toEqual([]);
    });

    test('keeps every entry when no versions resolved (shouldBuild still true)', () => {
      const result = decide(MATRIX, {}, () => false);
      expect(result.matrix).toHaveLength(3);
      expect(result.shouldBuild).toBe(true);
    });
  });

  test('handles empty matrix (shouldBuild=false, no skips)', () => {
    const result = decide([], {}, () => false);
    expect(result.matrix).toEqual([]);
    expect(result.skipList).toEqual([]);
    expect(result.shouldBuild).toBe(false);
  });

  test('mixed: keeps unresolved apps, skips resolved+existing, keeps resolved+missing', () => {
    const matrix = [
      MATRIX[0], // youtube — has version 20.44.38 — release exists → skip
      MATRIX[1], // ytmusic — version '' → fail-open, keep
      MATRIX[2], // reddit — has version 2025.02.17 — release missing → keep
    ];
    const apkVersions = {
      'com.google.android.youtube': '20.44.38',
      'com.google.android.apps.youtube.music': '',
      'com.reddit.frontpage': '2025.02.17',
    };
    const existing = new Set(['youtube-v20.44.38-v1.24.0-dev.8']);
    const releaseExists = (tag) => existing.has(tag);
    const result = decide(matrix, apkVersions, releaseExists);
    expect(result.matrix.map((e) => e.appId)).toEqual([
      'com.google.android.apps.youtube.music',
      'com.reddit.frontpage',
    ]);
    expect(result.skipList).toEqual(['com.google.android.youtube']);
    expect(result.shouldBuild).toBe(true);
  });
});
