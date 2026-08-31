#!/usr/bin/env bash
#
# .github/scripts/sync-patches.sh
#
# Sync patches.json with upstream patch repos, preserving user toggles.
# Extracted from the duplicated jq merge logic that previously lived
# inline in both .github/workflows/update-patches.yml and the
# morphe-build.yml workflow. Now only invoked by the manual
# update-patches.yml workflow.
#
# Usage:
#   REPO_VERSIONS='{"MorpheApp/morphe-patches":"v1.24.0-dev.8"}' \
#     bash .github/scripts/sync-patches.sh
#
# Environment:
#   REPO_VERSIONS  (required) JSON object {"owner/repo": "tag", ...} mapping
#                   each unique patch repo to its resolved release tag.
#   CONFIG_FILE    (optional) Path to config.json (default: ./config.json).
#   PATCHES_FILE   (optional) Path to patches.json (default: ./patches.json).
#   RUNNER_TEMP    (optional) Scratch dir for intermediate files
#                   (default: ${TMPDIR:-/tmp}).
#
# Reads:
#   config.json (validates patch_repos, cli.repo, cli.branch).
#   patches.json (existing user toggles; flat shape is treated as empty).
#   Each upstream patches-list.json at the resolved tag.
#
# Writes:
#   patches.json (overwritten with the merged result).
#
# Requires: jq, curl, bash.

set -euo pipefail

CONFIG_FILE="${CONFIG_FILE:-./config.json}"
PATCHES_FILE="${PATCHES_FILE:-./patches.json}"
RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"

if [ -z "${REPO_VERSIONS:-}" ]; then
  echo "::error::REPO_VERSIONS env var must be set (JSON object mapping owner/repo -> tag)"
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq is required for patches.json sync."
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "::error::curl is required for patches.json sync."
  exit 1
fi

if ! jq -e '.patch_repos | type == "object" and length > 0' "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "::error::$CONFIG_FILE is missing or empty 'patch_repos'."
  exit 1
fi
if ! jq -e '.cli | has("repo") and has("branch")' "$CONFIG_FILE" >/dev/null 2>&1; then
  echo "::error::$CONFIG_FILE is missing 'cli.repo' or 'cli.branch'."
  exit 1
fi

# Build list of unique repo+branch pairs from config.json.
REPO_PAIRS="$(jq -r '
  .patch_repos
  | to_entries
  | map(.value | "\(.repo)|\(.branch | ascii_downcase)")
  | unique[]
' "$CONFIG_FILE")"

if [ -z "$REPO_PAIRS" ]; then
  echo "::warning::No repos in patch_repos; skipping patches.json sync."
  exit 0
fi

WORK_DIR="$(mktemp -d "${RUNNER_TEMP%/}/sync-patches.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# Fetch patches-list.json for each unique repo at its resolved tag.
mkdir -p "$WORK_DIR/lists"
while IFS='|' read -r repo branch; do
  slug="${repo//\//-}"
  tag="$(echo "$REPO_VERSIONS" | jq -r --arg r "$repo" '.[$r] // empty')"
  if [ -z "$tag" ]; then
    echo "::warning::No resolved tag for ${repo}; skipping patches sync for this repo."
    continue
  fi
  url="https://raw.githubusercontent.com/${repo}/${tag}/patches-list.json"
  # Hardened curl: --fail exits non-zero on 4xx/5xx; --max-time /
  # --connect-timeout cap handshake stalls; --retry-all-errors covers
  # connection-level failures. No outer with_retry here — sync-patches
  # is best-effort per repo (warns + continues on failure) so a
  # transient network blip on one upstream shouldn't block the others.
  if ! curl \
       --fail \
       --location \
       --show-error \
       --silent \
       --connect-timeout 15 \
       --max-time 300 \
       --retry 3 \
       --retry-delay 5 \
       --retry-all-errors \
       --output "$WORK_DIR/lists/${slug}.json" \
       "$url"; then
    echo "::warning::Failed to fetch patches-list.json for ${repo}; skipping."
  fi
done <<< "$REPO_PAIRS"

# Determine if existing patches.json is repo-keyed. Old flat shape is
# treated as empty so the migration run starts from a clean slate.
EXISTING_IS_REPO_KEYED=false
if [ -s "$PATCHES_FILE" ] && jq -e 'type=="object"' "$PATCHES_FILE" >/dev/null 2>&1; then
  if jq -e 'keys | map(select(contains("/"))) | length > 0' "$PATCHES_FILE" >/dev/null 2>&1; then
    EXISTING_IS_REPO_KEYED=true
  fi
fi

if [ "$EXISTING_IS_REPO_KEYED" = "true" ]; then
  echo "::notice::Existing patches.json is repo-keyed; preserving user toggles."
  cp "$PATCHES_FILE" "$WORK_DIR/patches_base.json"
