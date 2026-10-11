#!/usr/bin/env bash
# Download a fresh CLI and one patches archive per distinct repository/tag.
# Archives use tag-derived identities and must match the release API SHA-256
# before the compatibility probe or release filter can invoke them.

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
# before morphe-desktop is invoked downstream. `tr -d '\r'` strips a stray
# carriage return that the upstream JAR's MANIFEST.MF sometimes ships with
# (it would otherwise survive `head -n1` and break the string compare below,
# producing a spurious "version mismatch" warning when both sides match).
if [ -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
  actual_version="$(unzip -p "$TOOLS_DIR/morphe-desktop.jar" META-INF/MANIFEST.MF 2>/dev/null \
    | grep '^Implementation-Version:' | sed 's/^Implementation-Version:[[:space:]]*//' \
    | head -n1 | tr -d '\r' || true)"
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
    # Pin drift check: pin must agree with API *for the same CLI tag*,
    # or someone has tampered with the asset. When the pin row carries
    # a `# vX.Y.Z` annotation that names a *different* CLI release than
    # the one we're downloading, the SHA mismatch is just a version
    # bump we haven't refreshed the pin for yet — log a TODO marker
    # and continue. Without the version annotation (or with one that
    # does match), disagreement stays a hard fail.
    if [ -n "$pinned_sha" ] && [ "$pinned_sha" != "$api_sha" ]; then
      pinned_version_raw="$(tools_sha_pinned_version "morphe-desktop.jar" || true)"
      pinned_version="${pinned_version_raw#v}"
      if [ -n "$pinned_version_raw" ] && [ -n "$pinned_version" ] \
          && [ "$pinned_version" != "$expected_version" ]; then
        log "morphe-desktop.jar pin in checksums/tools.sha256 is for ${pinned_version_raw} but downloading v${expected_version}; treating as a CLI version bump (not a tamper signal). TODO(refresh-pin-morphe-desktop): update checksums/tools.sha256 to pin ${cli_asset_name} = ${api_sha}  # v${expected_version} so the next run can detect republish attacks."
      else
        log_error "morphe-desktop.jar pin in checksums/tools.sha256 disagrees with upstream API digest for ${CLI_TAG}. pinned: ${pinned_sha}, API: ${api_sha}. This means the asset was republished under ${CLI_TAG}; either refresh the pin or stop the workflow to investigate."
        exit 1
      fi
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

while IFS='|' read -r repo tag slug; do
  mpp_dest="$TOOLS_DIR/${slug}.mpp"
  scratch="$(mktemp -d "${RUNNER_TEMP:-/tmp}/patches.XXXXXX")"
  gh_release_download "$repo" "$tag" 'patches-*.mpp' "$scratch" >/dev/null
  assets=("$scratch"/*.mpp)
  if [ "${#assets[@]}" -ne 1 ] || [ ! -f "${assets[0]}" ]; then
    log_error "Expected one patches archive for ${repo}@${tag}"
    exit 1
  fi
  asset_name="$(basename "${assets[0]}")"
  api_sha="$(gh_asset_sha256 "$repo" "$tag" "$asset_name")"
  actual_sha="$(sha256sum "${assets[0]}" | awk '{print $1}')"
  if [ -z "$api_sha" ] || [ "$actual_sha" != "$api_sha" ]; then
    log_error "Patches SHA-256 verification failed for ${repo}@${tag}"
    exit 1
  fi
  mv "${assets[0]}" "$mpp_dest"
  rm -rf "$scratch"
done < <(node "$(dirname "$0")/../build-plan.js" | jq -r 'unique_by(.patchSlug)[] | "\(.patchRepo)|\(.patchTag)|\(.patchSlug)"')
