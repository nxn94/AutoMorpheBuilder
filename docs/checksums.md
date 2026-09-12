# Tool checksums

`checksums/tools.sha256` records SHA-256 digests of downloaded tools. The CI workflow verifies each downloaded tool against its expected hash and fails closed on mismatch.

## Source of truth: GitHub release API

The verify step in `download_morphe_tools.sh` and `fetch_morphe_tools.sh` treats the **per-asset digest served by the GitHub release API** as the authoritative hash for each run. `gh release view <tag> --json assets` returns each asset's `digest` field (`sha256:HEX`), and `gh_asset_sha256 <repo> <tag> <asset-name>` in `lib/github.sh` extracts that hex.

This means a new CLI release does **not** require editing the manifest to keep the build green: the API digest we just fetched is what we compare the local bytes against.

## Role of `checksums/tools.sha256`

The pinned values in the manifest are a **tripwire, not the primary gate**:

1. **Local bytes must match the API digest** — this is the tamper / corruption gate. If they disagree, the build fails closed: someone republished the asset, the download was corrupted in transit, or `--pattern` matched the wrong file.
2. **Pin must agree with the API digest *for the same CLI tag*** — when the pin row carries a `# vX.Y.Z` annotation, the verify scripts compare the running CLI tag to the pin's annotation before treating a SHA disagreement as a tamper signal. If the pin is for a *different* CLI release, the mismatch is a normal version bump and the build continues with a `TODO(refresh-pin-…)` log line. If the pin is for the *same* CLI tag and the SHA still disagrees, that is a republish attack and the build fails closed.
3. **Pin row has no parseable `# vX.Y.Z` comment and SHA disagrees with API** — fail closed. Better to over-warn than to silently accept a malformed manifest.
4. **No pin → accept the API digest but emit a `TODO(refresh-pin-…)` marker** in the CI log. The build proceeds; a maintainer can refresh the pin before the next bump makes the drift harder to spot.

## Updating a checksum

1. Trigger a fresh build with `actions: write` permission.
2. The pinned row already in `checksums/tools.sha256` (if any) is only one of the two things being compared; the more useful line is `SHA-256 verified against upstream API digest (….)`, which is what actually matched the local bytes.
3. If the upstream version bumped, the API digest printed in the prior step is your new pin target. Replace the line **and** the `# vX.Y.Z` annotation on the same row so the tripwire stays active. The version annotation lets the verify scripts distinguish a normal CLI bump from a same-tag republish attack. A stale pin whose annotation no longer matches the running CLI tag is logged as a `TODO(refresh-pin-…)` instead of failing the build — but the next run with the same tag will fail closed if the asset is tampered with, so refresh promptly.

### Example: bumping `morphe-desktop.jar` from v1.15.0 → v1.15.1

Before:
```
727e3744aa5c0006474590de6f4041bd55edc59f3d6cb9b596e95f7116384506  morphe-desktop.jar  # v1.15.0
```

After (one-line edit, both SHA and `# vX.Y.Z` annotation refresh together):
```
6ae9954cd4e22e61055cf9ef6b0bbd25556d2092f354031828f824dc0f7364e1  morphe-desktop.jar  # v1.15.1
```

The verify scripts in `download_morphe_tools.sh` and `fetch_morphe_tools.sh` extract the version annotation via the `tools_sha_pinned_version` helper in `.github/scripts/pipeline/lib/checksums.sh`; if the helper returns empty (no annotation, malformed row), disagreement still fails closed so a damaged manifest cannot silently disable the tripwire.

## Empty or TODO entries

Some entries may be TODO (`# TODO(pin-aapt2)` etc.) when the value couldn't be computed at PR-creation time, or when the upstream doesn't publish a sibling hash:

- `morphe-desktop.jar`: `download_morphe_tools.sh` and `fetch_morphe_tools.sh` always fall back to the `META-INF/MANIFEST.MF` `Implementation-Version` tag check. With a real SHA in the manifest, the JAR is also verified against the digest.
- `APKEditor.jar`: same fallback as `morphe-desktop.jar`. SHA-256 verification is opt-in via `checksums/tools.sha256`.
- Per-repo `*.mpp` files: `fetch_morphe_tools.sh` resolves the per-asset digest from the GitHub release API and verifies the on-disk bytes against it on every run. A stale cache entry (e.g. one left over from before fd537df removed `restore-keys: morphe-patches-<slug>-`) fails the SHA check and the script re-downloads the correct `.mpp` and re-verifies before letting the build continue. The script falls back to "download if missing, no SHA check" only when the release API itself is unreachable. SHA changes per release tag, so per-tag pinning in `checksums/<slug>-<tag>.sha256` is not currently used.
- `aapt2` (Android build-tools): SHA changes per SDK release. Pin via the specific SDK version (`build-tools;35.0.0`) + a commit that introduces it. `install_aapt.sh` prints the actual SHA at the end of each install with a `TODO(pin-aapt2)` note.
- `chromium-linux.zip`: SHA changes per Playwright/Chromium release. `install_playwright.sh` prints the actual SHA at the end of each install with a `TODO(pin-chromium)` note.

## Certificate fingerprint (not used)

The previous build flow pinned the signed APK's signing certificate via `EXPECTED_CERT_SHA256` (a repo variable), comparing `apksigner verify --print-certs` SHA-256 against the expected value in `sign_apk.sh`. That code path was removed when `sign_apk.sh` was deleted in favour of morphe-desktop's `patch --keystore` (which patches and signs in one step and does not expose the signed APK to a separate verify step). Pinning is not currently re-implemented — if you need it, post-process the signed APK with `apksigner verify --print-certs` in the `create-release` job and compare against a repo variable.

To extract the fingerprint of an existing keystore (still useful for documentation / rotation audits):

```bash
keytool -list -v -keystore <path-to-keystore.p12> -storetype PKCS12 \
  -storepass "$KEYSTORE_PASSWORD" \
  | grep -A1 'SHA256:' \
  | tail -n1 \
  | tr -d ' :'
```

## Per-release integrity

`create_release.sh` writes a `SHA256SUMS` file next to each release's APKs. Each line is `sha256  <apk-name>`; the file is verified with `sha256sum --check SHA256SUMS` before being uploaded alongside the APK assets. Downstream consumers (Obtainium, etc.) can `sha256sum --check` against the same file to confirm the APK they downloaded matches the one the workflow built.

## Files in this directory

- `tools.sha256` — single global manifest of tool digests consulted by the install / fetch scripts.
- (Future) `morphe-desktop-<version>.sha256` — per-CLI-version digest, useful when the JAR hash drifts between patch-tag runs.