else
  echo "::warning::Existing patches.json is flat or empty; resetting all toggles to true (migration run)."
  echo '{}' > "$WORK_DIR/patches_base.json"
fi

# compat_pkg_names helper — same shape as the Node.js
# resolve-supported-version.js helper, so the shell pipeline and the
# Node APK version resolver agree on which package IDs a patch supports.
# Handles four historical shapes of patches-list.json:
#   1. compatiblePackages as object (old): keys ARE the package IDs
#   2. compatible_packages as object (old): keys ARE the package IDs
#   3. compatiblePackages as array (current):
#        each entry has BOTH .name (friendly label, e.g. "YouTube")
#        AND .packageName (package id, e.g. "com.google.android.youtube").
#        Both must be returned so the filter below matches whichever
#        form the caller's config.json uses.
#   4. compatible_packages as array: same as #3.
COMPAT_FN='
  def compat_pkg_names($patch):
    if ($patch.compatiblePackages? | type) == "object" then
      ($patch.compatiblePackages | keys)
    elif ($patch.compatible_packages? | type) == "object" then
      ($patch.compatible_packages | keys)
    elif ($patch.compatiblePackages? | type) == "array" then
      ([$patch.compatiblePackages[] | (.name // empty), (.packageName // empty)]
        | map(select(. != "")) | unique)
    elif ($patch.compatible_packages? | type) == "array" then
      ([$patch.compatible_packages[] | (.name // empty), (.packageName // empty)]
        | map(select(. != "")) | unique)
    else
      []
    end;
'

# Build defaults + merge for each repo, accumulating into patches_base.json.
while IFS='|' read -r repo branch; do
  slug="${repo//\//-}"
  PATCHES_LIST="$WORK_DIR/lists/${slug}.json"
  [ -f "$PATCHES_LIST" ] || continue

  # Apps assigned to this repo in config.json.
  APPS_FOR_REPO="$(jq -c --arg r "$repo" '
    [.patch_repos | to_entries[]
      | select(.value.repo == $r)
      | .key]
  ' "$CONFIG_FILE")"

  # Defaults: every compatible patch for every assigned app, true.
  jq --argjson apps "$APPS_FOR_REPO" "$COMPAT_FN"'
    . as $src
    | reduce $apps[] as $pkg ({};
        .[$pkg] = (
          reduce (
            (($src.patches // $src)[])
            | select((compat_pkg_names(.) | index($pkg)) != null)
            | .name
          ) as $name
          ({};
            .[$name] = true
          )
        )
      )
  ' "$PATCHES_LIST" > "$WORK_DIR/defaults_${slug}.json"

  # Merge defaults with existing user toggles for this repo.
  # Key rule: only upstream patch names survive (stale keys are dropped).
  # For each patch name present in upstream, use the existing user toggle
  # if it was explicitly set (including explicit `false`), otherwise
  # default to true.
  # jq's `//` falls back on both `null` AND `false`, so it would silently
  # turn user-set `false` toggles back to `true`. `has()` is key-only.
  jq -n \
    --arg repo "$repo" \
    --slurpfile defaults "$WORK_DIR/defaults_${slug}.json" \
    --slurpfile base "$WORK_DIR/patches_base.json" '
    ($defaults[0] // {}) as $d
    | ($base[0] // {}) as $existing
    | ($existing[$repo] // {}) as $repo_existing
    | reduce ($d | keys[]) as $pkg (.;
        ($repo_existing[$pkg] // {}) as $pkg_existing
        | .[$pkg] = reduce ($d[$pkg] | keys[]) as $pname ({};
            .[$pname] = (if $pkg_existing | has($pname) then $pkg_existing[$pname] else true end)
          )
      )
    ' > "$WORK_DIR/merged_${slug}.json"

  # Inject merged section back into base.
  jq --arg repo "$repo" \
     --slurpfile merged "$WORK_DIR/merged_${slug}.json" \
     '.[$repo] = $merged[0]' \
     "$WORK_DIR/patches_base.json" > "$WORK_DIR/patches_next.json"
  mv "$WORK_DIR/patches_next.json" "$WORK_DIR/patches_base.json"
done <<< "$REPO_PAIRS"

# Drop repos not in config.json from the result.
ACTIVE_REPOS="$(jq -c '[.patch_repos | to_entries[] | .value.repo] | unique' "$CONFIG_FILE")"
jq --argjson active "$ACTIVE_REPOS" \
  'with_entries(select(.key as $k | $active | index($k) != null))' \
  "$WORK_DIR/patches_base.json" > "$PATCHES_FILE.tmp"
mv "$PATCHES_FILE.tmp" "$PATCHES_FILE"

echo "::notice::patches.json synced."
jq 'keys' "$PATCHES_FILE"