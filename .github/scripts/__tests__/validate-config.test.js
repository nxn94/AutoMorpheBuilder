// .github/scripts/__tests__/validate-config.test.js
'use strict';

const {
  validateConfig,
  PACKAGE_ID_RE,
  NAME_RE,
  PIN_VERSION_RE,
  PIN_TAG_RE,
} = require('../validate-config');

// Helper: returns true if at least one error mentions `substring`.
function hasError(issues, substring) {
  return issues.some((i) => i.level === 'error' && i.message.includes(substring));
}
function hasWarning(issues, substring) {
  return issues.some((i) => i.level === 'warning' && i.message.includes(substring));
}

const validApp = (overrides = {}) => ({
  name: 'mimo',
  repo: 'hoo-dles/morphe-patches',
  branch: 'main',
  apkmirror_path: 'mimohello-gmbh/mimo-learn-to-code',
  ...overrides,
});

const validConfig = (appOverrides = {}) => ({
  patch_repos: {
    'com.getmimo': validApp(appOverrides),
  },
  cli: { repo: 'MorpheApp/morphe-desktop', branch: 'main' },
});

describe('validateConfig — happy path', () => {
  test('the existing config.json shape passes', () => {
    // Roughly mirrors the real config.json: 7 apps with mixed optional
    // fields. We only assert zero errors; warnings may be present.
    const config = {
      preferred_arch: 'arm64-v8a',
      auto_update_urls: true,
      patch_repos: {
        'com.google.android.youtube': validApp({
          name: 'youtube', repo: 'MorpheApp/morphe-patches',
          apkmirror_path: 'google-inc/youtube',
        }),
        'com.google.android.apps.youtube.music': validApp({
          name: 'ytmusic', repo: 'MorpheApp/morphe-patches',
          apkmirror_path: 'google-inc/youtube-music',
        }),
        'com.reddit.frontpage': validApp({
          name: 'reddit', repo: 'MorpheApp/morphe-patches',
          apkmirror_path: 'redditinc/reddit',
        }),
        'com.sofascore.results': validApp({
          name: 'sofascore', repo: 'heval99/morphe-patches',
          apkmirror_path: 'sofascore/soccer-scores-and-sports-livescore-sofascore',
        }),
        'tv.twitch.android.app': validApp({
          name: 'twitch', repo: 'RookieEnough/De-Vanced',
          apkmirror_path: 'twitch-interactive-inc/twitch-live-streaming',
        }),
        'com.kevinforeman.nzb360': validApp({
          name: 'nzb360', repo: 'rushiranpise/morphe-patches',
          apkmirror_path: 'kevin-foreman/nzb360',
          pin_patch_tag: 'v1.18.3',
        }),
        'com.finalwire.aida64': validApp({
          name: 'aida64', repo: 'rushiranpise/morphe-patches',
          apkmirror_path: 'finalwire-ltd/aida64',
          pin_patch_tag: 'v1.18.3',
          pin_version: '1.20',
        }),
      },
      cli: { repo: 'MorpheApp/morphe-desktop', branch: 'main' },
    };
    const issues = validateConfig(config);
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  test('minimal valid config with just patch_repos + cli passes', () => {
    expect(validateConfig(validConfig()).filter((i) => i.level === 'error')).toEqual([]);
  });

  test('auto_update_urls:false is allowed', () => {
    expect(
      validateConfig({ ...validConfig(), auto_update_urls: false })
        .filter((i) => i.level === 'error'),
    ).toEqual([]);
  });

  test('cli.branch = "dev" is allowed', () => {
    expect(
      validateConfig({ ...validConfig(), cli: { repo: 'MorpheApp/morphe-desktop', branch: 'dev' } })
        .filter((i) => i.level === 'error'),
    ).toEqual([]);
  });

  test('download_urls: {} is allowed', () => {
    expect(
      validateConfig({ ...validConfig(), download_urls: {} })
        .filter((i) => i.level === 'error'),
    ).toEqual([]);
  });
});

describe('validateConfig — top-level shape', () => {
  test('non-object top-level is one error and short-circuits', () => {
    const issues = validateConfig('hi');
    expect(issues).toHaveLength(1);
    expect(issues[0].level).toBe('error');
    expect(issues[0].message).toMatch(/JSON object/);
  });

  test('null top-level is an error', () => {
    expect(validateConfig(null).filter((i) => i.level === 'error')).toHaveLength(1);
  });

  test('array top-level is an error', () => {
    expect(validateConfig([]).filter((i) => i.level === 'error')).toHaveLength(1);
  });

  test('missing patch_repos is an error', () => {
    const issues = validateConfig({ cli: { repo: 'a/b', branch: 'main' } });
    expect(hasError(issues, "'patch_repos'")).toBe(true);
  });

  test('empty patch_repos is an error', () => {
    const issues = validateConfig({ patch_repos: {}, cli: { repo: 'a/b', branch: 'main' } });
    expect(hasError(issues, "'patch_repos' is empty")).toBe(true);
  });

  test('patch_repos as an array is an error', () => {
    const issues = validateConfig({ patch_repos: [], cli: { repo: 'a/b', branch: 'main' } });
    expect(hasError(issues, 'must be a non-empty object')).toBe(true);
  });

  test('unknown top-level key is a warning (typo guard)', () => {
    const issues = validateConfig({ ...validConfig(), pach_repos: {} });
    expect(hasWarning(issues, 'Unknown top-level key "pach_repos"')).toBe(true);
  });

  test('preferred_arch with a bogus value is an error', () => {
    const issues = validateConfig({ ...validConfig(), preferred_arch: 'riscv64' });
    expect(hasError(issues, 'preferred_arch "riscv64"')).toBe(true);
  });

  test('preferred_arch:arm64-v8a is allowed', () => {
    expect(
      validateConfig({ ...validConfig(), preferred_arch: 'arm64-v8a' })
        .filter((i) => i.level === 'error'),
    ).toEqual([]);
  });

  test('auto_update_urls:42 is an error', () => {
    expect(
      validateConfig({ ...validConfig(), auto_update_urls: 42 })
        .filter((i) => i.level === 'error').length,
    ).toBeGreaterThan(0);
  });
});

describe('validateConfig — cli', () => {
  test('cli.repo with whitespace is an error', () => {
    const issues = validateConfig({ ...validConfig(), cli: { repo: 'foo bar/baz', branch: 'main' } });
    expect(hasError(issues, 'cli.repo')).toBe(true);
  });

  test('cli.repo with too many slashes is an error', () => {
    const issues = validateConfig({ ...validConfig(), cli: { repo: 'a/b/c', branch: 'main' } });
    expect(hasError(issues, 'cli.repo')).toBe(true);
  });

  test('cli.branch not in {main, dev} is an error', () => {
    const issues = validateConfig({ ...validConfig(), cli: { repo: 'a/b', branch: 'feature/x' } });
    expect(hasError(issues, 'must be "main" or "dev"')).toBe(true);
  });

  test('missing cli is an error', () => {
    const issues = validateConfig({ patch_repos: { 'com.getmimo': validApp() } });
    expect(hasError(issues, "'cli'")).toBe(true);
  });
});

describe('validateConfig — per-app entry', () => {
  test('non-object per-app entry is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': 'not-an-object' },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'must be a JSON object')).toBe(true);
  });

  test('missing name is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ name: undefined }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, '.name is required')).toBe(true);
  });

  test('uppercase name is an error (used in release tags)', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ name: 'Mimo' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'name "Mimo"')).toBe(true);
  });

  test('name with underscore is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ name: 'my_app' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'name "my_app"')).toBe(true);
  });

  test('duplicate name across two apps is an error', () => {
    const issues = validateConfig({
      patch_repos: {
        'com.getmimo': validApp({ name: 'mimo' }),
        'com.example.other': validApp({ name: 'mimo', apkmirror_path: 'pub/other' }),
      },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'Duplicate name "mimo"')).toBe(true);
  });

  test('invalid package id is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'GetMimo': validApp() },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'package id "GetMimo"')).toBe(true);
  });

  test('package id with single segment is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'mimo': validApp() },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'package id "mimo"')).toBe(true);
  });

  test('typo in apkmirror_path (extra slash) is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ apkmirror_path: 'pub/with/extra/slashes' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'apkmirror_path "pub/with/extra/slashes"')).toBe(true);
  });

  test('repo with whitespace is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ repo: 'foo bar/baz' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'owner/repo')).toBe(true);
  });

  test('pin_version typo (comma instead of dot) is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ pin_version: '20,44,38' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'pin_version')).toBe(true);
  });

  test('pin_patch_tag without `v` prefix and digits is allowed', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ pin_patch_tag: '1.18.3' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  test('pin_patch_tag with suffix is allowed', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ pin_patch_tag: 'v1.24.0-dev.8' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  test('pin_patch_tag with bad characters is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ pin_patch_tag: 'v1,18,3' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'pin_patch_tag')).toBe(true);
  });

  test('display_name omitted is allowed (optional, falls back to capitalised name)', () => {
    const issues = validateConfig(validConfig());
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  test('display_name set to a non-empty string is allowed', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ display_name: 'Mimo' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  test('display_name set to empty string is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ display_name: '' }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'display_name "" must be a non-empty string')).toBe(true);
  });

  test('display_name set to a non-string is an error', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': validApp({ display_name: 42 }) },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasError(issues, 'display_name "42" must be a non-empty string')).toBe(true);
  });

  test('unknown per-app key is a warning', () => {
    const issues = validateConfig({
      patch_repos: { 'com.getmimo': { ...validApp(), apkmirror_paath: 'x' } },
      cli: { repo: 'a/b', branch: 'main' },
    });
    expect(hasWarning(issues, 'Unknown key "apkmirror_paath"')).toBe(true);
  });
});

