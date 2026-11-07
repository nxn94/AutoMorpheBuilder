'use strict';

/**
 * Infer an APKMirror release-page URL for a version that `/all-versions/`
 * doesn't list.
 *
 * `/all-versions/` only shows the newest releases (about ten), so for an
 * app that releases often the version the patches support can already have
 * dropped off it. `resolveApkmirrorReleaseSlug` then falls back to
 * `buildReleasePageUrl`, which reuses the last part of `apkmirror_path` as
 * the release name. That 404s whenever APKMirror names releases
 * differently from the app path, e.g. LinkedIn:
 *
 *   apkmirror_path   linkedin/linkedin-linkedin
 *   release pages    linkedin-community-network-<version>-release
 *
 * The releases that ARE listed share the name pattern, so learn it from
 * them: split each listed release directory where the rest is a version
 * with as many dot-separated parts as the wanted one (so a name ending in
 * a number, e.g. "flightradar24-flight-tracker-2-11-12-0", splits in the
 * right place), take the most common name, and apply it to the wanted
 * version. A trailing -rcN / -betaN / -alphaN is ignored when splitting.
 *
 * Pure: no I/O. The caller passes the hrefs found on the page.
 */

const PRE_RELEASE_SUFFIX = /(?:-(?:rc|beta|alpha)\d*)?$/;

/**
 * Release name before the version in a release directory such as
 * "linkedin-community-network-4-1-1271-release", for a version with
 * `parts` numeric parts. Null when the directory doesn't end in such a
 * version.
 *
 * @param {string} dir
 * @param {number} parts
 * @returns {string|null}
 */
function releaseNamePrefix(dir, parts) {
  const m = /^(.+)-release$/.exec(dir);
  if (!m) return null;
  const bits = m[1].replace(PRE_RELEASE_SUFFIX, '').split('-');
  if (bits.length <= parts) return null;
  if (!bits.slice(-parts).every((b) => /^\d+$/.test(b))) return null;
  return bits.slice(0, -parts).join('-');
}

/**
 * @param {string[]} hrefs        links found on the /all-versions/ page
 * @param {string} apkmirrorPath  e.g. "linkedin/linkedin-linkedin"
 * @param {string} version        e.g. "4.1.1261"
 * @returns {string|null} absolute release-page URL, or null when no listed
 *   release of this app gives a name pattern
 */
function inferReleaseUrl(hrefs, apkmirrorPath, version) {
  const parts = String(version).split('.').length;
  const base = `/apk/${apkmirrorPath}/`;
  const counts = new Map();
  for (const raw of hrefs || []) {
    if (typeof raw !== 'string') continue;
    let parsed;
    try {
      parsed = new URL(raw, 'https://www.apkmirror.com');
    } catch {
      continue;
    }
    if (parsed.origin !== 'https://www.apkmirror.com' || parsed.username || parsed.password || parsed.search || parsed.hash) continue;
    const href = parsed.pathname;
    if (!href.startsWith(base)) continue;
    const dir = href.slice(base.length).replace(/\/$/, '');
    if (!dir || dir.includes('/')) continue;
    const prefix = releaseNamePrefix(dir, parts);
    if (prefix) counts.set(prefix, (counts.get(prefix) || 0) + 1);
  }
  if (!counts.size) return null;
  const [prefix] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return `https://www.apkmirror.com${base}${prefix}-${String(version).replace(/\./g, '-')}-release/`;
}

module.exports = { inferReleaseUrl, releaseNamePrefix };
