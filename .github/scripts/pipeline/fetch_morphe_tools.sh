#!/usr/bin/env bash
#
# scripts/fetch_morphe_tools.sh — fetch per-matrix Morphe artifacts
# (patches .mpp, morphe-desktop.jar, APKEditor.jar) that the build matrix
# needs before resolving + patching the APK.
#
# Replaces the ~60-line `run:` block in the workflow's "Get latest
# Morphe patches + CLI + APKEditor" step. Behaviour is identical:
#   - download patches-<ver>.mpp into $TOOLS_DIR/<slug>.mpp if missing
#   - always fetch patches-list.json (small, always fresh)
#   - download morphe-desktop-<ver>-all.jar into $TOOLS_DIR if missing
#   - resolve the latest APKEditor release tag + asset and download
#   - emit apkeditor_jar=<abs-path> to $GITHUB_OUTPUT for downstream
#
# The slug-named .mpp is what downstream steps consume (see patch_apk.sh
# which reads "$TOOLS_DIR/${PATCH_SLUG}.mpp").
#
# Environment:
#   PATCH_REPO    required  e.g. MorpheApp/morphe-patches
#   PATCH_TAG     required  e.g. v1.32.0
#   PATCH_SLUG    required  e.g. MorpheApp-morphe-patches
#   CLI_REPO      required  e.g. MorpheApp/morphe-desktop (sourced from
#                          config.json's `cli.repo` by check-versions.sh)
#   CLI_VERSION   required  e.g. v1.11.0
#   TOOLS_DIR     optional  default ./tools
#   GITHUB_OUTPUT required  workflow output file
#
# SHA-256 verification (see checksums/tools.sha256 + docs/checksums.md):
#   When the manifest contains a real SHA for `morphe-desktop.jar` or
#   `APKEditor.jar`, the downloaded artifact is also checked against
#   that digest. A mismatch hard-fails the build. The `<slug>.mpp` is
#   NOT pinned in the global manifest (its SHA changes per release
#   tag); the existing `gh release download <tag>` + tag check is the
#   primary gate.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/github.sh"
. "$(dirname "$0")/lib/checksums.sh"

PATCH_REPO="${PATCH_REPO:-}"
PATCH_TAG="${PATCH_TAG:-}"
PATCH_SLUG="${PATCH_SLUG:-}"
CLI_REPO="${CLI_REPO:-}"
CLI_VERSION="${CLI_VERSION:-}"
TOOLS_DIR="${TOOLS_DIR:-./tools}"

for var in PATCH_REPO PATCH_TAG PATCH_SLUG CLI_REPO CLI_VERSION; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done

gh_require_token
mkdir -p "$TOOLS_DIR"

# --- patches .mpp --------------------------------------------------------
#
# The .mpp at $MPP_DEST can come from `actions/cache` (this script runs
# after the build job's `Cache patches .mpp` step). Before fd537df removed
# `restore-keys: morphe-patches-<slug>-`, that step could silently restore
# a `.mpp` from an older tag, and `fetch_morphe_tools.sh` would skip the
# download because the file already existed — leaving a stale bundle in
# place for the rest of the build. Verify the bytes against the per-asset
# digest served by the GitHub release API; if they disagree, delete the
# cached file and re-download. A stale `.mpp` therefore always fails the
# verify-and-re-fetch loop and self-heals on the next run, without
# requiring a manual `gh cache delete`.

MPP_DEST="$TOOLS_DIR/${PATCH_SLUG}.mpp"

# Resolve the exact asset name from the release API so the per-asset
# digest we look up matches the bytes we download. `gh release view
# --json assets` is a single small request and is the same call shape
# `gh_asset_sha256` uses internally. If the API call fails (rate limit,
# private fork without workflow auth), we fall back to the legacy
# `patches-*.mpp` glob and skip SHA verification with a warning.
mpp_asset_name="$(gh release view "$PATCH_TAG" --repo "$PATCH_REPO" --json assets \
  --jq '[.assets[] | select(.name | startswith("patches-")) | select(.name | endswith(".mpp")) | .name][0] // empty' \
  2>/dev/null || true)"
