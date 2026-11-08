'use strict';

/**
 * Patch-source addressing: which forge a `patch_repos[*].repo` value points at,
 * and how its patches bundle is located and verified.
 *
 * A bare `owner/repo` is GitHub, exactly as before. A `gitlab:owner/project`
 * prefix selects gitlab.com. Encoding the forge in the existing `repo` string
 * keeps one identity flowing through `patches.json` keys, `patchSlug`, caches,
 * README tables and `detect-new-repos.js` untouched — only the functions that
 * build URLs parse it.
 *
 * GitLab bundles are resolved through the **generic package registry**, not the
 * Releases API, because that registry is the only gitlab.com endpoint that
 * publishes a per-file SHA-256 (`file_sha256`). GitLab's release API exposes
 * asset links with no digest at all, so a release-driven route could not
 * satisfy the integrity gate that `gh_asset_sha256` provides on GitHub. Every
 * function here fails closed when a digest is missing.
 *
 * Pure except `resolveGitlabBundle`, which takes an injected `request`.
 */

const GITLAB_API = 'https://gitlab.com/api/v4';

/** gitlab.com top-level project path: `owner/project`, no subgroups. */
const GITLAB_PROJECT = /^[A-Za-z0-9_.][A-Za-z0-9_.+-]*\/[A-Za-z0-9_.][A-Za-z0-9_.+-]*$/;
const GITHUB_SLUG = /^[^/\s]+\/[^/\s]+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MPP_FILE = /^patches-.*\.mpp$/;
/** A version with a pre-release part: 1.2.3-dev.4, 1.2.3-rc1, 1.2.3-beta. */
const PRERELEASE = /[-+]/;

/** Forges this builder can verify end to end. */
const SUPPORTED_HOSTS = ['github', 'gitlab'];

/**
 * Parse a `repo` value into `{ host, repo, projectPath }`.
 *
 * Throws with an actionable message for anything unsupported rather than
 * half-supporting it: an unknown `host:` prefix, or a GitLab path with
 * subgroups (`group/sub/project`), whose generic package registry and raw
 * file routes we have not verified.
 */
function parsePatchSource(repo) {
  if (typeof repo !== 'string' || !repo) {
    throw new Error('Patch source must be a non-empty "owner/repo" or "gitlab:owner/project" string');
  }
  const colon = repo.indexOf(':');
  if (colon === -1) {
    if (!GITHUB_SLUG.test(repo)) throw new Error(`Patch source "${repo}" is not an "owner/repo" GitHub slug`);
    return { host: 'github', repo, projectPath: repo };
  }
  const host = repo.slice(0, colon);
  const projectPath = repo.slice(colon + 1);
  if (!SUPPORTED_HOSTS.includes(host)) {
    throw new Error(`Unsupported patch source host "${host}" in "${repo}". Supported: a bare "owner/repo" GitHub slug, or "gitlab:owner/project".`);
  }
  if (host === 'github') {
    if (!GITHUB_SLUG.test(projectPath)) throw new Error(`Patch source "${repo}" is not an "owner/repo" GitHub slug`);
    return { host: 'github', repo, projectPath };
  }
  if (!GITLAB_PROJECT.test(projectPath)) {
    throw new Error(`Patch source "${repo}" is not a supported GitLab project path. AutoMorpheBuilder supports top-level gitlab.com projects ("gitlab:owner/project"); subgroup paths and self-hosted instances are not supported.`);
  }
  return { host: 'gitlab', repo, projectPath };
}

/** True when `repo` addresses something other than GitHub. */
function isGitHubSource(repo) {
  return parsePatchSource(repo).host === 'github';
}

/** `owner%2Fproject` — GitLab's URL-encoded project id. */
function gitlabProjectId(source) {
  return encodeURIComponent(source.projectPath);
}

/**
 * Per-tag raw file, GitLab's equivalent of raw.githubusercontent.com. Both the
 * ref and the file path are URL-encoded (GitLab wants `%2F` inside the path
 * segment). Returns 404 for an absent file, so the resolver's "only 404 means
 * absence" rule carries over unchanged.
 */
function gitlabRawFileUrl(source, ref, filePath) {
  if (!ref) throw new Error('GitLab raw file lookups require a ref');
  return `${GITLAB_API}/projects/${gitlabProjectId(source)}/repository/files/`
    + `${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`;
}

function gitlabPackagesUrl(source) {
  return `${GITLAB_API}/projects/${gitlabProjectId(source)}/packages`
    + '?package_type=generic&per_page=100&order_by=created_at&sort=desc';
}

function gitlabPackageFilesUrl(source, packageId) {
  if (!Number.isSafeInteger(packageId)) throw new Error('GitLab package id must be an integer');
  return `${GITLAB_API}/projects/${gitlabProjectId(source)}/packages/${packageId}/package_files?per_page=100`;
}

