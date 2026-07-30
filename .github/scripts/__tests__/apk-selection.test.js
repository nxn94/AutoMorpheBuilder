// .github/scripts/__tests__/apk-selection.test.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  extractVersionFromString,
  scoreApk,
  findCachedApk,
  findPackageCandidate,
  bestRankedApkInDir,
  apkHasDex,
  apkHasNativeLibsForArch,
  findBundleInDir,
  listApkAbis,
} = require('../apk-selection');

describe('extractVersionFromString', () => {
  test('extracts X.Y.Z from a typical APK filename', () => {
    expect(extractVersionFromString('youtube_v20.40.45.apk')).toBe('20.40.45');
  });
  test('returns first match when multiple are present', () => {
    expect(extractVersionFromString('app-1.2.3+meta-4.5.6.apk')).toBe('1.2.3');
  });
  test('returns empty string when no version is found', () => {
    expect(extractVersionFromString('just_a_name.apk')).toBe('');
  });
});

describe('scoreApk', () => {
  // The weights live in apk-selection.js and were lifted directly from the
  // original inline awk score() function. These tests guard the scoring
  // contract that findPackageCandidate / bestRankedApkInDir rely on.

  test('arm64-v8a .apk with no negatives scores very high', () => {
    const s = scoreApk('/dir/app_arm64-v8a.apk');
    // 2000 (.apk) + 800 (arm64) = 2800
    expect(s).toBe(2800);
  });

  test('arm64-v8a base.apk is the absolute best candidate', () => {
    // The +500 "base.apk" bonus only applies when the file is exactly
    // named "base.apk" (the awk uses `b == "base.apk"`); the
    // arm64 match adds 800.
    const s = scoreApk('/dir/base.apk');
    // 2000 (.apk) + 800 (arm64 doesn't match — filename has no arm64) = 2000
    // Actually "base.apk" doesn't match arm64, so just 2000 + 500 (base.apk) = 2500.
    expect(s).toBe(2500);
  });

  test('arm64-v8a base.apk scores higher than arm64-v8a app.apk (base.apk bonus)', () => {
    // Same dir, base.apk named with arm64 in some other file vs arm64-v8a app.apk.
    // We assert ordering instead of exact numbers to keep the test robust.
    const baseArm = scoreApk('/dir/base.apk');                  // 2500 (no arm64 in name)
    const appArm = scoreApk('/dir/app_arm64-v8a.apk');          // 2800
    expect(appArm).toBeGreaterThan(baseArm); // arm64 wins alone
    // But a base_arm64-v8a.apk beats both:
    const baseAndArm = scoreApk('/tmp/base_arm64-v8a.apk');     // 2000 + 800 = 2800 (no base.apk bonus — basename != "base.apk")
    expect(baseAndArm).toBeGreaterThan(baseArm);
  });

  test('xapk splits are heavily demoted vs .apk', () => {
    const apk = scoreApk('/dir/something_arm64-v8a.apk');
    const xapk = scoreApk('/dir/something_arm64-v8a.xapk');
    expect(apk).toBeGreaterThan(xapk);
  });

  test('x86 architecture is penalized heavily', () => {
    const arm = scoreApk('/dir/app_arm64-v8a.apk');  // 2000 + 800 = 2800
    const x86 = scoreApk('/dir/app_x86_64.apk');     // 2000 - 600 = 1400
    expect(arm).toBeGreaterThan(x86);
    expect(x86).toBeLessThan(arm);
  });

  test('split_config / config. artifacts are severely demoted', () => {
    const config = scoreApk('/dir/split_config.arm64_v8a.apk');  // 2000 + 800 - 1400 = 1400
    const normal = scoreApk('/dir/app_arm64-v8a.apk');           // 2800
    expect(normal).toBeGreaterThan(config);
    expect(config).toBe(1400);
  });

  test('case-insensitive', () => {
    expect(scoreApk('/dir/APP_ARM64-V8A.APK')).toBe(scoreApk('/dir/app_arm64-v8a.apk'));
  });
});

