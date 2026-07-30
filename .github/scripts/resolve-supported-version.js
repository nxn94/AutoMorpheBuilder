#!/usr/bin/env node
'use strict';

/**
 * resolve-supported-version.js
 *
 * Determines the latest Morphe-supported APK version for a given app,
 * for use as the matrix entry's target version in the build job.
 * Extracted from the inline ~170-line bash block that previously lived
 * in the "Resolve supported version for ${{ matrix.appId }}" workflow
 * step.
 *
 * Inputs (env vars):
 *   APP_ID                required  package id (e.g. com.google.android.youtube)
 *   PATCH_REPO            required  patch repo (e.g. MorpheApp/morphe-patches)
 *   TOOLS_DIR             required  dir containing patches-list.json + .mpp + .jar
 *   DISABLED_PATCHES_JSON required  JSON array of patch names disabled in patches.json
 *   PINNED_VERSION        optional  if set, validate against patches-list.json first
 *
 * Outputs (written to $GITHUB_OUTPUT):
 *   version   the selected version (X.Y.Z)
 *   versions  comma-separated list of all compatible versions
 *
 * Exits non-zero (and prints ::error::) if no compatible version can
 * be resolved — matches the bash step's behavior exactly.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP_ID = process.env.APP_ID;
const PATCH_REPO = process.env.PATCH_REPO;
const TOOLS_DIR = process.env.TOOLS_DIR;
const DISABLED_PATCHES_JSON = process.env.DISABLED_PATCHES_JSON || '[]';
const PINNED_VERSION = process.env.PINNED_VERSION || '';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

if (!APP_ID || !PATCH_REPO || !TOOLS_DIR) {
  console.error('::error::APP_ID, PATCH_REPO, and TOOLS_DIR are required env vars.');
  process.exit(1);
}
if (!GITHUB_OUTPUT) {
  console.error('::error::GITHUB_OUTPUT not set; this script must run inside a workflow step.');
  process.exit(1);
}

function setOutput(key, value) {
  if (value === undefined || value === null) value = '';
  const line = `${key}=${value}`;
  console.log(line);
  fs.appendFileSync(GITHUB_OUTPUT, line + '\n');
}

/**
 * Cross-version of patches-list.json's compatPackages syntax:
 *   - old: key-indexed object  { "com.x": { "versions": [...] } }
 *   - old: key-indexed object  { "com.x": [...] }
 *   - new: array-of-objects    [ { packageName: "com.x", targets: [...] } ]
 * Returns the list of package names this patch declares itself compatible with.
 */
function compatPkgNames(patch) {
  const candidates = ['compatiblePackages', 'compatible_packages'];
  for (const key of candidates) {
    const v = patch[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v);
    }
    if (Array.isArray(v)) {
      return v.map(c => c && (c.name || c.packageName) || '').filter(Boolean);
    }
  }
  return [];
}

/**
 * Cross-version of patches-list.json's target list for a specific package:
 *   - old: package's value is an array of { version, isExperimental } target objects.
 *   - new: same shape, just nested under compatiblePackages[].
 * Returns the list of version strings (any case — caller filters isExperimental).
 */
function targetsForApp(patch, pkgName) {
  const candidates = ['compatiblePackages', 'compatible_packages'];
  for (const key of candidates) {
    const v = patch[key];
    if (Array.isArray(v)) {
      const entry = v.find(c => c && (c.packageName === pkgName || c.name === pkgName));
      if (entry && Array.isArray(entry.targets)) return entry.targets;
    } else if (v && typeof v === 'object') {
      const entry = v[pkgName];
      if (entry) {
        if (Array.isArray(entry)) return entry;
        if (Array.isArray(entry.targets)) return entry.targets;
        if (Array.isArray(entry.versions)) return entry.versions;
      }
    }
  }
  return [];
}

function loadPatchesList() {
  const p = path.join(TOOLS_DIR, 'patches-list.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`Could not parse ${p}: ${e.message}`);
    return null;
  }
}