function gitlabDownloadUrl(source, packageName, packageVersion, fileName) {
  return `${GITLAB_API}/projects/${gitlabProjectId(source)}/packages/generic/`
    + `${encodeURIComponent(packageName)}/${encodeURIComponent(packageVersion)}/${encodeURIComponent(fileName)}`;
}

/** `v1.54.0` and `1.54.0` both address package version `1.54.0`. */
function packageVersion(tag) {
  return String(tag ?? '').replace(/^v/, '');
}

/** The tag identity we report back for a resolved package version. */
function packageTag(version) {
  return `v${version}`;
}

/**
 * Pick one generic package. With an explicit `tag` the match is exact — a pin
 * never silently slides to another version. Without one, the newest package by
 * `created_at` wins, preferring a stable version on `main` and a pre-release
 * version on any other branch, mirroring `resolve-tag.sh`'s channel choice on
 * GitHub. Falls back to the newest of any kind so a project that only ships
 * one channel still builds.
 */
function selectGitlabPackage(packages, { tag = '', branch = 'main' } = {}) {
  if (!Array.isArray(packages)) throw new Error('Malformed GitLab packages response');
  const generic = packages.filter((p) => p
    && p.package_type === 'generic'
    && (p.status === undefined || p.status === 'default')
    && typeof p.name === 'string' && p.name
    && typeof p.version === 'string' && p.version);
  if (!generic.length) throw new Error('No generic packages published; a GitLab patch source must publish its patches-*.mpp to the generic package registry');
  const newestFirst = [...generic].sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
  if (tag) {
    const wanted = packageVersion(tag);
    const exact = newestFirst.find((p) => p.version === wanted);
    if (!exact) throw new Error(`No GitLab generic package with version ${wanted} (from tag ${tag})`);
    return exact;
  }
  const stable = (p) => !PRERELEASE.test(p.version);
  const preferred = branch === 'main'
    ? newestFirst.find(stable)
    : newestFirst.find((p) => !stable(p));
  return preferred || newestFirst[0];
}

/**
 * Pick the `patches-*.mpp` package file and return its digest.
 *
 * Fails closed on every ambiguity: no matching file, more than one distinct
 * file name, or a missing/malformed `file_sha256`. Re-uploads of the same file
 * name produce several rows; the newest is what the download endpoint serves,
 * so that is the row whose digest we trust.
 */
function selectGitlabMppFile(files) {
  if (!Array.isArray(files)) throw new Error('Malformed GitLab package_files response');
  const matches = files.filter((f) => f && typeof f.file_name === 'string' && MPP_FILE.test(f.file_name));
  if (!matches.length) throw new Error('GitLab package publishes no patches-*.mpp file');
  const names = new Set(matches.map((f) => f.file_name));
  if (names.size !== 1) throw new Error(`Expected exactly one patches-*.mpp file name, got: ${[...names].sort().join(', ')}`);
  const newest = matches.reduce((a, b) => (String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) > 0 ? b : a));
  if (typeof newest.file_sha256 !== 'string' || !SHA256.test(newest.file_sha256)) {
    throw new Error(`GitLab package file ${newest.file_name} has no SHA-256 (file_sha256); refusing an unverifiable patches bundle`);
  }
  return newest;
}

/**
 * Shape a selected package + file as the release object the metadata resolver
 * already consumes, so GitLab joins the existing GitHub flow instead of
 * becoming a second, unrelated code path. `digest` carries the registry's
 * `file_sha256`, which `deriveMetadata`'s `verifiedAsset` enforces verbatim.
 */
function gitlabBundle(source, pkg, file) {
  const url = gitlabDownloadUrl(source, pkg.name, pkg.version, file.file_name);
  return {
    tag_name: packageTag(pkg.version),
    assets: [{
      name: file.file_name,
      url,
      browser_download_url: url,
      digest: `sha256:${file.file_sha256}`,
      size: file.size,
    }],
  };
}

/**
 * Resolve a GitLab patch source to `{ tag_name, assets: [mpp] }`.
 *
 * `request(url)` is the caller's JSON fetcher (the metadata resolver's, in
 * production) so retries, timeouts, the HTTPS/credential gate and request
 * de-duplication are shared rather than reimplemented.
 */
async function resolveGitlabBundle(source, { tag = '', branch = 'main', request }) {
  if (typeof request !== 'function') throw new Error('resolveGitlabBundle requires a request function');
  const pkg = selectGitlabPackage(await request(gitlabPackagesUrl(source)), { tag, branch });
  const file = selectGitlabMppFile(await request(gitlabPackageFilesUrl(source, pkg.id)));
  return gitlabBundle(source, pkg, file);
}

module.exports = {
  GITLAB_API,
  SUPPORTED_HOSTS,
  parsePatchSource,
  isGitHubSource,
  gitlabProjectId,
  gitlabRawFileUrl,
  gitlabPackagesUrl,
  gitlabPackageFilesUrl,
  gitlabDownloadUrl,
  packageVersion,
  packageTag,
  selectGitlabPackage,
  selectGitlabMppFile,
  gitlabBundle,
  resolveGitlabBundle,
};