if [ -z "$mpp_asset_name" ]; then
  log_warn "${PATCH_REPO}@${PATCH_TAG}: could not resolve patches-*.mpp asset name from release API; SHA-256 verification will be skipped for this run."
fi

# Pre-resolve the API digest so the verify-and-re-fetch loop can compare
# without re-issuing the API call on the re-download path. `gh_asset_sha256`
# returns "" on failure (network / auth / asset missing), in which case
# `verify_or_fetch_mpp` falls back to "file must exist, no SHA check".
api_mpp_sha=""
if [ -n "$mpp_asset_name" ]; then
  api_mpp_sha="$(gh_asset_sha256 "$PATCH_REPO" "$PATCH_TAG" "$mpp_asset_name" || true)"
fi

# verify_or_fetch_mpp <dest> <expected_sha> <repo> <tag> <asset_name>
#
# Ensures <dest> exists and matches <expected_sha>. If the file is
# missing OR its bytes don't match the upstream digest, delete it and
# re-download. Re-verifies after the re-download so a republish attack
# (upstream served tampered bytes between the two API calls) still fails
# closed. Returns 0 on success, 1 on unrecoverable failure.
verify_or_fetch_mpp() {
  local dest="$1" expected_sha="$2" repo="$3" tag="$4" asset_name="$5"
  local actual_sha="" dest_name="${dest##*/}"

  if [ -z "$expected_sha" ]; then
    # No API digest — preserve the legacy behaviour: download if
    # missing, otherwise keep what's on disk.
    if [ ! -f "$dest" ]; then
      log "Downloading patches from ${repo}@${tag} (no SHA verification available)..."
      gh_release_download "$repo" "$tag" "patches-*.mpp" "$TOOLS_DIR" >/dev/null || true
      for f in "$TOOLS_DIR"/patches-*.mpp; do
        [ -f "$f" ] && mv "$f" "$dest"
        break
      done
    fi
    return 0
  fi

  if [ -e "$dest" ]; then
    # `-e` matches any path entry (regular file, directory, symlink,
    # etc.) so a stray directory at $dest — which would otherwise be
    # invisible to the `[ -f ]` test and silently break the `mv`
    # below with "cannot overwrite directory" — still gets cleaned up.
    if [ ! -f "$dest" ]; then
      log_warn "${dest_name} exists but is not a regular file; removing before re-download."
      rm -rf "$dest"
    else
      actual_sha="$(sha256sum "$dest" | awk '{print $1}')"
      if [ "$actual_sha" = "$expected_sha" ]; then
        log "${dest_name} SHA-256 verified against upstream API digest (${actual_sha})"
        return 0
      fi
      log_warn "${dest_name} SHA-256 mismatch (cache stale? got ${actual_sha}, expected ${expected_sha}). Re-downloading from ${repo}@${tag}."
      rm -rf "$dest"
    fi
  fi

  log "Downloading patches from ${repo}@${tag}..."
  if [ -n "$asset_name" ]; then
    gh_release_download "$repo" "$tag" "$asset_name" "$TOOLS_DIR" >/dev/null || true
    if [ -f "$TOOLS_DIR/$asset_name" ] && [ "$TOOLS_DIR/$asset_name" != "$dest" ]; then
      mv "$TOOLS_DIR/$asset_name" "$dest"
    fi
  else
    gh_release_download "$repo" "$tag" "patches-*.mpp" "$TOOLS_DIR" >/dev/null || true
    for f in "$TOOLS_DIR"/patches-*.mpp; do
      [ -f "$f" ] && mv "$f" "$dest"
      break
    done
  fi

  if [ ! -f "$dest" ]; then
    log_error "Failed to obtain ${dest} from ${repo}@${tag}."
    return 1
  fi

  actual_sha="$(sha256sum "$dest" | awk '{print $1}')"
  if [ "$actual_sha" != "$expected_sha" ]; then
    log_error "${dest_name} SHA-256 mismatch after re-download: expected ${expected_sha}, got ${actual_sha}. Upstream republish attack or stale API digest; investigate before re-running."
    return 1
  fi
  log "${dest_name} SHA-256 verified against upstream API digest (${actual_sha})"
  return 0
}

