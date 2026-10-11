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

function pipelineDigest(root = path.resolve(__dirname, '../..')) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'fixtures') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (/\.(js|sh|yml)$/.test(file)) files.push(file);
    }
  }
  for (const dir of ['.github/scripts', '.github/workflows', 'src', 'scripts']) visit(path.join(root, dir));
  files.push(path.join(root, 'package-lock.json'), path.join(root, 'checksums/tools.sha256'));
  const hash = crypto.createHash('sha256');
  for (const file of files.sort()) hash.update(path.relative(root, file)).update('\0').update(fs.readFileSync(file)).update('\0');
  return hash.digest('hex');
}

function appFingerprint(config, patches, appId, cliVersion, pipeline) {
  const entry = config.patch_repos[appId];
  return fingerprint({ appId, app: entry, patches: patches[entry.repo]?.[appId] || {},
    architecture: config.preferred_arch || '', cli: config.cli, cliVersion, pipeline });
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
