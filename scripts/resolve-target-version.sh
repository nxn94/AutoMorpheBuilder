#!/usr/bin/env bash
#
# Resolve the Morphe-supported target version for an app.
# Extracted from .github/workflows/morphe-build.yml so the workflow
# remains focused on orchestration and downstream APK download steps.
#
# Environment:
#   APP_ID          Required package/application ID.
#   PATCH_REPO      Required owner/repo used to locate the patch bundle.
#   TOOLS_DIR       Optional directory containing Morphe tools (default: tools).
#   PINNED_VERSION  Optional pinned version; use "null" to request resolution.
#   GITHUB_OUTPUT   Optional GitHub Actions output file.

set -euo pipefail

APP_ID="${APP_ID:-}"
PATCH_REPO="${PATCH_REPO:-}"
TOOLS_DIR="${TOOLS_DIR:-tools}"
PINNED_VERSION="${PINNED_VERSION:-}"

if [ -z "$APP_ID" ] || [ -z "$PATCH_REPO" ]; then
  echo "::error::APP_ID and PATCH_REPO are required"
  exit 1
fi

slug="${PATCH_REPO//\//-}"
mpp="$TOOLS_DIR/${slug}.mpp"
jar="$TOOLS_DIR/morphe-desktop.jar"

if [ ! -f "$jar" ] || [ ! -f "$mpp" ]; then
  echo "::error::morphe-desktop jar or $mpp missing"
  exit 1
fi

if [ -n "$PINNED_VERSION" ] && [ "$PINNED_VERSION" != "null" ]; then
  version="$PINNED_VERSION"
else
  # The CLI does not guarantee latest-first ordering. Sort versions
  # descending so Twitch's 16.9.1 does not beat a later 25.3.0.
  # The numeric matcher accepts two-, three-, and four-segment versions.
  version="$(java -jar "$jar" list-versions -f "$APP_ID" --patches="$mpp" \
    | grep -oE '[0-9]+(\.[0-9]+)+' | sort -Vr | head -n1 || true)"
fi

if [ -z "$version" ]; then
  echo "::error::Could not resolve a Morphe-supported version for $APP_ID"
  exit 1
fi

if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "version=$version"
  echo "versions=$version"
else
  echo "version=$version" >> "$GITHUB_OUTPUT"
  echo "versions=$version" >> "$GITHUB_OUTPUT"
fi
echo "Selected version for $APP_ID: $version"
