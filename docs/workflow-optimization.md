# Workflow optimization (dev)

What this repo does: GitHub Actions builds, signs and publishes patched Android
APKs. This review assumes one personal repository, a daily build and occasional
manual builds or metadata updates, not a high-throughput build farm.

## Should fix — implemented

1. **Two copies of CI drift together** (`.github/workflows/ci.yml`).
   Ordinary and metadata-follow-up jobs duplicated the whole validation sequence.
   One `test` job now uses `npm run check`, plus the existing shell/workflow lint.
   Event-specific checkout steps preserve the trusted literal main checkout for
   `workflow_run`; no upstream head value is checked out. The old
   `test_workflow_run` job name is removed; any downstream consumer of that name
   must use `test` instead (dev has no branch protection at review time).

2. **The documented shared write lock was missing on the publisher**
   (`morphe-build.yml`, `update-patches.yml`). The updater declared a shared group,
   but `create-release` never joined it. The publisher now joins the same
   non-cancelling group. The expensive build stays outside this lock. GitHub
   concurrency retains at most one running and one pending group member; it is
   not a durable FIFO queue. Keep one-at-a-time manual operations.

## Nice to have — implemented

3. **CI did not explicitly cache npm downloads** (`ci.yml`). Enable setup-node's
   built-in npm cache, never a node_modules cache, and retain `npm ci` lockfile
   installs. CI and build installs omit audit/funding network requests;
   Dependabot security alerts and CodeQL remain enabled.

4. **Pre-downloaded APKs were compressed again** (`morphe-build.yml`). Set artifact
   compression to zero for APK/XAPK/APKM/APKS files, matching signed uploads.
   This avoids zlib work; size and elapsed savings have not been measured.

5. **Updater permissions did not match its own policy comment**
   (`update-patches.yml`). Set the workflow default to contents-read and grant
   contents-write explicitly to the updater job. Its existing token requirements
   and commit/push behavior are unchanged.

## Reviewed and retained

- `codeql.yml`: two distinct language scans, matching pinned init/analyze,
  security-and-quality queries, read-only checkout, job-scoped upload permission,
  timeouts and cancellation of superseded scans. No dependency installation to
  remove. Keep daily scans to detect new queries even without source changes.
- Build: keep no-change filtering, per-app failure isolation, validation of every
  APK, fresh CLI downloads, exact patch cache keys and conditional browser setup.
- Updater: keep the repo-move detection and toggle-preserving merge. README
  regeneration on pushes must still happen even when patch sync is unnecessary.
- No reusable-workflow layer, new action, dependency or runtime script was added.
  Regression tests use the already installed js-yaml package from the locked
  ESLint/Jest toolchain; actionlint checks Actions-specific semantics separately.

Verdict: small orchestration changes, not a pipeline rewrite. No measured
wall-clock speedup is claimed. All four workflow files were reviewed; CodeQL
needed no change.

Not checked: full third-party APK downloads, signing and release publication;
manual build/update dispatches would mutate repository releases or metadata and
were deliberately not run. The default-branch workflow_run listener cannot be
exercised from dev alone. Scheduled runs still use the default branch. Changes
are intentionally restricted to dev; main is not updated.
