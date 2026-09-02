# AGENTS.md — AutoMorpheBuilder

AutoMorpheBuilder is a GitHub Actions pipeline that builds signed, patched Android APKs with [Morphe](https://github.com/MorpheApp/morphe-patches) patches. **The workflow is the product** — there is no app to run locally. This file is a guide for AI agents and human contributors working in the repo.

## Sources of Truth

Every authoritative file in the repo, with its role. When information conflicts, the file listed below wins; this document only summarises them.

- `config.json` — application definitions and patch repositories.
- `patches.json` — per-application patch selection (repo-keyed format, see `docs/configuration.md`).
- `.github/workflows/morphe-build.yml` — main build orchestration (daily + `workflow_dispatch`).
- `.github/workflows/update-patches.yml` — patch metadata updates from upstream patch repos.
- `.github/workflows/ci.yml` — continuous integration (PR + main gate).
- `.github/workflows/codeql.yml` — security analysis.
- `README.md` — project overview.
- `SETUP.md` — fork and signing setup walkthrough.
- `CONTRIBUTING.md`, `SECURITY.md` — community files (contribution guide, vulnerability disclosure).
- `docs/configuration.md` — `config.json` field reference and "adding a new app" procedure.
- `docs/architecture.md` — pipeline architecture, job graph, Mermaid diagram.
- `docs/troubleshooting.md` — common failures, symptoms, causes, fixes.
- `docs/release-process.md` — release tagging, naming, and pruning.
- `.github/ISSUE_TEMPLATE/` — bug report, app request, download-resolver-failure templates + `config.yml`.
- `.github/pull_request_template.md` — PR description template.
- `.github/CODEOWNERS` — required reviewers per path.

## Generated and Managed Files

The repo mixes hand-curated and workflow-generated content. Treat the categories below as a contract — do not move a file across categories without a PR that explains why.

**User-managed** (edit freely; preserved across workflow runs):

- `config.json` — the source of truth for `patch_repos`, `cli`, `preferred_arch`, `auto_update_urls`.
- `patches.json` — the Boolean values you set per patch. New upstream patches default to `true` on first sync; your existing toggles are preserved.
- `docs/`, `README.md`, `SETUP.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md` — human-authored documentation.
- Tests and fixtures under `.github/scripts/__tests__/`.

**Workflow-managed** (do not hand-edit; the workflow rewrites them):

- `patches.json` keys for newly discovered upstream patches (added by `update-patches.yml`; your existing values are preserved on every sync).
- `config.json` `download_urls` cache — written by `pre_download_apks.sh` when `auto_update_urls` is `true`. Clear `~/.cache/auto-morphe-builder/urls/` to force re-resolution.
- Build artifacts under `apps/`, `tools/`, `out/` — gitignored, produced by the workflow.
- `tree -a -I '.git|node_modules|coverage|dist|build|tools|apps' -L 3` shows the full tree.

**Rule:** when updating `patches.json`, preserve existing user-selected Boolean values; new upstream patches default to `true`.

## Repository Layout (conceptual)

- **Workflows**: `.github/workflows/morphe-build.yml`, `update-patches.yml`, `ci.yml`, `codeql.yml` — orchestration only.
- **Scripts (Node.js)**: `.github/scripts/*.js` — downloaders, validators, release helpers, installer scripts.
- **Scripts (shell pipeline)**: `.github/scripts/pipeline/*.sh` plus shared helpers in `.github/scripts/pipeline/lib/`. Each `<step>.sh` corresponds to one workflow step.
- **Scripts (CLI orchestrators)**: `scripts/*.js` — thin entry points that wire `node_modules` (ajv etc.) into the pure logic in `.github/scripts/`. `scripts/generate-readme-tables.js` regenerates the "Tested apps" / "Releases & Obtainium" tables in `README.md` from `config.json` `patch_repos`.
- **Tests**: `.github/scripts/__tests__/*.test.js` — Jest unit tests for pure helpers and CLI wrappers.
- **Config**: `config.json`, `patches.json`, `eslint.config.js` (lints `.github/scripts/**/*.js` only).
- **Docs**: `docs/{configuration,architecture,troubleshooting,release-process}.md` plus `README.md`, `SETUP.md`, `AGENTS.md`.
- **Community**: `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`, `.github/CODEOWNERS`.

## Change Rules

1. Keep workflow YAML focused on orchestration; move logic into `.github/scripts/*.js` or `.github/scripts/pipeline/*.sh`.
2. Put reusable logic in JavaScript or shell modules — never inline duplicated shell in workflow YAML.
3. Add or update tests for every behavioural change. Behavioural logic must live behind a pure, exported function so Jest can exercise it without shelling out.
4. Add fixtures (sample `patches-list.json`, APKMirror HTML, protobuf payloads) when handling a new upstream response format.
5. Do not log secrets, passwords, keystore contents, or `Authorization:` headers. Use `set +x` / `::add-mask::` / `keytool -storepass:env` as appropriate.
6. Do not weaken APK, package-name, version, checksum, or signature validation. Adding a "skip the version check" or "trust any cert" path is a hard fail.
7. Preserve backward compatibility for existing `config.json` files unless a breaking change is explicitly documented in the PR description and `docs/configuration.md`.
8. Update related documentation in the same PR. Adding a workflow step, env var, or config field without updating `docs/` and `AGENTS.md` is incomplete.
9. Run all required validation commands before committing (see [Next](#required-validation)).

## Required Validation

Run these before every commit. `npm run check` runs the full chain (lint + test + validate:config + validate:agent-docs + check:readme).

```bash
npm ci
npm run lint
npm test
npm run validate:config
npm run check:readme        # regenerates README tables in-memory and diffs; --check-style
```

`npm run generate:readme` (no flag) writes the regenerated tables back to `README.md` — run this after any change to `config.json` `patch_repos` so the "Tested apps" / "Releases & Obtainium" tables stay in sync. `update-patches.yml` does this automatically on push to main, alongside the existing patches.json sync.

Shell scripts use `shellcheck .github/scripts/pipeline/*.sh .github/scripts/pipeline/lib/*.sh`; workflow YAML uses `actionlint .github/workflows/*.yml`. CI runs `node .github/scripts/validate-config.js` directly (it is not on `npm run` yet); the JSON config validator catches typos and missing required keys before merge.

## Repo quirks (not obvious from filenames)

- `morphe-desktop.jar` is **never** cached. `actions/cache@v5` only saves on miss, so caching the jar would silently put a stale jar back into `tools/`. `download_morphe_tools.sh` and `fetch_morphe_tools.sh` both `rm -f` and re-download on every run. See `docs/troubleshooting.md` → "java.lang.NoSuchMethodError" for the failure mode this prevents.
- `morphe-desktop.jar` verification is via `META-INF/MANIFEST.MF` `Implementation-Version`, not SHA-256. PR 6 upgrades to SHA-256.
- `apkeep` installer verifies SHA-256; `aapt` and `playwright` installers do not (PR 6). The previous `install_bouncycastle.sh` (BouncyCastle for keystore conversion) was deleted when morphe-desktop's `patch --keystore` flags made the conversion redundant.
- Signing has **no** `--unsigned` fallback. morphe-desktop's `patch` always signs when `--keystore` is passed; a bad password or invalid keystore aborts the workflow loudly rather than producing an unsigned APK. The previous `build` ↔ `sign` trust boundary was dissolved (see `docs/architecture.md` → "Signing model" for the implications).
- morphe-desktop v1.14.0 hardcodes `--keystore-entry-password` and `--keystore-entry-alias` defaults to `"Morphe"` (legacy bundled-keystore alias, see `MorpheApp/morphe-desktop` `PatchCommand.kt:215`/`221` + `PatchEngine.kt:64`/`65`). They do NOT inherit from `--keystore-password` and do NOT auto-pick the keystore's first alias — omitting either flag silently tries the literal password `"Morphe"` and fails with `BadPaddingException`. `patch_apk.sh` always passes both explicitly (alias detected via `keytool -list` when `KEY_ALIAS` is unset; entry password defaults to `KEYSTORE_PASSWORD` when `KEY_PASSWORD` is unset). If morphe-desktop later inherits from `--keystore-password` or auto-picks the first alias, the script can be simplified.
- The downloader saves XAPK/APKM/APKS bundles with a `.apk` extension. `detectApkShape` in `apk-selection.js` inspects zip contents to recognise bundles — required because APKMirror often serves bundles without preserving the extension.
- The `aapt` version check is skipped for split packages (the outer zip-of-zips is not a valid APK); the post-merge step verifies the inner `base.apk`.
- `pre_download_apks.sh` runs apps in parallel via `&` + `wait`. Each app's `.mpp` is passed directly to `morphe-desktop list-versions` (no shared-file race).
- `check_existing_releases.sh` is **fail-open**: if `morphe-desktop list-versions` returns nothing or `gh release view` errors, the app is kept in the matrix with a `::warning::`. The build never silently skips an app we couldn't version-check.
- The `compat-probe` step (in the `check-versions` job) runs `list-versions` per app and surfaces `NoSuchMethodError` / `NoClassDefFoundError` at the cheapest step rather than 30 minutes into the matrix.

## Local environment

Node.js 24 (matches `actions/setup-node@v6`; `package.json` declares `"engines": { "node": ">=24" }`). Java 21 (matches `actions/setup-java@v6`; required by `morphe-desktop` ≥ 1.12.0). The CI workflow installs `zip` via `apt-get` because the apk-selection / apk-abi-validator test fixtures shell out to `zip` to build fake APKs; without it several tests skip with "no zip" warnings instead of actually exercising the path-stripping bug fix. Tests use Jest only; ESLint is scoped to `.github/scripts/**/*.js` via `eslint.config.js`. Shell pipeline linting (`shellcheck`) is not part of `npm run lint`.