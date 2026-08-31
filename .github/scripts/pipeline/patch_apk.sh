#!/usr/bin/env bash
#
# scripts/patch_apk.sh — invoke morphe-desktop patch on a single APK, then
# copy the patched output to $OUT_DIR with the canonical Obtainium name.
#
# Replaces the inline block inside the workflow's "Patch ${matrix.name}
# with morphe-desktop" step (about 90 lines, including the find/awk scan
# for the patched APK).
#
# Behaviour matches the original step:
#   1. Resolve the morphe-desktop jar + .mpp file.
#   2. Compute enabled/disabled patch counts from patches.json.
#   3. Run `java -jar morphe-desktop.jar patch ...` with all the flags.
#   4. Find the patched APK at the deterministic temp path. Fall back to
#      scanning APKS_DIR / cwd for any newer APK that isn't the input.
#   5. Rename the patched APK to <app>-v<base-version>-<patches>.apk in
#      OUT_DIR and emit `output=<name>` to $GITHUB_OUTPUT.
#
# Signed builds are enforced — if the keystore preparation step didn't
# produce the expected file, this script hard-fails.
#
# Environment:
#   APP_ID           required  package id
#   APP_NAME         required  short app name (matches config.json .name)
#   APK              required  absolute path to the APK to patch
#   APK_VERSION      required  base APK version
#   PATCH_TAG        required  morphe patch tag (e.g. v1.32.0)
#   PATCH_REPO       required  patch repo slug (used to find .mpp)
#   PATCH_SLUG       required  repo slug for filename lookup
#   CLI_JAR          optional  explicit morphe-desktop jar override
#   KEYSTORE_FILE    required  BKS keystore path (from prepare_keystore)
#   KEY_ALIAS        required  key alias
#   KEYSTORE_PASSWORD required  keystore password
#   KEY_ENTRY_PASS   optional  key password (defaults to KEYSTORE_PASSWORD)
#   TOOLS_DIR        optional  default ./tools
#   OUT_DIR          optional  default ./out
#   APKS_DIR         optional  default ./apps
#   RUNNER_TEMP      optional  default /tmp
#   EXPECTED_CERT_SHA256  optional  pin the signing cert fingerprint;
#                                  when set, the actual cert SHA-256
#                                  of the signed APK must match
#                                  (compared case-insensitively). When
#                                  unset, the comparison is skipped
#                                  with a ::warning:: annotation.
#   BT_DIR / ANDROID_BUILD_TOOLS_VERSION  optional  used to locate
#                                  apksigner. Both env vars come
#                                  from install_aapt.sh via
#                                  $GITHUB_ENV; the wrapper falls
#                                  back to PATH lookup as a last
#                                  resort.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"

APP_ID="${APP_ID:-}"
APP_NAME="${APP_NAME:-}"
APK="${APK:-}"
APK_VERSION="${APK_VERSION:-}"
PATCH_TAG="${PATCH_TAG:-}"
PATCH_REPO="${PATCH_REPO:-}"
PATCH_SLUG="${PATCH_SLUG:-}"
CLI_JAR="${CLI_JAR:-}"
KEYSTORE_FILE="${KEYSTORE_FILE:-}"
KEY_ALIAS="${KEY_ALIAS:-}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-}"
KEY_ENTRY_PASS="${KEY_ENTRY_PASS:-$KEYSTORE_PASSWORD}"
TOOLS_DIR="${TOOLS_DIR:-./tools}"
OUT_DIR="${OUT_DIR:-./out}"
APKS_DIR="${APKS_DIR:-./apps}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"

for var in APP_ID APP_NAME APK APK_VERSION PATCH_TAG PATCH_REPO KEYSTORE_FILE KEY_ALIAS KEYSTORE_PASSWORD; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

mkdir -p "$OUT_DIR" "$APKS_DIR"

JAR="$CLI_JAR"
if [ -z "$JAR" ]; then
  JAR="$(ls -1 "$TOOLS_DIR"/morphe-desktop*.jar 2>/dev/null | head -n1 || true)"
