'use strict';

/**
 * Does an APK's versionName match the version the patches ask for?
 *
 * Some apps add a label after the version number:
 *
 *   Gboard   "18.5.4.993608717-release-arm64-v8a"  (patches say "18.5.4.993608717")
 *   Discord  "351.11 - Stable"                     (patches say "351.11")
 *
 * With an exact comparison, every correct download of these apps is
 * rejected and the build fails.
 *
 * So this accepts an exact match, or the version followed by "-" or a
 * space and then a label. The number itself must match in full: "2026.40.01"
 * or "2026.40.0.1" never pass for "2026.40.0". A label that marks a test
 * build ("-beta2", " rc1", "-dev"...) is still rejected, because that's a
 * different build from the one the patches name.
 */

const PRE_RELEASE = /(?:^|[^a-z])(?:alpha|beta|rc|dev|canary|preview|nightly|snapshot|debug|internal)(?:[^a-z]|$)/i;

/**
 * @param {string} actual    versionName read from the APK
 * @param {string} expected  version the patches / resolver asked for
 * @returns {boolean}
 */
function versionMatches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !actual || !expected) return false;
  if (actual === expected) return true;
  if (!actual.startsWith(`${expected}-`) && !actual.startsWith(`${expected} `)) return false;
  return !PRE_RELEASE.test(actual.slice(expected.length));
}

module.exports = { versionMatches, PRE_RELEASE };