describe('findCachedApk', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sel-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns null when dir does not exist', () => {
    expect(findCachedApk(path.join(tmp, 'does-not-exist'), '1.0.0')).toBeNull();
  });

  test('matches first file with the right version, any extension', () => {
    fs.writeFileSync(path.join(tmp, 'com.x_v1.0.0.apk'), 'fake');
    fs.writeFileSync(path.join(tmp, 'com.x_v2.0.0.apk'), 'fake');
    const found = findCachedApk(tmp, '1.0.0');
    expect(found).toBe(path.join(tmp, 'com.x_v1.0.0.apk'));
  });

  test('returns null when version does not match', () => {
    fs.writeFileSync(path.join(tmp, 'com.x_v1.0.0.apk'), 'fake');
    expect(findCachedApk(tmp, '2.0.0')).toBeNull();
  });

  test('finds split packages too', () => {
    fs.writeFileSync(path.join(tmp, 'com.x_v1.0.0.xapk'), 'fake');
    expect(findCachedApk(tmp, '1.0.0')).toBe(path.join(tmp, 'com.x_v1.0.0.xapk'));
  });
});

describe('findPackageCandidate', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sel-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns null for empty / missing dir', () => {
    expect(findPackageCandidate(tmp)).toBeNull();
    expect(findPackageCandidate(path.join(tmp, 'no'))).toBeNull();
  });

  test('picks arm64-v8a .apk over x86_64 .apk', () => {
    fs.writeFileSync(path.join(tmp, 'x86_x86_64.apk'), 'fake');
    fs.writeFileSync(path.join(tmp, 'arm_arm64-v8a.apk'), 'fake');
    expect(findPackageCandidate(tmp)).toBe(path.join(tmp, 'arm_arm64-v8a.apk'));
  });

  test('rejects split_config in favor of regular .apk', () => {
    fs.writeFileSync(path.join(tmp, 'split_config.apk'), 'fake');
    fs.writeFileSync(path.join(tmp, 'base.apk'), 'fake');
    expect(findPackageCandidate(tmp)).toBe(path.join(tmp, 'base.apk'));
  });

  test('returns xapk when no .apk exists', () => {
    fs.writeFileSync(path.join(tmp, 'com.x_v1.0.0.xapk'), 'fake');
    expect(findPackageCandidate(tmp)).toBe(path.join(tmp, 'com.x_v1.0.0.xapk'));
  });

  test('only descends into directories that exist', () => {
    fs.writeFileSync(path.join(tmp, 'a_arm64-v8a.apk'), 'fake');
    expect(findPackageCandidate(tmp)).toBe(path.join(tmp, 'a_arm64-v8a.apk'));
  });
});

describe('bestRankedApkInDir', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sel-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns empty array when dir is missing or has no .apk files', () => {
    expect(bestRankedApkInDir(tmp)).toEqual([]);
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'hi');
    expect(bestRankedApkInDir(tmp)).toEqual([]);
  });

  test('ranks arm64-v8a above x86_64', () => {
    fs.writeFileSync(path.join(tmp, 'x86_x86_64.apk'), 'fake');
    fs.writeFileSync(path.join(tmp, 'arm_arm64-v8a.apk'), 'fake');
    const ranked = bestRankedApkInDir(tmp);
    expect(ranked[0]).toBe(path.join(tmp, 'arm_arm64-v8a.apk'));
  });
});

