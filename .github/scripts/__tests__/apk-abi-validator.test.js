#!/usr/bin/env node
'use strict';

// .github/scripts/__tests__/apk-abi-validator.test.js
//
// Unit tests for the post-download ABI validator extracted from
// unified-downloader.js. Lives in its own module so it can be tested
// without playwright + the network stack.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { ABI_MISMATCH, validateDownloadedApkAbi, manifestRootAttribute } = require('../apk-abi-validator');

const MANIFESTS = path.join(__dirname, 'fixtures', 'manifests');

// execFileSync returns null with stdio 'ignore', so success is "didn't throw".
function zipAvailable() {
  try {
    execFileSync('zip', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeApk(tmp, name, entries) {
  const apkPath = path.join(tmp, name);
  for (const e of entries) {
    const full = path.join(tmp, e);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'fake');
  }
  execFileSync('zip', ['-q', apkPath, ...entries], { cwd: tmp, stdio: 'ignore' });
  return apkPath;
}

describe('validateDownloadedApkAbi', () => {
  // The zip-based cases skip themselves without zip; CI must not skip them.
  test('zip is available on CI', () => {
    if (process.env.CI) expect(zipAvailable()).toBe(true);
  });

  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-validator-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('no-op when preferredArch is empty', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk(tmp, 'single_arm.apk', ['lib/armeabi-v7a/libfoo.so', 'classes.dex']);
    // Should not throw even though v7a-only APK is missing arm64-v8a
    expect(() => validateDownloadedApkAbi(apk, '')).not.toThrow();
    expect(() => validateDownloadedApkAbi(apk, undefined)).not.toThrow();
    expect(() => validateDownloadedApkAbi(apk, null)).not.toThrow();
  });

  test('no-op for missing file (defensive — file may have been cleaned up)', () => {
    expect(() => validateDownloadedApkAbi('/nonexistent/path.apk', 'arm64-v8a')).not.toThrow();
  });

  test('no-op for non-zip file (HTML error page, partial download, placeholder)', () => {
    const fakeApk = path.join(tmp, 'fake.apk');
    fs.writeFileSync(fakeApk, Buffer.alloc(2048, 0x41)); // 2KB of 'A's
    // Should not throw — not a valid zip, defer to other checks
    expect(() => validateDownloadedApkAbi(fakeApk, 'arm64-v8a')).not.toThrow();
  });

  test('throws when single-arm APK is missing the preferred arch', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk(tmp, 'v7a_only.apk', ['lib/armeabi-v7a/libfoo.so', 'classes.dex']);
    expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a')).toThrow(/missing.*lib\/arm64-v8a/);
    // The code tells the downloader not to retry the file.
    expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a')).toThrow(expect.objectContaining({ code: ABI_MISMATCH }));
  });

  test('does not throw when APK has the preferred arch', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk(tmp, 'with_v8a.apk', [
      'lib/armeabi-v7a/libfoo.so',
      'lib/arm64-v8a/libbar.so',
      'classes.dex',
    ]);
    expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a')).not.toThrow();
    expect(() => validateDownloadedApkAbi(apk, 'armeabi-v7a')).not.toThrow();
  });

  test('does not throw for universal APK', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk(tmp, 'universal.apk', [
      'lib/arm64-v8a/libfoo.so',
      'lib/armeabi-v7a/libfoo.so',
      'lib/x86_64/libfoo.so',
      'classes.dex',
    ]);
    expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a')).not.toThrow();
    expect(() => validateDownloadedApkAbi(apk, 'armeabi-v7a')).not.toThrow();
    expect(() => validateDownloadedApkAbi(apk, 'x86_64')).not.toThrow();
  });

  test('does not throw for an APK with no native libs (pure-Java app)', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    // No lib/ entries and no required ABI split: nothing to validate.
    const apk = makeApk(tmp, 'java.apk', ['AndroidManifest.xml', 'classes.dex']);
    expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a')).not.toThrow();
  });

  // APKPure serves Discord's base.apk as a plain "APK": no lib/ at all,
  // and its manifest requires the ABI split (requiredSplitTypes="base__abi").
  // The manifests are real AAPT2-compiled files (see fixtures/manifests/README.md).
  function makeBaseApk(name, fixture) {
    const dir = fs.mkdtempSync(path.join(tmp, 'base-'));
    fs.copyFileSync(path.join(MANIFESTS, `${fixture}.axml`), path.join(dir, 'AndroidManifest.xml'));
    fs.writeFileSync(path.join(dir, 'classes.dex'), 'fake');
    const apk = path.join(tmp, name);
    execFileSync('zip', ['-q', apk, 'AndroidManifest.xml', 'classes.dex'], { cwd: dir, stdio: 'ignore' });
    return apk;
  }

  test.each([
    ['abi-required', true],
    ['abi-and-density', true],
    ['density-only', false],
    // base__abi only as the application label, not in requiredSplitTypes
    ['density-label-abi', false],
    // no requiredSplitTypes at all; "requiredSplitTypes" and "base__abi" only as other values
    ['unrelated-strings', false],
    ['no-split', false],
  ])('base APK with no libs, manifest %s: rejected = %s', (fixture, rejected) => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeBaseApk(`${fixture}.apk`, fixture);
    if (rejected) expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a')).toThrow(/base APK of a split app/);
    else expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a')).not.toThrow();
  });

  test('a manifest that is not binary XML is not rejected', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk(tmp, 'text_manifest.apk', ['classes.dex']);
    fs.writeFileSync(path.join(tmp, 'AndroidManifest.xml'), 'requiredSplitTypes="base__abi"');
    execFileSync('zip', ['-q', apk, 'AndroidManifest.xml'], { cwd: tmp, stdio: 'ignore' });
    expect(() => validateDownloadedApkAbi(apk, 'arm64-v8a')).not.toThrow();
  });

  // Regression guard: APKMirror's apkm-pw flow saves BUNDLE-shaped
  // files (zip-of-zips with inner .apk entries) under whatever filename
  // the upstream Content-Disposition sets — frequently `.apk`. The old
  // extension-based dispatch mis-identified such a bundle as a single
  // APK and rejected it for "missing lib/<arch>/*.so" (because the
  // bundle's native libs live inside base.apk / split_config.*.apk,
  // not at the zip top level). The fix inspects the zip contents to
  // decide whether the file is a single APK or a bundle, regardless
  // of the on-disk extension.
  test('accepts a bundle even when its filename uses .apk extension (content-based detection)', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }

    // Build a fake bundle with arm64-v8a inside base.apk.
    const bundleDir = path.join(tmp, 'inner');
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.mkdirSync(path.join(bundleDir, 'lib', 'arm64-v8a'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'lib', 'arm64-v8a', 'libfoo.so'), 'fake');
    fs.writeFileSync(path.join(bundleDir, 'classes.dex'), 'fake');
    execFileSync('zip', ['-q', path.join(bundleDir, 'base.apk'), 'lib/arm64-v8a/libfoo.so'], { cwd: bundleDir, stdio: 'ignore' });
    execFileSync('zip', ['-q', path.join(bundleDir, 'base.apk'), 'classes.dex'], { cwd: bundleDir, stdio: 'ignore' });

    // Wrap base.apk in an outer .apk (mimicking APKMirror's mislabel).
    const bundlePath = path.join(tmp, 'fake_bundle_named_apk.apk');
    execFileSync('zip', ['-q', bundlePath, 'base.apk'], { cwd: bundleDir, stdio: 'ignore' });

    // This must NOT throw — content-based detection sees the inner
    // .apk and routes through the bundle branch, which extracts and
    // finds arm64-v8a inside base.apk.
    expect(() => validateDownloadedApkAbi(bundlePath, 'arm64-v8a')).not.toThrow();
  });

  // Regression guard for the PK magic-byte typo. The previous test
  // exercises a bundle with arm64-v8a inside — the bundle branch
  // returns early on the first matching split, so the magic-byte
  // check at the top of validateDownloadedApkAbi is never exercised
  // for "wrong arch" bundles. This test builds a bundle with NO
  // arm64-v8a split, forcing the validator to reach the throw at
  // the end of the bundle loop — which only runs if the magic-byte
  // check accepts the zip. If the check rejects real zips (e.g. 0x6b
  // vs 0x4b), this test silently passes, hiding the bug the way the
  // existing positive-case test hid it.
  test('throws on real-zip bundle with no arm64-v8a split', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }

    const v7aInner = path.join(tmp, 'inner', 'config.armeabi_v7a.apk');
    fs.mkdirSync(path.dirname(v7aInner), { recursive: true });
    const v7aLib = path.join('lib', 'armeabi-v7a', 'libfoo.so');
    fs.mkdirSync(path.join(tmp, 'lib', 'armeabi-v7a'), { recursive: true });
    fs.writeFileSync(path.join(tmp, v7aLib), 'fake');
    execFileSync('zip', ['-q', v7aInner, v7aLib], { cwd: tmp, stdio: 'ignore' });

    const xapk = path.join(tmp, 'v7a_only.xapk');
    execFileSync('zip', ['-q', xapk, 'config.armeabi_v7a.apk'], { cwd: path.dirname(v7aInner), stdio: 'ignore' });

    // Sanity: the file really does start with the real PK signature.
    const head = fs.readFileSync(xapk).slice(0, 4);
    expect(head[0]).toBe(0x50);
    expect(head[1]).toBe(0x4b);

    expect(() => validateDownloadedApkAbi(xapk, 'arm64-v8a')).toThrow(/no split containing.*arm64-v8a/);
  });
});

describe('manifestRootAttribute', () => {
  const read = (f) => manifestRootAttribute(fs.readFileSync(path.join(MANIFESTS, `${f}.axml`)), 0x0101064e, 'requiredSplitTypes');
  test('reads android:requiredSplitTypes from the root element only', () => {
    expect(read('abi-required')).toBe('base__abi');
    expect(read('abi-and-density')).toBe('base__density,base__abi');
    expect(read('density-label-abi')).toBe('base__density');
    expect(read('unrelated-strings')).toBeUndefined();
  });
  test('throws on a file that is not binary XML, or is cut short', () => {
    expect(() => manifestRootAttribute(Buffer.from('<manifest/>'), 0x0101064e, 'requiredSplitTypes')).toThrow();
    const cut = fs.readFileSync(path.join(MANIFESTS, 'abi-required.axml')).subarray(0, 200);
    expect(() => manifestRootAttribute(cut, 0x0101064e, 'requiredSplitTypes')).toThrow();
  });
});
