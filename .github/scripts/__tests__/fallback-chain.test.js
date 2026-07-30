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

const { parallelResolveSources, download } = unifiedDownloader;

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
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('returns the first fulfilled source by index (apkeep wins when it succeeds)', async () => {
    // apkeep at index 0 succeeds (immediately), so the loop returns it
    // before considering apkmirror-api or apkmirror at later indices.
    // apkmirror-api is mocked to fail; apkmirror is rejected.
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));
    execFile.mockImplementation((cmd, _args, _opts, cb) => {
      cb(null, '', '');
    });

    const result = await parallelResolveSources(PKG, VER);
    expect(result.source).toBe('apkeep');
    // fetch is invoked once for apkmirror-api (which fails). It should
    // not be re-invoked for any other source.
    expect(global.fetch).toHaveBeenCalledTimes(1);
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
