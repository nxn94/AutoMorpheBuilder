#!/usr/bin/env node
'use strict';

/**
 * check-existing-releases.js
 *
 * For every app in patch_repos, decide whether a release for the
 * currently-resolved APK version + patches tag already exists. Emit a
 * filtered matrix and a skip-list.
 *
 * Replaces the previous "always build" contract. The daily cron was
 * rebuilding every 24h even when no upstream APK / patches version had
 * moved, producing no-op releases. This script makes the build
 * conditional on actual upstream change.
 *
 * Behaviour:
 *   1. For each matrix entry, resolve the APK version:
 *        - pinned version (config.json patch_repos[name].pin_version), or
 *        - `morphe-desktop list-versions -f <pkg> --patches=<mpp>` head
 *   2. Compute the expected release tag (matches create_release.sh):
 *        <name>-v<apk-version>-<patch-tag>
 *   3. `gh release view <tag>` — present ⇒ already built ⇒ skip.
 *   4. Emit:
 *        matrix-include   filtered matrix (already-built apps removed)
 *        skip-list        JSON array of appIds skipped
 *        should-build     true if any app remains; false if all skipped
 *
 * Failure policy is "fail open": any per-app resolution / network /
 * release-view failure defaults to "needs build" and logs ::warning::
 * so the build still runs. We never block a build just because the
 * comparison couldn't be made.
 *
 * Environment:
 *   REPO_VERSIONS  required  JSON object {repo:tag} from check-versions
 *   TOOLS_DIR      required  where morphe-desktop.jar + *.mpp live
 *   GITHUB_OUTPUT  required  workflow output file
 *   CONFIG_FILE    optional  default ./config.json
 *   FORCE_BUILD    optional  truthy bypasses the release-existence
 *                            comparison. The workflow sets this when
 *                            triggered via workflow_dispatch so a
 *                            manual run always patches + releases,
 *                            regardless of whether a release for the
 *                            current APK version + patches tag already
 *                            exists. Default behaviour (cron / push)
 *                            stays as the smart skip-when-current.
 *
 * Outputs (written to $GITHUB_OUTPUT):
 *   matrix-include   JSON array of {name,appId,patchRepo,patchBranch,patchSlug,patchTag}
 *   skip-list        JSON array of appIds skipped
 *   should-build     "true" | "false"  (overrides the value set by check-versions)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOOLS_DIR = process.env.TOOLS_DIR || './tools';
const REPO_VERSIONS = process.env.REPO_VERSIONS || '';
const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;
const CONFIG_FILE = process.env.CONFIG_FILE || './config.json';

/**
 * Pure: decide which apps to keep vs skip, given the matrix, the
 * already-resolved APK versions, and a release-existence predicate.
 *
 * matrix        array of { name, appId, patchRepo, patchBranch, patchSlug, patchTag }
 * apkVersions   map of appId -> version string ('' when unresolved)
 * releaseExists function(tag) -> boolean
 *
 * Returns { matrix, skipList, shouldBuild }. Fail-open: any entry with
 * an unresolved APK version is kept in the matrix so the build still
 * runs.
 */
function decide(matrix, apkVersions, releaseExists) {
  const filtered = [];
  const skipList = [];
  for (const entry of matrix) {
    const version = apkVersions[entry.appId];
    if (!version) {
      filtered.push(entry);
      continue;
    }
    const tag = `${entry.name}-v${version}-${entry.patchTag}`;
    if (releaseExists(tag)) {
      skipList.push(entry.appId);
    } else {
      filtered.push(entry);
    }
  }
  return { matrix: filtered, skipList, shouldBuild: filtered.length > 0 };
}

function setOutput(key, value) {
  const v = value === undefined || value === null ? '' : value;
  const line = `${key}=${v}`;
  console.log(line);
  fs.appendFileSync(GITHUB_OUTPUT, line + '\n');
}

