#!/usr/bin/env bash
# Sign every patched APK in APKS_DIR, in place, with the release keystore.
#
# Runs in create-release, which never executes patch code, so third-party
# patch bundles have no route to the keystore or its passwords. Any failure
# stops the job: an unsigned APK is never published.
#
# Environment:
#   APKS_DIR                     required  directory holding the unsigned *.apk
#   KEYSTORE_BASE64              required  base64 of the PKCS12/JKS keystore
#   KEYSTORE_PASSWORD            required  store password
#   KEY_ALIAS                    optional  default: the keystore's first alias
#   KEY_PASSWORD                 optional  default: KEYSTORE_PASSWORD
#   ANDROID_HOME                 optional  default /tmp/android-sdk
#   ANDROID_BUILD_TOOLS_VERSION  optional  default 35.0.0
#   RUNNER_TEMP                  optional  default /tmp

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

for var in APKS_DIR KEYSTORE_BASE64 KEYSTORE_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    log_error "Required env var $var is empty (signed builds are enforced)."
    exit 1
  fi
done

BUILD_TOOLS="${ANDROID_HOME:-/tmp/android-sdk}/build-tools/${ANDROID_BUILD_TOOLS_VERSION:-35.0.0}"
APKSIGNER="$BUILD_TOOLS/apksigner"
ZIPALIGN="$BUILD_TOOLS/zipalign"
require_file "$APKSIGNER" >/dev/null
require_file "$ZIPALIGN" >/dev/null

WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/sign.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
KEYSTORE="$WORK/source.keystore"
printf '%s' "$KEYSTORE_BASE64" | base64 -d > "$KEYSTORE"

KEY_ALIAS="${KEY_ALIAS:-}"
if [ -z "$KEY_ALIAS" ]; then
  KEY_ALIAS="$(
    keytool -list -keystore "$KEYSTORE" -storepass:env KEYSTORE_PASSWORD 2>/dev/null \
      | awk -F, '/,/{print $1}' | sed '/^$/d' | head -n1
  )" || true
  if [ -z "$KEY_ALIAS" ]; then
    log_error "No KEY_ALIAS set and no alias could be read; check KEYSTORE_PASSWORD."
    exit 1
  fi
fi
export KEY_ENTRY_PASSWORD="${KEY_PASSWORD:-$KEYSTORE_PASSWORD}"

shopt -s nullglob
apks=("$APKS_DIR"/*.apk)
if [ "${#apks[@]}" -eq 0 ]; then
  log_error "No APK files found in $APKS_DIR"
  exit 1
fi

for apk in "${apks[@]}"; do
  name="$(basename "$apk")"
  input="$apk"
  if ! "$ZIPALIGN" -c -P 16 4 "$input" >/dev/null 2>&1; then
    "$ZIPALIGN" -f -P 16 4 "$input" "$WORK/aligned.apk"
    input="$WORK/aligned.apk"
  fi
  "$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass env:KEYSTORE_PASSWORD \
    --ks-key-alias "$KEY_ALIAS" --key-pass env:KEY_ENTRY_PASSWORD \
    --out "$WORK/signed.apk" "$input"
  "$APKSIGNER" verify "$WORK/signed.apk"
  mv "$WORK/signed.apk" "$apk"
  rm -f "$WORK/aligned.apk" "$WORK/signed.apk.idsig"
  log "Signed $name"
done
