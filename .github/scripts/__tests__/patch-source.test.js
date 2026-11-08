'use strict';
const {
  parsePatchSource, isGitHubSource, gitlabProjectId, gitlabPackagesUrl, gitlabPackageFilesUrl,
  gitlabDownloadUrl, packageVersion, selectGitlabPackage, selectGitlabMppFile, gitlabBundle,
  resolveGitlabBundle,
} = require('../patch-source');
const { run } = require('../patch-source-runtime');

// Shapes below are trimmed copies of real gitlab.com/api/v4 responses for
// johninnld/nl-morphe-patches (see the PR body for the captured requests).
const SHA = '478fa865b7f000f8a7a528bfbfa09c3affc7fea71b6b163fe514f8695be007ce';
const source = parsePatchSource('gitlab:johninnld/nl-morphe-patches');
const packages = [
  { id: 75766452, name: 'morphe-patches', version: '1.55.0', package_type: 'generic', status: 'default', created_at: '2026-11-08T16:01:36.609Z' },
  { id: 75765241, name: 'morphe-patches', version: '1.54.0', package_type: 'generic', status: 'default', created_at: '2026-11-08T15:32:28.536Z' },
  { id: 75753398, name: 'morphe-patches', version: '1.53.10-dev.1', package_type: 'generic', status: 'default', created_at: '2026-11-08T09:49:20.035Z' },
];
const files = [
  { id: 386844507, package_id: 75765241, created_at: '2026-11-08T15:32:28.578Z', file_name: 'patches-1.54.0.mpp', size: 33196609, file_md5: null, file_sha1: null, file_sha256: SHA },
];

describe('parsePatchSource', () => {
  test('a bare slug stays GitHub, so every existing config entry is untouched', () => {
    expect(parsePatchSource('MorpheApp/morphe-patches')).toEqual({
      host: 'github', repo: 'MorpheApp/morphe-patches', projectPath: 'MorpheApp/morphe-patches',
    });
    expect(isGitHubSource('rushiranpise/morphe-patches')).toBe(true);
  });
  test('a gitlab: prefix selects gitlab.com', () => {
    expect(source).toEqual({ host: 'gitlab', repo: 'gitlab:johninnld/nl-morphe-patches', projectPath: 'johninnld/nl-morphe-patches' });
    expect(isGitHubSource('gitlab:johninnld/nl-morphe-patches')).toBe(false);
  });
  test.each([
    ['gitlab:group/sub/project', /subgroup/i],
    ['gitlab:owner', /project path/i],
    ['gitlab:', /project path/i],
    ['codeberg:owner/repo', /Unsupported patch source host "codeberg"/],
    ['https://gitlab.com/johninnld/nl-morphe-patches', /Unsupported patch source host/],
    ['owner', /owner\/repo/],
    ['', /non-empty/],
    [undefined, /non-empty/],
  ])('%s is rejected with an actionable message, never half-supported', (repo, pattern) => {
    expect(() => parsePatchSource(repo)).toThrow(pattern);
  });
});

