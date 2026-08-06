#!/usr/bin/env bash
#
# scripts/install_apkeep.sh — install the apkeep binary used for
# downloading APKs from APKPure.
#
# Replaces the ~7-line `run:` block in the workflow's "Install apkeep"
# step. Idempotent: if /usr/local/bin/apkeep already exists, the
# version check is run and the script exits 0.
#
# Behaviour matches the original step:
#   - Download apkeep 0.18.0 from EFForg/apkeep releases
#   - Place at /usr/local/bin/apkeep
#   - chmod +x
#   - Print `apkeep --version`
#
# Environment:
#   APKEEP_VERSION  (optional) override the version, default 0.18.0
#   APKEEP_PATH     (optional) install location, default /usr/local/bin/apkeep
#
# Uses sudo only if the install path is not writable by the current user.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

APKEEP_VERSION="${APKEEP_VERSION:-0.18.0}"
APKEEP_PATH="${APKEEP_PATH:-/usr/local/bin/apkeep}"
APKEEP_URL="https://github.com/EFForg/apkeep/releases/download/${APKEEP_VERSION}/apkeep-x86_64-unknown-linux-gnu"

# Pinned SHA-256 of apkeep-${APKEEP_VERSION}-x86_64-unknown-linux-gnu.
# apkeep does not publish a .sha256 file alongside the binary, so the
# hash is embedded in the script. Update this together with APKEEP_VERSION.
# Generated with: curl -fsSL "$APKEEP_URL" | sha256sum
APKEEP_SHA256="c1e89d5cad5852bdbec44617c56fcf0fbd12edfd4bfd9f399f8e852f0b3bee27"

if [ -x "$APKEEP_PATH" ]; then
  "$APKEEP_PATH" --version || true
  exit 0
fi

# Pick a writable target. If the default path isn't writable as the
# current user, try sudo (works on self-hosted runners; on ubuntu-latest
# GH runners the runner user can already write /usr/local/bin).
TMP_INSTALL="$(mktemp)"
log "Downloading apkeep ${APKEEP_VERSION}..."
with_retry 3 5 curl -fsSL -o "$TMP_INSTALL" "$APKEEP_URL"
chmod +x "$TMP_INSTALL"

# Verify the download matches the pinned hash before installing.
# Refuse to proceed on mismatch — a compromised upstream would land
# arbitrary code on the runner.
log "Verifying apkeep ${APKEEP_VERSION} sha256..."
if ! echo "${APKEEP_SHA256}  ${TMP_INSTALL}" | sha256sum -c --strict >/dev/null 2>&1; then
  log_error "apkeep sha256 mismatch — refusing to install."
  log_error "Expected: ${APKEEP_SHA256}"
  log_error "Got:      $(sha256sum "${TMP_INSTALL}" | awk '{print $1}')"
  rm -f "${TMP_INSTALL}"
  exit 1
fi

if [ -w "$(dirname "$APKEEP_PATH")" ]; then
  mv "$TMP_INSTALL" "$APKEEP_PATH"
else
  if ! command -v sudo >/dev/null 2>&1; then
    log_error "Cannot write $(dirname "$APKEEP_PATH") and sudo is unavailable."
    exit 1
  fi
  sudo mv "$TMP_INSTALL" "$APKEEP_PATH"
  sudo chmod +x "$APKEEP_PATH"
fi

"$APKEEP_PATH" --version
log "apkeep installed at $APKEEP_PATH"