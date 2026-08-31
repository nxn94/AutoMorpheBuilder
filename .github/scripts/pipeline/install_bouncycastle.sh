#!/usr/bin/env bash
#
# scripts/install_bouncycastle.sh — install the BouncyCastle provider
# JAR used by the signing step to load BKS-format keystores.
#
# Replaces the ~25-line `run:` block in the workflow's "Install
# BouncyCastle" step. Idempotent: if the JAR is already at
# /usr/share/java/bcprov.jar, exit 0.
#
# Behaviour matches the original step:
#   - Download bcprov-jdk18on 1.77 from Maven Central
#   - Copy to /usr/share/java/bcprov.jar (the path keytool resolves)
#   - Print "✓ BouncyCastle downloaded"
#
# Environment:
#   BCOPS_VERSION  (optional) default 1.77
#   BCPROV_PATH    (optional) destination, default /usr/share/java/bcprov.jar
#   TMP_DIR        (optional) download dir, default /tmp/bouncycastle
#
# Uses sudo only if /usr/share/java isn't writable by the current user.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

BCOPS_VERSION="${BCOPS_VERSION:-1.77}"
BCOPS_URL="https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/${BCOPS_VERSION}/bcprov-jdk18on-${BCOPS_VERSION}.jar"
# Maven Central publishes a companion .sha256 file alongside every
# artifact; we fetch it and verify before installing.
BCOPS_SHA256_URL="${BCOPS_URL}.sha256"
BCPROV_PATH="${BCPROV_PATH:-/usr/share/java/bcprov.jar}"
TMP_DIR="${TMP_DIR:-/tmp/bouncycastle}"

if [ -f "$BCPROV_PATH" ]; then
  log "BouncyCastle already present at $BCPROV_PATH"
  exit 0
fi

mkdir -p "$TMP_DIR"
TARGET="$TMP_DIR/bcprov.jar"
SHA_FILE="$TMP_DIR/bcprov.jar.sha256"

log "Downloading BouncyCastle ${BCOPS_VERSION} from Maven Central..."
# Hardened curl: --fail exits non-zero on 4xx/5xx; --max-time /
# --connect-timeout prevent a hung TCP handshake from blocking the
# pipeline; --retry-all-errors covers connection-level failures.
# Outer with_retry layers one more exponential-backoff cycle on top
# of curl's --retry.
with_retry 3 5 curl \
  --fail \
  --location \
  --show-error \
  --silent \
  --connect-timeout 15 \
  --max-time 300 \
  --retry 3 \
  --retry-delay 5 \
  --retry-all-errors \
  --output "$TARGET" \
  "$BCOPS_URL"
with_retry 3 5 curl \
  --fail \
  --location \
  --show-error \
  --silent \
  --connect-timeout 15 \
  --max-time 300 \
  --retry 3 \
  --retry-delay 5 \
  --retry-all-errors \
  --output "$SHA_FILE" \
  "$BCOPS_SHA256_URL"

# The Maven .sha256 file is the bare hash on a single line. Read it,
# compare against the downloaded jar, refuse to install on mismatch.
EXPECTED_SHA="$(awk '{print $1}' "$SHA_FILE")"
log "Verifying BouncyCastle ${BCOPS_VERSION} sha256..."
if ! echo "${EXPECTED_SHA}  ${TARGET}" | sha256sum -c --strict >/dev/null 2>&1; then
  log_error "BouncyCastle sha256 mismatch — refusing to install."
  log_error "Expected: ${EXPECTED_SHA}"
  log_error "Got:      $(sha256sum "${TARGET}" | awk '{print $1}')"
  rm -f "${TARGET}" "${SHA_FILE}"
  exit 1
fi

mkdir -p "$(dirname "$BCPROV_PATH")"
if [ -w "$(dirname "$BCPROV_PATH")" ]; then
  cp "$TARGET" "$BCPROV_PATH"
else
  if ! command -v sudo >/dev/null 2>&1; then
    log_error "Cannot write $(dirname "$BCPROV_PATH") and sudo is unavailable."
    exit 1
  fi
  sudo cp "$TARGET" "$BCPROV_PATH"
fi

log "BouncyCastle installed at $BCPROV_PATH"