describe('GitLab URL construction', () => {
  test('the project path is URL-encoded as GitLab requires', () => {
    expect(gitlabProjectId(source)).toBe('johninnld%2Fnl-morphe-patches');
    expect(gitlabPackagesUrl(source)).toBe(
      'https://gitlab.com/api/v4/projects/johninnld%2Fnl-morphe-patches/packages'
      + '?package_type=generic&per_page=100&order_by=created_at&sort=desc');
    expect(gitlabPackageFilesUrl(source, 75765241)).toBe(
      'https://gitlab.com/api/v4/projects/johninnld%2Fnl-morphe-patches/packages/75765241/package_files?per_page=100');
    expect(gitlabDownloadUrl(source, 'morphe-patches', '1.54.0', 'patches-1.54.0.mpp')).toBe(
      'https://gitlab.com/api/v4/projects/johninnld%2Fnl-morphe-patches/packages/generic/morphe-patches/1.54.0/patches-1.54.0.mpp');
  });
  test('the per-tag raw file route encodes both the path and the ref', () => {
    const { gitlabRawFileUrl } = require('../patch-source');
    expect(gitlabRawFileUrl(source, 'v1.54.0', 'patches-list.json')).toBe(
      'https://gitlab.com/api/v4/projects/johninnld%2Fnl-morphe-patches/repository/files/patches-list.json/raw?ref=v1.54.0');
    expect(gitlabRawFileUrl(source, 'release/1.0', 'dir/list.json')).toBe(
      'https://gitlab.com/api/v4/projects/johninnld%2Fnl-morphe-patches/repository/files/dir%2Flist.json/raw?ref=release%2F1.0');
    expect(() => gitlabRawFileUrl(source, '', 'patches-list.json')).toThrow(/require a ref/);
  });
  test('a non-integer package id cannot reach the URL', () => {
    expect(() => gitlabPackageFilesUrl(source, '1 OR 1')).toThrow(/integer/);
  });
  test('v-prefixed and bare tags address the same package version', () => {
    expect(packageVersion('v1.54.0')).toBe('1.54.0');
    expect(packageVersion('1.54.0')).toBe('1.54.0');
  });
});

describe('selectGitlabPackage', () => {
  test('main prefers the newest stable version; a non-main branch prefers a pre-release', () => {
    expect(selectGitlabPackage(packages, { branch: 'main' }).version).toBe('1.55.0');
    expect(selectGitlabPackage(packages, { branch: 'dev' }).version).toBe('1.53.10-dev.1');
  });
  test('server ordering is not trusted; created_at decides', () => {
    expect(selectGitlabPackage([...packages].reverse(), { branch: 'main' }).version).toBe('1.55.0');
  });
  test('a channel with no match falls back to the newest of any kind rather than failing the build', () => {
    expect(selectGitlabPackage(packages.slice(0, 2), { branch: 'dev' }).version).toBe('1.55.0');
  });
  test('an explicit tag matches exactly and never slides to another version', () => {
    expect(selectGitlabPackage(packages, { tag: 'v1.54.0' }).id).toBe(75765241);
    expect(() => selectGitlabPackage(packages, { tag: 'v1.54' })).toThrow(/version 1\.54 /);
    expect(() => selectGitlabPackage(packages, { tag: 'v99.0.0' })).toThrow(/No GitLab generic package with version 99\.0\.0/);
  });
  test.each([
    [[], /No generic packages published/],
    [[{ id: 1, name: 'x', version: '1.0.0', package_type: 'maven', status: 'default' }], /No generic packages published/],
    [[{ id: 1, name: 'x', version: '1.0.0', package_type: 'generic', status: 'pending_destruction' }], /No generic packages published/],
    [null, /Malformed GitLab packages response/],
  ])('unusable package listings fail closed', (input, pattern) => {
    expect(() => selectGitlabPackage(input, {})).toThrow(pattern);
  });
});

describe('selectGitlabMppFile — the integrity gate', () => {
  test('the registry SHA-256 is taken from the file row', () => {
    expect(selectGitlabMppFile(files).file_sha256).toBe(SHA);
  });
  test('a re-uploaded file name resolves to the newest row, which is what the endpoint serves', () => {
    const older = { ...files[0], id: 1, created_at: '2026-11-01T00:00:00.000Z', file_sha256: 'a'.repeat(64) };
    expect(selectGitlabMppFile([files[0], older]).id).toBe(386844507);
    expect(selectGitlabMppFile([older, files[0]]).id).toBe(386844507);
  });
  test.each([
    [[{ file_name: 'README.md', file_sha256: SHA }], /publishes no patches-\*\.mpp file/],
    [[], /publishes no patches-\*\.mpp file/],
    [[files[0], { ...files[0], file_name: 'patches-1.54.1.mpp' }], /exactly one patches-\*\.mpp file name/],
    [[{ ...files[0], file_sha256: null }], /no SHA-256/],
    [[{ ...files[0], file_sha256: '' }], /no SHA-256/],
    [[{ ...files[0], file_sha256: 'deadbeef' }], /no SHA-256/],
    [[{ ...files[0], file_sha256: SHA.toUpperCase() }], /no SHA-256/],
    [null, /Malformed GitLab package_files response/],
  ])('an unverifiable bundle is refused rather than trusted', (input, pattern) => {
    expect(() => selectGitlabMppFile(input)).toThrow(pattern);
  });
  test('md5/sha1 being null is irrelevant — only file_sha256 counts', () => {
    expect(selectGitlabMppFile([{ ...files[0], file_md5: null, file_sha1: null }]).file_sha256).toBe(SHA);
  });
});

