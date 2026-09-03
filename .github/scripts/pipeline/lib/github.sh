#!/usr/bin/env bash
#
# scripts/lib/github.sh — wrappers around the GitHub CLI.
#
# Sourced, not executed. Centralises every `gh ...` invocation in the
# project so we can:
#   - assert GH_TOKEN is set once (instead of repeating per call)
#   - apply consistent retry / timeout behavior
#   - switch to a different tool (curl against the API) in tests
#
# Public API:
#   gh_require_token            — die if GH_TOKEN not set
#   gh_release_tag <repo>       — echo the latest release tag
#   gh_release_view <repo> [args...]
#   gh_asset_sha256 <repo> <tag> <asset-name>
#                                echo the hex SHA-256 of the named asset
#                                on <repo>@<tag>'s release, or empty if the
#                                asset isn't published or lacks a digest.
#   gh_release_download <repo> <tag> <pattern> <dir>
#   gh_release_create <tag> <files...> --title X --notes Y
#   gh_release_upload <tag> <files...>
#   gh_release_edit <tag> [args...]

# shellcheck source=./common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

gh_require_token() {
  if [ -z "${GH_TOKEN:-}" ]; then
    log_error "GH_TOKEN is required for GitHub API access."
    return 1
  fi
  require_command gh || return 1
}

gh_release_tag() {
  local repo="$1"
  gh_require_token || return 1
  gh release view --repo "$repo" --json tagName -q .tagName 2>/dev/null
}

gh_release_view() {
  local repo="$1"
  shift
  gh_require_token || return 1
  gh release view --repo "$repo" "$@"
}

# GitHub computes and serves the SHA-256 (typically) of every release
# asset in the `digest` field of the release JSON. We use that as the
# authoritative hash when verifying a freshly downloaded artifact, so
# CI doesn't depend on a hand-pinned value in `checksums/tools.sha256`
# surviving every CLI bump. The pin in the manifest remains as a
# tripwire for asset-republish attacks: when both are present they
# must agree, and a disagreeing pin is treated as a tamper signal
# (see scripts/lib/checksums.sh for the verify-side policy and
# docs/checksums.md for the contract).
#
# Echoes the bare hex SHA-256 of <asset-name> on <repo>@<tag>'s
# release, or "" if the asset is not published or has no digest.
# Network errors are passed through so callers can decide between
# "fall back to the local pin" vs. "hard fail with a clear message".
gh_asset_sha256() {
  local repo="$1" tag="$2" asset_name="$3"
  gh_require_token || return 1
  # `gh release view --json assets` returns an array of objects with
  # `name`, `digest` ("sha256:HEX"), and an HTTPS `url`. Filter to the
  # exact asset name so ambiguous patterns can never match the wrong
  # file. Strip the `sha256:` prefix so callers can compare with
  # `sha256sum` output byte-for-byte.
  gh release view "$tag" --repo "$repo" --json assets --jq \
    "[.assets[] | select(.name == \"${asset_name}\") | .digest][0] // empty" \
    2>/dev/null \
    | sed -E 's/^sha256://' \
    | tr -d '[:space:]'
}

gh_release_download() {
  local repo="$1" tag="$2" pattern="$3" dir="$4"
  gh_require_token || return 1
  with_retry 3 5 gh release download "$tag" \
    --repo "$repo" \
    --pattern "$pattern" \
    --dir "$dir" \
    --clobber
}

gh_release_create() {
  local tag="$1" title="$2" notes="$3"
  shift 3
  gh_require_token || return 1
  with_retry 3 5 gh release create "$tag" "$@" \
    --title "$title" \
    --notes "$notes"
}

gh_release_upload() {
  local tag="$1"
  shift
  gh_require_token || return 1
  with_retry 3 5 gh release upload "$tag" "$@" --clobber
}

gh_release_edit() {
  local tag="$1"
  shift
  gh_require_token || return 1
  gh release edit "$tag" "$@"
}