function loadDisabledPatches() {
  try {
    const v = JSON.parse(DISABLED_PATCHES_JSON);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Pinned-version path: pin only sticks if every enabled (non-disabled,
 * use=true) patch that targets our package also lists the pinned version
 * as a compatible target. Returns true iff valid.
 */
function tryPinned(patchesList, pinned) {
  const disabled = loadDisabledPatches();
  const enabled = (patchesList.patches || patchesList || []).filter(
    p => (p.use !== false) && !disabled.includes(p.name),
  );
  const totalForApp = enabled.filter(p => compatPkgNames(p).includes(APP_ID)).length;
  const matchesForPinned = enabled.filter(p => {
    if (!compatPkgNames(p).includes(APP_ID)) return false;
    return targetsForApp(p, APP_ID).some(t => t && t.version === pinned);
  }).length;
  return totalForApp > 0 && totalForApp === matchesForPinned;
}

/**
 * morphe-desktop primary source. The CLI is the authoritative version list
 * (reads the .mpp artifact directly), so we prefer it over any
 * patches-list.json logic. Returns array of versions sorted as the CLI
 * returns them (most-preferred first).
 */
function tryMorpheCli(jarPath, mppFile) {
  if (!jarPath || !fs.existsSync(jarPath) || !fs.existsSync(mppFile)) return null;
  let out;
  try {
    out = execFileSync(
      'java',
      ['-jar', jarPath, 'list-versions', '-f', APP_ID, '--patches=' + mppFile],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch (e) {
    console.error(`morphe-desktop list-versions failed: ${e.message}`);
    return null;
  }
  const versions = out.match(/\d+\.\d+\.\d+/g) || [];
  return versions;
}

/**
 * Two-tier fallback when morphe-desktop can't be used (missing jar / mpp /
 * cli broken):
 *   1. strict intersection — versions supported by EVERY enabled patch.
 *   2. count-based — versions ranked by how many enabled patches support
 *      them, ties broken by semver-descending.
 * In both tiers, isExperimental targets are filtered out.
 */
function strictIntersection(patchesList) {
  const disabled = loadDisabledPatches();
  const enabled = (patchesList.patches || patchesList || []).filter(
    p =>
      (p.use !== false) &&
      !disabled.includes(p.name) &&
      compatPkgNames(p).includes(APP_ID),
  );
  if (enabled.length === 0) return [];
  const versionLists = enabled.map(p => {
    const targets = targetsForApp(p, APP_ID).filter(t => !(t && t.isExperimental));
    return [...new Set(targets.map(t => t.version).filter(Boolean))];
  });
  if (versionLists.length === 0) return [];
  return versionLists.reduce(
    (acc, cur) => acc.filter(v => cur.includes(v)),
    versionLists[0],
  );
}

function countBased(patchesList) {
  const disabled = loadDisabledPatches();
  const enabled = (patchesList.patches || patchesList || []).filter(
    p =>
      (p.use !== false) &&
      !disabled.includes(p.name) &&
      compatPkgNames(p).includes(APP_ID),
  );
  const counts = new Map();
  for (const p of enabled) {
    for (const t of targetsForApp(p, APP_ID)) {
      if (!t || t.isExperimental || !t.version) continue;
      counts.set(t.version, (counts.get(t.version) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0], undefined, { numeric: true }))
    .map(([v]) => v);
}

/**
 * Sort versions descending by semver (X.Y.Z compare).
 */
function sortVersionsDesc(versions) {
  return [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// === Main ===
const patchesList = loadPatchesList();
if (!patchesList) {
  setOutput('version', '');
  setOutput('versions', '');
  console.error('::error::Could not resolve a Morphe-supported version from patches list.');
  process.exit(1);
}

// 1. Pinned-version path
if (PINNED_VERSION && PINNED_VERSION !== 'null') {
  if (tryPinned(patchesList, PINNED_VERSION)) {
    setOutput('version', PINNED_VERSION);
    setOutput('versions', PINNED_VERSION);
    console.log(`Selected version for ${APP_ID}: ${PINNED_VERSION} (pinned, validated against patches-list.json)`);
    process.exit(0);
  }
  console.error(`::warning::Pinned version ${PINNED_VERSION} is not in the compatible list for ${APP_ID}; falling back to auto-resolution`);
}

// 2. morphe-desktop primary
const slug = PATCH_REPO.replace(/\//g, '-');
const mppFile = path.join(TOOLS_DIR, `${slug}.mpp`);
let jarPath = '';
try {
  const jars = fs.readdirSync(TOOLS_DIR).filter(f => f.startsWith('morphe-desktop-') && f.endsWith('-all.jar'));
  if (jars.length > 0) jarPath = path.join(TOOLS_DIR, jars[0]);
} catch { /* TOOLS_DIR may not exist yet */ }

const versions = tryMorpheCli(jarPath, mppFile);
if (versions && versions.length > 0) {
  setOutput('version', versions[0]);
  setOutput('versions', versions.join(','));
  console.log(`Selected version for ${APP_ID}: ${versions[0]} (morphe-desktop list-versions; experimental targets filtered)`);
  process.exit(0);
}

if (versions === null && jarPath && fs.existsSync(mppFile)) {
  console.log('morphe-desktop did not return a usable version; falling back to patches-list.json logic...');
}

// 3. Patches-list.json fallback
let finalVersions = strictIntersection(patchesList);
if (finalVersions.length > 0) {
  finalVersions = sortVersionsDesc(finalVersions);
} else {
  finalVersions = countBased(patchesList); // already sorted
}

if (finalVersions.length > 0) {
  setOutput('version', finalVersions[0]);
  setOutput('versions', finalVersions.join(','));
  console.log(`Selected version for ${APP_ID}: ${finalVersions[0]} (URL resolved in check-versions)`);
} else {
  setOutput('version', '');
  setOutput('versions', '');
  console.error('::error::Could not resolve a Morphe-supported version from patches list.');
  process.exit(1);
}