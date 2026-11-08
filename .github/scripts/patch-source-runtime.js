#!/usr/bin/env node
'use strict';

/**
 * Thin CLI over `patch-source.js` for the shell pipeline. Keeps the GitLab
 * lookup in one tested place instead of duplicating curl + jq across
 * `resolve-tag.sh`, `download_morphe_tools.sh` and `fetch_morphe_tools.sh`.
 *
 *   node patch-source-runtime.js host <repo>
 *       -> "github" | "gitlab"
 *   node patch-source-runtime.js tag <repo> [branch]
 *       -> the resolved patches tag (e.g. v1.54.0)
 *   node patch-source-runtime.js mpp <repo> <tag>
 *       -> "<file-name>\t<url>\t<sha256>" for the digest-verified bundle
 *
 * Every command exits non-zero with a single-line reason on failure; nothing
 * here can emit an unverified bundle.
 */

const { parsePatchSource, resolveGitlabBundle } = require('./patch-source');

async function request(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Patch source lookups require credential-free HTTPS');
  }
  const headers = process.env.GITLAB_TOKEN && parsed.hostname === 'gitlab.com'
    ? { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN } : {};
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000), headers });
    if (response.ok) return response.json();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 2) throw new Error(`HTTP ${response.status} from ${parsed.hostname}${parsed.pathname}`);
    await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
  }
}

async function run(argv, { requestImpl = request, out = console.log } = {}) {
  const [mode, repo, arg] = argv;
  const source = parsePatchSource(repo);
  if (mode === 'host') return out(source.host);
  if (source.host !== 'gitlab') throw new Error(`patch-source-runtime ${mode} is only for non-GitHub sources; ${repo} is on GitHub`);
  if (mode === 'tag') {
    const bundle = await resolveGitlabBundle(source, { branch: arg || 'main', request: requestImpl });
    return out(bundle.tag_name);
  }
  if (mode === 'mpp') {
    if (!arg) throw new Error('mpp requires a tag');
    const [asset] = (await resolveGitlabBundle(source, { tag: arg, request: requestImpl })).assets;
    return out(`${asset.name}\t${asset.url}\t${asset.digest.slice(7)}`);
  }
  throw new Error(`Unknown patch-source command "${mode}"`);
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { run };
