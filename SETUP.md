# Setup Guide

**Quick setup** for signed Morphe builds with Obtainium-ready releases.

🌟 **Forking this repo and customizing it for your own needs is encouraged!** Feel free to modify the workflow, add more apps, or adjust patches.

---

## 🔐 Step 1: Create Signing Keystore

```bash
keytool -genkey -v -keystore morphe.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias Key \
  -dname "CN=Your Name, O=Your Org, L=City, ST=State, C=US"
```

> ⚠️ **IMPORTANT**: Keep this file safe! **Do not commit it.**

---

## 📤 Step 2: Base64 Encode Keystore

### Linux/macOS
```bash
base64 -w 0 morphe.jks > morphe.jks.b64
cat morphe.jks.b64
```

### Windows PowerShell
```powershell
[Convert]::ToBase64String([System.IO.File]::ReadAllBytes("morphe.jks"))
```

Copy the output - you'll need it for GitHub Secrets.

---

## 🔑 Step 3: Add GitHub Actions Secrets

**Path:** Repository → Settings → Secrets and variables → Actions

| Secret | Required | Description |
|--------|----------|-------------|
| `KEYSTORE_BASE64` | ✅ Yes | Paste your base64 from Step 2 |
| `KEYSTORE_PASSWORD` | ✅ Yes | Your keystore password |
| `KEY_ALIAS` | ❌ No | Optional: specific alias (defaults to first) |
| `KEY_PASSWORD` | ❌ No | Optional: if key password ≠ keystore password |
| `APKMIRROR_API_USER` | ❌ No | Optional: APKMirror-API username |
| `APKMIRROR_API_PASS` | ❌ No | Optional: APKMirror-API password |

> 💡 **Pro Tip**: APKMirror-API credentials make APK resolution **much faster** (avoids slow Playwright fallback).

> ⚠️ **Warning**: Signed builds are **enforced**. Missing required secrets = build fails.

---

## ⚙️ Step 4: Configure `config.json`

Edit `config.json` with your build options:

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
    }
  },
  "cli": {
    "repo": "MorpheApp/morphe-desktop",
    "branch": "main"
  }
}
```

> 📝 **Note**: Sofascore uses `heval99/morphe-patches` (community patches) instead of the upstream `MorpheApp/morphe-patches` repo. The `apkmirror_path` slug is the package's *index* page — the slug resolver at `/all-versions/` will pick up the current 2025+ slug (`sofascore-live-sports-scores`) automatically. You can omit the `com.sofascore.results` entry if you don't want to build Sofascore.

### Configuration Options

| Field | Default | Description |
|-------|---------|-------------|
| `preferred_arch` | `arm64-v8a` | CPU architecture to prefer |
| `auto_update_urls` | `true` | Auto-update download URLs after builds |
| `patch_repos[*].name` | - | App identifier (e.g., `youtube`) |
| `patch_repos[*].repo` | - | Patch repository |
| `patch_repos[*].branch` | - | Patch branch |
| `patch_repos[*].apkmirror_path` | - | APKMirror URL slug |
| `patch_repos[*].pin_version` | - | Optional: lock to specific version |
| `cli.repo` | - | morphe-desktop repository |
| `cli.branch` | - | morphe-desktop branch (`main` or `dev`) |

> 📝 **Note**: `download_urls` is auto-managed - don't set it manually.

---

## 🎛️ Step 5: Configure `patches.json`

First, run the `update-patches.yml` workflow to populate the file, then edit it:

```json
{
  "MorpheApp/morphe-patches": {
    "com.google.android.youtube": {
      "Hide ads": true,
      "SponsorBlock": true,
      "Return YouTube Dislike": false
    },
    "com.google.android.apps.youtube.music": {
      "Hide music video ads": true
    },
    "com.reddit.frontpage": {
      "Hide ads": true
    }
  }
}
```

### How It Works

- ✅ `true` = **enable** patch
- ❌ `false` = **disable** patch
- 🔄 Workflow **auto-adds** new upstream patches (default: `true`)
- 💾 Your existing `true`/`false` values are **never overwritten**
- 📋 Build logs show which patches were enabled/disabled per app

---

## ▶️ Step 6: Run the Workflow

### Manual Trigger
1. Go to **Actions** tab
2. Select **Build Morphe-patched apps**
3. Click **Run workflow**

### Automatic Schedule
- Runs daily at **05:15 UTC**
- Only builds when Morphe patch or CLI versions changed

---

## 📥 Step 7: Download Outputs

### GitHub Releases (Recommended)
Each app gets its own release:

| App | Release Name | APK File |
|-----|--------------|----------|
| YouTube | `youtube v<base>-<patches>` | `youtube-v20.44.38-v1.24.0-dev.8.apk` |
| YouTube Music | `ytmusic v<base>-<patches>` | `ytmusic-v8.44.54-v1.24.0-dev.8.apk` |
| Reddit | `reddit v<base>-<patches>` | `reddit-v2025.02.17-v1.24.0-dev.8.apk` |
| Sofascore | `sofascore v<base>-<patches>` | `sofascore-v26.07.27-v1.0.0.apk` |

### GitHub Actions Artifacts
Same files available as workflow artifacts.

---

## 📱 Step 8: Add to Obtainium

Create **one entry per app** (same repo, different filters per app).

### For Each App:

1. **Source**: Select `GitHub`
2. **Repository URL**: `https://github.com/<your-user>/<your-repo>`
3. **Release Tag Filter** (regex):
   - YouTube: `^youtube`
   - YouTube Music: `^ytmusic`
   - Reddit: `^reddit`
   - Sofascore: `^sofascore`

