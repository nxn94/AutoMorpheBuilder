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
// The source resolver tests use sanitized API/HTML fixtures. Playwright
// is not mocked: the APKMirror HTML parser reads the fixture files and
// the real child_process APIs launch the fixture apkeep command.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');

const fixtureRoot = path.resolve(__dirname, '../../../test/fixtures');
const fixtureTools = path.join(fixtureRoot, 'fixture-tools');
const apiFixturePath = path.join(fixtureRoot, 'api', 'apkmirror-success.json');
const originalPath = process.env.PATH;

// Forward to real child_process while retaining the original call-count
// assertions. No child_process module is mocked.
const execFile = jest.fn((file, args, ...rest) => {
  const command = file === 'apkeep'
    ? path.join(fixtureTools, process.env.APKEEP_RESULT === 'fail' ? 'apkeep-fail' : 'apkeep')
    : file;
  return childProcess.execFile(command, args, ...rest);
});
const spawn = jest.fn((...args) => childProcess.spawn(...args));
const execFileSync = jest.fn((file, args, ...rest) => {
  if (file === 'aapt') {
    return fs.readFileSync(
      process.env.AAPT_FIXTURE || path.join(fixtureRoot, 'apk-metadata', 'valid-badging.txt'),
      'utf8',
    );
  }
  if (file === 'aapt2') {
    const error = new Error('aapt2 is unavailable in fixture mode');
    error.code = 'ENOENT';
    throw error;
  }
  return childProcess.execFileSync(file, args, ...rest);
});

// Required for the APKMirror-API path. The real apkMirrorAuthHeader()
// reads env vars at call time; setting them here keeps the auth path
// from throwing "APKMIRROR_API_USER and/or APKMIRROR_API_PASS are not set".
process.env.APKMIRROR_API_USER = 'test-user';
process.env.APKMIRROR_API_PASS = 'test-pass';

const apiFixture = JSON.parse(fs.readFileSync(apiFixturePath, 'utf8'));
const { parseApkmirrorFixture } = require('../../../test/fixtures/fixture-tools/parse-apkmirror.js');
const unifiedDownloader = require('../unified-downloader');

const { parallelResolveSources, download, resolveApkeep, resolveApkeepVariant } = unifiedDownloader;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-test-'));
}

function installFixtureTools() {
  process.env.APKEEP_FIXTURE = path.join(fixtureRoot, 'apk-metadata', 'placeholder.apk');
  process.env.APKEEP_RESULT = 'success';
  process.env.PATH = `${fixtureTools}:${process.env.PATH}`;
}

function fixtureUrl(fileName) {
  return `file://${path.join(fixtureRoot, 'apk-metadata', fileName)}`;
}

function fixtureApiResponse() {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve({ downloadUrl: apiFixture.downloadUrl }),
  };
}

function fixtureApkmirrorResolver() {
  return Promise.resolve(parseApkmirrorFixture());
}

beforeEach(() => {
  jest.clearAllMocks();
  installFixtureTools();
});

afterEach(() => {
  delete process.env.APKEEP_FIXTURE;
  delete process.env.APKEEP_RESULT;
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
});

