// .github/scripts/__tests__/generate-readme-tables.test.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  capitalizeFirst,
  displayNameFor,
  buildAdditionalSettings,
  obtainiumUrlFor,
  testedAppsRow,
  obtainiumRow,
  buildTestedAppsTable,
  buildObtainiumTable,
  spliceReadmeBlocks,
  lineDiff,
  MARKER_TESTED_APPS_BEGIN,
  MARKER_TESTED_APPS_END,
  MARKER_OBTAINIUM_BEGIN,
  MARKER_OBTAINIUM_END,
  OBTAINIUM_BADGE_IMG,
  REPO_AUTHOR,
} = require('../generate-readme-tables');

// All eight apps from the repo's config.json at the time these tests
// were written — used as a golden-fixture for the byte-for-byte checks.
const REAL_CONFIG = {
  patch_repos: {
    'com.google.android.youtube': {
      name: 'youtube',
      repo: 'MorpheApp/morphe-patches',
      branch: 'main',
      apkmirror_path: 'google-inc/youtube',
      display_name: 'YouTube',
    },
    'com.google.android.apps.youtube.music': {
      name: 'ytmusic',
      repo: 'MorpheApp/morphe-patches',
      branch: 'main',
      apkmirror_path: 'google-inc/youtube-music',
      display_name: 'YouTube Music',
    },
    'com.reddit.frontpage': {
      name: 'reddit',
      repo: 'MorpheApp/morphe-patches',
      branch: 'main',
      apkmirror_path: 'redditinc/reddit',
      display_name: 'Reddit',
    },
    'com.sofascore.results': {
      name: 'sofascore',
      repo: 'heval99/morphe-patches',
      branch: 'main',
      apkmirror_path: 'sofascore/soccer-scores-and-sports-livescore-sofascore',
      display_name: 'Sofascore',
    },
    'tv.twitch.android.app': {
      name: 'twitch',
      repo: 'RookieEnough/De-Vanced',
      branch: 'main',
      apkmirror_path: 'twitch-interactive-inc/twitch-live-streaming',
      display_name: 'Twitch',
    },
    'com.kevinforeman.nzb360': {
      name: 'nzb360',
      repo: 'rushiranpise/morphe-patches',
      branch: 'main',
      apkmirror_path: 'kevin-foreman/nzb360',
      pin_patch_tag: 'v1.18.3',
      display_name: 'NZB360',
    },
    'com.finalwire.aida64': {
      name: 'aida64',
      repo: 'rushiranpise/morphe-patches',
      branch: 'main',
      apkmirror_path: 'finalwire-ltd/aida64',
      pin_patch_tag: 'v1.18.3',
      display_name: 'AIDA64',
    },
    'com.getmimo': {
      name: 'mimo',
      repo: 'hoo-dles/morphe-patches',
      branch: 'main',
      apkmirror_path: 'mimohello-gmbh/mimo-learn-to-code',
      display_name: 'Mimo',
    },
  },
};

// What the README contained BEFORE the generator was introduced —
// captured verbatim from the repo so a refactor cannot silently change
// the byte-level encoding. If this fixture ever needs updating because
// the URL scheme genuinely changed upstream, the test should be updated
// alongside the README with a PR that explains why.
const LEGACY_YOUTUBE_ROW =
  '| YouTube | `^youtube` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.google.android.youtube%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22YouTube%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Eyoutube%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="50"></a> |';

const LEGACY_TESTED_ROW =
  '| YouTube | `com.google.android.youtube` | `MorpheApp/morphe-patches` |';

const LEGACY_OBTAINIUM_HEADER = '| App | Release Tag Filter | Add to Obtainium |';
const LEGACY_OBTAINIUM_SEPARATOR = '|-----|--------------------|------------------|';
const LEGACY_TESTED_HEADER = '| App | Package | Patch repo |';
const LEGACY_TESTED_SEPARATOR = '|-----|---------|------------|';

describe('capitalizeFirst', () => {
  test('capitalises the first letter', () => {
    expect(capitalizeFirst('youtube')).toBe('Youtube');
    expect(capitalizeFirst('nzb360')).toBe('Nzb360');
  });

  test('handles empty / non-string inputs gracefully', () => {
    expect(capitalizeFirst('')).toBe('');
    expect(capitalizeFirst(undefined)).toBe('');
    expect(capitalizeFirst(null)).toBe('');
  });
});

describe('displayNameFor', () => {
  test('returns display_name when set and non-empty', () => {
    expect(displayNameFor({ name: 'ytmusic', display_name: 'YouTube Music' })).toBe(
      'YouTube Music',
    );
  });

  test('falls back to a capitalised name when display_name is absent', () => {
    expect(displayNameFor({ name: 'nzb360' })).toBe('Nzb360');
  });

  test('falls back when display_name is empty', () => {
    expect(displayNameFor({ name: 'nzb360', display_name: '' })).toBe('Nzb360');
  });
});

