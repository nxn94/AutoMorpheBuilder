// .github/scripts/__tests__/preflight-apps.test.js
'use strict';

const {
  preflight,
  compatPkgNames,
  collectPkgIds,
  renderTable,
} = require('../preflight-apps');

// --- test fixtures --------------------------------------------------------

/**
 * Build a fetch stub keyed by URL substring. Each entry is a promise
 * that resolves to `{ok, json}`. URLs not matching any key return 404.
 */
function makeStub(responses) {
  return async (url) => {
    for (const [substring, response] of Object.entries(responses)) {
      if (url.includes(substring)) {
        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
          json: async () => response.body,
        };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => null,
    };
  };
}

const mimoConfig = (overrides = {}) => ({
  patch_repos: {
    'com.getmimo': {
      name: 'mimo',
      repo: 'hoo-dles/morphe-patches',
      branch: 'main',
      apkmirror_path: 'mimohello-gmbh/mimo-learn-to-code',
      ...overrides,
    },
  },
  cli: { repo: 'MorpheApp/morphe-desktop', branch: 'main' },
});

const mimoRepoVersions = { 'hoo-dles/morphe-patches': 'v9.11' };

// patches-list.json payload matching what hoo-dles/morphe-patches ships.
const mimoPatchesList = {
  patches: [
    {
      name: 'Enable Pro',
      compatiblePackages: [
        { name: 'Mimo', packageName: 'com.getmimo' },
      ],
    },
    {
      name: 'Spoof signature',
      compatiblePackages: [
        { name: 'Mimo', packageName: 'com.getmimo' },
      ],
    },
  ],
};

// --- compatPkgNames -------------------------------------------------------

describe('compatPkgNames — historical shapes', () => {
  test('object form (old key-indexed)', () => {
    expect(
      compatPkgNames({ compatiblePackages: { 'com.getmimo': {}, 'com.example': {} } }),
    ).toEqual(['com.getmimo', 'com.example']);
    expect(
      compatPkgNames({ compatible_packages: { 'com.getmimo': {} } }),
    ).toEqual(['com.getmimo']);
  });

  test('array form (current) returns both name and packageName', () => {
    expect(
      compatPkgNames({
        compatiblePackages: [{ name: 'YouTube', packageName: 'com.google.android.youtube' }],
      }),
    ).toEqual(['YouTube', 'com.google.android.youtube']);
    expect(
      compatPkgNames({
        compatible_packages: [{ name: 'YT Music', packageName: 'com.google.android.apps.youtube.music' }],
      }),
    ).toEqual(['YT Music', 'com.google.android.apps.youtube.music']);
  });

  test('missing or empty → empty array', () => {
    expect(compatPkgNames({})).toEqual([]);
    expect(compatPkgNames(null)).toEqual([]);
    expect(compatPkgNames({ compatiblePackages: [] })).toEqual([]);
    expect(compatPkgNames({ compatiblePackages: {} })).toEqual([]);
  });
});

// --- collectPkgIds --------------------------------------------------------

describe('collectPkgIds', () => {
  test('aggregates across all patches (object form)', () => {
    const list = {
      patches: [
        { name: 'A', compatiblePackages: { 'com.x': {}, 'com.y': {} } },
        { name: 'B', compatible_packages: { 'com.y': {}, 'com.z': {} } },
      ],
    };
    expect([...collectPkgIds(list)].sort()).toEqual(['com.x', 'com.y', 'com.z']);
  });

  test('aggregates across all patches (array form)', () => {
    const list = {
      patches: [
        { name: 'A', compatiblePackages: [{ name: 'YT', packageName: 'com.google.android.youtube' }] },
        { name: 'B', compatiblePackages: [{ packageName: 'com.getmimo' }] },
      ],
    };
    expect([...collectPkgIds(list)].sort()).toEqual([
      'YT', 'com.getmimo', 'com.google.android.youtube',
    ]);
  });

  test('accepts a bare array', () => {
    expect(
      [...collectPkgIds([
        { name: 'A', compatiblePackages: { 'com.x': {} } },
      ])],
    ).toEqual(['com.x']);
  });
});

// --- renderTable ----------------------------------------------------------

describe('renderTable', () => {
  test('empty rows', () => {
    expect(renderTable([])).toBe('_(no apps configured)_');
  });

  test('happy rows render green check columns', () => {
    const md = renderTable([
      { appId: 'com.getmimo', name: 'mimo', repo: 'hoo-dles/morphe-patches', tag: 'v9.11', pkgListed: 'yes', fetchOk: 'yes', error: null },
    ]);
    expect(md).toContain('| app | name | repo | pkg listed | upstream fetch |');
    expect(md).toContain('| com.getmimo | mimo | hoo-dles/morphe-patches@v9.11 | yes | yes |');
  });

  test('errors surface inline + escape pipes', () => {
    const md = renderTable([
      { appId: 'com.x', name: 'x', repo: 'a/b', tag: 'v1', pkgListed: 'NO', fetchOk: 'NO', error: 'oops | bad' },
    ]);
    expect(md).toContain('NO');
    expect(md).toContain('oops \\| bad');
  });
});

