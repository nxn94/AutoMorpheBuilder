'use strict';

// download() when a source serves a build for an older Android than the
// patches support: the file is dropped, never cached, the URL is uncached,
// and the next path is tried. curl and aapt are stubbed;
// the package is not in config.json so the APKMirror sources fail fast.

jest.mock('../goopdl-downloader', () => ({ downloadWithGoopdl: jest.fn() }));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { download } = require('../unified-downloader');
const { downloadWithGoopdl } = require('../goopdl-downloader');

const PKG = 'com.example.minsdk';
const VER = '1.2.3';
const placeholder = path.resolve(__dirname, '../../../test/fixtures/apk-metadata/placeholder.apk');

const SMALL = 'https://download.pureapk.com/b/XAPK/small';

let dir;
let outDir;
let cacheDir;
let sdkByUrl;
let fetched;
let current;
let errors;

// Fake curl: writes the placeholder APK and remembers which URL it came from.
function spawnImpl(_cmd, args) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  const url = args.at(-1);
  const out = args[args.indexOf('-o') + 1];
  fetched.push(url);
  setImmediate(() => {
    fs.copyFileSync(placeholder, out);
    current = sdkByUrl[url];
    child.emit('close', 0);
  });
  return child;
}

// Fake aapt: the package/version line, plus sdkVersion of the last download.
function execFileSyncImpl(tool, args) {
  if (tool !== 'aapt') {
    const error = new Error('unavailable');
    error.code = 'ENOENT';
    throw error;
  }
  const sdk = path.basename(String(args[2])) === 'goopdl.apkm' ? sdkByUrl.goopdl : current;
  return `package: name='${PKG}' versionCode='1' versionName='${VER}'\n${sdk ? `sdkVersion:'${sdk}'\n` : ''}`;
}

const resolvers = (url) => ({
  apkeep: async () => ({ url, source: 'apkeep' }),
  apkmirrorApi: async () => { throw new Error('none'); },
  apkmirror: async () => { throw new Error('none'); },
});

const options = (extra = {}) => ({
  cacheDir,
  minSdk: 30,
  spawnImpl,
  execFileSyncImpl,
  sleepImpl: async () => {},
  ...extra,
});

function seedCache(url) {
  fs.mkdirSync(path.join(cacheDir, PKG), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, PKG, `${VER}.json`), JSON.stringify({ version: VER, url, source: 'apkeep', downloads: 1, lastWorkingAt: 'x' }));
}
const cachedUrl = () => {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, PKG, `${VER}.json`), 'utf8')).url; } catch { return null; }
};

beforeEach(() => {
  jest.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'min-sdk-dl-'));
  outDir = path.join(dir, 'out');
  cacheDir = path.join(dir, 'urls');
  sdkByUrl = {};
  fetched = [];
  current = undefined;
  downloadWithGoopdl.mockRejectedValue(new Error('Google Play unavailable'));
  global.fetch = jest.fn(async () => ({ ok: true, status: 200 })); // verifyUrl HEAD probe
  errors = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
  delete global.fetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

const logged = () => errors.mock.calls.map((c) => c.join(' ')).join('\n');

test('a cached URL for an old build is dropped and the next source is used', async () => {
  const OLD = 'https://cdn.example.test/old.apk';
  const NEW = 'https://cdn.example.test/new.apk';
  seedCache(OLD);
  sdkByUrl[OLD] = 28;
  sdkByUrl[NEW] = 30;
  const result = await download(PKG, VER, outDir, options({ sourceResolvers: resolvers(NEW) }));
  expect(result.success).toBe(true);
  expect(fetched).toEqual([OLD, NEW]);
  expect(logged()).toContain('[min-sdk] url-cache: build is for Android API 28+, the patches need API 30+');
  expect(cachedUrl()).toBe(NEW);
  expect(fs.readdirSync(outDir)).toEqual([`${PKG}_${VER}.apk`]);
});

