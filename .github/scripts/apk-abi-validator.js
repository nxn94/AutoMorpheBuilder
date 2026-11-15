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
const { apkHasNativeLibsForArch, detectApkShape, listApkAbis } = require('./apk-selection');

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
 * @param {{timeoutMs?: () => number, expired?: () => boolean}} [limits] Time left for each subprocess; a
 *   caller passing this must reject the file once expired, since checks that can't run count as passes.
 * @throws {Error} If the file is genuinely missing the preferred arch's .so.
 */
function validateDownloadedApkAbi(filePath, preferredArch, limits = {}) {
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
    if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) return;
  } finally {
    fs.closeSync(fd);
  }

  const shape = detectApkShape(filePath, limits);
  if (shape === 'unknown') return; // Trust upstream; download-supported-apk.js's post-merge guardrail is the safety net.
  if (shape === 'apk') {
    const abis = listApkAbis(filePath, limits);
    if (abis.length > 0 && !apkHasNativeLibsForArch(filePath, preferredArch, limits)) {
      throw new Error(
        `Downloaded APK ${path.basename(filePath)} is missing ` +
        `lib/${preferredArch}/*.so (upstream mislabelled it as universal/` +
        `noarch). Falling back to next download source.`,
      );
    }
    if (abis.length === 0 && requiresAbiSplit(filePath, limits)) {
      throw new Error(
        `Downloaded APK ${path.basename(filePath)} is the base APK of a split app: ` +
        'it has no native libraries and its manifest requires an ABI split. ' +
        'Falling back to next download source.',
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
  require('../../src/apk/validate-boundary').validateArchiveSafe(filePath, limits);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi_check_'));
  try {
    try {
      execFileSync('unzip', ['-q', '-o', filePath, '-d', tmpDir], { stdio: 'ignore', timeout: limits.timeoutMs?.() });
    } catch {
      // Extraction failed (corrupt bundle, unsupported format, etc.).
      // Trust the upstream — download-supported-apk.js's post-merge
      // ABI guardrail will catch this if it's actually broken.
      return;
    }
    const inner = fs.readdirSync(tmpDir).filter((f) => f.toLowerCase().endsWith('.apk'));
    if (inner.length > 0 && inner.every((apk) => listApkAbis(path.join(tmpDir, apk), limits).length === 0)) return;
    for (const apk of inner) {
      if (limits.expired?.()) return; // the caller rejects anything past its end time
      if (apkHasNativeLibsForArch(path.join(tmpDir, apk), preferredArch, limits)) return;
    }
    throw new Error(
      `Downloaded bundle ${path.basename(filePath)} has no split containing ` +
      `lib/${preferredArch}/*.so. Falling back to next download source.`,
    );
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * True when the APK's manifest declares android:requiredSplitTypes with an
 * ABI type (e.g. "base__abi"). Such an APK is the base of a split app whose
 * native libraries live in the ABI split, so on its own it installs
 * nowhere (Discord's base.apk, served by APKPure as a plain "APK").
 *
 * Reads that one attribute of the root <manifest> element from the binary
 * manifest, so no aapt is needed. Any read or parse error counts as "not required".
 */
function requiresAbiSplit(filePath, limits = {}) {
  let manifest;
  try {
    manifest = execFileSync('unzip', ['-p', filePath, 'AndroidManifest.xml'], {
      timeout: limits.timeoutMs?.(), maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return false;
  }
  let value;
  try {
    value = manifestRootAttribute(manifest, REQUIRED_SPLIT_TYPES_ID, 'requiredSplitTypes');
  } catch {
    return false;
  }
  return typeof value === 'string' && value.split(',').some((t) => /__abi$/.test(t.trim()));
}

const ANDROID_NS = 'http://schemas.android.com/apk/res/android';
const REQUIRED_SPLIT_TYPES_ID = 0x0101064e; // android:requiredSplitTypes

/**
 * String value of one android: attribute on the root element of a binary
 * XML file (AndroidManifest.xml as stored in an APK), matched by resource
 * id, or by name and namespace when the file maps no resource id to it.
 * Returns undefined when the root element doesn't have it or the value
 * isn't a string. Throws on a malformed file.
 */
function manifestRootAttribute(buf, resId, attrName) {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw new Error('not binary XML');
  let pos = buf.readUInt16LE(2);
  let strings = null;
  let resIds = [];
  while (pos + 8 <= buf.length) {
    const type = buf.readUInt16LE(pos);
    const headerSize = buf.readUInt16LE(pos + 2);
    const size = buf.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > buf.length) throw new Error('bad chunk');
    if (type === 0x0001) {
      strings = readStringPool(buf, pos, size);
    } else if (type === 0x0180) {
      resIds = [];
      for (let p = pos + headerSize; p + 4 <= pos + size; p += 4) resIds.push(buf.readUInt32LE(p));
    } else if (type === 0x0102) {
      if (!strings) throw new Error('no string pool');
      const ext = pos + headerSize;
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10);
      const attrCount = buf.readUInt16LE(ext + 12);
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        if (a + 20 > pos + size) throw new Error('bad attribute');
        const ns = buf.readUInt32LE(a);
        const name = buf.readUInt32LE(a + 4);
        const matches = resIds[name]
          ? resIds[name] === resId
          : strings[name] === attrName && strings[ns] === ANDROID_NS;
        if (!matches) continue;
        const raw = buf.readUInt32LE(a + 8);
        if (raw !== 0xffffffff) return strings[raw];
        return buf[a + 15] === 0x03 ? strings[buf.readUInt32LE(a + 16)] : undefined; // TYPE_STRING
      }
      return undefined; // only the root element counts
    }
    pos += size;
  }
  return undefined;
}

function readStringPool(buf, start, size) {
  const headerSize = buf.readUInt16LE(start + 2);
  const count = buf.readUInt32LE(start + 8);
  const utf8 = (buf.readUInt32LE(start + 16) & 0x100) !== 0;
  const base = start + buf.readUInt32LE(start + 20);
  const end = start + size;
  if (start + headerSize + 4 * count > end) throw new Error('bad string pool');
  const strings = [];
  for (let i = 0; i < count; i++) {
    let p = base + buf.readUInt32LE(start + headerSize + 4 * i);
    let len;
    if (utf8) {
      p += buf[p] & 0x80 ? 2 : 1; // length in characters, then in bytes
      len = buf[p] & 0x80 ? ((buf[p] & 0x7f) << 8) | buf[p + 1] : buf[p];
      p += buf[p] & 0x80 ? 2 : 1;
      if (p + len > end) throw new Error('bad string');
      strings.push(buf.toString('utf8', p, p + len));
    } else {
      len = buf.readUInt16LE(p);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2);
        p += 4;
      } else {
        p += 2;
      }
      if (p + 2 * len > end) throw new Error('bad string');
      strings.push(buf.toString('utf16le', p, p + 2 * len));
    }
  }
  return strings;
}

module.exports = { validateDownloadedApkAbi, detectApkShape, requiresAbiSplit, manifestRootAttribute };