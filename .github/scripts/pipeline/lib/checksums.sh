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
#   tools_sha_pinned_version <artifact-name>
#     Prints the version annotation (e.g. `v1.15.1`) from the pin row
#     for <artifact-name>, preserving any leading `v`, or empty when
#     the manifest is missing, the artifact is not present, or the
#     row carries no parseable `# vX.Y.Z` comment. Callers use this
#     to distinguish a stale pin from a true tamper signal: when the
#     pinned version disagrees with the running CLI_TAG, the SHA
#     mismatch is a CLI bump (refresh and continue); when it agrees,
#     the SHA mismatch is a republish attack (fail closed).

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

# tools_sha_pinned_version <artifact-name>
#   Reads CHECKSUMS_FILE and returns the version annotation embedded
#   in the pin row for <artifact-name> — the first token after the
#   trailing `#` comment, when it matches `v?[0-9]+(\.[0-9]+)+...`.
#   For a row like:
#       <sha>  morphe-desktop.jar  # v1.15.1  (verified via ...)
#   this prints `v1.15.1` (leading `v` preserved). Returns '' when the
#   manifest is missing, the artifact is not present, the row's SHA is
#   not a real hex digest (so the row is treated as a TODO), or the
#   comment carries no parseable version. Callers should branch on the
#   empty string — an unparseable version is treated as "indistinguish-
#   able from tamper" so callers fail closed when in doubt.
tools_sha_pinned_version() {
  local artifact="$1"
  [ -f "$CHECKSUMS_FILE" ] || { printf ''; return 0; }
  # Match rows that look like a real pin (64-hex SHA + artifact name +
  # `# v...` comment) and capture the first whitespace-delimited token
  # after the `#`. `[[:space:]]+` collapses any run of spaces between
  # the SHA, the name, and the `#`. The regex is anchored to start-of-
  # line so leading `#` comment lines and blank rows are skipped.
  local row_ver
  row_ver="$(
    grep -E "^[[:space:]]*[0-9a-fA-F]{64}[[:space:]]+${artifact}[[:space:]]+#" \
      "$CHECKSUMS_FILE" 2>/dev/null \
      | head -n1 \
      | sed -nE 's/^[[:space:]]*[0-9a-fA-F]{64}[[:space:]]+[^[:space:]]+[[:space:]]+#[[:space:]]*([vV]?[0-9]+(\.[0-9]+)+([._-][0-9A-Za-z]+)*).*/\1/p' \
      || true
  )"
  printf '%s' "$row_ver"
}
