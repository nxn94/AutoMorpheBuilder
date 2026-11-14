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

// Files that cannot change the bytes, signing or validation of a built APK:
// release/cache housekeeping, the patch-sync workflow, doc/README tooling,
// browser installation (downloads are still hash- and signer-checked) and
// download-source data. Everything else under the scanned directories is hashed,
// so a NEW file defaults to "affects output" (fail closed). Add a file here only
// after confirming no build, download, patch or sign step reads it.
const NON_OUTPUT_FILES = new Set([
  '.github/scripts/cleanup-caches.js',
  '.github/scripts/prune-old-releases.js',
  '.github/scripts/pipeline/prune_old_releases.sh',
  '.github/scripts/pipeline/delete_run_artifacts.sh',
  '.github/scripts/pipeline/push_with_rebase.sh',
  '.github/scripts/pipeline/install_playwright.sh',
  '.github/scripts/pipeline/sync-patches.sh',
  '.github/scripts/generate-readme-tables.js',
  '.github/scripts/goopdl-version-codes.json',
  'scripts/check-agents-doc.js',
  'scripts/generate-readme-tables.js',
  'scripts/detect-new-repos.js',
  'scripts/sync-patches.sh',
]);

// Dev-only packages (jest, eslint, ...) never run in a build. Only the root
// entry's devDependencies list and `dev: true` packages are dropped; anything
// unparsable or unexpected is hashed as-is.
function lockfileForDigest(text) {
  let lock;
  try { lock = JSON.parse(text); } catch { return text; }
  if (!lock || typeof lock !== 'object' || !lock.packages || typeof lock.packages !== 'object') return text;
  const packages = {};
  for (const [key, value] of Object.entries(lock.packages)) {
    if (value && value.dev === true) continue;
    if (key === '' && value && typeof value === 'object') {
      const { devDependencies: _devDependencies, ...rest } = value;
      packages[key] = rest;
    } else packages[key] = value;
  }
  return JSON.stringify(canonical({ ...lock, packages }));
}

function pipelineDigest(root = path.resolve(__dirname, '../..')) {
  const files = ['.github/workflows/morphe-build.yml'];
  function visit(dir) {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (['__tests__', 'fixtures'].includes(entry.name)) continue;
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(file);
      else if (/\.(js|sh|json)$/.test(entry.name) && !NON_OUTPUT_FILES.has(file)) files.push(file);
    }
  }
  for (const dir of ['src', '.github/scripts', 'scripts']) visit(dir);
  const hash = crypto.createHash('sha256').update(`epoch:${REBUILD_EPOCH}\0`)
    .update(outputToolPins(fs.readFileSync(path.join(root, 'checksums/tools.sha256'), 'utf8')));
  for (const file of files.sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  }
  hash.update('package-lock.json\0')
    .update(lockfileForDigest(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))).update('\0');
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

module.exports = { fingerprint, appFingerprint, releaseIsCurrent, pipelineDigest, NON_OUTPUT_FILES, lockfileForDigest };
