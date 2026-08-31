'use strict';

/**
 * APK candidate ranking & selection.
 *
 * Pure helpers that take uniformly-shaped candidate objects (see
 * `./candidate.js` — `createCandidate`) and pick the best one for a
 * given preference (preferred architecture, target versionName, etc.).
 *
 * This module is the canonical API for new code paths that work with
 * structured candidates. The path-based scorer in `.github/scripts/
 * apk-selection.js#scoreApk` predates this and uses different weights
 * because it inspects APK filenames (regex over a string) instead of
 * candidate fields — those weights are preserved inline for behavior
 * stability of the existing `findPackageCandidate` / `bestRankedApkInDir`
 * callers and are intentionally NOT delegated to `scoreCandidate` here.
 */

const { createCandidate } = require('./candidate');

const ARCHITECTURE_SCORE = {
  'arm64-v8a': 100,
  universal: 80,
  'armeabi-v7a': 60,
  x86_64: 40,
  x86: 20,
  unknown: 0,
};

const DPI_SCORE = {
  nodpi: 100,
  '120-640dpi': 90,
  '480-640dpi': 80,
  '120-480dpi': 70,
  '240-480dpi': 60,
  universal: 50,
  unknown: 0,
};

const FORMAT_SCORE = {
  apk: 100,
  xapk: 70,
  apkm: 60,
  apks: 50,
  unknown: 0,
};

function isCompatible(candidate, requirement) {
  if (candidate.packageName !== requirement.packageName) {
    return false;
  }

  if (
    requirement.versionName &&
    candidate.versionName &&
    candidate.versionName !== requirement.versionName
  ) {
    return false;
  }

  return true;
}

function scoreCandidate(candidate, preference) {
  let score = 0;

  if (candidate.architecture === preference.preferredArchitecture) {
    score += 1_000;
  }

  score += ARCHITECTURE_SCORE[candidate.architecture] ?? 0;
  score += DPI_SCORE[candidate.dpi] ?? 0;
  score += FORMAT_SCORE[candidate.format] ?? 0;

  if (candidate.versionName === preference.versionName) {
    score += 500;
  }

  if (candidate.sizeBytes !== null) {
    score += Math.min(candidate.sizeBytes / 1_000_000, 100);
  }

  return score;
}

function compareCandidates(preference) {
  return (left, right) => {
    const scoreDifference =
      scoreCandidate(right, preference) -
      scoreCandidate(left, preference);

    if (scoreDifference !== 0) {
      return scoreDifference;
    }

    return left.url.localeCompare(right.url);
  };
}

function selectCandidate(candidates, preference) {
  const compatible = candidates.filter((candidate) =>
    isCompatible(candidate, preference),
  );

  compatible.sort(compareCandidates(preference));

  return compatible[0] ?? null;
}

module.exports = {
  ARCHITECTURE_SCORE,
  compareCandidates,
  DPI_SCORE,
  FORMAT_SCORE,
  isCompatible,
  scoreCandidate,
  selectCandidate,
};

// Re-export so consumers can `require('./src/apk/rank-candidates')` and get
// the factory too.
module.exports.createCandidate = createCandidate;