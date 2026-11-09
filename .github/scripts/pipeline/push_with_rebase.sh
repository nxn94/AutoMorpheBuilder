#!/usr/bin/env bash
# Push HEAD to a branch, rebasing onto newer commits if the push is rejected
# because something else landed on the branch after checkout.
#
# Usage: push_with_rebase.sh <push-url> <branch>
# PUSH_RETRY_DELAY overrides the seconds between attempts (default 3).
#
# A rebase conflict stops with an error rather than overwriting either side.

set -Eeuo pipefail

PUSH_URL="$1"
BRANCH="$2"
DELAY="${PUSH_RETRY_DELAY:-3}"

for attempt in 1 2 3 4 5; do
  if git push "$PUSH_URL" "HEAD:${BRANCH}"; then
    exit 0
  fi
  [ "$attempt" -lt 5 ] || break
  echo "::warning::Push to ${BRANCH} was rejected (attempt ${attempt}/5); rebasing and retrying."
  sleep "$DELAY"
  if ! git pull --rebase "$PUSH_URL" "$BRANCH"; then
    git rebase --abort 2>/dev/null || true
    echo "::error::Could not rebase onto ${BRANCH}; re-run this workflow."
    exit 1
  fi
done

echo "::error::Could not push to ${BRANCH} after 5 attempts; re-run this workflow."
exit 1
