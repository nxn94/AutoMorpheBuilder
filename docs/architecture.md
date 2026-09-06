# Architecture

AutoMorpheBuilder is a **GitHub Actions pipeline** that produces signed, patched Android APKs and publishes them as per-app GitHub Releases. There is no application code to run locally — the workflow files, shell pipeline, and Node.js helpers under `.github/scripts/` **are** the product.

## High-level flow

1. **`check-versions`** resolves the latest Morphe patches tags per app and the latest `morphe-desktop` CLI tag, then filters the build matrix by whether each app's expected release already exists.
2. **`build`** (matrix per app, gated by the `signing` GitHub environment) downloads the APK and runs `morphe-desktop patch --keystore`, which patches **and** signs the APK in one step. morphe-desktop auto-detects PKCS12 / JKS / BKS from file contents (not extension) and converts internally — no manual type detection, no BouncyCastle conversion step.
3. (Removed — see "Signing model" below for the dissolved trust boundary.)
4. **`create-release`** downloads the signed APKs, publishes one GitHub Release per app, and prunes the oldest beyond `KEEP_COUNT`.

The split between `build` and `sign` has been dissolved in favour of morphe-desktop's native `patch --keystore` (which requires the keystore at patch time). The build matrix and create-release are both gated by the `signing` GitHub environment so the keystore is only visible to those jobs. The keystore still lives in only one place on disk (`tools/source.keystore`) and never leaves the runner, but a code-execution bug during APK download / patch execution can now reach the keystore. The available mitigation is to pin the patch repo (`pin_patch_tag`) and the APK version (`pin_version`) to known-good values, restricting what the build job ever invokes against an untrusted APK.

(Historically a deliberate `build` ↔ `sign` trust boundary separated untrusted-input download/patch from keystore handling; that boundary is gone — the code-execution bug triggered during APK download or morhe-desktop patch execution (the largest untrusted-input surface) could not reach the signing keystore because that code ran in a different job with no signing secrets in its environment.)

```mermaid
flowchart TD
    A[schedule: daily 05:15 UTC<br/>or workflow_dispatch] --> B[check-versions job]

    B --> B1[Resolve latest tags<br/>check_versions.sh]
    B1 --> B2[Set up Java 21]
    B2 --> B3[Preflight per-app patch availability<br/>preflight-apps.js]
    B3 --> B4[Download morphe-desktop + per-repo .mpp<br/>download_morphe_tools.sh]
    B4 --> B5[Cache patches .mpp<br/>morphe-desktop.jar is intentionally NOT cached]
    B5 --> B6[Compat probe per app<br/>compat-probe.js runs list-versions, classifies stderr<br/>for NoSuchMethodError / NoClassDefFoundError / VerifyError]
    B6 --> B7[Filter matrix by existing releases<br/>check_existing_releases.sh]
    B7 --> B8{should-build?}
    B8 -->|false| Z1[build + create-release skipped<br/>no-op day]
    B8 -->|true| B9[Setup Node 24 + npm ci]
    B9 --> B10[Cache + install Playwright Chromium]
    B10 --> B11[Cache + install apkeep]
    B11 --> B12[Install aapt]
    B12 --> B13[Pre-download APKs in parallel<br>pre_download_apks.sh]
    B13 --> C[build job matrix per app<br/>environment: signing<br/>holds keystore secrets]

    C --> C1[Checkout + Java 21]
    C1 --> C2[Restore apkeep / Playwright<br/>from check-versions artifacts]
    C2 --> C3[Restore pre-downloaded APKs]
    C3 --> C4[Cache + fetch morphe tools<br/>fetch_morphe_tools.sh<br/>morphe-desktop.jar always re-downloaded]
    C4 --> C5[Resolve supported version<br/>prepare_target_version.sh]
    C5 --> C6[Download supported APK<br/>download-supported-apk.js<br/>multi-source fallback chain]
    C6 --> C7[Decode signing keystore<br/>printf '$KEYSTORE_BASE64' | base64 -d<br/>to $TOOLS_DIR/source.keystore]
    C7 --> C8[Patch and sign APK<br/>patch_apk.sh runs morphe-desktop patch --keystore]
    C8 --> C9[Upload signed APK as artifact<br/>per-app <name>-v<ver>-<patches>]

    C9 --> D[create-release job<br/>environment: signing]

    D --> D1[Download signed APKs from build<br/>pattern *-v* with merge-multiple]
    D1 --> D2[Publish per-app releases<br/>create_release.sh<br/>tag = name-v apk -v patches]
    D2 --> D3[Prune old releases per app<br/>prune_old_releases.sh<br/>keep KEEP_COUNT = 2 by default]

    style B5 stroke-dasharray: 4 4
    style B6 stroke-dasharray: 4 4
    style C4 stroke-dasharray: 4 4
    style C stroke:#c00,stroke-width:3px
```

