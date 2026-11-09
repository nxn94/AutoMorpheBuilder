'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function fingerprint(inputs) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(inputs))).digest('hex');
}

// The epoch remains an explicit escape hatch for inputs outside this digest.
const REBUILD_EPOCH = 1;

// Browser and inspection-tool refreshes do not by themselves alter APK output.
function outputToolPins(text) {
  return [...text.matchAll(/^([0-9a-f]{64})\s+(morphe-desktop\.jar|APKEditor\.jar)(?=\s|$)/gm)]
    .map((m) => `${m[1]}  ${m[2]}\n`).join('');
}

function pipelineDigest(root = path.resolve(__dirname, '../..')) {
  const files = ['package-lock.json', '.github/workflows/morphe-build.yml'];
  function visit(dir) {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (['__tests__', 'fixtures'].includes(entry.name)) continue;
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/\.(js|sh|json)$/.test(entry.name)
        && !['check-agents-doc.js', 'generate-readme-tables.js'].includes(entry.name)) files.push(file);
    }
  }
  for (const dir of ['src', '.github/scripts', 'scripts']) visit(dir);
  const hash = crypto.createHash('sha256').update(`epoch:${REBUILD_EPOCH}\0`)
    .update(outputToolPins(fs.readFileSync(path.join(root, 'checksums/tools.sha256'), 'utf8')));
  for (const file of files.sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  }
  return hash.digest('hex');
}

function appFingerprint(config, patches, appId, cliVersion, pipeline) {
  const entry = config.patch_repos[appId];
  return fingerprint({ appId, app: entry, patches: patches[entry.repo]?.[appId] || {},
    architecture: config.preferred_arch || '', cli: config.cli, cliVersion, pipeline,
    ...(config.honor_patch_opt_ins === true ? { honorPatchOptIns: true } : {}) });
}

function releaseIsCurrent(release, name, digest) {
  const names = new Set((release.assets || []).map((asset) => asset.name));
  return release.body?.includes(`<!-- build-input:${digest} -->`)
    && [`${name}.apk`, 'SHA256SUMS', 'build-inputs.json'].every((asset) => names.has(asset));
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE || 'config.json', 'utf8'));
  const patches = JSON.parse(fs.readFileSync(process.env.PATCHES_FILE || 'patches.json', 'utf8'));
  const pipeline = pipelineDigest();
  console.log(JSON.stringify(Object.fromEntries(Object.keys(config.patch_repos).map((appId) =>
    [config.patch_repos[appId].name, appFingerprint(config, patches, appId, process.env.CLI_VERSION || '', pipeline)]))));
}

module.exports = { fingerprint, appFingerprint, releaseIsCurrent, pipelineDigest };