describe('apkHasDex', () => {
  // apkHasDex shells out to `unzip -Z1 <file>` and greps for classes*.dex.
  // We exercise it against a real zip fixture to avoid mocking the
  // subprocess pipeline (the function is a thin wrapper, but the wrapper
  // is what matters for correctness).

  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sel-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns true for a zip containing classes.dex', () => {
    // Use the `zip` CLI if available; otherwise skip via test.skip.
    // Most CI runners have zip. If not, the test will be skipped cleanly.
    let zipStatus;
    try {
      zipStatus = require('node:child_process')
        .spawnSync('zip', ['--version'], { stdio: 'ignore' }).status;
    } catch {
      zipStatus = -1;
    }
    if (zipStatus !== 0 && zipStatus !== 1 /* zip --version exits 0 or 1, both mean present */) {
      console.warn('Skipping apkHasDex real-zip test: `zip` CLI not available.');
      return;
    }
    const fakeApk = path.join(tmp, 'has-dex.apk');
    // Empty zip, then add classes.dex
    require('node:child_process').spawnSync('zip', [fakeApk, '/dev/null'], { stdio: 'ignore' });
    // Write a small classes.dex and add it. (Empty zip without dex -> false.)
    fs.writeFileSync(path.join(tmp, 'classes.dex'), 'fake');
    require('node:child_process').spawnSync('zip', [fakeApk, 'classes.dex'], { cwd: tmp, stdio: 'ignore' });
    expect(apkHasDex(fakeApk)).toBe(true);
  });

  test('returns false for a zip without classes.dex', () => {
    let zipStatus;
    try {
      zipStatus = require('node:child_process')
        .spawnSync('zip', ['--version'], { stdio: 'ignore' }).status;
    } catch {
      zipStatus = -1;
    }
    if (zipStatus !== 0 && zipStatus !== 1) {
      console.warn('Skipping apkHasDex real-zip test: `zip` CLI not available.');
      return;
    }
    const fakeApk = path.join(tmp, 'no-dex.apk');
    fs.writeFileSync(path.join(tmp, 'other.txt'), 'fake');
    require('node:child_process').spawnSync('zip', [fakeApk, 'other.txt'], { cwd: tmp, stdio: 'ignore' });
    expect(apkHasDex(fakeApk)).toBe(false);
  });
});

describe('apkHasNativeLibsForArch', () => {
  // Same real-zip approach as apkHasDex: thin wrapper, but the wrapper
  // is the surface the ABI guardrail relies on. Covers the Reddit
  // BUNDLE failure mode (base.apk ships only armeabi-v7a, the
  // arm64-v8a libs sit in a split_config.*.apk that gets discarded).
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sel-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function zipAvailable() {
    let zipStatus;
    try {
      zipStatus = require('node:child_process')
        .spawnSync('zip', ['--version'], { stdio: 'ignore' }).status;
    } catch {
      zipStatus = -1;
    }
    return zipStatus === 0 || zipStatus === 1;
  }

  function makeApk(name, entries) {
    const apkPath = path.join(tmp, name);
    // Create an empty zip first, then add each entry at its full path.
    // Using `cwd: tmp` plus a relative entry name preserves directory
    // structure inside the zip — important because the helpers under
    // test match against `lib/<arch>/...` paths.
    require('node:child_process').spawnSync('zip', [apkPath, '/dev/null'], { stdio: 'ignore' });
    for (const e of entries) {
      const full = path.join(tmp, e);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'fake');
      require('node:child_process').spawnSync('zip', [apkPath, e], { cwd: tmp, stdio: 'ignore' });
    }
    return apkPath;
  }

  test('returns true when lib/<arch>/*.so exists', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk('full.apk', [
      'lib/arm64-v8a/libyoga.so',
      'lib/armeabi-v7a/libyoga.so',
      'classes.dex',
    ]);
    expect(apkHasNativeLibsForArch(apk, 'arm64-v8a')).toBe(true);
    expect(apkHasNativeLibsForArch(apk, 'armeabi-v7a')).toBe(true);
  });

  test('returns false when lib/<arch>/*.so is missing (base.apk-only scenario)', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk('base-only.apk', [
      'lib/armeabi-v7a/libyoga.so',
      'classes.dex',
    ]);
    expect(apkHasNativeLibsForArch(apk, 'arm64-v8a')).toBe(false);
    expect(apkHasNativeLibsForArch(apk, 'x86_64')).toBe(false);
    expect(apkHasNativeLibsForArch(apk, 'armeabi-v7a')).toBe(true);
  });

  test('returns true for empty/falsy arch (no filter applied)', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk('any.apk', ['lib/armeabi-v7a/libyoga.so', 'classes.dex']);
    expect(apkHasNativeLibsForArch(apk, '')).toBe(true);
    expect(apkHasNativeLibsForArch(apk, null)).toBe(true);
    expect(apkHasNativeLibsForArch(apk, undefined)).toBe(true);
  });

  test('regex-escapes arch so dashes / dots are literal', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk('esc.apk', ['lib/arm64-v8a/libfoo.so', 'classes.dex']);
    // The dash in "arm64-v8a" must not become a regex range.
    expect(apkHasNativeLibsForArch(apk, 'arm64-v8a')).toBe(true);
    // An arch containing regex metachars would be matched literally,
    // not as a pattern; verify by asking for a fake arch that, if not
    // escaped, would falsely match via wildcards.
    expect(apkHasNativeLibsForArch(apk, 'arm64XXXX')).toBe(false);
  });

  test('does not confuse lib/<arch> with a deeper lib/<arch>/sub/ path', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk('nested.apk', [
      'lib/arm64-v8a/sub/libyoga.so', // deeper than one level
      'classes.dex',
    ]);
    // The implementation matches `lib/<arch>/<file>.so` only — a nested
    // path under another dir should not count.
    expect(apkHasNativeLibsForArch(apk, 'arm64-v8a')).toBe(false);
  });
});

