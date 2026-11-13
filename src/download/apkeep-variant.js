'use strict';

const { versionMatches } = require('./version-match');

/**
 * APKPure protobuf URL parsing extracted from
 * `.github/scripts/unified-downloader.js#resolveApkeepVariant`.
 *
 * APKPure's `/m/v3/cms/app_version` endpoint returns a ~400KB
 * protobuf body with XAPK download URLs embedded inline. Each URL
 * encodes the variant metadata inside the `c` query param as
 * pipe-separated base64-encoded URL-encoded params:
 *
 *   c=<counter>|<category>|<base64(rest)>
 *   rest → "dev=<name>&t=<type>&s=<size>&vn=<version>&vc=<version_code>"
 *
 * The arm64-v8a variant is consistently the smallest of the three
 * per-app variants APKPure serves, so picking the smallest
 * matching URL gives us the arm64-only build we want.
 *
 * Two pure functions:
 *   - parseApkeepXapkUrls(body, version)  → array of matching URLs
 *     in declared-size order (smallest first)
 *   - decodeApkeepCParam(c)               → the inner params object
 *     parsed from the `c` query string
 *
 * The fetch call and the cheerio-equivalent protobuf parsing stays
 * in the downloader; only the URL selection / variant-picking
 * logic moves here. Tests can drive the parsers with a canned
 * body that mimics the real protobuf shape.
 */

