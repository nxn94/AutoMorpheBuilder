# Troubleshooting

This document mirrors and expands the "Common failures" section of `AGENTS.md`. Each entry follows the pattern:

- **Symptom** — what the log / user-visible failure looks like.
- **Cause** — what's actually happening.
- **Fix** — what to change.

If a failure you see is not listed here, capture a redacted workflow log and file an issue with the `bug-report.yml` template.

---

## `Chosen APK has no classes.dex`

**Symptom:** the build step fails after `morphe-desktop patch` with a log line indicating the chosen APK has no `classes.dex`.

**Cause:** the downloader picked a split/config APK instead of the monolithic APK. This typically happens when the target version only ships as a BUNDLE (XAPK/APKM/APKS) variant on APKMirror.

**Fix:**

1. Open the app's APKMirror release page manually (use the `apkmirror_path` from `config.json`) and confirm whether the release ships a BUNDLE-only variant.
2. If yes, the post-merge step (which re-runs the version check on the inner `base.apk` of XAPK/APKM/APKS bundles) should handle it. The downloader hardcodes the saved filename to `${packageId}_${version}.apk` regardless of URL path, so the file lands with `.apk` extension — `detectApkShape` is content-based (it inspects zip contents, not extension) and still recognises the bundle. If aapt validation still throws on the outer zip, file an issue with the workflow run URL.
3. If the release ships only a BUNDLE variant and the post-merge step cannot extract a valid `base.apk`, set `pin_version` to an earlier release that ships a monolithic APK:

   ```json
   "com.example.app": { "name": "example", "repo": "...", "branch": "main", "apkmirror_path": "...", "pin_version": "1.2.3" }
   ```

The downloader now uses content-based split-package detection (`detectApkShape` in `apk-selection.js`) so a `.xapk` / `.apkm` / `.apks` bundle saved with `.apk` filename is still recognised and merged.

---

## `Wrong version of key store` / `keystore password was incorrect`

**Symptom:** the `Patch and sign ${{ matrix.name }} with morphe-desktop` step fails with `Couldn't decrypt keystore — wrong password or alias` from morphe-desktop, with the underlying Java stack trace typically `java.io.IOException: keystore password was incorrect` at `sun.security.pkcs12.PKCS12KeyStore.engineLoad` (PKCS12) or `BadPaddingException` deep down.

**Cause:** wrong keystore password, **or** the key password differs from the keystore password and only the keystore password is set as a secret, **or** the keystore is in a format morphe-desktop does not accept.

