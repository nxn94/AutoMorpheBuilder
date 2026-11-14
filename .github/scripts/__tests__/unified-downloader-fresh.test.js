'use strict';

// FRESH_DOWNLOAD (opts.fresh): download() skips the remembered URLs, so a file
// that just failed to patch is not fetched again by its cached URL.

jest.mock('../goopdl-downloader', () => ({ downloadWithGoopdl: jest.fn() }));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { download } = require('../unified-downloader');
const { downloadWithGoopdl } = require('../goopdl-downloader');

const PKG = 'com.example.fresh';
const VER = '1.2.3';
const OLD = 'https://cdn.example.test/old.apk';
const NEW = 'https://cdn.example.test/new.apk';
const placeholder = path.resolve(__dirname, '../../../test/fixtures/apk-metadata/placeholder.apk');

let dir;
let cacheDir;
let fetched;
let errors;

// Fake curl: writes the placeholder APK and remembers which URL it came from.
function spawnImpl(_cmd, args) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  fetched.push(args.at(-1));
  setImmediate(() => { fs.copyFileSync(placeholder, args[args.indexOf('-o') + 1]); child.emit('close', 0); });
  return child;
}
// Fake aapt: the right package and version.
function execFileSyncImpl(tool) {
  if (tool !== 'aapt') throw Object.assign(new Error('unavailable'), { code: 'ENOENT' });
  return `package: name='${PKG}' versionCode='1' versionName='${VER}'\n`;
}
const options = (extra = {}) => ({
  cacheDir,
  minSdk: 0,
  spawnImpl,
  execFileSyncImpl,
  sleepImpl: async () => {},
  sourceResolvers: {
    apkeep: async () => ({ url: NEW, source: 'apkeep' }),
    apkmirrorApi: async () => { throw new Error('none'); },
    apkmirror: async () => { throw new Error('none'); },
  },
  ...extra,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-urls-'));
  cacheDir = path.join(dir, 'urls');
  fetched = [];
  fs.mkdirSync(path.join(cacheDir, PKG), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, PKG, `${VER}.json`), JSON.stringify({ version: VER, url: OLD, source: 'apkeep', downloads: 1, lastWorkingAt: 'x' }));
  downloadWithGoopdl.mockRejectedValue(new Error('Google Play unavailable'));
  global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
  errors = jest.spyOn(console, 'error').mockImplementation(() => {});
  delete process.env.FRESH_DOWNLOAD;
});
afterEach(() => {
  errors.mockRestore();
  delete global.fetch;
  delete process.env.FRESH_DOWNLOAD;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('by default the remembered URL is used', async () => {
  await download(PKG, VER, path.join(dir, 'out'), options());
  expect(fetched).toEqual([OLD]);
});

test('FRESH_DOWNLOAD skips the remembered URL and resolves again', async () => {
  process.env.FRESH_DOWNLOAD = '1';
  const result = await download(PKG, VER, path.join(dir, 'out'), options());
  expect(result.success).toBe(true);
  expect(fetched).toEqual([NEW]);
});
