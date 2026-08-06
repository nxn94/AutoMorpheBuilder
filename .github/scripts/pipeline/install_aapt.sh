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
# The install-aapt.js script is unchanged; this wrapper is a thin shim
# to keep the YAML steps readable.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

export ANDROID_HOME="${ANDROID_HOME:-/tmp/android-sdk}"

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

# Persist for downstream steps.
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'ANDROID_BUILD_TOOLS_VERSION=%s\n' "$BT_VERSION" >> "$GITHUB_ENV"
  printf 'PATH=%s:%s\n' "$BT_DIR" "${PATH}" >> "$GITHUB_ENV"
fi

log "aapt ready (build-tools ${BT_VERSION})"