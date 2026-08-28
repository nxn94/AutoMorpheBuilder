#!/usr/bin/env node
'use strict';

/**
 * Install aapt + aapt2 for APK version validation.
 *
 * Why this exists:
 *   The workflow's previous "install aapt" block only fetched the Android
 *   cmdline-tools manager; it never actually ran `sdkmanager` to install
 *   the build-tools package, which is where the `aapt` and `aapt2` binaries
 *   live. As a result `command -v aapt` always returned non-zero and the
 *   unified-downloader's apkeep path would discard every download with
 *   "aapt not available - cannot validate version", causing builds to fail
 *   on transient sources like APKMirror rate limits.
 *
 *   This installer does the right thing: cmdline-tools → accept licenses
 *   → sdkmanager install build-tools. Idempotent (skips if aapt is
 *   already on PATH). Exits non-zero on failure so callers can `|| true`
 *   to make it best-effort.
 *
 * Usage:
 *   node .github/scripts/install-aapt.js
 *
 * After this script, `aapt` and `aapt2` are on PATH.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SDK_ROOT = process.env.ANDROID_HOME || path.join(os.tmpdir(), 'android-sdk');
const CMDLINE_TOOLS_URL = 'https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip';
const BUILD_TOOLS_VERSION = '35.0.0';

function log(msg) {
  console.error(`[aapt-install] ${msg}`);
}

function alreadyInstalled() {
  // If `aapt` is already on PATH (e.g. apt-installed, or a previous
  // run cached the SDK), don't redo the work.
  const r = spawnSync('aapt', ['version'], { stdio: 'ignore' });
  return r.status === 0;
}

function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Retry transient network/protocol errors (HTTP/2 stream errors in
  // particular — curl 92 — are surfaced as non-zero by libcurl even
  // though the upstream server is fine on the next attempt). The shell
  // pipeline uses a `with_retry` helper for the same purpose; mirror
  // that here so the JS installer is equally resilient. `--retry-all-errors`
  // is required because HTTP/2 stream errors are not in curl's default
  // transient-error set. Mirrors the flags used by
  // install-playwright-browsers.js.
  execFileSync('curl', [
    '-fSL',
    '--retry', '3',
    '--retry-delay', '2',
    '--retry-all-errors',
    '--connect-timeout', '30',
    '--max-time', '300',
    '-o', dest,
    url,
  ], { stdio: 'inherit' });
  const size = fs.statSync(dest).size;
  if (size < 1_000_000) throw new Error(`Downloaded ${url} is suspiciously small (${size} bytes)`);
  return dest;
}

function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: 'inherit' });
}

function ensureCmdlineTools() {
  const sdkMgr = path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
  if (fs.existsSync(sdkMgr)) {
    log(`cmdline-tools already present at ${sdkMgr}`);
    return;
  }

  log(`Installing Android cmdline-tools to ${SDK_ROOT}...`);
  const zip = path.join(os.tmpdir(), 'cmdline-tools.zip');
  download(CMDLINE_TOOLS_URL, zip);

  // The zip extracts to a top-level "cmdline-tools/" directory; we need it
  // at $SDK_ROOT/cmdline-tools/latest/ (the layout sdkmanager expects).
  const staging = path.join(os.tmpdir(), `cmdline-tools-staging-${Date.now()}`);
  unzip(zip, staging);
  const src = path.join(staging, 'cmdline-tools');
  const dest = path.join(SDK_ROOT, 'cmdline-tools', 'latest');
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    fs.renameSync(path.join(src, entry), path.join(dest, entry));
  }
  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
}

function acceptLicenses() {
  // Pipe `yes` into sdkmanager --licenses. The first run writes the
  // license accept record to $SDK_ROOT/licenses/; subsequent runs are no-ops.
  log('Accepting SDK licenses (idempotent)...');
  const sdkMgr = path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
  // Redirect everything through a shell so stdin is a real pipe.
  // The license prompt cycles through ~7 licenses; `yes` answers them all,
  // and the trailing `y/N?` after the last "All accepted" is harmless
  // because we've already written all accept records.
  // codeql[js/indirect-command-line-injection] reason: SDK_ROOT comes
  // from ANDROID_HOME (hardcoded to /tmp/android-sdk by the workflow)
  // or os.tmpdir() fallback — not attacker-controllable.
  const cmd = `printf 'y\\ny\\ny\\ny\\ny\\ny\\ny\\ny\\n' | "${sdkMgr}" --sdk_root="${SDK_ROOT}" --licenses >/dev/null 2>&1; true`;
  const r = spawnSync('bash', ['-c', cmd], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`sdkmanager --licenses exited with code ${r.status}`);
  }
}

function installBuildTools() {
  const aaptPath = path.join(SDK_ROOT, 'build-tools', BUILD_TOOLS_VERSION, 'aapt');
  if (fs.existsSync(aaptPath)) {
    log(`build-tools;${BUILD_TOOLS_VERSION} already installed (aapt present)`);
    return;
  }
  log(`Installing build-tools;${BUILD_TOOLS_VERSION}...`);
  const sdkMgr = path.join(SDK_ROOT, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
  // sdkmanager parses --sdk_root=path but not --sdk_root path (no space form).
  // The licenses subcommand is the same — keep the = form throughout.
  const r = spawnSync(sdkMgr, [
    `--sdk_root=${SDK_ROOT}`,
    `build-tools;${BUILD_TOOLS_VERSION}`,
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`sdkmanager install build-tools;${BUILD_TOOLS_VERSION} exited with code ${r.status}`);
  }
  if (!fs.existsSync(aaptPath)) {
    throw new Error(`build-tools install reported success but ${aaptPath} is missing`);
  }
}

function main() {
  if (alreadyInstalled()) {
    log('aapt is already on PATH — nothing to do');
  } else {
    ensureCmdlineTools();
    acceptLicenses();
    installBuildTools();
    log(`Done. aapt is at ${SDK_ROOT}/build-tools/${BUILD_TOOLS_VERSION}/aapt`);
    log('Caller must add $ANDROID_HOME/build-tools/<ver> to PATH for the unified-downloader to find aapt.');
  }

  // Print the version to stdout so the same step that runs us can capture
  // it via bash command substitution:
  //   BT_VERSION="$(node install-aapt.js | grep '^ANDROID_BUILD_TOOLS_VERSION=' | cut -d= -f2)"
  // $GITHUB_ENV does NOT propagate within a single step (only across steps),
  // so command substitution is the only way to read it back in this step.
  // All log lines go to stderr via log()/console.error, so they remain
  // visible in the workflow log without polluting the captured value.
  process.stdout.write(`ANDROID_BUILD_TOOLS_VERSION=${BUILD_TOOLS_VERSION}\n`);

  // Also export to $GITHUB_ENV so *subsequent* steps in the same job can
  // reference ${{ env.ANDROID_BUILD_TOOLS_VERSION }} without re-running.
  if (process.env.GITHUB_ENV) {
    try {
      fs.appendFileSync(process.env.GITHUB_ENV,
        `ANDROID_BUILD_TOOLS_VERSION=${BUILD_TOOLS_VERSION}\n`);
    } catch (e) {
      log(`warning: could not write to GITHUB_ENV: ${e.message}`);
    }
  }
}

try {
  main();
} catch (e) {
  console.error(`[aapt-install] FAILED: ${e.message}`);
  process.exit(1);
}
