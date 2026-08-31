// test/__tests__/rank-candidates.test.js
//
// Behavioural coverage for src/apk/rank-candidates.js — the
// candidate-object ranking API introduced in PR 5b. This suite lives
// under test/ (not .github/scripts/__tests__/) so it can exercise the
// src/ tree without being pulled into the ESLint scope that wraps the
// workflow scripts.

'use strict';

const {
  selectCandidate,
  scoreCandidate,
  isCompatible,
  compareCandidates,
  createCandidate,
  ARCHITECTURE_SCORE,
  DPI_SCORE,
  FORMAT_SCORE,
} = require('../../src/apk/rank-candidates');

const preference = {
  packageName: 'com.example.app',
  preferredArchitecture: 'arm64-v8a',
  versionName: '1.2.3',
};

function makeCandidate(overrides = {}) {
  return createCandidate({
    source: overrides.source ?? 'apkeep',
    url: overrides.url ?? 'https://example.com/app.apk',
    packageName: overrides.packageName ?? preference.packageName,
    versionName: overrides.versionName ?? preference.versionName,
    versionCode: overrides.versionCode ?? null,
    architecture: overrides.architecture ?? 'arm64-v8a',
    dpi: overrides.dpi ?? 'nodpi',
    format: overrides.format ?? 'apk',
    sizeBytes: overrides.sizeBytes ?? null,
    variantLabel: overrides.variantLabel ?? null,
    metadata: overrides.metadata ?? {},
  });
}

describe('rank-candidates/selectCandidate', () => {
  test('prefers arm64-v8a over universal for the same package+version', () => {
    const arm64 = makeCandidate({
      url: 'https://example.com/arm64.apk',
      architecture: 'arm64-v8a',
    });
    const universal = makeCandidate({
      url: 'https://example.com/universal.apk',
      architecture: 'universal',
    });

    const picked = selectCandidate([universal, arm64], preference);
    expect(picked).toBe(arm64);

    // Order should not matter — pass arm64 first and verify same result.
    const pickedReversed = selectCandidate([arm64, universal], preference);
    expect(pickedReversed).toBe(arm64);
  });

  test('returns null when no candidate matches the package name', () => {
    const wrongPackage = makeCandidate({
      url: 'https://example.com/wrong.apk',
      packageName: 'com.other.app',
    });
    expect(selectCandidate([wrongPackage], preference)).toBeNull();
  });

  test('returns null on an empty candidates list', () => {
    expect(selectCandidate([], preference)).toBeNull();
  });

  test('excludes candidates whose versionName does not match the requirement', () => {
    const matching = makeCandidate({
      url: 'https://example.com/v1.2.3.apk',
      versionName: '1.2.3',
    });
    const stale = makeCandidate({
      url: 'https://example.com/v1.2.4.apk',
      versionName: '1.2.4',
    });

    expect(selectCandidate([stale, matching], preference)).toBe(matching);
  });

  test('treats candidates with unknown versionName as compatible when requirement has none', () => {
    const noRequirement = { ...preference, versionName: null };
    const noVersion = makeCandidate({
      url: 'https://example.com/noversion.apk',
      versionName: null,
    });
    expect(selectCandidate([noVersion], noRequirement)).toBe(noVersion);
  });

  test('tie-breaking is deterministic and lexicographic by URL', () => {
    // Two candidates with identical scores (same architecture, dpi,
    // format, versionName, size). The comparator falls through to
    // localeCompare on URL, so the lower URL string always wins
    // regardless of input order.
    const a = makeCandidate({
      url: 'https://example.com/zzz.apk',
      architecture: 'arm64-v8a',
      dpi: 'nodpi',
      format: 'apk',
      versionName: '1.2.3',
      sizeBytes: 10_000_000,
    });
    const b = makeCandidate({
      url: 'https://example.com/aaa.apk',
      architecture: 'arm64-v8a',
      dpi: 'nodpi',
      format: 'apk',
      versionName: '1.2.3',
      sizeBytes: 10_000_000,
    });

    const pickedForward = selectCandidate([a, b], preference);
    const pickedReverse = selectCandidate([b, a], preference);

    // 'aaa' < 'zzz' lexicographically, so b must win both times.
    expect(pickedForward).toBe(b);
    expect(pickedReverse).toBe(b);
  });
});

