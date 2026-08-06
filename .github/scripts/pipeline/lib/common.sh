#!/usr/bin/env bash
#
# scripts/lib/common.sh — shared helpers used by every script.
#
# Sourced, not executed. Provides:
#   - logging helpers (log, log_warn, log_error)
#   - require_command, require_env, require_file
#   - with_retry (generic curl wrapper)
#   - run_with_timeout wrapper
#   - safe_dir / safe_tmp
#
# Strict mode is set inside every helper script that sources this library.
# Callers should still write `set -Eeuo pipefail` at the top of their own
# file — this library does NOT impose strict mode by itself so it can be
# sourced from contexts that legitimately want a different mode (tests,
# wrappers that disable -e around a command, etc.).
#
# Public API is prefixed lib_ or is the bare helper name. Names not
# starting with lib_ are kept short for readability at call sites.

# --- logging ---------------------------------------------------------------

log()    { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
log_warn()  { printf '::warning::%s\n' "$*" >&2; }
log_error() { printf '::error::%s\n' "$*" >&2; }

# --- validation ------------------------------------------------------------

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log_error "$cmd is required but not installed."
    return 127
  fi
}

require_env() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    log_error "Required environment variable $name is empty."
    return 1
  fi
  printf '%s' "$value"
}

require_file() {
  local path="$1"
  if [ ! -f "$path" ]; then
    log_error "Required file not found: $path"
    return 1
  fi
  printf '%s' "$path"
}

# --- retry -----------------------------------------------------------------
#
# with_retry <max-attempts> <initial-delay-secs> <command...>
#
# Runs the command, retrying up to max-attempts times with exponential
# backoff. Each call prints a one-line status to stderr. The function
# returns the last command's exit status.
#
# Use this for *idempotent* network operations only (curl + a sane
# destination). Never retry non-idempotent operations (POST, git push).

with_retry() {
  local max_attempts="$1"
  local delay="$2"
  shift 2

  local attempt=1
  while true; do
    if "$@"; then
      return 0
    fi
    local rc=$?
    if [ "$attempt" -ge "$max_attempts" ]; then
      return "$rc"
    fi
    log_warn "  attempt $attempt/$max_attempts failed (rc=$rc); retrying in ${delay}s..."
    sleep "$delay"
    delay=$((delay * 2))
    attempt=$((attempt + 1))
  done
}

# --- tempdir / cleanup -----------------------------------------------------
#
# safe_tmpdir creates an isolated scratch dir under ${TMPDIR:-/tmp} and
# registers a trap that removes it on EXIT. Use this anywhere a script
# needs temp files so failures still clean up.

safe_tmpdir() {
  local prefix="${1:-scratch}"
  local dir
  dir="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
  # shellcheck disable=SC2064  # we want $dir expanded at trap-registration time
  trap "rm -rf '$dir'" EXIT
  printf '%s' "$dir"
}

# --- output capture --------------------------------------------------------
#
# Capture stdout of a command into a variable while still surfacing
# failures. Convenience wrapper for `var=$(cmd)` that won't silently
# swallow a non-zero status under set -e.

capture() {
  local out
  out="$("$@")"
  printf '%s' "$out"
}