# AutoMorpheBuilder

[![CI](https://img.shields.io/github/actions/workflow/status/nxn94/AutoMorpheBuilder/ci.yml?branch=dev&label=CI)](https://github.com/nxn94/AutoMorpheBuilder/actions/workflows/ci.yml)
[![CodeQL](https://img.shields.io/github/actions/workflow/status/nxn94/AutoMorpheBuilder/codeql.yml?branch=dev&label=CodeQL)](https://github.com/nxn94/AutoMorpheBuilder/actions/workflows/codeql.yml)
[![Build](https://img.shields.io/github/actions/workflow/status/nxn94/AutoMorpheBuilder/morphe-build.yml?branch=dev&label=Build)](https://github.com/nxn94/AutoMorpheBuilder/actions/workflows/morphe-build.yml)
[![License: GPL-3.0](https://img.shields.io/github/license/nxn94/AutoMorpheBuilder?color=blue)](https://github.com/nxn94/AutoMorpheBuilder/blob/dev/LICENSE)


GitHub Actions pipeline that builds patched Android APKs with [Morphe patches](https://github.com/MorpheApp/morphe-patches), [morphe-desktop](https://github.com/MorpheApp/morphe-desktop), and [APKEditor](https://github.com/REAndroid/APKEditor). Outputs are signed, per-app versioned, and ready for Obtainium.

Forking for personal use is encouraged. To add or remove an app, edit `config.json` `patch_repos` — no workflow changes needed.

> [!IMPORTANT]
> **Legal and security notice.** This project downloads and modifies third-party Android applications (via APKMirror, APKPure, and upstream patch repositories). You are responsible for ensuring that your use of the resulting patched APKs complies with each app's license, terms of service, and the laws of your jurisdiction. The maintainers do not host, mirror, or redistribute any copyrighted APK — every APK is fetched at build time from the upstream source you configure.
>
> The build signs patched APKs with **your** keystore (`KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`). Treat those secrets as production credentials: do not paste them into issues or PRs, do not reuse a personal keystore across experiments, and review the upstream patch repo before trusting it with your signing material. See [`SECURITY.md`](SECURITY.md) for the disclosure policy and how to report a vulnerability privately.

---

## Tested apps

| App | Package | Patch repo |
|-----|---------|------------|
| YouTube | `com.google.android.youtube` | `MorpheApp/morphe-patches` |
| YouTube Music | `com.google.android.apps.youtube.music` | `MorpheApp/morphe-patches` |
| Reddit | `com.reddit.frontpage` | `MorpheApp/morphe-patches` |
| Sofascore | `com.sofascore.results` | `heval99/morphe-patches` |
| Twitch | `tv.twitch.android.app` | `RookieEnough/De-Vanced` |
| NZB360 | `com.kevinforeman.nzb360` | `rushiranpise/morphe-patches` |
| AIDA64 | `com.finalwire.aida64` | `rushiranpise/morphe-patches` |
| Mimo | `com.getmimo` | `hoo-dles/morphe-patches` |

---

## Workflows

| Workflow | File | Trigger | Purpose |
|----------|------|---------|---------|
| **Build Morphe-patched apps** | `morphe-build.yml` | daily 05:15 UTC + manual | Main pipeline. `check-versions` resolves latest tags and drops apps whose release already exists → `build` (matrix per app) downloads the APK, applies patches, signs → `create-release` publishes one GitHub Release per app and prunes the oldest (keeps 2 per app). |
| **Update patches.json from upstream repos** | `update-patches.yml` | manual + push to `config.json` | Refreshes `patches.json` from each upstream patch repo. New patches default to `true`; existing toggles are preserved. |
| **CI** | `ci.yml` | PR + push to `main` | `npm ci` → `eslint` → `jest`. Gates broken PRs. |
| **CodeQL** | `codeql.yml` | PR + push to `main` + daily 06:00 UTC | Static security analysis (JavaScript/TypeScript + Actions). |

---

## Releases & Obtainium

Each app gets its own release with tag `<app>-v<base-version>-<patches-version>`:

```
youtube-v20.44.38-v1.24.0-dev.8.apk
ytmusic-v8.44.54-v1.24.0-dev.8.apk
sofascore-v26.07.27-v1.0.0.apk
```

Create one Obtainium entry per app against this repo with a Release Tag Filter matching `name`:

| App | Release Tag Filter | Add to Obtainium |
|-----|--------------------|------------------|
| YouTube | `^youtube` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.google.android.youtube%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22YouTube%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Eyoutube%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="30"></a> |
| YouTube Music | `^ytmusic` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.google.android.apps.youtube.music%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22YouTube%20Music%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Eytmusic%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="40"></a> |
| Reddit | `^reddit` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.reddit.frontpage%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22Reddit%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Ereddit%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="20"></a> |
| Sofascore | `^sofascore` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.sofascore.results%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22Sofascore%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Esofascore%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="20"></a> |
| Twitch | `^twitch` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22tv.twitch.android.app%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22Twitch%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Etwitch%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="20"></a> |
| NZB360 | `^nzb360` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.kevinforeman.nzb360%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22NZB360%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Enzb360%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="20"></a> |
| AIDA64 | `^aida64` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.finalwire.aida64%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22AIDA64%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Eaida64%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="20"></a> |
| Mimo | `^mimo` | <a href="https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/%7B%22id%22%3A%22com.getmimo%22%2C%22url%22%3A%22https%3A%2F%2Fgithub.com%2Fnxn94%2FAutoMorpheBuilder%2Freleases%22%2C%22author%22%3A%22nxn94%22%2C%22name%22%3A%22Mimo%22%2C%22preferredApkIndex%22%3A0%2C%22additionalSettings%22%3A%22%7B%5C%22includePrereleases%5C%22%3Afalse%2C%5C%22fallbackToOlderReleases%5C%22%3Atrue%2C%5C%22filterReleaseTitlesByRegEx%5C%22%3A%5C%22%5Emimo%5C%22%2C%5C%22filterReleaseNotesByRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22verifyLatestTag%5C%22%3Afalse%2C%5C%22sortMethodChoice%5C%22%3A%5C%22date%5C%22%2C%5C%22useLatestAssetDateAsReleaseDate%5C%22%3Afalse%2C%5C%22releaseTitleAsVersion%5C%22%3Afalse%2C%5C%22trackOnly%5C%22%3Afalse%2C%5C%22versionExtractionRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22matchGroupToUse%5C%22%3A%5C%22%5C%22%2C%5C%22versionDetection%5C%22%3Atrue%2C%5C%22releaseDateAsVersion%5C%22%3Afalse%2C%5C%22useVersionCodeAsOSVersion%5C%22%3Afalse%2C%5C%22apkFilterRegEx%5C%22%3A%5C%22%5C%22%2C%5C%22invertAPKFilter%5C%22%3Afalse%2C%5C%22autoApkFilterByArch%5C%22%3Atrue%2C%5C%22appName%5C%22%3A%5C%22%5C%22%2C%5C%22appAuthor%5C%22%3A%5C%22%5C%22%2C%5C%22shizukuPretendToBeGooglePlay%5C%22%3Afalse%2C%5C%22allowInsecure%5C%22%3Afalse%2C%5C%22exemptFromBackgroundUpdates%5C%22%3Afalse%2C%5C%22skipUpdateNotifications%5C%22%3Afalse%2C%5C%22about%5C%22%3A%5C%22%5C%22%2C%5C%22refreshBeforeDownload%5C%22%3Afalse%2C%5C%22includeZips%5C%22%3Afalse%2C%5C%22zippedApkFilterRegEx%5C%22%3A%5C%22%5C%22%7D%22%7D"><img src="https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png" alt="Add to Obtainium" height="20"></a> |

---

## Required secrets

Signed builds are enforced — missing `KEYSTORE_BASE64` or `KEYSTORE_PASSWORD` = build fails.

| Secret | Required | Description |
|--------|----------|-------------|
| `KEYSTORE_BASE64` | yes | Base64 of your keystore |
| `KEYSTORE_PASSWORD` | yes | Keystore password |
| `KEY_ALIAS` | no | Defaults to first alias in keystore |
| `KEY_PASSWORD` | no | Only if key password ≠ keystore password |
| `APKMIRROR_API_USER` | no | APKMirror-API username (skips Playwright fallback) |
| `APKMIRROR_API_PASS` | no | APKMirror-API password |

---

## APK download

Multi-source fallback (first valid result wins): pre-downloaded `tools/*.apk` → URL cache (`~/.cache/auto-morphe-builder/urls/`) → `config.json download_urls` → parallel resolution via **apkeep** (APKPure), **APKMirror-API** (if creds set), **APKMirror scraper** (curl → Chromium fallback for `/all-versions/` slug when Cloudflare blocks).

Split packages (XAPK/APKM/APKS) are saved as `.apk` on disk and detected by **content**, not extension — aapt validation is skipped on the outer zip-of-zips, the inner `base.apk` is validated post-merge. Sofascore's 57MB arm64-v8a XAPK wins over the 93MB universal by size.

---

## APK selection

- Architecture: `preferred_arch` from `config.json` (default `arm64-v8a`)
- DPI preference (APKMirror only): `nodpi` → `120-640dpi` → `480-640dpi` → `120-480dpi` → `240-480dpi`
- Split packages: APKEditor merge → fallback to dex-bearing APK extraction
- Rejects dex-less APKs (must contain `classes*.dex`)

---

## Signing

1. Decode `KEYSTORE_BASE64` → `tools/source.keystore`
2. Auto-detect type (PKCS12 / JKS / BKS / UBER)
3. Convert to BKS for morphe-desktop compatibility
4. Sign patched APK
5. Fail immediately on any signing error

---

## Common failures

- **`Chosen APK has no classes.dex`** — split/config APK picked. The post-merge step re-validates `base.apk`'s versionName for XAPK/APKM/APKS bundles.
- **`[pkg] could not determine version`** — `morphe-desktop list-versions` returned no matching version. Verify `patch_repos[*].repo` actually publishes a `.mpp` for your app.
- **`Wrong version of key store`** — wrong `KEYSTORE_PASSWORD`, or `KEY_PASSWORD` differs from keystore password.
- **Arm64-v8a APK arrives with armeabi-v7a libs only** — upstream bundle is mislabeled. Use `pin_version` to lock to a known-good APK version.
- **Obtainium not finding updates** — verify the Release Tag Filter regex matches the `name` field in `config.json`.

---

## License

Licensed under the GNU General Public License v3.0. See [LICENSE](LICENSE).
