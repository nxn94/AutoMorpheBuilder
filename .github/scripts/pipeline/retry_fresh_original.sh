#!/usr/bin/env bash
#
# scripts/retry_fresh_original.sh — patch again on a freshly downloaded original.
#
# Runs after the workflow's patch step failed on an original restored from the
# APK cache. A cached original can share the version and versionCode of the one
# the patches target but differ in code, which fails the same way every run.
#
# Behaviour:
#   1. Only a `Failed to match the fingerprint` failure is retried.
#   2. Download again with FRESH_DOWNLOAD=1: no apps/ cache, no tools/apks
#      pre-downloaded file, no remembered or listed download URLs.
#   3. If the new original(s) are byte-identical to the reused ones, fail:
#      the patches, not the cache, are the likely cause.
#   4. Re-run patch_apk.sh on the new original; it emits `output=<name>` to
#      $GITHUB_OUTPUT. `fresh=true` is emitted once the download succeeded.
#
# Environment: the same as download-supported-apk.js and patch_apk.sh, plus
#   APP_ID, APP_NAME, APKS_DIR, RUNNER_TEMP   required
#   GITHUB_WORKSPACE                          required (repo root)
#   GITHUB_OUTPUT                             required

set -Eeuo pipefail

: "${APP_ID:?}" "${APP_NAME:?}" "${APKS_DIR:?}" "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}" "${GITHUB_OUTPUT:?}"

if ! grep -q 'Failed to match the fingerprint' "$RUNNER_TEMP/morphe_patch_${APP_NAME}.log"; then
  echo "Not a fingerprint failure; not retrying."
  exit 1
fi

# Sorted sha256 list of the original(s) in APKS_DIR (not the merged $APP_ID.apk).
originals() {
  find "$APKS_DIR" -maxdepth 1 -type f \( -name '*.apk' -o -name '*.xapk' -o -name '*.apkm' -o -name '*.apks' \) \
    ! -name "$APP_ID.apk" -exec sha256sum {} + | cut -d' ' -f1 | sort
}

reused="$(originals)"
out="$RUNNER_TEMP/retry_getapk_output"
: > "$out"
GITHUB_OUTPUT="$out" FRESH_DOWNLOAD=1 node "$GITHUB_WORKSPACE/.github/scripts/download-supported-apk.js"

if [ "$(originals)" = "$reused" ]; then
  echo "::error::The source returned the same file that failed to patch; the patches, not the cache, are the likely cause."
  exit 1
fi

echo "fresh=true" >> "$GITHUB_OUTPUT"
APK="$(sed -n 's/^apk=//p' "$out")"
APK_VERSION="$(sed -n 's/^version=//p' "$out")"
export APK APK_VERSION
rm -rf "$RUNNER_TEMP/morphe_${APP_NAME}"
bash "$GITHUB_WORKSPACE/.github/scripts/pipeline/patch_apk.sh"
echo "::notice::Patched $APP_NAME on a freshly downloaded original; the cached copy was stale."
