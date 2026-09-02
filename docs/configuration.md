# `config.json` reference

Every field in `config.json`, with type, required-ness, default, example, and validation rules. The current default file is shown at the bottom of this document.

## Top-level shape

```jsonc
{
  "preferred_arch":  "arm64-v8a",
  "auto_update_urls": true,
  "patch_repos":     { /* per-app entries, key = package id */ },
  "cli":             { "repo": "MorpheApp/morphe-desktop", "branch": "main" },
  "download_urls":   { /* auto-managed, do not hand-edit */ }
}
```

## `preferred_arch`

| | |
|---|---|
| Type | `string` |
| Required | no |
| Default | `"arm64-v8a"` |
| Example | `"arm64-v8a"` |
| Allowed values | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64`, `universal` |

Selects the preferred native architecture when APKMirror / APKPure lists multiple ABIs in the same release. The downloader (`unified-downloader.js`) reads this to:

- Pick the smaller arm64-v8a variant when both arm64-v8a and universal are present (Sofascore's 57 MB arm64-v8a XAPK wins over the 93 MB universal).
- Reject a downloaded bundle whose only `lib/` ABI does not match this preference (post-merge validation in `download-supported-apk.js`).

Validation: any string is accepted at config-load time; mismatch is caught at the per-app ABI validator, not here.

## `auto_update_urls`

| | |
|---|---|
| Type | `boolean` |
| Required | no |
| Default | `true` |
| Example | `false` |

When `true`, `pre_download_apks.sh` writes resolved APK URLs back to `download_urls` after a successful pre-download (via `node update-download-urls.js <pkg> <version> <url>`). The next build reads `download_urls` before falling through to `apkeep` / `APKMirror-API` / Playwright resolution, so a resolved URL short-circuits the chain.

When `false`, the resolved URL is logged but `config.json` is left untouched. Useful if you want to pin downloads to specific URLs, or want to avoid noisy diffs on every run.

`true` / `false` / `1` / `0` / `yes` / `no` are accepted; anything else is treated as `false`. See `pipeline/lib/config.sh` `auto_update_urls_enabled` for the source of truth.

Apps with `pin_version` set **also** skip URL updates — the cached URL would never be used (the pin short-circuits version resolution) and updating it is wasted work.

## `patch_repos`

| | |
|---|---|
| Type | object (`{ [packageId: string]: AppConfig }`) |
| Required | yes |
| Min entries | 1 (the build hard-fails on empty) |

The dynamic build matrix. Each key is an Android package id (`applicationId`), each value is an `AppConfig` (below). The order is preserved in the matrix for stable log output.

**Validation:** the `check-versions` job fails immediately if `patch_repos` is empty, and emits a per-app table of failures if a key is malformed (missing `name` / `repo` / `branch` / `apkmirror_path`).

### `AppConfig`

```jsonc
"com.example.app": {
  "name":           "example",                 // required, used for release tag + artifact filename
  "repo":           "owner/morphe-patches",    // required, the upstream patches repo
  "branch":         "main",                    // required, the patches repo branch to track tags from
  "apkmirror_path": "vendor/example",          // required, APKMirror URL slug
  "pin_version":    "1.2.3",                   // optional, lock to this APK version
  "pin_patch_tag":  "v1.0.0",                  // optional, lock the patches release tag
  "display_name":   "Example"                  // optional, human-readable name for README/Obtainium
}
```

#### `name`

| | |
|---|---|
| Type | `string` |
| Required | yes |
| Example | `"youtube"` |

Short identifier used in:

- Release tag: `<name>-v<base-version>-<patches-version>` (e.g. `youtube-v20.44.38-v1.24.0-dev.8`).
- Artifact filename: `<name>-v<base-version>-<patches-version>.apk`.
- Obtainium Release Tag Filter: `^<name>`.
- APK cache key: `apk-<name>-<version>`.

Must be unique across `patch_repos`. Lower-case ASCII letters, digits, dashes only is the convention but not enforced.

#### `repo`

| | |
|---|---|
| Type | `string` (`owner/repo`) |
| Required | yes |
| Example | `"MorpheApp/morphe-patches"` |

GitHub `owner/repo` slug pointing at a Morphe-compatible patches repository. The workflow:

1. Lists the latest release tag of this repo (used as the `patches-version`).
2. Downloads the `patches-<tag>.mpp` artifact attached to that release.
3. Calls `morphe-desktop.jar patch -b <mpp>` with this `.mpp` to patch the APK.

The repo **must** publish `.mpp` artifacts. If it does not, the per-app `Preflight per-app patch availability` step fails the workflow before the build matrix spins up.

#### `branch`

| | |
|---|---|
| Type | `string` |
| Required | yes |
| Default | `"main"` |

The patches repo branch used to resolve the latest release tag. Almost always `"main"`. Set to a non-`main` branch only if the patches repo deliberately tags releases from a non-default branch.

#### `apkmirror_path`

| | |
|---|---|
| Type | `string` |
| Required | yes |
| Example | `"google-inc/youtube"` |

APKMirror URL slug (the path segment after `https://www.apkmirror.com/apk/`). The downloader navigates to `https://www.apkmirror.com/apk/<apkmirror_path>/all-versions/` to enumerate releases.

When Cloudflare blocks the `/all-versions/` page (403), the downloader falls back to a Chromium session that resolves the slug via the live page HTML. For Sofascore, the historical slug `soccer-scores-and-sports-livescore-sofascore` was deprecated and is now `sofascore-live-sports-scores`; keep `apkmirror_path` current with APKMirror's current URL.

#### `pin_version` (optional)

