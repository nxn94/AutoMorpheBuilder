#!/usr/bin/env node
'use strict';

/**
 * download-supported-apk.js
 *
 * For a single matrix entry, ensure the target-version APK is present
 * in $APKS_DIR (downloading, picking from cache, or merging a split
 * package as needed), validate its version with aapt, and emit the
 * chosen APK path + version as workflow outputs.
 *
 * Extracted from the ~480-line inline bash block in morphe-build.yml's
 * "Download supported APK for ${{ matrix.appId }}" step. Behavior
 * intentionally identical to that bash — the same fallback chain:
 *
 *   1. Cached APK already in $APKS_DIR matching the target version.
 *   2. Pre-downloaded APK in $TOOLS_DIR (from check-versions).
 *   3. unified-downloader.js (URL cache → parallel resolve → sequential).
 *   4. Manual APKMirror URL from config.json download_urls[pkg].latest_supported.
 *   5. If pinned and everything above failed: emergency fallback to
 *      morphe-desktop list-versions, retry with the head of that list.
 *
 * Then: aapt-validate, score-rank candidate, merge split packages
 * (APKEditor required — no silent fallback to base.apk-only, which would
 * drop arm64-v8a / x86_64 native libs and silently break install on
 * 64-bit-only devices), require classes.dex, and enforce the
 * preferred_arch ABI guardrail when config.json sets one.
 *
 * Inputs (env vars):
 *   APP_ID         required  package id
 *   TARGET_VERSION required  selected version from resolve-supported-version step
 *   TARGET_VERSIONS optional comma-separated list of all compatible versions
 *                            (used only for the "All compatible versions" log line)
 *   APKS_DIR       required  destination directory for the chosen APK
 *   TOOLS_DIR      required  where pre-downloaded APKs / .mpp / .jar live
 *   APKEDITOR_JAR  optional  APKEditor.jar path (needed for split-package merge)
 *   PINNED_CHECK   optional  same as config.json patch_repos[pkg].pin_version
 *   PATCH_REPO     optional  patch repo (for emergency fallback)
 *   MORPHE_CLI_JAR optional  morphe-desktop jar (for emergency fallback)
 *   MANUAL_URL     optional  config.json download_urls[pkg].latest_supported
 *   RUNNER_TEMP    optional  temp dir (default /tmp)
 *   GITHUB_OUTPUT  required  workflow output file
 *
 * Outputs ($GITHUB_OUTPUT):
 *   apk     absolute path of the chosen APK
 *   version APK's version (from filename, falling back to TARGET_VERSION)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  extractVersionFromString,
  findCachedApk,
  findPackageCandidate,
  bestRankedApkInDir,
  apkHasDex,
  apkHasNativeLibsForArch,
  findBundleInDir,
  listApkAbis,
} = require('./apk-selection');
const { validateDownloadedApkAbi } = require('./apk-abi-validator');

const APP_ID = process.env.APP_ID;
const TARGET_VERSION = process.env.TARGET_VERSION || '';
const TARGET_VERSIONS = process.env.TARGET_VERSIONS || '';
const APKS_DIR = process.env.APKS_DIR;
const TOOLS_DIR = process.env.TOOLS_DIR;
const APKEDITOR_JAR = process.env.APKEDITOR_JAR || '';
const PINNED_CHECK = process.env.PINNED_CHECK || '';
const PATCH_REPO = process.env.PATCH_REPO || '';
const MORPHE_CLI_JAR = process.env.MORPHE_CLI_JAR || '';
const MANUAL_URL = process.env.MANUAL_URL || '';
const RUNNER_TEMP = process.env.RUNNER_TEMP || '/tmp';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

if (!APP_ID || !APKS_DIR || !TOOLS_DIR) {
  console.error('::error::APP_ID, APKS_DIR, and TOOLS_DIR are required.');
  process.exit(1);
}
if (!GITHUB_OUTPUT) {
  console.error('::error::GITHUB_OUTPUT not set; this script must run inside a workflow step.');
  process.exit(1);
}

function setOutput(key, value) {
  if (value === undefined || value === null) value = '';
  const line = `${key}=${value}`;
  console.log(line);
  fs.appendFileSync(GITHUB_OUTPUT, line + '\n');
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

/**
 * Wrap the unified-downloader.js invocation in a child node process so
 * its JSON output can be parsed without an in-process import (avoids
 * polluting the test environment).
 */
