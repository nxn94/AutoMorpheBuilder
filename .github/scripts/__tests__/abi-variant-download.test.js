'use strict';

// download() when a source serves a build for another architecture: the file
// is downloaded once (a retry can't change it), and if it came from APKPure
// the other variants of that version are tried before the other sources.
// curl and aapt are stubbed; the ABI check is stubbed per URL.

jest.mock('../goopdl-downloader', () => ({ downloadWithGoopdl: jest.fn() }));

let mockWrongArch = new Set();
let mockCurrent;
jest.mock('../apk-abi-validator', () => {
  const actual = jest.requireActual('../apk-abi-validator');
  return {
    ...actual,
    validateDownloadedApkAbi: jest.fn(() => {
      if (!mockWrongArch.has(mockCurrent)) return;
      const error = new Error('Downloaded bundle x.apk has no split containing lib/arm64-v8a/*.so.');
      error.code = actual.ABI_MISMATCH;
      throw error;
    }),
  };
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { download } = require('../unified-downloader');
const { downloadWithGoopdl } = require('../goopdl-downloader');

const PKG = 'com.example.abi';
const VER = '1.2.3';
const placeholder = path.resolve(__dirname, '../../../test/fixtures/apk-metadata/placeholder.apk');

const variant = (size, code) => {
  const inner = Buffer.from(`dev=Example&t=xapk&s=${size}&vn=${VER}&vc=${code}`).toString('base64');
  return `https://download.pureapk.com/b/XAPK/${code}${size}?_fn=x&c=1|CAT|${inner}`;
};
// Twitter 12.19.1 on APKPure: one build, three variants, the arm64 one largest.
const SMALL = variant(100, 11);
const MID = variant(200, 11);
const BIG = variant(300, 11);
const listing = [MID, BIG, SMALL].join('\n');

let dir;
let outDir;
let cacheDir;
let fetched;
let errors;
let listingFetches;

// Fake curl: writes the placeholder APK and remembers which URL it came from.
function spawnImpl(_cmd, args) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  const url = args.at(-1);
  const out = args[args.indexOf('-o') + 1];
  fetched.push(url);
  setImmediate(() => {
    fs.copyFileSync(placeholder, out);
    mockCurrent = url;
    child.emit('close', 0);
  });
  return child;
}

function execFileSyncImpl(tool) {
  if (tool !== 'aapt') {
    const error = new Error('unavailable');
    error.code = 'ENOENT';
    throw error;
  }
  return `package: name='${PKG}' versionCode='11' versionName='${VER}'\n`;
}

const noApkeep = jest.fn((_c, _a, _o, cb) => cb(new Error('no apkeep'), '', ''));

const options = (resolvers) => ({
  cacheDir,
  minSdk: 0,
  spawnImpl,
  execFileSyncImpl,
  execFileImpl: noApkeep,
  sleepImpl: async () => {},
  fetchImpl: async () => { listingFetches++; return { ok: true, status: 200, text: async () => listing }; },
  sourceResolvers: resolvers,
});

const cachedUrl = () => {
  try { return JSON.parse(fs.readFileSync(path.join(cacheDir, PKG, `${VER}.json`), 'utf8')).url; } catch { return null; }
};

beforeEach(() => {
  jest.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-dl-'));
  outDir = path.join(dir, 'out');
  cacheDir = path.join(dir, 'urls');
  fetched = [];
  listingFetches = 0;
  mockWrongArch = new Set();
  mockCurrent = undefined;
  downloadWithGoopdl.mockRejectedValue(new Error('Google Play unavailable'));
  global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
  errors = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
  delete global.fetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

const logged = () => errors.mock.calls.map((c) => c.join(' ')).join('\n');

test("APKPure's other variants are tried when its pick is for another architecture, each downloaded once", async () => {
  mockWrongArch = new Set([SMALL, MID]);
  const result = await download(PKG, VER, outDir, options({
    apkeep: async () => ({ url: SMALL, source: 'apkeep' }),
    apkmirrorApi: async () => { throw new Error('none'); },
    apkmirror: async () => { throw new Error('none'); },
  }));
  expect(result.success).toBe(true);
  expect(fetched).toEqual([SMALL, MID, BIG]);
  expect(cachedUrl()).toBe(BIG);
  expect(logged()).not.toContain('Retry attempt');
});

test("when no APKPure variant fits, APKPure's own pick isn't fetched again through apkeep", async () => {
  mockWrongArch = new Set([SMALL, MID, BIG]);
  await expect(download(PKG, VER, outDir, options({
    apkeep: async () => ({ url: SMALL, source: 'apkeep' }),
    apkmirrorApi: async () => { throw new Error('none'); },
    apkmirror: async () => { throw new Error('none'); },
  }))).rejects.toThrow();
  expect(fetched).toEqual([SMALL, MID, BIG]);
  expect(logged()).toContain("[apkeep] Skipped: APKPure's variants were already tried");
  expect(noApkeep).not.toHaveBeenCalled();
});

test('a file for another architecture from any source is not downloaded again', async () => {
  const MIRROR = 'https://cdn.example.test/mirror.apk';
  mockWrongArch = new Set([MIRROR]);
  await expect(download(PKG, VER, outDir, options({
    apkeep: async () => { throw new Error('none'); },
    apkmirrorApi: async () => ({ url: MIRROR, source: 'apkmirror-api' }),
    apkmirror: async () => { throw new Error('none'); },
  }))).rejects.toThrow();
  expect(fetched.filter((u) => u === MIRROR)).toHaveLength(1);
  // Not an APKPure URL, so APKPure's variant listing isn't fetched for it.
  expect(listingFetches).toBe(0);
});

test('a cached APKPure URL for another architecture is dropped and not downloaded again', async () => {
  fs.mkdirSync(path.join(cacheDir, PKG), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, PKG, `${VER}.json`), JSON.stringify({ url: SMALL, source: 'apkeep', downloads: 1 }));
  mockWrongArch = new Set([SMALL]);
  const result = await download(PKG, VER, outDir, options({
    apkeep: async () => ({ url: SMALL, source: 'apkeep' }),
    apkmirrorApi: async () => { throw new Error('none'); },
    apkmirror: async () => { throw new Error('none'); },
  }));
  expect(result.success).toBe(true);
  expect(fetched.filter((u) => u === SMALL)).toHaveLength(1);
  expect(cachedUrl()).not.toBe(SMALL);
});

test('other download failures are still retried', async () => {
  let calls = 0;
  const flaky = (cmd, args) => {
    calls++;
    if (calls > 1) return spawnImpl(cmd, args);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    fetched.push(args.at(-1));
    setImmediate(() => child.emit('close', 28));
    return child;
  };
  const result = await download(PKG, VER, outDir, {
    ...options({
      apkeep: async () => ({ url: BIG, source: 'apkeep' }),
      apkmirrorApi: async () => { throw new Error('none'); },
      apkmirror: async () => { throw new Error('none'); },
    }),
    spawnImpl: flaky,
  });
  expect(result.success).toBe(true);
  expect(fetched).toEqual([BIG, BIG]);
});
