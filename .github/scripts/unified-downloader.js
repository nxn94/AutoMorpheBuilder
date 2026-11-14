#!/usr/bin/env node
const { withApkmirrorPacing } = require('./apkmirror-pacing');

/**
 * Unified APK Downloader
 * Downloads APK files from multiple sources with fallback chain:
 * 1. URL cache (~/.cache/auto-morphe-builder/urls/)
 * 2. config.json download_urls (auto-managed)
 * 3. apkeep (APKPure) - try first
 * 4. APKMirror API - second
 * 5. apkmirror with Playwright - last resort
 *
 * Resolved URLs are cached so subsequent builds can skip the network round-trip.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("child_process");
const { chromium } = require("playwright");
const os = require("node:os");
const cheerio = require('cheerio');
const { downloadWithGoopdl } = require('./goopdl-downloader');
const { openApkmirror, navigateApkmirror, extractVersionCode } = require('./apkmirror-browser');
const { validateDownloadedApkAbi } = require('./apk-abi-validator');
const { detectApkShape } = require('./apk-selection');
// Network-independent URL/auth helpers extracted to a pure module so
// they can be unit-tested without standing up the downloader. The
// downloader imports them and orchestrates them around the actual
// HTTP/Playwright fetches below.
const {
  buildReleasePageUrl,
  apkmirrorReleaseTailCandidates,
  apkMirrorAuthHeader,
} = require('../../src/download/url');
const {
  buildVariantPriorities,
  selectVariant,
} = require('../../src/download/variant');
const { collectCookies } = require('../../src/download/cookies');
const {
  getCachedUrl,
  saveCachedUrl,
  removeCachedUrl,
  cleanupOldUrls,
} = require('../../src/download/cache');
const { loadConfig, loadExistingUrl } = require('../../src/download/config');
const { parseArgs } = require('../../src/download/cli-args');
const { validateApkVersion } = require('../../src/download/aapt');
const { findApkFile } = require('../../src/download/scan');
const { pickSmallestMatchingVariant, remainingMatchingVariants, variantKey, buildCodeOf, exactBuildOf, versionCodeOf } = require('../../src/download/apkeep-variant');
const { inferReleaseUrl } = require('../../src/download/release-slug');
const apkpureExact = require('../../src/download/apkpure-exact');
const minSdkLib = require('../../src/download/min-sdk');

// Source priority for the resolver fallback chain. Higher = preferred.
// This is the single source of truth for the order in which APK sources
// are tried — both the parallel resolver (parallelResolveSources) and
// the sequential fallback (download) consult it. The numeric gaps are
// intentional so future sources can be inserted between tiers without
// renumbering (e.g. a new "f-droid" tier could land at 175 between
// apkmirrorApi and apkmirrorHtml).
//
// Mapping between priority keys and the legacy inline names:
//   apkeep        ↔ 'apkeep'        (used by parallelResolveSources sources[])
//   apkmirrorApi  ↔ 'apkmirror-api' (the wp-json API path)
//   apkmirrorHtml ↔ 'apkmirror'     (the Playwright HTML-scraper fallback)
//
// local / cache / configured are not yet wired into parallelResolveSources
// (they short-circuit before the resolver runs); they are reserved here so
// the priority table is a complete picture of the resolver pipeline.
const SOURCE_PRIORITY = {
  local: 500,
  cache: 400,
  configured: 300,
  apkeep: 200,
  apkmirrorApi: 150,
  apkmirrorHtml: 100,
};

// Centralized timeout knobs (ms). Each one is named after the call site
// where it applies, so a "why is apkeep hanging" question lands on the
// right line in a single place. Tune these in one spot rather than
// chasing inline magic numbers through the file.
const TIMEOUTS = {
  urlVerify:           5_000,   // HEAD probe for a cached URL.
  apkeepResolve:      60_000,   // apkeep source resolution.
  apkeepDownload:    180_000,   // apkeep APK download.
  sourceResolve:      60_000,   // per-source timeout for parallelResolveSources.
  commandDefault:    120_000,   // runCommand fallback when no override given.
  playwrightDownload:120_000,   // page.waitForEvent('download') ceiling.
  apkpureVariants:   150_000,   // all of APKPure's other variants of one version, together.
  totalDownload:     540_000,   // download(): best effort, no new step after this once a build was rejected (the caller kills at 600 s).
  minStepRemaining:   30_000,   // ...and none is started with less than this left.
};

/**
 * Get APKMirror path for a package from config.json patch_repos.
 */
function getApkmirrorPath(packageId) {
  const config = loadConfig();
  return config.patch_repos?.[packageId]?.apkmirror_path || null;
}

// buildReleasePageUrl, apkmirrorReleaseTailCandidates, and
// apkMirrorAuthHeader now live in src/download/url.js (imported at
// the top of this file). They were extracted because the downloader
// grew past 1800 lines and these helpers are pure network-
// independent logic that the apkmirror-scraper test suite already
// exercises; they're now reachable as a focused unit-test target.

/**
 * Resolve APKMirror's actual release-page slug for a given (path, version).
 *
 * APKMirror's `apkmirror_path` config value points at the package's index
 * page (e.g. `sofascore/soccer-scores-and-sports-livescore-sofascore`), but
 * individual release pages use a SEPARATE slug baked into the URL — and
 * the slug for the same package can drift over time. Sofascore is the
 * canonical example:
 *   apkmirror_path → sofascore/soccer-scores-and-sports-livescore-sofascore
 *   2024 releases   → /apk/.../soccer-scores-and-sports-livescore-sofascore-<ver>-release/
 *   2025+ releases  → /apk/.../sofascore-live-sports-scores-<ver>-release/
 *
 * `buildReleasePageUrl` derives the slug from the last path component
 * (`soccer-scores-and-sports-livescore-sofascore`), which happens to
 * match for old releases and YouTube (where `google-inc/youtube`'s last
 * component is the same `youtube` the release URL uses), but 404s on
 * Sofascore's 2025+ releases. Without this fix the Playwright fallback
 * can't reach the variant table for the Morphe-supported 26.07.27.
 *
 * We scrape the package's `/all-versions/` page (a single fetch — no
 * pagination; `show-more` is purely a visual fold that hides nothing
 * from the HTML source) and match the URL whose tail ends in
 * `<dashed-version>-release/`. We always return the path observed on
 * APKMirror's server — never a fabricated one. When the upstream
 * version lacks the rc/beta/alpha suffix that APKMirror bakes into
 * the slug (e.g. `2.0.2` vs `2-0-2-rc0`), we widen the selector to
 * common pre-release suffixes before giving up.
 *
 * `/all-versions/` only lists the newest releases (about ten), so an
 * often-updated app's supported version can be missing from it. Then the
 * release name is inferred from the listed releases (`inferReleaseUrl` in
 * `src/download/release-slug.js`), e.g. LinkedIn's
 * `linkedin-community-network-<ver>-release` under `linkedin/linkedin-linkedin`.
 * Like the path-slug fallback below it is a guess. A distinct inferred URL
 * gets one bounded existence check; HTTP 404 retains the path-slug fallback.
 * Other probe errors propagate so a block is not mistaken for a missing page.
 * The APK still goes through the usual validation.
 *
 * Falls back to `buildReleasePageUrl(apkmirrorPath, version)` on listing network
 * / parse errors so the existing path-slug contract still works for
 * apps whose release slug matches the path slug (YouTube, YT Music,
 * Reddit, …).
 *
 * @param {string} apkmirrorPath - Path from config (e.g. "sofascore/soccer-scores-and-sports-livescore-sofascore")
 * @param {string} version - Version (e.g. "26.07.27")
 * @param {object} [opts] - Inject for tests: { fetchImpl, cheerioImpl }
 * @returns {Promise<string>} Absolute release-page URL
 */
