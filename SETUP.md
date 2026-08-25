# Setup Guide

Forking for personal use is encouraged. Most customizations are edits to `config.json` and `patches.json` — no workflow changes needed.

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

**Linux / macOS:**
```bash
base64 -w 0 morphe.jks
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
| `KEYSTORE_PASSWORD` | yes | Keystore password |
| `KEY_ALIAS` | no | Defaults to first alias in keystore |
| `KEY_PASSWORD` | no | Only if key password ≠ keystore password |
| `APKMIRROR_API_USER` | no | Speeds up APK resolution (skips Playwright fallback) |
| `APKMIRROR_API_PASS` | no | APKMirror-API password |

---

## 4. Configure `config.json`

Each entry under `patch_repos` is one app. Remove entries to skip an app; add entries to support more.

```json
{
  "preferred_arch": "arm64-v8a",
  "auto_update_urls": true,
  "patch_repos": {
    "com.google.android.youtube": {
      "name": "youtube",
      "repo": "MorpheApp/morphe-patches",
      "branch": "main",
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
      "repo": "heval99/morphe-patches",
      "branch": "main",
      "apkmirror_path": "sofascore/soccer-scores-and-sports-livescore-sofascore"
    },
    "tv.twitch.android.app": {
      "name": "twitch",
      "repo": "RookieEnough/De-Vanced",
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
    "com.finalwire.aida64": {
      "name": "aida64",
      "repo": "rushiranpise/morphe-patches",
      "branch": "main",
      "apkmirror_path": "finalwire-ltd/aida64",
      "pin_patch_tag": "v1.18.3"
    },
    "com.getmimo": {
      "name": "mimo",
      "repo": "hoo-dles/morphe-patches",
      "branch": "main",
      "apkmirror_path": "mimohello-gmbh/mimo-learn-to-code"
    }
  },
  "cli": {
    "repo": "MorpheApp/morphe-desktop",
    "branch": "main"
  }
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

Runs daily at 05:15 UTC automatically. The `check-versions` job drops apps whose release already exists — only apps with a new patch or APK version get rebuilt.

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
| AIDA64 | `^aida64` |
| Mimo | `^mimo` |

---

## Common issues

- **`Chosen APK has no classes.dex`** — split/config APK picked. The post-merge step handles XAPK/APKM/APKS bundles via APKEditor, so bundles should resolve to a patched base APK automatically.
- **`[pkg] could not determine version`** — `morphe-desktop list-versions` found no compatible APK for the app's patch. Verify `patch_repos[*].repo` publishes a `.mpp` for your package.
- **`Wrong version of key store`** — verify `KEYSTORE_BASE64` decodes to the correct keystore, `KEYSTORE_PASSWORD` is right, and `KEY_PASSWORD` is set only if it differs.
- **Arm64-v8a APK arrives with armeabi-v7a libs only** — upstream bundle is mislabeled. Use `pin_version` to lock to a known-good APK version.
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