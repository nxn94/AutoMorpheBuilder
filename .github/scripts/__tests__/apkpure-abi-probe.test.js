'use strict';

// APKPure variants are ranked by what their zip holds (a ranged read of the
// file tail), not by size alone. curl, aapt and the network are faked; the
// package is not in config.json so the APKMirror sources fail fast.

jest.mock('../goopdl-downloader', () => ({ downloadWithGoopdl: jest.fn() }));

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { download, resolveApkeepVariant } = require('../unified-downloader');
const { downloadWithGoopdl } = require('../goopdl-downloader');

const PKG = 'com.example.abiprobe';
const VER = '1.2.3';
const placeholder = path.resolve(__dirname, '../../../test/fixtures/apk-metadata/placeholder.apk');

const variant = (size, code) => {
  const inner = Buffer.from(`dev=Example&t=xxapk&s=${size}&vn=${VER}&vc=${code}`).toString('base64');
  return `https://download.pureapk.com/b/XAPK/${code}?_fn=x&c=1|CAT|${inner}`;
};
const SMALL = variant(265, 11); // armeabi-v7a
const MID = variant(285, 12); // arm64-v8a
const BIG = variant(297, 13); // x86
const listing = [SMALL, MID, BIG].join('\n');

// The last bytes of a zip holding the given entry names.
function zipTail(names) {
  const totalSize = 5_000_000;
  const cd = Buffer.concat(names.map((n) => {
    const h = Buffer.alloc(46 + n.length);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(n.length, 28);
    h.write(n, 46);
    return h;
  }));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(totalSize - 22 - cd.length, 16);
  return { body: Buffer.concat([cd, eocd]), totalSize };
}
const namesByBuild = {
  11: ['base.apk', 'config.armeabi_v7a.apk'],
  12: ['base.apk', 'config.arm64_v8a.apk'],
  13: ['base.apk', 'config.x86.apk'],
};

let dir;
let outDir;
let cacheDir;
let fetched;
let probed;
let probeMode; // 'zip' | 'full' | 'throw'
let errors;

// One fake network: the listing, and range probes of the variant files.
async function fakeFetch(url, init = {}) {
  if (String(url).includes('api.pureapk.com')) return { ok: true, status: 200, text: async () => listing };
  probed.push(url);
  if (probeMode === 'throw') throw new Error('network down');
  if (probeMode === 'full') return { ok: true, status: 200, body: { cancel: jest.fn() } };
  if (probeMode === 'oversized') {
    return {
      ok: true,
      status: 206,
      headers: { get: (h) => (h.toLowerCase() === 'content-length' ? '300000' : null) },
      body: { cancel: jest.fn() },
      arrayBuffer: async () => { throw new Error('an oversized range must not be read'); },
    };
  }
  expect(init.headers.Range).toBe('bytes=-65558');
  const code = new URL(url).pathname.split('/').pop();
  const { body, totalSize } = zipTail(namesByBuild[code]);
  return {
    ok: true,
    status: 206,
    headers: { get: (h) => (h.toLowerCase() === 'content-range' ? `bytes ${totalSize - body.length}-${totalSize - 1}/${totalSize}` : null) },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
  };
}

function spawnImpl(_cmd, args) {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  fetched.push(args.at(-1));
  const out = args[args.indexOf('-o') + 1];
  setImmediate(() => {
    fs.copyFileSync(placeholder, out);
    child.emit('close', 0);
  });
  return child;
}

let sdk;
function execFileSyncImpl(tool) {
  if (tool !== 'aapt') {
    const error = new Error('unavailable');
    error.code = 'ENOENT';
    throw error;
  }
  return `package: name='${PKG}' versionCode='1' versionName='${VER}'\nsdkVersion:'${sdk[fetched.at(-1)] ?? 30}'\n`;
}

beforeEach(() => {
  jest.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-probe-'));
  outDir = path.join(dir, 'out');
  cacheDir = path.join(dir, 'urls');
  fetched = [];
  probed = [];
  probeMode = 'zip';
  sdk = {};
  downloadWithGoopdl.mockRejectedValue(new Error('Google Play unavailable'));
  global.fetch = jest.fn(fakeFetch);
  errors = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errors.mockRestore();
  delete global.fetch;
  fs.rmSync(dir, { recursive: true, force: true });
});

const logged = () => errors.mock.calls.map((c) => c.join(' ')).join('\n');
const base = (extra = {}) => ({
  cacheDir,
  minSdk: 30,
  spawnImpl,
  execFileSyncImpl,
  sleepImpl: async () => {},
  fetchImpl: fakeFetch,
  sourceResolvers: {
    apkeep: async () => ({ url: SMALL, source: 'apkeep' }),
    apkmirrorApi: async () => { throw new Error('none'); },
    apkmirror: async () => { throw new Error('none'); },
  },
  ...extra,
});

describe('resolveApkeepVariant', () => {
  test('picks the variant that holds the arm64 split, not the smallest', async () => {
    expect(await resolveApkeepVariant(PKG, VER)).toBe(MID);
    expect(probed).toHaveLength(3);
    expect(logged()).toContain('[apkpure-variants] 1 of 3 variants have config.arm64_v8a.apk');
  });

  test('a probe answered with 200 falls back to the smallest', async () => {
    probeMode = 'full';
    expect(await resolveApkeepVariant(PKG, VER)).toBe(SMALL);
  });

  test('a 206 larger than the requested tail is not read', async () => {
    probeMode = 'oversized';
    expect(await resolveApkeepVariant(PKG, VER)).toBe(SMALL);
    expect(logged()).toContain('0 of 3 variants');
  });

  test('a failing probe falls back to the smallest', async () => {
    probeMode = 'throw';
    expect(await resolveApkeepVariant(PKG, VER)).toBe(SMALL);
  });

  test('a single candidate is not probed', async () => {
    global.fetch = jest.fn(async (url, init) => (String(url).includes('api.pureapk.com')
      ? { ok: true, status: 200, text: async () => MID }
      : fakeFetch(url, init)));
    expect(await resolveApkeepVariant(PKG, VER)).toBe(MID);
    expect(probed).toHaveLength(0);
  });
});

describe('other variants after a rejected one', () => {
  test('the variant with the arm64 split is downloaded first, and only it', async () => {
    sdk[SMALL] = 28;
    const result = await download(PKG, VER, outDir, base());
    expect(result.success).toBe(true);
    expect(fetched).toEqual([SMALL, MID]);
  });

  test('when probing fails the order stays smallest first', async () => {
    probeMode = 'full';
    sdk[SMALL] = 28;
    sdk[MID] = 28;
    const result = await download(PKG, VER, outDir, base());
    expect(result.success).toBe(true);
    expect(fetched).toEqual([SMALL, MID, BIG]);
  });
});

