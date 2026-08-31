## Summary

<!-- One-paragraph description of what this PR does and why. -->

## Type of change

<!-- Tick exactly one. Delete the others. -->

- [ ] Bug fix (`fix:`) — non-breaking change that restores intended behaviour
- [ ] New feature (`feat:`) — non-breaking change that adds user-visible capability
- [ ] Breaking change (`feat:` or `fix:` with `!`) — change that requires user action
- [ ] Documentation (`docs:`) — no production-code change
- [ ] Refactor (`refactor:`) — no user-visible behaviour change
- [ ] Chore / tooling (`chore:`) — CI, dependencies, repo maintenance
- [ ] Tests (`test:`) — test-only changes

## Validation

<!-- Tick every box that applies. CI runs npm ci + npm test + npm run lint, but please confirm locally. -->

- [ ] `npm ci` succeeds on a clean clone
- [ ] `npm test` passes (no skipped tests for new code)
- [ ] `npm run lint` passes
- [ ] `jq '.' config.json && jq '.' patches.json` succeeds
- [ ] Workflow YAML changes validated with `actionlint .github/workflows/<file>.yml`
- [ ] Shell changes validated with `shellcheck .github/scripts/pipeline/*.sh .github/scripts/pipeline/lib/*.sh`
- [ ] Python YAML validation: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/<file>.yml'))"`
- [ ] New behaviour covered by a Jest test (if applicable)
- [ ] AGENTS.md and `docs/` updated where the public surface changes

## Security review

<!-- Required for any change touching secrets, signing, or workflow permissions. -->

- [ ] No secrets committed (no `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_PASSWORD`, `KEY_ALIAS`, GitHub tokens, APKMirror creds)
- [ ] No `permissions:` widening in any workflow
- [ ] No new `pull_request_target` trigger and no new use of untrusted input in shell steps
- [ ] No downgrade of pinned `actions/*` versions
- [ ] No new third-party Action that has not been audited
- [ ] For PRs from forks: `pull_request_target` is not used; secrets are not exposed to fork PRs

## Documentation

<!-- Tick what you updated. -->

- [ ] README.md (if user-visible behaviour or badges change)
- [ ] `docs/configuration.md` (if `config.json` shape changes)
- [ ] `docs/architecture.md` (if the workflow graph changes)
- [ ] `docs/release-process.md` (if release tag format, pruning, or pinning changes)
- [ ] `docs/troubleshooting.md` (if a new failure mode is introduced)
- [ ] AGENTS.md (if a new developer command or invariant is introduced)
- [ ] `CONTRIBUTING.md` (if commit message or PR conventions change)

## Additional notes

<!-- Anything reviewers should know: screenshots, before/after log excerpts, follow-up work, related PRs. -->
