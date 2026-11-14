'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadWithUrl } = require('../unified-downloader');
const { codesFromPatchList, targetsForApp, patchListCodes, exactBuildUrls, assertExactBuild, downloadExactBuild } = require('../../../src/download/apkpure-exact');

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

// Excerpt of SysAdminDoc/Hushfacebook's patches-list.json (v0.22.0): the packages are
// an object of version lists, and the targets (with their build numbers) are in compatibility[].
const hushfacebook = {
  version: 'v0.22.0',
  patches: [{
    name: 'AMOLED black theme',
    compatiblePackages: { 'com.facebook.katana': ['586.0.0.52.53'] },
    compatibility: [{
      name: 'Facebook',
      packageName: 'com.facebook.katana',
      description: null,
      targets: [{ version: '586.0.0.52.53', experimental: false, versionCodes: { ARM64_V8A: 476217123, ARMEABI_V7A: 476217122 } }],
    }],
  }],
};

test("a patch list with compatibility[].targets (Hushfacebook's layout) gives its build numbers", () => {
  expect(codesFromPatchList(hushfacebook, 'com.facebook.katana', '586.0.0.52.53', 'arm64-v8a')).toEqual([476217123, 476217122]);
  expect(codesFromPatchList(hushfacebook, 'com.facebook.katana', '586.0.0.52.53', 'armeabi-v7a')).toEqual([476217122, 476217123]);
  expect(codesFromPatchList(hushfacebook, 'com.facebook.katana', '587.0.0.39.55', 'arm64-v8a')).toEqual([]);
  expect(codesFromPatchList(hushfacebook, 'com.other', '586.0.0.52.53', 'arm64-v8a')).toEqual([]);
  expect(targetsForApp(hushfacebook, 'com.facebook.katana')).toHaveLength(1);
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

  test('a verify hook that throws rejects the candidate and the next is tried', async () => {
    const download = jest.fn(async (url) => ({ path: url.includes('=7') ? 'seven' : 'eight' }));
    const verify = jest.fn((result) => { if (result.path === 'seven') throw new Error('too old'); });
    const execFileSyncImpl = (_tool, args) => exec(args[2] === 'seven' ? 7 : 8)();
    const found = await downloadExactBuild({ ...common, codes: [7, 8], download, execFileSyncImpl, verify });
    expect(found.url).toBe('https://d.apkpure.com/b/XAPK/com.app?versionCode=8');
    expect(verify).toHaveBeenCalledTimes(3); // XAPK and APK of build 7 both rejected, then XAPK of build 8
  });

  test('a wrong build is rejected and the next candidate tried', async () => {
    const download = jest.fn(async (url) => ({ path: url.includes('=7') ? 'seven' : 'eight' }));
    const execFileSyncImpl = (_tool, args) => (args[2] === 'seven' ? exec(999)() : exec(8)());
    const found = await downloadExactBuild({ ...common, codes: [7, 8], download, execFileSyncImpl });
    expect(found.url).toBe('https://d.apkpure.com/b/XAPK/com.app?versionCode=8');
    expect(download).toHaveBeenCalledTimes(3);
  });

  const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  test('a check past the limit is not accepted, even if it reports a match', async () => {
    const timeouts = [];
    const execFileSyncImpl = (_tool, _args, options) => {
      timeouts.push(options.timeout);
      block(60);
      return "package: name='com.app' versionCode='7'\n";
    };
    const download = jest.fn(async () => ({ path: 'file' }));
    await expect(downloadExactBuild({ ...common, codes: [7], download, execFileSyncImpl, budgetMs: 20 })).resolves.toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
    expect(timeouts[0]).toBeGreaterThanOrEqual(1);
    expect(timeouts[0]).toBeLessThanOrEqual(20);
  });

  test('checks inside the download past the limit also reject the file, and stop further candidates', async () => {
    const download = jest.fn(async () => { block(40); return { path: 'file' }; });
    const execFileSyncImpl = exec(7);
    await expect(downloadExactBuild({ ...common, codes: [7, 8], download, execFileSyncImpl, budgetMs: 10 })).resolves.toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
  });

  test('the download is given the remaining time for its own checks', async () => {
    const download = jest.fn(async () => ({ path: 'file' }));
    const isBundle = jest.fn(() => false);
    await downloadExactBuild({ ...common, isBundle, codes: [7], download, execFileSyncImpl: exec(7), budgetMs: 5000 });
    const { timeoutMs, expired } = download.mock.calls[0][1];
    expect(timeoutMs()).toBeGreaterThanOrEqual(1);
    expect(timeoutMs()).toBeLessThanOrEqual(5000);
    expect(expired()).toBe(false);
    expect(typeof isBundle.mock.calls[0][1]).toBe('function');
  });

  test('stops at the shared limit, cancelling the transfer', async () => {
    const download = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    await expect(downloadExactBuild({ ...common, codes: [7, 8], download, budgetMs: 20 })).resolves.toBeNull();
    expect(download).toHaveBeenCalledTimes(1);
  });

  test('a cancel that fires before the end time still stops further candidates', async () => {
    const controller = new AbortController();
    const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const download = jest.fn(async (_url, { signal }) => {
        if (!signal.aborted) controller.abort(new Error('cancelled'));
        throw signal.reason;
      });
      await expect(downloadExactBuild({ ...common, codes: [7, 8], download, budgetMs: 5000 })).resolves.toBeNull();
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe('existing checks honour the time limit', () => {
  const { validateApkVersion } = require('../../../src/download/aapt');
  const { detectApkShape } = require('../apk-selection');
  const { validateDownloadedApkAbi } = require('../apk-abi-validator');
  const posixTest = process.platform === 'win32' ? test.skip : test;

  test('validateApkVersion passes the remaining time to aapt', () => {
    const execFileSyncImpl = jest.fn(() => "package: name='com.app' versionCode='7' versionName='1.2'\n");
    validateApkVersion('a.apk', '1.2', { execFileSyncImpl, timeoutMs: () => 123 });
    expect(execFileSyncImpl.mock.calls[0][2].timeout).toBe(123);
  });

  posixTest('a stalled unzip is cut off at the limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-unzip-'));
    const originalPath = process.env.PATH;
    fs.writeFileSync(path.join(dir, 'unzip'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
    const apk = path.join(dir, 'a.apk');
    fs.writeFileSync(apk, Buffer.from('PK\x03\x04'));
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
    try {
      const start = Date.now();
      expect(detectApkShape(apk, { timeoutMs: () => 50 })).toBe('unknown');
      expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a', { timeoutMs: () => 50 })).not.toThrow();
      expect(Date.now() - start).toBeLessThan(5000);
    } finally {
      process.env.PATH = originalPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
