#!/usr/bin/env bash
# resolve-tag.sh — resolve the latest release tag for a GitHub repo given a branch
#
# Usage:
#   source .github/scripts/pipeline/resolve-tag.sh
#   tag="$(resolve_release_tag "owner/repo" "branch")"
#
# Requires GH_TOKEN in environment.

resolve_release_tag() {
  local repo="$1"
  local branch="$2"
  local stable_tag selected_tag

  stable_tag="$(gh release view --repo "$repo" --json tagName -q .tagName || true)"

  if [ "$branch" = "main" ]; then
    selected_tag="$stable_tag"
  else
    selected_tag="$(
      gh api "repos/${repo}/releases?per_page=100" --jq '
        [ .[]
          | select(
              (.draft != true)
              and (
              ((.target_commitish // "" | ascii_downcase) == "dev")
              or (.prerelease == true)
              or ((.tag_name // "" | ascii_downcase | test("(^|[-_.])(dev|beta|alpha|rc)")))
              )
            )
        ][0].tag_name // empty
      ' || true
    )"
    if [ -z "$selected_tag" ]; then
      echo "No dev-style release found for ${repo}; falling back to latest."
      selected_tag="$stable_tag"
    fi
  fi

  if [ -z "$selected_tag" ]; then
    echo "::error::Could not resolve release tag for ${repo} (branch=${branch})."
    exit 1
  fi

  # Strip any CR/LF the upstream release API might have returned.
  # resolve_release_tag's output is written to $GITHUB_OUTPUT via
  # KEY=VALUE lines; a newline in the tag would inject extra keys.
  selected_tag="${selected_tag//$'\r'/}"
  selected_tag="${selected_tag//$'\n'/}"
  echo "$selected_tag"
}
