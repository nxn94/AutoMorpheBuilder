'use strict';

/**
 * Reject archive entry names that would escape the extraction target
 * directory. Called by every code path that unpacks a downloaded
 * archive (apkeep's apkm, apkmirror's xapk/apkm/apks bundles, the
 * split-package merger).
 *
 * Throws on:
 *   - absolute paths (e.g. `/etc/passwd`)
 *   - `..` traversal segments (e.g. `../secret`, `safe/../../secret`)
 *
 * Returns the normalized POSIX path on success.
 */

const path = require('node:path');

function assertSafeArchiveEntry(entryName) {
  if (typeof entryName !== 'string' || entryName.length === 0) {
    throw new Error(`Archive entry name must be a non-empty string: ${JSON.stringify(entryName)}`);
  }

  if (path.isAbsolute(entryName)) {
    throw new Error(`Archive contains absolute path: ${entryName}`);
  }

  const normalized = path.posix.normalize(entryName);

  if (
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new Error(`Archive contains path traversal: ${entryName}`);
  }

  return normalized;
}

module.exports = {
  assertSafeArchiveEntry,
};