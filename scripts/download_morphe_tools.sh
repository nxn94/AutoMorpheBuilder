#!/usr/bin/env bash
#
# scripts/download_morphe_tools.sh — download the morphe-desktop .jar and
# per-repo .mpp files needed by the build matrix.
#
# Replaces the ~50-line `run:` block in the workflow's "Resolve latest
# APK versions from APKMirror" step. The new layout reads REPO_VERSIONS
# (from $GITHUB_OUTPUT of check-versions) and CLI_TAG/CLI_REPO from the
# workflow environment and downloads the right artifacts to $TOOLS_DIR.
#
# Behaviour matches the original step:
#   - mkdir tools/ (idempotent)
#   - gh release download <CLI_TAG> --pattern '*.jar' → tools/morphe-desktop.jar
#   - For each unique patch_repo at its resolved tag:
#       gh release download <tag> --pattern 'patches-*.mpp' → tools/<slug>.mpp
#
# After this script, $TOOLS_DIR contains:
#   morphe-desktop.jar       (always, if CLI release download succeeded)
#   <repo-slug>.mpp          (one per unique patch_repo)
#
# Hard-fails if the CLI .jar or any required .mpp cannot be obtained.
# The previous workflow exited 0 when the CLI .jar was missing; this
# preserves that behaviour because the subsequent APK-resolution step
# also depends on it. We log a warning so the absence is visible.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"
. "$(dirname "$0")/lib/github.sh"

TOOLS_DIR="${TOOLS_DIR:-./tools}"
REPO_VERSIONS="${REPO_VERSIONS:-}"
CLI_REPO="${CLI_REPO:-}"
CLI_TAG="${CLI_TAG:-}"

if [ -z "$CLI_REPO" ] || [ -z "$CLI_TAG" ]; then
  log_error "CLI_REPO and CLI_TAG must be set in the environment."
  exit 1
fi
if [ -z "$REPO_VERSIONS" ]; then
  log_error "REPO_VERSIONS must be set (JSON object of {repo:tag})."
  exit 1
fi

mkdir -p "$TOOLS_DIR"

# --- CLI jar --------------------------------------------------------------

if [ ! -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
  log "Downloading morphe-desktop ${CLI_TAG}..."
  # Releases <= v1.10.x shipped as morphe-cli-X.Y.Z-all.jar under the old
  # MorpheApp/morphe-cli repo. Current releases use morphe-desktop-*; accept
  # either name so legacy pins still resolve.
  gh_release_download "$CLI_REPO" "$CLI_TAG" "morphe-desktop-*-all.jar" "$TOOLS_DIR" || true
  for f in "$TOOLS_DIR"/morphe-desktop-*-all.jar "$TOOLS_DIR"/morphe-cli-*-all.jar; do
    [ -f "$f" ] || continue
    if [ "$f" != "$TOOLS_DIR/morphe-desktop.jar" ]; then
      mv "$f" "$TOOLS_DIR/morphe-desktop.jar"
      log "  moved $(basename "$f") -> morphe-desktop.jar"
    fi
    break
  done
else
  log "Using cached $TOOLS_DIR/morphe-desktop.jar"
fi

if [ ! -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
  log_warn "morphe-desktop.jar not found; downstream APK version resolution will be skipped."
fi

# --- patches .mpp files ---------------------------------------------------

while IFS='|' read -r repo _; do
  # branch is unused here; we already have the tag in REPO_VERSIONS.
  slug="$(repo_slug "$repo")"
  tag="$(jq -r --arg r "$repo" '.[$r] // empty' <<<"$REPO_VERSIONS")"
  if [ -z "$tag" ]; then
    log_error "No resolved tag for repo ${repo}. Cannot download .mpp."
    exit 1
  fi
  mpp_dest="$TOOLS_DIR/${slug}.mpp"
  if [ -f "$mpp_dest" ]; then
    log "Using cached ${mpp_dest}"
    continue
  fi
  log "Downloading patches .mpp from ${repo}@${tag}..."
  gh_release_download "$repo" "$tag" "patches-*.mpp" "$TOOLS_DIR" >/dev/null || true
  # The download may land as tools/patches-X.Y.Z.mpp; rename to slug-named file.
  for f in "$TOOLS_DIR"/patches-*.mpp; do
    [ -f "$f" ] || continue
    if [ "$f" != "$mpp_dest" ]; then
      mv "$f" "$mpp_dest"
      log "  moved $(basename "$f") -> ${slug}.mpp"
    fi
    break
  done
  if [ ! -f "$mpp_dest" ]; then
    log_error "Failed to obtain ${mpp_dest} from ${repo}@${tag}."
    exit 1
  fi
done <<< "$(list_repo_branches)"