describe('gitlabBundle', () => {
  test('is shaped like the GitHub release object the metadata resolver already consumes', () => {
    expect(gitlabBundle(source, packages[1], files[0])).toEqual({
      tag_name: 'v1.54.0',
      assets: [{
        name: 'patches-1.54.0.mpp',
        url: 'https://gitlab.com/api/v4/projects/johninnld%2Fnl-morphe-patches/packages/generic/morphe-patches/1.54.0/patches-1.54.0.mpp',
        browser_download_url: 'https://gitlab.com/api/v4/projects/johninnld%2Fnl-morphe-patches/packages/generic/morphe-patches/1.54.0/patches-1.54.0.mpp',
        digest: `sha256:${SHA}`,
        size: 33196609,
      }],
    });
  });
});

function registry({ pkgs = packages, pkgFiles = files } = {}) {
  return jest.fn(async (url) => {
    if (url.endsWith('sort=desc')) return pkgs;
    if (url.includes('/package_files')) return pkgFiles;
    throw new Error(`unexpected request ${url}`);
  });
}

describe('resolveGitlabBundle', () => {
  test('two requests: the package listing, then its files', async () => {
    const request = registry();
    await expect(resolveGitlabBundle(source, { tag: 'v1.54.0', request })).resolves.toMatchObject({ tag_name: 'v1.54.0' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0]).toContain('/packages/75765241/package_files');
  });
  test('without a tag the resolved tag comes back for the caller to record', async () => {
    await expect(resolveGitlabBundle(source, { request: registry() })).resolves.toMatchObject({ tag_name: 'v1.55.0' });
  });
  test('a missing request function is a programming error, not a silent skip', async () => {
    await expect(resolveGitlabBundle(source, {})).rejects.toThrow(/request function/);
  });
});

describe('patch-source-runtime CLI', () => {
  test('host reports the forge for both source kinds', async () => {
    const out = jest.fn();
    await run(['host', 'MorpheApp/morphe-patches'], { out });
    await run(['host', 'gitlab:johninnld/nl-morphe-patches'], { out });
    expect(out.mock.calls.flat()).toEqual(['github', 'gitlab']);
  });
  test('tag and mpp emit shell-parsable output', async () => {
    const out = jest.fn();
    const requestImpl = registry();
    await run(['tag', source.repo, 'main'], { requestImpl, out });
    await run(['mpp', source.repo, 'v1.54.0'], { requestImpl, out });
    expect(out.mock.calls[0][0]).toBe('v1.55.0');
    expect(out.mock.calls[1][0].split('\t')).toEqual([
      'patches-1.54.0.mpp',
      'https://gitlab.com/api/v4/projects/johninnld%2Fnl-morphe-patches/packages/generic/morphe-patches/1.54.0/patches-1.54.0.mpp',
      SHA,
    ]);
  });
  test.each([
    [['tag', 'MorpheApp/morphe-patches'], /only for non-GitHub sources/],
    [['mpp', source.repo], /mpp requires a tag/],
    [['bogus', source.repo], /Unknown patch-source command/],
  ])('misuse fails loudly', async (argv, pattern) => {
    await expect(run(argv, { requestImpl: registry(), out: () => {} })).rejects.toThrow(pattern);
  });
});
