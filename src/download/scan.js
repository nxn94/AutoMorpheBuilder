'use strict';

/**
 * Output-directory scanning helpers extracted from
 * `.github/scripts/unified-downloader.js`.
 *
 * `findApkFile(outputDir)` returns the first file in
 * `outputDir` whose extension is one of `.apk`/`.xapk`/`.apkm`,
 * or `null` when the directory is missing or empty of matching
 * files. It does NOT descend into subdirectories — the
 * downloader always writes APKs into a flat APKS_DIR, and a
 * recursive scan would surprise callers that pre-stage
 * intermediate artifacts in subfolders.
 *
 * Pure fs + string operations, no network, no child_process.
 */

const fs = require('node:fs');
const path = require('node:path');

const APK_EXTENSIONS = ['.apk', '.xapk', '.apkm'];

/**
 * @param {string} outputDir
 * @param {object} [opts]
 * @param {(dir: string) => string[]} [opts.readdir] Override for
 *   fs.readdirSync. Tests pass a stub that returns a canned
 *   list of names without needing a tmp dir on disk.
 * @param {(dir: string) => boolean} [opts.exists] Override for
 *   fs.existsSync. Default uses the real fs.existsSync.
 * @returns {string|null} Absolute path to the first matching
 *   file, or null when no match.
 */
function findApkFile(outputDir, opts = {}) {
  const exists = opts.exists || fs.existsSync;
  const readdir = opts.readdir || fs.readdirSync;

  if (!exists(outputDir)) {
    return null;
  }
  const files = readdir(outputDir);

  for (const file of files) {
    const lower = file.toLowerCase();
    for (const ext of APK_EXTENSIONS) {
      if (lower.endsWith(ext)) {
        return path.join(outputDir, file);
      }
    }
  }
  return null;
}

module.exports = {
  findApkFile,
  APK_EXTENSIONS,
};
