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
# Optional SHA-256 verification (env: EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256):
#   chrome-for-testing does NOT publish a sibling .sha256 for
#   chrome-linux64.zip. When EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256 is set,
#   this wrapper re-downloads the same URL via scripts/download-tool.sh
#   to verify the digest BEFORE invoking install-playwright-browsers.js.
#   We verify once per cache-miss; subsequent runs (browser already on
#   disk) skip the download entirely. When the env var is unset, we
#   log the actual SHA-256 of the installed chrome binary at the end
#   with a TODO(pin-chromium) note so the maintainer can paste it into
#   `checksums/tools.sha256`.
#
# Environment:
#   PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST  optional  override download host
#                                       (default: chrome-for-testing GCS bucket)
#   EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256  optional  pin the chromium zip hash

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"

PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST="${PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST:-https://storage.googleapis.com/chrome-for-testing-public}"
export PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST

SCRIPTS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CACHE_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"

needs_install=true
if [ -d "$CACHE_DIR" ]; then
  if find "$CACHE_DIR" -name 'chrome' 2>/dev/null | grep -q . \
     || find "$CACHE_DIR" -name 'chrome-headless-shell' 2>/dev/null | grep -q .; then
    needs_install=false
  fi
fi

# --- optional SHA-256 verification (only when we'd actually download) -------

if [ "$needs_install" = true ] && [ -n "${EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256:-}" ]; then
  log "Verifying chrome-linux64.zip against EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256..."
  # Playwright's own _downloadURLs isn't reachable from this shell script
  # without booting Node, so use the chrome-for-testing last-known-good
  # manifest as a deterministic URL source. The CDN URL changes per
  # Chromium version; the manifest always points at the current stable.
  manifest_url='https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
  chromium_url="$(
    curl --fail --silent --show-error --max-time 60 "$manifest_url" \
      | jq -r '.channels.Stable.downloads.chrome[] | select(.platform == "linux64") | .url' \
      2>/dev/null \
      | head -n1 || true
  )"
  if [ -z "$chromium_url" ]; then
    log_warn "Could not resolve chrome-for-testing stable linux64 URL; skipping SHA verification."
  else
    if ! "$(dirname "$0")/../../scripts/download-tool.sh" \
        "$chromium_url" \
        /tmp/chrome-linux64-verify.zip \
        "$EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256"; then
      log_warn "chrome-linux64.zip SHA-256 mismatch; install will still proceed (best-effort)."
    fi
    rm -f /tmp/chrome-linux64-verify.zip
  fi
elif [ "$needs_install" = true ]; then
  log_warn "EXPECTED_PLAYWRIGHT_CHROMIUM_SHA256 not set; skipping SHA verification."
  log_warn "After the next successful install, capture the actual chrome sha256 and"
  log_warn "paste it into checksums/tools.sha256 to enable verification."
fi

# --- install if missing ---------------------------------------------------

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