## Jobs in detail

### `check-versions`

Runs first. Failures here short-circuit the rest of the workflow.

| Step | Script | Purpose |
|------|--------|---------|
| Resolve latest Morphe + CLI versions | `pipeline/check_versions.sh` | Emits the optimistic default (`should-build=true`, full matrix) — the downstream filter overrides it. |
| Set up Java 21 | `actions/setup-java@v5` | Required for `java -jar morphe-desktop.jar`. Default runner Java is older and fails to invoke the jar. |
| Preflight per-app patch availability | `scripts/preflight-apps.js` | Hits each patch repo's `patches-list.json` at the resolved tag and confirms the app's package id is in `compatiblePackages`. Fail-fast per-app table on upstream rename or typo'd package id. |
| Download morphe-desktop + patches `.mpp` | `pipeline/download_morphe_tools.sh` | Provides the jar + per-repo `.mpp` files the filter step needs. Runs **unconditionally** so the filter step runs before the expensive Playwright / apkeep / aapt installs. |
| Cache patches `.mpp` | `actions/cache@v5` | Caches only the per-repo `.mpp` files. **The CLI jar is intentionally NOT cached** — see "Notes" below. |
| Compat probe | `scripts/compat-probe.js` | Actually invokes `morphe-desktop list-versions` per app to catch runtime API mismatches the static preflight can't see (e.g. hoo-dles/morphe-patches using `BytecodePatchBuilder.extendWithAll(Supplier)` added to morphe-patcher 2026-07-27, which only morphe-desktop v1.13.2+ carries). |
| Filter matrix by existing releases | `pipeline/check_existing_releases.sh` | For each app, resolves the APK version (pinned or via `morphe-desktop list-versions`) and drops entries whose `<name>-v<apk>-<patches>` release already exists. **Fail-open**: if version resolution or `gh release view` errors, the app is kept in the matrix. `FORCE_BUILD=1` on `workflow_dispatch` skips the check. |
| Setup Node 24 + `npm ci` | `actions/setup-node@v6` + `npm ci` | Gated on `should-build == 'true'`. |
| Cache + install Playwright | `actions/cache@v5` + `pipeline/install_playwright.sh` | The custom installer bypasses a yauzl extraction bug in Playwright 1.58. |
| Install apkeep + aapt | `pipeline/install_apkeep.sh` + `pipeline/install_aapt.sh` | apkeep is pinned to SHA-256 against `APKEEP_VERSION`. |
| Pre-download APKs in parallel | `pipeline/pre_download_apks.sh` | Per-app `&` + `wait`. Honours `SKIP_LIST` from the filter step. Calls `update-download-urls.js` per app (writes back only when `auto_update_urls=true` and no `pin_version` is set). |

**Notes:**

- The CLI jar is **never** cached. `download_morphe_tools.sh` always `rm -f` and re-downloads it, because `actions/cache@v5` only saves on a cache miss — a restore would silently put a stale jar back into `tools/`. Both download scripts verify the jar's `Implementation-Version` from `META-INF/MANIFEST.MF` matches `CLI_VERSION` after download.
- The compat probe classifies stderr for `NoSuchMethodError`, `NoClassDefFoundError`, `IncompatibleClassChangeError`, `VerifyError`, `LinkageError` and emits an actionable `::error::` ("bump cli or pin each affected app to an older patch tag") instead of waiting 30 minutes for the matrix to surface the same crash.

