#!/usr/bin/env bash
# Install Playwright-pinned browsers and smoke-test Chromium.
# Per-revision markers make installation idempotent. Optional archive pins
# EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256 and EXPECTED_PLAYWRIGHT_HEADLESS_SHA256
# are verified by the installer before extraction; pin failures are fatal.
# Without pins, browser setup remains best-effort for other download sources.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"

PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST="${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST:-https://storage.googleapis.com/chrome-for-testing-public}"
export PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST

SCRIPTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

# --- install (always; install-playwright-browsers.js is per-browser idempotent) ---
#
# install-playwright-browsers.js reads playwright-core/browsers.json for the
# expected revision of each browser it was asked to install and skips any
# browser whose INSTALLATION_COMPLETE marker is already present at the
# expected cache dir. Running unconditionally is the only safe posture when
# actions/cache is in play: a stale partial archive can match one browser
# (e.g. chromium-1208) without matching another (chromium_headless_shell-1234),
# and there is no need_install=false branch that correctly describes that
# state. Always re-run; the per-browser marker check makes the no-op case free.

log "Syncing Playwright browsers (per-revision INSTALLATION_COMPLETE markers)..."
set +e
NODE_OPTIONS="--require=${SCRIPTS_DIR}/patch-playwright-cft-path.js" \
  timeout 300 node "${SCRIPTS_DIR}/install-playwright-browsers.js"
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  if [ -n "${EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256:-}${EXPECTED_PLAYWRIGHT_HEADLESS_SHA256:-}" ]; then
    log_error "Pinned browser installation failed (rc=$rc)."
    exit "$rc"
  fi
  log_warn "playwright install failed (rc=$rc); APKMirror Playwright fallback will be unavailable."
fi

# --- log actual sha256 + smoke test ---------------------------------------

if [ -z "${EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256:-}" ] && [ -d "$CACHE_DIR" ]; then
  chrome_bin="$(find "$CACHE_DIR" -name chrome -type f 2>/dev/null | head -n1 || true)"
  if [ -n "$chrome_bin" ]; then
    actual_sha="$(sha256sum "$chrome_bin" | awk '{print $1}')"
    log "TODO(pin-chromium): ${chrome_bin} sha256=${actual_sha}"
    log "TODO(pin-chromium): paste into checksums/tools.sha256 to enable verification"
  fi
fi

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