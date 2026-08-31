#!/usr/bin/env bash
#
# Resolve patch repository release tags and sync patches.json.
# Extracted from .github/workflows/update-patches.yml so the workflow
# remains focused on checkout, orchestration, and commit/push steps.
#
# Requires: jq and GitHub CLI commands used by resolve-tag.sh (gh).

set -euo pipefail

CONFIG_FILE="${CONFIG_FILE:-./config.json}"
PATCHES_FILE="${PATCHES_FILE:-./patches.json}"
RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
REPO_VERSIONS="${REPO_VERSIONS:-{}}"

if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is required for patches.json sync."
  exit 1
fi

# Validate required config keys.
if ! jq -e '.patch_repos | type == "object" and length > 0' "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "::error::$CONFIG_FILE is missing or empty 'patch_repos'. Add per-app repo assignments."
  exit 1
fi
if ! jq -e '.cli | has("repo") and has("branch")' "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "::error::$CONFIG_FILE is missing 'cli.repo' or 'cli.branch'."
  exit 1
fi

# Resolve branch -> tag using the same helper as the build workflow.
source .github/scripts/pipeline/resolve-tag.sh

# Build a list of unique repo+branch pairs from config.json.
REPO_PAIRS="$(jq -r '
  .patch_repos
  | to_entries
  | map(.value | "\(.repo)|\(.branch)")
  | unique[]
' "$CONFIG_FILE")"

# Resolve a tag for each unique repo+branch pair.
declare -A REPO_TAGS
while IFS='|' read -r repo branch; do
  echo "Resolving tag for ${repo} (branch=${branch})..."
  tag="$(resolve_release_tag "$repo" "$branch")"
  echo "  -> ${tag}"
  REPO_TAGS["$repo"]="$tag"
done <<< "$REPO_PAIRS"

# Pack the results into the {repo: tag} JSON object consumed by
# .github/scripts/pipeline/sync-patches.sh.
REPO_VERSIONS="$(
  for repo in "${!REPO_TAGS[@]}"; do
    echo "{\"repo\":\"$repo\",\"tag\":\"${REPO_TAGS[$repo]}\"}"
  done | jq -sc 'map({(.repo): .tag}) | add // {}'
)"

REPO_VERSIONS="$REPO_VERSIONS" \
  CONFIG_FILE="$CONFIG_FILE" \
  PATCHES_FILE="$PATCHES_FILE" \
  RUNNER_TEMP="$RUNNER_TEMP" \
  bash .github/scripts/pipeline/sync-patches.sh
