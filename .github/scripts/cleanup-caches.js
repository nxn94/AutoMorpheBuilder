#!/usr/bin/env node

/**
 * Clean up stale GitHub Actions caches for the AutoMorpheBuilder project.
 *
 * Caches accumulate because several `actions/cache` steps are keyed by
 * morphe-desktop version, morphe-patches tag, or per-app APK version. Each new
 * version creates a new cache entry, and GitHub's default cache eviction
 * only removes entries that haven't been accessed in 7 days - which means
 * superseded versions linger for up to a week after being replaced.
 *
 * This script identifies the *currently in use* version for each cache
 * pattern (from config.json) and deletes all other matching caches.
 * It always keeps:
 *   - the newest entry per pattern (to avoid breaking in-flight runs); for the
 *     per-app apk- caches that means the newest entry of EACH app, and the
 *     apk-urls- (downloader URL cache) entries are a pattern of their own
 *   - APK caches for currently-pinned apps (from config.json)
 *
 * Run modes:
 *   node cleanup-caches.js            # dry-run, prints what would be deleted
 *   node cleanup-caches.js --apply    # actually delete the stale entries
 *
 * Required env:
 *   GH_TOKEN         - GitHub token with `actions:write` scope
 *   GITHUB_REPOSITORY - owner/repo (set automatically by GitHub Actions)
 *
 * Exits 0 on success (or if there is nothing to do), non-zero on error.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APPLY = process.argv.includes('--apply');

function resolveRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;

  // Fall back to the git origin if GITHUB_REPOSITORY isn't set (local dev).
  try {
    const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
    }).trim();
    const m = origin.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
  } catch {
    /* ignore */
  }

  throw new Error(
    'GITHUB_REPOSITORY is not set and could not be inferred from git origin. ' +
      'Set it (e.g. export GITHUB_REPOSITORY=owner/repo) or run from a CI runner.'
  );
}

const CACHE_PATTERNS = {
  'morphe-tools-desktop-': 'cli',
  'morphe-desktop-': 'cli',
  'morphe-patches-': 'patches',
  'apk-urls-': 'apk-urls',
  'apk-': 'apk',
};

// `classifyCache` iterates Object.keys(CACHE_PATTERNS) in insertion order.
// 'apk-' is likewise a prefix of 'apk-urls-', which is the downloader URL
// cache, not an APK.
// 'morphe-desktop-' is a prefix of 'morphe-tools-desktop-', so without this
// ordering every morphe-tools-desktop-* cache would be misclassified as the
// shorter morphe-desktop- group. We keep the longer prefix first so the
// more-specific match wins. The map below re-asserts this order regardless
// of how the keys above were entered — defence in depth against future
// reordering.
const CACHE_PATTERNS_ORDERED = Object.keys(CACHE_PATTERNS).sort(
  (a, b) => b.length - a.length
);