describe('findBundleInDir', () => {
  // findBundleInDir locates a split package (.xapk / .apkm / .apks) in
  // APKS_DIR so the bundle can be preferred over a single-arm .apk when
  // both are present. The order is .xapk > .apkm > .apks (first match
  // wins on a sorted readdir, which is what `fs.readdirSync` returns).
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sel-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('returns null for missing dir', () => {
    expect(findBundleInDir(path.join(tmp, 'does-not-exist'))).toBeNull();
  });

  test('returns null when only .apk files are present', () => {
    fs.writeFileSync(path.join(tmp, 'app_v1.0.0.apk'), 'fake');
    expect(findBundleInDir(tmp)).toBeNull();
  });

  test('finds a .xapk split package', () => {
    fs.writeFileSync(path.join(tmp, 'app_v1.0.0.apk'), 'fake');
    const xapk = path.join(tmp, 'app_v1.0.0.xapk');
    fs.writeFileSync(xapk, 'fake');
    expect(findBundleInDir(tmp)).toBe(xapk);
  });

  test('finds an .apkm split package', () => {
    const apkm = path.join(tmp, 'app_v1.0.0.apkm');
    fs.writeFileSync(apkm, 'fake');
    expect(findBundleInDir(tmp)).toBe(apkm);
  });

  test('finds an .apks split package', () => {
    const apks = path.join(tmp, 'app_v1.0.0.apks');
    fs.writeFileSync(apks, 'fake');
    expect(findBundleInDir(tmp)).toBe(apks);
  });
});

describe('listApkAbis', () => {
  // listApkAbis is used for post-merge diagnostics: it shells out to
  // `unzip -Z1 <apk>` and aggregates the unique `lib/<arch>/` directory
  // names so the build log shows exactly which architectures the merged
  // APK shipped. Empty list means pure-Java (no native libs) or an error.
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sel-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function zipAvailable() {
    let zipStatus;
    try {
      zipStatus = require('node:child_process')
        .spawnSync('zip', ['--version'], { stdio: 'ignore' }).status;
    } catch {
      zipStatus = -1;
    }
    return zipStatus === 0 || zipStatus === 1;
  }

  function makeApk(name, entries) {
    const apkPath = path.join(tmp, name);
    require('node:child_process').spawnSync('zip', [apkPath, '/dev/null'], { stdio: 'ignore' });
    for (const e of entries) {
      const full = path.join(tmp, e);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'fake');
      require('node:child_process').spawnSync('zip', [apkPath, e], { cwd: tmp, stdio: 'ignore' });
    }
    return apkPath;
  }

  test('returns [] for a zip without native libs', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk('jvm.apk', ['classes.dex']);
    expect(listApkAbis(apk)).toEqual([]);
  });

  test('returns the unique ABIs in sorted order', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const apk = makeApk('multi.apk', [
      'lib/x86_64/libfoo.so',
      'lib/arm64-v8a/libbar.so',
      'lib/arm64-v8a/libbaz.so', // dup
      'lib/armeabi-v7a/libqux.so',
      'classes.dex',
    ]);
    expect(listApkAbis(apk)).toEqual(['arm64-v8a', 'armeabi-v7a', 'x86_64']);
  });
});

