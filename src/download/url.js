'use strict';

/**
 * URL building for the downloader.
 *
 * Pure network-independent helpers extracted from
 * `.github/scripts/unified-downloader.js`. Kept side-effect free so
 * they can be unit-tested without standing up a downloader — the
 * downloader now imports these and orchestrates them around the
 * actual HTTP/Playwright fetches.
 *
 * Functions:
 *   - buildReleasePageUrl     pure URL construction for an APKMirror
 *                             release page
 *   - apkmirrorReleaseTailCandidates  pure list of dashed-version
 *                                     suffix tails (exact, rc, beta,
 *                                     alpha) tried in order when
 *                                     APKMirror's slug includes a
 *                                     pre-release marker
 *   - apkMirrorAuthHeader     Basic auth header from configured
 *                             credentials; throws when either
 *                             APKMIRROR_API_USER or APKMIRROR_API_PASS
 *                             is missing
 */

/**
 * Build APKMirror release page URL for a given version.
 * Slug is derived from the last path component of apkmirrorPath.
 * e.g. "google-inc/youtube" + "20.44.38" → ".../youtube-20-44-38-release/"
 */
function buildReleasePageUrl(apkmirrorPath, version) {
  const slug = apkmirrorPath.split('/').pop();
  const versionSlug = version.replace(/\./g, '-');
  return `https://www.apkmirror.com/apk/${apkmirrorPath}/${slug}-${versionSlug}-release/`;
}

/**
 * Pre-release suffixes APKMirror inserts between the version and the
 * trailing `-release/` segment when a developer uploads a release
 * candidate, beta, or alpha build. The upstream patch repo (and
 * `patches-list.json`) usually records the bare version (e.g. `2.0.2`),
 * but APKMirror's URL slug uses the pre-release form (`2.0.2-rc0`),
 * which our `<dashedVersion>-release/` selector would miss. We try the
 * exact match first, then progressively widen to common suffixes so
 * apps like SD Maid (2.0.2 → /sd-maid-2-se-system-cleaner-2-0-2-rc0-release/)
 * resolve without per-app configuration.
 *
 * Ordered by frequency on APKMirror; rc0..rc9 covers the full release
 * candidate sequence.
 */
function apkmirrorReleaseTailCandidates(version) {
  const tails = [`-${version.replace(/\./g, '-')}-release/`];
  for (let i = 0; i <= 9; i += 1) {
    tails.push(`-${version.replace(/\./g, '-')}-rc${i}-release/`);
  }
  tails.push(`-${version.replace(/\./g, '-')}-beta-release/`);
  tails.push(`-${version.replace(/\./g, '-')}-beta1-release/`);
  tails.push(`-${version.replace(/\./g, '-')}-alpha-release/`);
  tails.push(`-${version.replace(/\./g, '-')}-alpha1-release/`);
  return tails;
}

/**
 * Build the Authorization header for APKMirror's wp-json API.
 *
 * @param {object} [env=process.env] Override for the env object —
 *                                tests pass a stub so they don't
 *                                depend on process.env state.
 *                                The default (process.env) is what
 *                                production callers use.
 * @returns {string} `Basic <base64(user:pass)>`.
 * @throws {Error} When either APKMIRROR_API_USER or APKMIRROR_API_PASS
 *                 is unset. The caller's fallback chain
 *                 (apkeep → apkmirror Playwright) is used in that case;
 *                 the apkmirror-api path is just one of several
 *                 resolution sources.
 */
function apkMirrorAuthHeader(env) {
  const source = env || process.env;
  const user = source.APKMIRROR_API_USER;
  const pass = source.APKMIRROR_API_PASS;
  if (!user || !pass) {
    throw new Error(
      'APKMIRROR_API_USER and/or APKMIRROR_API_PASS are not set. ' +
      'Configure them as repo secrets to enable the APKMirror-API ' +
      'resolution path; the fallback chain (apkeep → apkmirror Playwright) ' +
      'will be used otherwise.',
    );
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

module.exports = {
  buildReleasePageUrl,
  apkmirrorReleaseTailCandidates,
  apkMirrorAuthHeader,
};
