#!/usr/bin/env node
'use strict';

/**
 * apk-selection.js — pure scoring/ranking helpers for picking the best
 * APK candidate from a directory containing APKs / split packages.
 *
 * Extracted from the inline awk score() function that previously lived
 * inside the "Download supported APK" workflow step. Kept in a separate
 * file so the logic can be unit-tested (see __tests__/apk-selection.test.js)
 * independently of the workflow step that drives it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Canonical candidate-based ranking API (from src/apk/rank-candidates.js).
// `findPackageCandidate` and `bestRankedApkInDir` now build candidate
// objects (via `createCandidate` from src/apk/candidate.js) from the
// filename and delegate the actual ranking to
// `selectCandidate`/`compareCandidates` here. The previous regex-based
// `scoreApk` function and its parallel weight table have been removed.
const rankCandidates = require('../../src/apk/rank-candidates');
const { createCandidate } = require('../../src/apk/candidate');

/**
 * Inspect the zip at `filePath` and decide whether it's a single APK
 * or a bundle (zip-of-zips with inner .apk entries). Returns:
 *   'apk'       — file has lib/* or AndroidManifest.xml at top level
 *   'bundle'    — file has inner .apk entries (apks / apkm / xapk shape)
 *   'unknown'   — non-zip, empty, or unrecognizable
 *
 * Content-based detection matters because upstream sources sometimes
 * mislabel the extension: APKMirror's apkm-pw flow saves bundle files
 * with whatever filename the server's Content-Disposition sets, and
 * Reddit's variant downloads come back with a `.apk` filename even
 * though the contents are a zip-of-zips. Extension-based dispatch
 * would treat such a bundle as a single APK, run lib/<arch>/*.so
 * detection on it, find no top-level native libs, and reject it —
 * even though the bundle's inner base.apk / split_config.*.apk files
 * DO contain the right ABIs and would merge into a universal APK.
 */
