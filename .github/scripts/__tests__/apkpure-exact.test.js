'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadWithUrl } = require('../unified-downloader');
const { codesFromPatchList, patchListCodes, exactBuildUrls } = require('../../../src/download/apkpure-exact');

const list = {
  patches: [{
    name: 'x',
    compatiblePackages: [
      { packageName: 'com.app', targets: [{ version: '1.2 - Stable', versionCodes: { ARMEABI_V7A: 10, ARM64_V8A: 20, X86: 'bad' } }] },
      { packageName: 'com.other', targets: [{ version: '1.2', versionCodes: { ARM64_V8A: 30 } }] },
    ],
  }],
};

test('preferred CPU first; other apps, versions and bad values ignored', () => {
  expect(codesFromPatchList(list, 'com.app', '1.2', 'arm64-v8a')).toEqual([20, 10]);
  expect(codesFromPatchList(list, 'com.app', '1.3', 'arm64-v8a')).toEqual([]);
  expect(codesFromPatchList(null, 'com.app', '1.2', 'arm64-v8a')).toEqual([]);
});

test('a missing or broken patch list gives no build numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-'));
  expect(patchListCodes('com.app', '1.2', 'arm64-v8a', dir)).toEqual([]);
  fs.writeFileSync(path.join(dir, 'patches-list.json'), '{');
  expect(patchListCodes('com.app', '1.2', 'arm64-v8a', dir)).toEqual([]);
  fs.writeFileSync(path.join(dir, 'patches-list.json'), JSON.stringify(list));
  expect(patchListCodes('com.app', '1.2', 'arm64-v8a', dir)).toEqual([20, 10]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bundle then single APK per build number', () => {
  expect(exactBuildUrls('com.app', [20])).toEqual([
    'https://d.apkpure.com/b/XAPK/com.app?versionCode=20',
    'https://d.apkpure.com/b/APK/com.app?versionCode=20',
  ]);
});

test('curl sends a User-Agent only when asked', async () => {
  const argsFor = async (extra) => {
    const spawnImpl = jest.fn(() => { throw new Error('stop'); });
    await expect(downloadWithUrl('https://example.test/a.apk', '/unused', 'com.app', '1.2', { spawnImpl, sleepImpl: async () => {}, ...extra })).rejects.toThrow('stop');
    return spawnImpl.mock.calls[0][1];
  };
  expect(await argsFor({})).not.toContain('-A');
  const args = await argsFor({ userAgent: 'x/1' });
  expect(args.slice(args.indexOf('-A'), args.indexOf('-A') + 2)).toEqual(['-A', 'x/1']);
  expect(args.slice(-2)).toEqual(['--', 'https://example.test/a.apk']);
});
