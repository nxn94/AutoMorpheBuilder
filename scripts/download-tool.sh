#!/usr/bin/env bash
#
# download-tool.sh — generic SHA-256-verified downloader.
#
# Usage: scripts/download-tool.sh <URL> <OUTPUT_PATH> <EXPECTED_SHA256>
#
# Fails closed: if the computed SHA does not match the expected value,
# the file is removed and the script exits non-zero with a ::error::
# annotation suitable for GitHub Actions.
#
# Curl flags mirror `install_apkeep.sh`:
#   --fail           exit non-zero on 4xx/5xx (404 aborts immediately)
#   --location       follow redirects
#   --show-error     surface non-200 errors
#   --silent         no progress bar (so logs stay greppable)
#   --connect-timeout / --max-time  cap handshake / total duration
#   --retry + --retry-delay + --retry-all-errors  retry transient
#                                  connection-level failures
#
# Usage in scripts:
#   scripts/download-tool.sh "$URL" "$OUTPUT" "$EXPECTED_SHA256"

set -euo pipefail

readonly URL="${1:?Usage: download-tool.sh <URL> <OUTPUT_PATH> <EXPECTED_SHA256>}"
readonly OUTPUT="${2:?Output path required}"
readonly EXPECTED_SHA256="${3:?Expected SHA-256 required}"

mkdir -p "$(dirname "$OUTPUT")"

curl \
  --fail \
  --location \
  --show-error \
  --silent \
  --connect-timeout 15 \
  --max-time 300 \
  --retry 3 \
  --retry-delay 5 \
  --retry-all-errors \
  --output "$OUTPUT" \
  "$URL"

readonly ACTUAL_SHA256="$(sha256sum "$OUTPUT" | awk '{print $1}')"

if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "::error file=$OUTPUT::Downloaded file checksum mismatch"
  echo "Expected: $EXPECTED_SHA256"
  echo "Actual:   $ACTUAL_SHA256"
  rm -f "$OUTPUT"
  exit 1
fi

echo "Verified SHA-256 for $OUTPUT"