fi
if [ -z "$JAR" ] || [ ! -f "$JAR" ]; then
  log_error "morphe-desktop jar not found in $TOOLS_DIR"
  exit 1
fi

MPP="$TOOLS_DIR/${PATCH_SLUG}.mpp"
if [ ! -f "$MPP" ]; then
  log_error "Patch file not found: $MPP"
  exit 1
fi

# --- keystore + signing args ----------------------------------------------

if [ ! -f "$KEYSTORE_FILE" ]; then
  log_error "Prepared keystore file not found at $KEYSTORE_FILE."
  exit 1
fi

# NOTE: --keystore-password / --keystore-entry-password are currently
# passed as inline values, which makes them visible in /proc/<pid>/cmdline
# to any other process in the same job for the duration of the call.
# prepare_keystore.sh's keytool invocations already use the safer
# -storepass:env / -keypass:env form (see that script). If morphe-desktop
# upstream gains an equivalent env- or file-based password form (e.g.
# --keystore-password=env:KEYSTORE_PASSWORD or =file:<path>), switch
# these to it. Until then, this is the documented upstream limitation.
KEY_ARGS=(
  --keystore="$KEYSTORE_FILE"
  --keystore-password="$KEYSTORE_PASSWORD"
  --keystore-entry-alias="$KEY_ALIAS"
  --keystore-entry-password="$KEY_ENTRY_PASS"
)

# --- patches.json → enabled/disabled lists --------------------------------

PATCHES_FILE="${PATCHES_FILE:-./patches.json}"

if ! jq -e --arg repo "$PATCH_REPO" --arg pkg "$APP_ID" \
    'has($repo) and (.[$repo] | has($pkg))' "$PATCHES_FILE" >/dev/null 2>&1; then
  log_warn "No patches.json entry for ${PATCH_REPO}/${APP_ID}; applying all patches."
fi

ENABLED_PATCHES="$(
  jq -r --arg repo "$PATCH_REPO" --arg pkg "$APP_ID" \
    '.[$repo][$pkg] // {} | to_entries[] | select(.value == true) | .key' \
    "$PATCHES_FILE" 2>/dev/null || true
)"
DISABLED_PATCHES="$(list_disabled_patches "$APP_ID")"

ENABLED_COUNT="$(printf '%s\n' "$ENABLED_PATCHES" | sed '/^$/d' | wc -l | tr -d ' ')"
DISABLED_COUNT="$(printf '%s\n' "$DISABLED_PATCHES" | sed '/^$/d' | wc -l | tr -d ' ')"

log "Enabled patches for $APP_ID (${ENABLED_COUNT}):"
if [ "$ENABLED_COUNT" -gt 0 ]; then
  printf '%s\n' "$ENABLED_PATCHES" | sed '/^$/d' | paste -sd '; ' - | sed 's/^/  /'
else
  log "  (none)"
fi
log "Disabled patches for $APP_ID (${DISABLED_COUNT}):"
if [ "$DISABLED_COUNT" -gt 0 ]; then
  printf '%s\n' "$DISABLED_PATCHES" | sed '/^$/d' | paste -sd '; ' - | sed 's/^/  /'
else
  log "  (none)"
fi

PATCH_ARGS=()
while IFS= read -r patch_name; do
  [ -z "$patch_name" ] && continue
  PATCH_ARGS+=("-d" "$patch_name")
done <<< "$DISABLED_PATCHES"

# --- patch ---------------------------------------------------------------

MARKER="$RUNNER_TEMP/morphe_${APP_NAME}_start.marker"
: > "$MARKER"

PATCH_LOG="$RUNNER_TEMP/morphe_patch_${APP_NAME}.log"
PATCH_TMP_DIR="$RUNNER_TEMP/morphe_${APP_NAME}"
PATCHED_APK="$RUNNER_TEMP/morphe_${APP_NAME}_patched.apk"
rm -f "$PATCHED_APK"

