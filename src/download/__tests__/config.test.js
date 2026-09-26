'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, loadExistingUrl } = require('../config');

function tmpConfigPath(content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
  const file = path.join(tmp, 'config.json');
  fs.writeFileSync(file, content);
  return { tmp, file };
}

describe('download/config', () => {
  describe('loadConfig', () => {
    test('returns {} when the file is missing', () => {
      const result = loadConfig('/nonexistent/config.json');
      expect(result).toEqual({});
    });

    test('returns parsed object when the file exists', () => {
      const { tmp, file } = tmpConfigPath(JSON.stringify({
        patch_repos: { 'com.x': { apkmirror_path: 'x/y' } },
        download_urls: { 'com.x': { '1.0.0': 'https://x/1.apk' } },
      }));
      try {
        const result = loadConfig(file);
        expect(result).toEqual({
          patch_repos: { 'com.x': { apkmirror_path: 'x/y' } },
          download_urls: { 'com.x': { '1.0.0': 'https://x/1.apk' } },
        });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('returns {} and logs a warning on corrupt JSON', () => {
      const { tmp, file } = tmpConfigPath('{ broken');
      try {
        const result = loadConfig(file);
        expect(result).toEqual({});
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('returns {} when called with no argument and no config.json in cwd', () => {
      const cwd = process.cwd();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'no-config-'));
      try {
        process.chdir(tmp);
        expect(loadConfig()).toEqual({});
      } finally {
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });

  describe('loadExistingUrl', () => {
    test('returns null when no download_urls block exists', () => {
      const { tmp, file } = tmpConfigPath(JSON.stringify({ patch_repos: {} }));
      try {
        expect(loadExistingUrl('com.x', '1.0.0', file)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('returns null when the package is unknown', () => {
      const { tmp, file } = tmpConfigPath(JSON.stringify({
        download_urls: { 'com.other': { '1.0.0': 'https://x/1.apk' } },
      }));
      try {
        expect(loadExistingUrl('com.x', '1.0.0', file)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('returns null when the version is not configured (exact-version only)', () => {
      const { tmp, file } = tmpConfigPath(JSON.stringify({
        download_urls: { 'com.x': { '1.0.0': 'https://x/1.apk' } },
      }));
      try {
        expect(loadExistingUrl('com.x', '2.0.0', file)).toBeNull();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

    test('returns the configured URL on exact-version match', () => {
      const { tmp, file } = tmpConfigPath(JSON.stringify({
        download_urls: {
          'com.x': {
            '1.0.0': 'https://x/1.apk',
            '2.0.0': 'https://x/2.apk',
          },
        },
      }));
      try {
        expect(loadExistingUrl('com.x', '1.0.0', file)).toBe('https://x/1.apk');
        expect(loadExistingUrl('com.x', '2.0.0', file)).toBe('https://x/2.apk');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
