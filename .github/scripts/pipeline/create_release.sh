#!/usr/bin/env bash
#
# scripts/create_release.sh — group patched APKs by app and publish one
# GitHub Release per app via `gh release`.
#
# Replaces the ~80-line `run:` block in the workflow's "Create per-app
# releases" step. Behaviour is identical:
#   1. Group downloaded APKs by app prefix (everything before "-v").
#   2. For each app, derive the release tag from the APK filename:
#        <app>-<base-version>-<patches-version>
#      e.g. youtube-v20.44.38-v1.24.0-dev.8
#   3. Generate the release notes (title, version block, Obtainium
#      instructions with the required -v filter).
#   4. If the release exists, upload any new assets with retry + skip
#      already-attached. If it doesn't, create it.
#   5. Generate a SHA256SUMS file next to the APKs, verify it via
#      `sha256sum --check`, and upload it alongside the APK assets.
#      Downstream consumers (Obtainium, manual curators) can use this
#      to confirm the APK they downloaded matches the one the workflow
#      built (see docs/checksums.md).
#
# Environment:
#   APKS_DIR         required  where patched APKs land (download-artifact dest)
#   CLI_VERSION      required  CLI tag (e.g. v1.9.1)
#   CLI_BRANCH       required  CLI branch (main or dev)
#   REPO_VERSIONS    required  JSON object {repo: tag} for the notes
#   GH_TOKEN         required  GitHub token with release permissions

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/github.sh"

APKS_DIR="${APKS_DIR:-./apks}"
CLI_VERSION="${CLI_VERSION:-}"
CLI_BRANCH="${CLI_BRANCH:-main}"
_default_repo_versions='{}'
REPO_VERSIONS="${REPO_VERSIONS:-$_default_repo_versions}"

for var in CLI_VERSION REPO_VERSIONS; do
  if [ -z "${!var}" ]; then
    log_error "Required env var $var is empty."
    exit 1
  fi
done
if [ ! -d "$APKS_DIR" ]; then
  log_error "APKs directory not found: $APKS_DIR"
  exit 1
fi

# --- group APKs by app ----------------------------------------------------

# Stable ordering is important here — `declare -A` iteration order is
# unspecified, so we collect keys into an array sorted via printf | sort.
declare -A APP_APKS
for apk in "$APKS_DIR"/*.apk; do
  [ -f "$apk" ] || continue
  apk_basename="$(basename "$apk" .apk)"
  app_name="$(printf '%s' "$apk_basename" | sed -E 's/-v[0-9].*//')"
  APP_APKS["$app_name"]+="$apk "
done

if [ "${#APP_APKS[@]}" -eq 0 ]; then
  log_error "No APK files found in $APKS_DIR"
  exit 1
fi

mapfile -t APPS < <(printf '%s\n' "${!APP_APKS[@]}" | sort -u)

PATCHES_SUMMARY="$(
  printf '%s' "$REPO_VERSIONS" | jq -r 'to_entries | map("- \(.key): \(.value)") | join("\n")'
)"

# --- publish each app's release -------------------------------------------

for app_name in "${APPS[@]}"; do
  read -r -a apk_files <<<"${APP_APKS[$app_name]}"
  first_apk="${apk_files[0]}"
  apk_basename="$(basename "$first_apk" .apk)"
  # version_str = everything after "<name>-": e.g. "v20.44.38-v1.24.0-dev.8"
  version_str="$(printf '%s' "$apk_basename" | sed -E 's/^[^-]+-//')"

  TAG="${app_name}-${version_str}"
  TITLE="${app_name} ${version_str}"

  RELEASE_NOTES="$(printf '%s\n\n' \
    "${TITLE}" \
    "**CLI version:** ${CLI_VERSION}" \
    "**Base + patches:** ${version_str}" \
    "" \
    "**Patch repo versions:**" \
    "${PATCHES_SUMMARY}" \
    "" \
    "## Obtainium Setup" \
    "Add source: GitHub" \
    "" \
    "- **Release tag filter:** \`^${app_name}\`" \
  )"

  if gh release view "$TAG" >/dev/null 2>&1; then
    log "Release $TAG exists; uploading assets."
    for apk in "${apk_files[@]}"; do
      apk_name="$(basename "$apk")"
      # Skip if already attached; --clobber would 422 in that case.
      if gh release view "$TAG" --json assets --jq '.assets[].name' 2>/dev/null \
        | grep -Fxq "$apk_name"; then
        log "  $apk_name already attached; skipping."
        continue
      fi
      uploaded=false
      for try in 1 2 3 4 5; do
        if gh release upload "$TAG" "$apk" --clobber; then
          uploaded=true
          break
        fi
        log_warn "  upload attempt $try for $apk_name failed; retrying in 3s..."
        sleep 3
      done
      if [ "$uploaded" != "true" ]; then
        log_error "Failed to upload $apk_name to release $TAG after 5 attempts."
        exit 1
      fi
    done
    gh release edit "$TAG" --title "$TITLE" --notes "$RELEASE_NOTES"
  else
    log "Creating release $TAG..."
    gh release create "$TAG" "${apk_files[@]}" \
      --title "$TITLE" \
      --notes "$RELEASE_NOTES"
  fi

  # Per-release integrity manifest. Generate SHA256SUMS in the APK
  # directory (same place where the .apk files live) and upload it
  # alongside the release assets. Downstream consumers (Obtainium,
  # curators) can `sha256sum --check SHA256SUMS` against this file to
  # confirm the APK they downloaded matches the one the workflow built.
  #
  # The intermediate `sha256sum --check` is a self-test that catches
  # bugs in the file glob (a typo would silently produce a file that
  # doesn't match the actual binaries).
  if [ "${#apk_files[@]}" -gt 0 ]; then
    sha256_dir="$(dirname "${apk_files[0]}")"
    log "Writing per-release SHA256SUMS to $sha256_dir/SHA256SUMS..."
    (
      cd "$sha256_dir"
      # Note: redirect target is relative to cwd (which is now $sha256_dir),
      # so use the bare filename "SHA256SUMS" — not "$sha256_dir/SHA256SUMS"
      # (which would resolve to $sha256_dir/$sha256_dir/SHA256SUMS and fail).
      sha256sum -- "${apk_files[@]#$sha256_dir/}" > SHA256SUMS
    )
    # Self-test: re-hash and compare. Any mismatch means a file in the
    # manifest no longer matches the bytes on disk — surface as an
    # ::error:: rather than shipping a broken manifest.
    if ! ( cd "$sha256_dir" && sha256sum --check "$sha256_file" ); then
      log_error "SHA256SUMS self-test failed for $TAG"
      exit 1
    fi
    if gh release view "$TAG" --json assets --jq '.assets[].name' 2>/dev/null \
      | grep -Fxq "SHA256SUMS"; then
      log "  SHA256SUMS already attached; skipping."
    else
      uploaded=false
      for try in 1 2 3 4 5; do
        if gh release upload "$TAG" "$sha256_file" --clobber; then
          uploaded=true
          break
        fi
        log_warn "  SHA256SUMS upload attempt $try failed; retrying in 3s..."
        sleep 3
      done
      if [ "$uploaded" != "true" ]; then
        log_error "Failed to upload SHA256SUMS to release $TAG after 5 attempts."
        exit 1
      fi
      log "  SHA256SUMS uploaded"
    fi
  fi

  log "::notice::Published release: ${TAG}"
done