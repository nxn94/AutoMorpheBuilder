'use strict';

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
 * Pick the matching XAPK URL with the smallest declared size for
 * the requested version. Returns null when no XAPK URL in the body
 * matches.
 *
 * @param {string} body The raw protobuf response body (mixed
 *   metadata + URLs).
 * @param {string} version The version string to match against
 *   the `vn` field of each XAPK URL's inner params.
 * @returns {string|null} The selected XAPK URL, or null.
 */
function pickSmallestMatchingVariant(body, version) {
  if (typeof body !== 'string' || !version) return null;
  const rawUrls = body.match(XAPK_URL_RE) || [];
  // Strip non-printable bytes that leak past the URL boundary —
  // the protobuf response is binary, the URL is followed by
  // framing bytes that the regex preserves.
  const cleaned = rawUrls.map((u) => u.replace(/[^\x20-\x7e]/g, ''));

  const matching = cleaned.filter((u) => {
    try {
      const parsed = new URL(u);
      const inner = decodeApkeepCParam(parsed.searchParams.get('c'));
      return inner != null && inner.vn === version;
    } catch {
      return false;
    }
  });

  if (matching.length === 0) return null;

  // Sort by declared size; the arm64-v8a variant is the smallest
  // of the three per-app variants APKPure serves.
  const withSize = matching.map((url) => {
    let size = 0;
    try {
      const parsed = new URL(url);
      const inner = decodeApkeepCParam(parsed.searchParams.get('c'));
      size = parseInt(inner?.s || '0', 10) || 0;
    } catch {
      /* size stays 0 — the URL is still considered, just sorted low */
    }
    return { url, size };
  });
  withSize.sort((a, b) => a.size - b.size);

  return withSize[0].url;
}

module.exports = {
  decodeApkeepCParam,
  pickSmallestMatchingVariant,
};