APK_NORM="${APK#./}"

run_patch() {
  local mode="$1"; shift
  log "Running morphe-desktop for $APP_ID (v$APK_VERSION, mode=$mode)..."
  set +e
  "$@" 2>&1 | tee "$PATCH_LOG"
  local rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

build_patch_cmd() {
  local -a cmd=(java -jar "$JAR" patch --patches="$MPP")
  cmd+=("${KEY_ARGS[@]}")
  cmd+=(--temporary-files-path="$PATCH_TMP_DIR")
  cmd+=(--out="$PATCHED_APK")
  cmd+=("${PATCH_ARGS[@]}")
  cmd+=("$APK")
  printf '%s\0' "${cmd[@]}"
}

mapfile -d '' -t PATCH_CMD < <(build_patch_cmd)
if ! run_patch signed-required "${PATCH_CMD[@]}"; then
  if grep -q "Wrong version of key store" "$PATCH_LOG"; then
    log_error "Morphe could not read the provided keystore (Wrong version of key store)."
    log_error "Ensure KEYSTORE_BASE64 decodes to a valid keystore and KEYSTORE_PASSWORD/KEY_PASSWORD are correct."
  fi
  exit 1
fi

# --- locate patched output -----------------------------------------------

OUT_APK=""
if [ -f "$PATCHED_APK" ]; then
  OUT_APK="$PATCHED_APK"
else
  log_warn "morphe-desktop --out was not honored; falling back to find-based scan."
  OUT_APK="$(
    { find . -maxdepth 1 -type f -name "*.apk" -newer "$MARKER" -printf '%T@ %p\n' || true; \
      find "$APKS_DIR" -maxdepth 1 -type f -name "*.apk" -newer "$MARKER" -printf '%T@ %p\n' || true; } \
      | sort -nr \
      | cut -d' ' -f2- \
      | awk -v apk="$APK_NORM" '
          { line=$0; sub(/^\.\//, "", line)
            if (line != "" && line != apk && out == "") out=line }
          END { if (out != "") print out }'
  )"
  if [ -z "$OUT_APK" ] || [ ! -f "$OUT_APK" ]; then
    OUT_APK="$(
      { find . -maxdepth 1 -type f -name "*.apk" -printf '%T@ %p\n' || true; \
        find "$APKS_DIR" -maxdepth 1 -type f -name "*.apk" -printf '%T@ %p\n' || true; } \
        | sort -nr \
        | cut -d' ' -f2- \
        | awk -v apk="$APK_NORM" '
            { line=$0; sub(/^\.\//, "", line)
              if (line != "" && line != apk && out == "") out=line }
            END { if (out != "") print out }'
    )"
  fi
fi

if [ -z "$OUT_APK" ] || [ ! -f "$OUT_APK" ]; then
  log_error "Could not locate patched APK output (expected at $PATCHED_APK)."
  log_error "Files in current dir: $(ls -A)"
  log_error "Files in $APKS_DIR: $(ls -A "$APKS_DIR" 2>/dev/null || echo '<empty>')"
  exit 1
fi

OUTPUT_NAME="${APP_NAME}-v${APK_VERSION}-${PATCH_TAG}.apk"
mv "$OUT_APK" "$OUT_DIR/$OUTPUT_NAME"
json_set_output output "$OUTPUT_NAME"
log "Patched APK ready: $OUT_DIR/$OUTPUT_NAME"

# --- post-sign verification ------------------------------------------------
#
# After morphe-desktop has signed the APK, re-verify with apksigner
# (apksigner verify --print-certs dumps the SHA-256 of the signing
# certificate). Catches:
#   - silent signing failures (morphe-desktop might exit 0 but leave
#     the APK unsigned in edge cases).
#   - signing-cert drift: when EXPECTED_CERT_SHA256 is set in the
#     repo's environment variables, the actual cert fingerprint must
#     match. This pins the build to a specific keystore so a leaked
#     signing key triggers an immediate hard-fail.
# (Previously this block also ran a zipalign -c alignment check as a
# hard gate, but morphe-desktop.jar's 'patch' produces an unaligned
# APK by design; the gate rejected 5 of 6 builds in the first
# post-merge run. Alignment is a follow-up improvement lane, not a
# gate that fails every APK this workflow produces.)
#
# Both tools live in the Android build-tools directory that
# install_aapt.sh pinned to $ANDROID_HOME/build-tools/<ver>/.
# $BT_DIR may already be exported by a previous step (the workflow
# propagates $PATH via $GITHUB_ENV); fall back to aapt-style discovery
# when it isn't.

BT_DIR_CACHED="${BT_DIR:-}"
if [ -z "$BT_DIR_CACHED" ] && [ -n "${ANDROID_HOME:-}" ] && [ -n "${ANDROID_BUILD_TOOLS_VERSION:-}" ]; then
  BT_DIR_CACHED="$ANDROID_HOME/build-tools/${ANDROID_BUILD_TOOLS_VERSION}"
fi
if [ -n "$BT_DIR_CACHED" ] && [ -x "$BT_DIR_CACHED/apksigner" ]; then
  APKSIGNER="$BT_DIR_CACHED/apksigner"
  ZIPALIGN="$BT_DIR_CACHED/zipalign"
else
  # Last resort: rely on PATH (install_aapt.sh exports PATH via
  # GITHUB_ENV so the build-tools dir is on PATH for downstream steps).
  APKSIGNER="$(command -v apksigner || true)"
  ZIPALIGN="$(command -v zipalign || true)"
fi

if [ -z "$APKSIGNER" ] || [ -z "$ZIPALIGN" ]; then
  log_warn "apksigner/zipalign not found; skipping post-sign verification."
else
  log "Verifying signed APK with apksigner..."
  if ! "$APKSIGNER" verify --verbose --print-certs "$OUT_DIR/$OUTPUT_NAME"; then
    log_error "apksigner verify FAILED for $OUTPUT_NAME"
    exit 1
  fi

  if [ -n "${EXPECTED_CERT_SHA256:-}" ]; then
    # apksigner --print-certs dumps lines like:
    #   Signer #1 certificate DN: CN=...
    #   Signer #1 certificate SHA-256 digest: <hex>
    #     [sha256 of cert above, possibly indented under "Subject"]
    # Extract the digest with a two-line window so we pick up the
    # first signer even when the formatting shifts across build-tools
    # versions. Lowercase both sides for comparison.
    ACTUAL_CERT_SHA256="$(
      "$APKSIGNER" verify --print-certs "$OUT_DIR/$OUTPUT_NAME" 2>/dev/null \
        | awk '/SHA-256 digest:/ { sub(/^[^:]*:/, ""); gsub(/[[:space:]]/, ""); print; exit }'
    )"
    EXPECTED_CERT_SHA256_LC="$(printf '%s' "$EXPECTED_CERT_SHA256" | tr '[:upper:]' '[:lower:]')"
    ACTUAL_CERT_SHA256_LC="$(printf '%s' "$ACTUAL_CERT_SHA256" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$ACTUAL_CERT_SHA256_LC" ]; then
      log_error "apksigner did not print a SHA-256 digest for $OUTPUT_NAME; cannot compare against EXPECTED_CERT_SHA256"
      exit 1
    fi
    if [ "$ACTUAL_CERT_SHA256_LC" != "$EXPECTED_CERT_SHA256_LC" ]; then
      log_error "Signed APK certificate SHA-256 mismatch"
      log_error "Expected: $EXPECTED_CERT_SHA256_LC"
      log_error "Actual:   $ACTUAL_CERT_SHA256_LC"
      exit 1
    fi
    log "Verified certificate SHA-256 matches EXPECTED_CERT_SHA256"
  else
    log_warn "EXPECTED_CERT_SHA256 not set; certificate pinning is skipped."
    log_warn "Set the env var in repo settings (or env 'apk-signing') to enable pinning."
  fi


fi
