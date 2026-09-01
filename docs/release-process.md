# Release process

This document describes how AutoMorpheBuilder produces, tags, publishes, and prunes its per-app Android APK releases.

## Overview

The `morphe-build.yml` workflow runs on a daily cron (`15 5 * * *` UTC) and on `workflow_dispatch`. The full pipeline is:

1. **`check-versions`** resolves the latest Morphe patches tags per app and the latest `morphe-desktop` CLI tag, then filters the build matrix by whether each app's expected release already exists.
2. **`build`** (matrix per app, already filtered) downloads the APK, applies patches, signs the result, uploads the patched APK as an artifact.
3. **`create-release`** downloads all patched APKs, publishes one GitHub Release per app, then prunes the oldest beyond `KEEP_COUNT`.

See `docs/architecture.md` for the job graph.

## Release tag format

```
<name>-v<base-version>-<patches-version>
```

Where:

- `<name>` is the `config.json` `patch_repos[*].name` field — short identifier (`youtube`, `ytmusic`, `reddit`, `sofascore`, `twitch`, `nzb360`, `aida64`, `mimo`).
- `<base-version>` is the resolved APK `versionName` from `morphe-desktop list-versions` (or `pin_version` when set).
- `<patches-version>` is the latest release tag of the patch repo at `patch_repos[*].repo` (or `pin_patch_tag` when set).

Example: `youtube-v20.44.38-v1.24.0-dev.8`.

The artifact filename follows the same shape with `.apk` appended:

```
<name>-v<base-version>-<patches-version>.apk
```

Example: `youtube-v20.44.38-v1.24.0-dev.8.apk`.

The `-v` infix in the APK filename is **required** — Obtainium filters use `^youtube-v.*\.apk$`. Do not strip it.

## Per-app release isolation

Each app gets its own GitHub Release (and its own tag). The release contains **only** that app's patched APK. The `create_release.sh` step iterates over the downloaded artifacts and creates one release per `*-v*-v*` filename pattern; there is no "umbrella" release.

## Pruning (`KEEP_COUNT`)

After publishing, `prune_old_releases.sh` caps each app's release history at `KEEP_COUNT` (default `2`). Older releases + their tags are deleted via `gh release delete --cleanup-tag`. The freshly-created/-updated release is always the newest of its app's set, so it survives the prune.

Override the count per workflow run by setting the `KEEP_COUNT` environment variable in the workflow file (default `2`). Failures on a single tag (race / already gone) are warnings only — the list call is the hard gate so the cleanup never silently skips.

**Recommended value:** `2` (the default). Going higher trades GitHub storage for slower Obtainium checks. Going to `1` means Obtainium sees only the latest release with no rollback option.

## Pinned-version behavior

When `config.json` `patch_repos[*].pin_version` is set:

- `prepare_target_version.sh` exports `PINNED_VERSION=<value>` and `pinned=1`.
- The `Resolve supported version` step uses the pinned value instead of calling `morphe-desktop list-versions`.
- `update-download-urls.js` **skips** URL write-backs for that app (the cached URL would never be used — the pin short-circuits version resolution).
- The release tag format is unchanged — `<name>-v<pinned-version>-<patches-version>`.

When `pin_patch_tag` is set (used by `nzb360` and `aida64`):

- The patch repo's release list is filtered to that exact tag instead of "latest".
- The CLI / APK download / patch flow is otherwise unchanged.

A pinned version does **not** prevent pruning — a release tagged with a pinned version is still subject to `KEEP_COUNT`.

## Prerelease handling

Morphe patches repos ship prerelease tags like `v1.24.0-dev.8`. GitHub Releases auto-detect a tag matching the SemVer prerelease convention (`-` followed by a dot-separated identifier) and mark the release as a prerelease automatically.

If your Obtainium entry does not show prereleases, check the "Include prereleases" toggle in the Obtainium app config. Pruning treats prereleases the same as stable releases (oldest-first within the app's release set).

## Force-build

On `workflow_dispatch`, the `check_existing_releases.sh` step sets `FORCE_BUILD=1`, which bypasses the "release already exists" check. This is the right way to manually rebuild an app without first deleting the existing release tag.

A scheduled run never sets `FORCE_BUILD` — it always honours the filter.

## Rolling back

To roll back an app to a previous APK + patches combination:

1. Pin the app to the previous `patches-version` via `pin_patch_tag` (if you want to hold the patches).
2. Or pin the app to the previous APK version via `pin_version`.
3. Push `config.json`. The next workflow run produces a release with the pinned tag.

If you want to remove a published release immediately (because it is broken):

```bash
gh release delete <app>-v<apk>-<patches> --cleanup-tag
```

The next workflow run will rebuild and republish it (or skip it, if you have not changed anything and the prior build is still current).

## Manual workflow run

`Actions → Build Morphe-patched apps → Run workflow` starts a full pipeline run. There are no inputs — the run uses the current `config.json` and `patches.json` on `dev`.

To trigger only the patch-toggles refresh (no APK build), use `Actions → Update patches.json from upstream repos → Run workflow`.

## Artifact retention

Patched-APK build artifacts (`${{ matrix.name }}-v${{ version }}-${{ patches-tag }}`) use GitHub Actions' default 90-day retention. Releases themselves are persisted indefinitely until pruned by `prune_old_releases.sh`.
