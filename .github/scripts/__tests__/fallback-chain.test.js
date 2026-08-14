// .github/scripts/__tests__/fallback-chain.test.js
'use strict';

// Tests for parallelResolveSources and the high-level download()
// fallback chain. Coverage is intentionally minimal — just the three
// contracts listed in the task:
//
//   1. cache hit short-circuits the rest
//   2. all sources failing throws
//   3. parallel resolution picks the first fulfilled promise
//
// We mock at the dependency boundary (child_process execFile + global
// fetch + playwright chromium) rather than mocking the unit's internal
// helpers, so the tests exercise the real wiring.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// --- Module-level mocks. These need to be in place before the
//     downloader is require()'d, hence hoisted via jest.mock factories.

// Mock child_process. The downloader uses `require("child_process")`
// (no `node:` prefix); we mock the same path so its `execFile` etc.
// resolve to our jest.fn() shims. We also `jest.mock('node:child_process')`
// for symmetry, since test code uses the `node:` form when capturing
// handles — both names are the same module internally, but Jest's
// mock registry keys on the require string, so we register both.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFile: jest.fn(),
    // execFileSync is used by apkmirrorFetch (curl subprocess for the
    // APKMirror-scraper release/variant/download pages). Make it throw
    // an error containing "403" so resolveApkmirror's
    // `if (e.message.includes('403'))` triggers the Playwright
    // fallback — which the playwright mock then rejects.
    execFileSync: jest.fn(() => {
      const err = new Error('HTTP 403 — Cloudflare block (mocked)');
      throw err;
    }),
    spawn: jest.fn(),
  };
});
jest.mock('node:child_process', () => jest.requireMock('child_process'));

jest.mock('playwright', () => ({
  chromium: {
    launch: jest.fn(() => Promise.reject(new Error('mocked: no browser in tests'))),
  },
}));

// Required for the APKMirror-API path. The real apkMirrorAuthHeader()
// reads env vars at call time; setting them here keeps the auth path
// from throwing "APKMIRROR_API_USER and/or APKMIRROR_API_PASS are not set".
process.env.APKMIRROR_API_USER = 'test-user';
process.env.APKMIRROR_API_PASS = 'test-pass';

const { execFile } = require('child_process');

const unifiedDownloader = require('../unified-downloader');

const { parallelResolveSources, download, resolveApkeep, resolveApkeepVariant } = unifiedDownloader;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-test-'));
}

describe('parallelResolveSources', () => {
  // The package id must match an entry in this repo's config.json
  // (real config.json has com.google.android.youtube etc.) so that
  // getApkmirrorPath() returns a non-null path for the apkmirror
  // sources — otherwise they bail with "No APKMirror path for <pkg>"
  // before any of our mocks have a chance to run.
  const PKG = 'com.google.android.youtube';
  const VER = '20.44.38';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the first fulfilled source by index (apkmirror-api wins when apkeep fails)', async () => {
    // The implementation iterates sources in declaration order
    // (apkeep → apkmirror-api → apkmirror) and picks the first one
    // whose promise fulfilled. With apkeep forced to fail, the loop
    // skips it and apkmirror-api (the next index) becomes the winner.
    //
    // apkmirror-api (fetch) → success.
    // apkeep (execFile) → always fails (forces the loop past index 0).
    // apkmirror (chromium) → already mocked to reject fast.
    //
    // fetch is called three times by parallelResolveSources:
    //   1. resolveApkeepVariant (the custom APKPure protobuf resolver
    //      inside the apkeep path).
    //   2. resolveApkmirrorApi (the API path).
    //   3. resolveApkmirrorReleaseSlug (the apkmirror curl path resolves
    //      its real release-page slug from /all-versions/ before
    //      scraping the variant table).
    // Promise.allSettled does not cancel in-flight promises, so all three
    // have been kicked off by the time the loop picks apkmirror-api.
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ downloadUrl: 'https://api.example/x.apk' }),
      }),
    );
    execFile.mockImplementation((cmd, _args, _opts, cb) => {
      cb(new Error('apkeep down (mocked)'), '', '');
    });

    const result = await parallelResolveSources(PKG, VER);
    expect(result).toEqual({
      url: 'https://api.example/x.apk',
      source: 'apkmirror-api',
    });
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('returns the first fulfilled source by index (apkeep wins when it succeeds)', async () => {
    // apkeep at index 0 succeeds (immediately), so the loop returns it
    // before considering apkmirror-api or apkmirror at later indices.
    // apkmirror-api is mocked to fail; apkmirror is rejected.
    //
    // fetch is called three times: once by resolveApkeepVariant
    // (custom APKPure resolver), once by resolveApkmirrorApi (fails),
    // and once by resolveApkmirrorReleaseSlug (the apkmirror curl
    // path resolves its real release-page slug). The loop wins on apkeep
    // before those fetches resolve, but Promise.allSettled has already
    // started their promises by then.
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));
    execFile.mockImplementation((cmd, _args, _opts, cb) => {
      cb(null, '', '');
    });

    const result = await parallelResolveSources(PKG, VER);
    expect(result.source).toBe('apkeep');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('picks apkeep when apkmirror-api fails', async () => {
    // apkmirror-api → fetch fails.
    // apkeep → execFile succeeds with empty stdout (the apkeep path
    //   doesn't return a URL via stdout — it just signals success).
    // apkmirror → chromium rejects.
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));
    execFile.mockImplementation((cmd, _args, _opts, cb) => {
      cb(null, '', '');
    });

    const result = await parallelResolveSources(PKG, VER);
    expect(result.url).toBe(`https://apkpure.com/${PKG.replace(/\./g, '/')}/${VER}`);
    expect(result.source).toBe('apkeep');
  });

  test('throws when all sources fail', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));
    execFile.mockImplementation((cmd, _args, _opts, cb) => {
      cb(new Error('apkeep down'), '', 'mock stderr');
    });
    // chromium already mocked to reject at the module level.

    await expect(parallelResolveSources(PKG, VER))
      .rejects.toThrow(/All sources failed/);
  });

  test('does not throw when fetch returns non-OK', async () => {
    // apkmirror-api returns HTTP 500 — that source counts as failed.
    // apkeep succeeds as the winner.
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      }),
    );
    execFile.mockImplementation((cmd, _args, _opts, cb) => cb(null, '', ''));

    const result = await parallelResolveSources(PKG, VER);
    expect(result.source).toBe('apkeep');
  });
});