---

## 📥 APK Download Flow (Advanced)

The workflow uses a multi-source fallback chain:

1. **Pre-downloaded APKs** - from `check-versions` job output in `tools/`
2. **URL cache** - `~/.cache/auto-morphe-builder/urls/` for previously resolved URLs
3. **config.json URLs** - version-specific URLs saved by workflow
4. **Parallel resolution** - tries these simultaneously:
   - apkeep (APKPure)
   - APKMirror API (if credentials set)
   - APKMirror scraper (curl → Chromium slug fallback)

**APKMirror Scraper Details:**
- Navigates: release page → variant page → download page
- Uses same browser session to preserve cookies
- Slug resolution uses `/all-versions/` to fetch the *current* slug (the `apkmirror_path` in `config.json` is the package's index page, not the release page). When curl hits Cloudflare's HTTP 403 on that page, the scraper falls back to a Chromium browser for the slug scrape only; the rest of the flow stays on curl. Sofascore's `apkmirror_path` is the deprecated `soccer-scores-and-sports-livescore-sofascore` slug but the current 2025+ slug is `sofascore-live-sports-scores` — the slug resolver captures this drift automatically.

**Split packages (XAPK/APKM/APKS):** The downloader hardcodes the saved filename to `${packageId}_${version}.apk` regardless of the URL path, so a downloaded XAPK bundle arrives as `.apk` on disk. The downloader and the post-merge step both use content-based shape detection (`detectApkShape`) to recognise these as bundles: aapt validation is skipped on the outer zip-of-zips and the inner `base.apk` is validated by the post-merge verifier, and the merge step picks up the right file regardless of extension. Sofascore's arm64-v8a variant from APKPure is a XAPK bundle (57MB with `config.arm64_v8a.apk` inside) — this path lets the 57MB arm64-v8a variant win instead of the 93MB universal.

---

## 🎯 APK Selection (Advanced)

| Criteria | Priority |
|----------|----------|
| Architecture | `preferred_arch` from config (default: `arm64-v8a`) |
| DPI | `nodpi` → `120-640dpi` → `480-640dpi` → `120-480dpi` → `240-480dpi` (APKMirror only — apkeep takes whatever APKPure serves) |
| APK Type | `APK` preferred over `BUNDLE` for same arch/DPI |
| Split Packages | APKEditor merge → dex-bearing APK extraction |
| Validation | **Rejects** dex-less APKs (requires `classes*.dex`) |

---

## ❌ Common Issues & Fixes

### ❌ APK download fails / `No APK could be downloaded`
**Check:**
- [ ] `apkmirror_path` values in `config.json` are correct
- [ ] Retry workflow (Cloudflare blocks are often transient)
- [ ] Consider adding APKMirror-API credentials
- [ ] In `check-versions` → `Pre-download APKs (parallel)` logs, look for `[pkg] could not determine version` — this means `morphe-desktop list-versions` returned no matching version for the per-app `.mpp`. Verify the patch repo at `patch_repos[*].repo` actually publishes a `.mpp` for your app

### ❌ `Chosen APK has no classes.dex`
**Solution:**
- The selected file is a split config APK, not the base APK
- Check APKMirror manually to confirm an APK variant exists
- The scraper uses priority list but some releases only have BUNDLE variants — the post-merge step in `download-supported-apk.js` invokes APKEditor when the file is a bundle, so the build needs APKEditor installed and on the runner image (the `morphe` GitHub Actions setup handles this)

### ❌ Sofascore builds download `armeabi-v7a`-only libs
- The APKPure arm64-v8a variant is a 57MB XAPK bundle. The downloader picks it by size; the post-merge step merges `base.apk` with `config.arm64_v8a.apk` to produce a real arm64-v8a APK. If your build is shipping the 93MB universal variant instead, the upstream bundle is mislabeled — try `pin_version` to lock to a known-good version

### ❌ `Wrong version of key store`
**Verify:**
1. `KEYSTORE_BASE64` decodes to your **actual** keystore file
2. `KEYSTORE_PASSWORD` is **correct**
3. `KEY_PASSWORD` is set if key password **differs** from keystore password

---

## ✅ Setup Checklist

- [ ] Created signing keystore
- [ ] Base64 encoded keystore
- [ ] Added GitHub Secrets (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`)
- [ ] Configured `config.json`
- [ ] Ran `update-patches.yml` workflow
- [ ] Configured `patches.json`
- [ ] Ran first build manually
- [ ] Verified releases created
- [ ] Set up Obtainium entries

---

## 📚 Learn More

- [README.md](README.md) - Full project documentation
- [Morphe patches](https://github.com/MorpheApp/morphe-patches)
- [morphe-desktop](https://github.com/MorpheApp/morphe-desktop)
