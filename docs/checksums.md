# Tool checksums

`checksums/tools.sha256` records SHA-256 digests of downloaded tools. The CI workflow verifies each downloaded tool against its expected hash and fails closed on mismatch.

## Updating a checksum

1. Trigger a fresh build with `actions: write` permission, OR run `scripts/download-tool.sh <URL> /tmp/<output> <expected-sha>` locally with a fresh download.
2. Compare the printed `Verified SHA-256 for /tmp/<output>` line against the existing entry in `checksums/tools.sha256`.
3. If the upstream version changed, replace the line and commit.

## Empty or TODO entries

Some entries may be TODO (`# TODO(pin-aapt2)` etc.) when the value couldn't be computed at PR-creation time, or when the upstream doesn't publish a sibling hash:

- `morphe-desktop.jar`: `download_morphe_tools.sh` and `fetch_morphe_tools.sh` always fall back to the `META-INF/MANIFEST.MF` `Implementation-Version` tag check. With a real SHA in the manifest, the JAR is also verified against the digest.
- `APKEditor.jar`: same fallback as `morphe-desktop.jar`. SHA-256 verification is opt-in via `checksums/tools.sha256`.
- Per-repo `*.mpp` files: SHA changes per release tag, so they're not in the global manifest. The existing tag check (which compares `cli-tag` / `patch-tag` env vars against the release tag we asked `gh` to download) handles these.
- `aapt2` (Android build-tools): SHA changes per SDK release. Pin via the specific SDK version (`build-tools;35.0.0`) + a commit that introduces it. `install_aapt.sh` prints the actual SHA at the end of each install with a `TODO(pin-aapt2)` note.
- `chromium-linux.zip`: SHA changes per Playwright/Chromium release. `install_playwright.sh` prints the actual SHA at the end of each install with a `TODO(pin-chromium)` note.

## Certificate fingerprint

`EXPECTED_CERT_SHA256` is a GitHub Actions variable (set in repo settings or environment `apk-signing`) containing the SHA-256 fingerprint of the signing certificate. `patch_apk.sh` compares the actual signing certificate against this value after signing. If unset, the comparison is skipped with a `::warning::` annotation — the build will still pass, but you'll be missing the certificate-pinning guarantee.

To extract the fingerprint of an existing keystore:

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
- (Future) `<repo-slug>-<tag>.sha256` — per-(repo, patch-tag) digest for `.mpp` archives.