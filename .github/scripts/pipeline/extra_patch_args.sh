#!/usr/bin/env bash
#
# extra_patch_args.sh — fetch the app's extra patch bundles and print the
# NUL-separated morphe-desktop arguments that apply them.
#
# Each bundle is the release the check job pinned (EXTRA_PATCH_TAGS, else the
# repo's latest) and must match the SHA-256 digest GitHub serves for the asset.
# A missing digest, a mismatch or any failed fetch exits non-zero, so the build
# fails instead of silently leaving a listed patch out.
#
# Environment:
#   APP_ID, PATCH_REPO, TOOLS_DIR  required
#   EXTRA_PATCH_TAGS               optional  JSON { "owner/repo": "tag" }

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"

EXTRA_JS="$(dirname "$0")/../extra-patches.js"
export TOOLS_DIR="${TOOLS_DIR:-./tools}"

while IFS= read -r repo; do
  [ -n "$repo" ] || continue
  tag="$(node "$EXTRA_JS" tag "$repo")"
  tag="$(gh release view ${tag:+"$tag"} --repo "$repo" --json tagName -q .tagName)"
  IFS=$'	' read -r asset want < <(gh release view "$tag" --repo "$repo" --json assets     --jq '[.assets[] | select(.name | startswith("patches-") and endswith(".mpp"))][0] // empty | [.name, (.digest // "")] | @tsv') || true
  if [ -z "$asset" ]; then
    log_error "No patches-*.mpp asset on ${repo}@${tag}"
    exit 1
  fi
  mpp="$(node "$EXTRA_JS" path "$repo")"
  rm -f "$mpp"
  gh release download "$tag" --repo "$repo" --pattern "$asset" --output "$mpp" --clobber >&2
  want="${want#sha256:}"
  if [ -z "$want" ]; then
    log_error "GitHub gave no SHA-256 for ${repo}@${tag} ${asset}; refusing to use it unchecked."
    exit 1
  fi
  got="$(sha256sum "$mpp" | awk '{print $1}')"
  if [ "$want" != "$got" ]; then
    log_error "SHA-256 mismatch for ${repo}@${tag} ${asset}"
    exit 1
  fi
  log "Extra patch bundle ${repo}@${tag} (${asset}) verified"
done < <(node "$EXTRA_JS" repos)

node "$EXTRA_JS" args