// --- preflight (integration) ---------------------------------------------

describe('preflight', () => {
  test('mimo with package present in patches-list.json → row ok, no errors', async () => {
    const fetchImpl = makeStub({
      '/hoo-dles/morphe-patches/v9.11/patches-list.json': { status: 200, body: mimoPatchesList },
    });
    const result = await preflight({ config: mimoConfig(), repoVersions: mimoRepoVersions, fetchImpl });
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      appId: 'com.getmimo', pkgListed: 'yes', fetchOk: 'yes', error: undefined,
    });
  });

  test('package id missing from patches-list.json → row shows NO + error', async () => {
    const fetchImpl = makeStub({
      '/hoo-dles/morphe-patches/v9.11/patches-list.json': { status: 200, body: { patches: [] } },
    });
    const result = await preflight({ config: mimoConfig(), repoVersions: mimoRepoVersions, fetchImpl });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].appId).toBe('com.getmimo');
    expect(result.errors[0].message).toMatch(/not listed/);
    expect(result.rows[0].pkgListed).toBe('NO');
  });

  test('404 from upstream → error names the repo + tag', async () => {
    // default 404 stub from makeStub with no matching keys
    const fetchImpl = makeStub({});
    const result = await preflight({ config: mimoConfig(), repoVersions: mimoRepoVersions, fetchImpl });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/hoo-dles\/morphe-patches@v9.11/);
    expect(result.errors[0].message).toMatch(/HTTP 404/);
    expect(result.rows[0]).toMatchObject({ pkgListed: '?', fetchOk: 'NO' });
  });

  test('typo in repo slug: mimoConfig({repo:"hoodles/morphe-patches"}) still maps to the same upstream call, but if upstream returns 404 the error names the slug the user typed', async () => {
    const fetchImpl = makeStub({});
    const result = await preflight({
      config: mimoConfig({ repo: 'hoodles/morphe-patches' }),
      repoVersions: { 'hoodles/morphe-patches': 'v9.11' },
      fetchImpl,
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/hoodles\/morphe-patches@v9.11/);
  });

  test('pin_patch_tag overrides the resolved tag for the per-app row', async () => {
    const fetchImpl = makeStub({
      '/hoo-dles/morphe-patches/v1.18.3/patches-list.json': { status: 200, body: mimoPatchesList },
    });
    const config = mimoConfig({ pin_patch_tag: 'v1.18.3' });
    // repoVersions still has v9.11, but the per-app row should use v1.18.3.
    const result = await preflight({
      config, repoVersions: mimoRepoVersions, fetchImpl,
    });
    expect(result.errors).toEqual([]);
    expect(result.rows[0].tag).toBe('v1.18.3');
  });

  test('two apps sharing one repo trigger exactly one upstream fetch', async () => {
    let fetchCount = 0;
    const fetchImpl = async (url) => {
      fetchCount++;
      if (url.includes('/hoo-dles/morphe-patches/v9.11/patches-list.json')) {
        return { ok: true, status: 200, json: async () => ({
          patches: [
            { name: 'Enable Pro', compatiblePackages: [{ name: 'Mimo', packageName: 'com.getmimo' }] },
          ],
        }) };
      }
      return { ok: false, status: 404, json: async () => null };
    };
    const config = {
      patch_repos: {
        'com.getmimo': { name: 'mimo', repo: 'hoo-dles/morphe-patches', branch: 'main', apkmirror_path: 'x/y' },
        // com.example.mimo2 is the same package family but maps to a
        // different *package id*, also supposed to be supported by
        // the same repo.
        'com.example.mimo2': { name: 'mimo2', repo: 'hoo-dles/morphe-patches', branch: 'main', apkmirror_path: 'x/y' },
      },
      cli: { repo: 'a/b', branch: 'main' },
    };
    const result = await preflight({ config, repoVersions: mimoRepoVersions, fetchImpl });
    expect(fetchCount).toBe(1);
    expect(result.rows).toHaveLength(2);
    // mimo2 isn't in the test patches-list, so it errors.
    expect(result.errors.map((e) => e.appId).sort()).toEqual(['com.example.mimo2']);
  });

  test('missing repoVersions entry → error names the repo', async () => {
    const fetchImpl = makeStub({});
    const result = await preflight({ config: mimoConfig(), repoVersions: {}, fetchImpl });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/No resolved tag for hoo-dles\/morphe-patches/);
  });

  test('missing patch_repos → top-level error, no rows', async () => {
    const result = await preflight({
      config: { cli: { repo: 'a/b', branch: 'main' } },
      repoVersions: {}, fetchImpl: makeStub({}),
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].appId).toBeNull();
    expect(result.rows).toEqual([]);
  });
});