| | |
|---|---|
| Type | `string` |
| Required | no |
| Example | `"20.45.36"` |

Lock the build to this exact APK version, bypassing `morphe-desktop list-versions`. Useful when:

- The latest Morphe-supported version only ships as a BUNDLE variant on APKMirror and produces `Chosen APK has no classes.dex`.
- A specific upstream version is known to have arm64-v8a libs (and a later universal bundle is mislabeled).
- You want to verify a build reproducibly before letting CI follow latest.

When set:

- `prepare_target_version.sh` outputs `pinned=1` and exports `PINNED_VERSION=<value>`.
- `update-download-urls.js` skips URL write-backs for this app (the cached URL would never be used).
- The Obtainium release filter `^<name>` still matches — the release tag format is unchanged.

#### `pin_patch_tag` (optional)

| | |
|---|---|
| Type | `string` |
| Required | no |
| Example | `"v1.18.3"` |

Lock the patches tag to this exact release, bypassing `gh release list` on the patches repo. Currently used by `nzb360` and `aida64` because their upstream `rushiranpise/morphe-patches` ships patches tags that lag the morphe-desktop CLI API surface.

#### `display_name` (optional)

| | |
|---|---|
| Type | `string` (non-empty) |
| Required | no |
| Example | `"YouTube Music"` |

Human-readable name rendered in `README.md`'s **Tested apps** / **Releases & Obtainium** tables and embedded in the Obtainium deep-link's `name` field. The `name` field is a build slug (lowercase letters/digits/hyphens) baked into release tags, so IDs like `ytmusic`, `nzb360`, and `aida64` cannot be humanised by capitalisation alone — set `display_name` explicitly for those.

When `display_name` is omitted, the generator falls back to a capitalised `name` (so `nzb360` renders as `Nzb360` if no `display_name` is set). The field stays optional so adding a new app entry never blocks on picking a pretty name.

## `cli`

| | |
|---|---|
| Type | object (`{ repo: string, branch: string }`) |
| Required | yes |

```jsonc
"cli": {
  "repo":   "MorpheApp/morphe-desktop",
  "branch": "main"
}
```

#### `cli.repo`

| | |
|---|---|
| Type | `string` (`owner/repo`) |
| Required | yes |
| Example | `"MorpheApp/morphe-desktop"` |

GitHub `owner/repo` slug pointing at the morphe-desktop CLI repo. The workflow resolves the latest release tag and downloads `morphe-desktop-<tag>.jar` as `tools/morphe-desktop.jar`.

Hard-fail if missing.

#### `cli.branch`

| | |
|---|---|
| Type | `string` |
| Required | yes |
| Default | `"main"` |

The branch to query for the latest release tag. Hard-fail if missing.

## `download_urls`

| | |
|---|---|
| Type | object (`{ [packageId: string]: { [version: string \| "latest_supported"]: string } }`) |
| Required | no |
| Auto-managed | yes (do not hand-edit) |

APK URLs cached by the downloader for fast-path resolution. The cache is consulted **after** `~/.cache/auto-morphe-builder/urls/` and **before** falling through to `apkeep` / `APKMirror-API` / Playwright.

Shape:

```jsonc
"download_urls": {
  "<packageId>": {
    "<version>":           "<url>",
    "latest_supported":    "<url>"
  }
}
```

- `<version>` keys are the APK `versionName` (not the package version).
- `latest_supported` is the last URL picked when no `pin_version` was in effect.

**Write-back policy:** `pre_download_apks.sh` only updates this section when `auto_update_urls` is `true` AND the app does **not** have `pin_version` set. To force re-resolution on the next run, delete the relevant entries from this object **and** clear `~/.cache/auto-morphe-builder/urls/` on the runner.

## Current defaults

```json
{
  "preferred_arch": "arm64-v8a",
  "auto_update_urls": true,
  "patch_repos": {
    "com.google.android.youtube":                { "name": "youtube", "repo": "MorpheApp/morphe-patches",     "branch": "main", "apkmirror_path": "google-inc/youtube" },
    "com.google.android.apps.youtube.music":     { "name": "ytmusic", "repo": "MorpheApp/morphe-patches",     "branch": "main", "apkmirror_path": "google-inc/youtube-music" },
    "com.reddit.frontpage":                      { "name": "reddit",  "repo": "MorpheApp/morphe-patches",     "branch": "main", "apkmirror_path": "redditinc/reddit" },
    "com.sofascore.results":                     { "name": "sofascore","repo": "heval99/morphe-patches",      "branch": "main", "apkmirror_path": "sofascore/soccer-scores-and-sports-livescore-sofascore" },
    "tv.twitch.android.app":                     { "name": "twitch",  "repo": "RookieEnough/De-Vanced",       "branch": "main", "apkmirror_path": "twitch-interactive-inc/twitch-live-streaming" },
    "com.kevinforeman.nzb360":                   { "name": "nzb360",  "repo": "rushiranpise/morphe-patches",  "branch": "main", "apkmirror_path": "kevin-foreman/nzb360",          "pin_patch_tag": "v1.18.3" },
    "com.finalwire.aida64":                      { "name": "aida64",  "repo": "rushiranpise/morphe-patches",  "branch": "main", "apkmirror_path": "finalwire-ltd/aida64",          "pin_patch_tag": "v1.18.3" },
    "com.getmimo":                               { "name": "mimo",    "repo": "hoo-dles/morphe-patches",       "branch": "main", "apkmirror_path": "mimohello-gmbh/mimohello-mimo-learn-to-code" }
  },
  "cli":             { "repo": "MorpheApp/morphe-desktop", "branch": "main" },
  "download_urls":   { /* see file */ }
}
```