async function resolveApkmirrorReleaseSlug(apkmirrorPath, version, opts = {}) {
  // Reuse the warmed browser when available; curl remains the standalone
  // HTML path. Either transport may still be blocked by the runner's IP.
  const page = opts.page;
  const fetchImpl = opts.fetchImpl || apkmirrorFetch;
  const cheerioImpl = opts.cheerioImpl || cheerio;

  const listUrl = `https://www.apkmirror.com/apk/${apkmirrorPath}/all-versions/`;
  // Selector tail suffixes, ordered exact → rc0..rc9 → beta → alpha.
  // APKMirror slugs are case-stable; we don't normalize case because
  // the live HTML always emits lowercase for the path components we
  // observe in /all-versions/.
  const tailCandidates = apkmirrorReleaseTailCandidates(version);
  const fallback = buildReleasePageUrl(apkmirrorPath, version);
  let inferred;

  try {
    let html;
    if (page) {
      await navigateApkmirror(page, listUrl);
      html = await page.content();
    } else {
      // codeql[js/file-access-to-http] reason: listUrl is APKMirror's
      // public package index page; only the parsed HTML is read, no
      // file write.
      const response = await fetchImpl(listUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
      }
      html = await response.text();
    }
    const $ = cheerioImpl.load(html);

    // Every release row links to the release page with href ending in
    // `<dashed-version>[-rc0|rc1|…|beta|alpha]-release/`. We capture
    // that href verbatim — never reconstruct the slug from the
    // version. We prefer the exact match; the pre-release suffix
    // fallbacks only fire when the developer's patch repo records a
    // bare version (e.g. SD Maid `2.0.2` ↔ APKMirror `2.0.2-rc0`).
    let matchedTail = null;
    let matchedHref = null;
    for (const tail of tailCandidates) {
      const href = $(`a[href$="${tail}"]`).first().attr('href');
      if (href) {
        matchedTail = tail;
        matchedHref = href;
        break;
      }
    }
    if (matchedHref) {
      const abs = matchedHref.startsWith('http')
        ? matchedHref
        : `https://www.apkmirror.com${matchedHref}`;
      const suffixNote = matchedTail === tailCandidates[0] ? '' : ` (matched via fallback tail ${matchedTail})`;
      console.error(`[apkmirror-slug-resolve] ${apkmirrorPath} v${version} → ${abs}${suffixNote}`);
      return abs;
    }
    // Not listed (older than the newest releases on the page): apply the
    // listed releases' name pattern to this version.
    inferred = inferReleaseUrl($('a[href$="-release/"]').map((_, a) => $(a).attr('href')).get(), apkmirrorPath, version);
    if (!inferred) throw new Error(`No release link found ending in any of: ${tailCandidates.join(', ')}`);
  } catch (err) {
    if (err.status === 429) throw err;
    console.error(`[apkmirror-slug-resolve] ${apkmirrorPath} v${version} → fallback (${err.message})`);
    return fallback;
  }

  // Check only a distinct guess; a renamed app's old releases may retain the path slug.
  if (inferred !== fallback) {
    try {
      if (page) {
        await navigateApkmirror(page, inferred);
      } else {
        const response = await fetchImpl(inferred);
        if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} for inferred release`), { status: response.status });
      }
    } catch (err) {
      // A blocked request or network error does not prove that the guessed page is absent.
      if (err.status !== 404 || /Cloudflare block/.test(err.message)) throw err;
      console.error(`[apkmirror-slug-resolve] inferred release not found → ${fallback}`);
      return fallback;
    }
  }
  console.error(`[apkmirror-slug-resolve] ${apkmirrorPath} v${version} → ${inferred} (not listed; name inferred from listed releases)`);
  return inferred;
}

/**
 * Fetch HTML through the shared APKMirror origin gate using curl.
 * Neither curl nor Chromium guarantees access through upstream challenges.
 */
async function apkmirrorFetch(url, cookies = {}, referer = null) {
  return withApkmirrorPacing(async gate => {
    const execAsync = require('node:util').promisify(require('node:child_process').execFile);
    const args = [
      '-s', '-L', '--proto', '=https', '--proto-redir', '=https', '--max-time', '30', '-D', '-',
      '-A', 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      '-H', 'DNT: 1',
      '-w', '\n%{http_code}',
    ];
    if (referer) args.push('-H', `Referer: ${referer}`);
    if (Object.keys(cookies).length > 0) {
      args.push('-H', `Cookie: ${Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')}`);
    }
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.hostname !== 'www.apkmirror.com' || target.username || target.password || target.port) throw new Error('Invalid APKMirror URL');
    args.push('--', target.href);

    const { stdout: output } = await execAsync('curl', args, { timeout: 35000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
    const lastNewline = output.lastIndexOf('\n');
    const statusCode = parseInt(output.slice(lastNewline + 1).trim(), 10);
    let body = output.slice(0, lastNewline);
    let retryAfter;
    while (/^HTTP\/\S+ \d{3}/.test(body)) {
      const end = body.search(/\r?\n\r?\n/);
      if (end < 0) break;
      retryAfter = body.slice(0, end).match(/^retry-after:\s*(.+)$/im)?.[1]?.trim();
      body = body.slice(end).replace(/^\r?\n\r?\n/, '');
    }
    if (statusCode === 429) await gate.cooldown(retryAfter);

    if (statusCode >= 400) throw Object.assign(new Error(`HTTP ${statusCode} for ${url}`), { status: statusCode });

    return {
      text: async () => body,
      headers: { getSetCookie: () => [] },
      ok: statusCode < 400,
      status: statusCode,
    };
  });
}

// getCachedUrl / saveCachedUrl / cleanupOldUrls now live in
// src/download/cache.js (imported at the top of this file). They
// were extracted because the downloader grew past 1800 lines and
// these helpers are the local-file-cache foundation for every
// fallback-chain path. See src/download/cache.js for the
// packageDir / cacheFileFor layout and the documented race window
// in saveCachedUrl's mkdirSync({ recursive: true }).

/**
 * Verify URL still works with HEAD request
 * @param {string} url - URL to verify
 * @returns {Promise<boolean>} True if URL is valid
 */
async function verifyUrl(url) {
  // Input validation
  if (!url) {
    throw new Error('URL is required');
  }

  // Sanitize the URL string before it leaves the local trust boundary.
  //
  // verifyUrl is called with a URL string that originates from a
  // file read (cache.js reads ~/.cache/auto-morphe-builder/urls/*.json,
  // config.js reads config.json download_urls). CodeQL flags the
  // file → fetch edge as `js/file-access-to-http` even though the
  // cache file is only ever written by this module from a successful
  // resolver round-trip — the taint flow is real (file data reaches
  // a network sink) and defense-in-depth wants a sanitiser here
  // anyway.
  //
  // The fix is to round-trip the URL through the WHATWG URL parser
  // (new URL()) and require protocol=https:, then pass
  // `parsed.toString()` (not the raw input) into fetch. new URL()
  // is the recognised CodeQL sanitiser for the
  // js/file-access-to-http query — the flow becomes
  // "string → parsed URL → re-stringified URL → fetch" instead of
  // "string → fetch", and the protocol gate blocks any non-https
  // scheme that might have landed there via a tampered cache file
  // or a misauthored config.json entry.
  let safeUrl;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      console.error(`[url-cache] URL verify rejected: non-https scheme "${parsed.protocol}"`);
      return false;
    }
    safeUrl = parsed.toString();
  } catch (e) {
    console.error(`[url-cache] URL verify rejected: unparseable URL (${e.message})`);
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUTS.urlVerify);
  try {
    const response = await fetch(safeUrl, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    });

    const isValid = response.ok;
    console.error(`[url-cache] URL verify: ${isValid ? 'valid' : 'invalid'} (${response.status})`);
    return isValid;
  } catch (e) {
    console.error(`[url-cache] URL verify failed: ${e.message}`);
    return false;
  } finally {
    // clearTimeout must run on every path: success, fetch rejection,
    // AND the `return isValid` short-circuit above. Without the
    // finally, a successful early return leaves the AbortController
    // timer armed for the full `urlVerify` ceiling (5s default) — a
    // slow leak across every cache hit. clearTimeout on an already-
    // fired timer is a no-op, so this is also safe when the
    // timeout itself fired and aborted fetch.
    clearTimeout(timeout);
  }
}

/**
 * APKPure's version listing for a package (the protobuf body that
 * resolveApkeepVariant and the Google Play build-number lookup read).
 *
 * @param {string} packageId
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
async function fetchApkpureVersionListing(packageId, fetchImpl = fetch, signal) {
  const apiUrl = `https://api.pureapk.com/m/v3/cms/app_version?hl=en-US&package_name=${encodeURIComponent(packageId)}`;
  // codeql[js/file-access-to-http] reason: apiUrl is the public APKPure
  // protobuf endpoint; only the response text is returned, never
  // written to disk.
  const response = await fetchImpl(apiUrl, {
    signal: signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUTS.sourceResolve), signal]) : AbortSignal.timeout(TIMEOUTS.sourceResolve),
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'x-cv': '3172501',
      'x-sv': '29',
      'x-gp': '1',
    },
  });

  if (!response.ok) {
    throw new Error(`APKPure API returned ${response.status}`);
  }

  return response.text();
}

/**
 * Query APKPure's backend protobuf for every XAPK variant URL of a
 * given package, returning the arm64-v8a variant URL specifically.
 *
 * Background: apkeep's regex on APKPure's protobuf response captures
 * the FIRST XAPKJ URL — always the universal variant. For apps that
 * ship arm64-v8a-only xapks (Sofascore, Reddit, etc.), the universal
 * bundle's splits may only contain armeabi-v7a libs, leading to
 * post-merge ABI guardrail failures. Quoting the analysis outlined in
 * the header comment: APKPure's protobuf contains three XAPK URLs per
 * version (universal, arm64-v8a, armeabi-v7a), ordered by descending
 * size. The smallest variant is the arm64-v8a-only build.
 *
 * The download URL itself isn't parsable for arch — we have only the
 * size signal. We pick the smallest of the three matching URLs and
 * trust the size ordering. For Sofascore 26.07.27:
 *   universal     93_044_062 bytes
 *   arm64-v8a      57_302_642 bytes  ← smallest
 *   armeabi-v7a    89_218_647 bytes
 *
 * If the size heuristic ever fails (e.g. a future arm64-v8a bundle
 * bigger than armeabi-v7a), the fallback path through `apkeep` still
 * returns the universal variant — the build will fail at the ABI
 * guardrail with a clear "arm64-v8a libs missing" error rather than
 * silently shipping a wrong-arch APK.
 *
 * @param {string} packageId - Package ID (e.g. "com.sofascore.results")
 * @param {string} version - Version to resolve (e.g. "26.07.27")
 * @returns {Promise<string>} Direct download URL for the arm64-v8a variant
 */
