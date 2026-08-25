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

# Always re-download the CLI jar. We do NOT trust any cached copy:
# `actions/cache@v5` only saves on a cache miss by default, so if a
# restore happens (via exact key or a restore-key) the freshly
# downloaded jar gets REPLACED by the cached one and the cache is
# NOT re-saved. A stale jar cached from a previous cli-version or a
# manual upload would persist forever otherwise. The jar is small
# (~40MB) and the network cost is negligible. (The .mpp files below
# ARE cached — they're per (repo, tag), reused across apps, and
# each download emits its own actions/cache key.)
rm -f "$TOOLS_DIR/morphe-desktop.jar"
log "Downloading morphe-desktop ${CLI_TAG} (forced, not cached)..."
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

if [ ! -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
  log_warn "morphe-desktop.jar not found; downstream APK version resolution will be skipped."
fi

# Sanity-check the downloaded jar matches the requested tag. gh_release_download
# pins the asset name to '<cli>-<version>-all.jar', but a corrupted/partial
# download or a wrong tag would still produce a file — this grep surfaces that
# before morphe-desktop is invoked downstream.
if [ -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
  actual_version="$(unzip -p "$TOOLS_DIR/morphe-desktop.jar" META-INF/MANIFEST.MF 2>/dev/null \
    | grep '^Implementation-Version:' | sed 's/^Implementation-Version:[[:space:]]*//' | head -n1 || true)"
  expected_version="${CLI_TAG#v}"  # strip leading 'v' (e.g. v1.13.2 -> 1.13.2)
  if [ -n "$actual_version" ] && [ "$actual_version" != "$expected_version" ]; then
    log_warn "morphe-desktop.jar version mismatch: expected ${expected_version}, got ${actual_version}."
  elif [ -n "$actual_version" ]; then
    log "morphe-desktop.jar version confirmed: ${actual_version}"
  fi
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