describe('download() fallback chain', () => {
  const PKG = 'com.google.android.youtube';
  const VER = '20.44.38';
  let apksDir;
  let homeDir;

  beforeEach(() => {
    jest.clearAllMocks();
    apksDir = tmpDir();
    homeDir = tmpDir();
    process.env.HOME = homeDir;
    delete global.fetch;
  });
  afterEach(() => {
    try { fs.rmSync(apksDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('cache hit short-circuits the rest', async () => {
    // Seed the URL cache so getCachedUrl returns a hit.
    const cacheDir = path.join(os.homedir(), '.cache', 'auto-morphe-builder', 'urls', PKG);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, `${VER}.json`),
      JSON.stringify({
        url: 'https://cached.example/x.apk',
        source: 'cached-source',
        downloads: 0,
        lastWorkingAt: '2025-01-01T00:00:00Z',
      }),
    );

    // verifyUrl is HEAD-based; make it return true (url is "valid").
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200 }));

    // downloadWithUrl spawns curl. Make spawn write a fake apk file
    // (size > 10KB — the size floor in downloadWithUrl) and immediately
    // close cleanly so the rest of the path is exercised.
    const { spawn } = require('child_process');
    spawn.mockImplementation(() => {
      const fakeApk = path.join(apksDir, `${PKG}_${VER}.apk`);
      fs.writeFileSync(fakeApk, Buffer.alloc(20 * 1024, 0x41)); // 20KB of 'A'
      return {
        stderr: { on: jest.fn() },
        on: (event, cb) => {
          if (event === 'close') setImmediate(() => cb(0));
        },
      };
    });

    // downloadWithUrl calls validateApkVersion after curl "succeeds".
    // The validator shells out to `aapt dump badging` and parses
    // versionName out of the output. Mock execFileSync (the validator
    // uses execFileSync) to return our version. Also covers the
    // "No APK could be downloaded" path's aapt validation, so this
    // test covers the cache-hit short-circuit even when aapt is
    // missing from the test runner.
    const { execFileSync } = require('child_process');
    execFileSync.mockImplementation(() => `package: name='${PKG}' versionName='${VER}'\n`);

    const result = await download(PKG, VER, apksDir);
    expect(result.success).toBe(true);
    // spawn should be called exactly once (cache-hit download), not
    // for any other path.
    expect(spawn).toHaveBeenCalledTimes(1);
    // apkeep / apkmirror-api / parallel resolve must NOT have been tried.
    expect(execFile).not.toHaveBeenCalled();
    // fetch was used for verifyUrl HEAD only (one call); the parallel
    // resolve's apkmirror-api fetch must NOT have been triggered.
    expect(global.fetch.mock.calls.length).toBe(1);
  });
});

