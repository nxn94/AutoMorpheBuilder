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

## `honor_patch_opt_ins`

Optional Boolean, default `false`. Generated patch metadata always honours a patch set `true` in `patches.json`. Structured patch lists do not by default, because the old sync marked every new patch `true`, so such entries may not be real choices. Set this to `true` once your `patches.json` reflects what you want: a patch that is off by default is then enabled when you set it `true`. Review diagnostic patches first.

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
  "min_sdk":        30,                        // optional, lowest Android API level the patches support
  "display_name":   "Example",                 // optional, human-readable name for README/Obtainium
  "extra_patches":  { "owner/other-patches": ["Patch name"] }, // optional, named patches from other sources
  "patch_options":  { "Change app name": { "appName": "My Maps" } } // optional, patch settings
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
- APK cache key: `apk-<appId>-<version>-<run_id>-<run_attempt>`; the newest entry for the version is restored.

Must be unique across `patch_repos`. The schema enforces `^[a-z0-9][a-z0-9-]*$`; the semantic validator rejects duplicate names.

#### `repo`

| | |
|---|---|
| Type | `string` (`owner/repo`, or `gitlab:owner/project`) |
| Required | yes |
| Example | `"MorpheApp/morphe-patches"`, `"gitlab:johninnld/nl-morphe-patches"` |

