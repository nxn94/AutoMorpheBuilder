'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_CACHE_DIR,
  getCachedUrl,
  saveCachedUrl,
  cleanupOldUrls,
} = require('../cache');

describe('download/cache', () => {
  let tmpCache;

  beforeEach(() => {
    tmpCache = fs.mkdtempSync(path.join(os.tmpdir(), 'url-cache-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpCache, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('module surface', () => {
    test('DEFAULT_CACHE_DIR lives under ~/.cache/auto-morphe-builder/urls', () => {
      expect(DEFAULT_CACHE_DIR).toBe(
        path.join(os.homedir(), '.cache', 'auto-morphe-builder', 'urls'),
      );
    });
  });

  describe('getCachedUrl', () => {
    test('returns null when nothing is cached', () => {
      expect(getCachedUrl('com.x', '1.0.0', tmpCache)).toBeNull();
    });

    test('returns the cached entry on hit', () => {
      saveCachedUrl('com.x', '1.0.0', 'https://x/y.apk', 'apkeep', tmpCache);
      const entry = getCachedUrl('com.x', '1.0.0', tmpCache);
      expect(entry).toBeTruthy();
      expect(entry.url).toBe('https://x/y.apk');
      expect(entry.source).toBe('apkeep');
      expect(entry.version).toBe('1.0.0');
    });

    test('returns null when the cache file is corrupt JSON', () => {
      const dir = path.join(tmpCache, 'com.x');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '1.0.0.json'), 'not json {');
      expect(getCachedUrl('com.x', '1.0.0', tmpCache)).toBeNull();
    });

    test('different versions are independent', () => {
      saveCachedUrl('com.x', '1.0.0', 'https://x/1.apk', 'apkeep', tmpCache);
      saveCachedUrl('com.x', '2.0.0', 'https://x/2.apk', 'apkeep', tmpCache);
      const v1 = getCachedUrl('com.x', '1.0.0', tmpCache);
      const v2 = getCachedUrl('com.x', '2.0.0', tmpCache);
      expect(v1.url).toBe('https://x/1.apk');
      expect(v2.url).toBe('https://x/2.apk');
    });

    test('sanitizes version string for the filename', () => {
      // Versions with slashes or odd characters still resolve to a
      // file on disk and round-trip back to their original key.
      saveCachedUrl('com.x', '1.0.0+meta', 'https://x/y.apk', 'apkeep', tmpCache);
      const entry = getCachedUrl('com.x', '1.0.0+meta', tmpCache);
      expect(entry).toBeTruthy();
      expect(entry.url).toBe('https://x/y.apk');
      // The sanitized filename replaces `+` with `_`.
      expect(fs.existsSync(path.join(tmpCache, 'com.x', '1.0.0_meta.json'))).toBe(true);
    });
  });

  describe('saveCachedUrl', () => {
    test('throws when a required parameter is missing', () => {
      expect(() => saveCachedUrl('', '1.0.0', 'https://x', 'apkeep', tmpCache)).toThrow();
      expect(() => saveCachedUrl('com.x', '', 'https://x', 'apkeep', tmpCache)).toThrow();
      expect(() => saveCachedUrl('com.x', '1.0.0', '', 'apkeep', tmpCache)).toThrow();
    });

    test('writes a JSON file with the expected fields', () => {
      const file = saveCachedUrl('com.x', '1.0.0', 'https://x/y.apk', 'apkeep', tmpCache);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(data).toMatchObject({
        version: '1.0.0',
        url: 'https://x/y.apk',
        source: 'apkeep',
        downloads: 1,
      });
      expect(typeof data.resolvedAt).toBe('string');
      expect(typeof data.lastWorkingAt).toBe('string');
    });

    test('increments downloads on overwrite', () => {
      saveCachedUrl('com.x', '1.0.0', 'https://x/y.apk', 'apkeep', tmpCache);
      saveCachedUrl('com.x', '1.0.0', 'https://x/y.apk', 'apkeep', tmpCache);
      const entry = getCachedUrl('com.x', '1.0.0', tmpCache);
      expect(entry.downloads).toBe(2);
    });

    test('a save recreates the package dir when missing', () => {
      // No package dir exists before save.
      const pkgDir = path.join(tmpCache, 'com.example.new');
      expect(fs.existsSync(pkgDir)).toBe(false);
      saveCachedUrl('com.example.new', '1.0.0', 'https://x/y.apk', 'apkeep', tmpCache);
      expect(fs.existsSync(pkgDir)).toBe(true);
    });

    test('recovers from a corrupt existing cache entry', () => {
      const dir = path.join(tmpCache, 'com.x');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '1.0.0.json'), '{ broken');
      saveCachedUrl('com.x', '1.0.0', 'https://x/y.apk', 'apkeep', tmpCache);
      const entry = getCachedUrl('com.x', '1.0.0', tmpCache);
      expect(entry).toBeTruthy();
      expect(entry.url).toBe('https://x/y.apk');
    });
  });

  describe('cleanupOldUrls', () => {
    test('returns 0 when no cache dir exists', () => {
      expect(cleanupOldUrls('nonexistent', 3, tmpCache)).toBe(0);
    });

    test('keeps the most-recent `keep` entries by mtime', () => {
      // Pin five entries with deterministic mtimes set 1 second apart
      // so the "newest 3" selection is reproducible. saveCachedUrl
      // auto-prunes after each save, so we write the underlying file
      // directly and run cleanupOldUrls once at the end.
      const versions = ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0'];
      const base = Date.now() / 1000;
      fs.mkdirSync(path.join(tmpCache, 'com.x'), { recursive: true });
      for (let i = 0; i < versions.length; i += 1) {
        const v = versions[i];
        const file = path.join(tmpCache, 'com.x', `${v}.json`);
        fs.writeFileSync(file, JSON.stringify({ version: v, url: `https://x/${v}`, source: 'apkeep', downloads: 1 }));
        // Each entry is exactly 1 second newer than the previous.
        fs.utimesSync(file, base + i, base + i);
      }
      const deleted = cleanupOldUrls('com.x', 3, tmpCache);
      expect(deleted).toBe(2);
      // The three newest — 3.0.0, 4.0.0, 5.0.0 — survive.
      expect(getCachedUrl('com.x', '3.0.0', tmpCache)).toBeTruthy();
      expect(getCachedUrl('com.x', '4.0.0', tmpCache)).toBeTruthy();
      expect(getCachedUrl('com.x', '5.0.0', tmpCache)).toBeTruthy();
      // The two oldest — 1.0.0, 2.0.0 — are gone.
      expect(getCachedUrl('com.x', '1.0.0', tmpCache)).toBeNull();
      expect(getCachedUrl('com.x', '2.0.0', tmpCache)).toBeNull();
    });

    test('does not prune when entries ≤ keep', () => {
      // Same approach: write two entries with deterministic mtimes
      // so cleanup with keep=3 deletes nothing.
      const base = Date.now() / 1000;
      fs.mkdirSync(path.join(tmpCache, 'com.x'), { recursive: true });
      for (let i = 0; i < 2; i += 1) {
        const v = `1.0.${i}`;
        const file = path.join(tmpCache, 'com.x', `${v}.json`);
        fs.writeFileSync(file, JSON.stringify({ version: v, url: `https://x/${v}`, source: 'apkeep', downloads: 1 }));
        fs.utimesSync(file, base + i, base + i);
      }
      expect(cleanupOldUrls('com.x', 3, tmpCache)).toBe(0);
      expect(getCachedUrl('com.x', '1.0.0', tmpCache)).toBeTruthy();
      expect(getCachedUrl('com.x', '1.0.1', tmpCache)).toBeTruthy();
    });
  });
});
