#!/usr/bin/env node
//
// scripts/merge-patches.js
//
// Pure merge helper used by .github/scripts/pipeline/sync-patches.sh.
// Combines the upstream-derived defaults for ONE patch repo with the
// user's existing toggles (across ALL repos in the current patches.json)
// to produce the merged section for that target repo.
//
// Critical contract: when an app has moved repos in config.json (e.g.
// sofascore from heval99/morphe-patches to hoo-dles/morphe-patches),
// the user's existing per-patch toggles for that app MUST be carried
// over to the new repo's section — otherwise the final ACTIVE_REPOS
// drop step in sync-patches.sh would silently lose them. This helper
// makes that explicit and unit-testable.

'use strict';

/**
 * Build the merged section for one target repo.
 *
 * Lookup priority for an existing per-pkg toggle map:
 *   1. baseAllRepos[targetRepo][pkg] — same-repo lookup, preserves the
 *      legacy path; identical to the pre-relocation sync-patches.sh.
 *   2. baseAllRepos[any other repo][pkg] — picked up if (1) misses, so
 *      apps that moved repo in config.json keep their existing toggles.
 *      When multiple other repos carry the same pkg (corrupt but possible
 *      if someone hand-edited patches.json), the first match wins in
 *      insertion-order of Object.keys.
 *
 * Per-patch-name handling mirrors sync-patches.sh's pre-existing rule:
 * `has()` is used so that an explicit `false` toggled by the user is
 * preserved; jq's `//` falls back on both null AND false and would
 * silently flip `false` toggles back to `true`.
 *
 * @param {object} args
 * @param {object<string, object<string, boolean>>} args.defaultsForTargetRepo
 *   Defaults built from the upstream patches-list.json, scoped to apps
 *   whose config.patch_repos[pkg].repo === targetRepo. Keys are package
 *   ids; values are `{patchName: true, ...}` (every compatible patch
 *   on by default).
 * @param {object<string, object<string, object<string, boolean>>>} args.baseAllRepos
 *   The full existing patches.json. Top-level keys are repo names
 *   (owner/repo); the values are `{pkg: {patchName: bool, ...}}`.
 * @param {string} args.targetRepo
 *   The repo whose merged section this call is building.
 * @returns {object<string, object<string, boolean>>}
 *   The merged section to be written under `baseAllRepos[targetRepo]`.
 */
function mergeRepoEntries({ defaultsForTargetRepo, baseAllRepos, targetRepo }) {
  const defaults = defaultsForTargetRepo || {};
  const base = baseAllRepos && typeof baseAllRepos === 'object' ? baseAllRepos : {};
  const ownSection = (base[targetRepo] && typeof base[targetRepo] === 'object')
    ? base[targetRepo]
    : {};

  const merged = {};
  for (const pkg of Object.keys(defaults)) {
    // (1) own-repo lookup
    let pkgExisting = null;
    if (Object.prototype.hasOwnProperty.call(ownSection, pkg)
        && ownSection[pkg] && typeof ownSection[pkg] === 'object') {
      pkgExisting = ownSection[pkg];
    } else {
      // (2) relocation fallback: first match in any other repo
      for (const otherRepo of Object.keys(base)) {
        if (otherRepo === targetRepo) continue;
        const section = base[otherRepo];
        if (!section || typeof section !== 'object') continue;
        if (Object.prototype.hasOwnProperty.call(section, pkg)
            && section[pkg] && typeof section[pkg] === 'object') {
          pkgExisting = section[pkg];
          break;
        }
      }
    }
    pkgExisting = pkgExisting || {};

    const mergedPkg = {};
    for (const patchName of Object.keys(defaults[pkg])) {
      // `has()` semantics: explicit `false` from the user must survive.
      mergedPkg[patchName] = Object.prototype.hasOwnProperty.call(pkgExisting, patchName)
        ? pkgExisting[patchName]
        : true;
    }
    merged[pkg] = mergedPkg;
  }
  return merged;
}

/**
 * Drop repo keys from patches.json that are no longer referenced by any
 * app in config.json. Reproduces the trailing ACTIVE_REPOS filter in
 * sync-patches.sh so it can be unit-tested independently of bash.
 *
 * @param {object<string, object>} patches
 * @param {Set<string> | string[]} activeRepos
 * @returns {object<string, object>}
 */
function pruneInactiveRepos(patches, activeRepos) {
  const allowed = activeRepos instanceof Set ? activeRepos : new Set(activeRepos);
  const out = {};
  for (const repo of Object.keys(patches)) {
    if (allowed.has(repo)) out[repo] = patches[repo];
  }
  return out;
}

module.exports = { mergeRepoEntries, pruneInactiveRepos };

if (require.main === module) {
  // Tiny CLI hook so callers can pipe JSON via stdin. The shell pipeline
  // uses this rather than shelling out to a one-off jq program.
  const chunks = [];
  process.stdin.on('data', (chunk) => chunks.push(chunk));
  process.stdin.on('end', () => {
    const args = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const result = {
      merged: mergeRepoEntries(args),
      pruned: args.prune && pruneInactiveRepos(args.prune.patches, args.prune.activeRepos),
    };
    process.stdout.write(JSON.stringify(result));
  });
}
