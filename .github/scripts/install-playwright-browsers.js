#!/usr/bin/env node
'use strict';

/**
 * Custom Playwright browser installer for CI.
 *
 * Why this exists:
 *   `npx playwright install chromium` on Playwright ≥1.58 uses a yauzl-based
 *   extraction in a forked child process (oopDownloadBrowserMain.js) and the
 *   pipeline from yauzl's read stream into fs.createWriteStream never emits
 *   'finish' / 'close' on modern Node — the child hangs after extracting a
 *   handful of entries until the workflow's 5-min timeout kills it. The result
 *   is a half-installed browser (no chrome binary, no INSTALLATION_COMPLETE
 *   marker) and a failed smoke test.
 *
 *   This installer does the same thing the broken Playwright installer does,
 *   but with two well-known-working primitives:
 *     - `curl` for the download (rewritten URL via the cft-path patch).
 *     - `unzip` for the extraction (system Info-ZIP, ~3s for the full zip).
 *
 *   On Playwright ≥1.62 the `playwright-core` `exports` field no longer
 *   exposes `lib/server/registry/index`, so we cannot use Playwright's own
 *   `_downloadURLs` helper. We derive the URL from the version pinned in
 *   `playwright-core/browsers.json` (which IS on disk and is part of the
 *   published package) — the chrome-for-testing URL pattern is
 *   `${baseUrl}/${browserVersion}/linux64/${name}-linux64.zip`, identical
 *   to what Playwright uses internally.
 *
 * Usage:
 *   PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST=https://storage.googleapis.com/chrome-for-testing-public \
 *     node .github/scripts/install-playwright-browsers.js chromium chromium-headless-shell
 *
 * The install location matches Playwright's expectation:
 *   $HOME/.cache/ms-playwright/<name>-<revision>/<unzipped>/...
 *
 * Writes INSTALLATION_COMPLETE in each browser directory, which is the marker
 * Playwright uses to skip re-installing.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// browsers.json is *not* in playwright-core's exports map, so read it from
// disk directly. It is the source of truth for the revision + browserVersion
// each `npx playwright install <name>` would download.
const PLAYWRIGHT_CORE_DIR = path.dirname(require.resolve('playwright-core/package.json'));
const BROWSERS_JSON_PATH = path.join(PLAYWRIGHT_CORE_DIR, 'browsers.json');

// Reflect Playwright's own expectation: $XDG_CACHE_HOME/$HOME/.cache/ms-playwright
const CACHE_DIR = process.env.PLAYWRIGHT_BROWSERS_PATH
  || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');

// PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST is the chrome-for-testing bucket prefix.
// Playwright's default URL template is `${baseUrl}/builds/cft/${browserVersion}/${suffix}`;
// the public chrome-for-testing bucket serves `${browserVersion}/${suffix}` (no
// `builds/cft/` prefix), hence `patch-playwright-cft-path.js` when the CLI
// installer is used. We construct the public URL directly, no patch needed.
const CFT_BASE_URL = (process.env.PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST || 'https://storage.googleapis.com/chrome-for-testing-public').replace(/\/$/, '');

/**
 * Look up the revision + browserVersion for a browser name in
 * playwright-core/browsers.json. We don't use the registry because
 * playwright-core's `exports` no longer exposes `lib/server/registry/index`
 * on Playwright ≥1.62.
 */
function lookupBrowser(name) {
  const descriptors = JSON.parse(fs.readFileSync(BROWSERS_JSON_PATH, 'utf8')).browsers;
  const d = descriptors.find((b) => b.name === name);
  if (!d) throw new Error(`Unknown browser: ${name}`);
  return { name: d.name, revision: d.revision, browserVersion: d.browserVersion };
}

/**
 * Compute the public chrome-for-testing download URL for a given
 * (name, browserVersion) pair. The URL pattern is:
 *   ${baseUrl}/${browserVersion}/linux64/${name}-linux64.zip
 * which is what Playwright's own `_downloadURLs` returns after the
 * `builds/cft/` patch strips its prefix.
 */
function buildDownloadURL(name, browserVersion) {
  // 'chromium' and 'chromium-headless-shell' map to chrome-linux64 / chrome-headless-shell-linux64
  const archiveBase = name === 'chromium-headless-shell' ? 'chrome-headless-shell-linux64' : 'chrome-linux64';
  return `${CFT_BASE_URL}/${browserVersion}/linux64/${archiveBase}.zip`;
}

