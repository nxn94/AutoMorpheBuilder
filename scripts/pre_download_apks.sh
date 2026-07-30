#!/usr/bin/env bash
#
# scripts/pre_download_apks.sh — pre-download APKs for every configured
# app before the build matrix spins up. Runs once per app in parallel.
#
# Replaces the ~70-line `run:` block in the workflow's "Download APKs
# using unified-downloader" step. The previous block ran the downloader
# in a subshell per app using `&` + `wait`. This version is structured
# identically but pulls all the parameter extraction into the helper
# library so the script is short enough to read.
#
# Behaviour matches the original step:
#   1. For each app:
#        - If pin_version is set, use it directly.
#        - Otherwise, run `morphe-desktop list-versions -f <pkg>` and pick
#          the first X.Y.Z version.
#        - Call unified-downloader.js with (pkg, version, APK_DIR).
#        - On failure with a pinned version, retry with the head of
#          morphe-desktop list-versions (emergency fallback).
#   2. Merge results and write them to config.json via
#      update-download-urls.js.
#
# The whole step is best-effort: a single failure doesn't abort the
# build matrix. We log errors with ::warning:: so they're visible in
# the UI but don't gate the rest of the pipeline.
#
# Environment:
#   REPO_VERSIONS  required  JSON object {repo:tag}
#   TOOLS_DIR      required  where morphe-desktop.jar and *.mpp live
#   APK_DIR        required  where APKs land (default ./tools/apks)
#   RESULTS_DIR    optional  scratch dir for per-app results
#                            (default $RUNNER_TEMP/download_results)

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"

TOOLS_DIR="${TOOLS_DIR:-./tools}"
APK_DIR="${APK_DIR:-${TOOLS_DIR}/apks}"
RESULTS_DIR="${RESULTS_DIR:-${RUNNER_TEMP:-/tmp}/download_results}"
_default_repo_versions='{}'
REPO_VERSIONS="${REPO_VERSIONS:-$_default_repo_versions}"

mkdir -p "$APK_DIR" "$RESULTS_DIR"