describe('resolveApkeepVariant (arm64-v8a pick)', () => {
  // The custom resolver hits APKPure's protobuf endpoint and parses
  // every XAPK URL for the requested version. Three variants per
  // version are returned: universal (largest), armeabi-v7a (middle),
  // arm64-v8a (smallest). The resolver picks the smallest — that's
  // the arm64-v8a split, which is what the user wants so the
  // post-merge ABI guardrail in download-supported-apk.js passes.
  const PKG = 'com.sofascore.results';
  const VER = '26.07.27';

  // Build a fake APKPure protobuf response. APKPure's URL structure
  // nests the version inside the `c` query param as base64-encoded
  // URL-encoded params. Each URL here shares the same outer shell but
  // has a different `c` value encoding the variant's size.
  // The 3 sizes match what sofascore@26.07.27 actually returns on
  // APKPure's server (verified by greping the real response).
  const FAKE_URL_UNIV = 'https://download.pureapk.com/b/XAPK/Y29tLnNvZmFzY29yZS5yZXN1bHRzXzI2MDcyNzAwMl9BQT?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9OTMwNDQwNjImdm49MjYuMDcuMjcmdmM9MjYwNzI3MDAy';
  const FAKE_URL_ARM64 = 'https://download.pureapk.com/b/XAPK/Y29tLnNvZmFzY29yZS5yZXN1bHRzXzI2MDcyNzAwMl9BQT?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9NTczMDI2NDImdm49MjYuMDcuMjcmdmM9MjYwNzI3MDAy';
  const FAKE_URL_V7A   = 'https://download.pureapk.com/b/XAPK/Y29tLnNvZmFzY29yZS5yZXN1bHRzXzI2MDcyNzAwMl9BQT?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9ODkyMTg2NDcmdm49MjYuMDcuMjcmdmM9MjYwNzI3MDAy';
  // Different version — must be filtered out by the `vn` match.
  const FAKE_URL_OTHER = 'https://download.pureapk.com/b/XAPK/OTHER?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9MTAwMCZ2bj05OS45OS45OSZ2Yz05OTk5OTk5OTk=';

  const FAKE_BODY = [
    'noise before',
    FAKE_URL_UNIV,
    FAKE_URL_ARM64,
    FAKE_URL_V7A,
    FAKE_URL_OTHER,
    'noise after',
  ].join('\n');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the smallest variant URL (arm64-v8a by size ordering)', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(FAKE_BODY),
      }),
    );

    const variantUrl = await resolveApkeepVariant(PKG, VER);

    // The arm64-v8a fixture URL is the smallest of the three (size 57302642).
    // We assert exact equality rather than substring matching because the
    // `s=` and `vn=` markers are base64-encoded inside the `c` query
    // param — they're not visible as plain substrings on the URL.
    expect(variantUrl).toBe(FAKE_URL_ARM64);
  });

  test('hits the APKPure protobuf endpoint with the correct headers', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('') }),
    );

    await resolveApkeepVariant(PKG, VER).catch(() => { /* expected — no URLs */ });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe(`https://api.pureapk.com/m/v3/cms/app_version?hl=en-US&package_name=${PKG}`);
    // The headers must identify us as a real browser; APKPure's edge
    // returns 403/empty for anything missing the x-cv/x-sv/x-gp trio.
    expect(calledInit.headers['x-cv']).toBe('3172501');
    expect(calledInit.headers['x-sv']).toBe('29');
    expect(calledInit.headers['x-gp']).toBe('1');
  });

  test('throws when APKPure returns no XAPK URLs for the requested version', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve('no urls here') }),
    );

    await expect(resolveApkeepVariant(PKG, VER)).rejects.toThrow(/No APKPure XAPK URLs/);
  });

  test('throws when APKPure returns HTTP error', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') }),
    );

    await expect(resolveApkeepVariant(PKG, VER)).rejects.toThrow(/APKPure API returned 500/);
  });

  test('resolveApkeep returns the variant URL on success', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(FAKE_BODY) }),
    );

    const result = await resolveApkeep(PKG, VER);
    expect(result.source).toBe('apkeep');
    expect(result.url).toBe(FAKE_URL_ARM64);
    // The apkeep binary must NOT have been called — the custom resolver
    // succeeded so the fallback path stays dormant. Saves a real
    // apkeep invocation per build.
    expect(execFile).not.toHaveBeenCalled();
  });

  test('resolveApkeep falls back to apkeep binary when resolver fails', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('network down (mocked)')));
    execFile.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, '', '');
    });

    const result = await resolveApkeep(PKG, VER);
    expect(result.source).toBe('apkeep');
    // The constructed URL is the fallback signal that the resolver
    // failed and the apkeep binary took over.
    expect(result.url).toBe(`https://apkpure.com/${PKG.replace(/\./g, '/')}/${VER}`);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
