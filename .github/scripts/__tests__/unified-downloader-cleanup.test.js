// .github/scripts/__tests__/unified-downloader-cleanup.test.js
'use strict';

// Cleanup-on-failure contract tests for unified-downloader.js.
//
// Bug being pinned: when one download source fails a post-download
// validation (VERSION MISMATCH or ABI mismatch) it leaves its partial
// file behind in outputDir. The next source in the fallback chain then
// writes its own file into the same directory, and
// `findPackageCandidate`'s first-encountered tiebreak (filesystem-
// dependent readdir order, not guaranteed alphabetical on ext4) picks
// the stale file over the working one. Result: the merged APK ships
// with the wrong architecture even though a successful download
// happened.
//
// Fix: each terminal download function must delete the partial file
// when a post-download validation throws, BEFORE the error propagates
// to the caller. These tests pin that contract for downloadWithUrl
// (VERSION MISMATCH + ABI mismatch), downloadWithApkeep (VERSION
// MISMATCH + ABI mismatch), plus a positive control that the success
// path still preserves the file.
//
// Mocking strategy mirrors fallback-chain.test.js: child_process
// (execFile / spawn / execFileSync) and playwright are stubbed at the
// module level. apk-abi-validator is jest.mock()'d so the
// destructured reference inside the downloader resolves to the same
// jest.fn() instance we configure per-test (a jest.spyOn at the
// test level wouldn't reach the captured reference — see the
// jest.mock block below).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// --- Module-level mocks. Must be in place before the downloader is
//     require()'d. Mirrors fallback-chain.test.js. ----------------------------

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFile: jest.fn(),
    // execFileSync is used by apkmirrorFetch for curl subprocess
    // probes. Make it throw with "403" so resolveApkmirror's fallback
    // to Playwright triggers (Playwright is also mocked below to
    // reject). Without this, any code path that inadvertently touches
    // resolveApkmirror will hit the real network.
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

// Mock the apk-abi-validator module BEFORE the downloader is
// required. The downloader destructures `validateDownloadedApkAbi`
// at require time, so a jest.spyOn() at the test level wouldn't
// reach the captured reference — we have to mock the source module
// up-front so both the test and the downloader see the same
// jest.fn() instance.
jest.mock('../apk-abi-validator', () => {
  const actual = jest.requireActual('../apk-abi-validator');
  return {
    ...actual,
    validateDownloadedApkAbi: jest.fn(actual.validateDownloadedApkAbi),
  };
});

process.env.APKMIRROR_API_USER = 'test-user';
process.env.APKMIRROR_API_PASS = 'test-pass';

const { execFile, execFileSync, spawn } = require('child_process');
const { validateDownloadedApkAbi } = require('../apk-abi-validator');
const { downloadWithUrl, downloadWithApkeep } = require('../unified-downloader');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
}

