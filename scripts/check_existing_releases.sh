#!/usr/bin/env bash
#
# scripts/check_existing_releases.sh — thin wrapper that delegates to
# the Node.js implementation. Kept as a shell script for consistency
# with the rest of scripts/ (every other step has a shell
# orchestrator on this side).
#
# See .github/scripts/check-existing-releases.js for the actual
# implementation. The Node.js script does the env-dependent work
# (java -jar morphe-desktop list-versions + gh release view) and
# the pure keep/skip decision; this wrapper just validates env vars
# and hands off.
#
# Environment:
#   REPO_VERSIONS  required  JSON object {repo:tag} from check-versions
#   TOOLS_DIR      required  where morphe-desktop.jar + *.mpp live
#   GITHUB_OUTPUT  required  workflow output file
#   CONFIG_FILE    optional  default ./config.json
#
# Outputs (written to $GITHUB_OUTPUT):
#   matrix-include   filtered matrix
#   skip-list        JSON array of appIds skipped
#   should-build     "true" | "false"  (overrides check-versions)

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

if [ -z "${REPO_VERSIONS:-}" ]; then
  log_error "REPO_VERSIONS is empty; check-versions must run first."
  exit 1
fi
if [ -z "${GITHUB_OUTPUT:-}" ]; then
  log_error "GITHUB_OUTPUT is not set; this script must run inside a workflow step."
  exit 1
fi

exec node "$(dirname "$0")/../.github/scripts/check-existing-releases.js"
