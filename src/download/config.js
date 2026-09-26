'use strict';

/**
 * config.json loader + lookup helpers for the unified-downloader.
 *
 * Lives next to `cache.js` because both handle local-file state
 * that the downloader wants to inspect synchronously between
 * resolver calls (URL cache, config-driven defaults). Both files
 * are kept side-effect-free at the boundary: `loadConfig(configPath)`
 * reads a file; `loadExistingUrl(packageId, version, configPath)`
 * reads the same config and returns the entry recorded under
 * `download_urls[packageId][version]`. Neither writes.
 *
 * The config shape (`patch_repos`, `download_urls`) is the contract
 * validated by `node scripts/validate-config.js`; this loader trusts
 * that the file is well-formed after the validator has passed it.
 */

const fs = require('node:fs');

/**
 * @param {string} [configPath='./config.json'] Override for the path;
 *                                                 tests pass a tmpfs
 *                                                 fixture.
 * @returns {object} Parsed config, or `{}` when the file is missing
 *                   or unparseable (errors are logged, not thrown,
 *                   so a missing config never blocks a build — the
 *                   downstream code falls back to defaults).
 */
function loadConfig(configPath) {
  const path = configPath === undefined
    ? `${process.cwd()}/config.json`
    : configPath;
  if (!fs.existsSync(path)) return {};
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`Warning: Failed to parse config.json: ${e.message}`);
    return {};
  }
}

/**
 * Look up the configured APK URL for `<packageId>` and `<version>`.
 *
 * The downloader's third source ("configured") sits between the
 * local cache and the apkeep resolver; entries in
 * `config.download_urls[<packageId>]` are treated as authoritative
 * for the version they name. They are not fallbacks and are not
 * used for other versions — the comment in the original
 * implementation: "latest_supported is for a specific old version
 * and cannot be used as a direct download URL for a different
 * version" still holds.
 *
 * @param {string} packageId
 * @param {string} version  Exact version key to look up.
 * @param {string} [configPath]  Forwarded to loadConfig.
 * @returns {string|null} The configured URL string, or null when
 *                        no entry exists for this package/version.
 */
function loadExistingUrl(packageId, version, configPath) {
  const config = loadConfig(configPath);
  const downloadUrls = config.download_urls?.[packageId];
  if (!downloadUrls) return null;

  // Exact-version match only — see header comment.
  if (downloadUrls[version]) {
    console.error(`Found existing URL for version ${version} in config.json`);
    return downloadUrls[version];
  }
  return null;
}

module.exports = {
  loadConfig,
  loadExistingUrl,
};