function detectApkShape(filePath) {
  try {
    const out = execFileSync('unzip', ['-Z1', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = out.split('\n');
    let hasInnerApk = false;
    let hasTopLevelLib = false;
    let hasManifest = false;
    for (const line of lines) {
      if (!line) continue;
      if (line.toLowerCase().endsWith('.apk')) { hasInnerApk = true; continue; }
      if (/^lib\/[^/]+\//.test(line)) { hasTopLevelLib = true; continue; }
      if (line === 'AndroidManifest.xml') { hasManifest = true; continue; }
    }
    if (hasInnerApk && !hasTopLevelLib && !hasManifest) return 'bundle';
    if (hasTopLevelLib || hasManifest) return 'apk';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Extract the first X.Y.Z version-like sequence from a string (typically
 * an APK filename). Returns the matched substring, or ''.
 */
function extractVersionFromString(s) {
  const m = String(s).match(/\d+(?:\.\d+){2,}/);
  return m ? m[0] : '';
}

/**
 * Build a candidate object from a filename on disk. Mirrors the
 * fields the legacy regex-based scoreApk() inspected: architecture
 * tag, supported format extension, and the file's size. Used by
 * `findPackageCandidate` and `bestRankedApkInDir` to feed the
 * canonical ranking pipeline in src/apk/rank-candidates.js without
 * maintaining a parallel weight table.
 *
 * packageName is set to a fixed sentinel because the directory-scan
 * resolvers don't have a target package in scope — `selectCandidate`
 * treats the sentinel as a single bucket (every candidate on disk
 * belongs to the same group for this purpose), so packageName
 * filtering remains a no-op as in the legacy implementation.
 */
function filenameToCandidate(filename) {
  const lower = String(filename).toLowerCase();
  const ext = lower.replace(/^.*\./, '');

  // Architecture extraction mirrors the legacy regex-based scoreApk
  // heuristic so directory-scan ranking stays in lockstep with what
  // `find_package_candidate` used to do. Boundaries are
  // non-alphanumeric characters (underscores, dashes, dots, slashes)
  // plus string ends; this catches `app_arm64-v8a.apk`,
  // `split_config.arm64_v8a.apk`, and `arm_arm64-v8a.apk` while
  // ignoring the random `x86` substring inside `xxx86_thing.apk`.
  // Order matters: more-specific tokens (arm64-v8a, x86_64) are tried
  // before less-specific ones (arm64, x86), so a filename carrying
  // both wins the more-specific bucket.
  const sep = '(?:^|[^a-z0-9])';
  const end = '(?:[^a-z0-9]|$)';
  let architecture = 'unknown';
  if (/arm64[-_]?v?8a/.test(lower) || new RegExp(`${sep}arm64${end}`).test(lower)) {
    architecture = 'arm64-v8a';
  } else if (/armeabi[-_]?v7a/.test(lower) || new RegExp(`${sep}v7a${end}`).test(lower)) {
    architecture = 'armeabi-v7a';
  } else if (/x86[-_]?64/.test(lower) || new RegExp(`${sep}x86_64${end}`).test(lower)) {
    architecture = 'x86_64';
  } else if (new RegExp(`${sep}x86${end}`).test(lower)) {
    architecture = 'x86';
  } else if (/universal/.test(lower)) {
    architecture = 'universal';
  }

  const format = ['apk', 'xapk', 'apkm', 'apks'].includes(ext) ? ext : 'unknown';

  let sizeBytes = null;
  try {
    const stat = fs.statSync(filename);
    if (stat.isFile()) sizeBytes = stat.size;
  } catch {
    // stat failures are non-fatal for selection — leave sizeBytes null
    // and let the rank-candidates scorer fall back to its 0-bonus
    // default. (Test fixtures sometimes use empty files where statSync
    // works fine; the catch covers symlinks-to-nowhere and the like.)
  }

  return createCandidate({
    source: 'directory-scan',
    url: filename,
    packageName: 'directory-scan',
    architecture,
    format,
    sizeBytes,
  });
}

/**
 * Find a cached APK (or split package) in APKS_DIR that matches the
 * target version. Mirrors the for-ext/while-find bash loop.
 *
 * @param {string} apksDir   Directory to scan (one level deep).
 * @param {string} targetVersion X.Y.Z version to match against filename.
 * @returns {string|null} Absolute path, or null if nothing matches.
 */
function findCachedApk(apksDir, targetVersion) {
  if (!fs.existsSync(apksDir)) return null;
  const exts = ['apk', 'xapk', 'apkm', 'apks'];
  for (const ext of exts) {
    let entries;
    try {
      entries = fs.readdirSync(apksDir).filter(f => f.endsWith('.' + ext));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const ver = extractVersionFromString(entry);
      if (ver === targetVersion) return path.join(apksDir, entry);
    }
  }
  return null;
}

/**
 * Scan APKS_DIR for all .apk/.xapk/.apkm/.apks files and return the
 * highest-scored one. Mirrors the find_package_candidate awk pipeline;
 * now uses the canonical selectCandidate ranking so legacy regex
 * weight tables no longer live here.
 *
 * @param {string} apksDir Directory to scan (recursive).
 * @returns {string|null} Absolute path of best candidate, or null.
 */
function findPackageCandidate(apksDir) {
  if (!fs.existsSync(apksDir)) return null;
  const entries = [];
  const walk = (dir) => {
    let list;
    try { list = fs.readdirSync(dir); } catch { return; }
    for (const f of list) {
      const full = path.join(dir, f);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full);
      else if (/\.(apk|xapk|apkm|apks)$/i.test(full)) entries.push(full);
    }
  };
  walk(apksDir);
  if (entries.length === 0) return null;
  const candidates = entries.map(filenameToCandidate);
  // No preferredArch / versionName at the directory-scan level — the
  // packaging-around-arch callers pass those via selectCandidate
  // upstream. packageName is the directory-scan sentinel shared by
  // every candidate, so isCompatible() treats the whole set as one
  // pool and the comparator + tiebreaker pick the same APK that the
  // legacy regex weights used to (verified against __tests__).
  const chosen = rankCandidates.selectCandidate(candidates, {
    packageName: 'directory-scan',
  });
  return chosen ? chosen.url : null;
}

/**
 * Variant of findPackageCandidate used after a split-package fallback:
 * returns every .apk under `dir`, sorted best-first. The caller then
 * picks the first one whose contents include classes*.dex.
 *
 * @param {string} dir Directory to scan.
 * @returns {string[]} Absolute paths sorted by score, descending.
 */
function bestRankedApkInDir(dir) {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir)
    .filter(f => f.endsWith('.apk'))
    .map(f => path.join(dir, f));
  if (entries.length === 0) return [];
  const candidates = entries.map(filenameToCandidate);
  const comparator = rankCandidates.compareCandidates({
    packageName: 'directory-scan',
  });
  return candidates.sort(comparator).map(c => c.url);
}

/**
 * Returns true if `apk` is a (likely) patchable APK — i.e. its zip
 * contents include classes.dex / classes2.dex / etc.
 */
function apkHasDex(apk) {
  try {
    const out = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return /^classes(?:\d+)?\.dex$/m.test(out);
  } catch {
    return false;
  }
}

/**
 * Returns true if `apk` ships at least one .so file under `lib/<arch>/`.
 * Used to catch the BUNDLE-merge-fell-back-to-base.apk failure mode where
 * a base APK only declares armeabi-v7a and the arm64-v8a / x86_64 splits
 * get dropped on the floor — the resulting APK then silently fails to
 * install on arm64-v8a-only devices (GrapheneOS, modern Pixels).
 *
 * If `arch` is empty/falsy the function returns true (no ABI filter).
 * The arch string is regex-escaped so values like "arm64-v8a" are safe.
 */
function apkHasNativeLibsForArch(apk, arch) {
  if (!arch) return true;
  const safe = String(arch).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const out = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return new RegExp(`^lib/${safe}/[^/]+\\.so$`, 'm').test(out);
  } catch {
    return false;
  }
}

/**
 * Find any split-package bundle (.xapk / .apkm / .apks) sitting in
 * `dir`. Returns the absolute path of the first match, or null. BUNDLE/APK
 * sets always need merging — a single-arm .apk candidate would silently
 * drop other architectures, so callers should prefer the bundle when one
 * coexists with a single-arm .apk in the download directory.
 *
 * Order of preference (first match wins): .xapk, .apkm, .apks. These are
 * alphabetical, but in practice each app downloads exactly one of these
 * per build (the downloader's variant priorities pick exactly one).
 *
 * @param {string} dir Directory to scan (one level deep — recursive scan
 *                     would surprise callers; split packages live in
 *                     APKS_DIR, not in nested subdirs).
 * @returns {string|null} Absolute path of the bundle, or null.
 */
function findBundleInDir(dir) {
  if (!fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  // First: extension-based check (fast path).
  for (const ext of ['xapk', 'apkm', 'apks']) {
    for (const f of entries) {
      if (f.toLowerCase().endsWith('.' + ext)) return path.join(dir, f);
    }
  }
  // Fallback: content-based check for .apk files that are actually
  // bundles (zip-of-zips). The downloader in unified-downloader.js
  // hardcodes the saved filename to .apk regardless of the URL path,
  // so call-by-extension misses every split-package download from that
  // path. detectApkShape inspects the zip contents to discriminate.
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.apk')) continue;
    const full = path.join(dir, f);
    if (detectApkShape(full) === 'bundle') return full;
  }
  return null;
}

/**
 * Return the deduped, sorted list of ABI directory names embedded in
 * `apk` (one per unique `lib/<abi>/`). Empty list if the APK has no
 * native libs (pure-Java app, dex-only split, etc.) or on any error.
 * Used for post-merge logging and the BUNDLE-vs-.apk preference logic.
 *
 * @param {string} apk Absolute path to an APK/XAPK/APKM/APKS.
 * @returns {string[]} Sorted ABI directory names (e.g. ['arm64-v8a',
 *                    'armeabi-v7a', 'x86_64']). May be empty.
 */
function listApkAbis(apk) {
  try {
    const out = execFileSync('unzip', ['-Z1', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const abis = new Set();
    for (const line of out.split('\n')) {
      const m = line.match(/^lib\/([^/]+)\//);
      if (m) abis.add(m[1]);
    }
    return [...abis].sort();
  } catch {
    return [];
  }
}

module.exports = {
  extractVersionFromString,
  filenameToCandidate,
  findCachedApk,
  findPackageCandidate,
  bestRankedApkInDir,
  apkHasDex,
  apkHasNativeLibsForArch,
  findBundleInDir,
  listApkAbis,
  detectApkShape,
  // Re-export the canonical candidate-based ranking API so existing
  // callers can opt in to the new selection model without changing
  // their import path. The legacy path-based helpers above remain
  // exported unchanged for backward compatibility.
  selectCandidate: rankCandidates.selectCandidate,
  compareCandidates: rankCandidates.compareCandidates,
  scoreCandidate: rankCandidates.scoreCandidate,
  isCompatible: rankCandidates.isCompatible,
  createCandidate: rankCandidates.createCandidate,
  ARCHITECTURE_SCORE: rankCandidates.ARCHITECTURE_SCORE,
  DPI_SCORE: rankCandidates.DPI_SCORE,
  FORMAT_SCORE: rankCandidates.FORMAT_SCORE,
};