#!/usr/bin/env bash
# Optional provider: an installation failure must not disable existing sources.
set -Eeuo pipefail

venv="${TOOLS_DIR:-./tools}/goopdl"
# Evaluated upstream 1.2.2; immutable source pin rather than a moving release tag.
source_url='goopdl @ https://github.com/Villoh/goopdl/archive/30c43eb0f4e06d5ab0a45e39c559a2869a2c7d68.tar.gz'
if python3 -m venv "$venv" \
  && "$venv/bin/python" -m pip install --disable-pip-version-check --quiet --timeout 30 --retries 1 "$source_url" \
  && "$venv/bin/goopdl" --help >/dev/null; then
  printf 'goopdl installed from pinned upstream source.\n'
else
  printf '::warning::goopdl installation failed; existing APK sources remain available.\n' >&2
  rm -rf -- "$venv"
fi