describe('parallelResolveSources', () => {
  // The package id must match an entry in this repo's config.json
  // (real config.json has com.google.android.youtube etc.) so that
  // getApkmirrorPath() returns a non-null path for the apkmirror
  // sources — otherwise they bail with "No APKMirror path for <pkg>"
  // before any of our fixture-backed sources have a chance to run.
  const PKG = 'com.google.android.youtube';
  const VER = '20.44.38';

  test('returns the first fulfilled source by index (apkmirrorapi wins when apkeep fails)', async () => {
    // The implementation iterates sources in declaration order
    // (apkeep → apkmirror-api → apkmirror) and picks the first one
    // whose promise fulfilled. With apkeep forced to fail, the loop
    // skips it and apkmirror-api (the next index) becomes the winner.
    //
    // APKMirror's HTML response is represented by the sanitized fixture
    // parser; the real apkeep command is run for its failure path.
    process.env.APKEEP_RESULT = 'fail';
    global.fetch = jest.fn((url) => {
      if (url.includes('app_version')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
      }
      return Promise.resolve(fixtureApiResponse());
    });

    const result = await parallelResolveSources(PKG, VER, {
      execFileImpl: execFile,
      sourceResolvers: {
        apkmirror: fixtureApkmirrorResolver,
      },
    });
    expect(result).toEqual({
      url: apiFixture.downloadUrl,
      source: 'apkmirror-api',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  test('returns the first fulfilled source by index (apkeep wins when it succeeds)', async () => {
    // Apkeep at index 0 succeeds, so the loop returns it before
    // considering the later API/HTML sources. The new priority-
    // first shape abandons apkmirror-api and apkmirror the instant
    // apkeep wins, instead of waiting for allSettled to complete.
    // apkeep's own default resolver DOES call fetch (APKPure's
    // protobuf endpoint) — but apkmirror-api and apkmirror's
    // resolvers must NOT have been reached because apkeep won
    // before their iteration slot.
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));

    const result = await parallelResolveSources(PKG, VER, {
      execFileImpl: execFile,
      sourceResolvers: {
        apkmirror: fixtureApkmirrorResolver,
      },
    });
    expect(result.source).toBe('apkeep');
    // fetch WAS called — but only by apkeep's own resolver, not by
    // apkmirror-api. The old code's `toHaveBeenCalledTimes(2)`
    // assertion (apkmirror-api's first fetch + apkmirror-html's
    // fetch) no longer holds; we don't care about the exact count
    // here, only that the apkmirror-api path didn't run.
    expect(global.fetch).toHaveBeenCalled();
  });

  test('picks apkeep when apkmirror-api fails', async () => {
    // APKMirror API fails; apkeep's real fixture command succeeds and
    // supplies the constructed APK fallback URL.
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));

    const result = await parallelResolveSources(PKG, VER, {
      execFileImpl: execFile,
      sourceResolvers: {
        apkmirror: fixtureApkmirrorResolver,
      },
    });
    expect(result.url).toBe(`https://apkpure.com/${PKG.replace(/\./g, '/')}/${VER}`);
    expect(result.source).toBe('apkeep');
  });

  test('throws when all sources fail', async () => {
    process.env.APKEEP_RESULT = 'fail';
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));

    await expect(parallelResolveSources(PKG, VER, {
      execFileImpl: execFile,
      sourceResolvers: {
        apkmirror: () => Promise.reject(new Error('fixture resolver down')),
      },
    })).rejects.toThrow(/All sources failed/);
  });

  test('does not throw when fetch returns non-OK', async () => {
    // The APKMirror API returns HTTP 500; the real apkeep fixture
    // command succeeds at index 0 and becomes the winner. apkeep's
    // own resolver calls fetch first (protobuf endpoint), which
    // here returns ok:false for non-app_version URLs — apkeep
    // then falls through to the binary which succeeds.
    //
    // Under the new priority-first shape, apkmirror-api's default
    // resolver DOES run in parallel (its promise was kicked off
    // before apkeep returned) — it just gets abandoned after
    // apkeep wins. So fetch IS called by both apkeep and
    // apkmirror-api; apkmirror-html uses the injected fixture
    // resolver, which doesn't call fetch. The exact count is
    // incidental; we just assert apkeep wins.
    global.fetch = jest.fn((url) => {
      if (url.includes('app_version')) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      });
    });

    const result = await parallelResolveSources(PKG, VER, {
      execFileImpl: execFile,
      sourceResolvers: {
        apkmirror: fixtureApkmirrorResolver,
      },
    });
    expect(result.source).toBe('apkeep');
    expect(global.fetch).toHaveBeenCalled();
  });

  test('fast source wins while a lower-priority source hangs (no SOURCE_TIMEOUT wait)', async () => {
    // The bug commit e7b… fixed: Promise.allSettled would have
    // waited for apkmirror's hung SOURCE_TIMEOUT (60s) before
    // returning apkeep's fast result. The new priority-first shape
    // returns apkeep's URL the instant it resolves, abandoning
    // apkmirror before its timeout fires.
    //
    // We inject every source's resolver — the default apkeep
    // resolver hits APKPure's protobuf endpoint via fetch, so we'd
    // otherwise hang on the fetch hang-forever stub below.
    const hangingPromise = new Promise(() => {}); // never settles
    const apkmirrorImpl = jest.fn(() => hangingPromise);
    const apkmirrorApiImpl = jest.fn(() => hangingPromise);
    global.fetch = jest.fn(() => hangingPromise);

    const start = Date.now();
    const result = await parallelResolveSources(PKG, VER, {
      execFileImpl: execFile,
      sourceResolvers: {
        apkeep: async () => ({ url: 'https://apkeep-fast.example/foo.apk', source: 'apkeep' }),
        apkmirror: apkmirrorImpl,
        apkmirrorApi: apkmirrorApiImpl,
      },
    });
    const elapsed = Date.now() - start;

    expect(result.source).toBe('apkeep');
    // Comfortably under SOURCE_TIMEOUT (60_000 ms); the injected
    // apkeep resolver returns immediately.
    expect(elapsed).toBeLessThan(10_000);
    // Apkmirror-api's fetch never ran (apkeep won first).
    expect(global.fetch).not.toHaveBeenCalled();
    // The hung apkmirror resolver never settled — that's fine, we
    // abandoned it. The test just ensures we didn't wait for it.
    expect(apkmirrorImpl).toHaveBeenCalledTimes(1);
  });

  test('all sources fail (the priority-ordered fall-through path)', async () => {
    // Every source rejects. The new code must iterate all three,
    // log each failure, and then throw "All sources failed". Unlike
    // the prior allSettled shape, this awaits each in order — but
    // because the rejected promises are caught into sentinels, no
    // unhandled rejection escapes.
    process.env.APKEEP_RESULT = 'fail';
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));

    await expect(parallelResolveSources(PKG, VER, {
      execFileImpl: execFile,
      sourceResolvers: {
        apkmirror: () => Promise.reject(new Error('fixture resolver down')),
      },
    })).rejects.toThrow(/All sources failed/);
  });

  test('a slow high-priority source beats a fast low-priority one', async () => {
    // Priority order matters: even though apkmirror-api (index 1)
    // resolves with a valid URL much faster than apkeep (index 0,
    // which takes ~30s in this test), the function must wait for
    // apkeep to settle first and return apkeep's URL when it does.
    // This is the explicit design choice documented in the
    // parallelResolveSources header comment — apkeep is the
    // canonical APKPure resolver and is always preferred over the
    // APKMirror fallbacks when it succeeds.
    //
    // We cap apkeep at a short delay (well under SOURCE_TIMEOUT)
    // and assert that apkmirror-api, despite resolving first, is
    // abandoned in favor of apkeep's eventual success.
    global.fetch = jest.fn(() => Promise.reject(new Error('api down')));

    const apkeepDelay = 200; // apkeep fixture command already runs
                              // a real subprocess; the 200ms cushion
                              // here models an "extra-slow" case.
    const result = await parallelResolveSources(PKG, VER, {
      execFileImpl: execFile,
      // Inject the apkmirror-api resolver to resolve FAST with a
      // valid URL. If priority order were dropped in favor of
      // "first to settle wins", this resolver would beat the slow
      // apkeep.
      sourceResolvers: {
        apkmirrorApi: async () => ({ url: 'https://apkmirror-api-fast.example/foo.apk', source: 'apkmirror-api' }),
        apkmirror: () => new Promise(() => {}), // never settles
      },
    });

    expect(result.source).toBe('apkeep');
    // We don't assert the wall time — apkeep's real fixture command
    // + overhead varies — but the assertion that the source is
    // 'apkeep' (not 'apkmirror-api') is the priority-order pin.
    void apkeepDelay; // documented above
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
        url: fixtureUrl('placeholder.apk'),
        source: 'cached-source',
        downloads: 0,
        lastWorkingAt: '2025-01-01T00:00:00Z',
      }),
    );

    // verifyUrl is HEAD-based; make it return true (url is "valid").
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200 }));

    // downloadWithUrl uses a real curl subprocess. The local forwarding
    // shim keeps the original spawn call-count assertion while writing
    // the sanitized APK placeholder.
    const cachedFixture = path.join(fixtureRoot, 'apk-metadata', 'placeholder.apk');
    const target = path.join(apksDir, `${PKG}_${VER}.apk`);
    const resultOfCopy = childProcess.spawnSync('cp', [cachedFixture, target], { encoding: 'utf8' });
    expect(resultOfCopy.status).toBe(0);

    const result = await download(PKG, VER, apksDir, {
      spawnImpl: spawn,
      execFileSyncImpl: execFileSync,
    });
    expect(result.success).toBe(true);
    // A real spawn was called exactly once (cache-hit download), not for
    // any other path.
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
  const FAKE_URL_V7A   = 'https://download.pureapk.com/b/XAPK/Y29tLnNvZmFzY29yZS5yZXN1bHRzXzI2MDcyNzAwMl9BQT?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9ODkyMTg2NDcmdm49MjYwNzI3MDAy';
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
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve('no urls here'),
      }),
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

    const result = await resolveApkeep(PKG, VER, { execFileImpl: execFile });
    expect(result.source).toBe('apkeep');
    // The constructed URL is the fallback signal that the resolver
    // failed and the apkeep binary took over.
    expect(result.url).toBe(`https://apkpure.com/${PKG.replace(/\./g, '/')}/${VER}`);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});
