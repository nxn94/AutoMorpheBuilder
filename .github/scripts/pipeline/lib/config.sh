#!/usr/bin/env bash
#
# scripts/lib/config.sh — config.json / patches.json helpers.
#
# Sourced, not executed. Centralises the per-app lookup, pin-version
# detection, and repo↔slug conversion that the workflow repeats across
# many steps. Also exposes the active "matrix" iteration as a single
# helper so per-app steps don't all need their own jq + while loop.
#
# Repo↔slug conversion is intentionally a one-liner — the previous
# workflow inlined the `${repo//\//-}` parameter expansion in at least
# 4 places. If we ever need a different transformation (e.g. URL-encoding
# the slash) this is the only file that has to change.

# shellcheck source=./json.sh
. "$(dirname "${BASH_SOURCE[0]}")/json.sh"

CONFIG_FILE="${CONFIG_FILE:-./config.json}"
PATCHES_FILE="${PATCHES_FILE:-./patches.json}"

# repo_slug <owner/repo> -> owner-repo
repo_slug() { printf '%s' "${1//\//-}"; }

# list_app_ids
#   Emits one appId (config.json patch_repos key) per line, in stable order.
list_app_ids() {
  require_file "$CONFIG_FILE" >/dev/null || return 1
  jq -r '.patch_repos | keys[]' "$CONFIG_FILE"
}

# list_repo_branches
#   Emits "<repo>|<branch>|<pin_tag>" triples (one per unique repo). The
#   third column is the optional pin_patch_tag from config.json (empty
#   when not set). Used by check-versions and download_morphe_tools.
#   Consumers that only need repo+branch can keep using `read -r repo _`
#   since bash silently discards the third field.
list_repo_branches() {
  require_file "$CONFIG_FILE" >/dev/null || return 1
  jq -r '
    .patch_repos
    | to_entries
    | map(.value | "\(.repo)|\(.branch | ascii_downcase)|\(.pin_patch_tag // "")")
    | unique[]
  ' "$CONFIG_FILE"
}

# app_config <appId> [jq-expr]
#   Returns the slice of config.json for the given app. With no jq-expr,
#   returns the full entry; otherwise the jq-expr is applied to it.
app_config() {
  local app_id="$1"
  local expr="${2:-.}"
  require_file "$CONFIG_FILE" >/dev/null || return 1
  jq -r --arg pkg "$app_id" ".patch_repos[\$pkg] | $expr" "$CONFIG_FILE"
}

# pinned_version <appId>
#   Returns the pin_version (or '' if unset).
pinned_version() {
  local app_id="$1"
  app_config "$app_id" '.pin_version // empty' "$CONFIG_FILE"
}

# app_patches <appId>
#   Returns the patches.json entry for the given app under repo key.
app_patches() {
  local app_id="$1"
  local repo="${PATCH_REPO:-}"
  if [ -z "$repo" ]; then
    # Pick the first (and usually only) repo key in patches.json.
    repo="$(jq -r 'keys[0] // empty' "$PATCHES_FILE" 2>/dev/null)"
  fi
  require_file "$PATCHES_FILE" >/dev/null || return 1
  jq -r --arg repo "$repo" --arg pkg "$app_id" '
    .[$repo][$pkg] // {} | to_entries[] | "\(.key)=\(.value)"
  ' "$PATCHES_FILE"
}

# list_disabled_patches <appId>
#   Emits one disabled patch name per line. Used by the patch step to
#   build the morphe-desktop `-d` flag list.
list_disabled_patches() {
  local app_id="$1"
  local repo="${PATCH_REPO:-}"
  if [ -z "$repo" ]; then
    repo="$(jq -r 'keys[0] // empty' "$PATCHES_FILE" 2>/dev/null)"
  fi
  require_file "$PATCHES_FILE" >/dev/null || return 1
  jq -r --arg repo "$repo" --arg pkg "$app_id" '
    .[$repo][$pkg] // {} | to_entries[] | select(.value == false) | .key
  ' "$PATCHES_FILE"
}

# validate_required_config
#   Asserts the config.json shape the workflow relies on. Returns 0 if
#   the file is valid and complete, non-zero with an ::error:: otherwise.
validate_required_config() {
  require_file "$CONFIG_FILE" >/dev/null || return 1
  if ! jq -e '.patch_repos | type == "object" and length > 0' "$CONFIG_FILE" >/dev/null 2>&1; then
    log_error "$CONFIG_FILE is missing or empty 'patch_repos'."
    return 1
  fi
  if ! jq -e '.cli | has("repo") and has("branch")' "$CONFIG_FILE" >/dev/null 2>&1; then
    log_error "$CONFIG_FILE is missing 'cli.repo' or 'cli.branch'."
    return 1
  fi
}

# auto_update_urls_enabled
#   Returns 0 when config.json's `auto_update_urls` flag is truthy (or
#   absent, for backward compatibility with existing configs), non-zero
#   when explicitly disabled. The pre-download step honours this to
#   decide whether to write back resolved URLs into config.json.
auto_update_urls_enabled() {
  require_file "$CONFIG_FILE" >/dev/null || return 1
  local flag
  flag="$(jq -r '.auto_update_urls // true' "$CONFIG_FILE" 2>/dev/null)"
  case "$flag" in
    true|True|TRUE|1|yes|YES) return 0 ;;
    *)                        return 1 ;;
  esac
}