#!/usr/bin/env bash
# Delete every artifact uploaded by the current workflow run.
# A failed delete only warns: the artifact still expires at its retention date.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

ids="$(gh api --paginate "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/artifacts" --jq '.artifacts[].id')"

for id in $ids; do
  if gh api -X DELETE "repos/${GITHUB_REPOSITORY}/actions/artifacts/${id}"; then
    log "Deleted artifact ${id}"
  else
    log_warn "Could not delete artifact ${id}; it will expire at its retention date."
  fi
done