if ! verify_or_fetch_mpp "$MPP_DEST" "$api_mpp_sha" "$PATCH_REPO" "$PATCH_TAG" "$mpp_asset_name"; then
  exit 1
fi
if [ ! -f "$MPP_DEST" ]; then
  log_error "Failed to obtain ${MPP_DEST} from ${PATCH_REPO}@${PATCH_TAG}."
  exit 1
fi
json_set_output patches_tag "$PATCH_TAG"

# --- patches-list.json (always fresh) -----------------------------------

# Hardened curl: --fail exits non-zero on 4xx/5xx; --max-time /
# --connect-timeout cap handshake stalls; --retry-all-errors covers
# connection-level failures. Outer with_retry layers one more
# exponential-backoff cycle on top of curl's --retry.
with_retry 3 5 curl \
  --fail \
  --location \
  --show-error \
  --silent \
  --connect-timeout 15 \
  --max-time 300 \
  --retry 3 \
  --retry-delay 5 \
  --retry-all-errors \
  --output "$TOOLS_DIR/patches-list.json" \
  "https://raw.githubusercontent.com/${PATCH_REPO}/${PATCH_TAG}/patches-list.json"

# --- morphe-desktop.jar --------------------------------------------------

# Always re-download the CLI jar (see download_morphe_tools.sh for the
# full rationale: actions/cache@v5 only saves on miss, so a stale jar
# cached from a previous cli-version persists across runs even when
# cli-version resolves to a newer release). The check-versions job
# already populates tools/; this re-downloads fresh inside each
# build matrix entry so they all see exactly the jar for the
# resolved CLI_VERSION.
rm -f "$TOOLS_DIR/morphe-desktop.jar"
# Releases <= v1.10.x shipped as morphe-cli-X.Y.Z-all.jar under the old
# MorpheApp/morphe-cli repo. Current releases use morphe-desktop-*; accept
# either name so legacy pins still resolve.
gh_release_download "$CLI_REPO" "$CLI_VERSION" "morphe-desktop-*-all.jar" "$TOOLS_DIR" >/dev/null || true
# Capture the exact asset name before the rename loop, so the
# per-asset digest pulled from the GitHub release API matches the
# bytes on disk verbatim.
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

