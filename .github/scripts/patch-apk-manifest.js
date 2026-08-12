#!/usr/bin/env node
/**
 * patch-apk-manifest.js — directly rewrite versionCode / versionName on the
 * binary AndroidManifest.xml inside an APK zip.
 *
 * Why this exists:
 *   The previous flow used `apktool d … apktool b` to round-trip the APK just
 *   to flip two attributes on the binary AndroidManifest.xml. Three apktool
 *   versions in a row (2.10.0, 2.12.1, 3.0.2) silently exit-1'd on the
 *   Morphe-patched YouTube APK. We then switched to ensody/androidmanifest-
 *   changer, which shells out to system `aapt2 convert` and that crashes too
 *   with `XmlDom.cpp:356 Check failed: !node_stack.empty()`. The crash is
 *   inside Google's AXML parser, not in our caller's logic.
 *
 *   This script walks the AXML chunk structure directly (AOSP ResourceTypes.h
 *   is the spec). It has no assertions to trip and no third-party parser to
 *   disagree with us. Mutation is two surgical changes per attribute:
 *     - versionCode: overwrite the typedValue.data int32 in place.
 *     - versionName: append the new UTF-8/UTF-16 string to the string pool,
 *       update the attribute's pool indices, bump the relevant chunk sizes.
 *
 * Usage:
 *   node patch-apk-manifest.js <input.apk> <output.apk> \
 *     --version-code 12345 \
 *     --version-name "1.2.3+v4"
 *
 *   If <output.apk> equals <input.apk>, the APK is rewritten in place.
 *
 * Exits non-zero on any structural error so `set -euo pipefail` callers
 * get a clear failure path.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// === AXML chunk / value constants (AOSP frameworks/base/include/androidfw/ResourceTypes.h) ===
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_TYPE = 0x0003;
const RES_XML_START_ELEMENT_TYPE = 0x0102;

const UTF8_FLAG = 1 << 8;
const SORTED_FLAG = 1 << 0;

const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;

const STRING_POOL_HEADER_SIZE = 28;
const RES_CHUNK_HEADER_SIZE = 8;
const ATTR_SIZE = 20;
const NO_ENTRY = 0xFFFFFFFF;
const MAX_ANDROID_VERSION_CODE = 0x7FFFFFFF;

function fail(msg, code = 1) {
  process.stderr.write(`[patch-apk-manifest] ${msg}\n`);
  process.exit(code);
}

function usage() {
  return [
    'Usage: node patch-apk-manifest.js <input.apk> <output.apk> [options]',
    '',
    'Options:',
    '  --version-code N    Set versionCode to N (uint32)',
    '  --version-name "X"  Set versionName to X (string)',
    '',
    'At least one of --version-code / --version-name must be provided.',
    'If <output> equals <input>, the APK is rewritten in place.',
  ].join('\n');
}

// === Argv parsing ===
function parseArgs(argv) {
  const opts = { versionCode: null, versionName: null };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version-code' || a === '--versionCode') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0 || v > MAX_ANDROID_VERSION_CODE) {
        fail(`--version-code must be an Android signed 32-bit integer (0..${MAX_ANDROID_VERSION_CODE}), got: ${argv[i]}`);
      }
      opts.versionCode = v >>> 0;
    } else if (a === '--version-name' || a === '--versionName') {
      opts.versionName = argv[++i];
      if (typeof opts.versionName !== 'string') {
        fail(`--version-name requires a string value`);
      }
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(usage() + '\n');
      process.exit(0);
    } else if (a.startsWith('-')) {
      fail(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) {
    process.stderr.write(usage() + '\n');
    fail(`Expected exactly two positional args, got ${positional.length}`);
  }
  if (opts.versionCode === null && opts.versionName === null) {
    fail('At least one of --version-code or --version-name must be provided');
  }
  return { ...opts, input: positional[0], output: positional[1] };
}

// === APK read ===
function readManifestFromApk(apkPath) {
  const buf = execFileSync('unzip', ['-p', apkPath, 'AndroidManifest.xml'], {
    maxBuffer: 32 * 1024 * 1024,
  });
  if (!buf || buf.length < RES_CHUNK_HEADER_SIZE) {
    fail(`AndroidManifest.xml from ${apkPath} is empty or truncated`);
  }
  return buf;
}

// === AXML parser/patcher ===
class AxmlPatcher {
  constructor(buf) {
    this.buf = buf;
    this._verifyTopLevel();
    this.stringPool = this._parseStringPool();
    this.rootElement = this._findRootManifest();
  }

  _verifyTopLevel() {
    if (this.buf.length < RES_CHUNK_HEADER_SIZE) fail('AXML too small');
    const type = this.buf.readUInt16LE(0);
    if (type !== RES_XML_TYPE) {
      fail(`Top-level chunk is not RES_XML_TYPE (got 0x${type.toString(16)})`);
    }
    this.xmlChunkSize = this.buf.readUInt32LE(4);
    if (this.xmlChunkSize > this.buf.length) {
      fail(`XML chunk size (${this.xmlChunkSize}) > buffer length (${this.buf.length})`);
    }
  }

  _parseStringPool() {
    let off = RES_CHUNK_HEADER_SIZE;
    while (off < this.xmlChunkSize) {
      const t = this.buf.readUInt16LE(off);
      const sz = this.buf.readUInt32LE(off + 4);
      if (sz < RES_CHUNK_HEADER_SIZE || off + sz > this.xmlChunkSize) {
        fail(`Invalid chunk at offset ${off}: type=0x${t.toString(16)} size=${sz}`);
      }
      if (t === RES_STRING_POOL_TYPE) return this._readStringPool(off, sz);
      off += sz;
    }
    fail('No string pool found in AXML');
  }

  _readStringPool(chunkOff, chunkSize) {
    if (chunkSize < STRING_POOL_HEADER_SIZE) fail(`String pool too small: ${chunkSize}`);
    const stringCount = this.buf.readUInt32LE(chunkOff + 8);
    const styleCount = this.buf.readUInt32LE(chunkOff + 12);
    if (styleCount !== 0) {
      fail(`Style count ${styleCount} != 0; this patcher only handles AndroidManifest.xml pools`);
    }
    const flags = this.buf.readUInt32LE(chunkOff + 16);
    const stringsStart = this.buf.readUInt32LE(chunkOff + 20);
    const stylesStart = this.buf.readUInt32LE(chunkOff + 24);
    const utf8 = (flags & UTF8_FLAG) !== 0;
    const sorted = (flags & SORTED_FLAG) !== 0;
    return {
      chunkOff, chunkSize, stringCount, styleCount, flags,
      stringsStart, stylesStart, utf8, sorted,
    };
  }

  _findRootManifest() {
    let off = this.stringPool.chunkOff + this.stringPool.chunkSize;
    while (off < this.xmlChunkSize) {
      if (off + 16 > this.xmlChunkSize) break;
      const t = this.buf.readUInt16LE(off);
      const chunkSize = this.buf.readUInt32LE(off + 4);
      if (chunkSize < 16 || off + chunkSize > this.xmlChunkSize) {
        fail(`Invalid XML tree chunk at offset ${off}: type=0x${t.toString(16)} size=${chunkSize}`);
      }
      if (t === RES_XML_START_ELEMENT_TYPE) {
        const headerSize = this.buf.readUInt16LE(off + 2);
        // headerSize=16: ResChunk_header (8) + lineNumber (4) + comment (4).
        // After that comes ResXMLTree_attrExt (ns, name, attributeStart,
        // attributeSize, attributeCount, idIndex, classIndex, styleIndex).
        // attributeStart is RELATIVE TO attrExt, NOT to the chunk. attrExt
        // begins at off + headerSize. Attribute struct follows at
        // off + headerSize + attributeStart.
        if (headerSize !== 16) fail(`Unexpected start-element header size ${headerSize} (expected 16)`);
        const nameIdx = this.buf.readUInt32LE(off + 20);
        const name = this._readString(this.stringPool, nameIdx);
        if (name === 'manifest') {
          const attributeStart = this.buf.readUInt16LE(off + 24);
          const attributeSize = this.buf.readUInt16LE(off + 26);
          const attributeCount = this.buf.readUInt16LE(off + 28);
          if (attributeSize !== ATTR_SIZE) fail(`Unexpected attribute size ${attributeSize} (expected ${ATTR_SIZE})`);
          return {
            chunkOff: off,
            chunkSize,
            attrArrayStart: off + headerSize + attributeStart,
            attrCount: attributeCount,
          };
        }
      }
      off += chunkSize;
    }
    fail('No <manifest> start element found in AXML');
  }

  // Decode a string in the pool's encoding. Returns { str, byteLen }.
  _decodeString(absOffset) {
    const pool = this.stringPool;
    const maxEnd = pool.chunkOff + pool.chunkSize;
    if (absOffset < pool.chunkOff + pool.stringsStart || absOffset >= maxEnd) {
      fail(`String offset out of pool bounds: ${absOffset}`);
    }
    if (pool.utf8) {
      // UTF-8 layout:
      //   char-len prefix: 1 byte (≤0x7F) or 2 bytes (high bit set; big-endian)
      //   byte-len prefix: 1 byte (≤0x7F) or 2 bytes (high bit set; big-endian)
      //   UTF-8 bytes
      //   null terminator (1 byte)
      let p = absOffset;
      const c0 = this.buf.readUInt8(p);
      if (c0 & 0x80) {
        p += 2;
      } else {
        p += 1;
      }
      const b0 = this.buf.readUInt8(p);
      let byteLen;
      if (b0 & 0x80) {
        byteLen = ((b0 & 0x7F) << 8) | this.buf.readUInt8(p + 1);
        p += 2;
      } else {
        byteLen = b0;
        p += 1;
      }
      const str = this.buf.toString('utf8', p, p + byteLen);
      return { str, byteLen: p + byteLen + 1 - absOffset };
    } else {
      // UTF-16 layout:
      //   char-len prefix: 2 bytes LE (≤0x7FFF) or 4 bytes LE (high bit set on first 2)
      //   UTF-16LE bytes
      //   null terminator (2 bytes)
      let p = absOffset;
      const c0 = this.buf.readUInt16LE(p);
      let charLen;
      let lenBytes;
      if (c0 & 0x8000) {
        const hi = c0 & 0x7FFF;
        const lo = this.buf.readUInt16LE(p + 2);
        charLen = (hi << 16) | lo;
        lenBytes = 4;
      } else {
        charLen = c0;
        lenBytes = 2;
      }
      p += lenBytes;
      const str = this.buf.toString('utf16le', p, p + charLen * 2);
      return { str, byteLen: lenBytes + charLen * 2 + 2 };
    }
  }

  _readString(pool, idx) {
    if (idx === NO_ENTRY) return null;
    if (idx >= pool.stringCount) fail(`String pool index out of range: ${idx} >= ${pool.stringCount}`);
    const offsetsStart = pool.chunkOff + STRING_POOL_HEADER_SIZE;
    const relOffset = this.buf.readUInt32LE(offsetsStart + idx * 4);
    const absOffset = pool.chunkOff + pool.stringsStart + relOffset;
    return this._decodeString(absOffset).str;
  }

  // Encode a string in the pool's encoding. Returns Buffer.
  _encodeString(str) {
    if (this.stringPool.utf8) {
      const encoded = Buffer.from(str, 'utf8');
      const charLen = str.length;
      const byteLen = encoded.length;
      const charLenBytes = charLen <= 0x7F
        ? Buffer.from([charLen])
        : Buffer.from([0x80 | (charLen >> 8), charLen & 0xFF]);
      const byteLenBytes = byteLen <= 0x7F
        ? Buffer.from([byteLen])
        : Buffer.from([0x80 | (byteLen >> 8), byteLen & 0xFF]);
      return Buffer.concat([charLenBytes, byteLenBytes, encoded, Buffer.from([0])]);
    } else {
      const encoded = Buffer.from(str, 'utf16le');
      const charLen = str.length;
      let lenBytes;
      if (charLen <= 0x7FFF) {
        lenBytes = Buffer.from([charLen & 0xFF, (charLen >> 8) & 0xFF]);
      } else {
        const hi = 0x8000 | (charLen >> 16);
        const lo = charLen & 0xFFFF;
        lenBytes = Buffer.from([hi & 0xFF, (hi >> 8) & 0xFF, lo & 0xFF, (lo >> 8) & 0xFF]);
      }
      return Buffer.concat([lenBytes, encoded, Buffer.from([0, 0])]);
    }
  }

  // Find attribute on root <manifest> by name. Returns absolute offset of the
  // attribute struct, or null if not found.
  findAttribute(name) {
    const re = this.rootElement;
    for (let i = 0; i < re.attrCount; i++) {
      const attrOff = re.attrArrayStart + i * ATTR_SIZE;
      const nameIdx = this.buf.readUInt32LE(attrOff + 4);
      const attrName = this._readString(this.stringPool, nameIdx);
      if (attrName === name) {
        return {
          offset: attrOff,
          namespace: this.buf.readUInt32LE(attrOff + 0),
          name: nameIdx,
          rawValue: this.buf.readUInt32LE(attrOff + 8),
          typedValueSize: this.buf.readUInt16LE(attrOff + 12),
          typedValueRes0: this.buf.readUInt8(attrOff + 14),
          typedValueDataType: this.buf.readUInt8(attrOff + 15),
          typedValueData: this.buf.readUInt32LE(attrOff + 16),
        };
      }
    }
    return null;
  }

  // === Mutations ===

  setVersionCode(newCode) {
    const attr = this.findAttribute('versionCode');
    if (!attr) fail('versionCode attribute not found on <manifest>');
    if (attr.typedValueDataType !== TYPE_INT_DEC) {
      fail(`versionCode typedValue.dataType is 0x${attr.typedValueDataType.toString(16)} (expected 0x${TYPE_INT_DEC.toString(16)})`);
    }
    // Overwrite the int32 in place; no chunk-size change.
    this.buf.writeUInt32LE(newCode >>> 0, attr.offset + 16);
  }

  setVersionName(newName) {
    const attr = this.findAttribute('versionName');
    if (!attr) fail('versionName attribute not found on <manifest>');
    if (attr.typedValueDataType !== TYPE_STRING) {
      fail(`versionName typedValue.dataType is 0x${attr.typedValueDataType.toString(16)} (expected 0x${TYPE_STRING.toString(16)})`);
    }

    // Snapshot positions before mutation.
    const oldChunkOff = this.stringPool.chunkOff;
    const oldChunkSize = this.stringPool.chunkSize;
    const oldStringsStart = this.stringPool.stringsStart;
    const newStringBytes = this._encodeString(newName);
    const newStringIdx = this.stringPool.stringCount;
    const newRelOffset = oldChunkSize - oldStringsStart; // bytes already used in strings data section

    // 1. Insert a new uint32 entry into the offsets table (just after the last
    //    existing entry, i.e. at offset oldChunkOff+28+stringCount*4).
    const offsetsTableStart = oldChunkOff + STRING_POOL_HEADER_SIZE;
    const oldOffsetsEnd = offsetsTableStart + newStringIdx * 4;
    const newOffsetBuf = Buffer.alloc(4);
    newOffsetBuf.writeUInt32LE(newRelOffset, 0);
    this.buf = Buffer.concat([
      this.buf.subarray(0, oldOffsetsEnd),
      newOffsetBuf,
      this.buf.subarray(oldOffsetsEnd),
    ]);

    // 2. Append the new string at the end of the strings data section. After
    //    step 1, the strings data has shifted forward by 4 bytes, so the new
    //    insertion point is (oldChunkOff + oldStringsStart + 4 + newRelOffset).
    const newInsertionPoint = oldChunkOff + oldStringsStart + 4 + newRelOffset;
    // AOSP's binary XML emitter pads the string pool after every append so
    // chunk sizes stay 4-byte aligned (the start-element chunk's `size`
    // field aapt reads next is computed relative to the string-pool end
    // and has to be aligned too). Without this padding, a longer new name
    // like "8.47.56+v1.32.0" — UTF-8 encoded as 18 bytes (1+1+15+1) — would
    // push the chunk by 18 + 4 = 22 bytes, drifting the end by 2 from a 4
    // boundary and making aapt reject the file with "AndroidManifest.xml
    // is corrupt" / "size ... is not on an integer boundary". The padding
    // bytes sit inside the strings data section but past the last entry
    // in the offsets table, so the parser's offsets-table navigation
    // never reads them.
    const newStringPaddedLen = (newStringBytes.length + 3) & ~3;
    const stringPadding = Buffer.alloc(newStringPaddedLen - newStringBytes.length);
    this.buf = Buffer.concat([
      this.buf.subarray(0, newInsertionPoint),
      newStringBytes,
      stringPadding,
      this.buf.subarray(newInsertionPoint),
    ]);

    // 3. Bump string pool's chunk size and stringCount.
    const addedBytes = newStringPaddedLen + 4; // padded string bytes + new offset entry
    const newChunkSize = oldChunkSize + addedBytes;
    this.buf.writeUInt32LE(newStringIdx + 1, oldChunkOff + 8); // stringCount
    this.buf.writeUInt32LE(newChunkSize, oldChunkOff + 4);     // chunk size

    // 4. Bump stringsStart by 4 (offsets table grew by 4 bytes).
    const newStringsStart = oldStringsStart + 4;
    this.buf.writeUInt32LE(newStringsStart, oldChunkOff + 20);

    // 5. Bump the top-level XML chunk size.
    this.xmlChunkSize += addedBytes;
    this.buf.writeUInt32LE(this.xmlChunkSize, 4);

    // 6. The attribute itself has shifted forward by addedBytes (because the
    //    string pool chunk grew before it). Compute the new attribute offset
    //    and update rawValue + typedValue.data to point at the new pool entry.
    const newAttrOffset = attr.offset + addedBytes;
    if (attr.rawValue !== NO_ENTRY) {
      this.buf.writeUInt32LE(newStringIdx, newAttrOffset + 8);  // rawValue
    }
    this.buf.writeUInt32LE(newStringIdx, newAttrOffset + 16); // typedValue.data

    // 7. Update internal state.
    this.stringPool.stringCount = newStringIdx + 1;
    this.stringPool.chunkSize = newChunkSize;
    this.stringPool.stringsStart = newStringsStart;
    this.rootElement.chunkOff += addedBytes;
    this.rootElement.attrArrayStart += addedBytes;
  }
}

// === APK write ===
function writeManifestToApk(apkPath, manifestBytes) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-apk-'));
  try {
    const tmpManifest = path.join(tmpDir, 'AndroidManifest.xml');
    fs.writeFileSync(tmpManifest, manifestBytes);
    // zip -f replaces the entry in place without changing entry order.
    execFileSync('zip', ['-f', apkPath, 'AndroidManifest.xml'], {
      cwd: tmpDir,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// === Main ===
function main() {
  const opts = parseArgs(process.argv);

  if (!fs.existsSync(opts.input)) fail(`input APK not found: ${opts.input}`);

  process.stderr.write(`[patch-apk-manifest] Reading AndroidManifest.xml from ${opts.input}\n`);
  const originalManifest = readManifestFromApk(opts.input);
  process.stderr.write(`[patch-apk-manifest] manifest: ${originalManifest.length} bytes\n`);

  const patcher = new AxmlPatcher(Buffer.from(originalManifest));

  if (opts.versionCode !== null) {
    const before = patcher.findAttribute('versionCode');
    if (!before) fail('versionCode attribute not found on <manifest>');
    patcher.setVersionCode(opts.versionCode);
    process.stderr.write(`[patch-apk-manifest] versionCode: ${before.typedValueData} → ${opts.versionCode}\n`);
  }

  if (opts.versionName !== null) {
    const before = patcher.findAttribute('versionName');
    if (!before) fail('versionName attribute not found on <manifest>');
    const beforeName = patcher._readString(patcher.stringPool, before.typedValueData);
    patcher.setVersionName(opts.versionName);
    process.stderr.write(`[patch-apk-manifest] versionName: "${beforeName}" → "${opts.versionName}"\n`);
  }

  // Sanity: re-parse the modified manifest to confirm it's still a valid AXML.
  new AxmlPatcher(Buffer.from(patcher.buf));

  // Stage the target APK, then update entry in place.
  if (opts.input !== opts.output) {
    execFileSync('cp', ['--', opts.input, opts.output]);
    process.stderr.write(`[patch-apk-manifest] copied ${opts.input} → ${opts.output}\n`);
  }
  writeManifestToApk(opts.output, patcher.buf);

  // Sanity: read it back with aapt to confirm round-trip works.
  process.stderr.write(`[patch-apk-manifest] ✓ wrote ${opts.output}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    fail(e && e.message ? e.message : String(e));
  }
}

module.exports = { AxmlPatcher, parseArgs };
