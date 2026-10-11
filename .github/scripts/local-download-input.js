'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findCachedApk } = require('./apk-selection');
const { validateDownloadedApkAbi } = require('./apk-abi-validator');

function hasLocalInput(directories, version, architecture, find = findCachedApk, validate = validateDownloadedApkAbi) {
  return directories.some((dir) => {
    const file = find(dir, version);
    if (!file) return false;
    try { validate(file, architecture); return true; } catch { return false; }
  });
}

if (require.main === module) {
  const config = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE || 'config.json', 'utf8'));
  const present = hasLocalInput([process.env.APKS_DIR || 'apps',
    path.join(process.env.TOOLS_DIR || 'tools', 'apks', process.env.APP_ID)],
  process.env.TARGET_VERSION, config.preferred_arch);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `present=${present}\n`);
}

module.exports = { hasLocalInput };
