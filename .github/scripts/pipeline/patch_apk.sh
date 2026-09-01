#!/usr/bin/env bash
#
# scripts/patch_apk.sh — invoke morphe-desktop `patch` WITHOUT signing.
#
# Replaces the inline `run:` block in the workflow's "Patch ${matrix.name}
# with morphe-desktop" step. Produces an unsigned patched APK in $OUT_DIR.
#
# The keystore signing step lives in a separate job (`sign`) so that the
# untrusted-input surface (APKMirror HTML/JSON parsing, third-party patch
# tools) runs in a job that has NO access to the signing secrets. If a
# malicious APK or upstream patch repo triggered code execution during
# this step, the blast radius is contained to a job with no KEYSTORE_*
# secrets in its environment.
#
# Behaviour:
#   1. Resolve the morphe-desktop jar + .mpp file.
#   2. Compute enabled/disabled patch counts from patches.json.
#   3. Run `java -jar morphe-desktop.jar patch --unsigned ...` with the
#      disabled-patch flags but WITHOUT any keystore args. morphe-desktop
#      emits an unsigned APK (the keystore-aware `sign` job re-signs it
#      later via apksigner).
#   4. Find the patched APK at the deterministic temp path. Fall back to
#      scanning APKS_DIR / cwd for any newer APK that isn't the input.
#   5. Rename the patched APK to <app>-v<base-version>-<patches>.apk in
#      OUT_DIR and emit `output=<name>` to $GITHUB_OUTPUT.
#
# Environment:
#   APP_ID     required  package id
#   APP_NAME   required  short app name (matches config.json .name)
#   APK        required  absolute path to the unsigned APK to patch
#   APK_VERSION required  base APK version (used for the output filename)
#   PATCH_TAG  required  morphe patch tag (e.g. v1.32.0)
#   PATCH_REPO required  patch repo slug (used to find .mpp)
#   PATCH_SLUG required  repo slug for filename lookup
#   CLI_JAR    optional  explicit morphe-desktop jar override
#   TOOLS_DIR  optional  default ./tools
#   OUT_DIR    optional  default ./out
#   APKS_DIR   optional  default ./apps
#   RUNNER_TEMP optional  default /tmp
#
# This script MUST NOT consume or expose any keystore-related env vars
# (KEYSTORE_BASE64, KEYSTORE_PASSWORD, KEY_ALIAS, KEY_PASSWORD,
# KEYSTORE_FILE, KEY_ENTRY_PASS). The `sign` job owns those exclusively.

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

# Defensive: refuse to run if any signing secret is set in this job's
# environment. The plan says patch_apk.sh MUST NOT touch keystore env
# vars; if a future change accidentally sets one, this guard fails fast
# with a clear message rather than silently passing it through.
for forbidden_var in KEYSTORE_BASE64 KEYSTORE_PASSWORD KEY_ALIAS KEY_PASSWORD KEYSTORE_FILE KEY_ENTRY_PASS; do
  if [ -n "${!forbidden_var:-}" ]; then
    log_error "$forbidden_var is set in the patch job's environment."
    log_error "patch_apk.sh must not see signing secrets; the 'sign' job owns them."
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

# --- patch (unsigned) -------------------------------------------------------

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
  # `--unsigned` tells morphe-desktop to skip its built-in signing step.
  # The `sign` job re-signs the result with our own keystore via
  # apksigner. This is the boundary that keeps KEYSTORE_* secrets out of
  # this job's environment.
  local -a cmd=(java -jar "$JAR" patch --patches="$MPP" --unsigned)
  cmd+=(--temporary-files-path="$PATCH_TMP_DIR")
  cmd+=(--out="$PATCHED_APK")
  cmd+=("${PATCH_ARGS[@]}")
  cmd+=("$APK")
  printf '%s\0' "${cmd[@]}"
}

mapfile -d '' -t PATCH_CMD < <(build_patch_cmd)
if ! run_patch unsigned "${PATCH_CMD[@]}"; then
  if grep -q "Wrong version of key store" "$PATCH_LOG"; then
    # morphe-desktop should not mention keystores with --unsigned. If it
    # does, the upstream tool no longer honours the flag — surface that
    # distinctly so a future operator knows to check for an upstream
    # breaking change.
    log_error "morphe-desktop referenced a keystore despite --unsigned."
    log_error "Upstream may have removed support for unsigned patching."
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
log "Patched (unsigned) APK ready: $OUT_DIR/$OUTPUT_NAME"
log "Signing happens in the downstream 'sign' job (environment: signing)."
