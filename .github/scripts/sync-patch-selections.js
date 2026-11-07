'use strict';

const { matchesPackage } = require('./patch-metadata');
const { patchTag } = require('./build-plan');
const { mergeRepoEntries } = require('../../scripts/merge-patches');

function compatiblePackages(patch) {
  const packages = Object.hasOwn(patch, 'compatiblePackages') ? patch.compatiblePackages : patch.compatible_packages;
  if (packages === null) return ['(universal)'];
  if (packages === undefined) return [];
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
        .filter((patch) => compatiblePackages(patch).some((name) => matchesPackage(name, appId)))
        .map((patch) => [patch.name, list.generated ? patch.use === true : patch.default ?? true]));
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
  const { createMetadataResolver, atomicWrite } = require('./patch-metadata');
  const resolveMetadata = createMetadataResolver();
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
      const { list, status } = await resolveMetadata({ repo: entry.repo, tag,
        cli: { repo: config.cli.repo, tag: process.env.CLI_TAG }, toolsDir: process.env.TOOLS_DIR || './tools' });
      if (status !== 'ready') throw new Error('Metadata deferred; Java and resolved CLI_TAG required');
      lists[key] = list;
    } catch (error) {
      console.error(`::warning::Could not sync ${key}; preserving choices: ${error.message}`);
      lists[key] = null;
    }
  }
  atomicWrite(patchesFile, JSON.stringify(syncSelections(config, original, versions, lists), null, 2) + '\n');
}

if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { syncSelections, compatiblePackages };
