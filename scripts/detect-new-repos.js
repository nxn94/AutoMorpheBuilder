#!/usr/bin/env node
//
// scripts/detect-new-repos.js
//
// Gate on the push trigger of .github/workflows/update-patches.yml. Decides
// whether sync-patches.sh needs to run after a config.json change.
//
// Returns true when EITHER:
//   (a) a patch repo in config.json has no key in patches.json yet
//       (a brand-new upstream repo was added), OR
//   (b) an app's patch repo changed in config.json relative to where it
//       currently sits in patches.json (an existing app relocated to a
//       different upstream repo).
//
// Case (b) matters: when a maintainer moves e.g. sofascore from
// `heval99/morphe-patches` to `hoo-dles/morphe-patches`, the destination
// repo *already* exists in patches.json (carrying other apps like mimo),
// so case (a) alone would short-circuit the gate and the user's toggles
// under the old repo would be silently dropped on the next manual sync.
//
// Outputs:
//   has_new_repos         "true" if either (a) or (b) is true, else "false"
//   has_relocated_apps    "true" if (b) is true (informational; log only)
//   relocated_apps_json   JSON array of {pkg,oldRepo,newRepo} for (b)
//                         (informational; log only)

'use strict';

const fs = require('node:fs');

/**
 * Compute the trigger flags from already-parsed config + patches.
 *
 * @param {object} config   parsed config.json
 * @param {object} patches  parsed patches.json
 * @returns {{
 *   hasNewRepos: boolean,
 *   hasRelocatedApps: boolean,
 *   newRepos: string[],
 *   relocatedApps: Array<{pkg: string, oldRepo: string, newRepo: string}>,
 * }}
 */
function detectChanges(config, patches) {
  const patchRepos = (config && config.patch_repos) || {};

  // Repos referenced by config (no path/branch split needed here — we only
  // care whether the repo key appears anywhere in patches.json).
  const configRepoSet = new Set();
  for (const entry of Object.values(patchRepos)) {
    if (entry && typeof entry.repo === 'string' && entry.repo.length > 0) {
      configRepoSet.add(entry.repo);
    }
  }

  // (a) Brand-new repo: in config, completely absent from patches.json.
  const newRepos = [];
  for (const repo of configRepoSet) {
    if (!Object.prototype.hasOwnProperty.call(patches || {}, repo)) {
      newRepos.push(repo);
    }
  }
  newRepos.sort();

  // (b) App relocated: app lives in patches.json under repo X, but config
  // now points the same app at repo Y where Y !== X. We only flag apps
  // that are still defined in config (apps fully removed from config are
  // cleaned up by sync-patches.sh's ACTIVE_REPOS drop, not by re-sync).
  const activePackages = new Set(Object.keys(patchRepos));
  const relocatedApps = [];
  const patchesObj = patches && typeof patches === 'object' ? patches : {};
  for (const [oldRepo, apps] of Object.entries(patchesObj)) {
    if (!apps || typeof apps !== 'object') continue;
    for (const pkg of Object.keys(apps)) {
      if (!activePackages.has(pkg)) continue;
      const entry = patchRepos[pkg];
      const newRepo = entry && entry.repo;
      if (typeof newRepo !== 'string' || newRepo.length === 0) continue;
      if (newRepo !== oldRepo) {
        relocatedApps.push({ pkg, oldRepo, newRepo });
      }
    }
  }
  // Deterministic order for stable logs/tests.
  relocatedApps.sort((a, b) => {
    if (a.pkg !== b.pkg) return a.pkg < b.pkg ? -1 : 1;
    if (a.oldRepo !== b.oldRepo) return a.oldRepo < b.oldRepo ? -1 : 1;
    return a.newRepo < b.newRepo ? -1 : 1;
  });

  return {
    hasNewRepos: newRepos.length > 0,
    hasRelocatedApps: relocatedApps.length > 0,
    newRepos,
    relocatedApps,
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.log(`${name}=${value}`);
    return;
  }
  const delimiter = `EOF_${Date.now()}_${process.pid}`;
  fs.appendFileSync(
    outputFile,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
    'utf8',
  );
}

function main() {
  const configPath = process.env.CONFIG_FILE || 'config.json';
  const patchesPath = process.env.PATCHES_FILE || 'patches.json';
  const config = readJson(configPath);
  const patches = readJson(patchesPath);

  const result = detectChanges(config, patches);

  // Open the gate on either condition. The downstream script
  // (sync-patches.sh) carries over the user's existing toggles when an
  // app is relocated, so re-syncing here is the right call.
  const hasNewRepos = result.hasNewRepos || result.hasRelocatedApps;
  writeOutput('has_new_repos', hasNewRepos ? 'true' : 'false');
  writeOutput('has_relocated_apps', result.hasRelocatedApps ? 'true' : 'false');
  writeOutput('relocated_apps_json', JSON.stringify(result.relocatedApps));

  if (!hasNewRepos) {
    console.log('::notice::No new patch repos or relocated apps; skipping sync.');
    return;
  }

  if (result.hasNewRepos) {
    console.log('New patch repos to seed:');
    for (const repo of result.newRepos) {
      console.log(`  - ${repo}`);
    }
  }
  if (result.hasRelocatedApps) {
    console.log('Apps relocated between patch repos:');
    for (const move of result.relocatedApps) {
      console.log(`  - ${move.pkg}: ${move.oldRepo} -> ${move.newRepo}`);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { detectChanges };
