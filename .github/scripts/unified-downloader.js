#!/usr/bin/env node

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
const { validateDownloadedApkAbi } = require('./apk-abi-validator');

// APKMirror API credentials (from environment; no defaults — see apkMirrorAuthHeader).
const APK_MIRROR_API_USER = process.env.APKMIRROR_API_USER;
const APK_MIRROR_API_PASS = process.env.APKMIRROR_API_PASS;

// URL cache directory - stores resolved URLs as JSON
const URL_CACHE_DIR = path.join(os.homedir(), ".cache", "auto-morphe-builder", "urls");

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
};

/**
 * Build the Authorization header for APKMirror's wp-json API.
 * Used by both the URL resolver and the (now-removed) legacy API download path;
 * kept centralized so the auth scheme stays in one place.
 *
 * Throws if either credential is unset. The caller's fallback chain
 * (apkeep → apkmirror Playwright) will then be used; the apkmirror-api
 * path is just one of several resolution sources.
 */
function apkMirrorAuthHeader() {
  if (!APK_MIRROR_API_USER || !APK_MIRROR_API_PASS) {
    throw new Error(
      'APKMIRROR_API_USER and/or APKMIRROR_API_PASS are not set. ' +
      'Configure them as repo secrets to enable the APKMirror-API ' +
      'resolution path; the fallback chain (apkeep → apkmirror Playwright) ' +
      'will be used otherwise.'
    );
  }
  return `Basic ${Buffer.from(`${APK_MIRROR_API_USER}:${APK_MIRROR_API_PASS}`).toString("base64")}`;
}

/**
 * Get APKMirror path for a package from config.json patch_repos.
 */
function getApkmirrorPath(packageId) {
  const config = loadConfig();
  return config.patch_repos?.[packageId]?.apkmirror_path || null;
}

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
 * Build ordered variant priority list from preferred arch.
 * Outer loop = DPI tier (outer is more important), inner loop = arch/type.
 * Within each DPI tier: preferred APK → preferred BUNDLE → universal APK
 * → universal BUNDLE → noarch APK.
 *
 * DPI preference is APKMirror-only. APKMirror exposes a variant table
 * with explicit DPI columns, so we can pick a precise target. APKPure
 * (via apkeep) doesn't expose DPI as a selectable axis — the apkeep
 * path takes whatever APKPure serves, then validates the resulting
 * .apk against `preferred_arch` post-download and falls back to the
 * next source if the ABI doesn't match.
 *
 * Tiers ordered by band tightness:
 *   nodpi        → no DPI-specific resources, runs on any density.
 *   120-640dpi   → assets-up to 640, asset-densities up to 480 — a
 *                  wide umbrella that covers every shipping device.
 *   480-640dpi   → upper-density-only, falls back to lower densities
 *                  visually (smaller assets on a phone but fine).
 *   120-480dpi   → explicit upper bound of 480 (xxxhdpi excluded).
 *   240-480dpi   → narrower band than 120-480dpi, last resort.
 */
function buildVariantPriorities(preferredArch) {
  const archs = [preferredArch, 'universal', 'noarch'];
  const dpis  = ['nodpi', '120-640dpi', '480-640dpi', '120-480dpi', '240-480dpi'];
  const priorities = [];
  for (const dpi of dpis) {
    for (const arch of archs) {
      priorities.push({ arch, dpi, type: 'APK' });
      if (arch !== 'noarch') priorities.push({ arch, dpi, type: 'BUNDLE' });
    }
  }
  return priorities;
}

/**
 * Parse variant table rows from a cheerio-loaded release page.
 * Returns the href of the first row matching the priority list.
 * Throws with available variants if nothing matches.
 */
function selectVariant($, priorities) {
  const rows = [];
  $('.table-row').each((_, row) => {
    const cells = $(row).find('.table-cell');
    if (cells.length < 4) return;
    // Real APKMirror DOM: cells[0]=variant name+type+link, cells[1]=arch, cells[2]=minver, cells[3]=dpi
    const href = $(cells[0]).find('a.accent_color[href], a[href*="/apk/"]').attr('href');
    if (!href || href.includes('#')) return;  // Skip anchor-only sidebar links
    const variantText = $(cells[0]).text().toUpperCase();
    const type = variantText.includes('BUNDLE') ? 'BUNDLE' : 'APK';
    rows.push({
      dpi:  $(cells[3]).text().trim().toLowerCase(),
      arch: $(cells[1]).text().trim().toLowerCase(),
      type,
      href,
    });
  });

  for (const { arch, dpi, type } of priorities) {
    const match = rows.find(r =>
      r.arch.includes(arch.toLowerCase()) &&
      r.dpi === dpi.toLowerCase() &&
      r.type === type
    );
    if (match) return match.href;
  }

  const found = rows.map(r => `${r.arch}/${r.dpi}/${r.type}`).join(', ') || 'none';
  throw new Error(`No matching variant found on APKMirror. Available: ${found}`);
}

