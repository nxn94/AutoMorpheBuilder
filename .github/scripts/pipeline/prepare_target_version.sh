#!/usr/bin/env bash
#
# scripts/prepare_target_version.sh — gather inputs for the
# download-supported-apk.js + resolve-supported-version.js steps
# (pin version, morphe-desktop jar, manual fallback URL, disabled patches).
#
# Replaces the inline `run:` block in the workflow's "Prepare inputs for
# download-supported-apk.js" step. The job previously wrote three
# GITHUB_OUTPUT entries (`pinned`, `jar`, `url`) AND ran a small bash
# prelude for the resolve step; this script emits all four.
#
# Environment:
#   APP_ID        required  package id
#   PATCH_REPO    required  patch repo (for slug → mpp lookup)
#   TOOLS_DIR     required  dir containing morphe-desktop-*-all.jar
#   CONFIG_FILE   optional  default ./config.json
#   PATCHES_FILE  optional  default ./patches.json
#   GITHUB_OUTPUT required

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"

APP_ID="${APP_ID:-}"
PATCH_REPO="${PATCH_REPO:-}"
TOOLS_DIR="${TOOLS_DIR:-./tools}"

for var in APP_ID PATCH_REPO; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

pin="$(pinned_version "$APP_ID" 2>/dev/null || true)"
if [ -z "$pin" ] || [ "$pin" = "null" ]; then pin=""; fi

jar="$(ls -1 "$TOOLS_DIR"/morphe-desktop-*-all.jar 2>/dev/null | head -n1 || true)"
if [ -z "$jar" ]; then jar=""; fi

url="$(jq -r --arg pkg "$APP_ID" '.download_urls?[$pkg]?["latest_supported"] // empty' "$CONFIG_FILE" 2>/dev/null || true)"
if [ -z "$url" ] || [ "$url" = "null" ]; then url=""; fi

disabled="$(
  jq -c \
    --arg repo "$PATCH_REPO" \
    --arg pkg "$APP_ID" \
    '.[$repo][$pkg] // {} | to_entries | map(select(.value == false) | .key)' \
    "$PATCHES_FILE" 2>/dev/null || echo '[]'
)"

json_set_output pinned "$pin"
json_set_output jar "$jar"
json_set_output url "$url"
json_set_output disabled "$disabled"

log "Prepared target-version inputs for $APP_ID:"
log "  pinned: ${pin:-<none>}"
log "  jar:    ${jar:-<none>}"
log "  url:    ${url:-<none>}"
log "  disabled: $(printf '%s' "$disabled" | jq -c '. | length') patch(es)"