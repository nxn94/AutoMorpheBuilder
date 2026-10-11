#!/usr/bin/env bash
# Resolve each app's repository/branch/pin selector independently and emit
# an app-keyed repo-versions map plus the full build matrix. Release filtering
# runs after verified tools and supported versions have been obtained.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"
. "$(dirname "$0")/lib/github.sh"

require_command gh
require_command jq
require_command curl
validate_required_config

CLI_REPO="$(jq -r '.cli.repo' "$CONFIG_FILE")"
CLI_BRANCH_RAW="$(jq -r '.cli.branch | ascii_downcase' "$CONFIG_FILE")"
if [ "$CLI_BRANCH_RAW" = "main" ] || [ "$CLI_BRANCH_RAW" = "dev" ]; then
  CLI_BRANCH="$CLI_BRANCH_RAW"
else
  log_warn "Invalid cli.branch '$CLI_BRANCH_RAW'. Falling back to 'main'."
  CLI_BRANCH="main"
fi

# Sourced here because it uses GH_TOKEN. resolve-tag.sh is a function
# library, not an executable script.
# shellcheck source=resolve-tag.sh
. "$(dirname "$0")/resolve-tag.sh"

# --- resolve tags for every patch repo ------------------------------------

REPO_PAIRS="$(list_repo_branches)"
[ -z "$REPO_PAIRS" ] && { log_error "No valid patch_repos entries found in $CONFIG_FILE."; exit 1; }

declare -A REPO_TAGS=()
while IFS='|' read -r repo branch pin_tag; do
  if [ -n "$pin_tag" ]; then
    # Per-app pin (config.json's pin_patch_tag) overrides the resolved tag.
    # Use this when an upstream patch release is broken (e.g. references a
    # class that morphe-desktop doesn't expose at runtime) and you need to
    # hold the matrix on a known-good tag until upstream ships a fix.
    log "Pinned tag for ${repo}: ${pin_tag} (config.json pin_patch_tag)"
    tag="$pin_tag"
  else
    log "Resolving tag for ${repo} (branch=${branch})..."
    tag="$(resolve_release_tag "$repo" "$branch")"
    log "  ${repo} -> ${tag}"
  fi
  REPO_TAGS["$repo|$branch|$pin_tag"]="$tag"
done <<< "$REPO_PAIRS"

CLI_TAG="$(resolve_release_tag "$CLI_REPO" "$CLI_BRANCH")"
log "CLI (${CLI_REPO}) -> ${CLI_TAG}"

# Preserve each selector independently. Build a per-app tag map so apps on
# different channels or pins never overwrite another app's selection.
TAGS_JSON='{}'
for selector in "${!REPO_TAGS[@]}"; do
  TAGS_JSON="$(jq -c --arg key "$selector" --arg tag "${REPO_TAGS[$selector]}" '. + {($key): $tag}' <<<"$TAGS_JSON")"
done
REPO_VERSIONS="$(jq -c --argjson tags "$TAGS_JSON" '
  .patch_repos | to_entries | map({(.key): $tags[(.value.repo + "|" + (.value.branch | ascii_downcase) + "|" + (.value.pin_patch_tag // ""))]}) | add
' "$CONFIG_FILE")"
MATRIX_WITH_TAGS="$(REPO_VERSIONS="$REPO_VERSIONS" node "$(dirname "$0")/../build-plan.js")"

# --- decide + emit -------------------------------------------------------

# Optimistic default: a build is needed. The downstream
# check_existing_releases.sh step (run after the morphe-desktop jar +
# .mpp files are downloaded) compares each app's resolved APK version
# + patches tag against the existing releases and overrides this to
# false when every app is already up-to-date.
SHOULD_BUILD=true
log "Default should-build=true; check_existing_releases.sh will override if all apps are current."

json_set_output matrix-include "$MATRIX_WITH_TAGS"
json_set_output repo-versions "$REPO_VERSIONS"
json_set_output cli-version "$CLI_TAG"
json_set_output cli-branch "$CLI_BRANCH"
json_set_output cli-repo "$CLI_REPO"
json_set_output should-build "$SHOULD_BUILD"