describe('buildAdditionalSettings', () => {
  test('returns all 27 fields, with filterReleaseTitlesByRegEx = ^name', () => {
    const s = buildAdditionalSettings('youtube');
    expect(Object.keys(s)).toHaveLength(27);
    expect(s.filterReleaseTitlesByRegEx).toBe('^youtube');
  });

  test('produces identical output regardless of name (only the regex changes)', () => {
    const a = buildAdditionalSettings('youtube');
    const b = buildAdditionalSettings('mimo');
    expect({ ...a, filterReleaseTitlesByRegEx: undefined })
      .toEqual({ ...b, filterReleaseTitlesByRegEx: undefined });
  });
});

describe('obtainiumUrlFor', () => {
  test('matches the historical YouTube deep-link byte-for-byte', () => {
    const url = obtainiumUrlFor('com.google.android.youtube', 'youtube', 'YouTube');
    // The full legacy row's href value — extract the expected URL:
    // <a href="<url>"><img ...
    const m = LEGACY_YOUTUBE_ROW.match(/href="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(url).toBe(m[1]);
  });

  test('the URL embeds obtainium://app/ unencoded followed by encoded JSON', () => {
    const url = obtainiumUrlFor('com.example.x', 'example', 'Example');
    // The literal `obtainium://app/` is unencoded (matches the
    // historical scheme byte-for-byte); only the JSON after is encoded.
    expect(url.startsWith('https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/'))
      .toBe(true);
  });
});

describe('Tested apps row (golden fixture, byte-for-byte)', () => {
  test('YouTube row matches the legacy README', () => {
    const entry = REAL_CONFIG.patch_repos['com.google.android.youtube'];
    expect(testedAppsRow('com.google.android.youtube', entry)).toBe(LEGACY_TESTED_ROW);
  });

  test('Mimo row matches the legacy encoding', () => {
    const entry = REAL_CONFIG.patch_repos['com.getmimo'];
    expect(testedAppsRow('com.getmimo', entry)).toBe(
      '| Mimo | `com.getmimo` | `hoo-dles/morphe-patches` |',
    );
  });
});

describe('Obtainium row (golden fixture, byte-for-byte)', () => {
  test('YouTube row matches the legacy README', () => {
    const entry = REAL_CONFIG.patch_repos['com.google.android.youtube'];
    expect(obtainiumRow('com.google.android.youtube', entry)).toBe(LEGACY_YOUTUBE_ROW);
  });

  test('all 8 rows use the repo author in additionalSettings', () => {
    for (const [pkgId, entry] of Object.entries(REAL_CONFIG.patch_repos)) {
      const row = obtainiumRow(pkgId, entry);
      expect(row).toContain(encodeURIComponent(REPO_AUTHOR));
    }
  });

  test('badge image is referenced verbatim', () => {
    for (const [pkgId, entry] of Object.entries(REAL_CONFIG.patch_repos)) {
      const row = obtainiumRow(pkgId, entry);
      expect(row).toContain(OBTAINIUM_BADGE_IMG);
    }
  });
});

describe('buildTestedAppsTable — current config produces README-matching markdown', () => {
  test('headers + all 8 app rows', () => {
    const md = buildTestedAppsTable(REAL_CONFIG);
    expect(md).toContain(LEGACY_TESTED_HEADER);
    expect(md).toContain(LEGACY_TESTED_SEPARATOR);
    const expectedRows = [
      '| YouTube | `com.google.android.youtube` | `MorpheApp/morphe-patches` |',
      '| YouTube Music | `com.google.android.apps.youtube.music` | `MorpheApp/morphe-patches` |',
      '| Reddit | `com.reddit.frontpage` | `MorpheApp/morphe-patches` |',
      '| Sofascore | `com.sofascore.results` | `heval99/morphe-patches` |',
      '| Twitch | `tv.twitch.android.app` | `RookieEnough/De-Vanced` |',
      '| NZB360 | `com.kevinforeman.nzb360` | `rushiranpise/morphe-patches` |',
      '| AIDA64 | `com.finalwire.aida64` | `rushiranpise/morphe-patches` |',
      '| Mimo | `com.getmimo` | `hoo-dles/morphe-patches` |',
    ];
    for (const row of expectedRows) {
      expect(md).toContain(row);
    }
  });

  test('contains exactly 10 newline-separated lines (header + sep + 8 rows)', () => {
    expect(buildTestedAppsTable(REAL_CONFIG).split('\n')).toHaveLength(10);
  });
});

describe('buildObtainiumTable — current config produces README-matching markdown', () => {
  test('all 8 Obtainium rows are present, byte-for-byte', () => {
    const md = buildObtainiumTable(REAL_CONFIG);
    expect(md.split('\n')[0]).toBe(LEGACY_OBTAINIUM_HEADER);
    expect(md.split('\n')[1]).toBe(LEGACY_OBTAINIUM_SEPARATOR);
    expect(md.split('\n')).toHaveLength(10);
    expect(md).toContain(LEGACY_YOUTUBE_ROW);
    // Spot-check Mimo too — its row also references display_name "Mimo".
    expect(md).toContain(
      '| Mimo | `^mimo` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.getmimo%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22Mimo%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Emimo%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="50"></a> |',
    );
  });
});

describe('spliceReadmeBlocks', () => {
  function withMarkers(testedApps, obtainium) {
    return [
      'intro paragraph\n',
      '\n',
      MARKER_TESTED_APPS_BEGIN, '\n',
      testedApps, '\n',
      MARKER_TESTED_APPS_END, '\n',
      'between\n',
      MARKER_OBTAINIUM_BEGIN, '\n',
      obtainium, '\n',
      MARKER_OBTAINIUM_END, '\n',
      'epilogue\n',
    ].join('');
  }

  test('round-trips: splicing the current tables yields the input verbatim', () => {
    const original = withMarkers(
      buildTestedAppsTable(REAL_CONFIG),
      buildObtainiumTable(REAL_CONFIG),
    );
    const spliced = spliceReadmeBlocks(
      original,
      buildTestedAppsTable(REAL_CONFIG),
      buildObtainiumTable(REAL_CONFIG),
    );
    expect(spliced).toBe(original);
  });

  test('detects drift: splicing a changed table yields a different string', () => {
    const original = withMarkers(
      buildTestedAppsTable(REAL_CONFIG),
      buildObtainiumTable(REAL_CONFIG),
    );
    const next = buildTestedAppsTable(REAL_CONFIG) + '\n'; // tiny change
    const spliced = spliceReadmeBlocks(original, next, buildObtainiumTable(REAL_CONFIG));
    expect(spliced).not.toBe(original);
  });

  test('throws when tested-apps marker pair is missing', () => {
    const broken = `before\n\n${MARKER_OBTAINIUM_BEGIN}\n${buildObtainiumTable(REAL_CONFIG)}\n${MARKER_OBTAINIUM_END}\nafter`;
    expect(() =>
      spliceReadmeBlocks(broken, buildTestedAppsTable(REAL_CONFIG), buildObtainiumTable(REAL_CONFIG)),
    ).toThrow(/tested-apps/);
  });

  test('throws when obtainium-table marker pair is missing', () => {
    const broken = `before\n\n${MARKER_TESTED_APPS_BEGIN}\n${buildTestedAppsTable(REAL_CONFIG)}\n${MARKER_TESTED_APPS_END}\nafter`;
    expect(() =>
      spliceReadmeBlocks(broken, buildTestedAppsTable(REAL_CONFIG), buildObtainiumTable(REAL_CONFIG)),
    ).toThrow(/obtainium-table/);
  });
});

describe('lineDiff', () => {
  test('reports no diffs for identical input', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc')).toMatch(/no line-level differences/);
  });

  test('reports the diff line number on mismatch', () => {
    const d = lineDiff('a\nb\nc', 'a\nX\nc');
    expect(d).toMatch(/line 2/);
    expect(d).toMatch(/- b/);
    expect(d).toMatch(/\+ X/);
  });
});

describe('CLI integration --check mode', () => {
  /**
   * Drive the CLI by spawning node and asserting exit code + stderr.
   * This is the equivalent of `npm run check:readme` and is what the
   * CI step will execute.
   */
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const cliPath = path.join(repoRoot, 'scripts', 'generate-readme-tables.js');

  test('--check exits 0 when the README is already in sync', () => {
    const result = require('node:child_process').spawnSync(
      process.execPath,
      [cliPath, '--check'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/up to date/);
  });

  test('non-check mode regenerates the README byte-identically (idempotent)', () => {
    // Save original, run, diff, restore.
    const readmePath = path.join(repoRoot, 'README.md');
    const original = fs.readFileSync(readmePath, 'utf8');
    try {
      const result = require('node:child_process').spawnSync(
        process.execPath,
        [cliPath],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      const after = fs.readFileSync(readmePath, 'utf8');
      expect(after).toBe(original);
    } finally {
      fs.writeFileSync(readmePath, original);
    }
  });
});
