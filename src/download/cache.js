'use strict';

/**
 * URL cache helpers extracted from
 * `.github/scripts/unified-downloader.js`.
 *
 * The cache lives at `~/.cache/auto-morphe-builder/urls/<packageId>/<version>.json`
 * and stores the most-recently-resolved APK URL plus `source`,
 * `downloads`, and `lastWorkingAt` analytics. This is local-only state
 * — never uploaded, never synced — so its trust boundary is the
 * workflow itself.
 *
 * `getCachedUrl`/`saveCachedUrl`/`cleanupOldUrls` accept an explicit
 * `cacheDir` argument. The default is the user-owned default-dir, but
 * tests pass a tmpfs path so they don't share state with the host.
 *
 * Pruning: `cleanupOldUrls` keeps the `keep` newest entries (by
 * mtime) and unlinks the rest. Default `keep=3` is a small window
 * because the cache is per-version — an app's typical lifetime is
 * 5–20 versions before the next major release, and a build only
 * ever pulls one at a time, so 3 entries cover recent work without
 * unbounded growth.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'auto-morphe-builder', 'urls');

function packageDir(packageId, cacheDir) {
  return path.join(cacheDir, packageId);
}

function cacheFileFor(packageId, version, cacheDir) {
  // Sanitize version before joining — caller controls `version` text;
  // `packageId` reaches us already sanitized (it's a Java package
  // name, so the filesystem-unsafe character set is empty).
  const safeVersion = version.replace(/[^a-zA-Z0-9.-]/g, '_');
  return path.join(packageDir(packageId, cacheDir), `${safeVersion}.json`);
}

/**
 * @param {string} packageId
 * @param {string} version
 * @param {string} [cacheDir] Override for the cache root directory
 *                             (defaults to ~/.cache/auto-morphe-builder/urls).
 * @returns {object|null} Parsed cache entry, or null when missing/corrupt.
 */
function getCachedUrl(packageId, version, cacheDir = DEFAULT_CACHE_DIR) {
  const cacheFile = cacheFileFor(packageId, version, cacheDir);
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
 * Persist a freshly-resolved URL into the cache. Increments the
 * `downloads` counter on the existing entry (if any) so the cache
 * surfaces how often the workflow relied on each cached URL — useful
 * for triaging stale entries at cleanup time.
 *
 * @param {string} packageId
 * @param {string} version
 * @param {string} url  Resolved APK URL.
 * @param {string} source  Free-form source identifier ("apkeep",
 *                          "apkmirror-api", "configured", "local").
 * @param {string} [cacheDir]
 * @returns {string} Absolute path to the cache file that was written.
 */
function saveCachedUrl(packageId, version, url, source, cacheDir = DEFAULT_CACHE_DIR) {
  if (!packageId || !version || !url) {
    throw new Error('Missing required parameters');
  }

  const dir = packageDir(packageId, cacheDir);
  if (!fs.existsSync(dir)) {
    // recursive:true is atomic on POSIX when the parent already
    // exists; the only race is between existsSync and mkdirSync, and
    // an attacker that can race this directory already owns the
    // workflow (the cache lives under the runner user's $HOME).
    fs.mkdirSync(dir, { recursive: true });
  }
  const cacheFile = cacheFileFor(packageId, version, cacheDir);

  let prior = { downloads: 0, lastWorkingAt: null };
  if (fs.existsSync(cacheFile)) {
    try {
      prior = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      console.error(`[url-cache] Corrupted cache file, recreating: ${e.message}`);
    }
  }
  const now = new Date().toISOString();
  const next = {
    version,
    url,
    source,
    resolvedAt: now,
    downloads: prior.downloads + 1,
    lastWorkingAt: now,
  };
  fs.writeFileSync(cacheFile, JSON.stringify(next, null, 2));
  console.error(`[url-cache] Saved: ${packageId} v${version} from ${source}`);

  // Best-effort prune — never blocks the save.
  cleanupOldUrls(packageId, 3, cacheDir);

  return cacheFile;
}

/**
 * Prune URL cache entries for a package, keeping only the most-recently
 * updated `keep` entries.
 *
 * @param {string} packageId
 * @param {number} [keep=3]
 * @param {string} [cacheDir]
 * @returns {number} Number of entries deleted (0 if the package had
 *                   no cache dir or already had ≤ `keep` entries).
 */
function cleanupOldUrls(packageId, keep = 3, cacheDir = DEFAULT_CACHE_DIR) {
  const dir = packageDir(packageId, cacheDir);
  if (!fs.existsSync(dir)) {
    return 0;
  }
  const entries = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const fp = path.join(dir, f);
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

module.exports = {
  DEFAULT_CACHE_DIR,
  getCachedUrl,
  saveCachedUrl,
  cleanupOldUrls,
};
