#!/usr/bin/env bash
#
# scripts/lib/json.sh — JSON helpers built on top of jq.
#
# Sourced, not executed. Provides:
#   - jq_required (verify jq is present and a sane version)
#   - jq_get   (jq -r '.foo.bar' <file>)
#   - jq_raw   (raw-mode access with default)
#   - jq_has   (jq -e 'has("foo")' <file>)
#   - json_update (in-place update using an arbitrary jq filter)
#
# All helpers route through `jq` so we never parse JSON with sed/grep
# — which the existing workflow already notes is fragile. Centralising
# the JSON access here also means future changes (e.g. yq support,
# alternate JSON tooling) only touch one file.

# shellcheck source=./common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

jq_required() {
  require_command jq || return 1
  # Anything older than 1.5 is unsupported on this project. Bump as
  # features are needed.
  local ver
  ver="$(jq --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -n1 || echo '0')"
  if [ "$(printf '%s\n' "1.5" "$ver" | sort -V | head -n1)" != "1.5" ]; then
    log_warn "jq $ver detected; >= 1.5 is recommended."
  fi
}

# jq_get <expr> <file> [default]
#   expr: a jq expression evaluated against the file's root (no leading dot).
#   default: returned when jq yields null/empty. Defaults to ''.
# Example: jq_get '.patch_repos | length' config.json
jq_get() {
  local expr="$1"
  local file="$2"
  local default="${3:-}"
  require_file "$file" >/dev/null || return 1
  jq -r "$expr // \"$default\"" "$file"
}

# jq_has <expr> <file>
#   Returns 0 if the expression is truthy, non-zero otherwise. Same shape
#   as `jq -e` but with our logging/error conventions.
jq_has() {
  local expr="$1"
  local file="$2"
  require_file "$file" >/dev/null || return 1
  jq -e "$expr" "$file" >/dev/null 2>&1
}

# json_update <file> <jq-filter> [jq-args...]
#   Rewrite <file> in place using jq. The filter is run as the LAST
#   argument so callers can use `--arg`/`--argjson` for templated values.
#
# Example:
#   json_update config.json '.cli_version = $v' --arg v v1.9.0
json_update() {
  local file="$1"
  local filter="$2"
  shift 2
  require_file "$file" >/dev/null || return 1
  local tmp
  tmp="$(mktemp)"
  # shellcheck disable=SC2068
  jq "$@" "$filter" "$file" > "$tmp"
  mv "$tmp" "$file"
}

# json_merge_at <file> <path> <jq-obj>
#   Merge a jq-supplied object as the value at <path>. Equivalent to
#   jq -s '.[0] * .[1]' but easier to call from bash:
#   json_merge_at config.json '.patch_repos' "$patches_map"
json_merge_at() {
  local file="$1"
  local path="$2"
  local obj="$3"
  json_update "$file" "setpath($path; $obj)"
}

# json_set_env <key> <value>
#   Append "KEY=VALUE" to $GITHUB_ENV (if set). Centralised so scripts
#   don't sprinkle `>> "$GITHUB_ENV"` everywhere.
json_set_env() {
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf '%s=%s\n' "$1" "$2" >> "$GITHUB_ENV"
  fi
}

# json_set_output <key> <value>
#   Append "KEY=VALUE" to $GITHUB_OUTPUT (if set) and echo it to stdout
#   for log visibility.
json_set_output() {
  local key="$1"
  local value="${2:-}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT"
  fi
  printf '%s=%s\n' "$key" "$value"
}