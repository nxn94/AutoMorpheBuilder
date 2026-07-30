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

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/github.sh"

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

with_retry 3 5 curl -fsSL \
  "https://raw.githubusercontent.com/${PATCH_REPO}/${PATCH_TAG}/patches-list.json" \
  -o "$TOOLS_DIR/patches-list.json"

# --- morphe-desktop.jar --------------------------------------------------

if [ ! -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
  # Releases <= v1.10.x shipped as morphe-cli-X.Y.Z-all.jar under the old
  # MorpheApp/morphe-cli repo. Current releases use morphe-desktop-*; accept
  # either name so legacy pins still resolve.
  gh_release_download "$CLI_REPO" "$CLI_VERSION" "morphe-desktop-*-all.jar" "$TOOLS_DIR" >/dev/null || true
  for f in "$TOOLS_DIR"/morphe-desktop-*-all.jar "$TOOLS_DIR"/morphe-cli-*-all.jar; do
    [ -f "$f" ] || continue
    if [ "$f" != "$TOOLS_DIR/morphe-desktop.jar" ]; then
      mv "$f" "$TOOLS_DIR/morphe-desktop.jar"
      log "  moved $(basename "$f") -> morphe-desktop.jar"
    fi
    break
  done
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
  )
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
json_set_output apkeditor_jar "$APKEDITOR_JAR_PATH"
log "Downloaded APKEditor ${APKEDITOR_TAG}: ${APKEDITOR_ASSET}"