describe('regex sanity (PIN_VERSION_RE / PIN_TAG_RE / etc.)', () => {
  test('PIN_VERSION_RE accepts 2- and 4-segment versions', () => {
    expect(PIN_VERSION_RE.test('24.3')).toBe(true);
    expect(PIN_VERSION_RE.test('20.44.38')).toBe(true);
    expect(PIN_VERSION_RE.test('26.07.27')).toBe(true);
    expect(PIN_VERSION_RE.test('20.44.38-rc')).toBe(false);
  });

  test('PIN_TAG_RE accepts vX.Y.Z and vX.Y.Z-suffix', () => {
    expect(PIN_TAG_RE.test('v1.18.3')).toBe(true);
    expect(PIN_TAG_RE.test('v1.24.0-dev.8')).toBe(true);
    expect(PIN_TAG_RE.test('1.18.3')).toBe(true);
    expect(PIN_TAG_RE.test('v1')).toBe(false);
  });

  test('PACKAGE_ID_RE accepts realistic ids, rejects common typos', () => {
    expect(PACKAGE_ID_RE.test('com.google.android.youtube')).toBe(true);
    expect(PACKAGE_ID_RE.test('tv.twitch.android.app')).toBe(true);
    expect(PACKAGE_ID_RE.test('com.getmimo')).toBe(true);
    expect(PACKAGE_ID_RE.test('com.example')).toBe(true); // 2-segment is valid
    expect(PACKAGE_ID_RE.test('com.google.android.youtube ')).toBe(false); // trailing whitespace
    expect(PACKAGE_ID_RE.test('com')).toBe(false); // single segment, no dots
    expect(PACKAGE_ID_RE.test('1com.example')).toBe(false); // leading digit
    expect(PACKAGE_ID_RE.test('com.Example.foo')).toBe(false); // uppercase mid-id
  });

  test('NAME_RE accepts typical names, rejects capitals/underscores', () => {
    expect(NAME_RE.test('mimo')).toBe(true);
    expect(NAME_RE.test('youtube-music')).toBe(true);
    expect(NAME_RE.test('Mimo')).toBe(false);
    expect(NAME_RE.test('my_app')).toBe(false);
    expect(NAME_RE.test('-leading-hyphen')).toBe(false);
  });
});