describe('rank-candidates/scoreCandidate', () => {
  test('returns 0 for an unknown-architecture candidate when no preference matches', () => {
    const noPreference = { ...preference, preferredArchitecture: 'arm64-v8a' };
    const candidate = makeCandidate({ architecture: 'unknown' });
    // architecture='unknown' → 0 (ARCHITECTURE_SCORE), preferredArch
    // mismatch → no +1000. dpi='nodpi' (default) → 100. format='apk'
    // (default) → 100. versionName matches → +500. No size bonus.
    // Total = 700.
    const score = scoreCandidate(candidate, noPreference);
    expect(score).toBe(700); // 100 (dpi nodpi) + 100 (format apk) + 500 (version match)
  });

  test('adds 1000 when architecture matches preferredArchitecture', () => {
    const pref = { ...preference, preferredArchitecture: 'arm64-v8a', versionName: null };
    const candidate = makeCandidate({ architecture: 'arm64-v8a', versionName: null });
    // 1000 (preferred bonus) + 100 (ARCH score arm64) + 100 (DPI nodpi) + 100 (FORMAT apk)
    expect(scoreCandidate(candidate, pref)).toBe(1300);
  });

  test('adds 500 when candidate versionName matches preference versionName', () => {
    const pref = { ...preference, preferredArchitecture: 'arm64-v8a' };
    const matching = makeCandidate({ architecture: 'unknown', versionName: '1.2.3', dpi: 'unknown', format: 'unknown' });
    const stale = makeCandidate({ architecture: 'unknown', versionName: '9.9.9', dpi: 'unknown', format: 'unknown' });
    const diff = scoreCandidate(matching, pref) - scoreCandidate(stale, pref);
    expect(diff).toBe(500);
  });

  test('caps the sizeBytes bonus at 100 (Math.min(sizeBytes / 1e6, 100))', () => {
    const pref = { ...preference, preferredArchitecture: 'arm64-v8a', versionName: null };
    const small = makeCandidate({
      architecture: 'unknown', versionName: null, dpi: 'unknown', format: 'unknown',
      sizeBytes: 10_000_000, // 10 MB → contributes 10
    });
    const huge = makeCandidate({
      architecture: 'unknown', versionName: null, dpi: 'unknown', format: 'unknown',
      sizeBytes: 1_000_000_000, // 1 GB → caps at 100
    });
    expect(scoreCandidate(huge, pref) - scoreCandidate(small, pref)).toBe(90);
  });

  test('does not crash when sizeBytes is null', () => {
    const pref = { ...preference, preferredArchitecture: 'arm64-v8a' };
    const candidate = makeCandidate({ sizeBytes: null });
    expect(typeof scoreCandidate(candidate, pref)).toBe('number');
  });
});

describe('rank-candidates/isCompatible', () => {
  test('rejects mismatched packageName', () => {
    const candidate = makeCandidate({ packageName: 'com.other.app' });
    expect(isCompatible(candidate, preference)).toBe(false);
  });

  test('accepts matching packageName when preference has no versionName', () => {
    const candidate = makeCandidate({ versionName: '9.9.9' });
    expect(isCompatible(candidate, { ...preference, versionName: null })).toBe(true);
  });

  test('rejects mismatched versionName when preference specifies one', () => {
    const candidate = makeCandidate({ versionName: '9.9.9' });
    expect(isCompatible(candidate, preference)).toBe(false);
  });

  test('accepts candidate with null versionName when preference specifies one', () => {
    // Some candidates (e.g. partially-populated upstream results) come
    // back with versionName: null. The spec says "ignore when either
    // side is empty" — the check only fires when both are non-null.
    const candidate = makeCandidate({ versionName: null });
    expect(isCompatible(candidate, preference)).toBe(true);
  });
});

describe('rank-candidates/compareCandidates', () => {
  test('returns 0 when both candidates have identical scores and URLs', () => {
    const a = makeCandidate({ url: 'https://example.com/same.apk' });
    const b = makeCandidate({ url: 'https://example.com/same.apk' });
    const cmp = compareCandidates(preference);
    expect(cmp(a, b)).toBe(0);
  });

  test('returns negative when left scores higher', () => {
    const a = makeCandidate({ architecture: 'arm64-v8a' });
    const b = makeCandidate({ architecture: 'unknown' });
    const cmp = compareCandidates(preference);
    expect(cmp(a, b)).toBeLessThan(0);
  });
});

describe('rank-candidates/lookup tables', () => {
  test('ARCHITECTURE_SCORE ranks arm64-v8a above universal', () => {
    expect(ARCHITECTURE_SCORE['arm64-v8a']).toBeGreaterThan(ARCHITECTURE_SCORE.universal);
    expect(ARCHITECTURE_SCORE.universal).toBeGreaterThan(ARCHITECTURE_SCORE['armeabi-v7a']);
    expect(ARCHITECTURE_SCORE['armeabi-v7a']).toBeGreaterThan(ARCHITECTURE_SCORE.x86_64);
    expect(ARCHITECTURE_SCORE.x86_64).toBeGreaterThan(ARCHITECTURE_SCORE.x86);
    expect(ARCHITECTURE_SCORE.x86).toBeGreaterThan(ARCHITECTURE_SCORE.unknown);
  });

  test('DPI_SCORE ranks nodpi first', () => {
    expect(DPI_SCORE.nodpi).toBeGreaterThan(DPI_SCORE['120-640dpi']);
  });

  test('FORMAT_SCORE ranks apk first', () => {
    expect(FORMAT_SCORE.apk).toBeGreaterThan(FORMAT_SCORE.xapk);
    expect(FORMAT_SCORE.xapk).toBeGreaterThan(FORMAT_SCORE.apkm);
    expect(FORMAT_SCORE.apkm).toBeGreaterThan(FORMAT_SCORE.apks);
    expect(FORMAT_SCORE.apks).toBeGreaterThan(FORMAT_SCORE.unknown);
  });
});