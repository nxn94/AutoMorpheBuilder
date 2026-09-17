#!/usr/bin/env node
//
// scripts/check-playwright-browsers.js
//
// Revision-aware companion to scripts/install-playwright-browsers.js. For
// each expected browser it looks up the expected revision in
// playwright-core/browsers.json and reports whether the corresponding
// INSTALLATION_COMPLETE marker is present at
// `<cacheDir>/<name-with-underscores>-<revision>/`.
//
// Used by .github/scripts/pipeline/install_playwright.sh to drive the
// optional SHA verification (only re-fetch chrome-linux64.zip when at
// least one expected browser is missing) and to log which browser(s)
// actually need installing. Exits 0 when ALL expected browsers are
// present, non-zero otherwise — the bash wrapper reads the exit code.
//
// Pure function checkPlaywrightBrowsers is exported for Jest.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function findPlaywrightCoreDir() {
  try {
    return path.dirname(require.resolve('playwright-core/package.json'));
  } catch {
    throw new Error('playwright-core is not installed; cannot resolve browsers.json');
  }
}

function findCacheDir() {
  return process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

/**
 * Look up the expected revision for each requested browser name in
 * playwright-core/browsers.json and report whether its INSTALLATION_COMPLETE
 * marker is present in the cache. Pure: only reads files, no writes.
 *
 * @param {object} [args]
 * @param {string} [args.playwrightCoreDir]  playwright-core install root (default: resolve from require)
 * @param {string} [args.cacheDir]          override PLAYWRIGHT_BROWSERS_PATH / $HOME/.cache/ms-playwright
 * @param {string[]} [args.browsers]         browser names to check (default: chromium, chromium-headless-shell)
 * @returns {Array<{name: string, revision: (string|null), installed: boolean}>}
 *   revision is null when the name isn't in playwright-core's browsers.json.
 */
function checkPlaywrightBrowsers({ playwrightCoreDir, cacheDir, browsers } = {}) {
  const coreDir = playwrightCoreDir || findPlaywrightCoreDir();
  const cache = cacheDir || findCacheDir();
  const names = browsers || ['chromium', 'chromium-headless-shell'];

  const descriptors = JSON.parse(fs.readFileSync(path.join(coreDir, 'browsers.json'), 'utf8')).browsers;

  return names.map((name) => {
    const d = descriptors.find((b) => b.name === name);
    if (!d) return { name, revision: null, installed: false };
    const dir = path.join(cache, `${name.replace(/-/g, '_')}-${d.revision}`);
    const marker = path.join(dir, 'INSTALLATION_COMPLETE');
    return { name, revision: String(d.revision), installed: fs.existsSync(marker) };
  });
}

module.exports = { checkPlaywrightBrowsers, findPlaywrightCoreDir, findCacheDir };

if (require.main === module) {
  let results;
  try {
    results = checkPlaywrightBrowsers();
  } catch (e) {
    console.error(`[check-playwright-browsers] FAILED: ${e.message}`);
    process.exit(2);
  }
  for (const r of results) {
    console.log(`${r.name}@${r.revision ?? '?'}: ${r.installed ? 'installed' : 'MISSING'}`);
  }
  process.exit(results.every((r) => r.installed) ? 0 : 1);
}