/**
 * Collect cookies from a fetch Response's Set-Cookie headers into a plain object.
 * Uses getSetCookie() which returns an array — safe for multi-cookie responses.
 * Merges with any existing cookies.
 */
function collectCookies(response, existing = {}) {
  const setCookies = response.headers.getSetCookie?.() ?? [];
  if (setCookies.length === 0) return existing;
  const cookies = { ...existing };
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 1) continue;
    cookies[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return cookies;
}

/**
 * Make a request with browser-like headers using curl subprocess.
 * Node's built-in fetch has a different TLS fingerprint that Cloudflare detects.
 * curl's TLS fingerprint matches real browsers and passes Cloudflare bot detection.
 */
async function apkmirrorFetch(url, cookies = {}, referer = null) {
  const { execFileSync } = require('child_process');
  const args = [
    '-s', '-L', '--max-time', '30',
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
  args.push(url);

  const output = execFileSync('curl', args, { maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });
  const lastNewline = output.lastIndexOf('\n');
  const statusCode = parseInt(output.slice(lastNewline + 1).trim(), 10);
  const body = output.slice(0, lastNewline);

  if (statusCode >= 400) throw new Error(`HTTP ${statusCode} for ${url}`);

  return {
    text: async () => body,
    headers: { getSetCookie: () => [] },
    ok: statusCode < 400,
    status: statusCode,
  };
}

/**
 * Check URL cache for a package version
 * @returns {object|null} Cache entry or null if not found/invalid
 */
function getCachedUrl(packageId, version) {
  const cacheDir = path.join(URL_CACHE_DIR, packageId);
  const cacheFile = path.join(cacheDir, `${version}.json`);

  if (!fs.existsSync(cacheFile)) {
    console.error(`[url-cache] Miss: ${packageId} v${version}`);
    return null;
  }

  try {
    const cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    console.error(`[url-cache] Hit: ${packageId} v${version} (source: ${cacheData.source}, downloads: ${cacheData.downloads})`);
    return cacheData;
  } catch (e) {
    console.error(`[url-cache] Error reading cache: ${e.message}`);
    return null;
  }
}

/**
 * Save URL to cache
 * @param {string} packageId - Package ID
 * @param {string} version - Version
 * @param {string} url - Resolved URL
 * @param {string} source - Source that provided the URL
 * @returns {string} Path to cached file
 */
function saveCachedUrl(packageId, version, url, source) {
  // Input validation
  if (!packageId || !version || !url) {
    throw new Error('Missing required parameters');
  }

  const cacheDir = path.join(URL_CACHE_DIR, packageId);

  // Create directory if it doesn't exist (race-safe: mkdirSync with
  // { recursive: true } is atomic on POSIX when the parent already
  // exists, and the only race window is between existsSync and mkdirSync,
  // which is mitigated by the recursive option).
  // codeql[js/file-system-race] reason: cacheDir is constructed from a
  // sanitized packageId and lives in the workflow's user-owned ~/.cache;
  // an attacker with write access to the cache directory already owns
  // the workflow.
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  // Sanitize version for use in filename to prevent path traversal
  const safeVersion = version.replace(/[^a-zA-Z0-9.-]/g, '_');
  // codeql[js/file-system-race] reason: cacheFile is built from a
  // sanitized version string into a user-owned cache directory.
  const cacheFile = path.join(cacheDir, `${safeVersion}.json`);

  // Read existing cache or create new
  // codeql[js/file-system-race] reason: existsSync + readFileSync TOCTOU
  // window is on a user-owned cache file we just constructed the path
  // for; in practice the read failure is handled by the try/catch.
  let cacheData = { downloads: 0, lastWorkingAt: null };
  if (fs.existsSync(cacheFile)) {
    try {
      // codeql[js/http-to-file-access] reason: cacheData is parsed from
      // a JSON file we own (user-owned ~/.cache), written by saveCachedUrl
      // elsewhere in this module. Trust boundary = the workflow itself.
      cacheData = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      console.error(`[url-cache] Corrupted cache file, recreating: ${e.message}`);
    }
  }

  // Update cache entry
  const newCacheData = {
    version,
    url,
    source,
    resolvedAt: new Date().toISOString(),
    downloads: cacheData.downloads + 1,
    lastWorkingAt: new Date().toISOString()
  };

  // codeql[js/file-system-race] reason: cacheFile is built from a sanitized
  // packageId + sanitized version, lives in the user-owned cache dir.
  // codeql[js/http-to-file-access] reason: newCacheData is constructed
  // in this module from URL metadata we cached; not attacker-controlled.
  fs.writeFileSync(cacheFile, JSON.stringify(newCacheData, null, 2));
  console.error(`[url-cache] Saved: ${packageId} v${version} from ${source}`);

  // Prune older version entries to prevent unbounded growth.
  cleanupOldUrls(packageId);

  return cacheFile;
}

/**
 * Prune URL cache entries for a package, keeping only the most-recently
 * updated ones.
 * @param {string} packageId
 * @param {number} keep Number of most-recent entries to retain (default 3).
 */
function cleanupOldUrls(packageId, keep = 3) {
  const cacheDir = path.join(URL_CACHE_DIR, packageId);
  if (!fs.existsSync(cacheDir)) {
    return 0;
  }

  const entries = fs.readdirSync(cacheDir)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const fp = path.join(cacheDir, f);
      try {
        const stat = fs.statSync(fp);
        return { file: fp, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);

  const toDelete = entries.slice(keep);
  for (const entry of toDelete) {
    try {
      fs.unlinkSync(entry.file);
      console.error(`[url-cache] Pruned old entry: ${entry.file}`);
    } catch (e) {
      console.error(`[url-cache] Failed to prune ${entry.file}: ${e.message}`);
    }
  }
  return toDelete.length;
}

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

  // codeql[js/file-access-to-http] reason: `url` is a HEAD-probe for a
  // cached APK download URL. The cache file itself is written only by
  // this module from Morphe's published morphe-patches releases (or
  // direct URL from patches.json that the user authored). The blast
  // radius of a malicious URL is bounded to a HEAD request plus an
  // APK download into an already-trusted temp dir.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUTS.urlVerify);

    // codeql[js/file-access-to-http] reason: `url` is a HEAD-probe for
    // a cached APK download URL from Morphe's patches-list.json or the
    // user's own patches.json. Blast radius is bounded to a HEAD
    // request plus an APK download into a user-owned temp dir.
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow'
    });

    clearTimeout(timeout);
    const isValid = response.ok;
    console.error(`[url-cache] URL verify: ${isValid ? 'valid' : 'invalid'} (${response.status})`);
    return isValid;
  } catch (e) {
    console.error(`[url-cache] URL verify failed: ${e.message}`);
    return false;
  }
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
  const apiUrl = `https://api.pureapk.com/m/v3/cms/app_version?hl=en-US&package_name=${packageId}`;
  // codeql[js/file-access-to-http] reason: apiUrl is the public APKPure
  // protobuf endpoint; only the JSON-parsed bytes are returned, never
  // written to disk.
  const response = await fetch(apiUrl, {
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

  const body = await response.text();

  // Extract every XAPK download URL APKPure returned for this package.
  // The protobuf body is ~400KB of mixed metadata; the URLs are
  // embedded inline (verified by greping the actual response bytes).
  const allUrls = body.match(/https?:\/\/download\.pureapk\.com\/b\/XAPK\/[^"\s\\]+/g) || [];

  // APKPure's URLs encode the version INSIDE the `c` query param as
  // pipe-separated base64-encoded URL-encoded params. The outer param
  // shape is `c=<counter>|<category>|<base64(rest)>` where the base64
  // decodes to `dev=<name>&t=<type>&s=<size>&vn=<version>&vc=<version_code>`.
  // Example inner payload:
  //   c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXhhcGsmcz01NzcwMzk2MyZ2bj0yNi4wOC4wMyZ2Yz0yNjA4MDMwMDI
  //   → base64 decode → "dev=Sofascore&t=xxapk&s=57703963&vn=26.08.03&vc=260803002"
  //
  // The matcher strips any non-printable bytes that leak past the URL
  // boundary (the protobuf response is binary — the URL is followed by
  // framing bytes like `d2 01 f8 01 0a` that the regex preserves).
  const cleanedUrls = allUrls.map((u) => u.replace(/[^\x20-\x7e]/g, ''));
  const matching = cleanedUrls.filter((u) => {
    try {
      const parsed = new URL(u);
      const c = parsed.searchParams.get('c');
      if (!c) return false;
      const parts = c.split('|');
      // parts[0] = counter, parts[1] = category, parts[2] = base64 rest
      if (parts.length < 3) return false;
      const decoded = Buffer.from(parts[2], 'base64').toString('utf8');
      const innerParams = new URLSearchParams(decoded);
      return innerParams.get('vn') === version;
    } catch {
      return false;
    }
  });

  if (matching.length === 0) {
    throw new Error(`No APKPure XAPK URLs found for ${packageId}@${version}`);
  }

  // Sort by declared size (smallest first). The arm64-v8a variant is
  // consistently the smallest of the three per-app variants.
  const withSize = matching.map((u) => {
    try {
      const parsed = new URL(u);
      const c = parsed.searchParams.get('c');
      const innerParams = new URLSearchParams(Buffer.from(c.split('|')[2], 'base64').toString('utf8'));
      return {
        url: u,
        size: parseInt(innerParams.get('s') || '0', 10),
      };
    } catch {
      return { url: u, size: 0 };
    }
  });
  withSize.sort((a, b) => a.size - b.size);

  const chosen = withSize[0];
  console.error(`[apkeep-resolve] APKPure arm64-v8a variant for ${packageId}@${version}: ${chosen.size} bytes`);
  return chosen.url;
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
 * @returns {Promise<object>} { url, source }
 */
async function resolveApkeep(packageId, version) {
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

    execFile('apkeep', args, { timeout: TIMEOUTS.apkeepResolve }, (error, stdout, stderr) => {
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

  // codeql[js/file-access-to-http] reason: apiUrl is the official
  // APKMirror API endpoint; constructed from a hardcoded path + the
  // version selector from Morphe's patches-list.json.
  try {
    // codeql[js/file-access-to-http] reason: same as the apiUrl comment
    // above; this fetch targets the hardcoded APKMirror API host.
    const response = await fetch(apiUrl, {
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
 * @returns {Promise<object>} Download result
 */
async function downloadWithUrl(url, outputDir, packageId, version) {
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

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const MAX_RETRIES = 3;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 1) {
      console.error(`[download-url] Retry attempt ${attempt}/${MAX_RETRIES}...`);
      await sleep((attempt - 1) * 2000);
    }

    // codeql[js/file-access-to-http] reason: argv-style spawn, no shell;
    // URL is constrained by the unified-downloader's upstream sources.
    try {
      const result = await new Promise((resolve, reject) => {
        // codeql[js/file-access-to-http] reason: same as above; the curl
        // invocation is the unified-downloader's intended download path.
        const curl = spawn('curl', ['-L', '-o', outputPath, '-w', '%{http_code}', '--fail', url]);

        let stderr = '';

        curl.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        curl.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`curl failed: ${stderr}`));
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

          // Validate APK version
          const validation = validateApkVersion(outputPath, version);
          if (!validation.valid) {
            // Cleanup-on-failure: delete the partial file so a later
            // fallback source's output isn't pre-empted by this stale
            // file in findPackageCandidate's first-encountered tiebreak
            // (filesystem-dependent readdir order; not guaranteed
            // alphabetical on ext4). Best-effort; never mask the
            // original error.
            try { fs.unlinkSync(outputPath); } catch { /* best-effort */ }
            reject(new Error(`VERSION MISMATCH: expected ${version}, got ${validation.version}`));
            return;
          }

          // Validate ABI composition. If the upstream returned a file
          // that doesn't actually ship the preferred architecture's .so
          // libs, reject the download — the caller's fallback chain
          // (apkmirror-api → apkeep → apkmirror-pw) will try the next
          // source. Without this, a 32-bit-only "universal" APK would
          // get cached and only fail much later inside
          // download-supported-apk.js's ABI guardrail.
          try {
            validateDownloadedApkAbi(outputPath, preferredArchForUrl);
          } catch (e) {
            // Cleanup-on-failure: same rationale as VERSION MISMATCH
            // above. The throw from validateDownloadedApkAbi tells us
            // upstream mislabelled the file; we must not let the
            // partial APK survive to contaminate the next source.
            try { fs.unlinkSync(outputPath); } catch { /* best-effort */ }
            reject(e);
            return;
          }

          console.error(`[download-url] Downloaded and validated: ${outputPath} (${stats.size} bytes)`);
          resolve({
            success: true,
            path: outputPath,
            filename,
            version: validation.version,
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
      if (attempt === MAX_RETRIES) {
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
 * @returns {Promise<object>} { url, source }
 */
async function parallelResolveSources(packageId, version) {
  const sources = [
    { name: 'apkeep', fn: () => resolveApkeep(packageId, version) },
    { name: 'apkmirror-api', fn: () => resolveApkmirrorApi(packageId, version) },
    { name: 'apkmirror', fn: () => resolveApkmirror(packageId, version) },
  ];

  const SOURCE_TIMEOUT = TIMEOUTS.sourceResolve;

  console.error(`[parallel-resolve] Starting parallel resolution for ${packageId} v${version}`);
  const startTime = Date.now();

  const results = await Promise.allSettled(
    sources.map(async (source) => {
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${source.name} timeout`)), SOURCE_TIMEOUT)
      );
      return Promise.race([source.fn(), timeout]);
    })
  );

  const elapsed = Date.now() - startTime;
  console.error(`[parallel-resolve] All sources completed in ${elapsed}ms`);

  // Find first successful resolution
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const sourceName = sources[i].name;

    if (result.status === 'fulfilled' && result.value?.url) {
      console.error(`[parallel-resolve] Winner: ${sourceName}`);
      return { ...result.value, source: result.value.source || sourceName };
    }

    const error = result.reason?.message || 'Unknown error';
    console.error(`[parallel-resolve] ${sourceName} failed: ${error}`);
  }

  throw new Error('All sources failed to resolve URL');
}

/**
 * Parse command-line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    return {
      error: "Usage: unified-downloader.js <package_id> <version> <output_dir>",
      example: "Example: unified-downloader.js com.google.android.youtube 20.40.45 ./downloads"
    };
  }

  const [packageId, version, outputDir] = args;

  // Validate inputs
  if (!packageId || !packageId.includes(".")) {
    return { error: "Invalid package_id. Expected format: com.example.app" };
  }
  if (!version || !/^\d+\.\d+/.test(version)) {
    return { error: "Invalid version. Expected format: X.Y.Z" };
  }
  if (!outputDir) {
    return { error: "Invalid output_dir" };
  }

  return { packageId, version, outputDir };
}

/**
 * Load config.json
 */
function loadConfig() {
  const configPath = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`Warning: Failed to parse config.json: ${e.message}`);
    return {};
  }
}

/**
 * Check config.json for existing URL matching the version
 */
function loadExistingUrl(packageId, version) {
  const config = loadConfig();

  const downloadUrls = config.download_urls?.[packageId];
  if (!downloadUrls) {
    return null;
  }

  // Check for exact version match only — latest_supported is for a specific old version
  // and cannot be used as a direct download URL for a different version
  if (downloadUrls[version]) {
    console.error(`Found existing URL for version ${version} in config.json`);
    return downloadUrls[version];
  }

  return null;
}

/**
 * Run command with execFile and timeout
 */
function runCommand(cmd, args, options = {}) {
  const timeout = options.timeout || TIMEOUTS.commandDefault;

  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, args, {
      timeout,
      stdio: options.stdio || ["pipe", "pipe", "pipe"],
      ...options
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
    const cleanup = () => {
      if (!settled) {
        settled = true;
      }
    };

    proc.on("close", (code) => {
      cleanup();
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr || cmd}`));
      }
    });

    proc.on("error", (err) => {
      cleanup();
      reject(err);
    });

    // Handle timeout
    setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`Command timed out after ${timeout}ms: ${cmd}`));
      }
    }, timeout);
  });
}

/**
 * Validate APK version matches expected version using aapt
 * Returns { valid: boolean, actualVersion: string }
 */
function validateApkVersion(apkPath, expectedVersion) {
  try {
    const { execFileSync } = require("child_process");

    // Try using aapt or aapt2. Use execFileSync with argv arrays
    // (matching the pattern already used in download-supported-apk.js
    // and apk-abi-validator.js) so apkPath is never interpolated into
    // a shell string — defense-in-depth for an untrusted download
    // whose final filename originates upstream.
    const aaptCmd = "aapt";
    let output;
    try {
      output = execFileSync(aaptCmd, ["dump", "badging", apkPath], { encoding: "utf8" });
    } catch (_e) {
      // Try aapt2
      try {
        output = execFileSync("aapt2", ["dump", "badging", apkPath], { encoding: "utf8" });
      } catch (e2) {
        console.error(`[validate] No aapt available: ${e2.message}`);
        return { valid: false, actualVersion: "unknown", error: "aapt not available - cannot validate version" };
      }
    }

    // Extract versionName from output
    const match = output.match(/versionName='([^']+)'/);
    const actualVersion = match ? match[1] : null;

    if (!actualVersion) {
      console.error(`[validate] Could not extract version from APK`);
      return { valid: false, actualVersion: "unknown", error: "could not extract version from APK" };
    }

    console.error(`[validate] APK version: ${actualVersion}, expected: ${expectedVersion}`);

    if (actualVersion !== expectedVersion) {
      console.error(`[validate] VERSION MISMATCH! Got ${actualVersion} but wanted ${expectedVersion}`);
      return { valid: false, actualVersion, error: `version mismatch: got ${actualVersion}, wanted ${expectedVersion}` };
    }

    return { valid: true, actualVersion };
  } catch (e) {
    console.error(`[validate] Error validating APK: ${e.message}`);
    return { valid: false, actualVersion: "unknown", error: e.message };
  }
}

/**
 * Find downloaded APK in output directory
 */
function findApkFile(outputDir) {
  if (!fs.existsSync(outputDir)) {
    return null;
  }
  const extensions = [".apk", ".xapk", ".apkm"];
  const files = fs.readdirSync(outputDir);

  for (const file of files) {
    const lower = file.toLowerCase();
    for (const ext of extensions) {
      if (lower.endsWith(ext)) {
        return path.join(outputDir, file);
      }
    }
  }
  return null;
}

/**
 * Download using apkeep (APKPure)
 */
async function downloadWithApkeep(packageId, version, outputDir) {
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
      timeout: TIMEOUTS.apkeepDownload
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
          const validation = validateApkVersion(apkPath, version);
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

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
      locale: 'en-US',
      acceptDownloads: true,
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9', 'DNT': '1' },
    });
    const page = await context.newPage();

    // Page 1: Release page → select variant using priority list
    const page1Url = buildReleasePageUrl(apkmirrorPath, version);
    console.error(`[apkmirror-pw] Page 1: ${page1Url}`);
    await page.goto(page1Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const $1 = cheerio.load(await page.content());
    const variantHref = selectVariant($1, priorities);

    // Page 2: Variant page → find download button
    const page2Url = `https://www.apkmirror.com${variantHref}`;
    console.error(`[apkmirror-pw] Page 2: ${page2Url}`);
    await page.goto(page2Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const $2 = cheerio.load(await page.content());
    const dlButtonHref = $2('a.downloadButton[href]').attr('href');
    if (!dlButtonHref) throw new Error('Download button not found on APKMirror variant page');

    // Page 3: Download confirmation page → click final link within browser session
    const page3Url = `https://www.apkmirror.com${dlButtonHref}`;
    console.error(`[apkmirror-pw] Page 3: ${page3Url}`);
    await page.goto(page3Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
 * Resolve APKMirror direct APK download URL using fetch + cheerio (3-page navigation).
 * Page 1: Release page → find correct arch/DPI/type variant row
 * Page 2: Variant page → find download button
 * Page 3: Download page → find final APK link
 */
async function resolveApkmirrorUrlViaCurl(apkmirrorPath, version, priorities) {
  // Page 1: Release page
  const page1Url = buildReleasePageUrl(apkmirrorPath, version);
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

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'DNT': '1',
      },
    });
    const page = await context.newPage();

    // Page 1: Release page
    const page1Url = buildReleasePageUrl(apkmirrorPath, version);
    console.error(`[apkmirror-scraper] Page 1 (PW): ${page1Url}`);
    await page.goto(page1Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html1 = await page.content();
    const $1 = cheerio.load(html1);
    const variantHref = selectVariant($1, priorities);

    // Page 2: Variant page
    const page2Url = `https://www.apkmirror.com${variantHref}`;
    console.error(`[apkmirror-scraper] Page 2 (PW): ${page2Url}`);
    await page.goto(page2Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const html2 = await page.content();
    const $2 = cheerio.load(html2);
    const downloadButtonHref = $2('a.downloadButton[href]').attr('href');
    if (!downloadButtonHref) throw new Error('Download button not found on APKMirror variant page');

    // Page 3: Download page. The actual download URL is the `#download-link`
    // element (not the generic `a[data-google-interstitial="false"]` selector
    // which matches ~96 unrelated sidebar nav links on the same page).
    const page3Url = `https://www.apkmirror.com${downloadButtonHref}`;
    console.error(`[apkmirror-scraper] Page 3 (PW): ${page3Url}`);
    await page.goto(page3Url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
 * Main download function with fallback chain
 */
/**
 * Main download function with improved reliability:
 * 1. Check URL cache -> if valid, use directly
 * 2. Check patches.json -> if has URL, verify and use
 * 3. Parallel resolution -> first valid URL wins
 * 4. Download from URL
 * 5. Save to cache on success
 * 6. Fallback to sequential on all parallel fail
 */
async function download(packageId, version, outputDir) {
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Step 1: Check URL cache
  const cachedUrl = getCachedUrl(packageId, version);
  if (cachedUrl) {
    console.error(`[download] Trying cache for ${packageId} v${version}`);
    try {
      const isValid = await verifyUrl(cachedUrl.url);
      if (isValid) {
        const result = await downloadWithUrl(cachedUrl.url, outputDir, packageId, version);
        // Update cache with incremented download count
        saveCachedUrl(packageId, version, cachedUrl.url, cachedUrl.source);
        return result;
      }
    } catch (e) {
      console.error(`[download] Cache URL invalid: ${e.message}`);
    }
  }

  // Step 2: Check patches.json for existing URL
  const existingUrl = loadExistingUrl(packageId, version);
  if (existingUrl) {
    console.error(`[download] Trying patches.json URL for ${packageId} v${version}`);
    try {
      const isValid = await verifyUrl(existingUrl);
      if (isValid) {
        const result = await downloadWithUrl(existingUrl, outputDir, packageId, version);
        // Save to our URL cache
        saveCachedUrl(packageId, version, existingUrl, 'patches.json');
        return result;
      }
    } catch (e) {
      console.error(`[download] patches.json URL invalid: ${e.message}`);
    }
  }

  // Step 3: Try parallel resolution
  console.error(`[download] Starting parallel resolution for ${packageId} v${version}`);
  try {
    const resolved = await parallelResolveSources(packageId, version);
    const result = await downloadWithUrl(resolved.url, outputDir, packageId, version);
    // Save to URL cache
    saveCachedUrl(packageId, version, resolved.url, resolved.source);
    return result;
  } catch (e) {
    console.error(`[download] Parallel resolution failed: ${e.message}`);
  }

  // Step 4: Fallback to sequential (existing behavior)
  console.error(`[download] Falling back to sequential resolution`);

  // Try apkeep
  console.error(`[apkeep] Attempting download for ${packageId} v${version}`);
  try {
    const result = await downloadWithApkeep(packageId, version, outputDir);
    const url = result.url || `apkeep:${packageId}@${version}`;
    saveCachedUrl(packageId, version, url, 'apkeep');
    return result;
  } catch (e) {
    console.error(`[apkeep] Failed: ${e.message}`);
  }

  // Try APKMirror API
  console.error(`[apkmirror-api] Attempting download for ${packageId} v${version} via API`);
  try {
    const result = await downloadWithApkmirrorApi(packageId, version, outputDir);
    saveCachedUrl(packageId, version, result.url, 'apkmirror-api');
    return result;
  } catch (e) {
    console.error(`[apkmirror-api] Failed: ${e.message}`);
  }

  // Try APKMirror Playwright - last resort
  console.error(`[apkmirror] Starting APKMirror Playwright fallback...`);
  try {
    const result = await downloadWithApkmirror(packageId, version, outputDir);
    saveCachedUrl(packageId, version, result.url, 'apkmirror');
    return result;
  } catch (e) {
    console.error(`[apkmirror] Failed: ${e.message}`);
    throw e;
  }
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
  selectVariant,
  collectCookies,
  resolveApkmirrorUrl,
  resolveApkeep,
  resolveApkeepVariant,
  cleanupOldUrls,
  parallelResolveSources,
  download,
  // Exported for the cleanup-on-failure unit tests
  // (__tests__/unified-downloader-cleanup.test.js). They exercise the
  // post-download validation paths in isolation rather than driving
  // them through the full download() fallback chain.
  downloadWithUrl,
  downloadWithApkeep,
};