// Match every XAPK download URL APKPure returned for this package.
// The regex tolerates trailing non-printable framing bytes that the
// protobuf response appends to the URL (verified by greping the
// real response bytes — the URL is followed by framing bytes like
// `d2 01 f8 01 0a`).
const XAPK_URL_RE = /https?:\/\/download\.pureapk\.com\/b\/XAPK\/[^"\s\\]+/g;

/**
 * Decode the `c=<counter>|<category>|<base64(rest)>` query
 * param into a plain params object.
 *
 * @param {string} c The raw `c` query-param value.
 * @returns {Record<string, string>|null} The decoded inner
 *   params, or null on any decode error. The downloader treats
 *   a null result as "no usable size metadata" so the URL can
 *   still be considered for selection — just sorted with size=0.
 */
function decodeApkeepCParam(c) {
  if (typeof c !== 'string' || c.length === 0) return null;
  const parts = c.split('|');
  if (parts.length < 3) return null;
  try {
    const decoded = Buffer.from(parts[2], 'base64').toString('utf8');
    const innerParams = new URLSearchParams(decoded);
    const out = {};
    for (const [k, v] of innerParams.entries()) out[k] = v;
    return out;
  } catch {
    return null;
  }
}

/**
 * Every matching XAPK URL for the requested version, smallest declared
 * size first (ties keep their order in the body). Empty when none match.
 *
 * @param {string} body The raw protobuf response body (mixed
 *   metadata + URLs).
 * @param {string} version The version string to match against
 *   the `vn` field of each XAPK URL's inner params.
 * @returns {string[]} The matching URLs, smallest first.
 */
function listMatchingVariants(body, version) {
  if (typeof body !== 'string' || !version) return [];
  const rawUrls = body.match(XAPK_URL_RE) || [];
  // Strip non-printable bytes that leak past the URL boundary —
  // the protobuf response is binary, the URL is followed by
  // framing bytes that the regex preserves.
  const cleaned = rawUrls.map((u) => u.replace(/[^\x20-\x7e]/g, ''));

  const withSize = [];
  for (const url of cleaned) {
    try {
      const inner = decodeApkeepCParam(new URL(url).searchParams.get('c'));
      if (inner == null || !versionMatches(inner.vn, version)) continue;
      // A URL without usable size metadata is still considered, just sorted low.
      withSize.push({ url, size: parseInt(inner.s || '0', 10) || 0 });
    } catch {
      /* not a parsable URL: not a candidate */
    }
  }
  // Stable sort: the arm64-v8a variant is usually the smallest of the
  // per-app variants APKPure serves.
  withSize.sort((a, b) => a.size - b.size);
  return withSize.map((v) => v.url);
}

/**
 * Pick the matching XAPK URL with the smallest declared size for
 * the requested version. Returns null when no XAPK URL in the body
 * matches.
 *
 * @param {string} body The raw protobuf response body.
 * @param {string} version The version to match.
 * @returns {string|null} The selected XAPK URL, or null.
 */
function pickSmallestMatchingVariant(body, version) {
  return listMatchingVariants(body, version)[0] ?? null;
}

/**
 * What identifies an APKPure variant across listings. Download URLs differ
 * between fetches (per-request tokens), so a variant is its decoded build
 * number plus declared size (`build:<vc>:<size>`). A URL without usable
 * metadata is identified by itself; an existing key is returned unchanged.
 *
 * @param {string} urlOrKey
 * @returns {string}
 */
function variantKey(urlOrKey) {
  if (typeof urlOrKey !== 'string' || urlOrKey.startsWith('build:')) return urlOrKey;
  try {
    const inner = decodeApkeepCParam(new URL(urlOrKey).searchParams.get('c'));
    const vc = inner?.vc || '';
    if (/^\d+$/.test(vc)) return `build:${vc}:${parseInt(inner.s || '0', 10) || 0}`;
  } catch {
    /* not a parsable URL: identified by itself */
  }
  return urlOrKey;
}

/**
 * The build number behind a variant URL (its `vc`), an exact-build URL
 * (`?versionCode=N`) or a variantKey / `build:<code>` key; null if none.
 *
 * @param {string} urlOrKey
 * @returns {string|null}
 */
function buildCodeOf(urlOrKey) {
  if (typeof urlOrKey !== 'string') return null;
  const key = /^build:(\d+)(?::\d+)?$/.exec(urlOrKey);
  if (key) return key[1];
  try {
    const u = new URL(urlOrKey);
    const exact = u.searchParams.get('versionCode');
    if (exact && /^\d+$/.test(exact)) return exact;
    const code = versionCodeOf(urlOrKey);
    return code ? String(code) : null;
  } catch {
    return null;
  }
}

/**
 * The build number when the string names one build alone: an exact-build URL
 * (`?versionCode=N`) or a `build:<code>` key without a size. Variants of
 * one version can share a `vc` while differing in size, so a variant URL or
 * a `build:<code>:<size>` key does not count; null for those.
 *
 * @param {string} urlOrKey
 * @returns {string|null}
 */
function exactBuildOf(urlOrKey) {
  if (typeof urlOrKey !== 'string') return null;
  const key = /^build:(\d+)$/.exec(urlOrKey);
  if (key) return key[1];
  try {
    const exact = new URL(urlOrKey).searchParams.get('versionCode');
    return exact && /^\d+$/.test(exact) ? exact : null;
  } catch {
    return null;
  }
}

/**
 * The matching variants other than the ones already tried, smallest first.
 * Used when the variant APKPure's smallest-first pick gave was rejected
 * (e.g. built for too old an Android) and the rest are worth a try.
 *
 * @param {string} body
 * @param {string} version
 * @param {string|string[]} tried URL(s), variantKey(s) or `build:<code>` keys
 *   already tried. A variant counts as tried when its build number and size match
 *   one of them, even if its URL differs from the one fetched earlier.
 * @returns {string[]}
 */
function remainingMatchingVariants(body, version, tried) {
  const list = Array.isArray(tried) ? tried : [tried];
  const skipKeys = new Set(list.map(variantKey));
  const skipBuilds = new Set(list.map(exactBuildOf).filter(Boolean));
  // (a variant of the same build but another size is a different file, so only a build named alone counts)
  return listMatchingVariants(body, version).filter((u) => !skipKeys.has(variantKey(u)) && !skipBuilds.has(buildCodeOf(u)));
}

/**
 * The build number (`vc`) inside an APKPure download URL's `c` param.
 *
 * @param {string|null} url A URL from pickSmallestMatchingVariant.
 * @returns {number|null} A positive whole number, or null when the URL
 *   has none (or an unusable one).
 */
function versionCodeOf(url) {
  if (typeof url !== 'string') return null;
  try {
    const inner = decodeApkeepCParam(new URL(url).searchParams.get('c'));
    const raw = inner?.vc || '';
    const code = Number(raw);
    return /^\d+$/.test(raw) && Number.isSafeInteger(code) && code > 0 ? code : null;
  } catch {
    return null;
  }
}

module.exports = {
  decodeApkeepCParam,
  listMatchingVariants,
  remainingMatchingVariants,
  variantKey,
  buildCodeOf,
  exactBuildOf,
  pickSmallestMatchingVariant,
  versionCodeOf,
};
