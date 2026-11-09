#!/usr/bin/env node
'use strict';

/**
 * extra-patches.js — named patches from other GitHub patch sources.
 *
 * `patch_repos[app].extra_patches` is `{ "owner/repo": ["Patch name", ...] }`.
 * The check job pins each extra source to one release (`resolveExtraTags`) so
 * every app in a run uses the same bundle; `extra_patch_args.sh` downloads and
 * SHA-256-verifies it, and `extraPatchArgs` builds the morphe-desktop flags.
 * The tag is deliberately not part of the build fingerprint: a new release of
 * an extra source alone rebuilds nothing. The setting itself is in the
 * fingerprint, because it is part of the app entry.
 */

const { execFileSync } = require('node:child_process');

/** Local path of an extra bundle, derived from its repo slug. */
function extraBundlePath(toolsDir, repo) {
  return `${toolsDir}/extra-${repo.replace(/\//g, '-')}.mpp`;
}

/** The app's extra patches as `{ repo: [names] }`; empty when unset. */
function extraPatchesOf(entry) {
  const extra = entry?.extra_patches;
  return extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
}

/** Extra repos that need their own bundle (those other than the app's own). */
function extraBundleRepos(entry, mainRepo) {
  return Object.entries(extraPatchesOf(entry))
    .filter(([repo, names]) => repo !== mainRepo && names.length > 0)
    .map(([repo]) => repo);
}

/**
 * morphe-desktop arguments for the extra patches. The app's own repo goes
 * first and without `--patches`, so its `-e` flags join the main bundle (the
 * CLI groups selections with the `--patches` that precedes them).
 */
function extraPatchArgs(entry, mainRepo, toolsDir) {
  const args = [];
  const repos = Object.keys(extraPatchesOf(entry));
  for (const repo of [...repos.filter((r) => r === mainRepo), ...repos.filter((r) => r !== mainRepo)]) {
    const names = extraPatchesOf(entry)[repo];
    if (repo !== mainRepo && names.length > 0) args.push(`--patches=${extraBundlePath(toolsDir, repo)}`);
    for (const name of names) args.push('-e', name);
  }
  return args;
}

function latestTag(repo) {
  return execFileSync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName', '-q', '.tagName'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
}

/**
 * `{ appId: { "owner/repo": "tag" } }` for apps with extra bundles, resolving
 * each repo's latest release once. A repo whose tag can't be resolved is left
 * out with a warning; the build then looks up that repo's latest itself and
 * fails if it can't fetch the bundle.
 */
function resolveExtraTags(config, lookup = latestTag, warn = console.log) {
  const tags = new Map();
  const result = {};
  for (const [appId, entry] of Object.entries(config.patch_repos || {})) {
    for (const repo of extraBundleRepos(entry, entry.repo)) {
      if (!tags.has(repo)) {
        let tag = '';
        try { tag = lookup(repo) || ''; } catch (err) {
          warn(`::warning::Could not resolve the latest release of ${repo}: ${String(err.message || err).split('\n')[0]}`);
        }
        tags.set(repo, tag);
      }
      if (tags.get(repo)) (result[appId] ||= {})[repo] = tags.get(repo);
    }
  }
  return result;
}

// Shell interface for extra_patch_args.sh. Env: APP_ID, PATCH_REPO, TOOLS_DIR,
// CONFIG_FILE, EXTRA_PATCH_TAGS (JSON `{ repo: tag }`, may be empty).
//   repos        bundle repos to fetch, one per line
//   tag <repo>   the pinned tag for <repo>, or nothing
//   args         NUL-separated morphe-desktop arguments
if (require.main === module) {
  const fs = require('node:fs');
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE || 'config.json', 'utf8'));
  const entry = config.patch_repos[process.env.APP_ID];
  const [command, repo] = process.argv.slice(2);
  if (command === 'repos') {
    for (const r of extraBundleRepos(entry, process.env.PATCH_REPO)) console.log(r);
  } else if (command === 'tag') {
    const pinned = process.env.EXTRA_PATCH_TAGS ? JSON.parse(process.env.EXTRA_PATCH_TAGS) : {};
    if (pinned?.[repo]) console.log(pinned[repo]);
  } else if (command === 'args') {
    for (const arg of extraPatchArgs(entry, process.env.PATCH_REPO, process.env.TOOLS_DIR)) process.stdout.write(`${arg}\0`);
  } else {
    console.error(`Usage: extra-patches.js repos | tag <repo> | args`);
    process.exit(2);
  }
}

module.exports = { extraBundlePath, extraPatchesOf, extraBundleRepos, extraPatchArgs, resolveExtraTags };
