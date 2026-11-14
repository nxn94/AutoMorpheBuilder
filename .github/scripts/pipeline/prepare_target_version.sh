#!/usr/bin/env bash
#
# scripts/prepare_target_version.sh — gather inputs for the
# download-supported-apk.js step
# (pin version, manual fallback URL).
#
# Replaces the inline `run:` block in the workflow's "Prepare inputs for
# download-supported-apk.js" step. The job previously wrote GITHUB_OUTPUT
# entries (`pinned`, `url`) AND ran a small bash prelude for the resolve
# step; this script emits `pinned` and `url`.
#
# Environment:
#   APP_ID        required  package id
#   CONFIG_FILE   optional  default ./config.json
#   GITHUB_OUTPUT required

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"

APP_ID="${APP_ID:-}"

if [ -z "$APP_ID" ]; then
  log_error "Required env var APP_ID is empty."
  exit 1
fi

pin="$(pinned_version "$APP_ID" 2>/dev/null || true)"
if [ -z "$pin" ] || [ "$pin" = "null" ]; then pin=""; fi

url="$(jq -r --arg pkg "$APP_ID" '.download_urls?[$pkg]?["latest_supported"] // empty' "$CONFIG_FILE" 2>/dev/null || true)"
if [ -z "$url" ] || [ "$url" = "null" ]; then url=""; fi

json_set_output pinned "$pin"
json_set_output url "$url"

log "Prepared target-version inputs for $APP_ID:"
log "  pinned: ${pin:-<none>}"
log "  url:    ${url:-<none>}"
