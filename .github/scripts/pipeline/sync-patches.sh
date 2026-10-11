#!/usr/bin/env bash
# Resolve tags with scripts/sync-patches.sh before calling this entry point.
set -Eeuo pipefail
: "${REPO_VERSIONS:?REPO_VERSIONS must be set}"
node "$(dirname "$0")/../sync-patch-selections.js"
