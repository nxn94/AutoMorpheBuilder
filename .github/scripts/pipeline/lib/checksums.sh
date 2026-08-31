#!/usr/bin/env bash
#
# scripts/lib/checksums.sh — SHA-256 manifest lookup helpers.
#
# Sourced, not executed. Centralises the parsing of
# `checksums/tools.sha256` so the install / fetch scripts can consult
# a single source of truth for expected digests.
#
# Manifest format (see `docs/checksums.md`):
#
#   # comment
#   <sha256>  <artifact-name>  # optional human note
#
# Lines starting with `#` and blank lines are ignored. SHA column must
# match `^[0-9a-fA-F]{64}$` for the entry to be considered "pinned" —
# anything else (TODO placeholders, blank entries, malformed rows) is
# treated as "no verification requested, fall back to the existing
# tag-based check".
#
# Public API:
#   tools_sha_lookup <artifact-name>
#     Prints the expected SHA-256 for <artifact-name>, or empty string
#     when the manifest is missing, the artifact is not present, or
#     the entry is a TODO placeholder. Never errors — callers should
#     branch on the empty string to decide whether to skip SHA
#     verification.
#   tools_sha_pinned <artifact-name>
#     Returns 0 when tools_sha_lookup returns a non-empty SHA, 1
#     otherwise. Convenience for `if tools_sha_pinned foo; then ...`.

# shellcheck source=./common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

CHECKSUMS_FILE="${CHECKSUMS_FILE:-./checksums/tools.sha256}"

# tools_sha_lookup <artifact-name>
#   Reads CHECKSUMS_FILE and returns the expected SHA-256 for the
#   given artifact name (matches the second whitespace-separated
#   column of the manifest). Returns '' if absent, TODO, or file
#   missing. Never errors.
tools_sha_lookup() {
  local artifact="$1"
  [ -f "$CHECKSUMS_FILE" ] || { printf ''; return 0; }
  awk -v want="$artifact" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      sha = $1
      name = $2
      sub(/[[:space:]]*#.*$/, "", name)  # strip inline comment + trailing ws
      gsub(/[[:space:]]+$/, "", name)
      if (name != want) next
      if (sha ~ /^[0-9a-fA-F]{64}$/) {
        print sha
        found = 1
        exit
      }
      # Non-empty second column but no valid SHA → TODO placeholder;
      # return empty so callers can fall back.
      exit
    }
    END {
      if (!found) exit 0
    }
  ' "$CHECKSUMS_FILE"
}

# tools_sha_pinned <artifact-name>
#   Returns 0 when tools_sha_lookup yields a valid SHA, 1 otherwise.
#   Use as a guard: `if tools_sha_pinned morphe-desktop.jar; then ...`.
tools_sha_pinned() {
  local sha
  sha="$(tools_sha_lookup "$1")"
  [ -n "$sha" ]
}