test("the patch list's own minSdk is not a floor: only config min_sdk is", async () => {
  // A real tools/patches-list.json that names minSdk 35 for this app and version.
  const toolsDir = path.join(dir, 'tools');
  fs.mkdirSync(toolsDir);
  fs.writeFileSync(path.join(toolsDir, 'patches-list.json'), JSON.stringify({
    patches: [{ name: 'p', compatiblePackages: [{ packageName: PKG, targets: [{ version: VER, minSdk: 35, versionCodes: null }] }] }],
  }));
  const OLD = 'https://cdn.example.test/old.apk';
  seedCache(OLD);
  sdkByUrl[OLD] = 28;
  const previous = process.env.TOOLS_DIR;
  process.env.TOOLS_DIR = toolsDir;
  try {
    const result = await download(PKG, VER, outDir, options({ minSdk: undefined }));
    expect(result.success).toBe(true);
    expect(fetched).toEqual([OLD]);
    expect(logged()).not.toContain('[min-sdk]');
  } finally {
    if (previous === undefined) delete process.env.TOOLS_DIR; else process.env.TOOLS_DIR = previous;
  }
});

test('a rejected build is never remembered, and every-path failure says which build to patch', async () => {
  sdkByUrl[SMALL] = 28;
  await expect(download(PKG, VER, outDir, options({ sourceResolvers: resolvers(SMALL) })))
    .rejects.toThrow(`Wrong build: every download of ${PKG} ${VER} was for older Android (API 28+); `
      + `the patches need API 30+. Patch the arm64-v8a (Android 11+) build of ${PKG} instead.`);
  expect(fetched).toEqual([SMALL]);
  expect(cachedUrl()).toBeNull();
  expect(fs.existsSync(path.join(outDir, `${PKG}_${VER}.apk`))).toBe(false);
});

test('a build whose minimum Android cannot be read is kept for the patcher', async () => {
  const URL_A = 'https://cdn.example.test/a.apk';
  sdkByUrl[URL_A] = undefined; // aapt prints no sdkVersion
  const result = await download(PKG, VER, outDir, options({ sourceResolvers: resolvers(URL_A) }));
  expect(result.success).toBe(true);
  expect(logged()).toContain('minimum Android unknown');
  expect(cachedUrl()).toBe(URL_A);
});

test('with no floor nothing is read and nothing is rejected', async () => {
  const URL_A = 'https://cdn.example.test/a.apk';
  sdkByUrl[URL_A] = 21;
  const exec = jest.fn(execFileSyncImpl);
  const result = await download(PKG, VER, outDir, options({ minSdk: 0, execFileSyncImpl: exec, sourceResolvers: resolvers(URL_A) }));
  expect(result.success).toBe(true);
  expect(logged()).not.toContain('[min-sdk]');
});

test('a Google Play file below the floor is deleted and the other sources are tried', async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'goopdl.apkm');
  fs.copyFileSync(placeholder, file);
  downloadWithGoopdl.mockResolvedValue({ success: true, file, source: 'goopdl', version: VER });
  sdkByUrl.goopdl = 28;
  const URL_A = 'https://cdn.example.test/a.apk';
  sdkByUrl[URL_A] = 31;
  const result = await download(PKG, VER, outDir, options({ sourceResolvers: resolvers(URL_A) }));
  expect(result.source).not.toBe('goopdl');
  expect(fs.existsSync(file)).toBe(false);
  expect(fetched).toEqual([URL_A]);
  expect(logged()).toContain('[min-sdk] goopdl: build is for Android API 28+');
});

test('a URL rejected from the cache is not downloaded again by a later path', async () => {
  seedCache(SMALL);
  sdkByUrl[SMALL] = 28;
  await expect(download(PKG, VER, outDir, options({ sourceResolvers: resolvers(SMALL) }))).rejects.toThrow(/^Wrong build:/);
  expect(fetched).toEqual([SMALL]); // the resolver's identical URL was not fetched a second time
});

test('once the time is up after a rejection, the clear error is thrown instead of starting another step', async () => {
  const OLD = 'https://cdn.example.test/old.apk';
  const NEW = 'https://cdn.example.test/new.apk';
  seedCache(OLD);
  sdkByUrl[OLD] = 28;
  sdkByUrl[NEW] = 31;
  await expect(download(PKG, VER, outDir, options({ totalBudgetMs: 0, sourceResolvers: resolvers(NEW) })))
    .rejects.toThrow(/^Wrong build: every download of com\.example\.minsdk 1\.2\.3 was for older Android \(API 28\+\)/);
  expect(fetched).toEqual([OLD]);
  expect(fs.existsSync(path.join(outDir, `${PKG}_${VER}.apk`))).toBe(false);
});
