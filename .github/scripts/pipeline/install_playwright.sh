#!/usr/bin/env bash
#
# scripts/install_playwright.sh — install Playwright Chromium and smoke-
# test the resulting browser.
#
# Replaces the inline blocks in the workflow's "Install Playwright
# browsers" and "Smoke-test Playwright Chromium" steps. The download
# itself is delegated to install-playwright-browsers.js (an existing
# focused tool); this script is a thin shim that:
#   1. Runs the installer with the right GCS mirror env var + the cft
#      path patch.
#   2. Restores execute permissions lost during artifact upload/download.
#   3. Smoke-tests the browser by launching headless and printing the UA.
#
# Steps are best-effort: the unified-downloader has non-Playwright
# fallback paths (apkeep + apkmirror-api), so a broken Playwright
# doesn't fail the build. Failures are surfaced as ::warning::.
#
# Environment:
#   PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST  optional  override download host
#                                       (default: chrome-for-testing GCS bucket)

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"

PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST="${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST:-https://storage.googleapis.com/chrome-for-testing-public}"
export PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST

# --- install if missing ---------------------------------------------------

SCRIPTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

needs_install=true
if [ -d "$CACHE_DIR" ]; then
  if find "$CACHE_DIR" -name 'chrome' 2>/dev/null | grep -q . \
     || find "$CACHE_DIR" -name 'chrome-headless-shell' 2>/dev/null | grep -q .; then
    needs_install=false
  fi
fi

if [ "$needs_install" = true ]; then
  log "Installing Playwright Chromium (best-effort)..."
  set +e
  NODE_OPTIONS="--require=${SCRIPTS_DIR}/patch-playwright-cft-path.js" \
    timeout 300 node "${SCRIPTS_DIR}/install-playwright-browsers.js"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log_warn "playwright install failed (rc=$rc); APKMirror Playwright fallback will be unavailable."
  fi
fi

# --- restore execute bits -------------------------------------------------

if [ -d "$CACHE_DIR" ]; then
  find "$CACHE_DIR" -type f -exec chmod +x {} + 2>/dev/null || true
fi

# --- smoke test -----------------------------------------------------------

if [ -d "$CACHE_DIR" ] && find "$CACHE_DIR" -name 'chrome' 2>/dev/null | grep -q .; then
  log "Smoke-testing Playwright Chromium..."
  set +e
  node -e '
    const { chromium } = require("playwright");
    (async () => {
      const t0 = Date.now();
      const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
      });
      const page = await browser.newPage();
      const ua = await page.evaluate(() => navigator.userAgent);
      console.log("Chromium launched OK in", Date.now() - t0, "ms, UA:", ua);
      await browser.close();
    })().catch((e) => { console.error("Chromium smoke-test FAILED:", e.message); process.exit(1); });
  '
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log_warn "Chromium smoke-test failed; downstream Playwright fallback path may be unavailable."
  fi
else
  log_warn "Chromium not installed; skipping smoke test."
fi