`patch_apk.sh` always passes `--keystore-password` (store password), `--keystore-entry-password` (entry password — defaults to the store password when `KEY_PASSWORD` is unset), and `--keystore-entry-alias` (defaults to the keystore's first alias detected via `keytool -list` when `KEY_ALIAS` is unset). The previous version omitted those flags and trusted morphe-desktop's defaults; those defaults are hardcoded to `"Morphe"` in v1.14.0 (`PatchCommand.kt:215`/`221`), so any third-party keystore hit a hardcoded legacy alias/password that does not match. The flags are now passed unconditionally for that reason.

**Fix:**

- Confirm `KEYSTORE_PASSWORD` matches the password used when the keystore was generated.
- If the key password differs, set `KEY_PASSWORD` to the key-specific password (and leave `KEYSTORE_PASSWORD` for the keystore). `patch_apk.sh` falls back to `KEYSTORE_PASSWORD` for the entry when `KEY_PASSWORD` is unset — matches the old `keytool -srckeypass`-defaults-to-`-srcstorepass` behavior.
- If your keystore has multiple aliases and you want a non-first one, set `KEY_ALIAS` explicitly. `patch_apk.sh` detects the first alias via `keytool -list -keystore <file> -storepass:env KEYSTORE_PASSWORD` when `KEY_ALIAS` is unset.
- morphe-desktop's `patch --keystore` accepts PKCS12 / JKS / BKS and auto-detects the format from file contents (not extension). If your keystore is in another format, convert it locally before base64-encoding:

  ```bash
  base64 -d keystore.b64 > /tmp/test.keystore
  keytool -list -keystore /tmp/test.keystore -storepass "$KEYSTORE_PASSWORD"
  ```

  A wrong password surfaces immediately.

---

## `Could not resolve a Morphe-supported version`

**Symptom:** the `Resolve supported version` step fails with `::error::Could not resolve a Morphe-supported version for <pkg>`.

**Cause:** `morphe-desktop list-versions` returned no matching version. This typically means the patches `.mpp` for the resolved tag does not list the package id in `compatiblePackages`.

The most common upstream-format change that triggers this: `patches-list.json` moved from a key-indexed syntax (`.compatiblePackages[$pkg]`) to an array-of-objects syntax (`select(.packageName == $pkg)`). Both forms are handled by `prepare_target_version.sh` and the pre-download step.

**Fix:**

1. Run `node .github/scripts/preflight-apps.js` locally against the resolved tag. It dumps the `patches-list.json` `compatiblePackages` per repo and surfaces upstream rename or typo'd package id immediately.
2. Confirm the patch repo at `patch_repos[*].repo` actually publishes a `.mpp` artifact for your app.
3. Confirm the package id in `config.json` exactly matches the `applicationId` listed on APKMirror (including any `.beta` / `.canary` suffix).

The pre-download step also passes the per-app `.mpp` directly to `morphe-desktop list-versions` (no shared `patches.mpp` copy), so parallel apps cannot trample each other's read.

---

## `java.lang.NoSuchMethodError: ...BytecodePatchBuilder.extendWithAll(Supplier)` during `list-versions`

**Symptom:** the `Compat probe` step fails with a `NoSuchMethodError`, `NoClassDefFoundError`, `IncompatibleClassChangeError`, `VerifyError`, or `LinkageError` referencing a morphe-patcher class.

**Cause:** the patches `.mpp` was compiled against a newer morphe-patcher than the `morphe-desktop.jar` the CI is running. Patches built against newer patcher APIs (e.g. `hoo-dles/morphe-patches` uses `extendWithAll` since 2026-07-27) crash every patch's `<clinit>` on an older CLI.

The repo defends against this in three layers:

1. **No jar caching.** `download_morphe_tools.sh` and `fetch_morphe_tools.sh` both `rm -f` and re-download `morphe-desktop.jar` on every run, because `actions/cache@v5` only saves on a miss — a restore would otherwise silently put a stale jar back into `tools/`.
2. **Compat probe.** Runs `list-versions` per app right after the jar download and classifies stderr for these specific error classes. Emits an actionable `::error::` ("bump cli or pin each affected app to an older patch tag") instead of waiting 30 minutes for the matrix to surface the same crash.
3. **Implementation-Version check.** Both download scripts verify the jar's `Implementation-Version` from `META-INF/MANIFEST.MF` matches `CLI_VERSION` after download, so a partial download or wrong tag is caught at the source.

**Fix:**

- Bump `cli.repo` to a `morphe-desktop` release that carries the required patcher API (the compat probe error message names the minimum version).
- Or, for the affected apps, pin the patches tag to an older release that compiles against the current CLI:

  ```json
  "com.example.app": { "name": "example", "repo": "...", "branch": "main", "apkmirror_path": "...", "pin_patch_tag": "v1.18.3" }
  ```

---

## APK download fails / `No APK could be downloaded`

**Symptom:** the `Download supported APK` step fails with `No APK could be downloaded` or hangs on Cloudflare 403s from APKMirror.

**Cause:** Cloudflare rate-limiting on APKMirror, transient APKMirror-API outage, or an invalid `apkmirror_path` slug.

**Fix:**

1. Re-run the workflow. APKMirror rate-limits clear within minutes.
2. Verify `apkmirror_path` slugs in `config.json` `patch_repos` are still valid by visiting `https://www.apkmirror.com/apk/<apkmirror_path>/all-versions/` in a browser. Sofascore's slug changed from `soccer-scores-and-sports-livescore-sofascore` (deprecated) to `sofascore-live-sports-scores`; keep the current slug in `config.json`.
3. The `resolveApkmirrorReleaseSlugViaChromium` helper covers the `/all-versions/` 403 case — if it is not engaging, file an issue with the workflow run URL.
4. Set `APKMIRROR_API_USER` and `APKMIRROR_API_PASS` as repository secrets to skip the Playwright fallback entirely (faster, more reliable).

---

## `[pkg] could not determine version` in `Pre-download APKs (parallel)` log

**Symptom:** the pre-download step logs `[<pkg>] could not determine version` for one or more apps.

**Cause:** `morphe-desktop list-versions` returned no matching version for the per-app `.mpp`. The patch repo at `patch_repos[*].repo` does not publish a `.mpp` for that app.

**Fix:**

1. Open the upstream patch repo and check the latest release's artifacts. The `.mpp` artifact must exist and the patches must list your package id in `compatiblePackages`.
2. If the patches repo renamed the package (e.g. upstream `applicationId` changed), update `config.json` `patch_repos[*]` to the new package id.
3. The preflight step (`preflight-apps.js`) catches this earlier in `check-versions` and is the source of truth — the pre-download error is a fallback.

---

## Obtainium not finding updates

**Symptom:** an Obtainium entry that points at this repo's Releases does not see a new release.

**Cause:** the Release Tag Filter regex or APK filter regex does not match the actual tag / filename format.

**Fix:** set both filters per app. The release tag format is `<name>-v<base-version>-<patches-version>` (e.g. `youtube-v20.44.38-v1.24.0-dev.8`). The APK filename is `<name>-v<base-version>-<patches-version>.apk` — note the `-v` infix is required.

| App | Release Tag Filter | APK filter |
|-----|--------------------|------------|
| YouTube | `^youtube` | `^youtube-v.*\.apk$` |
| YouTube Music | `^ytmusic` | `^ytmusic-v.*\.apk$` |
| Reddit | `^reddit` | `^reddit-v.*\.apk$` |
| Sofascore | `^sofascore` | `^sofascore-v.*\.apk$` |
| Twitch | `^twitch` | `^twitch-v.*\.apk$` |
| NZB360 | `^nzb360` | `^nzb360-v.*\.apk$` |
| AIDA64 | `^aida64` | `^aida64-v.*\.apk$` |
| Mimo | `^mimo` | `^mimo-v.*\.apk$` |

A missing APK filter (or one that lacks the `-v` infix) causes Obtainium to skip every release.

---

## Untracked `.xapk` / `.apkm` from a failed source pre-empts the good one

**Symptom:** the merged APK is missing the preferred architecture even though the downloader reported success via a later source.

**Cause:** an earlier source produced a partial `.xapk` / `.apkm` / `.apks` bundle that failed ABI or version validation, but the file remained on disk. `findPackageCandidate` then picked the stale file by readdir order (not guaranteed alphabetical on `ext4`) over the working bundle from a later source.

**Fix:** the downloader's cleanup-on-failure contract (delete partial APK on validation throw) ensures the file is removed when apkeep / direct-URL curl / Playwright fallback fails ABI or version validation. The contract is pinned by `__tests__/unified-downloader-cleanup.test.js`. If a stale file still pre-empts a good one, open an issue with the `download-resolver-failure.yml` template and include the list of files in `tools/apks/` (filenames + sizes, not content) immediately after the failure.

---

## `VERSION MISMATCH: expected <ver>, got undefined` from `downloadWithUrl`

**Symptom:** the post-download version check fails with `expected <ver>, got undefined` even though the download itself succeeded.

**Cause:** `aapt dump badging` cannot parse a split-package URL (the downloader hardcodes the saved filename to `.apk` regardless of URL path), so the version check on the outer zip-of-zips fails.

**Fix:** the downloader now skips the aapt check on bundles (`detectApkShape(outputPath) === 'bundle'`) and lets the post-merge step verify the inner `base.apk`'s `versionName`. Sofascore's arm64-v8a variant from APKPure is a `.xapk` URL — this path lets the 57 MB arm64-v8a variant win over the 93 MB universal.

If you see this error after upgrading, your saved file may not be the bundle shape expected — file an issue with the `download-resolver-failure.yml` template.

---

## Workflow skipping apps that should be rebuilt

**Symptom:** the `Filter matrix by existing releases` step drops an app from the matrix even though a new APK version was published upstream.

**Cause:** `check_existing_releases.sh` is fail-open, so the only way it can skip an app that genuinely needs a rebuild is if `morphe-desktop list-versions` returns a *different* version than what `releaseExists` matches against (e.g. experimental versions filtered out by the CLI). The release tag is `<name>-v<apk-version>-<patches-version>` — the `apk-version` part comes from `list-versions`, not from a direct lookup.

**Fix:**

1. Manually delete the offending release tag:

   ```bash
   gh release delete <app>-v<apk>-<patches>
   ```

2. Re-run the workflow. The next scheduled run will rebuild it.

3. If the issue is a mismatch between `list-versions` and the actual APKMirror release page, set `pin_version` on that app to lock the build to the desired APK version.

---

## Reporting a new failure

If you hit a failure not listed here:

1. Strip secrets (`KEYSTORE_PASSWORD`, `KEY_PASSWORD`, `KEYSTORE_BASE64`, `KEY_ALIAS`) before pasting logs.
2. Capture the workflow run URL.
3. Use the `bug-report.yml` issue template and include the app package id, expected version, artifact format (monolithic / XAPK / APKM / APKS), and `preferred_arch`.

For downloader-specific failures, use the `download-resolver-failure.yml` template — it asks for the package name, target version, selected source, attempted sources, architecture, DPI, artifact format, stable error code, sanitized log, `pin_version` in use, and whether a `download_urls` cache was in use.
