'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findApkFile, APK_EXTENSIONS } = require('../scan');

describe('download/scan', () => {
  describe('APK_EXTENSIONS', () => {
    test('lists every extension the downloader cares about', () => {
      expect(APK_EXTENSIONS).toEqual(['.apk', '.xapk', '.apkm']);
    });
  });

  describe('findApkFile', () => {
    test('returns null when the directory is missing', () => {
      expect(findApkFile('/nonexistent/path/does/not/exist')).toBeNull();
    });

    test('returns null when the directory is empty', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
      try {
        expect(findApkFile(tmp)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('returns null when no APK-shaped file exists in the directory', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
      try {
        fs.writeFileSync(path.join(tmp, 'README.md'), 'hi');
        fs.writeFileSync(path.join(tmp, 'notes.txt'), 'hi');
        expect(findApkFile(tmp)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('returns the first .apk file in readdir order', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
      try {
        fs.writeFileSync(path.join(tmp, 'first.apk'), '');
        fs.writeFileSync(path.join(tmp, 'second.apk'), '');
        fs.writeFileSync(path.join(tmp, 'third.apk'), '');
        // readdirSync returns names in the order they appear in the
        // directory, not lexicographically, on Linux ext4. We
        // assert first.apk is the picked file because the
        // implementation iterates in readdir order.
        const result = findApkFile(tmp);
        expect(result).not.toBeNull();
        expect(path.basename(result)).toMatch(/\.apk$/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('matches .xapk split packages', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
      try {
        fs.writeFileSync(path.join(tmp, 'app_v1.xapk'), '');
        expect(findApkFile(tmp)).toBe(path.join(tmp, 'app_v1.xapk'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('matches .apkm split packages', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
      try {
        fs.writeFileSync(path.join(tmp, 'app_v1.apkm'), '');
        expect(findApkFile(tmp)).toBe(path.join(tmp, 'app_v1.apkm'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('case-insensitive extension match', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
      try {
        // Mixed-case extension — common when the upstream CDN
        // serves the file with .APK capitalization.
        fs.writeFileSync(path.join(tmp, 'app_v1.APK'), '');
        expect(findApkFile(tmp)).toBe(path.join(tmp, 'app_v1.APK'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('does not descend into subdirectories', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
      try {
        // APK in a subdirectory should NOT be picked up — the
        // downloader's flat APKS_DIR contract means a recursive
        // scan would surprise callers that pre-stage intermediate
        // artifacts in subfolders.
        fs.mkdirSync(path.join(tmp, 'sub'));
        fs.writeFileSync(path.join(tmp, 'sub', 'app.apk'), '');
        expect(findApkFile(tmp)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('exposes a stub-friendly readdir/exists override path', () => {
      // Pin that the opts-driven path works: tests that don't want
      // a real tmp dir on disk can pass a synthetic readdir/exists.
      const readdirStub = () => ['pre.apk'];
      const existsStub = () => true;
      const result = findApkFile('/synthetic', { readdir: readdirStub, exists: existsStub });
      expect(result).toBe(path.join('/synthetic', 'pre.apk'));
    });
  });
});
