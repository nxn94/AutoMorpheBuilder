#!/usr/bin/env bash
# Install Android build-tools and persist their version/PATH for later steps.
# install-aapt.js verifies the exact cmdline-tools ZIP before extracting it
# when EXPECTED_AAPT_CMDLINE_TOOLS_SHA256 is configured.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

export ANDROID_HOME="${ANDROID_HOME:-/tmp/android-sdk}"

CMDLINE_TOOLS_SHA="${EXPECTED_AAPT_CMDLINE_TOOLS_SHA256:-}"

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