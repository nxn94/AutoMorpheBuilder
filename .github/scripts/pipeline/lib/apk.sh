#!/usr/bin/env bash
#
# scripts/lib/apk.sh — APK manipulation helpers (aapt, apksigner).
#
# Sourced, not executed. Centralises the calls to Google's SDK tools
# (aapt dump badging, apksigner sign) so they share the same
# path-discovery + retry logic. Also exposes read_apk_version which is
# duplicated in download-supported-apk.js — the shell version is here for
# the small handful of shell-side flows that need it.

# shellcheck source=./common.sh
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# Read the versionName attribute from an APK using aapt. Falls back to
# aapt2 if aapt isn't installed. Returns '' if neither is available.
read_apk_version() {
  local apk="$1"
  require_file "$apk" >/dev/null || return 1
  local info=""
  if command -v aapt >/dev/null 2>&1; then
    info="$(aapt dump badging "$apk" 2>/dev/null || true)"
  elif command -v aapt2 >/dev/null 2>&1; then
    info="$(aapt2 dump badging "$apk" 2>/dev/null || true)"
  fi
  if [ -z "$info" ]; then
    printf ''
    return 0
  fi
  local v
  v="$(printf '%s\n' "$info" | sed -nE "s/.*versionName='([^']+)'.*/\1/p" | head -n1)"
  printf '%s' "$v"
}

# Print "yes" if APK has classes*.dex in its zip listing, "no" otherwise.
apk_has_dex() {
  local apk="$1"
  if ! command -v unzip >/dev/null 2>&1; then
    log_error "unzip is required to probe APK contents"
    return 1
  fi
  unzip -Z1 "$apk" 2>/dev/null | awk '/^classes[0-9]*\.dex$/ {found=1} END {exit !found}'
}