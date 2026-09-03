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

MPP_DEST="$TOOLS_DIR/${PATCH_SLUG}.mpp"
if [ ! -f "$MPP_DEST" ]; then
  log "Downloading patches from ${PATCH_REPO}@${PATCH_TAG}..."
  gh_release_download "$PATCH_REPO" "$PATCH_TAG" "patches-*.mpp" "$TOOLS_DIR" >/dev/null
  for f in "$TOOLS_DIR"/patches-*.mpp; do
    [ -f "$f" ] && mv "$f" "$MPP_DEST"
    break
  done
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
if [ -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
  actual_version="$(unzip -p "$TOOLS_DIR/morphe-desktop.jar" META-INF/MANIFEST.MF 2>/dev/null \
    | grep '^Implementation-Version:' | sed 's/^Implementation-Version:[[:space:]]*//' | head -n1 || true)"
  expected_version="${CLI_VERSION#v}"
  if [ -n "$actual_version" ] && [ "$actual_version" != "$expected_version" ]; then
    log_warn "morphe-desktop.jar version mismatch: expected ${expected_version}, got ${actual_version}."
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
    if [ -n "$pinned_sha" ] && [ "$pinned_sha" != "$api_sha" ]; then
      log_error "morphe-desktop.jar pin in checksums/tools.sha256 disagrees with upstream API digest. pinned: ${pinned_sha}, API: ${api_sha}. This usually means the asset was republished under ${CLI_VERSION}; either refresh the pin or stop the workflow to investigate."
      exit 1
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