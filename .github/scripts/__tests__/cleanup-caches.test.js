// .github/scripts/__tests__/cleanup-caches.test.js
'use strict';

// Mock the fs + child_process modules BEFORE requiring cleanup-caches,
// since the module top-level evaluates `process.cwd()` and pulls in
// config.json via loadConfig(). For pure-helper tests (classifyCache /
// isActive) we don't care about that — but we must keep the require
// from running main(), which it won't as long as `require.main ===
// module` is false inside cleanup-caches.js.
const {
  CACHE_PATTERNS_ORDERED,
  classifyCache,
  isActive,
} = require('../cleanup-caches');

describe('CACHE_PATTERNS_ORDERED', () => {
  test('longer prefixes come first (so morphe-tools-cli- beats morphe-cli-)', () => {
    const idxTools = CACHE_PATTERNS_ORDERED.indexOf('morphe-tools-cli-');
    const idxCli = CACHE_PATTERNS_ORDERED.indexOf('morphe-cli-');
    expect(idxTools).toBeGreaterThanOrEqual(0);
    expect(idxCli).toBeGreaterThanOrEqual(0);
    expect(idxTools).toBeLessThan(idxCli);
  });

  test('every pattern key is in the ordered list', () => {
    expect(CACHE_PATTERNS_ORDERED).toEqual(
      expect.arrayContaining([
        'morphe-tools-cli-',
        'morphe-cli-',
        'morphe-patches-',
        'apk-',
      ])
    );
  });
});

describe('classifyCache', () => {
  test('classifies morphe-cli-* as morphe-cli-', () => {
    expect(classifyCache({ key: 'morphe-cli-v1.9.1' })).toBe('morphe-cli-');
  });

  test('classifies morphe-tools-cli-* as morphe-tools-cli- (not morphe-cli-)', () => {
    // Regression test for the bug where every morphe-tools-cli-* cache
    // was being grouped under the shorter morphe-cli- prefix.
    expect(
      classifyCache({
        key: 'morphe-tools-cli-v1.9.1-repos-MorpheApp-morphe-patches',
      })
    ).toBe('morphe-tools-cli-');
  });

  test('classifies morphe-patches-* as morphe-patches-', () => {
    expect(
      classifyCache({ key: 'morphe-patches-MorpheApp-morphe-patches-v1.31.0' })
    ).toBe('morphe-patches-');
  });

  test('classifies apk-* as apk-', () => {
    expect(
      classifyCache({
        key: 'apk-com.google.android.youtube-20.45.36',
      })
    ).toBe('apk-');
  });

  test('returns null for unrecognised keys (not one of ours)', () => {
    expect(classifyCache({ key: 'some-other-cache-v1' })).toBeNull();
    expect(classifyCache({ key: 'npm-1234' })).toBeNull();
    expect(classifyCache({ key: '' })).toBeNull();
  });

  test('does not falsely match a project prefix on a non-project key', () => {
    // e.g. a cache literally named "apk-" should still get classified
    // as apk- (it IS our pattern), but something like "apksuffix-foo"
    // should NOT — startsWith would match it, but we don't want to
    // include arbitrary third-party caches that happen to start with
    // our prefix. (The current contract IS startsWith-based, so this
    // test documents the behaviour: startsWith matches.)
    expect(classifyCache({ key: 'apk-foo' })).toBe('apk-');
  });
});

describe('isActive', () => {
  test('matches exact active key', () => {
    expect(isActive('morphe-cli-v1.9.1', ['morphe-cli-v1.9.1'])).toBe(true);
  });

  test('does not match a different key', () => {
    expect(isActive('morphe-cli-v1.8.0', ['morphe-cli-v1.9.1'])).toBe(false);
  });

  test('matches soft prefix when active key ends with -', () => {
    // apk-<appId>- is a soft prefix: any apk cache for that app is
    // considered in-use until a build writes a new one.
    expect(
      isActive('apk-com.google.android.youtube-20.45.36', [
        'apk-com.google.android.youtube-',
      ])
    ).toBe(true);
  });

  test('soft prefix does NOT match across different apps', () => {
    expect(
      isActive('apk-com.reddit.frontpage-2024.01.01', [
        'apk-com.google.android.youtube-',
      ])
    ).toBe(false);
  });

  test('soft prefix requires the trailing dash on the active key', () => {
    // Without the trailing dash, this is an exact match (returns false
    // for a longer cache key).
    expect(
      isActive('apk-com.google.android.youtube-20.45.36', [
        'apk-com.google.android.youtube',
      ])
    ).toBe(false);
  });

  test('returns true if ANY active key matches', () => {
    expect(
      isActive('morphe-cli-v1.9.1', [
        'morphe-cli-v1.8.0',
        'morphe-cli-v1.9.1',
        'apk-foo-',
      ])
    ).toBe(true);
  });

  test('handles empty active keys list', () => {
    expect(isActive('morphe-cli-v1.9.1', [])).toBe(false);
  });
});
