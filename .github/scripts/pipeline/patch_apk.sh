#!/usr/bin/env bash
#
# scripts/patch_apk.sh — invoke morphe-desktop `patch --unsigned`.
#
# Replaces the inline `run:` block in the workflow's "Patch and sign
# ${matrix.name} with morphe-desktop" step. Produces an unsigned patched APK
# in $OUT_DIR. Patch bundles are third-party code, so this script never sees
# the keystore; create-release signs the APK (sign_apks.sh).
#
# Behaviour:
#   1. Resolve the morphe-desktop jar + .mpp file.
#   2. Compute enabled/disabled patch counts from patches.json.
#   3. Run `java -jar morphe-desktop.jar patch --unsigned ...`.
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

for var in APP_ID APP_NAME APK APK_VERSION PATCH_TAG PATCH_REPO; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

mkdir -p "$OUT_DIR" "$APKS_DIR"

JAR="$CLI_JAR"
if [ -z "$JAR" ]; then
  JAR="$TOOLS_DIR/morphe-desktop.jar"
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

# Generated metadata honors explicit opt-ins. Structured sources do so only with
# honor_patch_opt_ins (legacy sync sets every new patch true).
ENABLE_ARGS_JSON="$(node "$(dirname "$0")/../patch-metadata-runtime.js" enables)"
mapfile -d '' -t ENABLE_ARGS < <(jq -j '.[] + "\u0000"' <<< "$ENABLE_ARGS_JSON")
PATCH_ARGS+=("${ENABLE_ARGS[@]}")

# --- patch (unsigned) -----------------------------------------------------

MARKER="$RUNNER_TEMP/morphe_${APP_NAME}_start.marker"
: > "$MARKER"

PATCH_LOG="$RUNNER_TEMP/morphe_patch_${APP_NAME}.log"
PATCH_TMP_DIR="$RUNNER_TEMP/morphe_${APP_NAME}"
PATCHED_APK="$RUNNER_TEMP/morphe_${APP_NAME}_patched.apk"
rm -f "$PATCHED_APK"


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
  local -a cmd=(java -jar "$JAR" patch --patches="$MPP" --unsigned)
  cmd+=(--temporary-files-path="$PATCH_TMP_DIR")
  cmd+=(--out="$PATCHED_APK")
  cmd+=("${PATCH_ARGS[@]}")
  cmd+=("$APK")
  printf '%s\0' "${cmd[@]}"
}

mapfile -d '' -t PATCH_CMD < <(build_patch_cmd)
if ! run_patch unsigned "${PATCH_CMD[@]}"; then
  exit 1
fi

# --- locate patched output -----------------------------------------------

OUT_APK="$PATCHED_APK"
if [ ! -s "$OUT_APK" ]; then
  log_error "morphe-desktop did not produce the declared output: $PATCHED_APK"
  exit 1
fi

OUTPUT_NAME="${APP_NAME}-v${APK_VERSION}-${PATCH_TAG}.apk"
mv "$OUT_APK" "$OUT_DIR/$OUTPUT_NAME"
json_set_output output "$OUTPUT_NAME"
log "Patched (unsigned) APK ready: $OUT_DIR/$OUTPUT_NAME"