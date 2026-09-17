'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkPlaywrightBrowsers } = require('../../../scripts/check-playwright-browsers');

// Build a fake playwright-core install dir with a browsers.json so the
// pure function doesn't require a real playwright install.
function makeFakePlaywrightCore(revisions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pw-core-'));
  const browsers = Object.entries(revisions).map(([name, revision]) => ({
    name,
    revision,
    browserVersion: '0',
  }));
  fs.writeFileSync(path.join(dir, 'browsers.json'), JSON.stringify({ browsers }));
  return dir;
}

function makeCacheDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pw-cache-'));
}

function markInstalled(cacheDir, browserName, revision) {
  // Playwright normalizes '-' → '_' in the on-disk dir name (the registry
  // applies the same convention), so mirror that here.
  const dir = path.join(cacheDir, `${browserName.replace(/-/g, '_')}-${revision}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'INSTALLATION_COMPLETE'), '');
}

describe('checkPlaywrightBrowsers', () => {
  let cacheDir;
  beforeEach(() => {
    cacheDir = makeCacheDir();
  });

  test('both browsers missing → both reported as MISSING', () => {
    const core = makeFakePlaywrightCore({ chromium: 1208, 'chromium-headless-shell': 1234 });
    const results = checkPlaywrightBrowsers({
      playwrightCoreDir: core, cacheDir, browsers: ['chromium', 'chromium-headless-shell'],
    });
    expect(results).toEqual([
      { name: 'chromium', revision: '1208', installed: false },
      { name: 'chromium-headless-shell', revision: '1234', installed: false },
    ]);
  });

  test('both browsers installed → both reported installed', () => {
    const core = makeFakePlaywrightCore({ chromium: 1208, 'chromium-headless-shell': 1234 });
    markInstalled(cacheDir, 'chromium', 1208);
    markInstalled(cacheDir, 'chromium-headless-shell', 1234);
    const results = checkPlaywrightBrowsers({
      playwrightCoreDir: core, cacheDir, browsers: ['chromium', 'chromium-headless-shell'],
    });
    expect(results).toEqual([
      { name: 'chromium', revision: '1208', installed: true },
      { name: 'chromium-headless-shell', revision: '1234', installed: true },
    ]);
  });

  test('REGRESSION: chromium present at OLD revision only, headless-shell at NEW revision missing', () => {
    // This is the exact failure mode observed in run 35233747307:
    // actions/cache restore-keys brought back a chromium-1208 archive from a
    // previous Playwright version. The previous `find -name 'chrome'`
    // heuristic saw chromium-1208 and skipped the install, leaving
    // chromium_headless_shell-1234 missing. The new check must surface
    // headless-shell as MISSING even though chromium is present.
    const core = makeFakePlaywrightCore({ chromium: 1208, 'chromium-headless-shell': 1234 });
    markInstalled(cacheDir, 'chromium', 1208);
    // No marker for chromium_headless_shell-1234 — that's the bug.
    const results = checkPlaywrightBrowsers({
      playwrightCoreDir: core, cacheDir, browsers: ['chromium', 'chromium-headless-shell'],
    });
    expect(results.find((r) => r.name === 'chromium').installed).toBe(true);
    expect(results.find((r) => r.name === 'chromium-headless-shell').installed).toBe(false);
    expect(results.every((r) => r.installed)).toBe(false);
  });

  test('a chromium binary exists but at the WRONG revision — counts as missing', () => {
    // Belt-and-braces: a partial cache might have *some* chromium directory
    // (without a marker) at an unexpected revision. Even so, the helper
    // checks the EXPECTED revision specifically, not "is there any chrome
    // anywhere".
    const core = makeFakePlaywrightCore({ chromium: 1208, 'chromium-headless-shell': 1234 });
    // Create chromium-1187 dir without a marker (e.g. a leftover from an old run).
    fs.mkdirSync(path.join(cacheDir, 'chromium-1187'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'chromium-1187', 'chrome'), '');
    const results = checkPlaywrightBrowsers({
      playwrightCoreDir: core, cacheDir, browsers: ['chromium', 'chromium-headless-shell'],
    });
    expect(results.find((r) => r.name === 'chromium').installed).toBe(false);
  });

  test('default browsers list when none supplied', () => {
    const core = makeFakePlaywrightCore({ chromium: 1208, 'chromium-headless-shell': 1234 });
    const results = checkPlaywrightBrowsers({ playwrightCoreDir: core, cacheDir });
    expect(results.map((r) => r.name)).toEqual(['chromium', 'chromium-headless-shell']);
  });

  test('unknown browser name → installed=false, revision=null', () => {
    const core = makeFakePlaywrightCore({ chromium: 1208 });
    const results = checkPlaywrightBrowsers({
      playwrightCoreDir: core, cacheDir, browsers: ['chromium', 'firefox'],
    });
    expect(results).toEqual([
      { name: 'chromium', revision: '1208', installed: false },
      { name: 'firefox', revision: null, installed: false },
    ]);
  });

  test('empty browsers list returns empty array', () => {
    const core = makeFakePlaywrightCore({ chromium: 1208 });
    expect(checkPlaywrightBrowsers({ playwrightCoreDir: core, cacheDir, browsers: [] })).toEqual([]);
  });
});
