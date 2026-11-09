# Release process

This document describes how AutoMorpheBuilder produces, tags, publishes, and prunes its per-app Android APK releases.

## Overview

The `morphe-build.yml` workflow runs on a daily cron (`15 5 * * *` UTC) and on `workflow_dispatch`. The full pipeline is:

1. **`check-versions`** resolves per-app patch tags and the CLI tag, then filters scheduled runs using complete assets and matching build-input provenance. Manual runs force rebuilding.
2. **`build`** (matrix per app, no signing secrets) downloads the APK and runs `morphe-desktop patch --unsigned`. `create-release` then signs each APK with `apksigner` before publishing.
3. **`create-release`** (the only job gated by the `signing` environment) downloads unsigned APK artifacts via `pattern: '*-v*'` + `merge-multiple: true`, aligns when needed, signs and verifies every APK, publishes one GitHub Release per app, then prunes the oldest beyond `KEEP_COUNT`.

Signing runs in `create-release`, not in the build matrix: third-party patch code never runs in the job that holds the keystore. Any signing failure stops the job before publication. Use PKCS12 or JKS; convert an existing BKS keystore locally while preserving its private key and certificate rather than generating a new signing identity.

See `docs/architecture.md` for the job graph and the signing model.

## Release tag format

```
<name>-v<base-version>-<patches-version>
```

Where:

- `<name>` is the `config.json` `patch_repos[*].name` field — short identifier (`youtube`, `ytmusic`, `reddit`, `sofascore`, `twitch`, `nzb360`, `flightradar24`).
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

Each app gets its own GitHub Release and tag, containing that app's patched APK, `SHA256SUMS` and `build-inputs.json`. `create_release.sh` iterates over the downloaded artifacts; there is no combined multi-app release. Failed apps are not published as successful builds, while successful matrix entries can still publish.

## Pruning (`KEEP_COUNT`)

After publishing, `prune_old_releases.sh` caps each app's release history at `KEEP_COUNT` (default `2`). Older releases + their tags are deleted via `gh release delete --cleanup-tag`. The freshly-created/-updated release is always the newest of its app's set, so it survives the prune.

Override the count per workflow run by setting the `KEEP_COUNT` environment variable in the workflow file (default `2`). Failures on a single tag (race / already gone) are warnings only — the list call is the hard gate so the cleanup never silently skips.

**Recommended value:** `2` (the default). Going higher trades GitHub storage for slower Obtainium checks. Going to `1` means Obtainium sees only the latest release with no rollback option.

## Pinned-version behavior

When `config.json` `patch_repos[*].pin_version` is set:

- `prepare_target_version.sh` emits `pinned=<value>`, passed as `PINNED_VERSION` to version resolution.
- The `Resolve supported version` step uses the pinned value instead of calling `morphe-desktop list-versions`.
- `update-download-urls.js` **skips** URL write-backs for that app (the cached URL would never be used — the pin short-circuits version resolution).
- The release tag format is unchanged — `<name>-v<pinned-version>-<patches-version>`.

When `pin_patch_tag` is set:

- The patch repo's release list is filtered to that exact tag instead of "latest".
- The CLI / APK download / patch flow is otherwise unchanged.

A pinned version does **not** prevent pruning — a release tagged with a pinned version is still subject to `KEEP_COUNT`.

## Prerelease handling

Upstream patches may use prerelease tags such as `v1.24.0-dev.8`. The publisher calls `gh release create` without `--prerelease`; a `-dev` suffix in the per-app tag does not automatically set GitHub's prerelease flag. Inspect the release's actual flag rather than inferring it from the tag.

If a release is marked as a prerelease, enable "Include prereleases" in Obtainium as needed. Pruning treats prereleases the same as stable releases (oldest-first within the app's release set).

## Build identity and forced rebuilds

Scheduled builds skip an app only when the expected tag contains its APK,
`SHA256SUMS`, and `build-inputs.json`, and the release notes contain a matching
build-input fingerprint. The fingerprint includes the app configuration, patch
Boolean selections, preferred architecture, CLI configuration/version, lockfile,
tool pins, and pipeline source. Changing these inputs rebuilds an existing tag.
Older releases without provenance are rebuilt once.

`workflow_dispatch` sets `FORCE_BUILD=true` and bypasses this comparison unless its `force` box is unticked. Its `apps` box limits the run to the named apps, which build even if current.
Publication replaces the APK, checksum manifest, and provenance with `--clobber`.
It removes the completion marker before replacement and restores it only after
all uploads succeed. A partial publication is retried by the next scheduled run.
GitHub asset replacement is not transactional; a consumer downloading during
replacement should retry if its checksum does not match.

Pins are exact: a failed `pin_version` download never silently selects a different
APK version. Change or remove the pin explicitly to select another version.

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

`Actions → Build Morphe-patched apps → Run workflow` starts a full pipeline run. There are no inputs — the run uses `config.json` and `patches.json` from the selected ref (normally `main`).

To trigger only the patch-toggles refresh (no APK build), use `Actions → Update patches.json from upstream repos → Run workflow`.

## Artifact retention

Unsigned patched-APK build artifacts (`${{ matrix.name }}-v${{ version }}-${{ patches-tag }}`) have explicit three-day retention. Releases contain signed APKs and persist until pruned by `prune_old_releases.sh`.
