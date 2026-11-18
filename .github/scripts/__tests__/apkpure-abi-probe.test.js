'use strict';

/* global Response, ReadableStream */

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
let probeMode; // 'zip' | 'full' | 'throw' | 'chunked' | 'wrongRange' | 'short'
let pulled; // bytes a fake server handed over
let errors;

// A body served in 16 KiB chunks, counting what is actually read.
function stream(bytes) {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      const chunk = bytes.subarray(at, at + 16384);
      at += chunk.length;
      pulled += chunk.length;
      controller.enqueue(chunk);
    },
  });
}

// One fake network: the listing, and range probes of the variant files.
async function fakeFetch(url, init = {}) {
  if (new URL(url).hostname === 'api.pureapk.com') return { ok: true, status: 200, text: async () => listing };
  probed.push(url);
  if (probeMode === 'throw') throw new Error('network down');
  expect(init.headers.Range).toBe('bytes=-65558');
  const code = new URL(url).pathname.split('/').pop();
  const zip = zipTail(namesByBuild[code]);
  const { totalSize } = zip;
  // A server sends the full 65558-byte suffix; the zip records are at its end.
  const body = Buffer.concat([Buffer.alloc(65558 - zip.body.length), zip.body]);
  const suffix = `bytes ${totalSize - body.length}-${totalSize - 1}/${totalSize}`;
  // The whole file: the zip tail after 1 MiB of other bytes.
  const whole = Buffer.concat([Buffer.alloc(1_048_576), body]);
  switch (probeMode) {
    case 'full':
      return new Response(stream(whole), { status: 200 });
    case 'chunked':
      // Claims the suffix, sends no Content-Length, then streams far more.
      return new Response(stream(whole), { status: 206, headers: { 'content-range': suffix } });
    case 'wrongRange':
      return new Response(stream(whole), { status: 206, headers: { 'content-range': `bytes 0-${whole.length - 1}/${whole.length}` } });
    case 'short':
      return new Response(stream(body.subarray(0, body.length - 1)), { status: 206, headers: { 'content-range': suffix } });
    default:
      return new Response(stream(body), { status: 206, headers: { 'content-range': suffix } });
  }
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
  pulled = 0;
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

  test('a chunked 206 longer than the requested tail is cut off, not buffered', async () => {
    probeMode = 'chunked';
    expect(await resolveApkeepVariant(PKG, VER)).toBe(SMALL);
    expect(logged()).toContain('0 of 3 variants');
    // Each probe stops within a chunk of the limit (plus the one the stream
    // queues ahead), not at the 1 MiB body.
    expect(pulled).toBeLessThanOrEqual(3 * (65558 + 2 * 16384));
  });

  test('a 206 for a range other than the file tail is not read', async () => {
    probeMode = 'wrongRange';
    expect(await resolveApkeepVariant(PKG, VER)).toBe(SMALL);
    expect(logged()).toContain('0 of 3 variants');
    expect(pulled).toBeLessThanOrEqual(3 * 16384);
  });

  test('a body shorter than its Content-Range is not used', async () => {
    probeMode = 'short';
    expect(await resolveApkeepVariant(PKG, VER)).toBe(SMALL);
    expect(logged()).toContain('0 of 3 variants');
  });

  test('a failing probe falls back to the smallest', async () => {
    probeMode = 'throw';
    expect(await resolveApkeepVariant(PKG, VER)).toBe(SMALL);
  });

  test('a single candidate is not probed', async () => {
    global.fetch = jest.fn(async (url, init) => (new URL(url).hostname === 'api.pureapk.com'
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
