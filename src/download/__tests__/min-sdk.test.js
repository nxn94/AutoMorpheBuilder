'use strict';

const {
  minSdkFromConfig,
  parseMinSdkFromBadging,
  readMinSdk,
  checkMinSdk,
  fileMeetsMinSdk,
  checkFileMinSdk,
  androidLabel,
  wrongBuildMessage,
} = require('../min-sdk');

describe('minSdkFromConfig (the only source of the floor)', () => {
  const config = { patch_repos: { 'com.app': { min_sdk: 30 }, 'com.bad': { min_sdk: 'thirty' }, 'com.zero': { min_sdk: 0 } } };

  test('reads a positive integer; anything else is 0', () => {
    expect(minSdkFromConfig(config, 'com.app')).toBe(30);
    expect(minSdkFromConfig(config, 'com.bad')).toBe(0);
    expect(minSdkFromConfig(config, 'com.zero')).toBe(0);
    expect(minSdkFromConfig(config, 'com.none')).toBe(0);
    expect(minSdkFromConfig({}, 'com.app')).toBe(0);
    expect(minSdkFromConfig(null, 'com.app')).toBe(0);
  });
});

test('parseMinSdkFromBadging reads sdkVersion from aapt output', () => {
  expect(parseMinSdkFromBadging("package: name='a'\nsdkVersion:'28'\ntargetSdkVersion:'34'\n")).toBe(28);
  expect(parseMinSdkFromBadging("package: name='a'\ntargetSdkVersion:'34'\n")).toBeNull();
  expect(parseMinSdkFromBadging("sdkVersion:'abc'")).toBeNull();
  expect(parseMinSdkFromBadging(undefined)).toBeNull();
});

describe('readMinSdk', () => {
  const badging = (name, sdk, split) => `package: name='${name}' versionCode='1' versionName='1.2'${split ? ` split='${split}'` : ''}\n${sdk ? `sdkVersion:'${sdk}'\n` : ''}`;

  test('a plain APK', () => {
    const exec = jest.fn(() => badging('com.app', 28));
    expect(readMinSdk('a.apk', { execFileSyncImpl: exec })).toBe(28);
    expect(exec.mock.calls[0].slice(0, 2)).toEqual(['aapt', ['dump', 'badging', 'a.apk']]);
  });

  test("a bundle's base APK is read, not a split", () => {
    // config.apk sorts first and has a lower sdk, so the base has to be found.
    const exec = (tool, args) => {
      if (tool === 'unzip') return args[0] === '-Z1' ? 'config.arm64.apk\ncom.app.apk\n' : '';
      return String(args[2]).endsWith('config.arm64.apk') ? badging('com.app', 21, 'config.arm64') : badging('com.app', 28);
    };
    expect(readMinSdk('a.xapk', { isBundle: true, execFileSyncImpl: exec })).toBe(28);
  });

  test('unknown (null), not an error, when aapt fails, sdkVersion is missing or the bundle has no base', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(readMinSdk('a.apk', { execFileSyncImpl: () => { throw new Error('no aapt'); } })).toBeNull();
      expect(readMinSdk('a.apk', { execFileSyncImpl: () => badging('com.app', null) })).toBeNull();
      const noBase = (tool, args) => (tool === 'unzip' ? (args[0] === '-Z1' ? 'config.arm64.apk\n' : '') : badging('com.app', 28, 'config.arm64'));
      expect(readMinSdk('a.xapk', { isBundle: true, execFileSyncImpl: noBase })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

test('checkMinSdk rejects only a known sdk below a real floor', () => {
  expect(checkMinSdk(28, 30)).toEqual({ ok: false, sdk: 28, floor: 30 });
  expect(checkMinSdk(30, 30).ok).toBe(true);
  expect(checkMinSdk(33, 30).ok).toBe(true);
  expect(checkMinSdk(null, 30).ok).toBe(true);
  expect(checkMinSdk(21, 0).ok).toBe(true);
});

describe('fileMeetsMinSdk', () => {
  let spy;
  beforeEach(() => { spy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => spy.mockRestore());

  test('no floor never reads the file', () => {
    const readImpl = jest.fn();
    expect(fileMeetsMinSdk('a.apk', 0, { readImpl })).toBe(true);
    expect(readImpl).not.toHaveBeenCalled();
  });
  test('below the floor fails; at it, above it, or unknown passes', () => {
    expect(fileMeetsMinSdk('a.apk', 30, { readImpl: () => 28 })).toBe(false);
    expect(fileMeetsMinSdk('a.apk', 30, { readImpl: () => 30 })).toBe(true);
    expect(fileMeetsMinSdk('a.apk', 30, { readImpl: () => null })).toBe(true);
  });
  test('reads with aapt by default', () => {
    expect(fileMeetsMinSdk('a.apk', 30, { execFileSyncImpl: () => "package: name='a'\nsdkVersion:'28'\n" })).toBe(false);
  });
});

test('androidLabel names known API levels and falls back to the API number', () => {
  const names = { 26: '8', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16', 37: '17' };
  for (const [api, name] of Object.entries(names)) expect(androidLabel(Number(api))).toBe(`Android ${name}`);
  expect(androidLabel(99)).toBe('API 99');
});

test('an unknown floor reads naturally in the message', () => {
  expect(wrongBuildMessage({ appId: 'com.app', version: '1', rejectedSdks: [30], floor: 99, arch: 'arm64-v8a' }))
    .toContain('Patch the arm64-v8a (API 99+) build of com.app instead.');
});

test('wrongBuildMessage wording is stable, because downstream tools may parse it', () => {
  const message = wrongBuildMessage({ appId: 'com.facebook.katana', version: '586.0.0.52.53', rejectedSdks: [28, 26, 28], floor: 30, arch: 'arm64-v8a' });
  expect(message).toBe('Wrong build: every download of com.facebook.katana 586.0.0.52.53 was for older Android (API 28+); '
    + 'the patches need API 30+. Patch the arm64-v8a (Android 11+) build of com.facebook.katana instead.');
  expect(message.match(/the patches need API (\d+)\+/)[1]).toBe('30');
});

test('checkFileMinSdk reports the sdk it found', () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(checkFileMinSdk('a.apk', 30, { readImpl: () => 28 })).toEqual({ ok: false, sdk: 28 });
    expect(checkFileMinSdk('a.apk', 30, { readImpl: () => 31 })).toEqual({ ok: true, sdk: 31 });
    expect(checkFileMinSdk('a.apk', 30, { readImpl: () => null })).toEqual({ ok: true, sdk: null });
    expect(checkFileMinSdk('a.apk', 0, { readImpl: () => 28 })).toEqual({ ok: true, sdk: null });
  } finally {
    spy.mockRestore();
  }
});

test('readMinSdk reads with the deadline it is given', () => {
  const deadline = { timeoutMs: () => 321, expired: () => false };
  const exec = jest.fn(() => "package: name='a'\nsdkVersion:'28'\n");
  expect(readMinSdk('a.apk', { execFileSyncImpl: exec, deadline })).toBe(28);
  expect(exec.mock.calls[0][2].timeout).toBe(321);
});
