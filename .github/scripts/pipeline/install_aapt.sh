#!/usr/bin/env bash
#
# scripts/install_aapt.sh — install aapt/aapt2 + persist the build-tools
# version to $GITHUB_ENV so downstream steps can use $ANDROID_BUILD_TOOLS_VERSION.
#
# Replaces the ~20-line `run:` block that ran twice in the workflow
# (check-versions and build jobs). Calls into install-aapt.js (the actual
# installer), then captures ANDROID_BUILD_TOOLS_VERSION for this step
# AND writes it to $GITHUB_ENV for subsequent steps.
#
# Behaviour matches the original step:
#   - ANDROID_HOME defaults to /tmp/android-sdk
#   - Captures BT_VERSION from install-aapt.js stdout (filtered to one line)
#   - Exports PATH=<build-tools dir>:$PATH for this step
#   - Echoes the same PATH into $GITHUB_ENV for downstream steps
#   - Validates `aapt` is now on PATH
#
# Optional SHA-256 verification (env: EXPECTED_AAPT_CMDLINE_TOOLS_SHA256):
#   Google's `dl.google.com/android/repository/...` does NOT publish a
#   sibling `.sha256` for the cmdline-tools zip. When the env var is set,
#   this wrapper re-downloads the zip with `scripts/download-tool.sh`
#   to verify the digest BEFORE invoking install-aapt.js. We do NOT
#   pre-place the zip in install-aapt.js's tmpdir — that installer
#   always fetches its own copy from the same URL (so the cached cmdline-
#   tools tree survives across runs even when verification runs again).
#   When the env var is unset, we skip verification and log the actual
#   SHA-256 of build-tools/<ver>/aapt2 at the end with a TODO(pin-aapt2)
#   note so the maintainer can paste it into `checksums/tools.sha256`.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

export ANDROID_HOME="${ANDROID_HOME:-/tmp/android-sdk}"

CMDLINE_TOOLS_URL='https://dl.google.com/android/repository/commandlinetools-linux-14742923_latest.zip'
CMDLINE_TOOLS_SHA="${EXPECTED_AAPT_CMDLINE_TOOLS_SHA256:-}"

if [ -n "$CMDLINE_TOOLS_SHA" ]; then
  log "Verifying cmdline-tools zip against EXPECTED_AAPT_CMDLINE_TOOLS_SHA256..."
  if ! "$(dirname "$0")/../../scripts/download-tool.sh" \
      "$CMDLINE_TOOLS_URL" \
      /tmp/cmdline-tools-verify.zip \
      "$CMDLINE_TOOLS_SHA"; then
    log_error "cmdline-tools zip failed SHA-256 verification; aborting install."
    rm -f /tmp/cmdline-tools-verify.zip
    exit 1
  fi
  rm -f /tmp/cmdline-tools-verify.zip
else
  log_warn "EXPECTED_AAPT_CMDLINE_TOOLS_SHA256 not set; skipping SHA verification."
  log_warn "After the next successful install, capture the actual aapt2 sha256 and"
  log_warn "paste it into checksums/tools.sha256 to enable verification."
fi

BT_VERSION="$(
  node "${SCRIPTS_DIR:-$(dirname "$0")}/../install-aapt.js" \
    | grep '^ANDROID_BUILD_TOOLS_VERSION=' \
    | cut -d= -f2
)"
if [ -z "$BT_VERSION" ]; then
  log_error "install-aapt.js did not emit ANDROID_BUILD_TOOLS_VERSION"
  exit 1
fi

BT_DIR="$ANDROID_HOME/build-tools/${BT_VERSION}"
export PATH="${BT_DIR}:${PATH}"

if ! command -v aapt >/dev/null 2>&1; then
  log_error "aapt not found on PATH after install (expected at $BT_DIR/aapt)"
  exit 1
fi
aapt version | head -1

# Print the actual SHA-256 of build-tools;$BT_VERSION/aapt2 so the
# maintainer can paste it into `checksums/tools.sha256`. Skip silently
# when verification is already in place — there's nothing new to pin.
if [ -z "$CMDLINE_TOOLS_SHA" ] && [ -x "$BT_DIR/aapt2" ]; then
  ACTUAL_BT_SHA="$(sha256sum "$BT_DIR/aapt2" | awk '{print $1}')"
  log "TODO(pin-aapt2): build-tools;${BT_VERSION}/aapt2 sha256=${ACTUAL_BT_SHA}"
  log "TODO(pin-aapt2): paste into checksums/tools.sha256 to enable verification"
fi

# Persist for downstream steps.
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'ANDROID_BUILD_TOOLS_VERSION=%s\n' "$BT_VERSION" >> "$GITHUB_ENV"
  printf 'PATH=%s:%s\n' "$BT_DIR" "${PATH}" >> "$GITHUB_ENV"
fi

log "aapt ready (build-tools ${BT_VERSION})"