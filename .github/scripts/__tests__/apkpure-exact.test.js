'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadWithUrl } = require('../unified-downloader');
const { codesFromPatchList, patchListCodes, exactBuildUrls, assertExactBuild, downloadExactBuild } = require('../../../src/download/apkpure-exact');

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
    { code: 20, url: 'https://d.apkpure.com/b/XAPK/com.app?versionCode=20' },
    { code: 20, url: 'https://d.apkpure.com/b/APK/com.app?versionCode=20' },
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

describe('assertExactBuild', () => {
  const badging = (name, code, split) => `package: name='${name}' versionCode='${code}' versionName='1.2'${split ? ` split='${split}'` : ''}\n`;
  const standalone = (name, code) => (tool) => {
    if (tool !== 'aapt') throw new Error('unexpected tool');
    return badging(name, code);
  };
  // config.apk sorts first so the base has to be found, not assumed.
  const bundle = (baseCode, withBase = true) => (tool, args) => {
    if (tool === 'unzip') return args[0] === '-Z1' ? `config.arm64.apk\nassets/x.apk\n${withBase ? 'com.app.apk\n' : ''}` : '';
    return String(args[2]).endsWith('config.arm64.apk') ? badging('com.app', 999, 'config.arm64') : badging('com.app', baseCode);
  };

  test('accepts the requested package and build', () => {
    expect(() => assertExactBuild('a.apk', 'com.app', 20, { execFileSyncImpl: standalone('com.app', 20) })).not.toThrow();
  });
  test('rejects the same version name at another build', () => {
    expect(() => assertExactBuild('a.apk', 'com.app', 20, { execFileSyncImpl: standalone('com.app', 999) })).toThrow('got com.app build 999');
  });
  test('rejects another package', () => {
    expect(() => assertExactBuild('a.apk', 'com.app', 20, { execFileSyncImpl: standalone('com.evil', 20) })).toThrow('com.evil');
  });
  test("checks a bundle's base APK, not its splits", () => {
    expect(() => assertExactBuild('a.xapk', 'com.app', 20, { isBundle: true, execFileSyncImpl: bundle(20) })).not.toThrow();
    expect(() => assertExactBuild('a.xapk', 'com.app', 20, { isBundle: true, execFileSyncImpl: bundle(21) })).toThrow('build 21');
  });
  test('rejects a bundle with no base APK', () => {
    expect(() => assertExactBuild('a.xapk', 'com.app', 20, { isBundle: true, execFileSyncImpl: bundle(20, false) })).toThrow('no readable base');
  });
});

describe('downloadExactBuild', () => {
  const common = { appId: 'com.app', version: '1.2', partialPath: path.join(os.tmpdir(), 'exact-none.apk'), isBundle: () => false };
  const exec = (code) => () => `package: name='com.app' versionCode='${code}'\n`;

  test('a wrong build is rejected and the next candidate tried', async () => {
    const download = jest.fn(async (url) => ({ path: url.includes('=7') ? 'seven' : 'eight' }));
    const execFileSyncImpl = (_tool, args) => (args[2] === 'seven' ? exec(999)() : exec(8)());
    const found = await downloadExactBuild({ ...common, codes: [7, 8], download, execFileSyncImpl });
    expect(found.url).toBe('https://d.apkpure.com/b/XAPK/com.app?versionCode=8');
    expect(download).toHaveBeenCalledTimes(3);
  });

  test('stops at the shared limit, cancelling the transfer', async () => {
    const download = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    await expect(downloadExactBuild({ ...common, codes: [7, 8], download, budgetMs: 20 })).resolves.toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
  });
});