/**
 * Run `unzip -q -o` and surface stderr if it fails. Returns the path to the
 * extracted top-level directory inside `destDir` (the single folder in the
 * zip — chromium zips always have one).
 */
function unzip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // unzip to stderr — surface the last 1KB to keep error messages sane
    const stderr = (e.stderr || Buffer.alloc(0)).toString().slice(-1024);
    throw new Error(`unzip failed for ${zipPath}: ${stderr || e.message}`, { cause: e });
  }
  // The chromium / headless-shell zips contain a single top-level directory
  // (chrome-linux64 / chrome-headless-shell-linux64). Find it.
  const entries = fs.readdirSync(destDir);
  const topLevel = entries.find((e) => fs.statSync(path.join(destDir, e)).isDirectory());
  if (!topLevel) throw new Error(`No top-level directory in ${zipPath} after unzip`);
  return path.join(destDir, topLevel);
}

/**
 * Download with curl. The chromium zip is ~170 MiB, the headless-shell
 * zip is ~110 MiB, so use a generous socket timeout and follow redirects.
 * Returns the local path.
 */
function download(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  execFileSync('curl', [
    '-fSL', '--retry', '3', '--retry-delay', '2',
    '--connect-timeout', '30', '--max-time', '300',
    '-o', destPath,
    url,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stat = fs.statSync(destPath);
  if (stat.size < 1_000_000) {
    throw new Error(`Downloaded ${url} is suspiciously small (${stat.size} bytes)`);
  }
  return destPath;
}

function install(name) {
  const { revision, browserVersion } = lookupBrowser(name);
  // Playwright normalizes the on-disk dir name by replacing '-' with '_' in
  // the browser name (the registry applies that same convention).
  const targetDir = path.join(CACHE_DIR, `${name.replace(/-/g, '_')}-${revision}`);

  const marker = path.join(targetDir, 'INSTALLATION_COMPLETE');
  if (fs.existsSync(marker)) {
    console.error(`[install] ${name} r${revision} already installed (${marker} present)`);
    return;
  }

  const url = buildDownloadURL(name, browserVersion);
  console.error(`[install] ${name} r${revision} (chrome ${browserVersion}) -> ${url}`);

  // Wipe any partial install from a previous failed run.
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true });

  // Download into a tmp file alongside the target dir (same filesystem → fast rename).
  const tmpZip = path.join(targetDir, `__download.zip`);
  const t0 = Date.now();
  try {
    download(url, tmpZip);
    console.error(`[install] ${name} downloaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const t1 = Date.now();
    unzip(tmpZip, targetDir);
    console.error(`[install] ${name} extracted in ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  } finally {
    // Clean up the zip regardless of success/failure
    try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }
  }

  // The chromium zip extracts to <dir>/chrome-linux64/{chrome, chrome-headless-shell}, ...
  // Validate the expected executable exists, then chmod +x (artifact upload
  // strips the exec bit — same as the post-install step in
  // install_playwright.sh does for the whole cache tree).
  const expectedExec = path.join(targetDir,
    name === 'chromium-headless-shell' ? 'chrome-headless-shell-linux64/chrome-headless-shell' : 'chrome-linux64/chrome');
  try {
    fs.chmodSync(expectedExec, 0o755);
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw new Error(`Expected ${expectedExec} after extraction, but it's missing`, { cause: e });
    }
    throw e;
  }

  // Mark install complete (Playwright's marker convention)
  // codeql[js/file-system-race] reason: marker path is constructed
  // by Playwright in targetDir (user-owned); the file is a zero-byte
  // sentinel, not attacker-controlled content.
  fs.writeFileSync(marker, '');
  console.error(`[install] ${name} r${revision} installed at ${targetDir}`);
}

function main() {
  const requested = process.argv.slice(2);
  if (requested.length === 0) {
    // Default: install the two browsers the workflow actually uses
    requested.push('chromium', 'chromium-headless-shell');
  }

  for (const name of requested) {
    install(name);
  }
  console.error('[install] All done');
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error(`[install] FAILED: ${e.message}`);
    process.exit(1);
  }
}
