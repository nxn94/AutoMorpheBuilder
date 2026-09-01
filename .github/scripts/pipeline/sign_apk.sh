#!/usr/bin/env bash
#
# scripts/sign_apk.sh — sign every APK in $INPUT_DIR with apksigner.
#
# This script is the ONLY script in the build pipeline that consumes
# signing secrets (KEYSTORE_BASE64 / KEYSTORE_PASSWORD / KEY_ALIAS /
# KEY_PASSWORD). It runs exclusively in the `sign` workflow job, which
# is gated by the `signing` GitHub environment so the secrets are not
# visible to the untrusted-input jobs (download / patch).
#
# Behaviour:
#   1. Iterate every *.apk file under $INPUT_DIR (the unsigned APKs
#      uploaded by the `build` job).
#   2. For each, sign in place using the PKCS12 keystore produced by
#      prepare_keystore.sh (`$P12_FILE`). apksigner rewrites the APK
#      so the unsigned → signed transition is just an in-place rewrite.
#   3. Run `apksigner verify --print-certs` after signing — catches:
#        - silent signing failures (apksigner exits 0 in some edge cases
#          even when no signature was applied)
#        - signing-cert drift: when EXPECTED_CERT_SHA256 is set, the
#          actual cert SHA-256 of the signed APK must match (case-
#          insensitive hex). This pins the build to a specific keystore
#          so a leaked signing key triggers an immediate hard-fail.
#   4. Copy each signed APK to $OUTPUT_DIR (the create-release job
#      downloads from there). The directory is the only thing the
#      create-release step needs to see.
#
# Environment:
#   INPUT_DIR       required  dir of unsigned APKs (download-artifact dest)
#   OUTPUT_DIR      required  dir to copy signed APKs to (upload-artifact src)
#   P12_FILE        required  PKCS12 keystore (prepare_keystore.sh p12_path)
#   KEY_ALIAS       required  signing key alias
#   KEYSTORE_PASSWORD required  keystore password (used as -ksPass)
#   KEY_ENTRY_PASS  optional  key entry password (defaults to KEYSTORE_PASSWORD)
#   BT_DIR          optional  explicit build-tools dir (preferred); falls
#                               back to PATH lookup if unset
#   ANDROID_HOME    optional  used with ANDROID_BUILD_TOOLS_VERSION to
#                    auto-locate apksigner when BT_DIR is unset
#   ANDROID_BUILD_TOOLS_VERSION optional  see BT_DIR
#   EXPECTED_CERT_SHA256 optional  pin the signing cert fingerprint;
#                                  when set, the actual cert SHA-256 of
#                                  the signed APK must match
#                                  (case-insensitive). When unset, the
#                                  comparison is skipped with a
#                                  ::warning:: annotation.
#
# This script MUST NOT run in a job that has not been gated by the
# `signing` GitHub environment. The four secret env vars are required
# inputs; their absence is a hard error.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"

INPUT_DIR="${INPUT_DIR:-}"
OUTPUT_DIR="${OUTPUT_DIR:-}"
P12_FILE="${P12_FILE:-}"
KEY_ALIAS="${KEY_ALIAS:-}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-}"
KEY_ENTRY_PASS="${KEY_ENTRY_PASS:-$KEYSTORE_PASSWORD}"
BT_DIR_CACHED="${BT_DIR:-}"
EXPECTED_CERT_SHA256="${EXPECTED_CERT_SHA256:-}"

for var in INPUT_DIR OUTPUT_DIR P12_FILE KEY_ALIAS KEYSTORE_PASSWORD; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

if [ ! -d "$INPUT_DIR" ]; then
  log_error "INPUT_DIR does not exist or is not a directory: $INPUT_DIR"
  exit 1
fi

if [ ! -f "$P12_FILE" ]; then
  log_error "PKCS12 keystore not found: $P12_FILE"
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Locate apksigner. Prefer $BT_DIR (set by install_aapt.sh), fall back
# to $ANDROID_HOME/build-tools/<ver>/, fall back to PATH.
if [ -z "$BT_DIR_CACHED" ] && [ -n "${ANDROID_HOME:-}" ] && [ -n "${ANDROID_BUILD_TOOLS_VERSION:-}" ]; then
  BT_DIR_CACHED="$ANDROID_HOME/build-tools/${ANDROID_BUILD_TOOLS_VERSION}"
fi
if [ -n "$BT_DIR_CACHED" ] && [ -x "$BT_DIR_CACHED/apksigner" ]; then
  APKSIGNER="$BT_DIR_CACHED/apksigner"
else
  APKSIGNER="$(command -v apksigner || true)"
fi

