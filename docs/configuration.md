# `config.json` reference

Every field in `config.json`, with type, required-ness, default, example, and validation rules. The current default file is shown at the bottom of this document.

For browser-based editing, use [AutoMorpheBuilder UI](https://nxn94.github.io/AutoMorpheBuilder-UI/), then download and commit the changed JSON files to your fork. The repository schema and `npm run validate:config` remain authoritative; never put secrets into config files.

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
| Allowed values | `arm64-v8a`, `armeabi-v7a`, `x86`, `x86_64` |

Selects the preferred native architecture when APKMirror / APKPure lists multiple ABIs in the same release. The downloader (`unified-downloader.js`) reads this to:

- Prefer an explicitly matching architecture over a compatible universal variant. APKPure API results use size to prioritize candidates, but actual native libraries are checked before acceptance.
- Reject a downloaded bundle whose only `lib/` ABI does not match this preference (post-merge validation in `download-supported-apk.js`).

Validation: `schemas/config.schema.json` enforces the four-value ABI enum. `universal` is a possible upstream variant, not an accepted `preferred_arch` value. Actual delivered libraries must still pass ABI validation.

## `auto_update_urls`

| | |
|---|---|
| Type | `boolean` |
| Required | no |
| Default | `true` |
| Example | `false` |

When `true`, `pre_download_apks.sh` writes reusable resolved APK URLs back to `download_urls` after a successful pre-download (via `node update-download-urls.js <pkg> <version> <url>`). After local APK reuse and the Google Play attempt, URL caches can short-circuit the remaining providers. Google Play returns local files; its expiring delivery URLs and authentication data are never written here.

When `false`, the resolved URL is logged but `config.json` is left untouched. Useful if you want to pin downloads to specific URLs, or want to avoid noisy diffs on every run.

Use JSON Booleans `true` or `false`; strings and numbers are rejected by the schema. The shell helper `pipeline/lib/config.sh` `auto_update_urls_enabled` also handles legacy truthy values defensively, but that does not make them valid configuration.

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

Must be unique across `patch_repos`. The schema enforces `^[a-z0-9][a-z0-9-]*$`; the semantic validator rejects duplicate names.

#### `repo`

| | |
|---|---|
| Type | `string` (`owner/repo`) |
| Required | yes |
| Example | `"MorpheApp/morphe-patches"` |

GitHub `owner/repo` slug pointing at a Morphe-compatible patches repository. The workflow:

1. Lists the latest release tag of this repo (used as the `patches-version`).
2. Downloads the `patches-<tag>.mpp` artifact attached to that release.
3. Calls `morphe-desktop.jar patch --patches <mpp>` with this `.mpp` to patch the APK.

The repo **must** publish `.mpp` artifacts. If it does not, the per-app `Preflight per-app patch availability` step fails the workflow before the build matrix spins up.

##### Moving an app to a different patch repo

Edit the app's existing `patch_repos` entry and change `repo` (and `branch` / `pin_patch_tag` if needed) in the same commit. The next push to `main`:

1. `update-patches.yml` detects the relocation — the destination repo *already exists* in `patches.json` (carrying other apps like `mimo` next to `hoo-dles/morphe-patches`) doesn't matter; the gate opens on a relocated app just as it does on a brand-new repo (`scripts/detect-new-repos.js`, unit-tested in `.github/scripts/__tests__/detect-new-repos.test.js`).
2. `sync-patches.sh` rebuilds the section under the destination repo. For each app under that destination, it looks up the user's existing per-patch toggles — first in the destination's own entry, then falling back to the entry under any other repo where the app lives. Explicit `false` toggles (e.g. `Disable telemetry: false`) are preserved across the move.
3. After merge, the trailing `ACTIVE_REPOS` filter drops the now-unreferenced source repo (`heval99/morphe-patches`), leaving the app's toggles intact under the new repo.

Manual backstop: `workflow_dispatch` on `update-patches.yml` re-runs sync unconditionally; use it if a push trigger hasn't landed.

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

Lock the patches tag to this exact release instead of selecting the latest compatible upstream tag. Currently `nzb360` pins `rushiranpise/morphe-patches` to `v1.18.3`; see `config.json` for current pins.

#### `display_name` (optional)

| | |
|---|---|
| Type | `string` (non-empty) |
| Required | no |
| Example | `"YouTube Music"` |

Human-readable name rendered in `README.md`'s **Tested apps** / **Releases & Obtainium** tables and embedded in the Obtainium deep-link's `name` field. The `name` field is a build slug baked into release tags; set `display_name` explicitly for labels such as YouTube Music, NZB360 and Flightradar24.

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

Reusable APK URLs cached for fast-path resolution. After local APK reuse and the optional goopdl attempt, this section is consulted **after** `~/.cache/auto-morphe-builder/urls/` and **before** apkeep / APKMirror-API / browser fallback. Cached downloads still require validation.

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

The authoritative complete file (including optional `display_name` labels) is [`config.json`](../config.json). The build-relevant defaults are:

```json
{
  "preferred_arch": "arm64-v8a",
  "auto_update_urls": true,
  "patch_repos": {
    "com.google.android.youtube":                { "name": "youtube", "repo": "MorpheApp/morphe-patches",     "branch": "dev",  "apkmirror_path": "google-inc/youtube" },
    "com.google.android.apps.youtube.music":     { "name": "ytmusic", "repo": "MorpheApp/morphe-patches",     "branch": "main", "apkmirror_path": "google-inc/youtube-music" },
    "com.reddit.frontpage":                      { "name": "reddit",  "repo": "MorpheApp/morphe-patches",     "branch": "main", "apkmirror_path": "redditinc/reddit" },
    "com.sofascore.results":                     { "name": "sofascore","repo": "hoo-dles/morphe-patches",    "branch": "main", "apkmirror_path": "sofascore/soccer-scores-and-sports-livescore-sofascore" },
    "tv.twitch.android.app":                     { "name": "twitch",  "repo": "ryykitty/twitch-patched",       "branch": "main", "apkmirror_path": "twitch-interactive-inc/twitch-live-streaming" },
    "com.kevinforeman.nzb360":                   { "name": "nzb360",  "repo": "rushiranpise/morphe-patches",  "branch": "main", "apkmirror_path": "kevin-foreman/nzb360",          "pin_patch_tag": "v1.18.3" },
    "com.flightradar24free":                     { "name": "flightradar24", "repo": "rushiranpise/morphe-patches", "branch": "main", "apkmirror_path": "flightradar24-ab/flightradar24-flight-tracker-2" }
  },
  "cli":             { "repo": "MorpheApp/morphe-desktop", "branch": "main" },
  "download_urls":   {}
}
```

## Independent release selectors

Each app resolves its own `(repo, branch, pin_patch_tag)` selection. Apps sharing
an upstream repository can use `main`, `dev`, and explicit tags simultaneously.
Only apps with the same resolved repository/tag share a downloaded patches bundle.
Patch synchronization uses the same selection and preserves existing Boolean
choices, including when an app moves repositories or upstream metadata is unavailable.
Adding a package under an existing repository also triggers initial toggle seeding.

`auto_update_urls: false` disables config URL write-back. The separate bounded URL
cache can still speed up resolution; cached URLs and the final APK remain validated.