# Clean any prior results so we don't accidentally merge stale entries.
rm -f "$RESULTS_DIR"/*.txt "$RESULTS_DIR"/*.failed 2>/dev/null || true

resolve_version_for() {
  local pkg="$1"
  local pin
  pin="$(pinned_version "$pkg")"
  if [ -n "$pin" ] && [ "$pin" != "null" ]; then
    log "  [$pkg] using pinned version $pin"
    printf '%s' "$pin"
    return 0
  fi

  # Resolve the patch repo for this app and find its .mpp file.
  local repo slug mpp
  repo="$(app_config "$pkg" '.repo')"
  slug="$(repo_slug "$repo")"
  mpp="$TOOLS_DIR/${slug}.mpp"
  if [ ! -f "$mpp" ] || [ ! -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
    log_warn "  [$pkg] no .mpp or morphe-desktop.jar; cannot resolve version"
    return 1
  fi
  cp "$mpp" "$TOOLS_DIR/patches.mpp"

  local versions version
  versions="$(java -jar "$TOOLS_DIR/morphe-desktop.jar" list-versions -f "$pkg" --patches="$TOOLS_DIR/patches.mpp" 2>/dev/null || true)"
  version="$(printf '%s\n' "$versions" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
  if [ -z "$version" ]; then
    log_warn "  [$pkg] could not determine version"
    return 1
  fi
  printf '%s' "$version"
}

download_for() {
  local pkg="$1"
  local version
  if ! version="$(resolve_version_for "$pkg")"; then
    echo "FAILED:no-version" > "$RESULTS_DIR/${pkg}.failed"
    return 0
  fi
  log "  [$pkg] downloading v${version}..."
  local result err stderr_log
  stderr_log="$(mktemp)"
  # Single-quoted trap so $stderr_log is re-evaluated when the trap
  # fires (on RETURN) — that way the second node invocation below,
  # which reassigns stderr_log, gets the right temp file cleaned up.
  trap 'rm -f "$stderr_log"' RETURN
  # Separate unified-downloader's stderr (per-source diagnostic lines)
  # from stdout (the JSON result). The previous 2>&1 merge buried the
  # JSON inside dozens of `[apkeep-resolve] Failed:` /
  # `[parallel-resolve] …` lines, so jq couldn't parse it, exited
  # non-zero, the `|| true` swallowed the error, and the `reason:`
  # line was silently skipped — leaving the operator guessing whether
  # the cause was missing APKMirror API credentials, a Cloudflare
  # block on the Playwright path, an APKPure rate-limit, or something
  # else entirely.
  result="$(node "$(dirname "$0")/../.github/scripts/unified-downloader.js" "$pkg" "$version" "$APK_DIR" 2>"$stderr_log" || true)"
  if printf '%s' "$result" | jq -e '.success' >/dev/null 2>&1; then
    local url
    url="$(printf '%s' "$result" | jq -r '.url // empty')"
    if [ -n "$url" ] && [ "$url" != "null" ]; then
      printf '%s:%s:%s\n' "$pkg" "$version" "$url" > "$RESULTS_DIR/${pkg}.txt"
      return 0
    fi
  fi
  log_warn "  [$pkg] unified-downloader failed for v${version}"
  err="$(printf '%s' "$result" | jq -r '.error // empty' 2>/dev/null || true)"
  if [ -n "$err" ] && [ "$err" != "null" ]; then
    log_warn "  [$pkg]   reason: ${err}"
  fi
  # Surface the per-source diagnostic lines so the operator can see
  # WHICH fallback source failed and what its concrete error was.
  # Without this, only the composite "All sources failed to resolve
  # URL" is visible — the per-source cause (missing
  # APKMIRROR_API_USER/PASS, Cloudflare 403 on the Playwright path,
  # APKPure rate-limit, apkeep EACCES, etc.) is invisible.
  if [ -s "$stderr_log" ]; then
    log_warn "  [$pkg]   stderr:"
    sed 's/^/    /' "$stderr_log" \
      | grep -E '^\s+\[(apkeep-resolve|apkmirror-api-resolve|apkmirror-resolve|parallel-resolve|apkeep|apkmirror-api|apkmirror-pw|apkmirror|download)\] ' \
      | while IFS= read -r line; do
          log_warn "  [$pkg]   ${line}"
        done
  fi

  # Pinned-version emergency fallback: retry with the head of
  # morphe-desktop list-versions.
  local pin
  pin="$(pinned_version "$pkg")"
  if [ -z "$pin" ] || [ "$pin" = "null" ] || [ "$pin" != "$version" ]; then
    echo "FAILED:download-error" > "$RESULTS_DIR/${pkg}.failed"
    return 0
  fi
  local fallback
  fallback="$(java -jar "$TOOLS_DIR/morphe-desktop.jar" list-versions -f "$pkg" --patches="$TOOLS_DIR/patches.mpp" 2>/dev/null \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
  if [ -z "$fallback" ]; then
    echo "FAILED:no-fallback-version" > "$RESULTS_DIR/${pkg}.failed"
    return 0
  fi
  log "  [$pkg] emergency fallback to v${fallback}..."
  # Same stderr separation for the fallback attempt. Reassigning
  # $stderr_log updates which file the RETURN trap cleans up.
  stderr_log="$(mktemp)"
  result="$(node "$(dirname "$0")/../.github/scripts/unified-downloader.js" "$pkg" "$fallback" "$APK_DIR" 2>"$stderr_log" || true)"
  if printf '%s' "$result" | jq -e '.success' >/dev/null 2>&1; then
    local url
    url="$(printf '%s' "$result" | jq -r '.url // empty')"
    if [ -n "$url" ] && [ "$url" != "null" ]; then
      printf '%s:%s:%s\n' "$pkg" "$fallback" "$url" > "$RESULTS_DIR/${pkg}.txt"
      return 0
    fi
  fi
  log_warn "  [$pkg] unified-downloader failed for fallback v${fallback}"
  err="$(printf '%s' "$result" | jq -r '.error // empty' 2>/dev/null || true)"
  if [ -n "$err" ] && [ "$err" != "null" ]; then
    log_warn "  [$pkg]   reason: ${err}"
  fi
  if [ -s "$stderr_log" ]; then
    log_warn "  [$pkg]   stderr:"
    sed 's/^/    /' "$stderr_log" \
      | grep -E '^\s+\[(apkeep-resolve|apkmirror-api-resolve|apkmirror-resolve|parallel-resolve|apkeep|apkmirror-api|apkmirror-pw|apkmirror|download)\] ' \
      | while IFS= read -r line; do
          log_warn "  [$pkg]   ${line}"
        done
  fi
  echo "FAILED:fallback-error" > "$RESULTS_DIR/${pkg}.failed"
  return 0
}

# --- parallel download -----------------------------------------------------

log "Pre-downloading APKs for $(list_app_ids | wc -l | tr -d ' ') app(s)..."

pids=()
while IFS= read -r pkg; do
  download_for "$pkg" &
  pids+=("$!")
done < <(list_app_ids)

for pid in "${pids[@]}"; do
  wait "$pid" || true
done

# --- merge results + write download_urls ----------------------------------

if compgen -G "$RESULTS_DIR/*.txt" >/dev/null; then
  cat "$RESULTS_DIR"/*.txt > "$RESULTS_DIR/merged.txt" || true
  if auto_update_urls_enabled; then
    while IFS=: read -r pkg ver url; do
      [ -z "$pkg" ] && continue
      node "$(dirname "$0")/../.github/scripts/update-download-urls.js" "$pkg" "$ver" "$url" >/dev/null || true
    done < "$RESULTS_DIR/merged.txt"
  else
    log "auto_update_urls is disabled in config.json; skipping download_urls backfill."
  fi
fi

log "Pre-download complete."
if compgen -G "$RESULTS_DIR/*.failed" >/dev/null; then
  log_warn "Some apps failed to pre-download:"
  for f in "$RESULTS_DIR"/*.failed; do
    log_warn "  $(basename "$f" .failed): $(cat "$f")"
  done
fi