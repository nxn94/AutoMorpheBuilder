#!/usr/bin/env node

/**
 * Update download URLs in config.json
 * Usage: node update-download-urls.js <package_id> <version> <url>
 */

const fs = require('fs');
const path = require('path');

function main() {
  const args = process.argv.slice(2);

  if (args.length !== 3) {
    console.log(JSON.stringify({
      success: false,
      error: 'Usage: node update-download-urls.js <package_id> <version> <url>'
    }, null, 2));
    process.exit(1);
  }

  const [packageId, version, url] = args;
  // Scrub CR/LF before any of these values touch config.json or
  // $GITHUB_OUTPUT. The downloader URLs are first-party today, but
  // versions come from upstream release tags — defense-in-depth
  // against a hostile or malformed tag.
  const scrub = (s) => String(s).replace(/[\r\n]/g, '');
  const safePackageId = scrub(packageId);
  const safeVersion = scrub(version);
  const safeUrl = scrub(url);
  const configPath = path.join(process.cwd(), 'config.json');

  try {
    let config;
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(content);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(JSON.stringify({
          success: false,
          error: 'config.json not found in current directory'
        }, null, 2));
        process.exit(1);
      }
      throw err;
    }

    // Initialize download_urls if needed
    if (!config.download_urls) {
      config.download_urls = {};
    }
    if (!config.download_urls[safePackageId]) {
      config.download_urls[safePackageId] = {};
    }

    const pinVersion = config.patch_repos?.[safePackageId]?.pin_version;
    if (pinVersion) {
      console.log(JSON.stringify({
        success: true,
        skipped: true,
        reason: `pin_version is set for ${safePackageId} (${pinVersion}) — skipping URL update`
      }, null, 2));
      return;
    }

    // Update the URL for the specific version and latest_supported
    config.download_urls[safePackageId][safeVersion] = safeUrl;
    config.download_urls[safePackageId].latest_supported = safeUrl;

    // Prune stale per-version entries. We only ever consume
    // .download_urls[pkg].latest_supported at build time (morphe-build.yml
    // uses the shortcut key, not the per-version key), so older per-version
    // entries are dead weight. Keep the entry we just wrote plus
    // latest_supported; drop the rest. This also matches the
    // "no longer used" intent — once a new version supersedes an old one,
    // its cached URL is no longer needed.
    const STALE_KEYS = Object.keys(config.download_urls[safePackageId]).filter(
      k => k !== safeVersion && k !== 'latest_supported'
    );
    for (const k of STALE_KEYS) {
      delete config.download_urls[safePackageId][k];
    }
    if (STALE_KEYS.length > 0) {
      console.error(`Pruned ${STALE_KEYS.length} stale download_urls entries for ${safePackageId}: ${STALE_KEYS.join(', ')}`);
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');

    console.log(JSON.stringify({
      success: true,
      packageId: safePackageId,
      version: safeVersion,
      url: safeUrl
    }, null, 2));

  } catch (err) {
    console.log(JSON.stringify({
      success: false,
      error: err.message
    }, null, 2));
    process.exit(1);
  }
}

main();