// Convenience: spawn that writes a fake APK to the same path curl
// would have used, then closes cleanly. Mirrors the established
// pattern in fallback-chain.test.js:209-219.
function makeFakeCurlSpawn(apksDir, pkg, ver) {
  return () => {
    const fakeApk = path.join(apksDir, `${pkg}_${ver}.apk`);
    fs.writeFileSync(fakeApk, Buffer.alloc(20 * 1024, 0x41)); // 20KB of 'A'
    return {
      stderr: { on: jest.fn() },
      on: (event, cb) => {
        if (event === 'close') setImmediate(() => cb(0));
      },
    };
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('downloadWithUrl — cleanup-on-failure contract', () => {
  const PKG = 'com.google.android.youtube';
  const VER = '20.44.38';
  let apksDir;

  beforeEach(() => {
    apksDir = tmpDir();
  });
  afterEach(() => {
    try { fs.rmSync(apksDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('deletes the partial APK when VERSION MISMATCH is detected', async () => {
    // The curl mock writes a fake APK and "succeeds" with code 0,
    // simulating a completed download. Then validateApkVersion (via
    // execFileSync) returns a wrong version, triggering VERSION MISMATCH.
    spawn.mockImplementation(makeFakeCurlSpawn(apksDir, PKG, VER));
    execFileSync.mockImplementation(() => `package: name='${PKG}' versionName='99.99.99'\n`);

    const expectedPath = path.join(apksDir, `${PKG}_${VER}.apk`);

    await expect(downloadWithUrl('https://example.invalid/x.apk', apksDir, PKG, VER))
      .rejects.toThrow(/VERSION MISMATCH/);

    // The contract: spawn ran (curl wrote the file) AND the file is
    // gone after the rejection (cleanup ran before throw). Checking
    // both conditions prevents a vacuous pass where spawn never
    // wrote anything.
    expect(spawn).toHaveBeenCalled();
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  // ABI errors trigger the retry path in downloadWithUrl (3 attempts
  // with 0+2+4s backoff = ~6s wallclock). Use fake timers to skip
  // the sleep waits so the test runs in milliseconds, not seconds.
  test('deletes the partial APK when ABI validation throws', async () => {
    jest.useFakeTimers();

    // Same setup as VERSION MISMATCH, but version validation passes
    // and the failure comes from validateDownloadedApkAbi. We
    // configure the mocked validateDownloadedApkAbi (jest.fn()
    // installed at the module level — see the jest.mock block at
    // the top of this file) to throw, simulating the upstream
    // mislabelled-ABI case.
    //
    // spawn strategy: succeed cleanly on every call (so ABI
    // validation runs and throws — that's the branch we're
    // testing). The retry path then takes over and the cleanup
    // contract is exercised on every attempt. Fake timers handle
    // the backoff sleeps.
    spawn.mockImplementation(makeFakeCurlSpawn(apksDir, PKG, VER));
    execFileSync.mockImplementation(() => `package: name='${PKG}' versionName='${VER}'\n`);

    validateDownloadedApkAbi.mockImplementation(() => {
      throw new Error('Downloaded APK is missing lib/arm64-v8a/*.so (forced for test)');
    });

    const expectedPath = path.join(apksDir, `${PKG}_${VER}.apk`);

    // Start the download but don't await yet — fake timers must be
    // advanced manually so the retry sleeps don't hang.
    const downloadPromise = downloadWithUrl('https://example.invalid/x.apk', apksDir, PKG, VER)
      .catch((e) => e); // capture the rejection instead of letting jest see it as unhandled

    // Run pending microtasks + timer callbacks. Each retry waits
    // 2s then 4s; advance enough to cover both, then a little more
    // for the final throw to surface.
    for (let i = 0; i < 20; i += 1) {
      await jest.advanceTimersByTimeAsync(1000);
    }

    // downloadPromise was started above; pull its settled value now.
    const result = await downloadPromise;
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/missing.*lib\/arm64-v8a|curl failed/);

    jest.useRealTimers();

    // Cleanup contract verified: the partial APK that was written
    // on every retry attempt is gone.
    expect(spawn).toHaveBeenCalled();
    expect(validateDownloadedApkAbi).toHaveBeenCalled();
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  test('preserves the file on the success path (regression guard)', async () => {
    // The cleanup-on-failure contract must NOT touch the file when
    // every validation passes. Pin the success path so a future
    // refactor doesn't accidentally delete the working APK.
    spawn.mockImplementation(makeFakeCurlSpawn(apksDir, PKG, VER));
    execFileSync.mockImplementation(() => `package: name='${PKG}' versionName='${VER}'\n`);

    // ABI validation passes (no throw).
    validateDownloadedApkAbi.mockImplementation(() => { /* no throw — pretend the arch is fine */ });

    const result = await downloadWithUrl('https://example.invalid/x.apk', apksDir, PKG, VER);
    expect(result.success).toBe(true);
    expect(result.path).toBe(path.join(apksDir, `${PKG}_${VER}.apk`));
    // File is preserved — this is the negative of the cleanup tests.
    expect(fs.existsSync(result.path)).toBe(true);
  });
});

describe('downloadWithApkeep — cleanup-on-failure contract', () => {
  const PKG = 'com.google.android.youtube';
  const VER = '20.44.38';
  let apksDir;

  beforeEach(() => {
    apksDir = tmpDir();
  });
  afterEach(() => {
    try { fs.rmSync(apksDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('deletes the partial .xapk when VERSION MISMATCH is detected', async () => {
    // downloadWithApkeep clears outputDir before invoking apkeep, so
    // any pre-staged file is wiped. We mock the apkeep subprocess
    // (execFile, which runCommand delegates to) to create a fake
    // .xapk as a side effect of "succeeding", matching the real
    // apkeep behavior of writing the download to outputDir.
    //
    // runCommand uses execFile with the *promise* signature (no
    // callback) and listens for 'close' / 'error' events on the
    // returned ChildProcess. Our mock returns a ChildProcess-shaped
    // EventEmitter, writes a fake .xapk to outputDir synchronously,
    // and emits 'close' with code 0 on the next tick so runCommand
    // resolves successfully.
    const { EventEmitter } = require('node:events');

    execFile.mockImplementation(() => {
      const fakeXapk = path.join(apksDir, `${PKG}@${VER}.xapk`);
      fs.writeFileSync(fakeXapk, Buffer.alloc(20 * 1024, 0x42)); // 20KB of 'B'
      const cp = new EventEmitter();
      cp.stdout = new EventEmitter();
      cp.stderr = new EventEmitter();
      cp.kill = jest.fn();
      setImmediate(() => cp.emit('close', 0));
      return cp;
    });

    // Version validation fails.
    execFileSync.mockImplementation(() => `package: name='${PKG}' versionName='99.99.99'\n`);

    // ABI validation never reached in this path (VERSION MISMATCH
    // throws first), but a no-throw implementation keeps the test
    // from getting a confusing secondary error if the order ever
    // changes.
    validateDownloadedApkAbi.mockImplementation(() => { /* no throw */ });

    // downloadWithApkeep inspects findApkFile(outputDir) to locate
    // the file apkeep produced. With our side-effect mock writing
    // a .xapk, that lookup returns the .xapk path.
    const expectedPath = path.join(apksDir, `${PKG}@${VER}.xapk`);

    await expect(downloadWithApkeep(PKG, VER, apksDir)).rejects.toThrow(
      /VERSION MISMATCH|APKPure does not have/
    );

    // The contract: execFile ran (apkeep wrote the file) AND the
    // .xapk is gone after the rejection.
    expect(execFile).toHaveBeenCalled();
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  test('deletes the partial .xapk when ABI validation throws', async () => {
    // Mirror of the VERSION MISMATCH test, but with version validation
    // passing and ABI validation throwing — exercises the second
    // cleanup branch in downloadWithApkeep independently.
    const { EventEmitter } = require('node:events');

    execFile.mockImplementation(() => {
      const fakeXapk = path.join(apksDir, `${PKG}@${VER}.xapk`);
      fs.writeFileSync(fakeXapk, Buffer.alloc(20 * 1024, 0x42));
      const cp = new EventEmitter();
      cp.stdout = new EventEmitter();
      cp.stderr = new EventEmitter();
      cp.kill = jest.fn();
      setImmediate(() => cp.emit('close', 0));
      return cp;
    });

    // Version validation passes.
    execFileSync.mockImplementation(() => `package: name='${PKG}' versionName='${VER}'\n`);

    // ABI validation throws — the actual Reddit failure mode that
    // prompted the cleanup contract.
    validateDownloadedApkAbi.mockImplementation(() => {
      throw new Error('Downloaded APK is missing lib/arm64-v8a/*.so (forced for test)');
    });

    const expectedPath = path.join(apksDir, `${PKG}@${VER}.xapk`);

    await expect(downloadWithApkeep(PKG, VER, apksDir)).rejects.toThrow(
      /missing.*lib\/arm64-v8a|APKPure does not have/
    );

    expect(execFile).toHaveBeenCalled();
    expect(validateDownloadedApkAbi).toHaveBeenCalled();
    expect(fs.existsSync(expectedPath)).toBe(false);
  });
});