function loadConfig() {
  const p = path.join(process.cwd(), 'config.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Compute the set of "active" cache keys (full keys) that must be kept
 * regardless of age. Each pattern may have multiple active keys (e.g. one
 * per app for the apk pattern).
 *
 * Currently only retains apk caches that are known to be pinned or have a
 * resolved latest_supported URL. The newest cache per pattern is always
 * kept by main() as a safety backup regardless of this list.
 *
 * @returns {string[]} Set of full cache keys to keep.
 */
function computeActiveKeys() {
  const config = loadConfig();
  const active = new Set();

  // --- apk-<appId>-<version> (keyed per app) ---
  if (config) {
    const patchRepos = config.patch_repos || {};
    const downloadUrls = config.download_urls || {};
    for (const [appId, info] of Object.entries(patchRepos)) {
      // Pinned version wins.
      if (info.pin_version) {
        active.add(`apk-${appId}-${info.pin_version}-`);
      }
      // Otherwise, keep the version whose URL is the "latest_supported".
      // We can't know the version from a URL alone, so we keep the bare
      // apk-<appId>- prefix entry as a soft match (any apk cache for this
      // app is "in use" until the next build writes a new one).
      if (downloadUrls[appId]?.latest_supported) {
        active.add(`apk-${appId}-`);
      }
    }
  }

  return [...active];
}

function listCaches(repo = resolveRepo()) {
  // gh cache list returns JSON when --json is set. id + key + createdAt is
  // the minimum we need.
  const out = execFileSync(
    'gh',
    [
      'cache',
      'list',
      '--repo',
      repo,
      '--json',
      'id,key,createdAt,sizeInBytes',
      '--limit',
      '500',
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

function classifyCache(cache) {
  for (const prefix of CACHE_PATTERNS_ORDERED) {
    if (cache.key.startsWith(prefix)) return prefix;
  }
  return null;
}

/**
 * The group within which only the newest cache is kept as a safety backup.
 * Most patterns are one group; apk-<appId>-<version> caches are grouped per
 * app (package ids contain no hyphen), so one app's newest cache is not
 * counted as another app's backup.
 */
function cacheGroup(cache) {
  const prefix = classifyCache(cache);
  if (prefix !== 'apk-') return prefix;
  const end = cache.key.indexOf('-', prefix.length);
  return end === -1 ? cache.key : cache.key.slice(0, end);
}

/**
 * Pure: which caches are stale. Keeps everything matching activeKeys and the
 * newest cache of each group (see cacheGroup).
 *
 * @returns {{toDelete: object[], bytesToFree: number}}
 */
function planDeletions(caches, activeKeys) {
  const byGroup = new Map();
  for (const c of caches) {
    const group = cacheGroup(c);
    if (!group) continue; // not ours
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(c);
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }
  const safeToKeep = new Set(activeKeys);
  for (const list of byGroup.values()) {
    if (list[0]) safeToKeep.add(list[0].key);
  }
  const toDelete = [];
  let bytesToFree = 0;
  for (const list of byGroup.values()) {
    for (const c of list) {
      if (!isActive(c.key, [...safeToKeep])) {
        toDelete.push(c);
        bytesToFree += c.sizeInBytes || 0;
      }
    }
  }
  return { toDelete, bytesToFree };
}

function isActive(cacheKey, activeKeys) {
  for (const active of activeKeys) {
    if (active.endsWith('-') && cacheKey.startsWith(active)) return true;
    if (cacheKey === active) return true;
  }
  return false;
}

function deleteCache(cache, repo = resolveRepo()) {
  // The `gh cache delete` command doesn't actually need a confirmation
  // flag — it deletes without prompting. The `--yes` flag was added in a
  // newer version of gh than the one currently on the runner, so we
  // don't pass it (it would be an "unknown flag" error on older gh).
  execFileSync('gh', ['cache', 'delete', String(cache.id), '--repo', repo], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function main() {
  const repo = resolveRepo();
  console.log(`Repository: ${repo}`);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN (use --apply to actually delete)'}`);

  const activeKeys = computeActiveKeys();
  console.log(`\nActive keys to preserve (${activeKeys.length}):`);
  for (const k of activeKeys) console.log(`  ${k}`);

  let caches;
  try {
    caches = listCaches(repo);
  } catch (e) {
    console.error(`Failed to list caches: ${e.message}`);
    process.exit(1);
  }

  console.log(`\nTotal project-related caches: ${caches.length}`);

  const { toDelete, bytesToFree } = planDeletions(caches, activeKeys);

  if (toDelete.length === 0) {
    console.log('\nNothing to clean up - all caches are either active or kept as backup.');
    return;
  }

  console.log(
    `\n${APPLY ? 'Deleting' : 'Would delete'} ${toDelete.length} stale caches ` +
      `(recovering ~${formatSize(bytesToFree)}):`
  );
  for (const c of toDelete) {
    console.log(`  - ${c.key}  (${formatSize(c.sizeInBytes)}, id=${c.id}, created=${c.createdAt})`);
  }

  if (!APPLY) {
    console.log('\nRe-run with --apply to actually delete these caches.');
    return;
  }

  let failed = 0;
  for (const c of toDelete) {
    try {
      deleteCache(c, repo);
      console.log(`  deleted ${c.key}`);
    } catch (e) {
      failed++;
      console.error(`  FAILED to delete ${c.key}: ${e.message}`);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} cache(s) failed to delete.`);
    process.exit(1);
  }
  console.log(`\nDone. Deleted ${toDelete.length} stale cache(s).`);
}

// Export pure helpers for unit tests; only run main() when executed
// directly (so `node cleanup-caches.js` works as before, and Jest can
// `require()` the module without side-effects).
module.exports = {
  CACHE_PATTERNS,
  CACHE_PATTERNS_ORDERED,
  classifyCache,
  cacheGroup,
  planDeletions,
  isActive,
  computeActiveKeys,
  resolveRepo,
  formatSize,
};

if (require.main === module) main();
