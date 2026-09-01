# Contributing

Thanks for using AutoMorpheBuilder. This document covers how to file issues, send pull requests, and validate changes locally.

## Code of conduct

Be respectful. Assume good faith. Disagree on the merits. Personal attacks, slurs, harassment, and doxxing are not tolerated.

## Filing issues

Use the issue templates in `.github/ISSUE_TEMPLATE/`. Blank issues are disabled (see `config.yml`).

For **security problems**, follow `SECURITY.md` — do **not** open a public issue.

## Adding a new app

This is a config-only change:

1. Add an entry to `config.json` `patch_repos` with `name`, `repo`, `branch`, and `apkmirror_path` (URL slug).
2. (Optional) Set `pin_version` to lock the build to a specific APK version, or `pin_patch_tag` to lock the patches release.
3. Trigger `.github/workflows/update-patches.yml` manually to populate `patches.json` from the upstream repo.
4. Edit `patches.json` to enable/disable specific patches.
5. Push — the next scheduled or manual build picks up the app via the dynamic matrix.

No `morphe-build.yml` edits are needed; the matrix is derived from `config.json`. See `docs/configuration.md` for field semantics.

## Commit messages — Conventional Commits

Every commit message **must** follow the [Conventional Commits](https://www.conventionalcommits.org/) spec:

```
<type>(<scope>): <short description>

<optional body>

<optional footer>
```

Allowed types:

| Type | Use for |
|------|---------|
| `feat` | New user-visible capability (new app support, new download source, new workflow job). |
| `fix` | Bug fix that restores intended behaviour. |
| `docs` | Documentation-only changes (README, `docs/`, inline YAML comments). |
| `chore` | Tooling, CI plumbing, dependency updates, repo maintenance. No production-code behaviour change. |
| `refactor` | Internal restructure with no user-visible behaviour change. |
| `test` | Test-only changes (Jest fixtures, test helpers). |
| `perf` | Performance improvement with no behaviour change. |
| `build` | Build-system or packaging change. |
| `ci` | CI workflow change that is not user-visible. |
| `revert` | Reverts a prior commit (include the reverted SHA in the footer). |

Scope (the `(scope)` part) is encouraged but not required. Prefer a short noun describing the area: `download`, `workflow`, `signing`, `patches`, `docs`, `lint`.

Subject line rules:

- Imperative mood ("add", not "added"). Lower-case first word.
- No trailing period.
- ≤72 characters total (`<type>(<scope>): <subject>`).
- Body (optional) wraps at 72 columns and explains *why*, not *what*.

Examples:

```
feat(download): add APKPure protobuf size-ordered variant picker
fix(patches): avoid race when multiple apps share patches.mpp
docs(readme): correct license to GPL-3.0
chore(workflows): remove stale comments pointing at AGENTS.md
```

## Pull requests

PRs go to the `dev` branch. `main` only receives fast-forward merges from `dev`.

Before opening a PR, complete the **Validation** section below and tick every box that applies. Use `.github/pull_request_template.md` — it lists the same checks.

A PR is mergeable when:

- `npm ci` succeeds on a clean clone.
- `npm test` passes (all green; skipped tests are not acceptable for new code).
- `npm run lint` passes.
- The PR title matches Conventional Commits.
- Each commit in the PR matches Conventional Commits (rebase or squash before requesting review if not).
- The diff contains no `console.log` debug output, no commented-out code, no secrets.
- Workflow YAML changes pass `actionlint` (`docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .`).
- Shell changes pass `shellcheck` (`shellcheck .github/scripts/pipeline/*.sh .github/scripts/pipeline/lib/*.sh`).

## Development requirements

- **Node.js ≥ 24** (matches `engines.node` in `package.json` and the GitHub Actions runner). Older versions are not supported.
- **Java 21** (Temurin) on the PATH for morphe-desktop. The workflow installs this via `actions/setup-java@v5`.
- **`zip`** is required for `apk-selection.test.js` and `apk-abi-validator.test.js` to exercise their fixtures. Install via `sudo apt-get install -y zip` (Ubuntu) or `brew install zip` (macOS). Without it, those tests are skipped (not a hard fail, but flagged).
- **Docker** (optional) for `actionlint` if you do not want to install the binary.

## Validation

Run from the repository root:

```bash
# Install dependencies
npm ci

# Unit tests (Jest)
npm test

# Lint JS (flat-config ESLint, scoped to .github/scripts/)
npm run lint

# Lint YAML workflows (pick one)
docker run --rm -v $(pwd):/repo ghcr.io/rhysd/actionlint:latest -color .
actionlint .github/workflows/morphe-build.yml

# Lint shell pipeline
shellcheck .github/scripts/pipeline/*.sh .github/scripts/pipeline/lib/*.sh

# Validate JSON
jq '.' patches.json && jq '.' config.json

# Validate a workflow YAML
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/morphe-build.yml'))" && echo "YAML is valid"
```

A "fully green" PR shows no skipped tests, no lint warnings, no `actionlint` findings, and no `shellcheck` findings.

## Repo rules

- **No unsigned APKs.** The build hard-fails on signing errors — do not add an `--unsigned` flag or env-gated skip path.
- **No force-pushes to `dev` or `main`.** Squash or rebase locally before pushing.
- **No secrets in the tree.** The `.gitignore` blocks `*.jks`, `*.keystore`, `*.p12`, `*.pfx`, `*.pem`, `*.b64`, `morphe.jks*`. Do not weaken it.
- **No workflow `uses:` downgrades.** All `actions/*` references pin to a major version (`@v4` / `@v5` / `@v6` / `@v7` / `@v8`). Dependabot updates them via `.github/dependabot.yml`; do not hand-edit.
- **No silent skips.** If a check might fail on an upstream change, surface it as `::error::` or `::warning::`, not as a swallowed exception.
- **`patches.json` toggles are user data.** The `update-patches.yml` workflow preserves existing toggles on sync. Do not mass-reset them.

## License

By contributing, you agree that your contributions are licensed under the GPL-3.0 (see `LICENSE`).
