'use strict';

/**
 * APKPure's address for one exact build number. A patch list can publish build
 * numbers per CPU type; APKPure's version listing doesn't always show them.
 *
 * This only finds URLs. The caller hands them to downloadWithUrl, so each file
 * gets the usual package/version, ABI and developer-signature checks.
 */

const fs = require('node:fs');
const path = require('node:path');
const { versionMatches } = require('./version-match');

// APKPure answers curl's default User-Agent with 403.
const USER_AGENT = 'AutoMorpheBuilder/1.0';
const ARCH_KEYS = { 'arm64-v8a': 'ARM64_V8A', 'armeabi-v7a': 'ARMEABI_V7A', x86_64: 'X86_64', x86: 'X86' };

/** Pure. Build numbers for appId@version, the preferred CPU's first. */
function codesFromPatchList(list, appId, version, arch) {
  const patches = Array.isArray(list) ? list : (list && Array.isArray(list.patches) ? list.patches : []);
  const preferred = [];
  const others = [];
  for (const patch of patches) {
    for (const pkg of Array.isArray(patch && patch.compatiblePackages) ? patch.compatiblePackages : []) {
      if (!pkg || pkg.packageName !== appId) continue;
      for (const target of pkg.targets || []) {
        if (!target || !target.versionCodes || !versionMatches(String(target.version || ''), version)) continue;
        for (const [cpu, value] of Object.entries(target.versionCodes)) {
          const code = Number(value);
          if (Number.isSafeInteger(code) && code > 0) (cpu === ARCH_KEYS[arch] ? preferred : others).push(code);
        }
      }
    }
  }
  return [...new Set([...preferred, ...others])];
}

/** Build numbers from the downloaded patch list; none if it is missing or unreadable. */
function patchListCodes(appId, version, arch, toolsDir = process.env.TOOLS_DIR || 'tools') {
  try {
    return codesFromPatchList(JSON.parse(fs.readFileSync(path.join(toolsDir, 'patches-list.json'), 'utf8')), appId, version, arch);
  } catch {
    return [];
  }
}

/** Pure. The split bundle first, then the single APK, for each build number. */
function exactBuildUrls(appId, codes) {
  return codes.flatMap((code) => ['XAPK', 'APK'].map((kind) => `https://d.apkpure.com/b/${kind}/${encodeURIComponent(appId)}?versionCode=${code}`));
}

module.exports = { USER_AGENT, codesFromPatchList, patchListCodes, exactBuildUrls };