if [ -z "$APKSIGNER" ]; then
  log_error "apksigner not found on runner (BT_DIR=$BT_DIR_CACHED; PATH lookup failed)."
  exit 1
fi

log "Using apksigner: $APKSIGNER"

# --- sign each APK --------------------------------------------------------

shopt -s nullglob
UNSIGNED_APKS=( "$INPUT_DIR"/*.apk )
shopt -u nullglob

if [ "${#UNSIGNED_APKS[@]}" -eq 0 ]; then
  log_error "No APK files found in $INPUT_DIR"
  exit 1
fi

sign_one() {
  local unsigned_apk="$1"
  local name
  name="$(basename "$unsigned_apk")"
  log "Signing $name ..."

  # apksigner mutates the input in place. Signing the unsigned APK to
  # the same path keeps the create-release step's "find by basename"
  # pattern working unchanged.
  set +e
  "$APKSIGNER" sign \
    --ks "$P12_FILE" \
    --ks-pass "pass:${KEYSTORE_PASSWORD}" \
    --ks-key-alias "$KEY_ALIAS" \
    --key-pass "pass:${KEY_ENTRY_PASS}" \
    --in "$unsigned_apk" \
    --out "$unsigned_apk" \
    >/dev/null 2>&1
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    # Re-run without output suppression so the user sees why it failed.
    "$APKSIGNER" sign \
      --ks "$P12_FILE" \
      --ks-pass "pass:${KEYSTORE_PASSWORD}" \
      --ks-key-alias "$KEY_ALIAS" \
      --key-pass "pass:${KEY_ENTRY_PASS}" \
      --in "$unsigned_apk" \
      --out "$unsigned_apk"
  fi

  # apksigner prints "Verified using v1/v2/v3 ..." on success. Fail
  # loudly if verify cannot confirm a valid signature.
  if ! "$APKSIGNER" verify --verbose --print-certs "$unsigned_apk" >/dev/null 2>&1; then
    "$APKSIGNER" verify --verbose --print-certs "$unsigned_apk"
    log_error "apksigner verify FAILED for $name"
    return 1
  fi

  if [ -n "$EXPECTED_CERT_SHA256" ]; then
    # apksigner --print-certs dumps lines like:
    #   Signer #1 certificate DN: CN=...
    #   Signer #1 certificate SHA-256 digest: <hex>
    #     [sha256 of cert above, possibly indented under "Subject"]
    # Extract the digest with a two-line window so we pick up the
    # first signer even when the formatting shifts across build-tools
    # versions. Lowercase both sides for comparison.
    ACTUAL_CERT_SHA256="$(
      "$APKSIGNER" verify --print-certs "$unsigned_apk" 2>/dev/null \
        | awk '/SHA-256 digest:/ { sub(/^[^:]*:/, ""); gsub(/[[:space:]]/, ""); print; exit }'
    )"
    EXPECTED_CERT_SHA256_LC="$(printf '%s' "$EXPECTED_CERT_SHA256" | tr '[:upper:]' '[:lower:]')"
    ACTUAL_CERT_SHA256_LC="$(printf '%s' "$ACTUAL_CERT_SHA256" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$ACTUAL_CERT_SHA256_LC" ]; then
      log_error "apksigner did not print a SHA-256 digest for $name; cannot compare against EXPECTED_CERT_SHA256"
      return 1
    fi
    if [ "$ACTUAL_CERT_SHA256_LC" != "$EXPECTED_CERT_SHA256_LC" ]; then
      log_error "Signed APK certificate SHA-256 mismatch for $name"
      log_error "Expected: $EXPECTED_CERT_SHA256_LC"
      log_error "Actual:   $ACTUAL_CERT_SHA256_LC"
      return 1
    fi
    log "Verified certificate SHA-256 matches EXPECTED_CERT_SHA256 for $name"
  else
    log_warn "EXPECTED_CERT_SHA256 not set; certificate pinning is skipped."
    log_warn "Set the env var on the 'signing' GitHub environment to enable pinning."
  fi

  # Copy the signed APK into the output dir (the create-release job
  # uploads from there).
  cp -f "$unsigned_apk" "$OUTPUT_DIR/$name"
  log "Signed APK ready: $OUTPUT_DIR/$name"
}

SIGNED_COUNT=0
FAILED=0
for unsigned_apk in "${UNSIGNED_APKS[@]}"; do
  if sign_one "$unsigned_apk"; then
    SIGNED_COUNT=$((SIGNED_COUNT + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done

if [ "$FAILED" -gt 0 ]; then
  log_error "Signing failed for $FAILED APK(s); $SIGNED_COUNT succeeded."
  exit 1
fi

log "Signed $SIGNED_COUNT APK(s) successfully."
