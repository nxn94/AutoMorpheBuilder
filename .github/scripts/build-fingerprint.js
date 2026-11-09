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

// Raise this when a builder change really should rebuild every app.
const REBUILD_EPOCH = 1;

// Only the tools that shape the APK count, so a builder change, a Chromium or
// aapt refresh or a comment doesn't rebuild every app.
function outputToolPins(text) {
  return [...text.matchAll(/^([0-9a-f]{64})\s+(morphe-desktop\.jar|APKEditor\.jar)(?=\s|$)/gm)]
    .map((m) => `${m[1]}  ${m[2]}\n`).join('');
}

function pipelineDigest(root = path.resolve(__dirname, '../..')) {
  return crypto.createHash('sha256').update(`epoch:${REBUILD_EPOCH}\0`)
    .update(outputToolPins(fs.readFileSync(path.join(root, 'checksums/tools.sha256'), 'utf8')))
    .digest('hex');
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
