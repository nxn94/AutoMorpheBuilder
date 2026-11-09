'use strict';

/**
 * APKPure's address for one exact build number. A patch list can publish build
 * numbers per CPU type; APKPure's version listing doesn't always show them.
 *
 * Each file gets the usual downloadWithUrl and developer-signature checks, plus
 * a check here that it really is the build that was asked for. The whole step
 * shares one time limit, so a stalled APKPure can't use up the downloader's
 * 600 seconds before the other sources get a turn.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { versionMatches } = require('./version-match');

// APKPure answers curl's default User-Agent with 403.
const USER_AGENT = 'AutoMorpheBuilder/1.0';
const BUDGET_MS = 150000;
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
  return codes.flatMap((code) => ['XAPK', 'APK'].map((kind) => ({ code, url: `https://d.apkpure.com/b/${kind}/${encodeURIComponent(appId)}?versionCode=${code}` })));
}

function readPackage(apk, exec) {
  let output;
  try {
    output = exec('aapt', ['dump', 'badging', apk], { encoding: 'utf8', timeout: 60000 });
  } catch {
    output = exec('aapt2', ['dump', 'badging', apk], { encoding: 'utf8', timeout: 60000 });
  }
  const line = String(output).split('\n').find((l) => l.startsWith('package:')) || '';
  return Object.fromEntries([...line.matchAll(/(\w+)='([^']*)'/g)].map((m) => [m[1], m[2]]));
}

/** The base APK's package details; a bundle's base is the APK that isn't a split. */
function readBase(file, isBundle, exec) {
  if (!isBundle) return readPackage(file, exec);
  const entries = String(exec('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
    .split('\n').map((e) => e.trim()).filter((e) => /^[^/]+\.apk$/i.test(e));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'apkpure-exact-'));
  try {
    for (const entry of entries) {
      try {
        exec('unzip', ['-o', '-j', '-q', file, entry, '-d', temp], { timeout: 60000 });
        const attrs = readPackage(path.join(temp, entry), exec);
        if (attrs.name && !attrs.split) return attrs;
      } catch { /* not readable; no base found from this entry */ }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  throw new Error('bundle has no readable base APK');
}

/** Throws unless the file (or a bundle's base APK) is appId at exactly this build number. */
function assertExactBuild(file, appId, code, { isBundle = false, execFileSyncImpl = execFileSync } = {}) {
  const attrs = readBase(file, isBundle, execFileSyncImpl);
  if (attrs.name !== appId || attrs.versionCode !== String(code)) {
    throw new Error(`expected ${appId} build ${code}, got ${attrs.name} build ${attrs.versionCode}`);
  }
}

/** The first candidate that passes every check as { result, url }, or null to move on. */
async function downloadExactBuild({ appId, version, codes, partialPath, download, isBundle, execFileSyncImpl, budgetMs = BUDGET_MS }) {
  console.error(`[apkpure-exact] Build numbers for ${appId} v${version}: ${codes.join(', ')}`);
  const signal = AbortSignal.timeout(budgetMs);
  let lastError = null;
  for (const { url, code } of exactBuildUrls(appId, codes)) {
    if (signal.aborted) break;
    try {
      const result = await download(url, { signal, userAgent: USER_AGENT });
      assertExactBuild(result.path, appId, code, { isBundle: isBundle(result.path), execFileSyncImpl });
      return { result, url };
    } catch (e) {
      lastError = e;
      console.error(`[apkpure-exact] ${url}: ${e.message}`);
      try { fs.rmSync(partialPath, { force: true }); } catch { /* best-effort: the next source overwrites it */ }
    }
  }
  console.error(`[apkpure-exact] Failed: ${signal.aborted ? `timed out after ${budgetMs / 1000}s` : lastError.message}`);
  return null;
}

module.exports = { USER_AGENT, codesFromPatchList, patchListCodes, exactBuildUrls, assertExactBuild, downloadExactBuild };