function runUnifiedDownloader(appId, version, apksDir) {
  const script = path.join(__dirname, 'unified-downloader.js');
  const r = spawnSync(process.execPath, [script, appId, version, apksDir], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 600000,
  });
  if (r.error) return { ok: false, error: r.error.message };
  const stdout = (r.stdout || '').trim();
  if (!stdout) return { ok: false, error: 'unified-downloader produced no output' };
  try {
    const parsed = JSON.parse(stdout);
    return parsed.success
      ? { ok: true, result: parsed }
      : { ok: false, error: parsed.error || 'unknown' };
  } catch (e) {
    return { ok: false, error: `could not parse unified-downloader output: ${e.message}` };
  }
}

/**
 * Curl-with-retries fallback. Mirrors the bash `download_with_curl`:
 * 4 attempts, exponential-ish sleep, size sanity check.
 */
function downloadWithCurl(url, apksDir, appId) {
  if (!url) {
    console.error('::error::Manual APKMirror URL is empty.');
    return null;
  }
  console.error(`Using APK source URL for ${appId}: ${url}`);

  let apkName = url.split('/').pop().replace(/\/$/, '');
  if (!apkName) apkName = `${appId}.apk`;
  if (!/\.(apk|xapk|apkm|apks)$/i.test(apkName)) apkName += '.apk';
  const outputFile = path.join(apksDir, apkName);

  const MAX = 4;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    console.log(`Download attempt ${attempt}/${MAX}...`);
    let r;
    try {
      r = spawnSync('curl', [
        '-fL', '--retry', '4', '--retry-delay', '5', '--connect-timeout', '30',
        '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        '-H', 'Accept: */*',
        '-H', 'Accept-Language: en-US,en;q=0.9',
        '-H', 'Referer: https://www.apkmirror.com/',
        '-o', outputFile,
        url,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      r = { error: e };
    }
    if (r.status === 0 && fs.existsSync(outputFile)) {
      const size = fs.statSync(outputFile).size;
      if (size > 1000) {
        console.log(`Download saved: ${outputFile}`);
        return outputFile;
      }
    }
    if (attempt >= MAX) {
      console.error(`Download failed after ${MAX} attempts.`);
      try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
      return null;
    }
    console.log(`Download attempt ${attempt} failed, retrying...`);
    spawnSync('sleep', [String(attempt * 10)]);
    try { fs.unlinkSync(outputFile); } catch { /* ignore */ }
  }
  return null;
}

/**
 * Try aapt dump badging and return the versionName, or '' if not available.
 */
function readApkVersion(apkPath) {
  let info;
  try {
    info = execFileSync('aapt', ['dump', 'badging', apkPath], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    try {
      info = execFileSync('aapt2', ['dump', 'badging', apkPath], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }
  const m = info.match(/versionName='([^']+)'/);
  return m ? m[1] : '';
}

/**
 * Merge a split package with APKEditor. Returns true on success (writes
 * `outApk`), false otherwise. Mirrors merge_split_package_with_apkeditor.
 *
 * Flags:
 *   -clean-meta   Strips the META-INF signature block before re-emit.
 *                 morphe-desktop re-signs the merged APK anyway, and the
 *                 original signature is for the per-split contents —
 *                 leaving it in place has caused post-merge install
 *                 failures on some downstream tools. Always safe; the
 *                 cost is one extra pass over the bundle's signature
 *                 entries.
 */
function mergeSplitPackageWithApkeditor(splitPkg, outApk) {
  if (!APKEDITOR_JAR || !fs.existsSync(APKEDITOR_JAR)) {
    console.error('APKEditor jar not available; cannot merge split package.');
    return false;
  }
  try { fs.unlinkSync(outApk); } catch { /* ignore */ }
  const mergeLog = path.join(RUNNER_TEMP, `apkeditor_merge_${APP_ID}.log`);
  console.error(`Merging split package with APKEditor: ${splitPkg}`);
  let r;
  try {
    // Same fd for both streams: opens the file once instead of twice,
    // which removes the openSync-twice TOCTOU CodeQL flagged.
    const logFd = fs.openSync(mergeLog, 'a');
    r = spawnSync('java', ['-jar', APKEDITOR_JAR, 'm', '-clean-meta', '-i', splitPkg, '-o', outApk], {
      encoding: 'utf8', stdio: ['ignore', logFd, logFd],
    });
  } catch (e) {
    r = { error: e, status: null };
  }
  if ((r.status === 0) && !fs.existsSync(outApk)) {
    const defaultMerged = splitPkg.replace(/\.[^.]+$/, '') + '_merged.apk';
    const fallbackMerged = findFirstFile(path.dirname(splitPkg), '_merged.apk');
    if (fs.existsSync(defaultMerged)) {
      fs.renameSync(defaultMerged, outApk);
    } else if (fallbackMerged && fs.existsSync(fallbackMerged)) {
      fs.renameSync(fallbackMerged, outApk);
    }
  }
  if (r.status !== 0 || !fs.existsSync(outApk)) {
    console.error(`APKEditor merge failed for ${splitPkg}`);
    try { console.error(fs.readFileSync(mergeLog, 'utf8')); } catch { /* ignore */ }
    return false;
  }
  if (!apkHasDex(outApk)) {
    console.error(`APKEditor output has no classes.dex: ${outApk}`);
    return false;
  }
  // Post-merge diagnostics: log which ABIs the merge actually emitted.
  // If a split slipped through despite our best efforts, this is the line
  // that tells the maintainer which arch went missing. The source bundle
  // is a zip-of-zips (lib/ entries live inside the per-arch .apk splits,
  // not at the top level), so a direct comparison isn't possible without
  // extracting it; log the output and rely on the ABI guardrail below
  // to hard-fail when the preferred arch is missing.
  const mergedAbis = listApkAbis(outApk);
  console.log(`::debug::Merged APK ABIs: ${mergedAbis.length ? mergedAbis.join(', ') : '(none — pure-Java app?)'}`);
  return true;
}

function findFirstFile(dir, suffix) {
  let list;
  try { list = fs.readdirSync(dir); } catch { return null; }
  for (const f of list) {
    if (f.endsWith(suffix)) return path.join(dir, f);
  }
  return null;
}

/**
 * Read `preferred_arch` from config.json. Mirrors `loadConfig()` in
 * unified-downloader.js — keeps the script independent of the caller.
 * Empty string means "no preference" (skip the ABI guardrail).
 *
 * Env override: $PREFERRED_ARCH wins if set, so tests/CI can pin it
 * without rewriting config.json.
 */
function loadPreferredArch() {
  if (process.env.PREFERRED_ARCH) return process.env.PREFERRED_ARCH;
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) return '';
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return cfg.preferred_arch || '';
  } catch {
    return '';
  }
}

/**
 * Best-effort dump of the APK's `native-code:` line from aapt badging,
 * for the guardrail error message. Returns '' on any failure.
 */
function readApkNativeCode(apkPath) {
  for (const bin of ['aapt', 'aapt2']) {
    try {
      const out = execFileSync(bin, ['dump', 'badging', apkPath], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      const line = out.split('\n').find(l => l.startsWith('native-code:'));
      return line ? line.trim() : '';
    } catch { /* try next */ }
  }
  return '';
}

// === Main ===
console.log(`Downloading APK for ${APP_ID}...`);
ensureDir(APKS_DIR);

let downloadSuccess = false;

/**
 * Return true if `filePath` is OK to use as-is (either no preferred
 * arch is configured, or the file actually ships the arch's .so libs).
 * Returns false on any failure — caller should drop the file and let
 * the next download path produce a fresh one.
 *
 * Wraps validateDownloadedApkAbi (which throws on missing arch) so
 * cache-hit code paths can decide whether to keep the cached file.
 */
function cachedFileHasPreferredAbi(filePath) {
  const arch = loadPreferredArch();
  if (!arch) return true;
  try {
    validateDownloadedApkAbi(filePath, arch);
    return true;
  } catch (e) {
    console.log(`::warning::Cached file ${path.basename(filePath)} rejected: ${e.message}`);
    return false;
  }
}

// 1. Check for cached APK matching target version
const cached = findCachedApk(APKS_DIR, TARGET_VERSION);
if (cached) {
  // Cached files survive across builds via actions/cache@v5 keyed by
  // apk-<appId>-<version>. Files written BEFORE the download-side ABI
  // validation (commit c855306) can be 32-bit-only and would sail
  // through this cache hit into the ABI guardrail at the end of this
  // script, hard-failing the build. Validate the cache contents the
  // same way the live downloader would.
  if (cachedFileHasPreferredAbi(cached)) {
    console.log(`Using cached APK: ${cached} (v${TARGET_VERSION})`);
    downloadSuccess = true;
  } else {
    console.log(`Discarding bad cached APK (missing ${loadPreferredArch() || 'preferred-arch'} libs) — will re-download.`);
    try { fs.unlinkSync(cached); } catch { /* ignore */ }
  }
} else {
  // Clear stale files in APKS_DIR (preserves nothing for this run).
  try {
    for (const f of fs.readdirSync(APKS_DIR)) {
      try { fs.unlinkSync(path.join(APKS_DIR, f)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// 2. Pre-downloaded APK from TOOLS_DIR?
if (!downloadSuccess) {
  if (!TARGET_VERSION) {
    console.error(`::error::No latest Morphe-supported version was resolved for ${APP_ID}.`);
    process.exit(1);
  }

  const preloaded = findCachedApk(TOOLS_DIR, TARGET_VERSION);
  if (preloaded) {
    // Same ABI validation as the APKS_DIR cache above. The
    // pre-downloaded file was produced by pre_download_apks.sh, which
    // runs unified-downloader.js (and would normally have caught a
    // 32-bit-only APK at download time) — but the artifact cache can
    // outlive a deploy by up to 1 day (see
    // actions/upload-artifact@v7 retention-days: 1 in morphe-build.yml).
    if (cachedFileHasPreferredAbi(preloaded)) {
      console.log(`Using pre-downloaded APK from check-versions: ${preloaded} (matches v${TARGET_VERSION})`);
      fs.copyFileSync(preloaded, path.join(APKS_DIR, path.basename(preloaded)));
      return;
    }
    // Preloaded file exists but is missing the preferred arch's libs.
    // Discard it and fall through to the unified-downloader (which
    // has its own ABI validation + fallback chain). The structure
    // here intentionally does NOT use an else-branch: previously, a
    // bad cache was discarded but the code returned up to the
    // `if (!downloadSuccess)` failure exit without ever invoking
    // the downloader, leading to "No APK could be downloaded" even
    // though APKMirror was still waiting to be tried.
    console.log(`Discarding bad pre-downloaded APK — will re-download via unified-downloader.`);
    try { fs.unlinkSync(preloaded); } catch { /* ignore */ }
  }

  // No preloaded file (or we just discarded a bad one): run the
  // unified-downloader's full fallback chain (URL cache → parallel
  // resolve → apkeep → apkmirror-api → apkmirror Playwright).
  console.log(`No matching pre-downloaded APK, running unified-downloader...`);
  const dl = runUnifiedDownloader(APP_ID, TARGET_VERSION, APKS_DIR);
  if (dl.ok) {
    console.log(`unified-downloader succeeded: ${JSON.stringify(dl.result)}`);
    downloadSuccess = true;
  } else {
    console.log(`unified-downloader failed: ${dl.error}`);
    if (MANUAL_URL) {
      console.log('Trying manual URL fallback...');
      if (downloadWithCurl(MANUAL_URL, APKS_DIR, APP_ID)) {
        downloadSuccess = true;
      }
    }
  }
}

// 3. Pinned-version emergency fallback
if (!downloadSuccess) {
  if (PINNED_CHECK && PINNED_CHECK !== 'null' && PINNED_CHECK === TARGET_VERSION) {
    console.error(`::warning::Pinned version ${PINNED_CHECK} download failed; attempting emergency fallback to list-versions...`);
    const slug = PATCH_REPO.replace(/\//g, '-');
    const mppFile = path.join(TOOLS_DIR, `${slug}.mpp`);
    if (fs.existsSync(mppFile) && MORPHE_CLI_JAR && fs.existsSync(MORPHE_CLI_JAR)) {
      let out;
      try {
        out = execFileSync(
          'java',
          ['-jar', MORPHE_CLI_JAR, 'list-versions', '-f', APP_ID, '--patches=' + mppFile],
          { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
        );
      } catch (_e) {
        out = '';
      }
      const versions = out.match(/\d+\.\d+\.\d+/g) || [];
      if (versions.length > 0) {
        const fallbackVersion = versions[0];
        console.log(`Emergency fallback: retrying with version ${fallbackVersion}`);
        const dl = runUnifiedDownloader(APP_ID, fallbackVersion, APKS_DIR);
        if (dl.ok) {
          console.log(`Emergency fallback succeeded: ${JSON.stringify(dl.result)}`);
          // Update TARGET_VERSION so downstream validation picks it up.
          process.env.TARGET_VERSION = fallbackVersion;
          downloadSuccess = true;
        } else {
          console.log(`Emergency fallback also failed: ${dl.error}`);
        }
      }
    }
  }
  if (!downloadSuccess) {
    console.error(`::error::No APK could be downloaded for ${APP_ID} version ${TARGET_VERSION}.`);
    process.exit(1);
  }
}

// 4. aapt validation pass — drop any APKs with the wrong versionName.
const effectiveTargetVersion = process.env.TARGET_VERSION || TARGET_VERSION;
console.log(`Validating APK version matches target v${effectiveTargetVersion} using aapt...`);

let apkValid = false;
const apkFiles = fs.readdirSync(APKS_DIR).filter(f => f.endsWith('.apk'));
for (const f of apkFiles) {
  const full = path.join(APKS_DIR, f);
  const versionName = readApkVersion(full);
  console.log(`::debug::APK: ${f} -> versionName=${versionName}`);
  if (versionName === effectiveTargetVersion) {
    console.log(`APK version validated: ${f} is v${versionName} (matches target)`);
    apkValid = true;
    break;
  } else if (!versionName) {
    // aapt couldn't read the version (not installed or unsupported format);
    // unified-downloader already validated, so accept the APK.
    console.log('Could not read APK version via aapt (aapt unavailable); trusting unified-downloader validation');
    apkValid = true;
    break;
  } else {
    console.log(`APK has wrong version: ${f} is v${versionName} but wanted v${effectiveTargetVersion} - removing`);
    try { fs.unlinkSync(full); } catch { /* ignore */ }
  }
}

// 5. Also check split packages
if (!apkValid) {
  for (const ext of ['xapk', 'apkm', 'apks']) {
    const splitFiles = fs.readdirSync(APKS_DIR).filter(f => f.endsWith('.' + ext));
    for (const f of splitFiles) {
      const full = path.join(APKS_DIR, f);
      console.log(`Checking split package: ${f}`);
      const tmpDir = fs.mkdtempSync(path.join(RUNNER_TEMP, 'split_validate_'));
      try {
        const r = spawnSync('unzip', ['-q', full, 'base.apk', '-d', tmpDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if (r.status === 0) {
          const baseApk = path.join(tmpDir, 'base.apk');
          if (fs.existsSync(baseApk)) {
            const splitVersion = readApkVersion(baseApk);
            console.log(`::debug::Split package base APK version: ${splitVersion} (expected: ${effectiveTargetVersion})`);
            if (splitVersion && splitVersion !== effectiveTargetVersion) {
              console.log(`Split package has wrong version: ${splitVersion} (expected ${effectiveTargetVersion}) - removing`);
              try { fs.unlinkSync(full); } catch { /* ignore */ }
              continue;
            }
            console.log(`Split package version validated: ${splitVersion}`);
          }
        }
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      // We'll re-validate after merge.
      apkValid = true;
      break;
    }
    if (apkValid) break;
  }
}

if (!apkValid) {
  console.error(`::error::No APK found with correct version v${effectiveTargetVersion}`);
  console.error(`Files in ${APKS_DIR}:`);
  try { console.error(fs.readdirSync(APKS_DIR).join('\n')); } catch { /* ignore */ }
  process.exit(1);
}

// 6. Pick best APK candidate.
let apkCandidate = findPackageCandidate(APKS_DIR);
if (!apkCandidate) {
  console.error(`::error::No package downloaded for latest Morphe-supported version ${effectiveTargetVersion} for ${APP_ID}.`);
  console.error(`All compatible versions (for reference): ${TARGET_VERSIONS}`);
  process.exit(1);
}
if (!fs.existsSync(apkCandidate)) {
  console.error(`::error::Resolved package path is missing: ${apkCandidate}`);
  console.error(`Files in ${APKS_DIR}:`);
  try { console.error(fs.readdirSync(APKS_DIR).join('\n')); } catch { /* ignore */ }
  process.exit(1);
}
console.log(`Found package in ${APKS_DIR}: ${apkCandidate}`);

// 6b. BUNDLE-vs-single-APK preference. `findPackageCandidate` scores a
//     plain `.apk` higher than a `.xapk`/`.apkm`/`.apks` (2000 vs 500)
//     because a .apk is ready-to-patch and skips the merge step. But that
//     scoring is purely filename-based: it doesn't know whether the .apk
//     is universal or single-arm. When both a single-arm .apk AND a
//     bundle are in APKS_DIR (e.g. apkeep produced an armeabi-v7a APK
//     and the apkmirror fallback downloaded a universal bundle on the
//     same run, or stale files from a previous build coexist with this
//     run's download), the .apk wins and the merge step is silently
//     skipped. The resulting build ships a single-architecture APK.
//
//     Fix: when the chosen .apk is missing the preferred architecture's
//     .so libs AND a bundle is also available, prefer the bundle. The
//     bundle is by definition multi-arch after merge. This preserves
//     the existing fast-path for genuine universal .apks (they keep the
//     +800 arm64 bonus and skip the merge entirely).
const preferredArchEarly = loadPreferredArch();
const bundleInDir = findBundleInDir(APKS_DIR);
if (
  apkCandidate.endsWith('.apk') &&
  bundleInDir &&
  preferredArchEarly &&
  !apkHasNativeLibsForArch(apkCandidate, preferredArchEarly)
) {
  const candidateAbis = listApkAbis(apkCandidate);
  console.log(
    `::warning::Single-arm APK ${path.basename(apkCandidate)} ` +
    `(ABIs: ${candidateAbis.join(', ') || 'none'}) is missing ` +
    `libs for preferred architecture '${preferredArchEarly}'. ` +
    `Switching to bundle ${path.basename(bundleInDir)} for universal merge.`,
  );
  apkCandidate = bundleInDir;
}

// 7. If the candidate is an APK without classes.dex, try to swap to a
//    dex-bearing APK from the same directory; failing that, fall back
//    to the first split package (which will be merged next).
if (apkCandidate.endsWith('.apk') && !apkHasDex(apkCandidate)) {
  console.log('Selected APK does not contain classes.dex; trying another APK candidate.');
  const ranked = bestRankedApkInDir(APKS_DIR);
  for (const c of ranked) {
    if (apkHasDex(c)) {
      apkCandidate = c;
      console.log(`Using APK with dex content: ${apkCandidate}`);
      break;
    }
  }
}
if (apkCandidate.endsWith('.apk') && !apkHasDex(apkCandidate)) {
  const splitFound = fs.readdirSync(APKS_DIR).find(f => /\.(xapk|apkm|apks)$/.test(f));
  if (splitFound) {
    console.log(`Switching to split package for merge: ${splitFound}`);
    apkCandidate = path.join(APKS_DIR, splitFound);
  }
}

// 8. Merge split packages into a standalone APK if necessary.
let finalApk = apkCandidate;
if (/\.(xapk|apkm|apks)$/.test(apkCandidate)) {
  console.log(`Split package detected (${apkCandidate}); attempting APKEditor merge...`);
  const outApk = path.join(APKS_DIR, `${APP_ID}.apk`);
  if (mergeSplitPackageWithApkeditor(apkCandidate, outApk)) {
    console.log(`Merged APK created: ${outApk}`);
    console.log('Validating merged APK version...');
    const mergedVersion = readApkVersion(outApk);
    console.log(`::debug::Merged APK version: ${mergedVersion} (expected: ${effectiveTargetVersion})`);
    if (mergedVersion && mergedVersion !== effectiveTargetVersion) {
      console.error(`::error::Merged APK has wrong version: ${mergedVersion} (expected ${effectiveTargetVersion})`);
      process.exit(1);
    }
    finalApk = outApk;
  } else {
    // APKEditor merge failed. The previous fallback path here would
    // `unzip *.apk` out of the BUNDLE and copy the highest-scored
    // dex-bearing APK, which is always base.apk — and base.apk ships
    // only armeabi-v7a libs in most universal bundles (Reddit, YouTube,
    // etc.). The arm64-v8a / x86_64 native libs live in separate
    // split_config.*.apk files that get silently discarded, producing
    // an APK that installs nowhere on 64-bit-only devices. Refuse to
    // ship that. The maintainer needs to fix the merge step (install
    // APKEditor, update its jar, or hand a non-BUNDLE source).
    let archiveContents = '';
    try {
      const probe = spawnSync('unzip', ['-Z1', apkCandidate], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (probe.status === 0) archiveContents = probe.stdout.split('\n').filter(Boolean).join(' ');
    } catch { /* ignore */ }
    console.error(`::error::APKEditor merge failed for ${APP_ID} ${effectiveTargetVersion}: ${apkCandidate}`);
    console.error('BUNDLE/APK set requires merging base.apk + split_config.*.apk before patching.');
    console.error('Falling back to base.apk-only would drop arm64-v8a / x86_64 native libs,');
    console.error('producing an APK that silently fails to install on 64-bit-only devices.');
    if (archiveContents) console.error(`Archive contents: ${archiveContents}`);
    process.exit(1);
  }
}

if (!fs.existsSync(finalApk)) {
  console.error(`::error::APK path check failed: ${finalApk}`);
  process.exit(1);
}
if (!apkHasDex(finalApk)) {
  console.error(`::error::Chosen APK has no classes.dex and cannot be patched: ${finalApk}`);
  try {
    const files = fs.readdirSync(APKS_DIR).filter(f => /\.(apk|xapk|apkm|apks)$/.test(f));
    console.error(`Files in ${APKS_DIR}:`, files.join(' '));
  } catch { /* ignore */ }
  process.exit(1);
}

// 8b. ABI guardrail. If the operator pinned a preferred_arch (typically
//     "arm64-v8a"), the final APK must actually ship lib/<arch>/*.so.
//     Without this check, the BUNDLE fallback path above used to happily
//     emit a base.apk-only APK declaring only armeabi-v7a, which then
//     silently fails to install on arm64-v8a-only devices (Pixel +
//     GrapheneOS, etc.). The check is opt-in: no preferred_arch means
//     no filter.
const preferredArch = loadPreferredArch();
if (preferredArch) {
  const hasLibs = apkHasNativeLibsForArch(finalApk, preferredArch);
  const nativeCodeLine = readApkNativeCode(finalApk);
  console.log(`::debug::ABI check: preferred=${preferredArch}, hasLib/${preferredArch}/*.so=${hasLibs}, manifest=${nativeCodeLine || '(no native-code line)'}`);
  if (!hasLibs) {
    console.error(`::error::APK ${finalApk} is missing native libraries for preferred architecture '${preferredArch}'.`);
    if (nativeCodeLine) console.error(`Manifest declares: ${nativeCodeLine}`);
    console.error('This usually means a BUNDLE/APK set was not properly merged and only base.apk was kept,');
    console.error('which ships armeabi-v7a libs while arm64-v8a / x86_64 libs sit in separate split APKs.');
    console.error('Fix the merge step (APKEditor), or pin a non-BUNDLE source. Failing the build is');
    console.error('intentional — shipping an un-installable APK is worse than no release.');
    process.exit(1);
  }
}

console.log(`Downloaded ${APP_ID} → ${finalApk}`);

// 9. Outputs
setOutput('apk', finalApk);
const apkFilename = path.basename(finalApk);
let apkVersion = extractVersionFromString(apkFilename);
if (!apkVersion && effectiveTargetVersion) apkVersion = effectiveTargetVersion;
if (!apkVersion) apkVersion = 'unknown';
setOutput('version', apkVersion);
console.log(`Downloaded ${APP_ID} → ${finalApk} (v${apkVersion})`);
