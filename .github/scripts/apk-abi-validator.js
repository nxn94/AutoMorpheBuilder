#!/usr/bin/env node
'use strict';

/**
 * apk-abi-validator.js — post-download ABI validation for the downloader.
 *
 * Extracted from unified-downloader.js so it can be unit-tested without
 * pulling in playwright + the network stack. The downloader's three
 * terminal functions (downloadWithUrl, downloadWithApkeep,
 * downloadViaPlaywright) call validateDownloadedApkAbi() before their
 * success return. A throw here is caught by the fallback chain in
 * download() (URL cache → parallel resolve → apkeep → apkmirror-api →
 * apkmirror Playwright), so a 32-bit-only APK from upstream gets
 * rejected and the next source is tried.
 *
 * The post-merge ABI guardrail in download-supported-apk.js still fires
 * as a final safety net — this is just an earlier, cheaper check that
 * catches the bad download before it gets cached.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { apkHasNativeLibsForArch } = require('./apk-selection');

/**
 * Inspect the zip at `filePath` and decide whether it's a single APK
 * or a bundle (zip-of-zips with inner .apk entries). Returns:
 *   'apk'       — file has lib/* or AndroidManifest.xml at top level
 *   'bundle'    — file has inner .apk entries (apks / apkm / xapk shape)
 *   'unknown'   — non-zip, empty, or unrecognizable
 *
 * Content-based detection matters because upstream sources sometimes
 * mislabel the extension: APKMirror's apkm-pw flow saves bundle files
 * with whatever filename the server's Content-Disposition sets, and
 * Reddit's variant downloads come back with a `.apk` filename even
 * though the contents are a zip-of-zips. Extension-based dispatch
 * would treat such a bundle as a single APK, run lib/<arch>/*.so
 * detection on it, find no top-level native libs, and reject it —
 * even though the bundle's inner base.apk / split_config.*.apk files
 * DO contain the right ABIs and would merge into a universal APK.
 */
function detectApkShape(filePath) {
  try {
    const out = execFileSync('unzip', ['-Z1', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = out.split('\n');
    let hasInnerApk = false;
    let hasTopLevelLib = false;
    let hasManifest = false;
    for (const line of lines) {
      if (!line) continue;
      // Inner .apk → bundle
      if (line.toLowerCase().endsWith('.apk')) { hasInnerApk = true; continue; }
      // Top-level lib/<arch>/ → single APK with native libs
      if (/^lib\/[^/]+\//.test(line)) { hasTopLevelLib = true; continue; }
      // AndroidManifest.xml at top level → single APK (signature)
      if (line === 'AndroidManifest.xml') { hasManifest = true; continue; }
    }
    if (hasInnerApk && !hasTopLevelLib && !hasManifest) return 'bundle';
    if (hasTopLevelLib || hasManifest) return 'apk';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Reject a freshly-downloaded APK/bundle that lacks libs for the
 * preferred architecture. Throws on failure; no-op otherwise.
 *
 * Detection is content-based (not extension-based): the same helper
 * inspects the zip's top-level entries and decides whether it's a
 * single APK or a bundle. APKMirror's apkm-pw flow commonly saves a
 * BUNDLE-shaped file (zip-of-zips with inner .apk entries) under a
 * `.apk` filename when the upstream Content-Disposition names the
 * file that way; extension-based dispatch would then mis-validate
 * the bundle as a single APK and reject it for "missing lib/<arch>".
 *
 * Non-zip files (HTML error pages, partial downloads, test fixtures
 * that are just bytes) are silently skipped — `unzip -Z1` would error
 * and apkHasNativeLibsForArch would return false, causing us to
 * spuriously reject the download. The size + version checks in
 * downloadWithUrl catch those cases; we don't want to add an
 * ABI-flavoured error on top.
 *
 * @param {string} filePath Path to the downloaded APK / XAPK / APKM / APKS.
 * @param {string|undefined} preferredArch e.g. "arm64-v8a"; empty/undefined means no filter.
 * @throws {Error} If the file is genuinely missing the preferred arch's .so.
 */
function validateDownloadedApkAbi(filePath, preferredArch) {
if (!preferredArch) return;

  // Zip-magic-byte check (PK\x03\x04) so non-zip placeholders don't
  // trip unzip. See function header.
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return;
  }
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    if (buf[0] !== 0x50 || buf[1] !== 0x6b || buf[2] !== 0x03 || buf[3] !== 0x04) return;
  } finally {
    fs.closeSync(fd);
  }

  const shape = detectApkShape(filePath);
  if (shape === 'unknown') return; // Trust upstream; download-supported-apk.js's post-merge guardrail is the safety net.
  if (shape === 'apk') {
    if (!apkHasNativeLibsForArch(filePath, preferredArch)) {
      throw new Error(
        `Downloaded APK ${path.basename(filePath)} is missing ` +
        `lib/${preferredArch}/*.so (upstream mislabelled it as universal/` +
        `noarch). Falling back to next download source.`,
      );
    }
    return;
  }

  // shape === 'bundle': extract to temp dir, check each inner .apk.
  // We can't simply look for split_config.<arch>.apk in the listing
  // because (a) the arch can be encoded with or without dashes
  // (arm64-v8a vs arm64_v8a), (b) some bundles ship the preferred
  // arch only inside base.apk, and (c) filename conventions drift.
  // Extraction + the same zip-listing helper used for plain APKs is
  // the most reliable.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi_check_'));
  try {
    try {
      execFileSync('unzip', ['-q', '-o', filePath, '-d', tmpDir], { stdio: 'ignore' });
    } catch {
      // Extraction failed (corrupt bundle, unsupported format, etc.).
      // Trust the upstream — download-supported-apk.js's post-merge
      // ABI guardrail will catch this if it's actually broken.
      return;
    }
    const inner = fs.readdirSync(tmpDir).filter((f) => f.toLowerCase().endsWith('.apk'));
    for (const apk of inner) {
      if (apkHasNativeLibsForArch(path.join(tmpDir, apk), preferredArch)) return;
    }
    throw new Error(
      `Downloaded bundle ${path.basename(filePath)} has no split containing ` +
      `lib/${preferredArch}/*.so. Falling back to next download source.`,
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

module.exports = { validateDownloadedApkAbi, detectApkShape };