### `build`

Per-app matrix. Already filtered to apps that need rebuilding by `check-versions`. `fail-fast: false` so a single app failure does not cancel the others.

Gated by the `signing` GitHub environment so `KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` are visible to this job (morphe-desktop's `patch --keystore` requires the keystore at patch time — there is no `--unsigned` fallback). Untrusted inputs (APKMirror HTML/JSON, third-party patch tools) are processed here, and the keystore is decoded straight from `KEYSTORE_BASE64` to `$TOOLS_DIR/source.keystore` — no manual type detection or BouncyCastle conversion needed.

| Step | Purpose |
|------|---------|
| Checkout + Java 21 | Standard runner setup. |
| Restore apkeep / Playwright / pre-downloaded APKs | `actions/download-artifact@v8` from `check-versions` artifacts. |
| Cache + fetch morphe tools | `fetch_morphe_tools.sh` re-downloads `morphe-desktop.jar` fresh, then per-app `.mpp` and `APKEditor.jar`. The `.mpp` is restored from cache with **exact-key match only** — no `restore-keys` fallback. A `restore-keys: morphe-patches-<slug>-` would silently restore an `.mpp` from an older patch tag when the matrix moves forward (e.g. Twitch `v1.3.1` → `v1.3.2`), which `morphe-desktop list-versions` would then read to produce a stale APK version; the build would silently re-create an already-released APK and `create_release.sh` would skip the upload. Forcing an exact-key match forces `fetch_morphe_tools.sh` to re-download the `.mpp` from `gh release download` whenever the patch tag moves. |
| Resolve supported version | `prepare_target_version.sh` + inline `list-versions` invocation. Pinned apps skip the CLI call. The `sort -Vr` head-pick handles `list-versions` not guaranteeing "latest first" (Twitch's RookieEnough/De-Vanced prints `16.9.1` before `25.3.0`). |
| Cache APK | `actions/cache@v5` keyed on `apk-<name>-<version>`. |
| Install aapt | For post-download version validation. |
| Download supported APK | `download-supported-apk.js`. Multi-source fallback: `tools/*.apk` → URL cache (`~/.cache/auto-morphe-builder/urls/`) → `config.json download_urls` → parallel resolution via apkeep (APKPure), APKMirror-API (if creds), APKMirror scraper (curl → Chromium fallback). **Cleanup on failure** removes partial APK on ABI / version validation throw so a stale file does not pre-empt the good one. |
| Decode signing keystore | `printf '%s' "$KEYSTORE_BASE64" \| base64 -d > "$TOOLS_DIR/source.keystore"` — no conversion. morphe-desktop auto-detects PKCS12 / JKS / BKS from file contents. Hard-fails if `KEYSTORE_BASE64` or `KEYSTORE_PASSWORD` is unset. |
| Patch and sign APK | `patch_apk.sh` runs `morphe-desktop.jar patch --keystore <file> --keystore-password <KEYSTORE_PASSWORD> --keystore-entry-alias <KEY_ALIAS or detected first alias> --keystore-entry-password <KEY_PASSWORD or KEYSTORE_PASSWORD>`. If the keystore is invalid or the password is wrong, morphe-desktop exits non-zero and the job fails loudly (no `--unsigned` fallback). |
| Upload signed APK | `${{ matrix.name }}-v${{ version }}-${{ patches-tag }}` artifact. |

### `create-release`

Runs after `build` succeeds (`needs: [check-versions, build]`). Also gated by the `signing` GitHub environment.

| Step | Purpose |
|------|---------|
| Download signed APKs from build job | `actions/download-artifact@v8` with `pattern: '*-v*'` + `merge-multiple: true` — pulls every `<name>-v<ver>-<patches>` artifact the `build` matrix uploaded. |
| Publish per-app releases | `create_release.sh` creates one GitHub Release per app, tag `<name>-v<base-version>-<patches-version>`, contains only that app's APK. |
| Prune old releases | `prune_old_releases.sh` caps each app's release history at `KEEP_COUNT` (default `2`) by `gh release delete --cleanup-tag` on the oldest beyond the window. Failures on a single tag (race / already gone) are warnings only. |

## Source layout

```
.github/
├── workflows/             YAML entrypoints (morphe-build, ci, codeql, update-patches)
├── scripts/
│   ├── *.js               Top-level Node.js helpers (downloaders, validators, install scripts)
│   ├── __tests__/         Jest tests for the helpers above
│   └── pipeline/
│       ├── *.sh           One shell script per workflow step
│       └── lib/           Sourced helpers shared across *.sh
├── ISSUE_TEMPLATE/        Issue templates + config.yml
├── pull_request_template.md
└── CODEOWNERS             Required reviewers per path

config.json                Build config (this repo's "settings")
patches.json               Patch toggles (repo-keyed: { "owner/repo": { "pkg": { "Patch": true } } })
patches-list.json          Per-repo, per-tag cache of compatiblePackages from the patches .mpp (managed)
LICENSE                    GPL-3.0
SECURITY.md                Vulnerability disclosure policy
CONTRIBUTING.md            How to file issues, send PRs, validate locally
docs/                      This documentation
```

## Signing model

Signing is enforced end-to-end. The previous `build` ↔ `sign` job split (which used BouncyCastle + `prepare_keystore.sh` + `sign_apk.sh`/`apksigner`) was replaced when morphe-desktop's `patch` subcommand gained native `--keystore` / `--keystore-password` / `--keystore-entry-alias` / `--keystore-entry-password` flags. morphe-desktop now accepts PKCS12 / JKS / BKS and auto-detects the format from file contents (not extension), converting to BKS internally without touching the original file. There is no separate sign job.

1. **Decode.** `KEYSTORE_BASE64` → `tools/source.keystore`. Runs as the first step of the `build` job; the file is written under `$TOOLS_DIR` and never leaves the runner.
2. **Patch + sign.** `morphe-desktop.jar patch --keystore "$KEYSTORE_FILE" --keystore-password "$KEYSTORE_PASSWORD" --keystore-entry-alias "$KEY_ALIAS_RESOLVED" --keystore-entry-password "$KEY_ENTRY_PASSWORD"`. morphe-desktop signs the patched APK in place. There is no `--unsigned` fallback — if the keystore is invalid or the password is wrong, morphe-desktop exits non-zero and the job fails loudly.
3. **Alias + entry-password resolution.** When `KEY_ALIAS` is unset, `patch_apk.sh` resolves the first alias via `keytool -list` and passes it as `--keystore-entry-alias` (morphe-desktop v1.14.0 hardcodes the default to `"Morphe"` — a legacy bundled-keystore alias — and does NOT auto-pick the first alias). When `KEY_PASSWORD` is unset, `patch_apk.sh` defaults `--keystore-entry-password` to `KEYSTORE_PASSWORD` (morphe-desktop v1.14.0 hardcodes `"Morphe"` here too — works only for the bundled keystore). Identical-password single-keystore users therefore stay on one secret; multi-alias or split-password keystores use the explicit overrides.
4. **Hard-fail.** Missing `KEYSTORE_BASE64` or `KEYSTORE_PASSWORD` aborts the workflow before any download cost. Patch failures during signing abort the matrix entry.

**Trust boundary.** The `signing` GitHub environment (Settings → Environments → `signing` in the repo UI) restricts the four secrets to the `build` and `create-release` jobs. Those are also the only jobs that touch the untrusted-input surface (APKMirror HTML/JSON, third-party patch tools), so a code-execution bug during APK download / patch execution **can reach the keystore**. Mitigate by pinning the patch repo (`pin_patch_tag`) and the APK version (`pin_version`) so the build job only ever invokes against known-good patches / APKs.

Required secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`. Optional: `KEY_ALIAS` (auto-detected as the keystore's first alias via `keytool -list` when unset — morphe-desktop's own default `"Morphe"` is hardcoded and not first-alias), `KEY_PASSWORD` (defaults to `KEYSTORE_PASSWORD` when unset — same morphe-desktop default caveat).

## Failure model

The workflow is **fail-open** on version resolution (per app) and **fail-closed** on signing and on patch availability. See `docs/troubleshooting.md` for the catalogue of common failure modes and their remediation.
