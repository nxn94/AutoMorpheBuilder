#!/usr/bin/env bash
# Download required apps in parallel into tools/apks/<package-id>/.
# Reuse supported-versions.json from the compatibility probe. Pins stay exact.
# Download failures are warnings here; the matrix retries and validates the
# final APK. SKIP_LIST omits apps with complete matching releases.

set -Eeuo pipefail

. "$(dirname "$0")/lib/common.sh"
. "$(dirname "$0")/lib/json.sh"
. "$(dirname "$0")/lib/config.sh"

TOOLS_DIR="${TOOLS_DIR:-./tools}"
APK_DIR="${APK_DIR:-${TOOLS_DIR}/apks}"
RESULTS_DIR="${RESULTS_DIR:-${RUNNER_TEMP:-/tmp}/download_results}"
_default_repo_versions='{}'
REPO_VERSIONS="${REPO_VERSIONS:-$_default_repo_versions}"
SKIP_LIST="${SKIP_LIST:-[]}"

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

  local resolved
  resolved="$(jq -r --arg pkg "$pkg" '.[$pkg][0] // empty' "$TOOLS_DIR/supported-versions.json" 2>/dev/null || true)"
  if [ -n "$resolved" ]; then printf '%s' "$resolved"; return 0; fi

  # Resolve the patch repo for this app and find its .mpp file.
  local slug mpp
  slug="$(node "$(dirname "$0")/../build-plan.js" | jq -r --arg pkg "$pkg" '.[] | select(.appId == $pkg) | .patchSlug')"
  mpp="$TOOLS_DIR/${slug}.mpp"
  if [ ! -f "$mpp" ] || [ ! -f "$TOOLS_DIR/morphe-desktop.jar" ]; then
    log_warn "  [$pkg] no .mpp or morphe-desktop.jar; cannot resolve version"
    return 1
  fi

  # Pass the per-app .mpp directly to morphe-desktop. The previous code
  # copied all per-app .mpp files to a single shared $TOOLS_DIR/patches.mpp
  # and ran the java call against that — but `download_for()` runs in
  # parallel for every app, so a copy from a later app would overwrite
  # the .mpp an earlier app's java call was still reading. Sofascore was
  # failing "could not determine version" because the in-flight copy had
  # been replaced with MorpheApp-morphe-patches.mpp (which doesn't list
  # com.sofascore.results) by the time its java call ran.
  local versions version
  # Sort the version list descending (numeric-aware) before picking head —
  # the CLI does not guarantee "latest first" (e.g. Twitch's RookieEnough/
  # De-Vanced mpp prints 16.9.1 before 25.3.0). The regex accepts 2+
  # segment versions so 24.3 (nzb360), 25.3.0 (Twitch), 26.07.27 (Sofascore)
  # all match.
  versions="$(java -jar "$TOOLS_DIR/morphe-desktop.jar" list-versions -f "$pkg" --patches="$mpp" 2>/dev/null || true)"
  version="$(printf '%s\n' "$versions" | grep -oE '[0-9]+(\.[0-9]+)+' | sort -Vr | head -n1 || true)"
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
  local APK_DIR="${APK_DIR}/${pkg}"
  mkdir -p "$APK_DIR"
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
  result="$(node "$(dirname "$0")/../unified-downloader.js" "$pkg" "$version" "$APK_DIR" 2>"$stderr_log" || true)"
  if printf '%s' "$result" | jq -e '.success' >/dev/null 2>&1; then
    local url
    url="$(printf '%s' "$result" | jq -r '.url // empty')"
    if [ -n "$url" ] && [ "$url" != "null" ]; then
      printf '%s:%s:%s\n' "$pkg" "$version" "$url" > "$RESULTS_DIR/${pkg}.txt"
      return 0
    fi
    # Google Play returns a local artifact, not a reusable public URL.
    if printf '%s' "$result" | jq -e '.source == "goopdl" and (.file | type == "string")' >/dev/null 2>&1; then
      local artifact
      artifact="$(printf '%s' "$result" | jq -r '.file')"
      if [ -f "$artifact" ]; then return 0; fi
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

  echo "FAILED:download" > "$RESULTS_DIR/${pkg}.failed"
  return 0
}

# --- parallel download -----------------------------------------------------

# Filter to apps that need pre-downloading. The skip list is an array
# of appIds that already have a current release (per
# check_existing_releases.sh). They don't need an APK fetch — the
# build matrix won't include them either.
declare -A SKIPPED
if [ "$SKIP_LIST" != "[]" ] && [ -n "$SKIP_LIST" ]; then
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    SKIPPED["$pkg"]=1
  done < <(jq -r '.[]' <<<"$SKIP_LIST")
fi

buildable=()
while IFS= read -r pkg; do
  if [ -n "${SKIPPED[$pkg]:-}" ]; then
    log "  [$pkg] in skip-list; not pre-downloading."
    continue
  fi
  buildable+=("$pkg")
done < <(list_app_ids)

if [ "${#buildable[@]}" -eq 0 ]; then
  log "All apps are in the skip-list; nothing to pre-download."
  exit 0
fi

log "Pre-downloading APKs for ${#buildable[@]} app(s)..."

pids=()
for pkg in "${buildable[@]}"; do
  download_for "$pkg" &
  pids+=("$!")
done

for pid in "${pids[@]}"; do
  wait "$pid" || true
done

# --- merge results + write download_urls ----------------------------------

if compgen -G "$RESULTS_DIR/*.txt" >/dev/null; then
  cat "$RESULTS_DIR"/*.txt > "$RESULTS_DIR/merged.txt" || true
  if auto_update_urls_enabled; then
    while IFS=: read -r pkg ver url; do
      [ -z "$pkg" ] && continue
      node "$(dirname "$0")/../update-download-urls.js" "$pkg" "$ver" "$url" >/dev/null || true
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