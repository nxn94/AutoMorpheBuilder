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
// Fixture strategy: child_process is no longer mocked at the module
// level. The command shims below forward to the real subprocess APIs;
// aapt/apkeep/curl use sanitized files under test/fixtures.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const childProcess = require('node:child_process');

const fixtureRoot = path.resolve(__dirname, '../../../test/fixtures');
const fixtureTools = path.join(fixtureRoot, 'fixture-tools');
const placeholderFixture = path.join(fixtureRoot, 'apk-metadata', 'placeholder.apk');
const splitFixture = path.join(fixtureRoot, 'apk-metadata', 'split-package.apk');
const validBadgingFixture = path.join(fixtureRoot, 'apk-metadata', 'valid-badging.txt');
const mismatchBadgingFixture = path.join(fixtureRoot, 'apk-metadata', 'mismatch-badging.txt');
const originalPath = process.env.PATH;

// Forwarding shims preserve call-count assertions while exercising real
// child_process operations. They are deliberately local rather than
// module-level shims so no subprocess contract is hidden.
const spawn = jest.fn((...args) => childProcess.spawn(...args));
const execFile = jest.fn((file, args, ...rest) => {
  const command = file === 'apkeep' ? path.join(fixtureTools, 'apkeep') : file;
  if (file === 'apkeep' && !process.env.APKEEP_FIXTURE) {
    process.env.APKEEP_FIXTURE = placeholderFixture;
  }
  return childProcess.execFile(command, args, ...rest);
});
const execFileSync = jest.fn((file, args, ...rest) => {
  if (file === 'aapt') {
    return fs.readFileSync(process.env.AAPT_FIXTURE || validBadgingFixture, 'utf8');
  }
  if (file === 'aapt2') {
    const error = new Error('aapt2 is unavailable in fixture mode');
    error.code = 'ENOENT';
    throw error;
  }
  return childProcess.execFileSync(file, args, ...rest);
});

// Mock apk-abi-validator only: its function is the isolation seam these
// tests need to force an ABI failure while retaining the downloader's
// real cleanup flow.
jest.mock('../apk-abi-validator', () => {
  const actual = jest.requireActual('../apk-abi-validator');
  return {
    ...actual,
    validateDownloadedApkAbi: jest.fn(actual.validateDownloadedApkAbi),
  };
});

process.env.APKMIRROR_API_USER = 'test-user';
process.env.APKMIRROR_API_PASS = 'test-pass';

const { validateDownloadedApkAbi } = require('../apk-abi-validator');
const { downloadWithUrl, downloadWithApkeep } = require('../unified-downloader');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-test-'));
}

function fixtureUrl(filePath) {
  return `file://${filePath}`;
}

function installFixtureTools() {
  process.env.AAPT_FIXTURE = validBadgingFixture;
  process.env.APKEEP_FIXTURE = placeholderFixture;
  process.env.PATH = `${fixtureTools}:${process.env.PATH}`;
}