A bare `owner/repo` slug is a GitHub repository — the default, and what every existing entry means. A `gitlab:owner/project` prefix points at a top-level gitlab.com project instead (see [GitLab patch sources](#gitlab-patch-sources) below). The forge is encoded in this one string so the rest of the pipeline — `patches.json` keys, patch slugs, caches, README tables, relocation detection — keeps treating it as a single opaque identity.

For a GitHub source the workflow:

1. Lists the latest release tag of this repo (used as the `patches-version`).
2. Downloads the `patches-<tag>.mpp` artifact attached to that release.
3. Calls `morphe-desktop.jar patch --patches <mpp>` with this `.mpp` to patch the APK.

The repo **must** publish `.mpp` artifacts. If it does not, the per-app `Preflight per-app patch availability` step fails the workflow before the build matrix spins up.

##### GitLab patch sources

`"repo": "gitlab:owner/project"` builds from a patches project hosted on gitlab.com. Roughly a dozen Morphe patch sources (around 60 apps) publish only there, and some patch an APK that no GitHub source handles — `com.alibaba.aliexpresshd` is the case this support was added for.

What is supported, and why it is drawn this narrowly:

1. **Top-level gitlab.com projects only.** `gitlab:owner/project`. Subgroup paths (`gitlab:group/sub/project`), other GitLab instances and other forges are rejected by `npm run validate:config` and by the resolver with a message naming the problem — never half-supported.
2. **The patches bundle comes from the generic package registry**, not from GitLab's release assets. GitLab's release API returns asset links with **no digest field of any kind**, so a release-driven route could not be verified. The generic package registry publishes `file_sha256` per file (`GET /projects/:id/packages` → `GET /projects/:id/packages/:package_id/package_files`), and that digest is enforced byte-for-byte — exactly the gate `gh_asset_sha256` provides for GitHub. **A bundle with no `file_sha256`, more than one `patches-*.mpp` name, or no `patches-*.mpp` at all fails the build rather than being trusted.**
3. **Tags are package versions.** With no `pin_patch_tag`, the newest generic package by `created_at` wins — a stable version on `branch: "main"`, a pre-release version on any other branch, mirroring the GitHub channel choice. The tag is reported as `v<version>` (e.g. package `1.54.0` → tag `v1.54.0`), which is also how these projects tag their git refs. `pin_patch_tag` matches a package version exactly; `v1.54.0` and `1.54.0` both address `1.54.0`.
4. **Patch metadata uses the same two steps as GitHub:** the exact tagged `patches-list.json` via GitLab's raw-file route, then metadata derived from the digest-verified `.mpp` through the configured CLI. There is no GitLab equivalent of the middle "same release's `patches-list.json` asset" step, because that is the undigested route above.

Optional `GITLAB_TOKEN` repository secret: gitlab.com rate-limits its unauthenticated API, and a shared runner IP can receive HTTP 429 (a persistent 429 fails the run rather than skipping patches). If builds hit this, create a personal access token on a free gitlab.com account with only the `read_api` scope and add it as a repository secret named `GITLAB_TOKEN`. The steps that query GitLab in `morphe-build.yml` and `update-patches.yml` pass it through; it is sent as a `PRIVATE-TOKEN` header to gitlab.com only and never logged. Without the secret the value is empty, no header is sent, and public projects are still queried anonymously. Tokens expire, so renew the secret when yours does.

`cli.repo` is unchanged and remains a GitHub slug — morphe-desktop is only published there.

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

APKMirror URL slug (the path segment after `https://www.apkmirror.com/apk/`). The downloader navigates to `https://www.apkmirror.com/apk/<apkmirror_path>/all-versions/` to enumerate releases. That page lists only the newest releases; for an older version that is no longer listed, the release-page name is inferred from the listed releases (e.g. LinkedIn's `linkedin-community-network-<version>-release`, which differs from the path's last part).

When Cloudflare blocks the `/all-versions/` page (403), the downloader falls back to a Chromium session that resolves the slug via the live page HTML. For Sofascore, the historical slug `soccer-scores-and-sports-livescore-sofascore` was deprecated and is now `sofascore-live-sports-scores`; keep `apkmirror_path` current with APKMirror's current URL.

#### `pin_version` (optional)

| | |
|---|---|
| Type | `string` |
| Required | no |
| Example | `"20.45.36"` |

Lock the build to this exact APK version, bypassing `morphe-desktop list-versions`. For MPP-derived metadata, the pin must satisfy every enabled patch; an incompatible pin fails before APK downloads. Useful when:

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

#### `extra_patches` (optional)

| | |
|---|---|
| Type | `object` (`{ "owner/repo": ["Patch name", ...] }`) |
| Required | no |
| Example | `{ "MorpheApp/morphe-patches": ["Disable Play Store updates"] }` |

Applies the named patches from other patch sources in addition to the app's own `repo`, for example a universal patch that the app's patch repo doesn't ship. Each source is a GitHub `owner/repo` slug (GitLab sources are rejected by validation). If a source is the app's own `repo`, the names are simply enabled in its bundle.

- **Release:** the `check-versions` job resolves each extra source's latest release once, so every app in a run uses the same release. If that lookup fails, the build looks up the latest release itself.
- **Integrity:** the bundle's SHA-256 must match the digest GitHub serves for the release asset, as for other `.mpp` files. A missing digest, a mismatch, or any failure to fetch a listed bundle fails that app's build.
- **Rebuilds:** changing `extra_patches` rebuilds that app only. A new release of an extra source does not rebuild anything on its own; apps pick it up the next time they rebuild.
- **Version resolution:** supported versions and the compatibility probe consider only the app's own bundle. Extra patches are not part of them, so use patches that are not tied to specific app versions.
- Apps without the field behave exactly as before.

#### `patch_options` (optional)

| | |
|---|---|
| Type | `object` (`{ "Patch name": { "key": value, ... } }`) |
| Required | no |
| Example | `{ "Change app name": { "appName": "My Maps" } }` |

Sets values for patches that take settings, for patches in the app's own `repo`. `patches.json` still only says which patches are on; this only gives them values.

- **Values:** strings, `true`/`false`, whole numbers, or decimals such as `1.5`. Whole numbers are passed as integers, so a decimal setting needs a fractional value. Each is passed as its own `-Okey=value` argument straight after the patch's `-e`, with no shell in between, so spaces and quotes are kept. Strings are wrapped in double quotes, which morphe-desktop removes once, so `"1"` or `"true"` stays a string. Keys can't contain spaces or `=`.
- **Names:** patch names must match the patch list exactly, including case, because morphe-desktop looks settings up by exact name. A different spelling is skipped with a warning naming the right one.
- **Errors:** a setting the patch doesn't have, or a value it rejects, fails the app's build. morphe-desktop itself would only log it.
- **Selection is unchanged:** settings apply only to a patch that runs anyway (on by default, or chosen in `patches.json` where opt-ins are honoured). A patch set `false` stays off, and settings for a patch that is off, or not in this release, are skipped with a warning.
- **Same-named patches:** morphe-desktop's `-e` acts on every patch of that name, ignoring case. If passing `-e` for a patch's settings would also switch on a same-named patch that is off by default (for example a universal one), the app's build fails instead.
- **Rebuilds:** changing `patch_options` rebuilds that app only (it is part of the app entry).
- Apps without the field behave exactly as before.

#### `min_sdk` (optional)

| | |
|---|---|
| Type | integer 1-99 (Android API level) |
| Required | no |
| Example | `30` (Android 11) |

The lowest Android the patches support. A store can serve a build for an older Android than the patches handle (a store's arm64 build was made for Android 9 while the patches need Android 11), and the patcher then fails minutes after the download was accepted.

- **Floor:** this value, and only this value. The check is opt-in per app: absent means no check. The patch list's own `minSdk` is deliberately not used, because it may describe the device or patched app rather than the APK's `minSdkVersion` (Morphe's YouTube targets carry 28/29) and would reject correct downloads.
- **Check:** after each download (Google Play, exact APKPure build, URL cache, `patches.json` URL, resolvers) the file's `sdkVersion` is read with `aapt` (a bundle's base APK). A file below the floor is deleted, never cached (and removed from the URL cache if it came from there), and the next source is tried. After APKPure's smallest variant is rejected, its other variants of the same version are tried too. A pre-downloaded APK in `apps/` and a `MANUAL_URL` download below the floor are discarded. A rejected build is not downloaded again (APKPure variants are recognised by build number and size, because their URLs change between fetches), and, best effort, the whole download stops starting new steps after about 540 s so the message below can survive the 600 s limit (if the downloader is killed anyway, the annotation is rebuilt from its `[min-sdk]` log lines). The error is also emitted as its own `::error title=Wrong build::` annotation.
- **Unreadable:** if the minimum Android can't be read the file is kept and the patcher judges it.
- **Failure:** if every source failed and at least one file was too old, the error reads `Wrong build: every download of <package> <version> was for older Android (API X+); the patches need API N+. Patch the <preferred_arch> (Android <name>+) build of <package> instead.`
- **Rebuilds:** changing `min_sdk` rebuilds that app only (it is part of the app entry).

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

## Patch metadata and selections

The shared resolver reads `patches-list.json` from the exact resolved or `pin_patch_tag` tag. If raw metadata is absent (HTTP 404), it tries the asset on that same release. A names-only list, or a list without usable compatibility, requires fallback to the exact release's MPP. The configured `cli.repo` and resolved CLI tag load that bundle with `list-patches -p -v --with-descriptions=false` (options and descriptions are unused and omitted); both binaries must match the GitHub release API's SHA-256 digests. There is no latest-release or third-party metadata fallback. Malformed metadata, auth errors, rate limits and transport failures are errors rather than evidence of an unsupported package.

Legacy structured metadata keeps its existing sync rule: new patches use an explicit upstream `default` Boolean when present, else an explicit `use` Boolean (some sources, such as SysAdminDoc/HushGram, write only `use`), otherwise `true`, existing choices survive, and patch execution uses CLI defaults with explicit exclusions. For generated metadata, new patches use upstream enabled defaults; explicit `true` and `false` choices survive sync and repo moves. Explicit `true` opt-ins are also passed with `-e` when executing these bundles. This corrects the former mismatch where a selected default-disabled patch was never enabled by the patch command. Legacy all-true selections do not acquire new diagnostic opt-ins. Explicit `compatiblePackages: null` is universal compatibility; an omitted compatibility field is malformed. Raw metadata may repeat patch names across package declarations; generated CLI metadata requires unique names. Structured target rows may explicitly use `version: null` for unrestricted compatibility; a missing version is malformed.

Generated version resolution intersects compatible versions across the effective selection, preserving full names such as `12.40.1-prod.01`. Experimental targets are excluded. Universal CLI patches (no package section or `(universal)`) apply to every package. Optional version-code rows are validated without altering version names. An explicitly unrestricted patch adds no version constraint; if all selected patches are unrestricted, set an exact `pin_version`. Missing or malformed compatibility is never interpreted as unrestricted. Preflight, the release matrix, predownload and target resolution use the same selection semantics.

Standalone `bash scripts/sync-patches.sh` requires Java 21 when MPP fallback is needed. The update workflow sets Java up automatically. The script resolves the configured CLI tag; the resolver downloads and verifies fallback tools lazily under `tools/metadata-artifacts/`. A failed metadata resolution preserves the app's previous selection and emits a warning.

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
