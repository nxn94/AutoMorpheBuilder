# AGENTS.md - AutoMorpheBuilder

## What this repo is

GitHub Actions CI/CD project that builds patched Android APKs with [Morphe](https://github.com/MorpheApp/morphe-patches) patches. **The workflow is the product** — there is no app to run locally. The full system is two YAML files plus a handful of Node.js scripts under `.github/scripts/`.

Supported apps (defined in `config.json` `patch_repos`): `com.google.android.youtube`, `com.google.android.apps.youtube.music`, `com.reddit.frontpage`. Add a new app = add a single entry to `config.json` `patch_repos` (includes `apkmirror_path`), no workflow edits.

## Key files

| File | Purpose |
|------|---------|
| `config.json` | Build config: `patch_repos` (per-app, with `name`, `repo`, `branch`, `apkmirror_path`, optional `pin_version`), `cli` repo/branch, `download_urls` cache. |
| `patches.json` | Patch toggles — **repo-keyed**: `{ "owner/repo": { "pkg": { "Patch": true } } }` |
| `.github/workflows/morphe-build.yml` | Main workflow (contains all build logic). Runs daily at 05:15 UTC + manual `workflow_dispatch`. |
| `.github/workflows/update-patches.yml` | Manual-only workflow to refresh `patches.json` from upstream patch repos. |
| `.github/scripts/unified-downloader.js` | APK downloader with multi-source fallback (config cache → URL cache → parallel apkeep/APKMirror-API/Playwright resolution → sequential fallback). |
| `.github/scripts/update-download-urls.js` | Writes resolved URLs back to `config.json` `download_urls`. CLI: `node update-download-urls.js <pkg> <version> <url>`. |
| `.github/scripts/install-aapt.js` | Installs Android `aapt` (cmdline-tools + build-tools 34.0.0). Idempotent. |
| `.github/scripts/install-playwright-browsers.js` | Custom Playwright installer (bypasses a yauzl/Node bug in Playwright 1.58). |
| `.github/scripts/cleanup-caches.js` | Prunes stale GitHub Actions caches. Dry-run by default; `--apply` to delete. |
| `.github/scripts/resolve-tag.sh` | Shared shell script: `resolve_release_tag` function (sourced by both workflows). |
| `.github/scripts/__tests__/apkmirror-scraper.test.js` | Jest unit tests for URL/variant helpers in `unified-downloader.js`. |

## Workflow job graph (morphe-build.yml)

```
check-versions → build (matrix per app) → create-release
```

- `check-versions` — queries GitHub for latest Morphe patch/CLI tags, emits the build matrix, pre-downloads APKs (in parallel across apps). Sets `should-build=true` (always builds). Hard-fails if `patch_repos` is empty or `cli.repo`/`cli.branch` is missing.
- `build` — per-app parallel matrix. Downloads APK, patches with morphe-desktop, signs (signing is **enforced** — no unsigned output). Uses `pin_version` from `config.json` if set, otherwise picks the latest Morphe-supported version.
- `create-release` — one GitHub Release per app, tag `vYYYY.MM.DD`, contains only that app's APK.

## Developer commands

```bash
# Run JS unit tests (Jest)
npm test
npx jest .github/scripts/__tests__/apkmirror-scraper.test.js   # single file

# Validate JSON
jq '.' patches.json && jq '.' config.json

# Lint JS
npx eslint .github/scripts/*.js

# Lint shell
shellcheck .github/scripts/*.sh

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

## Local environment

`package.json` declares `engines.node >=24` to match the GitHub Actions runner (which uses `actions/setup-node` with `node-version: '24'`). Tests use Jest only. A flat-config ESLint setup exists at the repo root (`eslint.config.js`) and `npm run lint` runs it over `.github/scripts/`; the documented `npx eslint .github/scripts/*.js` command also works. No OpenCode config (`opencode.json`) is present in the repo.
