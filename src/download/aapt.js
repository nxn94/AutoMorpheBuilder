'use strict';

/**
 * aapt version-validation helpers extracted from
 * `.github/scripts/unified-downloader.js`.
 *
 * The downloader calls `validateApkVersion` after a download to
 * confirm the APK actually matches the requested version — APK
 * caches can be stale, upstream CDNs can serve a different build,
 * and the merge step needs the right version regardless of how
 * the file got there.
 *
 * Two pieces:
 *   - `parseVersionFromBadging(stdout)` — extract `versionName='X'`
 *     from the badging dump. Pure regex on the captured aapt
 *     output. No I/O, no shell.
 *   - `validateApkVersion(apkPath, expectedVersion, opts)` —
 *     shell out to aapt (or aapt2), parse the badging output,
 *     compare against the expected version. Returns the same
 *     `{ valid, actualVersion, error? }` shape callers already
 *     destructure.
 *
 * The `execFileSyncImpl` injection lets tests pin the aapt
 * subprocess without standing up the real Android SDK build
 * tools; production callers omit it and get the standard
 * `child_process.execFileSync`. The argv-form invocation avoids
 * any shell interpolation of `apkPath` (defense-in-depth for an
 * untrusted download whose filename originates upstream).
 */

const VERSION_NAME_RE = /versionName='([^']+)'/;

/**
 * Extract `versionName='X'` from an aapt/aapt2 badging dump.
 *
 * @param {string} badgingStdout Raw stdout from
 *   `aapt[aapt2] dump badging <apkPath>`.
 * @returns {string|null} The captured version, or null when the
 *   badging dump doesn't carry a versionName line (rare — only
 *   happens for malformed APKs or non-Android zip inputs).
 */
function parseVersionFromBadging(badgingStdout) {
  if (typeof badgingStdout !== 'string') return null;
  const match = badgingStdout.match(VERSION_NAME_RE);
  return match ? match[1] : null;
}

/**
 * Validate APK version matches expected version using aapt.
 *
 * Tries `aapt` first, then falls back to `aapt2` (the modern
 * build-tool) if `aapt` is missing or fails on the input. Both
 * invocations use argv arrays so `apkPath` is never interpolated
 * into a shell string. The split here means the test surface
 * only has to stub one execFileSyncImpl to drive both branches.
 *
 * @param {string} apkPath Absolute path to the downloaded APK.
 * @param {string} expectedVersion The version the resolver
 *   targeted — typically the packageId's version pulled from
 *   config.json / patches-list.json.
 * @param {object} [opts]
 * @param {(cmd: string, args: string[], options?: object) => string|Buffer} [opts.execFileSyncImpl]
 *   Override for the aapt subprocess. Tests pass a stub that
 *   returns canned badging output. Production callers omit it.
 * @returns {{ valid: boolean, actualVersion: string, error?: string }}
 *   `valid: true` means the captured version matched
 *   `expectedVersion`. `valid: false` carries `error` with the
 *   reason (no aapt, no versionName, mismatch).
 */
function validateApkVersion(apkPath, expectedVersion, opts = {}) {
  // Lazy require so the module-load cost only hits the
  // validateApkVersion path (it's not used by the URL-only
  // resolver paths).
  const { execFileSync } = require('node:child_process');
  const execFileSyncImpl = opts.execFileSyncImpl || execFileSync;

  let output;
  try {
    output = execFileSyncImpl('aapt', ['dump', 'badging', apkPath], { encoding: 'utf8' });
  } catch (_e) {
    try {
      output = execFileSyncImpl('aapt2', ['dump', 'badging', apkPath], { encoding: 'utf8' });
    } catch (_e2) {
      return {
        valid: false,
        actualVersion: 'unknown',
        error: 'aapt not available - cannot validate version',
      };
    }
  }

  const actualVersion = parseVersionFromBadging(output);

  if (!actualVersion) {
    return {
      valid: false,
      actualVersion: 'unknown',
      error: 'could not extract version from APK',
    };
  }

  if (actualVersion !== expectedVersion) {
    return {
      valid: false,
      actualVersion,
      error: `version mismatch: got ${actualVersion}, wanted ${expectedVersion}`,
    };
  }

  return { valid: true, actualVersion };
}

module.exports = {
  parseVersionFromBadging,
  validateApkVersion,
};
