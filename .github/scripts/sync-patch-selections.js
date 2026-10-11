'use strict';

const { patchTag } = require('./build-plan');
const { mergeRepoEntries } = require('../../scripts/merge-patches');

function compatiblePackages(patch) {
  const packages = patch.compatiblePackages || patch.compatible_packages || {};
  return Array.isArray(packages)
    ? packages.flatMap((entry) => [entry.packageName, entry.name].filter(Boolean))
    : Object.keys(packages);
}

// Always read choices from the original snapshot, including on repo moves.
// An unavailable upstream preserves that app's complete previous selection.
function syncSelections(config, original, versions, lists) {
  const result = {};
  for (const [appId, entry] of Object.entries(config.patch_repos)) {
    const key = `${entry.repo}|${patchTag(appId, entry, versions)}`;
    const list = lists[key];
    let selection;
    if (!list) {
      selection = original[entry.repo]?.[appId]
        || Object.values(original).find((apps) => apps?.[appId])?.[appId] || {};
    } else {
      const defaults = Object.fromEntries((list.patches || list)
        .filter((patch) => compatiblePackages(patch).includes(appId))
        .map((patch) => [patch.name, true]));
      selection = mergeRepoEntries({
        defaultsForTargetRepo: { [appId]: defaults },
        baseAllRepos: original,
        targetRepo: entry.repo,
      })[appId];
    }
    (result[entry.repo] ||= {})[appId] = selection;
  }
  return result;
}

async function main() {
  const fs = require('node:fs');
  const { execFileSync } = require('node:child_process');
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE || 'config.json', 'utf8'));
  const patchesFile = process.env.PATCHES_FILE || 'patches.json';
  const original = fs.existsSync(patchesFile) ? JSON.parse(fs.readFileSync(patchesFile, 'utf8')) : {};
  const versions = JSON.parse(process.env.REPO_VERSIONS);
  const lists = {};
  for (const [appId, entry] of Object.entries(config.patch_repos)) {
    const tag = patchTag(appId, entry, versions);
    const key = `${entry.repo}|${tag}`;
    if (Object.hasOwn(lists, key)) continue;
    try {
      const body = execFileSync('curl', ['--fail', '--location', '--silent', '--show-error',
        '--connect-timeout', '15', '--max-time', '120', '--retry', '2',
        `https://raw.githubusercontent.com/${entry.repo}/${encodeURIComponent(tag)}/patches-list.json`],
      { encoding: 'utf8', timeout: 390000, maxBuffer: 16 * 1024 * 1024 });
      const list = JSON.parse(body);
      if (!Array.isArray(list.patches || list)) throw new Error('Invalid patches-list format');
      lists[key] = list;
    } catch (error) {
      console.error(`::warning::Could not sync ${key}; preserving choices: ${error.message}`);
      lists[key] = null;
    }
  }
  fs.writeFileSync(`${patchesFile}.tmp`, JSON.stringify(syncSelections(config, original, versions, lists), null, 2) + '\n');
  fs.renameSync(`${patchesFile}.tmp`, patchesFile);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { syncSelections, compatiblePackages };
