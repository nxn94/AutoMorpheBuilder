'use strict';

/**
 * Minimum Android ("minSdk") check for downloaded APKs.
 *
 * A store can serve a build for an older Android than the patches support
 * (a store's arm64 build was made for Android 9 while the patches need
 * Android 11). Such a file passes every package/version/ABI check and only
 * fails minutes later in the patcher. So the downloader reads the file's own
 * minimum Android and compares it with the floor the patches need.
 *
 * The floor is `patch_repos[<pkg>].min_sdk` in config.json, opt-in per app.
 * The patch list's own `minSdk` is deliberately not used: it may describe the
 * device or patched app rather than the APK's minSdkVersion, and would reject
 * correct downloads.
 * 0 means no floor: nothing is checked and behaviour is unchanged.
 *
 * A file whose minimum Android can't be read is "unknown", never rejected:
 * the patcher judges it.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readBaseBadging, createDeadline } = require('./apkpure-exact');

const READ_BUDGET_MS = 60000;

// Android release name for each API level the patches could plausibly ask for.
const ANDROID_NAMES = {
  26: '8', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L',
  33: '13', 34: '14', 35: '15', 36: '16', 37: '17',
};

/** Pure. A positive whole API level, or 0 for anything else. */
function toSdk(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Pure. The app's `min_sdk` from a parsed config.json; 0 if absent or invalid. */
function minSdkFromConfig(config, appId) {
  const entry = config && config.patch_repos && config.patch_repos[appId];
  return toSdk(entry && entry.min_sdk);
}

/** Pure. `sdkVersion:'28'` from an aapt badging dump; null if absent. */
function parseMinSdkFromBadging(badging) {
  const match = typeof badging === 'string' ? badging.match(/^sdkVersion:'(\d+)'/m) : null;
  return match ? toSdk(match[1]) || null : null;
}

/**
 * The file's minimum Android API (a bundle's is its base APK's), or null if
 * it can't be read.
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {boolean} [opts.isBundle]
 * @param {Function} [opts.execFileSyncImpl]
 * @param {object} [opts.deadline] From createDeadline; defaults to 60 seconds.
 */
function readMinSdk(file, { isBundle = false, execFileSyncImpl = execFileSync, deadline } = {}) {
  try {
    const { badging } = readBaseBadging(file, isBundle, execFileSyncImpl, deadline || createDeadline(READ_BUDGET_MS));
    return parseMinSdkFromBadging(badging);
  } catch (e) {
    console.error(`[min-sdk] Could not read the minimum Android of ${path.basename(String(file))}: ${e.message}`);
    return null;
  }
}

/**
 * Pure. Compare a file's minimum Android with the floor.
 * @returns {{ ok: boolean, sdk: number|null, floor: number }} ok is false only
 *   when the file's minSdk is known and below the floor.
 */
function checkMinSdk(sdk, floor) {
  return { ok: !(floor > 0 && sdk != null && sdk < floor), sdk: sdk ?? null, floor };
}

/**
 * Decide whether a file already on disk may be used: no floor, an unreadable
 * minimum Android, or a minimum at or above the floor. Logs what it decides.
 *
 * @param {string} file
 * @param {number} floor
 * @param {object} [opts] Passed to readMinSdk, plus readImpl to replace it.
 * @returns {{ ok: boolean, sdk: number|null }}
 */
function checkFileMinSdk(file, floor, opts = {}) {
  if (!floor) return { ok: true, sdk: null };
  const sdk = opts.readImpl ? opts.readImpl(file) : readMinSdk(file, opts);
  if (sdk == null) {
    console.error(`[min-sdk] ${path.basename(String(file))}: minimum Android unknown; keeping the file (the patcher will judge it)`);
    return { ok: true, sdk: null };
  }
  if (checkMinSdk(sdk, floor).ok) return { ok: true, sdk };
  console.error(`[min-sdk] ${path.basename(String(file))}: build is for Android API ${sdk}+, the patches need API ${floor}+`);
  return { ok: false, sdk };
}

/** True unless checkFileMinSdk rejects the file. */
function fileMeetsMinSdk(file, floor, opts = {}) {
  return checkFileMinSdk(file, floor, opts).ok;
}

/** Pure. "Android 11" for a known API level, else "API 99". */
function androidLabel(api) {
  return ANDROID_NAMES[api] ? `Android ${ANDROID_NAMES[api]}` : `API ${api}`;
}

/** Pure. The message of the final error when downloads were rejected for minSdk. */
function wrongBuildMessage({ appId, version, rejectedSdks, floor, arch }) {
  const highest = Math.max(...rejectedSdks);
  return `Wrong build: every download of ${appId} ${version} was for older Android (API ${highest}+); `
    + `the patches need API ${floor}+. `
    + `Patch the ${arch} (${androidLabel(floor)}+) build of ${appId} instead.`;
}

module.exports = {
  ANDROID_NAMES,
  minSdkFromConfig,
  parseMinSdkFromBadging,
  readMinSdk,
  checkMinSdk,
  checkFileMinSdk,
  fileMeetsMinSdk,
  androidLabel,
  wrongBuildMessage,
};