function copyFixtureTo(source, target) {
  const result = childProcess.spawnSync('cp', [source, target], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Could not seed fixture ${source}: ${result.stderr}`);
  }
}

function downloadOptions() {
  return {
    spawnImpl: spawn,
    execFileImpl: execFile,
    execFileSyncImpl: execFileSync,
    sleepImpl: async () => {},
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  installFixtureTools();
});

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.AAPT_FIXTURE;
  delete process.env.APKEEP_FIXTURE;
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
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
    process.env.AAPT_FIXTURE = mismatchBadgingFixture;
    const expectedPath = path.join(apksDir, `${PKG}_${VER}.apk`);
    // Seed the output with a real fixture, then let curl replace it.
    copyFixtureTo(placeholderFixture, expectedPath);

    await expect(
      downloadWithUrl(
        fixtureUrl(placeholderFixture),
        apksDir,
        PKG,
        VER,
        downloadOptions(),
      ),
    ).rejects.toThrow(/VERSION MISMATCH/);

    // The contract: a real curl process ran and its partial file was
    // removed after the rejection (cleanup ran before throw).
    expect(spawn).toHaveBeenCalled();
    expect(fs.existsSync(expectedPath)).toBe(false);
  });

  // ABI errors trigger the retry path in downloadWithUrl (3 attempts
  // with 0+2+4s backoff). The fixture dependency skips only the backoff
  // sleeps so the retry/cleanup contract runs quickly.
  test('deletes the partial APK when ABI validation throws', async () => {
    // Same setup as VERSION MISMATCH, but version validation passes
    // and the failure comes from validateDownloadedApkAbi.
    const expectedPath = path.join(apksDir, `${PKG}_${VER}.apk`);
    copyFixtureTo(placeholderFixture, expectedPath);
    validateDownloadedApkAbi.mockImplementation(() => {
      throw new Error('Downloaded APK is missing lib/arm64-v8a/*.so (forced for test)');
    });

    const result = await downloadWithUrl(
      fixtureUrl(placeholderFixture),
      apksDir,
      PKG,
      VER,
      downloadOptions(),
    ).catch((e) => e); // capture the rejection instead of letting jest see it as unhandled

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/missing.*lib\/arm64-v8a|curl failed/);

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
    const expectedPath = path.join(apksDir, `${PKG}_${VER}.apk`);
    copyFixtureTo(placeholderFixture, expectedPath);
    validateDownloadedApkAbi.mockImplementation(() => { /* no throw — pretend the arch is fine */ });

    const result = await downloadWithUrl(
      fixtureUrl(placeholderFixture),
      apksDir,
      PKG,
      VER,
      downloadOptions(),
    );
    expect(result.success).toBe(true);
    expect(result.path).toBe(expectedPath);
    // File is preserved — this is the negative of the cleanup tests.
    expect(fs.existsSync(result.path)).toBe(true);
  });

  test('skips aapt version validation for split packages (.xapk/.apkm/.apks)', async () => {
    // Sofascore regression: a fixture bundle is mislabelled .apk but has
    // an inner APK entry. aapt cannot parse this outer zip-of-zips.
    const xapkPath = path.join(apksDir, `${PKG}_${VER}.apk`);
    copyFixtureTo(splitFixture, xapkPath);

    // aapt is intentionally not called for this bundle. The real unzip
    // probe still detects the sanitized inner APK fixture.
    const result = await downloadWithUrl(
      fixtureUrl(splitFixture),
      apksDir,
      PKG,
      VER,
      downloadOptions(),
    );
    expect(result.success).toBe(true);
    expect(result.path).toBe(xapkPath);
    expect(result.version).toBe(VER); // falls back to expected version for split packages
    expect(fs.existsSync(xapkPath)).toBe(true);
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

  test('skips aapt version validation for split packages (.xapk/.apkm/.apks)', async () => {
    // The fixture apkeep command creates the synthetic .xapk bundle;
    // validation is intentionally bypassed for split packages.
    const expectedPath = path.join(apksDir, `${PKG}@${VER}.xapk`);

    const result = await downloadWithApkeep(
      PKG,
      VER,
      apksDir,
      downloadOptions(),
    );
    expect(result.success).toBe(true);
    expect(result.filepath).toBe(expectedPath);
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  test('deletes the partial .xapk when API validation throws', async () => {
    // Version validation passes; ABI validation throws — exercises the
    // cleanup branch in downloadWithApkeep independently.
    const expectedPath = path.join(apksDir, `${PKG}@${VER}.xapk`);
    validateDownloadedApkAbi.mockImplementation(() => {
      throw new Error('Downloaded APK is missing lib/arm64-v8a/*.so (forced for test)');
    });

    await expect(
      downloadWithApkeep(PKG, VER, apksDir, downloadOptions()),
    ).rejects.toThrow(
      /missing.*lib\/arm64-v8a|APKPure does not have/,
    );

    expect(execFile).toHaveBeenCalled();
    expect(validateDownloadedApkAbi).toHaveBeenCalled();
    expect(fs.existsSync(expectedPath)).toBe(false);
  });
});
