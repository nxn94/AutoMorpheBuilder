#!/usr/bin/env bash
#
# scripts/patch_apk.sh — invoke morphe-desktop `patch` with keystore signing.
#
# Replaces the inline `run:` block in the workflow's "Patch and sign
# ${matrix.name} with morphe-desktop" step. Produces a signed patched APK
# in $OUT_DIR.
#
# morphe-desktop's `patch --keystore` accepts PKCS12 / JKS / BKS and
# auto-detects the format from file contents (not extension), converting
# to BKS internally without touching the original file. The decoded
# keystore from the workflow's prior step is passed straight in — no
# manual type detection, no BouncyCastle conversion, no separate
# sign-and-rewrite step.
#
# Behaviour:
#   1. Resolve the morphe-desktop jar + .mpp file.
#   2. Compute enabled/disabled patch counts from patches.json.
#   3. Run `java -jar morphe-desktop.jar patch --keystore ...` with the
#      keystore + password + alias + entry-password flags. morphe-desktop
#      emits a signed APK in place. There is no `--unsigned` fallback:
#      if the keystore is invalid or the password is wrong,
#      morphe-desktop exits non-zero and this script fails the
#      workflow loudly.
#   4. Find the patched APK at the deterministic temp path. Fall back to
#      scanning APKS_DIR / cwd for any newer APK that isn't the input.
#   5. Rename the patched APK to <app>-v<base-version>-<patches>.apk in
#      OUT_DIR and emit `output=<name>` to $GITHUB_OUTPUT.
#
# Environment:
#   APP_ID            required  package id
#   APP_NAME          required  short app name (matches config.json .name)
#   APK               required  absolute path to the unsigned APK to patch
#   APK_VERSION       required  base APK version (used for the output filename)
#   PATCH_TAG         required  morphe patch tag (e.g. v1.32.0)
#   PATCH_REPO        required  patch repo slug (used to find .mpp)
#   PATCH_SLUG        required  repo slug for filename lookup
#   CLI_JAR           optional  explicit morphe-desktop jar override
#   TOOLS_DIR         optional  default ./tools
#   OUT_DIR           optional  default ./out
#   APKS_DIR          optional  default ./apps
#   RUNNER_TEMP       optional  default /tmp
#   KEYSTORE_FILE     required  path to the decoded source keystore (PKCS12/JKS/BKS)
#   KEYSTORE_PASSWORD required  keystore password
#   KEY_ALIAS         optional  alias override; omitted → morphe-desktop picks first alias
#   KEY_PASSWORD      optional  key entry password; omitted (or == KEYSTORE_PASSWORD)
#                                → morphe-desktop uses KEYSTORE_PASSWORD for the entry too

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
TOOLS_DIR="${TOOLS_DIR:-./tools}"
OUT_DIR="${OUT_DIR:-./out}"
APKS_DIR="${APKS_DIR:-./apps}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
KEYSTORE_FILE="${KEYSTORE_FILE:-}"
KEYSTORE_PASSWORD="${KEYSTORE_PASSWORD:-}"
KEY_ALIAS="${KEY_ALIAS:-}"
KEY_PASSWORD="${KEY_PASSWORD:-}"

for var in APP_ID APP_NAME APK APK_VERSION PATCH_TAG PATCH_REPO KEYSTORE_FILE KEYSTORE_PASSWORD; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

if [ ! -f "$KEYSTORE_FILE" ]; then
  log_error "Keystore file not found: $KEYSTORE_FILE"
  exit 1
fi

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

# --- patch (signed) -------------------------------------------------------

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
  # morphe-desktop's `--keystore` accepts PKCS12 / JKS / BKS and
  # auto-detects the format from file contents (not extension). The
  # `--keystore-password` is the store password. The alias flag is
  # omitted when KEY_ALIAS is unset — morphe-desktop then picks the
  # keystore's first alias (matches the previous "if empty, picks
  # first alias" behavior of prepare_keystore.sh; flag this if you
  # ever observe morphe-desktop refusing to pick one — the docs in
  # AGENTS.md should be updated to require KEY_ALIAS at that point).
  # The entry-password is only passed when it differs from the store
  # password, so identical-password keystores stay a single env var.
  local -a cmd=(java -jar "$JAR" patch --patches="$MPP")
  cmd+=(--keystore "$KEYSTORE_FILE")
  cmd+=(--keystore-password "$KEYSTORE_PASSWORD")
  if [ -n "$KEY_ALIAS" ]; then
    cmd+=(--keystore-entry-alias "$KEY_ALIAS")
  fi
  if [ -n "$KEY_PASSWORD" ] && [ "$KEY_PASSWORD" != "$KEYSTORE_PASSWORD" ]; then
    cmd+=(--keystore-entry-password "$KEY_PASSWORD")
  fi
  cmd+=(--temporary-files-path="$PATCH_TMP_DIR")
  cmd+=(--out="$PATCHED_APK")
  cmd+=("${PATCH_ARGS[@]}")
  cmd+=("$APK")
  printf '%s\0' "${cmd[@]}"
}

mapfile -d '' -t PATCH_CMD < <(build_patch_cmd)
if ! run_patch signed "${PATCH_CMD[@]}"; then
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
log "Patched (signed) APK ready: $OUT_DIR/$OUTPUT_NAME"