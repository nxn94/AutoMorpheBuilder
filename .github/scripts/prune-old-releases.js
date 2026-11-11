#!/usr/bin/env node
'use strict';

/**
 * prune-old-releases.js
 *
 * After a successful build, prune GitHub Releases so each app keeps only
 * the N most recently built releases (default N=2). Older releases
 * and their underlying git tags are deleted via `gh release delete
 * --cleanup-tag`. Runs as the last step in the create-release job so a
 * fresh publish becomes the newest and the rest fall out of the
 * keep-window.
 *
 * Tag format reminder (matches create_release.sh):
 *   <name>-v<apk>-<patches>
 * e.g. youtube-v20.44.38-v1.24.0-dev.8
 *
 * Matching strategy: for each app in config.json patch_repos, filter
 * releases whose tagName matches the literal-prefix regex
 *   ^<name>-v
 * The trailing `-v` is the separator between the app name and the APK
 * version, so an app named `youtube` cannot accidentally match a tag
 * starting with `youtube-music-…`. App names with special characters
 * are regex-escaped before constructing the pattern.
 *
 * Selection rule: for each app's matching releases, sort by when each was
 * last built, newest first, keep the first KEEP_COUNT, delete the rest.
 * A rebuild of the same version replaces the release's files in place, and
 * GitHub keeps its first publishedAt, so the last build is read from
 * build-inputs.json (uploaded last), or else the newest file, or else
 * publishedAt. Ties break on tagName descending so the deletion order is
 * deterministic.
 *
 * Idempotent: re-running with the same release list and keep-count is a
 * no-op. A missing tag (already deleted by another run) is logged as
 * a warning rather than failing the step.
 *
 * Environment:
 *   CONFIG_FILE   optional  default ./config.json
 *   KEEP_COUNT    optional  default 2; non-negative integer
 *   GH_TOKEN      required  the workflow's GITHUB_TOKEN
 *
 * Outputs:
 *   none (writes only via `gh release delete`).
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const CONFIG_FILE = process.env.CONFIG_FILE || './config.json';
const RAW_KEEP_COUNT = process.env.KEEP_COUNT || '2';
const GH_TOKEN = process.env.GH_TOKEN || '';

/**
 * Pure: when a release was last built, as an RFC3339 string ('' if unknown).
 * A rebuild of the same version replaces the release's files but keeps its
 * first publishedAt. build-inputs.json is uploaded last, so a rebuild that
 * stopped part-way still counts from the build before it. A draft (no
 * publishedAt) stays the oldest, as before.
 */
function lastBuilt(release) {
  const published = release.publishedAt || '';
  if (!published) return '';
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const inputs = assets.find((a) => a && a.name === 'build-inputs.json' && a.updatedAt);
  const times = inputs ? [inputs.updatedAt] : assets.map((a) => (a && a.updatedAt) || '');
  return [published, ...times].reduce((max, t) => (t > max ? t : max), '');
}

/**
 * Pure: select which tags to delete for one app.
 *
 * releases   array of { tagName, publishedAt, assets?: [{ name, updatedAt }] }
 * appName    the app's short name from config.json patch_repos[*].name
 * keepCount  number of newest releases to retain
 *
 * Returns array of tagName strings to delete, oldest-first. Empty when
 * matching releases <= keepCount.
 */
function selectTagsToDelete(releases, appName, keepCount) {
  // Escape regex metacharacters so a future app name containing `.`,
  // `+`, etc. is matched literally and doesn't widen the prefix.
  const escaped = String(appName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = new RegExp(`^${escaped}-v`);
  const matches = releases
    .filter((r) => typeof r.tagName === 'string' && prefix.test(r.tagName))
    // RFC3339 lexicographic sort = chronological sort. Falls back to
    // tagName descending so two releases built in the same second
    // get a deterministic order (cheaper than sorting on unstable
    // keys).
    .sort((a, b) => {
      const ta = lastBuilt(a);
      const tb = lastBuilt(b);
      if (ta !== tb) return tb.localeCompare(ta); // newest first
      return b.tagName.localeCompare(a.tagName);
    });
  if (matches.length <= keepCount) return [];
  // Keep matches[0..keepCount-1]; delete the rest. Reverse so the
  // caller deletes oldest-first (matches[keepCount] is the next-oldest).
  return matches.slice(keepCount).map((r) => r.tagName).reverse();
}

/**
 * Fetch every release in the repo with its publish time and its files'
 * upload times (`gh release list` has no file times). One line of JSON per
 * release, every page.
 */
function listReleases() {
  const out = execFileSync(
    'gh',
    ['api', '--paginate', 'repos/{owner}/{repo}/releases?per_page=100', '--jq',
      '.[] | {tagName: .tag_name, publishedAt: .published_at, assets: [.assets[]? | {name, updatedAt: .updated_at}]} | tojson'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  try {
    return out.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  } catch (e) {
    throw new Error(`Failed to parse the release list from gh api: ${e.message}`, { cause: e });
  }
}

function deleteRelease(tag) {
  execFileSync(
    'gh',
    ['release', 'delete', tag, '--cleanup-tag', '--yes'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function main() {
  if (!GH_TOKEN) {
    console.error('::error::GH_TOKEN is required for GitHub API access.');
    process.exit(1);
  }
  const keepCount = parseInt(RAW_KEEP_COUNT, 10);
  if (!Number.isFinite(keepCount) || keepCount < 0) {
    console.error(`::error::KEEP_COUNT must be a non-negative integer; got ${RAW_KEEP_COUNT}`);
    process.exit(1);
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error(`::error::Failed to read ${CONFIG_FILE}: ${e.message}`);
    process.exit(1);
  }
  const apps = Object.entries(config.patch_repos || {});
  if (apps.length === 0) {
    console.error('::error::config.json patch_repos is empty; nothing to prune.');
    process.exit(1);
  }

  let releases;
  try {
    releases = listReleases();
  } catch (e) {
    // Hard gate: if we can't list releases, we can't prune them. Failing
    // the step surfaces the issue in the workflow UI rather than letting
    // releases accumulate silently past the keep-window.
    console.error(`::error::Failed to list releases: ${e.message}`);
    process.exit(1);
  }

  let totalDeleted = 0;
  for (const [, cfg] of apps) {
    const tags = selectTagsToDelete(releases, cfg.name, keepCount);
    if (tags.length === 0) continue;
    console.log(`[${cfg.name}] pruning ${tags.length} old release(s); keeping newest ${keepCount}.`);
    for (const tag of tags) {
      try {
        deleteRelease(tag);
        totalDeleted++;
        console.log(`  ::notice::deleted ${tag}`);
      } catch (e) {
        // A missing tag (race with another run, or a manual delete
        // since the list call) surfaces as non-zero exit; log + continue
        // rather than failing the build over a single stale tag.
        const stderr = (e.stderr || e.message || '').toString().trim();
        console.log(`  ::warning::could not delete ${tag}: ${stderr.split('\n')[0]}`);
      }
    }
  }

  if (totalDeleted === 0) {
    console.log(`::notice::No releases exceeded the keep-count of ${keepCount}; nothing pruned.`);
  } else {
    console.log(`::notice::Pruned ${totalDeleted} old release(s); kept ${keepCount} per app.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { lastBuilt, selectTagsToDelete, listReleases, deleteRelease, main };