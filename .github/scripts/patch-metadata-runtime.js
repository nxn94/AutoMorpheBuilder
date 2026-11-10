#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createMetadataResolver, atomicWrite, generatedVersions, enableArgs } = require('./patch-metadata');
const { supportedVersions } = require('./build-plan');

function readGenerated(toolsDir, slug) {
  const file = path.join(toolsDir, `${slug}.metadata.json`);
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return list.generated ? list : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function readSelections(file = process.env.PATCHES_FILE || 'patches.json') {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}
async function resolveToFiles(options, resolveMetadata = createMetadataResolver()) {
  const { toolsDir, slug } = options;
  const files = [path.join(toolsDir, 'patches-list.json'), path.join(toolsDir, `${slug}.metadata.json`)];
  for (const file of files) fs.rmSync(file, { force: true });
  try {
    const { list, status } = await resolveMetadata(options);
    if (status !== 'ready') throw new Error('Patch metadata still deferred after tool setup');
    for (const file of files) atomicWrite(file, JSON.stringify(list));
  } catch (error) {
    for (const file of files) fs.rmSync(file, { force: true });
    throw error;
  }
}
async function main() {
  const mode = process.argv[2];
  const toolsDir = process.env.TOOLS_DIR || './tools';
  const repo = process.env.PATCH_REPO;
  const slug = process.env.PATCH_SLUG || repo?.replaceAll('/', '-');
  const appId = process.env.APP_ID;
  if (mode === 'tokens') {
    console.log(supportedVersions(fs.readFileSync(0, 'utf8')).join('\n'));
    return;
  }
  if (mode === 'resolve') {
    await resolveToFiles({ repo, tag: process.env.PATCH_TAG, slug,
      cli: { repo: process.env.CLI_REPO, tag: process.env.CLI_VERSION }, toolsDir,
      mppPath: path.join(toolsDir, `${slug}.mpp`), jarPath: path.join(toolsDir, 'morphe-desktop.jar') });
    return;
  }
  const list = readGenerated(toolsDir, slug)
    || (fs.existsSync(path.join(toolsDir, 'patches-list.json'))
      ? JSON.parse(fs.readFileSync(path.join(toolsDir, 'patches-list.json'), 'utf8')) : null);
  const choices = readSelections()[repo]?.[appId] || {};
  if (mode === 'enables') {
    const configFile = process.env.CONFIG_FILE || 'config.json';
    const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
    console.log(JSON.stringify(enableArgs(list || {}, appId, choices, {
      honorOptIns: config.honor_patch_opt_ins === true,
      options: config.patch_repos?.[appId]?.patch_options || {},
      warn: (message) => console.error(`::warning::${message}`),
    })));
    return;
  }
  if (mode !== 'versions') throw new Error('Unknown metadata runtime command');
  let versions;
  if (list?.generated) {
    const pin = process.env.PINNED_VERSION;
    versions = generatedVersions(list, appId, choices, pin && pin !== 'null' ? pin : '');
  } else {
    const out = execFileSync('java', ['-jar', path.join(toolsDir, 'morphe-desktop.jar'), 'list-versions', '-f', appId,
      `--patches=${path.join(toolsDir, `${slug}.mpp`)}`], { encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    versions = supportedVersions(out);
  }
  if (!versions.length) throw new Error(`No compatible version for enabled patches of ${appId}; unrestricted patches require pin_version`);
  console.log(versions.join('\n'));
}
if (require.main === module) main().catch((error) => { console.error(`::error::${error.message}`); process.exitCode = 1; });
module.exports = { resolveToFiles, readGenerated, readSelections, main };
