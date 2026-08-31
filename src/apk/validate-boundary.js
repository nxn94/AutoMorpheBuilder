'use strict';

/**
 * src/apk/validate-boundary.js
 *
 * Hard-fail integrity + safety checks for a downloaded APK/XAPK/APKM/APKS
 * archive. Run on the final, post-download archive BEFORE any further
 * processing (aapt badging, split-package merge, ABI guardrail, etc.),
 * so a corrupt or malicious archive can never reach morphe-desktop or
 * the signing step.
 *
 * The checks mirror the inventory in `docs/checksums.md` and the
 * AutoMorpheBuilder "Morphe" policy:
 *
 *   1. Archive integrity — `unzip -t` exits non-zero on a corrupt zip.
 *      Catches partial downloads, disk-full truncation, and man-in-the-
 *      middle tampering.
 *
 *   2. `classes*.dex` presence — every patchable Android archive must
 *      contain at least one `classes.dex` / `classes2.dex` entry. Split
 *      packages (xapk/apkm/apks) wrap per-arch APKs at the top level
 *      and never have a top-level dex, so callers should pass
 *      `isBundle: true` to skip this check on the outer bundle (the
 *      merge step validates the inner APKs).
 *
 *   3. Safe-path assertion — every entry name must pass
 *      `src/archive/assert-safe-entry.js`. Rejects absolute paths (`/etc`)
 *      and `..` traversal (`../../secret`). Backed by unit tests in
 *      src/archive/__tests__/assert-safe-entry.test.js.
 *
 * All three checks throw `InvalidApkError` from `src/errors/` with a
 * stable `code: 'INVALID_APK'` and a `details` object describing which
 * check failed (so callers + log scrapers can distinguish the failure
 * mode without parsing the message text).
 *
 * No I/O happens at module load — only when `validateApkBoundary` (or
 * its sibling `validateArchiveSafe`) is called. This keeps it cheap to
 * import from test fixtures.
 */

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const { assertSafeArchiveEntry } = require('../archive/assert-safe-entry');
const { InvalidApkError } = require('../errors');

const DEX_ENTRY_RE = /^classes(?:\d+)?\.dex$/;

function listArchiveEntries(archivePath) {
  let out;
  try {
    out = execFileSync('unzip', ['-Z1', archivePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new InvalidApkError(
      `Failed to enumerate archive entries: ${archivePath}: ${e.message}`,
      { code: 'INVALID_APK', details: { check: 'enumerate', path: archivePath } },
    );
  }
  return out.split('\n').filter(Boolean);
}

function assertArchiveIntegrity(archivePath) {
  // `unzip -t` runs the CRC + structure check and exits non-zero on any
  // corruption. Stderr is suppressed because the listing is noisy and
  // not actionable for callers — the non-zero status is what matters.
  let r;
  try {
    r = execFileSync('unzip', ['-t', archivePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (e) {
    throw new InvalidApkError(
      `Archive integrity check failed: ${archivePath}: ${e.message}`,
      {
        code: 'INVALID_APK',
        details: { check: 'archive_integrity', path: archivePath },
      },
    );
  }
  // Defensive: `unzip -t` with `stdio: ignore` for stdout + pipe for
  // stderr can still exit 0 while reporting errors on stderr; surface
  // any "At least one error" / "Bad ZIP" line in stdout as well.
  if (typeof r === 'string' && /Bad ZIP|At least one error/i.test(r)) {
    throw new InvalidApkError(
      `Archive integrity check failed: ${archivePath}`,
      {
        code: 'INVALID_APK',
        details: { check: 'archive_integrity', path: archivePath, output: r.trim() },
      },
    );
  }
}

function assertHasDexEntries(archivePath, entries) {
  const matches = entries.filter((e) => DEX_ENTRY_RE.test(e));
  if (matches.length === 0) {
    throw new InvalidApkError(
      `Archive contains no classes*.dex entries: ${archivePath}`,
      {
        code: 'INVALID_APK',
        details: { check: 'classes_dex_present', path: archivePath },
      },
    );
  }
}

function assertSafeEntries(entries) {
  for (const entry of entries) {
    try {
      assertSafeArchiveEntry(entry);
    } catch (e) {
      throw new InvalidApkError(
        `Archive contains unsafe entry: ${e.message}`,
        {
          code: 'INVALID_APK',
          details: { check: 'safe_path', entry, error: e.message },
        },
      );
    }
  }
}

/**
 * Validate a downloaded APK (single .apk shape) end-to-end. Throws
 * InvalidApkError on any failure. Call this on every downloaded .apk
 * BEFORE the aapt version check, ABI guardrail, or patch step.
 *
 * For split packages (.xapk / .apkm / .apks — outer zip-of-zips), use
 * `validateArchiveSafe(..., { isBundle: true })` instead and rely on
 * the post-merge apkHasDex check to catch dex-less inner APKs.
 */
function validateApkBoundary(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new InvalidApkError(
      `Archive path does not exist: ${archivePath}`,
      { code: 'INVALID_APK', details: { check: 'exists', path: archivePath } },
    );
  }
  assertArchiveIntegrity(archivePath);
  const entries = listArchiveEntries(archivePath);
  assertHasDexEntries(archivePath, entries);
  assertSafeEntries(entries);
}

/**
 * Validate a downloaded archive's structural safety without requiring
 * a top-level classes.dex. Use this for split-package bundles whose
 * inner APKs are merged later — the merge step performs its own dex
 * validation via apkHasDex.
 */
function validateArchiveSafe(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new InvalidApkError(
      `Archive path does not exist: ${archivePath}`,
      { code: 'INVALID_APK', details: { check: 'exists', path: archivePath } },
    );
  }
  assertArchiveIntegrity(archivePath);
  const entries = listArchiveEntries(archivePath);
  assertSafeEntries(entries);
  return entries;
}

module.exports = {
  validateApkBoundary,
  validateArchiveSafe,
};
