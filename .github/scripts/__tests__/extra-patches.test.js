'use strict';

const {
  extraBundlePath, extraBundleRepos, extraPatchArgs, resolveExtraTags,
} = require('../extra-patches');
const { appFingerprint } = require('../build-fingerprint');
const { validateConfig } = require('../validate-config');

const MORPHE = 'MorpheApp/morphe-patches';
const entry = (extra, repo = 'own/a') => ({ name: 'a', repo, branch: 'main', apkmirror_path: 'p/a', ...(extra !== undefined && { extra_patches: extra }) });

describe('extraPatchArgs', () => {
  test('no field gives no arguments', () => {
    expect(extraPatchArgs(entry(), 'own/a', '/t')).toEqual([]);
    expect(extraBundleRepos(entry(), 'own/a')).toEqual([]);
  });

  test('another source adds its bundle before its patches', () => {
    expect(extraPatchArgs(entry({ [MORPHE]: ['One', 'Two'] }), 'own/a', '/t')).toEqual([
      `--patches=${extraBundlePath('/t', MORPHE)}`, '-e', 'One', '-e', 'Two',
    ]);
    expect(extraBundlePath('/t', MORPHE)).toMatch(/^\/t\/extra-[0-9a-f]{64}\.mpp$/);
  });

  test("the app's own repo comes first and joins the main bundle", () => {
    const e = entry({ [MORPHE]: ['One'], 'own/a': ['Mine'] });
    expect(extraPatchArgs(e, 'own/a', '/t')).toEqual([
      '-e', 'Mine', `--patches=${extraBundlePath('/t', MORPHE)}`, '-e', 'One',
    ]);
    expect(extraBundleRepos(e, 'own/a')).toEqual([MORPHE]);
  });
});

describe('resolveExtraTags', () => {
  const config = { patch_repos: {
    'com.a': entry({ [MORPHE]: ['P'] }),
    'com.b': entry({ [MORPHE]: ['P'], 'own/b': ['Q'] }, 'own/b'),
    'com.c': entry(),
  } };

  test('resolves each source once, shared by every app, skipping own repos', () => {
    const lookup = jest.fn(() => 'v9.9.9');
    expect(resolveExtraTags(config, lookup, () => {})).toEqual({
      'com.a': { [MORPHE]: 'v9.9.9' },
      'com.b': { [MORPHE]: 'v9.9.9' },
    });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('a failed lookup warns and leaves the tag out', () => {
    const warn = jest.fn();
    expect(resolveExtraTags(config, () => { throw new Error('HTTP 502\nmore'); }, warn)).toEqual({});
    expect(warn).toHaveBeenCalledWith(`::warning::Could not resolve the latest release of ${MORPHE}: HTTP 502`);
  });
});

describe('fingerprint', () => {
  const build = (e) => appFingerprint({ patch_repos: { 'com.a': e }, cli: {} }, {}, 'com.a', 'v1', 'pipe');

  test('is unchanged for apps without the field', () => {
    expect(build(entry())).toBe(build(entry()));
  });

  test('changes when the setting changes, not with a release of an extra source', () => {
    expect(build(entry({ [MORPHE]: ['P'] }))).not.toBe(build(entry()));
    expect(build(entry({ [MORPHE]: ['P'] }))).not.toBe(build(entry({ [MORPHE]: ['P', 'Q'] })));
    expect(build(entry({ [MORPHE]: ['P'] }))).toBe(build(entry({ [MORPHE]: ['P'] })));
  });
});

describe('validateConfig extra_patches', () => {
  const run = (extra) => validateConfig({
    patch_repos: { 'com.a': entry(extra) }, cli: { repo: 'x/y', branch: 'main' },
  }).filter((i) => i.level === 'error').map((i) => i.message);

  test('accepts GitHub sources with patch names', () => {
    expect(run({ [MORPHE]: ['Disable Play Store updates'] })).toEqual([]);
  });

  test('rejects GitLab sources with a clear message', () => {
    expect(run({ 'gitlab:o/p': ['X'] })[0]).toMatch(/not supported.*GitHub "owner\/repo"/);
  });

  test.each([
    [['X']], [null], [{ 'noslash': ['X'] }], [{ [MORPHE]: [] }], [{ [MORPHE]: 'X' }], [{ [MORPHE]: [''] }],
  ])('rejects malformed %j', (extra) => {
    expect(run(extra).length).toBeGreaterThan(0);
  });
});
