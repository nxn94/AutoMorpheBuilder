# Security Policy

## Supported versions

Only the latest commit on the default branch (`dev`) of this repository receives security fixes. Older tags, forks, and stale branches are not maintained.

## Reporting a vulnerability

**Please do not file a public GitHub issue for security problems.** Public disclosure before a fix is available makes it trivial for an attacker to target users of patched builds.

Report privately via GitHub's private vulnerability reporting:

**https://github.com/nxn94/AutoMorpheBuilder/security/advisories/new**

Include:

- A clear description of the vulnerability and its impact.
- Reproduction steps, including any workflow run URLs that show the issue.
- The affected app (`patch_repos[*].appId`), if known.
- Any relevant redacted logs (strip `KEYSTORE_PASSWORD`, `KEY_PASSWORD`, and `KEYSTORE_BASE64` — see "Sanitising logs" below).

You should receive an acknowledgement within 7 days. We aim to ship a fix or documented mitigation before any public disclosure.

## Signing keys and secrets

This pipeline signs patched APKs with **your** keystore (`KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`). Treat them as high-value secrets:

- **Never** paste a real `KEYSTORE_BASE64` value into an issue, PR, or workflow log. If you need to share a sample, base64-encode an empty/dummy keystore.
- **Never** reuse your production keystore for testing. Generate a throwaway BKS/PKCS12 keystore per experiment.
- **Never** commit keystore files. The repository's `.gitignore` blocks `*.jks`, `*.keystore`, `*.p12`, `*.pfx`, `*.pem`, `*.b64`, and `morphe.jks*` for this reason — keep it that way.
- **Rotate** your keystore if you suspect it has leaked (a leaked keystore lets an attacker sign malicious APKs that your device will trust).
- The release step runs as `contents: write` because it creates / deletes GitHub Releases — this is the **only** step with write permission. The `check-versions` and `build` jobs are read-only.

## Sanitising logs

Before pasting workflow logs anywhere public (issues, PRs, discussions, chat):

1. Search for `KEYSTORE_PASSWORD`, `KEY_PASSWORD`, `KEYSTORE_BASE64`, `KEY_ALIAS` — replace with `<redacted>`.
2. Strip `Authorization:`, `Bearer `, and any GitHub token prefixes.
3. Truncate `gh release ...` output if it includes the release tarball URL with an embedded token.
4. If a log contains an APKMirror session cookie, replace it with `<cookie redacted>`.

The build matrix runs in `pull_request_target`-free workflows (`morphe-build.yml` is `workflow_dispatch` + `schedule` only, `ci.yml` is `pull_request` + `push` to `main`) so a malicious PR cannot exfiltrate secrets via the build graph.

## Out of scope

The following are not security issues for this repository:

- Crashes in `morphe-desktop`, `morphe-patcher`, or upstream Morphe patches. File those at https://github.com/MorpheApp/morphe-patches or https://github.com/MorpheApp/morphe-desktop.
- Anti-piracy / DRM bypass on third-party apps. This pipeline modifies apps you already own; the patches repo is responsible for what those patches do.
- APKMirror rate-limiting or 403s. Those are upstream operational issues.
- Build failures covered in `docs/troubleshooting.md`.

## Attribution

We follow coordinated disclosure. Reporters who file a valid advisory will be credited in the fix commit (unless they prefer anonymity).
