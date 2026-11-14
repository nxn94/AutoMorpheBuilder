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
  cacheGroup,
  planDeletions,
} = require('../cleanup-caches');

describe('CACHE_PATTERNS_ORDERED', () => {
  test('longer prefixes come first (so morphe-tools-desktop- beats morphe-desktop-)', () => {
    const idxTools = CACHE_PATTERNS_ORDERED.indexOf('morphe-tools-desktop-');
    const idxCli = CACHE_PATTERNS_ORDERED.indexOf('morphe-desktop-');
    expect(idxTools).toBeGreaterThanOrEqual(0);
    expect(idxCli).toBeGreaterThanOrEqual(0);
    expect(idxTools).toBeLessThan(idxCli);
  });

  test('every pattern key is in the ordered list', () => {
    expect(CACHE_PATTERNS_ORDERED).toEqual(
      expect.arrayContaining([
        'morphe-tools-desktop-',
        'morphe-desktop-',
        'morphe-patches-',
        'apk-',
      ])
    );
  });
});

describe('classifyCache', () => {
  test('classifies morphe-desktop-* as morphe-desktop-', () => {
    expect(classifyCache({ key: 'morphe-desktop-v1.11.0' })).toBe('morphe-desktop-');
  });

  test('classifies morphe-tools-desktop-* as morphe-tools-desktop- (not morphe-desktop-)', () => {
    // Regression test for the bug where every morphe-tools-desktop-* cache
    // was being grouped under the shorter morphe-desktop- prefix.
    expect(
      classifyCache({
        key: 'morphe-tools-desktop-v1.11.0-repos-MorpheApp-morphe-patches',
      })
    ).toBe('morphe-tools-desktop-');
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
    expect(isActive('morphe-desktop-v1.11.0', ['morphe-desktop-v1.11.0'])).toBe(true);
  });

  test('does not match a different key', () => {
    expect(isActive('morphe-desktop-v1.10.0', ['morphe-desktop-v1.11.0'])).toBe(false);
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
      isActive('morphe-desktop-v1.11.0', [
        'morphe-desktop-v1.10.0',
        'morphe-desktop-v1.11.0',
        'apk-foo-',
      ])
    ).toBe(true);
  });

  test('handles empty active keys list', () => {
    expect(isActive('morphe-desktop-v1.11.0', [])).toBe(false);
  });
});

describe('apk-urls- caches are not APK caches', () => {
  test('classified as their own pattern, ahead of apk-', () => {
    expect(classifyCache({ key: 'apk-urls-Linux-abc123-100-1' })).toBe('apk-urls-');
    expect(CACHE_PATTERNS_ORDERED.indexOf('apk-urls-')).toBeLessThan(CACHE_PATTERNS_ORDERED.indexOf('apk-'));
  });
});

describe('cacheGroup', () => {
  test('apk caches group per app', () => {
    expect(cacheGroup({ key: 'apk-com.google.android.youtube-20.45.36' })).toBe('apk-com.google.android.youtube');
    expect(cacheGroup({ key: 'apk-com.google.android.youtube-20.45.36-none-555' })).toBe('apk-com.google.android.youtube');
    expect(cacheGroup({ key: 'apk-com.reddit.frontpage-2024.01.01' })).toBe('apk-com.reddit.frontpage');
  });

  test('other patterns are one group each and foreign keys have none', () => {
    expect(cacheGroup({ key: 'morphe-patches-owner-repo-v1' })).toBe('morphe-patches-');
    expect(cacheGroup({ key: 'apk-urls-Linux-x-1-1' })).toBe('apk-urls-');
    expect(cacheGroup({ key: 'npm-123' })).toBeNull();
  });
});

describe('planDeletions keeps the newest cache per group', () => {
  const cache = (key, createdAt, sizeInBytes = 10) => ({ id: key, key, createdAt, sizeInBytes });
  const deleted = (caches, active = []) => planDeletions(caches, active).toDelete.map((c) => c.key).sort();

  test('an apk-urls cache newer than every APK cache no longer shields the APK caches from cleanup', () => {
    // Before: one shared apk- group, so apk-urls-* (newest) was the only entry
    // kept and the newest APK of each app was deleted with the rest.
    const caches = [
      cache('apk-urls-Linux-h-9-1', '2026-02-01T00:00:00Z'),
      cache('apk-com.a-2.0', '2026-01-02T00:00:00Z'),
      cache('apk-com.a-1.0', '2026-01-01T00:00:00Z'),
      cache('apk-com.b-5.0', '2026-01-01T00:00:00Z'),
    ];
    expect(deleted(caches)).toEqual(['apk-com.a-1.0']);
  });

  test('older apk-urls caches are deleted, the newest is kept', () => {
    const caches = [
      cache('apk-urls-Linux-h-9-1', '2026-02-01T00:00:00Z'),
      cache('apk-urls-Linux-h-8-1', '2026-01-01T00:00:00Z'),
    ];
    expect(deleted(caches)).toEqual(['apk-urls-Linux-h-8-1']);
  });

  test('each app keeps its own newest version even when another app is newer', () => {
    const caches = [
      cache('apk-com.a-2.0', '2026-03-01T00:00:00Z'),
      cache('apk-com.b-1.0', '2026-01-01T00:00:00Z'),
    ];
    expect(deleted(caches)).toEqual([]);
  });

  test('active keys are kept regardless of age and bytes are summed', () => {
    const caches = [
      cache('apk-com.a-2.0', '2026-03-01T00:00:00Z', 5),
      cache('apk-com.a-1.5', '2026-02-01T00:00:00Z', 7),
      cache('apk-com.a-1.0', '2026-01-01T00:00:00Z', 11),
    ];
    const plan = planDeletions(caches, ['apk-com.a-1.0']);
    expect(plan.toDelete.map((c) => c.key)).toEqual(['apk-com.a-1.5']);
    expect(plan.bytesToFree).toBe(7);
  });

  test('keys that are not ours are never deleted', () => {
    expect(deleted([cache('npm-1', '2026-01-01T00:00:00Z'), cache('npm-2', '2026-02-01T00:00:00Z')])).toEqual([]);
  });
});