async function resolveApkeepVariant(packageId, version) {
  const body = await fetchApkpureVersionListing(packageId);

  // URL/variant-selection logic (regex match, base64 `c` param
  // decode, version filter, size-based pick) lives in
  // src/download/apkeep-variant.js so it can be unit-tested
  // without standing up the protobuf endpoint. The downloader
  // keeps only the network call and the size logging here.
  const chosenUrl = pickSmallestMatchingVariant(body, version);
  if (!chosenUrl) {
    throw new Error(`No APKPure XAPK URLs found for ${packageId}@${version}`);
  }

  // Log the chosen size for observability — this mirrors the
  // pre-extraction log line operators used to grep for.
  try {
    const parsed = new URL(chosenUrl);
    const c = parsed.searchParams.get('c');
    if (c) {
      const parts = c.split('|');
      if (parts.length >= 3) {
        const decoded = Buffer.from(parts[2], 'base64').toString('utf8');
        const inner = new URLSearchParams(decoded);
        const size = inner.get('s') || '0';
        console.error(`[apkeep-resolve] APKPure arm64-v8a variant for ${packageId}@${version}: ${size} bytes`);
      }
    }
  } catch {
    /* size logging is best-effort — never block on it */
  }

  return chosenUrl;
}

/**
 * Resolve URL using apkeep (APKPure) - returns URL only, no download
 *
 * The default path hits APKPure's protobuf endpoint directly to pick
 * the arm64-v8a-only variant (see resolveApkeepVariant). The apkeep
 * binary is kept as a fallback — useful when APKPure's protobuf
 * response shape changes or the API is unavailable.
 *
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @param {object} [opts] - Optional command/source dependency overrides for tests
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkeep(packageId, version, opts = {}) {
  if (!packageId || !packageId.includes('.')) {
    throw new Error('Invalid packageId format');
  }
  if (!version) {
    throw new Error('Version is required');
  }

  console.error(`[apkeep-resolve] Resolving ${packageId} v${version}`);

  // Primary path: custom APKPure resolver that picks the arm64-v8a
  // variant. apkeep's regex would always pick the universal variant
  // (first URL by non-greedy match), which for apps like Sofascore
  // only ships armeabi-v7a libs and fails the post-merge ABI guardrail.
  try {
    const arm64Url = await resolveApkeepVariant(packageId, version);
    return { url: arm64Url, source: 'apkeep' };
  } catch (variantErr) {
    console.error(`[apkeep-resolve] Custom resolver failed (${variantErr.message}), falling back to apkeep binary`);
  }

  // Fallback: run apkeep with the preferred_arch hinted via the
  // x-abis header. apkeep 1.0.0 doesn't pick the arm64-v8a variant
  // from the response (its regex only captures the first URL), but the
  // future versions may. The sequential downloadWithApkeep will pick
  // up the actual download when the constructed URL fails.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkeep-'));
  const tempFile = path.join(tempDir, `${packageId}_${version}.apk`);

  return new Promise((resolve, reject) => {
    const args = ['-a', `${packageId}@${version}`, '-d', 'apk-pure', tempFile];

    const execFileImpl = opts.execFileImpl || execFile;
    execFileImpl('apkeep', args, { timeout: TIMEOUTS.apkeepResolve }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tempFile); fs.rmdirSync(tempDir); } catch (_e) { /* ignore */ }

      if (error) {
        console.error(`[apkeep-resolve] Failed: ${error.message}`);
        reject(new Error(`apkeep failed: ${error.message}${stderr ? ` - ${stderr}` : ''}`));
        return;
      }

      const url = `https://apkpure.com/${packageId.replace(/\./g, '/')}/${version}`;
      console.error(`[apkeep-resolve] Got APK via apkeep`);
      resolve({ url, source: 'apkeep' });
    });
  });
}

/**
 * Resolve URL using APKMirror API - returns URL only
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkmirrorApi(packageId, version) {
  console.error(`[apkmirror-api-resolve] Resolving ${packageId} v${version}`);

  const apkmirrorPath = getApkmirrorPath(packageId);
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path for ${packageId}`);
  }

  // CORRECT API endpoint with Basic auth
  const apiUrl = `https://www.apkmirror.com/wp-json/apkm/v1/${apkmirrorPath}/${version}`;

  // Intentional config-to-network flow: apkmirrorPath comes from the
  // maintainer-owned config.json and version is the selected APK version.
  // Only these public app selectors are sent to the fixed APKMirror host;
  // no arbitrary file content is included in headers or the request body.
  // CodeQL alert #41 is a reviewed false positive, not an inline suppression.
  try {
    const response = await fetch(apiUrl, {
    signal: AbortSignal.timeout(TIMEOUTS.sourceResolve),
      headers: {
        "Authorization": apkMirrorAuthHeader(),
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    const downloadUrl = data.downloadUrl;

    if (!downloadUrl) {
      throw new Error('No download URL in API response');
    }

    console.error(`[apkmirror-api-resolve] Got URL: ${downloadUrl}`);
    return { url: downloadUrl, source: 'apkmirror-api' };
  } catch (e) {
    console.error(`[apkmirror-api-resolve] Failed: ${e.message}`);
    throw e;
  }
}

/**
 * Resolve URL using APKMirror Playwright - returns URL only
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkmirror(packageId, version) {
  console.error(`[apkmirror-resolve] Resolving ${packageId} v${version}`);

  const apkmirrorPath = getApkmirrorPath(packageId);
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path for ${packageId}`);
  }

  // Use existing resolveApkmirrorUrl function (it already exists and returns URL)
  const url = await resolveApkmirrorUrl(apkmirrorPath, version);
  console.error(`[apkmirror-resolve] Got URL: ${url}`);

  return { url, source: 'apkmirror' };
}

/**
 * Download APK from a pre-resolved URL
 * @param {string} url - Direct URL to APK
 * @param {string} outputDir - Output directory
 * @param {string} packageId - Package ID
 * @param {string} version - Expected version
 * @param {object} [opts] - Optional process dependency overrides for tests
 * @returns {Promise<object>} Download result
 */
async function downloadWithUrl(url, outputDir, packageId, version, opts = {}) {
  // Cache/config strings are URLs, never curl options or local-file sources.
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:') throw new Error('Download URL must use HTTPS');
  if (parsedUrl.username || parsedUrl.password) throw new Error('Download URL must not contain credentials');
  const safeUrl = parsedUrl.toString();
  const spawnImpl = opts.spawnImpl || spawn;
  // Read preferred_arch so we can validate the downloaded file's ABI
  // composition. A 32-bit-only APK from upstream (e.g. APKMirror's
  // "universal" row that's actually armeabi-v7a-only, or APKPure's
  // single-arm fallback) must NOT be cached or handed back to the
  // caller — the caller's fallback chain then picks the next source.
  let preferredArchForUrl = '';
  try {
    preferredArchForUrl = loadConfig().preferred_arch || '';
  } catch { /* missing/invalid config — fall through, no validation */ }

  console.error(`[download-url] Downloading from: ${url}`);

  // Use curl for direct downloads
  const filename = `${packageId}_${version}.apk`;
  const outputPath = path.join(outputDir, filename);

  const sleep = opts.sleepImpl || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const MAX_RETRIES = 3;
  const limits = { timeoutMs: opts.timeoutMs, expired: opts.expired };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      console.error(`[download-url] Retry attempt ${attempt}/${MAX_RETRIES}...`);
      await sleep((attempt - 1) * 2000);
    }
    opts.signal?.throwIfAborted();

    // Restrict initial requests and redirects to HTTPS; terminate options
    // explicitly so no cached value can become a curl upload/config flag.
    try {
      const result = await new Promise((resolve, reject) => {
        const userAgentArgs = opts.userAgent ? ['-A', opts.userAgent] : [];
        const curl = spawnImpl('curl', ['-sS', ...userAgentArgs, '-L', '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '20', '--max-time', '180', '-o', outputPath, '-w', '%{http_code}', '--fail', '--', safeUrl], ...(opts.signal ? [{ signal: opts.signal }] : []));

        curl.on('error', reject);
        let stderr = '';

        curl.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        curl.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`curl failed: ${stderr.trim()}`));
            return;
          }

          // Validate downloaded file
          if (!fs.existsSync(outputPath)) {
            reject(new Error('Downloaded file not found'));
            return;
          }

          const stats = fs.statSync(outputPath);
          if (stats.size < 10000) { // Less than 10KB is probably an error
            reject(new Error(`Downloaded file too small: ${stats.size} bytes`));
            return;
          }

          // Validate APK version. Skip the aapt check for split packages
          // (zip-of-zips — aapt can't parse them). The post-merge verifier
          // in download-supported-apk.js re-checks the inner base.apk.
          // Content-based detection is required: the downloader hardcodes
          // the saved filename to `${packageId}_${version}.apk`,
          // extension-based detection would miss every split-package URL.
          const isSplitPackage = detectApkShape(outputPath, limits) === 'bundle';
          let validation = { valid: true, actualVersion: version };
          if (!isSplitPackage) {
            validation = validateApkVersion(outputPath, version, { execFileSyncImpl: opts.execFileSyncImpl, timeoutMs: opts.timeoutMs });
            if (!validation.valid) {
              // Cleanup-on-failure: same TOCTOU rationale as the
              // unlinkSync below.
              try { fs.unlinkSync(outputPath); } catch { /* best-effort */ }
              reject(new Error(`VERSION MISMATCH: expected ${version}, got ${validation.version}`));
              return;
            }
          } else {
            console.error(`[download-url] Split package detected — skipping aapt version check (caller validates inner base.apk)`);
          }

          // Validate ABI composition. The validator is bundle-aware
          // (apk-abi-validator.js): it extracts inner .apk files for
          // XAPK/APKM/APKS and checks each one for lib/<arch>/*.so.
          try {
            validateDownloadedApkAbi(outputPath, preferredArchForUrl, limits);
          } catch (e) {
            // Cleanup-on-failure: same rationale as VERSION MISMATCH.
            try { fs.unlinkSync(outputPath); } catch { /* best-effort */ }
            reject(e);
            return;
          }

          console.error(`[download-url] Downloaded and validated: ${outputPath} (${stats.size} bytes)`);
          resolve({
            success: true,
            path: outputPath,
            filename,
            version: validation.actualVersion,
            source: 'direct-url',
            url
          });
        });
      });

      return result;
    } catch (err) {
      if (err.message && err.message.includes('VERSION MISMATCH')) {
        // Version mismatch won't fix itself — break early
        throw err;
      }
      if (attempt === MAX_RETRIES || opts.signal?.aborted || opts.expired?.()) {
        throw err;
      }
      console.error(`[download-url] Attempt ${attempt} failed: ${err.message}`);
    }
  }
}

