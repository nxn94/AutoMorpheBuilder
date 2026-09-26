'use strict';

/**
 * Cookie-jar helpers extracted from
 * `.github/scripts/unified-downloader.js`.
 *
 * `collectCookies(response, existing)` merges the cookies in a fetch
 * `Response`'s `Set-Cookie` headers into the jar object passed as
 * `existing`. Pure transformation: no I/O, no network, no mutation
 * of the input — new cookies overwrite same-named keys in the
 * returned jar, the rest of the jar is unchanged.
 *
 * `getSetCookie()` is the WHATWG-fetch API for reading the array of
 * Set-Cookie values off a response. Older `get('set-cookie')` returns
 * a comma-joined string that's unsafe to split on `,` because
 * `Expires=Wed, 09 Nov 2026 07:28:00 GMT` contains one. Using
 * `getSetCookie()` avoids that whole class of bug.
 */

/**
 * @param {object} response Fetch Response-like; only `headers.getSetCookie()`
 *                         is read.
 * @param {object} [existing={}] Current cookie jar. The returned
 *                              jar is a fresh object; the input is
 *                              not mutated.
 * @returns {object} Merged cookie jar.
 */
function collectCookies(response, existing = {}) {
  const setCookies = response.headers?.getSetCookie?.() ?? [];
  if (setCookies.length === 0) return { ...existing };
  const cookies = { ...existing };
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) continue; // Skip malformed cookies (no `=` or `=` at index 0).
    cookies[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return cookies;
}

module.exports = {
  collectCookies,
};
