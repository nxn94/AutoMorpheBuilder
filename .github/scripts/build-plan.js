'use strict';

const crypto = require('node:crypto');

// App-keyed maps preserve independent selectors. Repo-keyed maps remain
// accepted for local callers using the older interface.
function patchTag(appId, entry, versions) {
  return entry.pin_patch_tag || versions[appId] || versions[entry.repo] || '';
}

function patchSlug(appId, entry, versions) {
  const repoSlug = entry.repo.replace(/\//g, '-');
  if (!Object.hasOwn(versions, appId)) return repoSlug;
  const digest = crypto.createHash('sha256').update(`${entry.repo}\n${patchTag(appId, entry, versions)}`).digest('hex').slice(0, 16);
  return `${repoSlug}-${digest}`;
}

function buildMatrix(config, versions) {
  return Object.entries(config.patch_repos).map(([appId, entry]) => ({
    name: entry.name,
    appId,
    patchRepo: entry.repo,
    patchBranch: (entry.branch || 'main').toLowerCase(),
    patchTag: patchTag(appId, entry, versions),
    patchSlug: patchSlug(appId, entry, versions),
  }));
}

// Descending version order: the dotted numeric core decides first (a longer core
// beats its own prefix, as 24.3.1 > 24.3), then a plain version (or "+build")
// outranks a "-label" version of the same core, so 1.2.3 > 1.2.3-beta. Between
// two labelled versions of one core the label is compared numerically. Labels
// such as 12.39.0-prod.01 are ordinary versions; they only rank below the same
// core without a label.
function compareVersionsDesc(a, b) {
  const split = (v) => {
    const m = /^(\d+(?:\.\d+)*)(.*)$/s.exec(v);
    return m ? { core: m[1].split('.').map(Number), rest: m[2] } : { core: [], rest: v };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i += 1) {
    const xi = x.core[i] ?? -1;
    const yi = y.core[i] ?? -1;
    if (xi !== yi) return yi - xi;
  }
  const labelled = (r) => r.startsWith('-');
  if (labelled(x.rest) !== labelled(y.rest)) return labelled(x.rest) ? 1 : -1;
  return y.rest.localeCompare(x.rest, undefined, { numeric: true });
}

function supportedVersions(stdout) {
  return [...new Set(stdout.match(/(?<![\w./-])\d+(?:\.\d+)+(?:[-+][A-Za-z0-9][A-Za-z0-9._+-]*)?(?![\w./-])/g) || [])]
    .sort(compareVersionsDesc);
}

if (require.main === module) {
  const fs = require('node:fs');
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE || 'config.json', 'utf8'));
  console.log(JSON.stringify(buildMatrix(config, JSON.parse(process.env.REPO_VERSIONS || '{}'))));
}

module.exports = { patchTag, patchSlug, buildMatrix, supportedVersions, compareVersionsDesc };
