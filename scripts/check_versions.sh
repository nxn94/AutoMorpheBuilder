#!/usr/bin/env bash
#
# scripts/check_versions.sh — resolve the latest Morphe / CLI release
# tags and decide whether a build is needed.
#
# Replaces the ~140-line inline `run:` block in the workflow's
# check-versions job. The behaviour is identical:
#   1. Validate config.json shape.
#   2. For every unique patch_repo+branch, resolve the latest matching
#      tag using resolve-tag.sh.
#   3. Resolve the CLI tag.
#   4. Emit a matrix-include JSON array of build entries.
#   5. Emit should-build=true. The build always runs (the daily schedule
#      rebuilds every day regardless of upstream).
#
# Outputs (written to $GITHUB_OUTPUT):
#   should-build    "true" | "false"
#   matrix-include  JSON array of {name, appId, patchRepo, patchBranch, patchSlug, patchTag}
#   repo-versions   JSON object { "owner/repo": "tag" }
#   cli-version     CLI release tag
#   cli-branch      CLI branch (echoed back for downstream steps)
#   cli-repo        CLI repo slug (echoed back for downstream steps)

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
# shellcheck source=../.github/scripts/resolve-tag.sh
. "$(dirname "$0")/../.github/scripts/resolve-tag.sh"

# --- resolve tags for every patch repo ------------------------------------

REPO_PAIRS="$(list_repo_branches)"
[ -z "$REPO_PAIRS" ] && { log_error "No valid patch_repos entries found in $CONFIG_FILE."; exit 1; }

declare -A REPO_TAGS=()
while IFS='|' read -r repo branch; do
  log "Resolving tag for ${repo} (branch=${branch})..."
  tag="$(resolve_release_tag "$repo" "$branch")"
  log "  ${repo} -> ${tag}"
  REPO_TAGS["$repo"]="$tag"
done <<< "$REPO_PAIRS"

CLI_TAG="$(resolve_release_tag "$CLI_REPO" "$CLI_BRANCH")"
log "CLI (${CLI_REPO}) -> ${CLI_TAG}"

# --- build matrix-include -------------------------------------------------

MATRIX_INCLUDE="$(
  jq -c '
    .patch_repos
    | to_entries
    | map({
        name: .value.name,
        appId: .key,
        patchRepo: .value.repo,
        patchBranch: (.value.branch | ascii_downcase),
        patchSlug: (.value.repo | gsub("/"; "-"))
      })
  ' "$CONFIG_FILE"
)"

# Inject the resolved patchTag per matrix entry. Using jq's --argjson
# ensures the tag map is parsed exactly once.
TAGS_JSON="$(
  for repo in "${!REPO_TAGS[@]}"; do
    printf '{"repo":"%s","tag":"%s"}\n' "$repo" "${REPO_TAGS[$repo]}"
  done | jq -sc 'map({(.repo): .tag}) | add // {}'
)"

MATRIX_WITH_TAGS="$(
  jq -c --argjson tags "$TAGS_JSON" \
    'map(. + {patchTag: ($tags[.patchRepo] // "")})' \
    <<<"$MATRIX_INCLUDE"
)"

if [ "$(jq 'length' <<<"$MATRIX_WITH_TAGS")" = "0" ]; then
  log_warn "No apps configured in patch_repos; skipping build."
  json_set_output should-build false
  json_set_output matrix-include '[]'
  json_set_output repo-versions '{}'
  json_set_output cli-version "$CLI_TAG"
  json_set_output cli-branch "$CLI_BRANCH"
  json_set_output cli-repo "$CLI_REPO"
  exit 0
fi

# Build the {owner/repo: tag} map for downstream use.
REPO_VERSIONS="$TAGS_JSON"

# --- decide + emit -------------------------------------------------------

# The build always runs. The daily schedule + the manual `update-patches`
# workflow drive meaningful version transitions.
SHOULD_BUILD=true
log "::notice::Build always runs."

json_set_output matrix-include "$MATRIX_WITH_TAGS"
json_set_output repo-versions "$REPO_VERSIONS"
json_set_output cli-version "$CLI_TAG"
json_set_output cli-branch "$CLI_BRANCH"
json_set_output cli-repo "$CLI_REPO"
json_set_output should-build "$SHOULD_BUILD"