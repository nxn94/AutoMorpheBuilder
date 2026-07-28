# scripts/

Build helpers used by `.github/workflows/morphe-build.yml` (and friends).
The scripts are split by responsibility: each one is small enough to read
in a few minutes and has a focused purpose. Cross-cutting helpers live
under `scripts/lib/` and are sourced (not executed) by the per-step
scripts.

## Layout

```
scripts/
├── README.md                 this file
├── lib/                      shared helpers (sourced)
│   ├── common.sh             logging, retry, validation, tempdirs
│   ├── config.sh             config.json / patches.json helpers
│   ├── github.sh             gh CLI wrappers + token checks
│   ├── json.sh               jq-backed JSON access
│   └── apk.sh                aapt / apksigner helpers
├── check_versions.sh         resolve latest Morphe + CLI tags; emit matrix + should-build
├── install_apkeep.sh         download apkeep binary
├── install_aapt.sh           install aapt + capture build-tools version
├── install_bouncycastle.sh   download BouncyCastle provider jar
├── install_playwright.sh     install Playwright Chromium + smoke test
├── download_morphe_tools.sh  download morphe-desktop.jar + per-repo .mpp
├── fetch_morphe_tools.sh     per-matrix mpp / cli / APKEditor download
├── pre_download_apks.sh      parallel pre-download APKs across all apps
├── prepare_target_version.sh gather inputs for download-supported-apk.js
├── prepare_keystore.sh       decode KEYSTORE_BASE64; produce BKS + PKCS12 keystores
├── patch_apk.sh              run morphe-desktop patch; rename output for Obtainium
└── create_release.sh         publish per-app GitHub Releases
```
The previously-existing helpers under `.github/scripts/` are unchanged:
they're still the implementation files for things like morphe-desktop jar
download orchestration, the unified-downloader, and sync-patches. The
scripts here are thin orchestrators that call into those helpers.

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
bash scripts/install_apkeep.sh
bash scripts/check_versions.sh
```

For the JSON state scripts, you can dry-run them against the local
`config.json` / `patches.json`:

```bash
# sync-patches.sh lives under .github/scripts/ and is invoked from the
# manual update-patches.yml workflow, not from scripts/.
REPO_VERSIONS='{"MorpheApp/morphe-patches":"v1.32.0"}' \
  bash .github/scripts/sync-patches.sh
```

## Validation

Run before opening a PR:

```bash
bash -n scripts/*.sh scripts/lib/*.sh        # syntax
node node_modules/.bin/eslint scripts         # JS (covers .github/scripts/)
node node_modules/.bin/jest                  # JS unit tests
```

The workflow YAML itself is validated by GitHub Actions; for local
checking, use `actionlint` or `python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/morphe-build.yml"))'`.