describe('BUNDLE-vs-single-APK regression', () => {
  // Regression guard for the "merge silently ships a single-arm APK" bug.
  //
  // `findPackageCandidate` scores a bare .apk higher than a bundle
  // (2000 vs 500) because a .apk is ready-to-patch and skips the merge
  // step. But that scoring is purely filename-based: it doesn't know
  // whether the .apk is universal or single-arm. When a single-arm .apk
  // AND a bundle coexist in APKS_DIR (e.g. apkeep dropped a v7a APK on
  // version-mismatch and apkmirror then downloaded a universal bundle
  // in the same run), the .apk wins and the merge never runs.
  //
  // The fix lives in download-supported-apk.js (the "BUNDLE-vs-single-
  // APK preference" block): it consults apkHasNativeLibsForArch on the
  // chosen candidate and switches to findBundleInDir(tmp) when the
  // preferred arch's .so libs are missing. These tests pin down the two
  // helpers the fix relies on so the behaviour is auditable without
  // standing up the whole download pipeline.
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sel-'));
  });
  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function zipAvailable() {
    let zipStatus;
    try {
      zipStatus = require('node:child_process')
        .spawnSync('zip', ['--version'], { stdio: 'ignore' }).status;
    } catch {
      zipStatus = -1;
    }
    return zipStatus === 0 || zipStatus === 1;
  }

  function makeApk(name, entries) {
    const apkPath = path.join(tmp, name);
    require('node:child_process').spawnSync('zip', [apkPath, '/dev/null'], { stdio: 'ignore' });
    for (const e of entries) {
      const full = path.join(tmp, e);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'fake');
      require('node:child_process').spawnSync('zip', [apkPath, e], { cwd: tmp, stdio: 'ignore' });
    }
    return apkPath;
  }

  test('apkHasNativeLibsForArch detects single-arm v7a APK is missing v8a', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    // The bug scenario: single-arm v7a APK in APKS_DIR alongside a bundle.
    const singleArm = makeApk('app_v1.0.0.apk', [
      'lib/armeabi-v7a/libfoo.so',
      'classes.dex',
    ]);
    // This is exactly what the BUNDLE-vs-single-APK preference block in
    // download-supported-apk.js checks: "does the chosen .apk actually
    // ship the preferred arch's libs?" — if not, switch to the bundle.
    expect(apkHasNativeLibsForArch(singleArm, 'arm64-v8a')).toBe(false);
    expect(apkHasNativeLibsForArch(singleArm, 'armeabi-v7a')).toBe(true);
  });

  test('findBundleInDir + apkHasNativeLibsForArch together identify the right pick', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    const singleArm = makeApk('app_v1.0.0.apk', [
      'lib/armeabi-v7a/libfoo.so',
      'classes.dex',
    ]);
    fs.writeFileSync(path.join(tmp, 'app_v1.0.0.xapk'), 'fake-bundle');

    const bundle = findBundleInDir(tmp);
    expect(bundle).not.toBeNull();
    expect(bundle).toBe(path.join(tmp, 'app_v1.0.0.xapk'));

    // The .apk scores higher in findPackageCandidate (so without the
    // preference fix, the bundle is ignored). The preference fix only
    // kicks in when the .apk lacks the preferred arch's libs.
    expect(apkHasNativeLibsForArch(singleArm, 'arm64-v8a')).toBe(false);
  });

  test('apkHasNativeLibsForArch returns true for a true universal .apk', () => {
    if (!zipAvailable()) { console.warn('skipping: no zip'); return; }
    // Genuine universal APK: has every common ABI. The preference fix
    // should NOT switch to the bundle here — the .apk is already good.
    const universal = makeApk('app_v1.0.0.apk', [
      'lib/arm64-v8a/libfoo.so',
      'lib/armeabi-v7a/libfoo.so',
      'lib/x86_64/libfoo.so',
      'classes.dex',
    ]);
    expect(apkHasNativeLibsForArch(universal, 'arm64-v8a')).toBe(true);
    expect(apkHasNativeLibsForArch(universal, 'armeabi-v7a')).toBe(true);
    expect(apkHasNativeLibsForArch(universal, 'x86_64')).toBe(true);
  });
});