/**
 * Resolve URLs from all sources in parallel, first valid wins
 * @param {string} packageId - Package ID
 * @param {string} version - Version to resolve
 * @param {object} [opts] - Optional source resolver overrides for tests
 * @returns {Promise<object>} { url, source }
 */
async function parallelResolveSources(packageId, version, opts = {}) {
  const sourceResolvers = opts.sourceResolvers || {};
  // Source list is in priority order (apkeep > apkmirror-api >
  // apkmirror). This order is the single source of truth for which
  // resolver wins when several succeed — see the "Fixed priority
  // order" comment below.
  const sources = [
    {
      name: 'apkeep',
      fn: () => sourceResolvers.apkeep
        ? sourceResolvers.apkeep(packageId, version)
        : resolveApkeep(packageId, version, opts),
    },
    {
      name: 'apkmirror-api',
      fn: () => sourceResolvers.apkmirrorApi
        ? sourceResolvers.apkmirrorApi(packageId, version)
        : resolveApkmirrorApi(packageId, version),
    },
    {
      name: 'apkmirror',
      fn: () => sourceResolvers.apkmirror
        ? sourceResolvers.apkmirror(packageId, version)
        : resolveApkmirror(packageId, version),
    },
  ];

  const SOURCE_TIMEOUT = TIMEOUTS.sourceResolve;

  console.error(`[parallel-resolve] Starting parallel resolution for ${packageId} v${version}`);
  const startTime = Date.now();

  // Fixed priority order, NOT first-arrives-wins.
  //
  // The README phrasing "first valid URL wins" is misleading — the
  // actual contract is "the highest-priority source whose promise
  // resolved with a valid URL wins, with fall-through to the next
  // source on failure." apkeep at index 0 is always preferred over
  // apkmirror-api at index 1 even when apkmirror-api returns faster,
  // because the apkeep URL is trusted to match the package/version
  // semantically (apkeep is the canonical APKPure resolver; the
  // apkmirror path is a Cloudflare-bypass fallback).
  //
  // Implementation: kick off every source's Promise.race
  // (source.fn() vs SOURCE_TIMEOUT) in parallel up front so the JS
  // event loop interleaves their I/O. Then iterate the resulting
  // promises IN PRIORITY ORDER, awaiting each one. As soon as the
  // highest-priority source settles with a valid URL we return it.
  // If it fails (no URL, rejection, timeout) we fall through to
  // the next-priority source.
  //
  // Why not Promise.any: Promise.any resolves to whichever promise
  // fulfills first — that loses the priority order (apkmirror-api
  // could win over apkeep just by being faster). The existing
  // fallback-chain test suite pins apkeep-first ordering, so we
  // keep allSettled semantics and just don't wait for all of them
  // to settle before returning the priority-first winner.
  //
  // Why not the prior Promise.allSettled: that waited for every
  // source to settle (or time out at SOURCE_TIMEOUT) before
  // returning, so a hung low-priority source would delay the
  // winner by up to SOURCE_TIMEOUT. The new shape consumes the
  // priority-ordered promises one at a time — once the
  // highest-priority source settles (success or failure), we
  // either return or move on. Lower-priority sources that are
  // still running are abandoned at function exit (their timers
  // are cleared in the per-source finally block below).

  // Per-source promise: each races source.fn() against SOURCE_TIMEOUT,
  // clears its own timer in the finally block (no orphan setTimeouts
  // when a source resolves fast — same fix as commit 93c42e0).
  //
  // Rejections are caught and converted into a `{__rejected, ...}`
  // sentinel so the caller's `await promises[i]` always resolves
  // uniformly. Without this catch, an abandoned loser (its promise
  // was kicked off in parallel but we returned early on a higher-
  // priority winner) would surface as an unhandled rejection — the
  // old Promise.allSettled shape absorbed those because allSettled
  // never lets a rejection escape.
  const promises = sources.map((source, index) => {
    let timer;
    return (async () => {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${source.name} timeout`)),
          SOURCE_TIMEOUT,
        );
      });
      try {
        return await Promise.race([source.fn(), timeoutPromise]);
      } finally {
        clearTimeout(timer);
      }
    })().catch((reason) => ({
      __rejected: true,
      index,
      name: source.name,
      reason,
    }));
  });

  // Iterate in priority order. Awaiting each promise sequentially
  // consumes results in priority order; the underlying I/O runs in
  // parallel because the promises were kicked off above.
  for (let i = 0; i < sources.length; i += 1) {
    const sourceName = sources[i].name;
    const result = await promises[i];
    if (result && result.__rejected) {
      const error = result.reason?.message || 'Unknown error';
      console.error(`[parallel-resolve] ${sourceName} failed: ${error}`);
      continue;
    }
    if (result && result.url) {
      const elapsed = Date.now() - startTime;
      console.error(`[parallel-resolve] Winner: ${sourceName} (after ${elapsed}ms)`);
      return { ...result, source: result.source || sourceName };
    }
    // Result lacked a URL — treat as a failure of this source and
    // fall through.
    console.error(`[parallel-resolve] ${sourceName} failed: returned no URL`);
  }

  throw new Error('All sources failed to resolve URL');
}

// parseArgs / loadConfig / loadExistingUrl moved to src/download/:
//   - parseArgs           → src/download/cli-args.js
//   - loadConfig + loadExistingUrl → src/download/config.js
// The original implementations are no longer inlined here; the
// downloader imports them at the top and main() / parallelResolveSources
// call them with the same arguments and get the same return shapes.

/**
 * Run command with execFile and timeout.
 *
 * Timeout enforcement is delegated to `execFile`'s built-in `timeout`
 * option (verified at runtime against Node 24+: a 200ms deadline on a
 * `sleep 5` child produces a `close` event with `code=null,
 * signal='SIGTERM'` without an `error` event, exactly as documented).
 * The Promise rejects on the resulting close by emitting the same
 * custom `Command timed out after ${timeout}ms: ${cmd}` message
 * callers previously relied on. Relying on `execFile`'s timeout
 * removes the legacy manual `setTimeout` block, which used to leak
 * its closure for the full timeout duration whenever the child
 * exited early (issue #1) — the earlier code never captured or
 * cleared the handle. Tests in `__tests__/unified-downloader-runcommand.test.js`
 * pin both contracts (timeout behavior + no manual setTimeout leaks).
 */
function runCommand(cmd, args, options = {}) {
  const { execFileImpl = execFile, ...commandOptions } = options;
  const timeout = commandOptions.timeout || TIMEOUTS.commandDefault;

  return new Promise((resolve, reject) => {
    // codeql[js/indirect-command-line-injection] reason: execFile's
    // argv-form spawn doesn't invoke a shell — `cmd` is the binary
    // name (passed to execvp(2)) and each `args[i]` becomes a
    // separate argv entry (POSIX execve), so shell metacharacters
    // in either field are not interpreted. Live callers pass
    // hardcoded `cmd` literals (`"apkeep"`, `"apkeep-fail"`, …) and
    // argv arrays the resolver built from filtered config fields.
    // The non-network callers in `runCommand` are runCommand's own
    // `unified-downloader-runcommand.test.js` tests, which run
    // against `printf`/`echo`/`sleep` with explicit literal
    // arguments — no shell expansion happens.
    const proc = execFileImpl(cmd, args, {
      timeout,
      stdio: commandOptions.stdio || ["pipe", "pipe", "pipe"],
      ...commandOptions
    });

    let stdout = "";
    let stderr = "";

    if (proc.stdout) {
      proc.stdout.on("data", (data) => {
        stdout += data;
      });
    }
    if (proc.stderr) {
      proc.stderr.on("data", (data) => {
        stderr += data;
      });
    }

    let settled = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      fn();
    };

    proc.on("close", (code, signal) => {
      // execFile's built-in timeout kills the child with SIGTERM and
      // surfaces the result via close (no error event). Map the
      // (code=null, signal='SIGTERM') signature to the same timeout
      // message callers saw with the legacy manual setTimeout path.
      // Any other SIGTERM is treated as a normal failure — the
      // downloader never sends SIGTERM itself, so this branch is
      // only reachable via a Node-internal timeout.
      if (signal === 'SIGTERM' && code === null) {
        settle(() => reject(new Error(`Command timed out after ${timeout}ms: ${cmd}`)));
        return;
      }
      if (code === 0) {
        settle(() => resolve({ stdout, stderr, code }));
      } else {
        settle(() => reject(new Error(`Command failed with code ${code}: ${stderr || cmd}`)));
      }
    });

    proc.on("error", (err) => {
      settle(() => reject(err));
    });
  });
}

/**
 * Download using apkeep (APKPure)
 */
async function downloadWithApkeep(packageId, version, outputDir, opts = {}) {
  console.error(`[apkeep] Attempting download for ${packageId} v${version}`);

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Try apkeep with specific version first (what patches need)
  // apkeep syntax: apkeep -a package@version -d source output_path
  // Use version as-is; APKPure accepts standard version formats
  const versionArg = version;

  let downloadedVersion = version;

  // First, clear any existing files
  if (fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir);
    for (const file of files) {
      if (file !== '.playwright-temp') {
        try {
          fs.unlinkSync(path.join(outputDir, file));
        } catch (_e) { /* ignore */ }
      }
    }
  }

  // Try SPECIFIC version first (what Morphe patches need)
  console.error(`[apkeep] Requesting specific version ${version}...`);
  let apkeepSucceeded = false;
  let apkPath = null;
  try {
    await runCommand("apkeep", ["-a", `${packageId}@${versionArg}`, "-d", "apk-pure", outputDir], {
      timeout: TIMEOUTS.apkeepDownload,
      execFileImpl: opts.execFileImpl,
    });

    apkPath = findApkFile(outputDir);
    if (apkPath) {
      const stats = fs.statSync(apkPath);
      if (stats.size > 1000) {
        console.error(`[apkeep] Downloaded: ${apkPath} (${stats.size} bytes)`);

        // Split packages (.xapk / .apkm / .apks) are zip-of-zips — aapt
        // can't parse them, so version validation on the outer archive
        // always returns false. The caller in download-supported-apk.js
        // already extracts base.apk and validates its versionName
        // (which aapt can read), so duplicating the check here would
        // spuriously reject every split package. Sofascore is the
        // prime example: apkeep ships a xapk bundle with a no-libs
        // base.apk + config.armeabi_v7a.apk + config.mdpi.apk.
        const isSplitPackage = /\.(xapk|apkm|apks)$/i.test(apkPath);

        if (!isSplitPackage) {
          // ALWAYS validate the downloaded APK matches requested version
          const validation = validateApkVersion(apkPath, version, { execFileSyncImpl: opts.execFileSyncImpl });
          if (!validation.valid) {
            // Cleanup-on-failure: APKPure just served a partial / wrong-
            // version download. Delete it so the next source
            // (apkmirror-api → apkmirror-pw) isn't contaminated by a
            // stale .apk that findPackageCandidate's first-encountered
            // tiebreak would pick over the working bundle. Best-effort.
            try { fs.unlinkSync(apkPath); } catch { /* best-effort */ }
            throw new Error(`VERSION MISMATCH: Downloaded APK v${validation.actualVersion} but wanted v${version}. ${validation.error || "The requested version is not available from APKPure."}`);
          }
        } else {
          console.error(`[apkeep] Split package detected — skipping aapt version check (aapt can't parse zip-of-zips; caller validates inner base.apk)`);
        }

        // Validate ABI composition. APKPure commonly serves a single-
        // architecture APK per download (often armeabi-v7a-only). If
        // that doesn't match the operator's preferred_arch, reject the
        // download so the fallback chain (apkmirror-api → apkmirror-pw)
        // can try a source that ships the right ABI.
        //
        // The validator (apk-abi-validator.js) is bundle-aware: it
        // detects the zip-of-zips shape, extracts inner .apk files to
        // a temp dir, and checks each one for lib/<arch>/*.so. So a
        // Sofascore xapk with only config.armeabi_v7a.apk is correctly
        // rejected for an arm64-v8a preference; the next source (APKMirror)
        // gets a chance to serve a multi-arch APK.
        let preferredArchForApkeep = '';
        try {
          preferredArchForApkeep = loadConfig().preferred_arch || '';
        } catch { /* missing/invalid config — skip validation */ }
        try {
          validateDownloadedApkAbi(apkPath, preferredArchForApkeep);
        } catch (abiErr) {
          // Cleanup-on-failure: same rationale as VERSION MISMATCH
          // above. APKPure served a single-arch APK that doesn't match
          // preferred_arch — let the next source try. Delete before
          // re-throwing so a stale partial file can't pre-empt the
          // good download later in the chain.
          try { fs.unlinkSync(apkPath); } catch { /* best-effort */ }
          throw abiErr;
        }

        downloadedVersion = version;
        console.error(`[apkeep] Version validated: ${downloadedVersion}`);
        apkeepSucceeded = true;
      }
    }
  } catch (e) {
    console.error(`[apkeep] Failed: ${e.message}`);
  }

  // If apkeep failed or version mismatch, return failure - let caller try other sources
  if (!apkeepSucceeded) {
    throw new Error(`APKPure does not have ${packageId}@${version} - version not available`);
  }

  return {
    success: true,
    filepath: apkPath,
    version: downloadedVersion,
    source: "apkeep",
    url: `apkeep:${packageId}@${downloadedVersion}`
  };
}



/**
 * Download using APKMirror API
 *
 * Resolves the URL via the apkmirror-api, then delegates the actual
 * download (retries + APK version validation) to downloadWithUrl. This
 * was previously a one-shot curl call without retry or version validation;
 * routing through downloadWithUrl brings it in line with every other
 * direct-URL path in the fallback chain.
 */
async function downloadWithApkmirrorApi(packageId, version, outputDir) {
  console.error(`[apkmirror-api] Attempting download for ${packageId} v${version} via API`);

  const apkmirrorPath = getApkmirrorPath(packageId);
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path configured for ${packageId}`);
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // resolveApkmirrorApi throws on auth failure, API error, or missing
  // downloadUrl — let it propagate so the caller's fallback chain can try
  // the next source.
  const { url: downloadUrl } = await resolveApkmirrorApi(packageId, version);

  // Delegate the actual download (retries + validateApkVersion + size checks)
  // to downloadWithUrl. We override `source` so saveCachedUrl records the
  // API as the resolver, not the generic direct-url path.
  const result = await downloadWithUrl(downloadUrl, outputDir, packageId, version);
  console.error(`[apkmirror-api] Downloaded via downloadWithUrl: ${result.path}`);

  return {
    ...result,
    source: "apkmirror-api",
    url: downloadUrl,
  };
}

/**
 * Download using APKMirror with Playwright
 */
/**
 * Download APK via Playwright by navigating the full 3-page APKMirror flow
 * within one browser session — avoids session-cookie dependency for download.php.
 */
async function downloadViaPlaywright(apkmirrorPath, version, outputDir) {
  const config = loadConfig();
  const preferredArch = config.preferred_arch || 'arm64-v8a';
  const priorities = buildVariantPriorities(preferredArch);

  console.error(`[apkmirror-pw] Starting browser download for ${apkmirrorPath} v${version}`);

  const { browser, page } = await openApkmirror(chromium);

  try {

    // Page 1: Release page (slug resolved via /all-versions/, not path last component).
    const page1Url = await resolveApkmirrorReleaseSlug(apkmirrorPath, version, { page });
    console.error(`[apkmirror-pw] Page 1: ${page1Url}`);
    await navigateApkmirror(page, page1Url);
    const $1 = cheerio.load(await page.content());
    const variantHref = selectVariant($1, priorities);

    // Page 2: Variant page → find download button
    const page2Url = `https://www.apkmirror.com${variantHref}`;
    console.error(`[apkmirror-pw] Page 2: ${page2Url}`);
    await navigateApkmirror(page, page2Url);
    const $2 = cheerio.load(await page.content());
    const dlButtonHref = $2('a.downloadButton[href]').attr('href');
    if (!dlButtonHref) throw new Error('Download button not found on APKMirror variant page');

    // Page 3: Download confirmation page → click final link within browser session
    const page3Url = `https://www.apkmirror.com${dlButtonHref}`;
    console.error(`[apkmirror-pw] Page 3: ${page3Url}`);
    await navigateApkmirror(page, page3Url);
    // APKMirror shows a cookie/consent popup on this page that blocks clicks.
    // The button text is exactly "AGREE" (InMobi CMP). Dismiss it before
    // trying to click the download link, otherwise the click is intercepted.
    try {
      const agreeClicked = await page.evaluate(() => {
        for (const btn of document.querySelectorAll('button')) {
          if (/^AGREE$/i.test(btn.textContent.trim())) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (agreeClicked) console.error('[apkmirror-pw] Dismissed consent popup');
      // Give the popup a moment to collapse
      await page.waitForTimeout(1500);
    } catch (_e) {
      // Best-effort — some pages won't have the popup at all
    }

    // The actual download trigger is the #download-link element (not the
    // generic `a[data-google-interstitial="false"]` selector which matches
    // ~96 unrelated sidebar nav links on the same page).
    const $3 = cheerio.load(await page.content());
    const finalHref = $3('#download-link[href]').attr('href');
    if (!finalHref) {
      // Fall back to the page-2 download button (the same link, but page 3
      // usually has the final signed URL with a fresh key). Better to fail
      // loudly than to silently chase the wrong selector again.
      throw new Error('Final #download-link not found on APKMirror download page');
    }
    const finalUrl = finalHref.startsWith('http') ? finalHref : `https://www.apkmirror.com${finalHref}`;
    console.error(`[apkmirror-pw] Resolved URL: ${finalUrl}`);

    // Click the link inside the browser session so cookies are preserved for the download.
    // `force: true` because InMobi's overlay sometimes leaves a residual hit-target
    // even after we clicked AGREE.
    const downloadPromise = page.waitForEvent('download', { timeout: TIMEOUTS.playwrightDownload });
    await page.click('#download-link', { force: true });
    const dl = await downloadPromise;

    const suggestedFilename = dl.suggestedFilename() || `${apkmirrorPath.split('/').pop()}_${version}.apk`;
    const destPath = path.join(outputDir, suggestedFilename);
    console.error(`[apkmirror-pw] Saving download to: ${destPath}`);
    await dl.saveAs(destPath);

    if (!fs.existsSync(destPath)) throw new Error(`File not found after download: ${destPath}`);
    const stats = fs.statSync(destPath);
    if (stats.size < 10000) throw new Error(`Downloaded file too small: ${stats.size} bytes`);

    console.error(`[apkmirror-pw] Download complete: ${destPath} (${stats.size} bytes)`);
    // Reject the download if the picked APKMirror variant doesn't
    // actually ship the preferred arch's .so libs. APKMirror's row
    // labels (arm64-v8a / universal / noarch) are occasionally
    // mislabelled — a row can be marked "universal" but actually be a
    // 32-bit-only upload. The DOM-driven selectVariant can't detect
    // this; the post-download zip inspection can.
    try {
      validateDownloadedApkAbi(destPath, preferredArch);
    } catch (abiErr) {
      // Cleanup-on-failure: the Playwright path is the LAST fallback
      // in the chain — but the contract is still that any validation
      // throw leaves no stale file behind. If a future caller wires
      // a retry around downloadViaPlaywright, a leftover .apkm here
      // would be picked over the next attempt's result.
      //
      // No direct unit coverage (downloadViaPlaywright is not
      // exported). The Playwright chain is the LAST fallback in the
      // caller's sequential fallback, so the preemption scenario this
      // fixes is hypothetical — the only realistic reason to get here
      // is upstream serving a mislabelled-ABI bundle. Mirror the same
      // shape as downloadWithUrl/downloadWithApkeep for consistency.
      try { fs.unlinkSync(destPath); } catch { /* best-effort */ }
      throw abiErr;
    }
    return { success: true, path: destPath, filename: suggestedFilename, url: finalUrl };
  } finally {
    await browser.close();
  }
}

async function downloadWithApkmirror(packageId, version, outputDir) {
  console.error(`[apkmirror] Attempting download for ${packageId} v${version}`);

  const apkmirrorPath = getApkmirrorPath(packageId);
  if (!apkmirrorPath) {
    throw new Error(`No APKMirror path configured for ${packageId}`);
  }

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Download within one browser session: resolve URL + download in same context
  console.error(`[apkmirror] Starting APKMirror Playwright fallback...`);
  const result = await downloadViaPlaywright(apkmirrorPath, version, outputDir);

  if (!result.success) {
    throw new Error("Playwright download failed");
  }

  return {
    success: true,
    filepath: result.path,
    version: version,
    source: "apkmirror",
    url: result.url
  };
}

/**
 * Find the Google Play build number (versionCode) for an exact version.
 *
 * APKMirror's listing is tried first: it names the build per CPU type. It
 * often blocks GitHub's runners, and then Google Play was only asked by
 * version name, which doesn't find older builds. So APKPure's listing is
 * the second choice: the build number of the variant APKPure's own step
 * picks (the arm64-v8a one, see resolveApkeepVariant). A wrong number
 * can't slip through: downloadWithGoopdl still checks the package, version
 * name, build number and the arm64-v8a split of what Play delivers.
 */
async function resolveGooglePlayVersionCode(packageId, version, arch, opts = {}) {
  let apkmirrorError;
  try {
    return await resolveGooglePlayVersionCodeViaApkmirror(packageId, version, arch);
  } catch (error) {
    apkmirrorError = error;
  }
  try {
    const code = await resolveGooglePlayVersionCodeViaApkpure(packageId, version, arch, opts);
    console.error(`[goopdl] APKMirror couldn't give the build number (${apkmirrorError.message}); using APKPure's: ${code}`);
    return code;
  } catch (error) {
    throw new Error(`${apkmirrorError.message}; APKPure: ${error.message}`, { cause: error });
  }
}

/** The arm64-v8a build number APKPure lists for an exact version. */
async function resolveGooglePlayVersionCodeViaApkpure(packageId, version, arch, { fetchImpl = fetch } = {}) {
  // APKPure's URLs don't say which CPU they're for; the arm64-v8a choice
  // rests on the size order resolveApkeepVariant relies on.
  if (arch !== 'arm64-v8a') throw new Error(`no ${arch} build numbers`);
  const code = versionCodeOf(pickSmallestMatchingVariant(await fetchApkpureVersionListing(packageId, fetchImpl), version));
  if (!code) throw new Error(`no build number listed for ${packageId}@${version}`);
  return code;
}

/** Discover a stock Play code from an exact-version, architecture-specific listing. */
async function resolveGooglePlayVersionCodeViaApkmirror(packageId, version, arch) {
  const apkmirrorPath = getApkmirrorPath(packageId);
  if (!apkmirrorPath) throw new Error('No APKMirror mapping for version discovery');
  const { browser, page } = await openApkmirror(chromium);
  try {
    const releaseUrl = await resolveApkmirrorReleaseSlug(apkmirrorPath, version, { page });
    await navigateApkmirror(page, releaseUrl);
    // Only explicit architecture matches provide Play codes, not universal fallbacks.
    const priorities = buildVariantPriorities(arch).filter(p => p.arch === arch);
    const variant = selectVariant(cheerio.load(await page.content()), priorities);
    await navigateApkmirror(page, new URL(variant, 'https://www.apkmirror.com').href);
    return extractVersionCode(cheerio.load(await page.content()), packageId, version);
  } finally {
    await browser.close();
  }
}

/** Resolve the current release slug when the curl listing is blocked. */
async function resolveApkmirrorReleaseSlugViaChromium(apkmirrorPath, version) {
  const { browser, page } = await openApkmirror(chromium);
  try {
    // Reuse the warmed context; the helper retains its path-slug fallback.
    const url = await resolveApkmirrorReleaseSlug(apkmirrorPath, version, { page });
    return url;
  } finally {
    await browser.close();
  }
}

/**
 * Resolve APKMirror direct APK download URL using fetch + cheerio (3-page navigation).
 * Page 1: Release page → find correct arch/DPI/type variant row
 * Page 2: Variant page → find download button
 * Page 3: Download page → find final APK link
 *
 * Slug resolution uses Chromium (Cloudflare-resistant) when curl hits
 * 403 on /all-versions/ — the path-slug fallback in resolveApkmirrorReleaseSlug
 * would otherwise point Sofascore at the deprecated slug
 * (soccer-scores-and-sports-livescore-sofascore) instead of the
 * current 2025+ slug (sofascore-live-sports-scores). The rest of the
 * flow stays on curl since the release/variant/download pages don't
 * trip Cloudflare the same way.
 */
async function resolveApkmirrorUrlViaCurl(apkmirrorPath, version, priorities) {
  // Page 1: Release page (slug resolved via /all-versions/, not path last component).
  // The Chromium fallback is invoked only when curl fails on /all-versions/.
  let page1Url;
  try {
    page1Url = await resolveApkmirrorReleaseSlug(apkmirrorPath, version);
  } catch (slugErr) {
    if (!slugErr.message.includes('403')) throw slugErr;
    console.error(`[apkmirror-scraper] /all-versions/ blocked by Cloudflare; retrying with Chromium`);
    page1Url = await resolveApkmirrorReleaseSlugViaChromium(apkmirrorPath, version);
  }
  console.error(`[apkmirror-scraper] Page 1 (curl): ${page1Url}`);
  const resp1 = await apkmirrorFetch(page1Url);
  let cookies = collectCookies(resp1);
  const $1 = cheerio.load(await resp1.text());

  const variantHref = selectVariant($1, priorities);

  // Page 2: Variant page
  const page2Url = `https://www.apkmirror.com${variantHref}`;
  console.error(`[apkmirror-scraper] Page 2 (curl): ${page2Url}`);
  const resp2 = await apkmirrorFetch(page2Url, cookies, page1Url);
  cookies = collectCookies(resp2, cookies);
  const $2 = cheerio.load(await resp2.text());

  const downloadButtonHref = $2('a.downloadButton[href]').attr('href');
  if (!downloadButtonHref) {
    throw new Error('Download button not found on APKMirror variant page');
  }

  // Page 3: Download page
  const page3Url = `https://www.apkmirror.com${downloadButtonHref}`;
  console.error(`[apkmirror-scraper] Page 3 (curl): ${page3Url}`);
  const resp3 = await apkmirrorFetch(page3Url, cookies, page2Url);
  collectCookies(resp3, cookies);
  const $3 = cheerio.load(await resp3.text());

  const finalHref =
    $3('a[data-google-interstitial="false"][href]').attr('href') ||
    $3('a[rel=nofollow][href*=".apk"]').attr('href');

  if (!finalHref) {
    throw new Error('Final APK download link not found on APKMirror download page');
  }

  const finalUrl = finalHref.startsWith('http')
    ? finalHref
    : `https://www.apkmirror.com${finalHref}`;

  console.error(`[apkmirror-scraper] Resolved (curl): ${finalUrl}`);
  return finalUrl;
}

/**
 * Resolve APKMirror download URL using Playwright (Chromium).
 * Used as fallback when curl is blocked by Cloudflare (HTTP 403).
 * Chromium's TLS fingerprint passes bot detection that curl cannot.
 */
async function resolveApkmirrorUrlViaPlaywright(apkmirrorPath, version, priorities) {
  console.error(`[apkmirror-scraper] Using Playwright fallback for ${apkmirrorPath} v${version}`);

  const { browser, page } = await openApkmirror(chromium);

  try {

    // Page 1: Release page (slug resolved via /all-versions/, not path last component).
    const page1Url = await resolveApkmirrorReleaseSlug(apkmirrorPath, version, { page });
    console.error(`[apkmirror-scraper] Page 1 (PW): ${page1Url}`);
    await navigateApkmirror(page, page1Url);
    const html1 = await page.content();
    const $1 = cheerio.load(html1);
    const variantHref = selectVariant($1, priorities);

    // Page 2: Variant page
    const page2Url = `https://www.apkmirror.com${variantHref}`;
    console.error(`[apkmirror-scraper] Page 2 (PW): ${page2Url}`);
    await navigateApkmirror(page, page2Url);
    const html2 = await page.content();
    const $2 = cheerio.load(html2);
    const downloadButtonHref = $2('a.downloadButton[href]').attr('href');
    if (!downloadButtonHref) throw new Error('Download button not found on APKMirror variant page');

    // Page 3: Download page. The actual download URL is the `#download-link`
    // element (not the generic `a[data-google-interstitial="false"]` selector
    // which matches ~96 unrelated sidebar nav links on the same page).
    const page3Url = `https://www.apkmirror.com${downloadButtonHref}`;
    console.error(`[apkmirror-scraper] Page 3 (PW): ${page3Url}`);
    await navigateApkmirror(page, page3Url);
    const html3 = await page.content();
    const $3 = cheerio.load(html3);
    const finalHref =
      $3('#download-link[href]').attr('href') ||
      $3('a[rel=nofollow][href*="download.php"]').attr('href');
    if (!finalHref) throw new Error('Final APK download link not found on APKMirror download page');

    const finalUrl = finalHref.startsWith('http')
      ? finalHref
      : `https://www.apkmirror.com${finalHref}`;
    console.error(`[apkmirror-scraper] Resolved (PW): ${finalUrl}`);
    return finalUrl;
  } finally {
    await browser.close();
  }
}

async function resolveApkmirrorUrl(apkmirrorPath, version) {
  const config = loadConfig();
  const preferredArch = config.preferred_arch || 'arm64-v8a';
  const priorities = buildVariantPriorities(preferredArch);

  // Try curl first (fast, no browser overhead)
  try {
    return await resolveApkmirrorUrlViaCurl(apkmirrorPath, version, priorities);
  } catch (e) {
    // Fall back to Playwright when Cloudflare blocks curl (HTTP 403)
    if (e.message.includes('403')) {
      console.error(`[apkmirror-scraper] curl blocked by Cloudflare, switching to Playwright`);
      return await resolveApkmirrorUrlViaPlaywright(apkmirrorPath, version, priorities);
    }
    throw e;
  }
}



/**
 * After APKPure's smallest-first variant was turned away, try the other
 * XAPK variants it lists for the exact version, smallest first, each with
 * the usual download checks plus the caller's accept check (minimum Android).
 * All of them share one time limit.
 *
 * @returns {Promise<{ url: string, result: object }|null>} The first variant
 *   that passes, or null.
 */
async function tryOtherApkpureVariants(packageId, version, outputDir, tried, opts, accept, remainingMs = Infinity) {
  // One limit for the listing fetch and every download and check after it.
  const deadline = apkpureExact.createDeadline(Math.max(1, Math.min(opts.apkpureVariantsBudgetMs || TIMEOUTS.apkpureVariants, remainingMs)));
  let urls;
  try {
    urls = remainingMatchingVariants(await fetchApkpureVersionListing(packageId, opts.fetchImpl, deadline.signal), version, tried);
  } catch (e) {
    console.error(`[apkpure-variants] Could not list other variants: ${e.message}`);
    return null;
  }
  console.error(`[apkpure-variants] ${urls.length} other variant(s) of ${packageId}@${version} to try`);
  for (const url of urls) {
    if (deadline.expired()) break;
    try {
      const result = await downloadWithUrl(url, outputDir, packageId, version, {
        ...opts, signal: deadline.signal, timeoutMs: deadline.timeoutMs, expired: deadline.expired,
      });
      if (accept(result, 'apkeep', { url, deadline })) {
        // A file accepted after the time ran out may have been kept only
        // because its checks were cut short; don't trust it.
        if (deadline.expired()) {
          console.error('[apkpure-variants] Time limit reached while checking the file; discarding it');
          try { fs.rmSync(path.join(outputDir, `${packageId}_${version}.apk`), { force: true }); } catch { /* best-effort */ }
          return null;
        }
        return { url, result };
      }
    } catch (e) {
      console.error(`[apkpure-variants] ${e.message}`);
      // An aborted or failed transfer can leave a partial file behind.
      try { fs.rmSync(path.join(outputDir, `${packageId}_${version}.apk`), { force: true }); } catch { /* best-effort */ }
    }
  }
  return null;
}

/**
 * Main download function with fallback chain
 */
/**
 * Main download function with improved reliability:
 * 0. Try exact Google Play build via goopdl; any failure uses the chain below
 * 1. Check URL cache -> if valid, use directly
 * 2. Check patches.json -> if has URL, verify and use
 * 3. Parallel resolution (priority-ordered: apkeep → apkmirror-api →
 *    apkmirror; first valid URL wins, fall through on failure or
 *    timeout — see parallelResolveSources header comment)
 * 4. Download from URL
 * 5. Save to cache on success
 * 6. Fallback to sequential on all parallel fail
 * @param {object} [opts] - Optional process dependency overrides for tests
 */
async function download(packageId, version, outputDir, opts = {}) {
  const cacheDir = opts.cacheDir || process.env.URL_CACHE_DIR
    || path.join(require('node:os').homedir(), '.cache', 'auto-morphe-builder', 'urls');
  // FRESH_DOWNLOAD: the remembered URLs may lead back to the file that just failed to patch.
  const fresh = opts.fresh !== undefined ? opts.fresh : /^(1|true)$/i.test(process.env.FRESH_DOWNLOAD || '');
  function remember(url, source) {
    try { saveCachedUrl(packageId, version, url, source, cacheDir); }
    catch (error) { console.error(`[url-cache] Could not persist URL: ${error.message}`); }
  }
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Minimum Android the patches support (0 = no check). A file built for an
  // older Android is dropped here, minutes before the patcher would fail on it.
  let config = {};
  try { config = loadConfig() || {}; } catch { /* default */ }
  const minSdk = opts.minSdk !== undefined ? opts.minSdk : minSdkLib.minSdkFromConfig(config, packageId);
  const rejectedSdks = [];
  // URLs already turned away, so no later path downloads the same build again.
  const rejectedUrls = new Set();
  const wasRejected = (url) => rejectedUrls.has(variantKey(url)) || rejectedUrls.has(`build:${buildCodeOf(url)}`);
  // The caller kills this process at 600 s; stop starting new steps well
  // before that so a "Wrong build" message can still be reported.
  const startedAt = Date.now();
  const totalBudgetMs = opts.totalBudgetMs !== undefined ? opts.totalBudgetMs : TIMEOUTS.totalDownload;
  const remainingMs = () => Math.max(0, totalBudgetMs - (Date.now() - startedAt));
  /**
   * True if the file the source produced may be used. A file below the
   * floor is deleted and, if its URL came from the URL cache, uncached;
   * a minSdk that can't be read is not a reason to reject.
   */
  function acceptMinSdk(result, source, { url, fromCache = false, deadline } = {}) {
    if (!minSdk) return true;
    const file = result && (result.path || result.filepath || result.file);
    if (!file) return true;
    let sdk = null;
    try {
      sdk = opts.readMinSdkImpl
        ? opts.readMinSdkImpl(file)
        : minSdkLib.readMinSdk(file, {
          isBundle: detectApkShape(file) === 'bundle',
          execFileSyncImpl: opts.execFileSyncImpl,
          deadline,
        });
    } catch (e) {
      console.error(`[min-sdk] ${source}: could not read the minimum Android (${e.message})`);
    }
    if (sdk == null) {
      console.error(`[min-sdk] ${source}: minimum Android unknown; keeping the file (the patcher will judge it)`);
      return true;
    }
    if (minSdkLib.checkMinSdk(sdk, minSdk).ok) return true;
    console.error(`[min-sdk] ${source}: build is for Android API ${sdk}+, the patches need API ${minSdk}+`);
    rejectedSdks.push(sdk);
    const rejectedUrl = url || result.url;
    if (rejectedUrl) {
      rejectedUrls.add(variantKey(rejectedUrl));
      // An exact-build URL names one build for certain: remember it by build number alone,
      // since the same build comes back under other URLs.
      const code = exactBuildOf(rejectedUrl);
      if (code) rejectedUrls.add(`build:${code}`);
    }
    try { fs.rmSync(file, { force: true }); } catch { /* best-effort: the next source overwrites it */ }
    if (fromCache && url) removeCachedUrl(packageId, version, url, cacheDir);
    return false;
  }
  // The error to end with: a clear "wrong build" when files were turned away
  // for their Android version, else the last source's own error.
  function finalError(lastError) {
    if (!rejectedSdks.length) return lastError;
    // Nothing was accepted, so nothing may stay behind in the output folder.
    try { fs.rmSync(path.join(outputDir, `${packageId}_${version}.apk`), { force: true }); } catch { /* best-effort */ }
    return new Error(minSdkLib.wrongBuildMessage({
      appId: packageId,
      version,
      rejectedSdks,
      floor: minSdk,
      arch: config.preferred_arch || 'arm64-v8a',
    }));
  }

  // Once files have been turned away and the time is up, end with the clear
  // error (called before each step, outside any try, so it propagates).
  function checkBudget(needMs = TIMEOUTS.minStepRemaining) {
    if (rejectedSdks.length && remainingMs() <= needMs) {
      console.error('[min-sdk] Time limit reached after rejecting older builds; stopping');
      throw finalError();
    }
  }

  // Google Play first; preserve the existing URL/resolver chain on any failure.
  try {
    const played = await downloadWithGoopdl(packageId, version, outputDir, { resolveVersionCode: resolveGooglePlayVersionCode, ...opts });
    if (acceptMinSdk(played, 'goopdl')) return played;
  } catch (error) {
    console.error(`[goopdl] ${error.message}; trying existing sources`);
  }

  // The exact build the patch list names, before any cached or listed URL.
  const exactArch = config.preferred_arch || 'arm64-v8a';
  const exactCodes = apkpureExact.patchListCodes(packageId, version, exactArch);
  checkBudget();
  if (exactCodes.length) {
    const exact = await apkpureExact.downloadExactBuild({
      appId: packageId,
      version,
      codes: exactCodes,
      partialPath: path.join(outputDir, `${packageId}_${version}.apk`),
      budgetMs: opts.apkpureExactBudgetMs,
      execFileSyncImpl: opts.execFileSyncImpl,
      isBundle: (file, timeoutMs) => detectApkShape(file, { timeoutMs }) === 'bundle',
      download: (url, extra) => downloadWithUrl(url, outputDir, packageId, version, { ...opts, ...extra }),
      // Throwing sends the exact-build loop on to its next candidate.
      verify: (result, deadline) => {
        if (!acceptMinSdk(result, 'apkpure-exact', { deadline })) throw new Error('built for an older Android than the patches support');
      },
    });
    if (exact) {
      remember(exact.url, 'apkpure-exact');
      return { ...exact.result, source: 'apkpure-exact' };
    }
  }

  // Step 1: Check URL cache
  checkBudget();
  const cachedUrl = fresh ? null : getCachedUrl(packageId, version, cacheDir);
  if (cachedUrl && !wasRejected(cachedUrl.url)) {
    console.error(`[download] Trying cache for ${packageId} v${version}`);
    try {
      const isValid = await verifyUrl(cachedUrl.url);
      if (isValid) {
        const result = await downloadWithUrl(cachedUrl.url, outputDir, packageId, version, opts);
        if (acceptMinSdk(result, 'url-cache', { url: cachedUrl.url, fromCache: true })) {
          // Update cache with incremented download count
          remember(cachedUrl.url, cachedUrl.source);
          return result;
        }
      }
    } catch (e) {
      console.error(`[download] Cache URL invalid: ${e.message}`);
    }
  }

  // Step 2: Check patches.json for existing URL
  checkBudget();
  const existingUrl = fresh ? null : loadExistingUrl(packageId, version);
  if (existingUrl && !wasRejected(existingUrl)) {
    console.error(`[download] Trying patches.json URL for ${packageId} v${version}`);
    try {
      const isValid = await verifyUrl(existingUrl);
      if (isValid) {
        const result = await downloadWithUrl(existingUrl, outputDir, packageId, version, opts);
        if (acceptMinSdk(result, 'patches.json', { url: existingUrl })) {
          // Save to our URL cache
          remember(existingUrl, 'patches.json');
          return result;
        }
      }
    } catch (e) {
      console.error(`[download] patches.json URL invalid: ${e.message}`);
    }
  }

  // Step 3: Try parallel resolution
  checkBudget();
  console.error(`[download] Starting parallel resolution for ${packageId} v${version}`);
  let triedApkpureVariants = false;
  try {
    const resolved = await parallelResolveSources(packageId, version, opts);
    if (!wasRejected(resolved.url)) {
      const result = await downloadWithUrl(resolved.url, outputDir, packageId, version, opts);
      if (acceptMinSdk(result, resolved.source, { url: resolved.url })) {
        // Save to URL cache
        remember(resolved.url, resolved.source);
        return result;
      }
    } else {
      console.error(`[download] ${resolved.source} gave a URL that was already rejected; not downloading it again`);
    }
    // APKPure lists several variants of one version; the smallest-first
    // pick was rejected, so try the others before moving on.
    if (resolved.source === 'apkeep') {
      triedApkpureVariants = true;
      const other = await tryOtherApkpureVariants(packageId, version, outputDir, [...rejectedUrls], opts, acceptMinSdk, remainingMs());
      if (other) {
        remember(other.url, 'apkeep');
        return other.result;
      }
    }
  } catch (e) {
    console.error(`[download] Parallel resolution failed: ${e.message}`);
  }

  // Step 4: Fallback to sequential (existing behavior)
  console.error(`[download] Falling back to sequential resolution`);

  // Sequential order mirrors SOURCE_PRIORITY (see top of file): the
  // highest-priority source that hasn't already been tried by the
  // parallel pass wins. Currently: apkeep (200) → apkmirrorApi (150)
  // → apkmirrorHtml (100). If you add or reorder a tier in
  // SOURCE_PRIORITY, update this block to match — there's no shared
  // driver loop yet (the parallel pass already finished, so this is a
  // pure tail of the pipeline).
  // Try apkeep (skipped once APKPure's variants were tried: it would fetch
  // APKPure's own pick again)
  checkBudget();
  if (triedApkpureVariants) {
    console.error('[apkeep] Skipped: APKPure\'s variants were already tried');
  } else {
    console.error(`[apkeep] Attempting download for ${packageId} v${version}`);
    try {
      const result = await downloadWithApkeep(packageId, version, outputDir);
      const url = result.url || `apkeep:${packageId}@${version}`;
      if (acceptMinSdk(result, 'apkeep')) {
        remember(url, 'apkeep');
        return result;
      }
    } catch (e) {
      console.error(`[apkeep] Failed: ${e.message}`);
    }
  }

  // Try APKMirror API
  checkBudget();
  console.error(`[apkmirror-api] Attempting download for ${packageId} v${version} via API`);
  try {
    const result = await downloadWithApkmirrorApi(packageId, version, outputDir);
    if (acceptMinSdk(result, 'apkmirror-api')) {
      remember(result.url, 'apkmirror-api');
      return result;
    }
  } catch (e) {
    console.error(`[apkmirror-api] Failed: ${e.message}`);
  }

  // Try APKMirror Playwright - last resort
  checkBudget();
  console.error(`[apkmirror] Starting APKMirror Playwright fallback...`);
  let lastError;
  try {
    const result = await downloadWithApkmirror(packageId, version, outputDir);
    if (acceptMinSdk(result, 'apkmirror')) {
      remember(result.url, 'apkmirror');
      return result;
    }
  } catch (e) {
    console.error(`[apkmirror] Failed: ${e.message}`);
    lastError = e;
  }
  throw finalError(lastError || new Error(`No source produced a usable ${packageId} ${version}`));
}

/**
 * Main entry point
 */
async function main() {
  // Parse arguments
  const args = parseArgs();
  if (args.error) {
    console.error(args.error);
    if (args.example) {
      console.error(args.example);
    }
    process.exit(2);
  }

  const { packageId, version, outputDir } = args;

  console.error(`Starting unified download for ${packageId} v${version}`);
  console.error(`Output directory: ${outputDir}`);

  try {
    const result = await download(packageId, version, outputDir);

    // Output JSON result to stdout
    console.log(JSON.stringify(result, null, 2));

    process.exit(0);
  } catch (e) {
    const errorResult = {
      success: false,
      error: e.message
    };

    console.error(`Download failed: ${e.message}`);
    console.log(JSON.stringify(errorResult));

    process.exit(1);
  }
}

// Guard: only run main() when executed directly, not when require()'d by tests
if (require.main === module) {
  main();
}

// Export helpers for testing and external use
module.exports = {
  buildReleasePageUrl,
  buildVariantPriorities,
  apkmirrorReleaseTailCandidates,
  selectVariant,
  collectCookies,
  resolveApkmirrorReleaseSlug,
  resolveApkmirrorReleaseSlugViaChromium,
  resolveGooglePlayVersionCode,
  resolveGooglePlayVersionCodeViaApkpure,
  fetchApkpureVersionListing,
  resolveApkmirrorUrl,
  resolveApkeep,
  resolveApkeepVariant,
  tryOtherApkpureVariants,
  cleanupOldUrls,
  parallelResolveSources,
  download,
  // For testing: runCommand is an internal helper used by
  // downloadWithApkeep and the apkeep resolver, but it's exported
  // here so __tests__/unified-downloader-runcommand.test.js can pin
  // its timeout-cancellation + custom-error contracts without
  // driving the full downloader.
  runCommand,
  // For testing: verifyUrl is called internally by download() to
  // HEAD-probe a cached URL. Exported here so
  // __tests__/unified-downloader-timers.test.js can pin that the
  // urlVerify AbortController timer is cleared on every exit path
  // (success, fetch rejection, timeout).
  verifyUrl,
  // Exported for the cleanup-on-failure unit tests
  // (__tests__/unified-downloader-cleanup.test.js). They exercise the
  // post-download validation paths in isolation rather than driving
  // them through the full download() fallback chain.
  downloadWithUrl,
  downloadWithApkeep,
  downloadViaPlaywright,
  // Source priority table for the resolver fallback chain (see top of
  // file). Exported so test code and external tooling can introspect
  // the order without re-reading the inline sources[] array.
  SOURCE_PRIORITY,
};
