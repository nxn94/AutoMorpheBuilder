#!/usr/bin/env bash
#
# scripts/prune_old_releases.sh — thin wrapper that delegates to the
# Node.js implementation. Mirrors check_existing_releases.sh's wrapper
# style so the pipeline stays uniform.
#
# See .github/scripts/prune-old-releases.js for the actual logic. The
# Node.js script does the env-dependent `gh release list` /
# `gh release delete` calls and the pure keep/delete decision; this
# wrapper just validates env vars and hands off.
#
# Environment:
#   CONFIG_FILE   optional  default ./config.json
#   KEEP_COUNT    optional  default 2 (non-negative integer)
#   GH_TOKEN      required  the workflow's GITHUB_TOKEN

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

if [ -z "${GH_TOKEN:-}" ]; then
  log_error "GH_TOKEN is required for GitHub API access."
  exit 1
fi

exec node "$(dirname "$0")/../prune-old-releases.js"