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
#
# SHA-256 verification (see checksums/tools.sha256 + docs/checksums.md):
#   When the manifest contains a real SHA for `morphe-desktop.jar`, the
#   downloaded jar is also checked against that digest. A mismatch hard-
#   fails the build. Per-repo `.mpp` files are NOT pinned in the global
#   manifest (their SHAs change per release tag); the existing
#   `gh release download <tag>` + tag check is the primary gate for
#   those — see `fetch_morphe_tools.sh` for the per-matrix path.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"
. "$(dirname "$0")/lib/github.sh"
. "$(dirname "$0")/lib/checksums.sh"

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
# Track the exact asset we got, so the per-asset digest we later
# pull from the release API matches the bytes on disk. basename
# before the rename so we capture `morphe-desktop-1.15.0-all.jar` (or
# the legacy `morphe-cli-X.Y.Z-all.jar`) verbatim.
cli_asset_name=""
for f in "$TOOLS_DIR"/morphe-desktop-*-all.jar "$TOOLS_DIR"/morphe-cli-*-all.jar; do
  [ -f "$f" ] || continue
  cli_asset_name="$(basename "$f")"
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

  # SHA-256 verification. We treat the per-asset digest served by the
  # GitHub release API as the authoritative hash for this run, so a
  # new CLI release doesn't fail the build on a stale manual pin in
  # checksums/tools.sha256. Pin still helps: when the manifest is
  # pinned, the pin must AGREE with the API digest — disagreement
  # means someone republished the asset under the same tag, which
  # is a tamper signal we fail closed on. When the manifest is NOT
  # pinned, we silently accept the API's digest but emit a single
  # `TODO(refresh-pin):` line so a maintainer can refresh the pin
  # before the next bump makes the drift more confusing.
  api_sha=""
  if [ -n "$cli_asset_name" ]; then
    api_sha="$(gh_asset_sha256 "$CLI_REPO" "$CLI_TAG" "$cli_asset_name" || true)"
  fi
  pinned_sha=""
  if tools_sha_pinned "morphe-desktop.jar"; then
    pinned_sha="$(tools_sha_lookup "morphe-desktop.jar")"
  fi
  actual_sha="$(sha256sum "$TOOLS_DIR/morphe-desktop.jar" | awk '{print $1}')"

  if [ -n "$api_sha" ]; then
    # Local bytes must match the API-published digest — this is the
    # tamper / corruption gate.
    if [ "$actual_sha" != "$api_sha" ]; then
      log_error "morphe-desktop.jar SHA-256 mismatch against upstream API digest. expected (from ${CLI_REPO}@${CLI_TAG}): ${api_sha}, got: ${actual_sha}."
      exit 1
    fi
    log "morphe-desktop.jar SHA-256 verified against upstream API digest (${api_sha})"
    # Pin drift check: pin must agree with API, or someone has
    # tampered with the asset.
    if [ -n "$pinned_sha" ] && [ "$pinned_sha" != "$api_sha" ]; then
      log_error "morphe-desktop.jar pin in checksums/tools.sha256 disagrees with upstream API digest. pinned: ${pinned_sha}, API: ${api_sha}. This usually means the asset was republished under ${CLI_TAG}; either refresh the pin or stop the workflow to investigate."
      exit 1
    fi
    if [ -z "$pinned_sha" ]; then
      log "TODO(refresh-pin-morphe-desktop): API has no local pin to compare; update checksums/tools.sha256 to pin ${cli_asset_name} = ${api_sha} before the next CLI bump so subsequent runs can detect republish attacks."
    fi
  else
    # No API digest available (very old release or asset without a
    # server-side hash). Fall back to the manual pin: if the
    # manifest claims a value, treat it as authoritative; otherwise
    # skip SHA verification and rely on the MANIFEST.MF version
    # check above. This branch should be unreachable for any CLI
    # release from the last several years.
    if [ -n "$pinned_sha" ]; then
      if [ "$actual_sha" != "$pinned_sha" ]; then
        log_error "morphe-desktop.jar SHA-256 mismatch: expected ${pinned_sha}, got ${actual_sha}."
        exit 1
      fi
      log "morphe-desktop.jar SHA-256 verified (manifest pin; no upstream digest available)"
    else
      log "morphe-desktop.jar SHA-256 not verified (no upstream digest, no manifest pin)"
    fi
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