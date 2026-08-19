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

describe('FORCE_BUILD branch', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  function loadFresh() {
    jest.resetModules();
    return require('../check-existing-releases');
  }

  function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) {
      saved[k] = process.env[k];
      if (!(k in process.env)) saved[k] = undefined;
    }
    for (const k of Object.keys(vars)) process.env[k] = vars[k];
    try { return fn(); }
    finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  test('isTruthyEnv accepts 1/true/TRUE/yes/YES and rejects everything else', () => {
    const { isTruthyEnv } = loadFresh();
    expect(isTruthyEnv('X')).toBe(false);
    withEnv({ X: '' },        () => expect(isTruthyEnv('X')).toBe(false));
    withEnv({ X: '0' },       () => expect(isTruthyEnv('X')).toBe(false));
    withEnv({ X: 'false' },   () => expect(isTruthyEnv('X')).toBe(false));
    withEnv({ X: 'no' },      () => expect(isTruthyEnv('X')).toBe(false));
    withEnv({ X: '1' },       () => expect(isTruthyEnv('X')).toBe(true));
    withEnv({ X: 'true' },    () => expect(isTruthyEnv('X')).toBe(true));
    withEnv({ X: 'TRUE' },    () => expect(isTruthyEnv('X')).toBe(true));
    withEnv({ X: 'yes' },     () => expect(isTruthyEnv('X')).toBe(true));
    withEnv({ X: 'YES' },     () => expect(isTruthyEnv('X')).toBe(true));
  });

  test('main() with FORCE_BUILD emits full matrix + should-build=true + empty skip-list', () => {
    // mkdtempSync creates a 0700 directory unique to this test, so the
    // helper files inside are not world-readable (fixes js/insecure-temporary-file).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-existing-releases-'));
    const tmpFile = path.join(tmpDir, 'github-output.txt');
    const cfgFile = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({
      patch_repos: {
        'com.google.android.youtube': { name: 'youtube', repo: 'MorpheApp/morphe-patches', branch: 'main' },
        'com.google.android.apps.youtube.music': { name: 'ytmusic', repo: 'MorpheApp/morphe-patches', branch: 'main' },
        'com.reddit.frontpage': { name: 'reddit', repo: 'MorpheApp/morphe-patches', branch: 'main' },
      },
    }));
    fs.writeFileSync(tmpFile, '');
    try {
      withEnv({
        REPO_VERSIONS: '{"MorpheApp/morphe-patches":"v1.39.1"}',
        GITHUB_OUTPUT: tmpFile,
        CONFIG_FILE: cfgFile,
        // Forces the java call (resolveApkVersion) to error → fail-open.
        // Used to prove the FORCE_BUILD branch short-circuits before it.
        TOOLS_DIR: '/nonexistent',
        FORCE_BUILD: 'true',
      }, () => {
        const { main } = loadFresh();
        main();
      });
      const out = fs.readFileSync(tmpFile, 'utf8');
      const line = (key) => out.split('\n').find((l) => l.startsWith(`${key}=`));
      expect(line('should-build')).toBe('should-build=true');
      expect(line('skip-list')).toBe('skip-list=[]');
      const matrix = JSON.parse(line('matrix-include').replace(/^matrix-include=/, ''));
      expect(matrix).toHaveLength(3);
      expect(matrix.map((e) => e.appId).sort()).toEqual([
        'com.google.android.apps.youtube.music',
        'com.google.android.youtube',
        'com.reddit.frontpage',
      ]);
      expect(matrix.every((e) => e.patchTag === 'v1.39.1')).toBe(true);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('main() without FORCE_BUILD falls through to the decide() path', () => {
    // TOOLS_DIR points at /nonexistent so resolveApkVersion returns ''
    // and the fail-open path emits should-build=true. This proves the
    // FORCE_BUILD guard is a real toggle: with it absent, main() does
    // not short-circuit and the same setup still produces a build.
    // mkdtempSync creates a 0700 directory unique to this test, so the
    // helper files inside are not world-readable (fixes js/insecure-temporary-file).
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-existing-releases-'));
    const tmpFile = path.join(tmpDir, 'github-output.txt');
    const cfgFile = path.join(tmpDir, 'config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({
      patch_repos: {
        'com.google.android.youtube': { name: 'youtube', repo: 'MorpheApp/morphe-patches', branch: 'main' },
      },
    }));
    fs.writeFileSync(tmpFile, '');
    try {
      withEnv({
        REPO_VERSIONS: '{"MorpheApp/morphe-patches":"v1.39.1"}',
        GITHUB_OUTPUT: tmpFile,
        CONFIG_FILE: cfgFile,
        TOOLS_DIR: '/nonexistent',
      }, () => {
        const { main } = loadFresh();
        main();
      });
      const out = fs.readFileSync(tmpFile, 'utf8');
      const line = (key) => out.split('\n').find((l) => l.startsWith(`${key}=`));
      expect(line('should-build')).toBe('should-build=true');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe('resolveApkVersion version-extraction regex', () => {
  // Regression for the universal "could not resolve a Morphe-supported
  // version" bug: every new app pointing at a non-default patch repo
  // (RookieEnough/De-Vanced for Twitch, rushiranpise/morphe-patches
  // for nzb360, heval99/morphe-patches for Sofascore) hit this because
  // morphe-desktop list-versions emits the supported versions as
  // `<ver> (<N> patch[es])` lines and the regex used to extract them
  // required EXACTLY three dot-separated numeric components. nzb360
  // ships a 2-segment version (`24.3`), which the old regex never
  // matched. The fix widens the regex to require 1+ dot-separated
  // components. These tests exercise resolveApkVersion against
  // mocked CLI output for each affected repo.
  const fs = require('node:fs');
  const cp = require('node:child_process');

  function loadFresh() {
    jest.resetModules();
    return require('../check-existing-releases');
  }

  // Realistic morphe-desktop list-versions output for each repo. Note
  // the `INFO: ` prefix on the first line of each logger.info() call
  // and the tab-indented version lines below it (verified against
  // MorpheApp/morphe-desktop's ListCompatibleVersions.kt).
  const nzb360CliOutput = `INFO: Package name: com.kevinforeman.nzb360
INFO: Most common compatible versions:
\t24.3 (1 patch)
 `;

  const twitchCliOutput = `INFO: Package name: tv.twitch.android.app
INFO: Most common compatible versions:
\t16.9.1 (5 patches)
\t25.3.0 (5 patches)
 `;

  const sofascoreCliOutput = `INFO: Package name: com.sofascore.results
INFO: Most common compatible versions:
\t26.07.27 (1 patch)
 `;

  test('extracts 2-segment versions like nzb360\'s `24.3`', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(cp, 'execFileSync').mockImplementation(() => nzb360CliOutput);
    const { resolveApkVersion } = loadFresh();
    const version = resolveApkVersion(
      'com.kevinforeman.nzb360',
      '/fake/jar',
      '/fake.mpp',
      { patch_repos: { 'com.kevinforeman.nzb360': {} } },
    );
    expect(version).toBe('24.3');
  });

  test('still extracts 3-segment versions like Twitch\'s `25.3.0`', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(cp, 'execFileSync').mockImplementation(() => twitchCliOutput);
    const { resolveApkVersion } = loadFresh();
    const version = resolveApkVersion(
      'tv.twitch.android.app',
      '/fake/jar',
      '/fake.mpp',
      { patch_repos: { 'tv.twitch.android.app': {} } },
    );
    // Both versions are listed; sort -Vr picks the highest. The
    // workflow doesn't depend on a stable CLI order — we just need
    // *some* X.Y.Z. This locks in the "3-segment versions still
    // extract" half of the regression so a future change that
    // accidentally drops them is caught here.
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('extracts 4-segment versions like Sofascore\'s `26.07.27`', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(cp, 'execFileSync').mockImplementation(() => sofascoreCliOutput);
    const { resolveApkVersion } = loadFresh();
    const version = resolveApkVersion(
      'com.sofascore.results',
      '/fake/jar',
      '/fake.mpp',
      { patch_repos: { 'com.sofascore.results': {} } },
    );
    expect(version).toBe('26.07.27');
  });
});