function resolveApkVersion(appId, jarPath, mppPath, config) {
  const pin = config.patch_repos?.[appId]?.pin_version;
  if (pin) {
    console.log(`  [${appId}] using pinned version ${pin}`);
    return pin;
  }
  if (!fs.existsSync(jarPath)) {
    console.log(`  ::warning::[${appId}] ${jarPath} missing; cannot auto-resolve version`);
    return '';
  }
  if (!fs.existsSync(mppPath)) {
    console.log(`  ::warning::[${appId}] ${mppPath} missing; cannot auto-resolve version`);
    return '';
  }
  try {
    const out = execFileSync(
      'java',
      ['-jar', jarPath, 'list-versions', '-f', appId, `--patches=${mppPath}`],
      { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/\d+\.\d+\.\d+/g);
    if (!m) return '';
    // Sort descending (numeric-aware) so the head picks the recommended
    // version, not whatever order the CLI happens to print — e.g. Twitch's
    // RookieEnough/De-Vanced mpp prints 16.9.1 before 25.3.0.
    return m.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  } catch (e) {
    console.log(`  ::warning::[${appId}] morphe-desktop list-versions failed: ${e.message}`);
    return '';
  }
}

function checkReleaseExists(tag) {
  try {
    execFileSync('gh', ['release', 'view', tag], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

function buildMatrix(config, repoVersions) {
  return Object.entries(config.patch_repos).map(([appId, cfg]) => ({
    name: cfg.name,
    appId,
    patchRepo: cfg.repo,
    patchBranch: (cfg.branch || 'main').toLowerCase(),
    patchSlug: cfg.repo.replace(/\//g, '-'),
    patchTag: repoVersions[cfg.repo] || '',
  }));
}

function isTruthyEnv(name) {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'TRUE' || v === 'yes' || v === 'YES';
}

function main() {
  if (!REPO_VERSIONS) {
    console.error('::error::REPO_VERSIONS is empty; check-versions must run first.');
    process.exit(1);
  }
  if (!GITHUB_OUTPUT) {
    console.error('::error::GITHUB_OUTPUT not set; this script must run inside a workflow step.');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const repoVersions = JSON.parse(REPO_VERSIONS);
  const jarPath = path.join(TOOLS_DIR, 'morphe-desktop.jar');
  const matrix = buildMatrix(config, repoVersions);

  // Manual trigger (workflow_dispatch): the workflow sets FORCE_BUILD so
  // a manual run always patches + releases, regardless of whether the
  // current APK version + patches tag already has a release. The
  // existing release-tag is overwritten on publish. This restores the
  // pre-check-existing-releases behaviour for `Run workflow`.
  if (isTruthyEnv('FORCE_BUILD')) {
    console.log('::notice::FORCE_BUILD is set; building all apps without release-existence check.');
    for (const entry of matrix) {
      const tag = `${entry.name}-v<apk>-${entry.patchTag}`;
      console.log(`  [${entry.name}] force-build; release ${tag} will be overwritten if it exists.`);
    }
    setOutput('matrix-include', JSON.stringify(matrix));
    setOutput('skip-list', '[]');
    setOutput('should-build', String(matrix.length > 0));
    return;
  }

  // Fail-open: if any entry has no patchTag, we can't compute a
  // deterministic release tag, so we build everything rather than
  // building nothing. (Shouldn't happen given check-versions validates
  // non-empty REPO_PAIRS upstream, but be defensive.)
  const missingTag = matrix.find((e) => !e.patchTag);
  if (missingTag) {
    console.log(`::warning::Matrix entry ${missingTag.appId} has no patchTag; failing open (build all).`);
    setOutput('matrix-include', JSON.stringify(matrix));
    setOutput('skip-list', '[]');
    setOutput('should-build', 'true');
    return;
  }

  // Resolve APK version per app.
  const apkVersions = {};
  for (const entry of matrix) {
    const mppPath = path.join(TOOLS_DIR, `${entry.patchSlug}.mpp`);
    apkVersions[entry.appId] = resolveApkVersion(entry.appId, jarPath, mppPath, config);
  }

  // Decide.
  const result = decide(matrix, apkVersions, checkReleaseExists);

  // Per-entry log (one line per app, skip or keep).
  for (const entry of matrix) {
    const version = apkVersions[entry.appId];
    if (!version) continue;
    const tag = `${entry.name}-v${version}-${entry.patchTag}`;
    if (result.skipList.includes(entry.appId)) {
      console.log(`  [${entry.name}] release ${tag} already exists; skipping.`);
    } else {
      console.log(`  [${entry.name}] no release at ${tag}; keeping in matrix.`);
    }
  }

  if (result.shouldBuild) {
    console.log(`::notice::Building ${result.matrix.length} of ${matrix.length} app(s); skipped ${result.skipList.length}.`);
  } else {
    console.log('::notice::All apps already have a current release; nothing to build.');
  }

  setOutput('matrix-include', JSON.stringify(result.matrix));
  setOutput('skip-list', JSON.stringify(result.skipList));
  setOutput('should-build', String(result.shouldBuild));
}

if (require.main === module) {
  main();
}

module.exports = { decide, buildMatrix, main, isTruthyEnv };

