# Setup Guide

Forking for personal use is encouraged. Most customizations are edits to `config.json` and `patches.json` — no workflow changes needed.

Optional browser editor: [AutoMorpheBuilder UI](https://nxn94.github.io/AutoMorpheBuilder-UI/) loads, edits and validates both JSON files. Download your changes and commit them to your fork; it does not save to GitHub or start workflows automatically. Never enter signing secrets into the UI or commit them in JSON.

---

## 1. Create a signing keystore

```bash
keytool -genkey -v -keystore morphe.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias Key \
  -dname "CN=Your Name, O=Your Org, L=City, ST=State, C=US"
```

Keep this file safe — do not commit it.

---

## 2. Base64-encode the keystore

**Linux (GNU coreutils):**
```bash
base64 -w 0 morphe.jks
```

**macOS:**
```bash
base64 < morphe.jks | tr -d '\n'
```

**Windows PowerShell:**
```powershell
[Convert]::ToBase64String([System.IO.File]::ReadAllBytes("morphe.jks"))
```

Copy the output — you'll paste it in step 3.

---

## 3. Add GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions.

| Secret | Required | Description |
|--------|----------|-------------|
| `KEYSTORE_BASE64` | yes | Output from step 2 |
| `KEYSTORE_PASSWORD` | yes | Keystore password (also used as the key entry password when `KEY_PASSWORD` is unset) |
| `KEY_ALIAS` | no | Defaults to the first alias in the keystore, detected via `keytool -list`. Set this explicitly if your keystore has multiple aliases. |
| `KEY_PASSWORD` | no | Only if the key entry password differs from `KEYSTORE_PASSWORD`. Set for keystores where the store and key passwords were generated separately. |
| `APKMIRROR_API_USER` | no | Enables the optional APKMirror-API provider; browser fallback remains available. Set as a repository secret: the `build` job does not use the `signing` environment |
| `APKMIRROR_API_PASS` | no | APKMirror-API password |

---

## 4. Configure `config.json`

Each entry under `patch_repos` is one app. Remove entries to skip an app; add entries to support more. The full field reference (types, defaults, allowed values, validation) lives in [`docs/configuration.md`](docs/configuration.md) — read that before adding new fields.

```json
{
  "preferred_arch": "arm64-v8a",
  "auto_update_urls": true,
  "patch_repos": {
    "com.google.android.youtube": {
      "name": "youtube",
      "repo": "MorpheApp/morphe-patches",
      "branch": "dev",
      "apkmirror_path": "google-inc/youtube"
    },
    "com.google.android.apps.youtube.music": {
      "name": "ytmusic",
      "repo": "MorpheApp/morphe-patches",
      "branch": "main",
      "apkmirror_path": "google-inc/youtube-music"
    },
    "com.reddit.frontpage": {
      "name": "reddit",
      "repo": "MorpheApp/morphe-patches",
      "branch": "main",
      "apkmirror_path": "redditinc/reddit"
    },
    "com.sofascore.results": {
      "name": "sofascore",
      "repo": "hoo-dles/morphe-patches",
      "branch": "main",
      "apkmirror_path": "sofascore/soccer-scores-and-sports-livescore-sofascore"
    },
    "tv.twitch.android.app": {
      "name": "twitch",
      "repo": "ryykitty/twitch-patched",
      "branch": "main",
      "apkmirror_path": "twitch-interactive-inc/twitch-live-streaming"
    },
    "com.kevinforeman.nzb360": {
      "name": "nzb360",
      "repo": "rushiranpise/morphe-patches",
      "branch": "main",
      "apkmirror_path": "kevin-foreman/nzb360",
      "pin_patch_tag": "v1.18.3"
    },
    "com.flightradar24free": {
      "name": "flightradar24",
      "repo": "rushiranpise/morphe-patches",
      "branch": "main",
      "apkmirror_path": "flightradar24-ab/flightradar24-flight-tracker-2"
    }
  },
  "cli": {
    "repo": "MorpheApp/morphe-desktop",
    "branch": "main"
  },
  "download_urls": {}
}
```

| Field | Description |
|-------|-------------|
| `preferred_arch` | Architecture preference (default `arm64-v8a`) |
| `auto_update_urls` | If `true`, write resolved download URLs back to `config.json` after each build |
| `patch_repos[*].name` | App identifier — used in the release tag and the Obtainium filter |
| `patch_repos[*].repo` | Patch repo (`MorpheApp/morphe-patches`, community fork, etc.) |
| `patch_repos[*].branch` | Patch branch |
| `patch_repos[*].apkmirror_path` | APKMirror package slug. The current slug is auto-resolved via `/all-versions/` if the configured one is deprecated |
| `patch_repos[*].pin_version` | Optional: lock to a specific APK version |
| `patch_repos[*].pin_patch_tag` | Optional: lock to a specific upstream patch tag (needed for patch repos without `latest_supported`) |
| `cli.repo` / `cli.branch` | morphe-desktop repo and branch |

`download_urls` at the bottom is auto-managed — do not edit it by hand.

---

## 5. Configure `patches.json`

1. Actions → **Update patches.json from upstream repos** → Run workflow — populates `patches.json` from each upstream patch repo.
2. Edit toggles per patch (`true` = enabled, `false` = disabled). New upstream patches default to `true`; your existing toggles are preserved across syncs.

```json
{
  "MorpheApp/morphe-patches": {
    "com.google.android.youtube": {
      "Hide ads": true,
      "SponsorBlock": true,
      "Return YouTube Dislike": false
    }
  }
}
```

---

## 6. Run the build

Actions → **Build Morphe-patched apps** → Run workflow.

Select your intended branch (normally `main`). Scheduled runs use the default branch daily at 05:15 UTC and skip apps only when APK, checksum and provenance assets are complete and match the current build inputs. Manual runs force rebuilding, including existing tags. See [release identity](docs/release-process.md#build-identity-and-forced-rebuilds).

The workflow installs optional goopdl and tries exact-version Google Play downloads before the existing cache/APKPure/APKMirror providers. No personal Google login is needed; all fallbacks remain available. Never upload or cache `tools/goopdl-home/` (the private anonymous-authentication pool).

---

## 7. Verify

Per-app releases appear as `<app>-v<base-version>-<patches-version>` (e.g. `youtube-v20.44.38-v1.24.0-dev.8`). Old releases are pruned to keep the most recent 2 per app (`KEEP_COUNT` env).

---

## 8. Set up Obtainium

One entry per app, same repo, different Release Tag Filter:

| App | Release Tag Filter |
|-----|--------------------|
| YouTube | `^youtube` |
| YouTube Music | `^ytmusic` |
| Reddit | `^reddit` |
| Sofascore | `^sofascore` |
| Twitch | `^twitch` |
| NZB360 | `^nzb360` |
| Flightradar24 | `^flightradar24` |

---

## Common issues

The list below mirrors the short set in `README.md` → "Common failures". For the full symptom/cause/fix catalogue — including APK download failures, `NoSuchMethodError` from the compat probe, stale `.xapk`/`apkm` bundles, and version-mismatch from `downloadWithUrl` — see [`docs/troubleshooting.md`](docs/troubleshooting.md).

- **`Chosen APK has no classes.dex`** — split/config APK picked. The post-merge step handles XAPK/APKM/APKS bundles via APKEditor, so bundles should resolve to a patched base APK automatically.
- **`[pkg] could not determine version`** — `morphe-desktop list-versions` found no compatible APK for the app's patch. Verify `patch_repos[*].repo` publishes a `.mpp` for your package.
- **`Wrong version of key store`** — verify `KEYSTORE_BASE64` decodes to the correct keystore, `KEYSTORE_PASSWORD` is right, and `KEY_PASSWORD` is set only if it differs.
- **ARM64 requested but only armeabi-v7a libraries arrive** — check the selected source/variant; keep validation enabled and use another provider or a known-good `pin_version`.
- **Obtainium not finding updates** — verify the Release Tag Filter regex matches the `name` field in `config.json`.

---

## Checklist

- [ ] Keystore created and base64-encoded
- [ ] Secrets added (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, optionally `KEY_ALIAS` / `KEY_PASSWORD` / APKMirror-API)
- [ ] `config.json` edited (apps / arch / patch repos)
- [ ] `update-patches.yml` run once
- [ ] `patches.json` toggles reviewed
- [ ] Manual build triggered and verified
- [ ] Obtainium entries created