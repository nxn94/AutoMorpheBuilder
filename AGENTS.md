# AGENTS.md - AutoMorpheBuilder

## What this repo is

GitHub Actions CI/CD project that builds patched Android APKs with [Morphe](https://github.com/MorpheApp/morphe-patches) patches. **The workflow is the product** — there is no app to run locally. The full system is three YAML workflows plus one tree of scripts under `.github/scripts/`:
- **Node.js helpers** (top-level `.github/scripts/*.js` and `__tests__/`) — orchestration, downloaders, validators, tests.
- **Shell pipeline** under `.github/scripts/pipeline/` — each top-level `<step>.sh` corresponds to one workflow step, with shared helpers in `pipeline/lib/`.

Supported apps (defined in `config.json` `patch_repos`): `com.google.android.youtube`, `com.google.android.apps.youtube.music`, `com.reddit.frontpage`. Add a new app = add a single entry to `config.json` `patch_repos` (includes `apkmirror_path`), no workflow edits.

## Key files

### Workflows

| File | Purpose |
|------|---------|
| `.github/workflows/morphe-build.yml` | Main build workflow. Runs daily at 05:15 UTC + manual `workflow_dispatch`. `check-versions → build (matrix per app) → create-release`. |
| `.github/workflows/update-patches.yml` | Manual-only workflow to refresh `patches.json` from upstream patch repos. |
| `.github/workflows/ci.yml` | Pull-request + main-branch CI: `npm ci` → `npm run lint` → `npm test`. Gates broken PRs. |

### Config

| File | Purpose |
|------|---------|
| `config.json` | Build config: `patch_repos` (per-app, with `name`, `repo`, `branch`, `apkmirror_path`, optional `pin_version`), `cli` repo/branch, `download_urls` cache, `auto_update_urls` flag (default `true`). |
| `patches.json` | Patch toggles — **repo-keyed**: `{ "owner/repo": { "pkg": { "Patch": true } } }` |
| `eslint.config.js` | Flat-config ESLint setup (v9). Scoped to `.github/scripts/**/*.js`. |

### Node.js helpers (`.github/scripts/`)

| File | Purpose |
|------|---------|
| `unified-downloader.js` | APK downloader with multi-source fallback (config cache → URL cache → parallel apkeep/APKMirror-API/Playwright resolution → sequential fallback). |
| `download-supported-apk.js` | Per-app download orchestration with version + ABI validation. |
| `apk-selection.js` | Pure scoring/ranking helpers (apkHasNativeLibsForArch, listApkAbis, findBundleInDir, etc.). |
| `apk-abi-validator.js` | Post-download ABI validation for the downloader. |
| `resolve-supported-version.js` | Morphe-supported version resolver. |
| `check-existing-releases.js` | Per-app release-tag comparison: for each matrix entry, resolve the APK version (pinned or via `morphe-desktop list-versions`) and drop entries whose `<name>-v<apk>-<patches>` release already exists. Pure `decide(matrix, apkVersions, releaseExists)` is unit-tested; the env-dependent `main()` shell-outs are integration-tested by the workflow. |
| `patch-apk-manifest.js` | APK manifest patching primitives. |
| `patch-playwright-cft-path.js` | Patches Playwright's chromium-for-testing download path on disk. |
| `update-download-urls.js` | Writes resolved URLs back to `config.json` `download_urls`. CLI: `node update-download-urls.js <pkg> <version> <url>`. Honoured only when `auto_update_urls` is true. |
| `install-aapt.js` | Installs Android `aapt` (cmdline-tools + build-tools 34.0.0). Idempotent. |
| `install-playwright-browsers.js` | Custom Playwright installer (bypasses a yauzl/Node bug in Playwright 1.58). |
| `cleanup-caches.js` | Prunes stale GitHub Actions caches. Dry-run by default; `--apply` to delete. |
| `resolve-tag.sh` | Shared shell script: `resolve_release_tag` function (sourced by both workflows). |
| `sync-patches.sh` | Patches.json syncer (used by update-patches.yml). |

### Shell pipeline (`.github/scripts/pipeline/`)

| File | Purpose |
|------|---------|
| `check_versions.sh` | Resolves latest Morphe patch + CLI tags and emits the optimistic-default build matrix (`should-build=true`, full set). The downstream `check_existing_releases.sh` step may override both. |
| `check_existing_releases.sh` | Thin shell wrapper around `.github/scripts/check-existing-releases.js`. Validates env then `exec node`s the implementation. |
| `pre_download_apks.sh` | Pre-downloads APKs in parallel across all configured apps before the build matrix spins up. Calls `update-download-urls.js` per app (honoured by `auto_update_urls`). Honours the `SKIP_LIST` env var emitted by `check_existing_releases.sh` — apps in the skip-list are not pre-downloaded. |
| `fetch_morphe_tools.sh` | Fetches `.mpp` patches + `morphe-desktop.jar` + `APKEditor.jar` per matrix entry. |
| `download_morphe_tools.sh` | Bulk morphe-desktop + patches download (check-versions step). |
| `prepare_target_version.sh` | Computes the pinned version for the matrix entry. |
| `prepare_keystore.sh` | Decodes `KEYSTORE_BASE64`, detects type, produces BKS (morphe-desktop) + PKCS12 (apksigner) keystores. Uses `keytool -storepass:env / -keypass:env` so passwords never appear on the cmdline. |
| `patch_apk.sh` | Runs `morphe-desktop.jar patch` and writes the patched APK to `out/`. |
| `create_release.sh` | Publishes per-app GitHub Releases. |
| `install_aapt.sh` | Idempotent `aapt` install. |
| `install_apkeep.sh` | Downloads apkeep binary; pins SHA-256 against `APKEEP_VERSION`. |
| `install_bouncycastle.sh` | Downloads BouncyCastle provider jar from Maven Central; verifies SHA-256 from the companion `.sha256` file. |
| `install_playwright.sh` | Installs Playwright Chromium (uses the download-host env override). |
| `lib/common.sh`, `lib/json.sh`, `lib/config.sh`, `lib/apk.sh`, `lib/github.sh` | Sourced helpers shared across `pipeline/*.sh`. `config.sh` exposes `auto_update_urls_enabled`, `pinned_version`, `list_app_ids`, etc. |

### Tests (`.github/scripts/__tests__/`)

| File | Purpose |
|------|---------|
| `apk-selection.test.js` | Pure helpers — scoring, ABI matching, bundle discovery. |
| `apk-abi-validator.test.js` | Post-download ABI validation. |
| `apkmirror-scraper.test.js` | URL/variant helpers in `unified-downloader.js`. |
| `cleanup-caches.test.js` | Cache-pruning script. |
| `fallback-chain.test.js` | Multi-source download fallback ordering. |
| `patch-apk-manifest.test.js` | Manifest patching. |
| `unified-downloader-cleanup.test.js` | Cleanup-on-failure contract for the downloader. |
| `check-existing-releases.test.js` | Pure `decide()` + `buildMatrix()` helpers — release-tag comparison, fail-open on unresolved versions, mixed keep/skip matrices. |

## Workflow job graph (morphe-build.yml)

```
check-versions → build (matrix per app) → create-release
```

- `check-versions` — two-phase:
  1. **Tag resolution** (`.github/scripts/pipeline/check_versions.sh`): queries GitHub for the latest Morphe patch + CLI tags, emits the full matrix and `should-build=true` (optimistic default).
  2. **Release comparison** (`.github/scripts/pipeline/check_existing_releases.sh`): for each app, resolves the APK version (pinned or via `morphe-desktop list-versions`), computes the expected release tag `<name>-v<apk>-<patches>`, and checks `gh release view <tag>`. Apps whose release already exists are dropped from the matrix and added to `skip-list`. If the filtered matrix is empty, `should-build` flips to `false` and both `build` and `create-release` skip. If the matrix is non-empty, only the changed apps are built and pre-downloaded.
  - The expensive setup steps (npm ci, Playwright, apkeep, aapt, APK pre-download) are all gated on the **post-filter** `should-build`, so a no-op day avoids the network/install cost entirely.
  - Failure policy is **fail-open**: if the APK version can't be resolved (missing jar/.mpp) or `gh release view` errors, the app is kept in the matrix and a `::warning::` is logged. The build never silently skips an app we couldn't version-check.
  - Hard-fails if `patch_repos` is empty or `cli.repo`/`cli.branch` is missing.
- `build` — per-app parallel matrix (already filtered to apps that need re-building). Downloads APK, patches with morphe-desktop, signs (signing is **enforced** — no unsigned output). Uses `pin_version` from `config.json` if set, otherwise picks the latest Morphe-supported version.
- `create-release` — one GitHub Release per app, tag `<name>-v<apk-version>-<patches-version>` (e.g. `youtube-v20.44.38-v1.24.0-dev.8`), contains only that app's APK.

## Developer commands

```bash
# Run JS unit tests (Jest)
npm test
npx jest .github/scripts/__tests__/apkmirror-scraper.test.js   # single file
# Note: apk-selection.test.js and apk-abi-validator.test.js shell
# out to `zip`. Install it (`sudo apt-get install -y zip`) for those
# tests to actually exercise instead of skipping.

# Validate JSON
jq '.' patches.json && jq '.' config.json

# Lint JS
npm run lint                              # via eslint.config.js
npx eslint .github/scripts                # same

# Lint shell
shellcheck .github/scripts/pipeline/*.sh .github/scripts/pipeline/lib/*.sh

# Validate workflow (any of these work)
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .
actionlint .github/workflows/morphe-build.yml
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/morphe-build.yml'))" && echo "YAML is valid"

# Run the cache cleanup locally (dry-run, needs GH_TOKEN)
GITHUB_REPOSITORY=owner/repo GH_TOKEN=... node .github/scripts/cleanup-caches.js
GITHUB_REPOSITORY=owner/repo GH_TOKEN=... node .github/scripts/cleanup-caches.js --apply
```

## Config structure (CRITICAL — do not rename keys)

`config.json` uses `patch_repos` and `cli` (NOT `branches`). The top-level shape is:

```json
{
  "preferred_arch": "arm64-v8a",
  "auto_update_urls": true,
  "patch_repos":      { "com.google.android.youtube": { "name": "youtube", "repo": "MorpheApp/morphe-patches", "branch": "main", "apkmirror_path": "google-inc/youtube", "pin_version": "20.45.36" } },
  "cli":              { "repo": "MorpheApp/morphe-desktop", "branch": "main" },
  "download_urls":    { "com.google.android.youtube": { "8.44.54": "...", "latest_supported": "..." } }
}
```

- `pin_version` (optional, per app) locks the build to a specific APK version, bypassing Morphe-supported resolution. When set, `update-download-urls.js` skips URL updates for that app.
- `auto_update_urls` (top-level, default `true`) gates whether resolved download URLs are written back to `config.json` after a pre-download. See the "Repo quirks" section for details.
- `apkmirror_path` (required, per app in `patch_repos`) is the APKMirror URL slug for that package (e.g. `google-inc/youtube`).
- `download_urls` is auto-managed — do not hand-edit.

`patches.json` is **repo-keyed** (top-level key = `owner/repo`, e.g. `MorpheApp/morphe-patches`). The old flat `{pkg: {patch: true}}` format is detected and reset to all-true on first run of `update-patches.yml`. Toggles you set are preserved across syncs; new upstream patches default to `true`.

## Adding a new app

1. Add the package to `config.json` `patch_repos` with `name`, `repo`, `branch`, and `apkmirror_path` (URL slug).
2. Trigger `.github/workflows/update-patches.yml` manually to populate `patches.json` from the upstream repo.
3. Edit `patches.json` to enable/disable specific patches.
4. Push — next scheduled or manual build picks it up via the dynamic matrix.

No `morphe-build.yml` edits needed; the matrix is derived from `config.json`.

## Artifact / release naming

- Artifact: `<app>-v<base-version>-<patches-version>.apk` (e.g. `youtube-v20.44.38-v1.24.0-dev.8.apk`).
- Release tag per app: `<app>-v<base-version>-<patches-version>`.
- The `-v` infix in the APK filename is required — Obtainium filters use `^youtube-v.*\.apk$` (release tag `^youtube`, APK filter `^youtube-v.*\.apk$`). One Obtainium entry per app, same repo.

## Signing (enforced)

- Decode `KEYSTORE_BASE64` → `tools/source.keystore`. Required secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`. Optional: `KEY_ALIAS` (defaults to first), `KEY_PASSWORD` (only if differs from keystore password).
- Workflow detects type (PKCS12 / JKS / BKS / UBER) and converts to BKS for morphe-desktop.
- Build fails immediately if signing cannot complete — there is no "unsigned" output path.

## Repo quirks (not obvious from filenames)

- `patches.json` gets pushed back to `main` by the `update-patches.yml` workflow. Local edits will conflict on the next run. Make `patches.json` changes before the run, or trigger `update-patches.yml` first.
- `download_urls` cached at `~/.cache/auto-morphe-builder/urls/` is consulted **before** `config.json` `download_urls` — clear it if you want to force re-resolution.
- `auto_update_urls` in `config.json` gates whether `pre_download_apks.sh` writes back resolved URLs to `config.json` after a pre-download. Default `true`. When `false`, the resolved URL is logged but `config.json` is left untouched (useful if you want to pin downloads to specific URLs or avoid noisy diffs). Set to `true`/`false`/`1`/`0`/`yes`/`no`; anything else is treated as `false`.
- An older version of this project shipped a `state.json` file (introduced in the original `feat: add CI/CD workflow` commit, removed by `chore: remove state.json and the update-state job`). If you see references to it in old docs, PRs, or commit messages, that's historical — do not re-introduce it.
- BouncyCastle is cached via `actions/cache@v5` (bcprov-jdk18on 1.77) and only downloaded when the cache misses.
- APKMirror scraper uses Playwright when curl is blocked by Cloudflare; all 3 pages (release → variant → download) navigate in the same browser session to preserve cookies. The custom `install-playwright-browsers.js` is required — `npx playwright install` is broken on Playwright 1.58 (yauzl extraction hang).
- `npm ci` + `npx playwright install chromium` runs on every CI build (not cached at the npm level).

## Common failures

- **`Chosen APK has no classes.dex`** — the scraper picked a split/config APK. The target version likely only has a BUNDLE variant on APKMirror. Check APKMirror manually; pin to an earlier version with `pin_version` if needed.
- **`Wrong version of key store`** — keystore password wrong, or key password differs from keystore password (set `KEY_PASSWORD`).
- **`Could not resolve a Morphe-supported version`** — `patches-list.json` format changed. Old key-indexed syntax: `.compatiblePackages[$pkg]`. New array-of-objects syntax requires `select(.packageName == $pkg)`. `targetver` step and both workflows now handle both forms.
- **APK download fails / `No APK could be downloaded`** — Cloudflare rate-limit on APKMirror. Re-run; transient. Verify `apkmirror_path` slugs in `config.json` `patch_repos` are still valid.
- **Obtainium not finding updates** — confirm both filters are set (Release Tag Filter + APK Filter) and the APK filter includes the `-v` infix.
- **Untracked `.xapk`/`.apkm` from a failed source pre-empts the good one** — the downloader's cleanup-on-failure contract (delete partial APK on validation throw) ensures that when the apkeep / direct-URL curl / Playwright fallback fails ABI or version validation, the file goes away. Without this, the `APKS_DIR` ends up with a stale file that gets picked by `findPackageCandidate` (first-encountered tiebreak on equal scores, via filesystem-dependent readdir order — not guaranteed alphabetical on ext4) over the working bundle from a later source. Symptom: the merged APK is missing the preferred arch even though the downloader reported success via a later source. The new tests in `__tests__/unified-downloader-cleanup.test.js` pin this contract.
- **Workflow skipping apps that should be rebuilt** — `check_existing_releases.sh` is fail-open, so the only way it can skip an app that genuinely needs a rebuild is if `morphe-desktop list-versions` returns a *different* version than what `releaseExists` matches against (e.g. experimental versions filtered out by the CLI). If you need to force a rebuild, manually delete the offending release tag (`gh release delete <app>-v<apk>-<patches>`) and re-run. The next scheduled run will rebuild it.

## Local environment

`package.json` declares `engines.node >=24` to match the GitHub Actions runner (which uses `actions/setup-node` with `node-version: '24'`). Tests use Jest only. The flat-config ESLint setup at the repo root (`eslint.config.js`) is what `npm run lint` runs against `.github/scripts/`; the documented `npx eslint .github/scripts/*.js` command also works. The shell pipeline under `.github/scripts/pipeline/` is linted via `shellcheck` (not part of `npm run lint`). The PR CI workflow (`.github/workflows/ci.yml`) installs `zip` via `apt-get` because the apk-selection / apk-abi-validator test fixtures shell out to `zip`. No OpenCode config (`opencode.json`) is present in the repo.