# Paranoia: confirm the downloaded jar matches CLI_VERSION before
# downstream steps (which call list-versions / patch) try to use it.
# `tr -d '\r'` strips a stray carriage return that the upstream JAR's
# MANIFEST.MF sometimes ships with (it would otherwise survive
# `head -n1` and break the string compare below, producing a spurious
# "version mismatch" warning when both sides match).
if [ -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
  actual_version="$(unzip -p "$TOOLS_DIR/morphe-desktop.jar" META-INF/MANIFEST.MF 2>/dev/null \
    | grep '^Implementation-Version:' | sed 's/^Implementation-Version:[[:space:]]*//' \
    | head -n1 | tr -d '\r' || true)"
  expected_version="${CLI_VERSION#v}"
  if [ -n "$actual_version" ] && [ "$actual_version" != "$expected_version" ]; then
    log_warn "morphe-desktop.jar version mismatch: expected ${expected_version}, got ${actual_version}."
  elif [ -n "$actual_version" ]; then
    log "morphe-desktop.jar version confirmed: ${actual_version}"
  fi

  # SHA-256 verification. GitHub's release API exposes a per-asset
  # digest that we treat as authoritative for this run — a CLI bump
  # no longer fails the build on a stale manual pin. The pin in
  # checksums/tools.sha256 stays as a tamper tripwire (mismatched
  # pin vs. API digest means someone republished the asset). See
  # docs/checksums.md and the matching block in
  # download_morphe_tools.sh for the full contract.
  api_sha=""
  if [ -n "$cli_asset_name" ]; then
    api_sha="$(gh_asset_sha256 "$CLI_REPO" "$CLI_VERSION" "$cli_asset_name" || true)"
  fi
  pinned_sha=""
  if tools_sha_pinned "morphe-desktop.jar"; then
    pinned_sha="$(tools_sha_lookup "morphe-desktop.jar")"
  fi
  actual_sha="$(sha256sum "$TOOLS_DIR/morphe-desktop.jar" | awk '{print $1}')"

  if [ -n "$api_sha" ]; then
    if [ "$actual_sha" != "$api_sha" ]; then
      log_error "morphe-desktop.jar SHA-256 mismatch against upstream API digest. expected (from ${CLI_REPO}@${CLI_VERSION}): ${api_sha}, got: ${actual_sha}."
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
        log_error "morphe-desktop.jar pin in checksums/tools.sha256 disagrees with upstream API digest for ${CLI_VERSION}. pinned: ${pinned_sha}, API: ${api_sha}. This means the asset was republished under ${CLI_VERSION}; either refresh the pin or stop the workflow to investigate."
        exit 1
      fi
    fi
    if [ -z "$pinned_sha" ]; then
      log "TODO(refresh-pin-morphe-desktop): API has no local pin to compare; update checksums/tools.sha256 to pin ${cli_asset_name} = ${api_sha} before the next CLI bump so subsequent runs can detect republish attacks."
    fi
  else
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

# --- APKEditor ----------------------------------------------------------

APKEDITOR_TAG="$(gh release view --repo REAndroid/APKEditor --json tagName -q .tagName)"
# Pick the canonical APKEditor-<version>.jar asset by name. The
# `endswith(".jar") | head -n1` form we used previously was
# order-dependent: if a release ever shipped both `APKEditor-X.Y.Z.jar`
# and a `-shaded.jar` or `-all.jar`, we'd pick whichever GitHub
# returned first. Match the canonical name first, then fall back to
# any .jar with a warning so we know if the upstream convention ever
# drifts.
APKEDITOR_ASSET="$(
  gh release view "$APKEDITOR_TAG" --repo REAndroid/APKEditor --json assets \
    -q '.assets[] | select(.name | test("^APKEditor-.*\\.jar$")) | .name' \
    | head -n1
)"
if [ -z "$APKEDITOR_ASSET" ]; then
  log_warn "No asset matched ^APKEditor-.*\\.jar\$ on release ${APKEDITOR_TAG}; falling back to any .jar."
  APKEDITOR_ASSET="$(
    gh release view "$APKEDITOR_TAG" --repo REAndroid/APKEditor --json assets \
      -q '.assets[] | select(.name | endswith(".jar")) | .name' \
      | head -n1
  )"
fi
if [ -z "$APKEDITOR_ASSET" ]; then
  log_error "Could not find APKEditor .jar asset on release ${APKEDITOR_TAG}."
  exit 1
fi
gh_release_download "REAndroid/APKEditor" "$APKEDITOR_TAG" "$APKEDITOR_ASSET" "$TOOLS_DIR" >/dev/null

APKEDITOR_JAR_PATH="$TOOLS_DIR/$APKEDITOR_ASSET"
if [ ! -f "$APKEDITOR_JAR_PATH" ]; then
  log_error "APKEditor download failed: $APKEDITOR_JAR_PATH"
  exit 1
fi

# SHA-256 verification when checksums/tools.sha256 pins APKEditor.jar.
# tools_sha_pinned returns false for TODO placeholders. When pinned, a
# mismatch hard-fails the build — APKEditor is the merge step for split
# packages, and silently shipping the wrong jar would silently produce
# single-architecture APKs that fail to install on 64-bit-only devices.
if tools_sha_pinned "APKEditor.jar"; then
  expected_sha="$(tools_sha_lookup "APKEditor.jar")"
  actual_sha="$(sha256sum "$APKEDITOR_JAR_PATH" | awk '{print $1}')"
  if [ "$actual_sha" != "$expected_sha" ]; then
    log_error "APKEditor.jar SHA-256 mismatch: expected ${expected_sha}, got ${actual_sha}."
    exit 1
  fi
  log "APKEditor.jar SHA-256 verified"
fi

json_set_output apkeditor_jar "$APKEDITOR_JAR_PATH"
log "Downloaded APKEditor ${APKEDITOR_TAG}: ${APKEDITOR_ASSET}"