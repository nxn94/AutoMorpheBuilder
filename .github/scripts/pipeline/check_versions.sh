#!/usr/bin/env bash
#
# scripts/check_versions.sh — resolve the latest Morphe / CLI release
# tags and emit the build matrix. The should-build decision is made
# later, in check_existing_releases.sh, which can short-circuit the
# build when every app already has a current release.
#
# Replaces the ~140-line inline `run:` block in the workflow's
# check-versions job. The behaviour is identical except for the
# should-build contract:
#   1. Validate config.json shape.
#   2. For every unique patch_repo+branch, resolve the latest matching
#      tag using resolve-tag.sh.
#   3. Resolve the CLI tag.
#   4. Emit a matrix-include JSON array of build entries (the FULL
#      matrix — filtering happens in check_existing_releases.sh).
#   5. Emit should-build=true as the optimistic default. The
#      check_existing_releases.sh step (run later in the same job, after
#      the morphe-desktop jar + .mpp files are downloaded) overrides
#      this to false if every app's release already exists.
#
# Outputs (written to $GITHUB_OUTPUT):
#   should-build    "true" | "false"  (default true; overridden downstream)
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
# shellcheck source=../resolve-tag.sh
. "$(dirname "$0")/../resolve-tag.sh"

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