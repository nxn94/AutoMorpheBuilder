# .github/scripts/pipeline/

Shell pipeline for `.github/workflows/morphe-build.yml` (and friends).
The scripts are split by responsibility: each one is small enough to read
in a few minutes and has a focused purpose. Cross-cutting helpers live
under `lib/` and are sourced (not executed) by the per-step scripts.

## Layout

```
.github/scripts/pipeline/
├── README.md                 this file
├── lib/                      shared helpers (sourced)
│   ├── common.sh             logging, retry, validation, tempdirs
│   ├── config.sh             config.json / patches.json helpers
│   ├── github.sh             gh CLI wrappers + token checks
│   ├── json.sh               jq-backed JSON access
│   └── apk.sh                aapt helpers
├── check_versions.sh         resolve latest Morphe + CLI tags; emit matrix + should-build
├── install_apkeep.sh         download apkeep binary
├── install_aapt.sh           install aapt + capture build-tools version
├── install_playwright.sh     install Playwright Chromium + smoke test
├── download_morphe_tools.sh  download morphe-desktop.jar + per-repo .mpp
├── fetch_morphe_tools.sh     per-matrix mpp / cli / APKEditor download
├── pre_download_apks.sh      parallel pre-download APKs across all apps
├── prepare_target_version.sh gather inputs for download-supported-apk.js
├── patch_apk.sh              run morphe-desktop patch --keystore; rename output for Obtainium
├── retry_fresh_original.sh   patch again on a fresh original after a fingerprint failure on a cached one
├── create_release.sh         publish per-app GitHub Releases
├── resolve-tag.sh            resolve branch → tag (sourced by check_versions.sh + update-patches.yml)
└── sync-patches.sh           sync patches.json from upstream patch repos (invoked by update-patches.yml)
```

The Node.js helpers under `.github/scripts/` are unchanged: they're still
the implementation files for things like morphe-desktop jar download
orchestration, the unified-downloader, and check-existing-releases. The
shell scripts here are thin orchestrators that call into those helpers.

## Conventions

- Every script begins with `set -Eeuo pipefail` so failures are loud.
- All scripts source `lib/common.sh` for logging/validation helpers.
- `log()` goes to stderr; `log_warn`/`log_error` add GitHub Actions
  `::warning::`/`::error::` prefixes.
- Scripts accept inputs via environment variables, not positional
  arguments, unless they're an executable command (e.g. install_apkeep.sh
  takes flags like `--help` if added later).
- Scripts that write workflow outputs use `json_set_output <key> <value>`
  from `lib/json.sh`, which echoes the line and writes to $GITHUB_OUTPUT.

## Running scripts locally

Most scripts require environment variables the workflow normally sets
(`GH_TOKEN`, `GITHUB_REPOSITORY`, secret names, etc.). To run one
locally:

```bash
# export the variables the script expects, then:
bash .github/scripts/pipeline/install_apkeep.sh
bash .github/scripts/pipeline/check_versions.sh
```

For metadata sync, run the standalone entry point against local
`config.json` / `patches.json` (this updates `patches.json`):

```bash
# Resolves exact patch tags and the configured CLI tag.
# Java 21 is required if metadata must be derived from a verified MPP.
bash scripts/sync-patches.sh
```

The lower-level `pipeline/sync-patches.sh` accepts resolved `REPO_VERSIONS`
and `CLI_TAG`. Metadata fallback shares `../patch-metadata.js` with preflight
and matrix tool setup; failures preserve existing selections.

## Validation

Run before opening a PR:

```bash
bash -n .github/scripts/pipeline/*.sh .github/scripts/pipeline/lib/*.sh        # syntax
shellcheck .github/scripts/pipeline/*.sh .github/scripts/pipeline/lib/*.sh     # shell lint
node node_modules/.bin/eslint .github/scripts                                   # JS (covers .github/scripts/)
node node_modules/.bin/jest                                                     # JS unit tests
```

The workflow YAML itself is validated by GitHub Actions; for local
checking, use `actionlint` or `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/morphe-build.yml"))'`.