'use strict';

const { detectChanges } = require('../../../scripts/detect-new-repos');

// Minimal config builders keep each test readable.
function configOf(reposByPackage) {
  const patch_repos = {};
  for (const [pkg, repoSpec] of Object.entries(reposByPackage)) {
    patch_repos[pkg] = {
      name: pkg.split('.').pop(),
      repo: repoSpec,
      branch: 'main',
      apkmirror_path: 'x/y',
      display_name: pkg,
      ...(repoSpec && typeof repoSpec === 'object' ? repoSpec : {}),
    };
  }
  return { patch_repos };
}

function patchesOf(repoMap) {
  // e.g. patchesOf({ 'MorpheApp/morphe-patches': { 'com.foo': { Foo: true } } })
  return repoMap;
}

describe('detectChanges', () => {
  test('empty patches.json with a config repo flags hasNewRepos', () => {
    const config = configOf({ 'com.example.app': 'new/repo' });
    const patches = patchesOf({});
    const result = detectChanges(config, patches);
    expect(result.hasNewRepos).toBe(true);
    expect(result.hasRelocatedApps).toBe(false);
    expect(result.newRepos).toEqual(['new/repo']);
  });

  test('repo already present in patches.json -> no newRepo, no relocate', () => {
    const config = configOf({ 'com.example.app': 'existing/repo' });
    const patches = patchesOf({ 'existing/repo': { 'com.example.app': { Foo: true } } });
    const result = detectChanges(config, patches);
    expect(result.hasNewRepos).toBe(false);
    expect(result.hasRelocatedApps).toBe(false);
    expect(result.newRepos).toEqual([]);
    expect(result.relocatedApps).toEqual([]);
  });

  test('app relocated between repos -> flags hasRelocatedApps but not hasNewRepos', () => {
    // The classic sofascore case: sofascore lived under heval99 in
    // patches.json but config now points it at hoo-dles (which already
    // exists in patches.json for mimo).
    const config = configOf({
      'com.sofascore.results': 'hoo-dles/morphe-patches',
      'com.getmimo': 'hoo-dles/morphe-patches',
    });
    const patches = patchesOf({
      'heval99/morphe-patches': {
        'com.sofascore.results': { 'Disable telemetry': false },
      },
      'hoo-dles/morphe-patches': {
        'com.getmimo': { 'Enable Pro': true },
      },
    });
    const result = detectChanges(config, patches);
    expect(result.hasNewRepos).toBe(false);
    expect(result.hasRelocatedApps).toBe(true);
    expect(result.relocatedApps).toEqual([
      {
        pkg: 'com.sofascore.results',
        oldRepo: 'heval99/morphe-patches',
        newRepo: 'hoo-dles/morphe-patches',
      },
    ]);
  });

  test('multiple relocations are reported', () => {
    const config = configOf({
      'com.foo': 'dest/r',
      'com.bar': 'dest/r2',
    });
    const patches = patchesOf({
      'old/r': { 'com.foo': { Foo: true } },
      'old/r2': { 'com.bar': { Bar: true } },
      'dest/r': { 'com.foo': { Foo: true } },
      'dest/r2': {},
    });
    const result = detectChanges(config, patches);
    expect(result.hasRelocatedApps).toBe(true);
    expect(result.relocatedApps).toEqual([
      { pkg: 'com.bar', oldRepo: 'old/r2', newRepo: 'dest/r2' },
      { pkg: 'com.foo', oldRepo: 'old/r', newRepo: 'dest/r' },
    ]);
  });

  test('app no longer in config but still in patches.json is NOT flagged (cleanup is sync-patches duty)', () => {
    const config = configOf({ 'com.foo': 'foo/repo' });
    const patches = patchesOf({
      'foo/repo': { 'com.foo': { Foo: true } },
      'orphan/repo': { 'com.removed': { Bar: true } },
    });
    const result = detectChanges(config, patches);
    expect(result.hasNewRepos).toBe(false);
    expect(result.hasRelocatedApps).toBe(false);
  });

  test('new repo AND relocated apps both present -> both flags set', () => {
    const config = configOf({
      'com.brandnew': 'brand/new-repo',
      'com.moved': 'dest/repo',
    });
    const patches = patchesOf({
      'source/repo': { 'com.moved': { Foo: false } },
      'dest/repo': { 'com.unrelated': { Unrelated: true } },
    });
    const result = detectChanges(config, patches);
    expect(result.hasNewRepos).toBe(true);
    expect(result.hasRelocatedApps).toBe(true);
    expect(result.newRepos).toEqual(['brand/new-repo']);
    expect(result.relocatedApps).toEqual([
      { pkg: 'com.moved', oldRepo: 'source/repo', newRepo: 'dest/repo' },
    ]);
  });

  test('config without patch_repos field is handled without crashing', () => {
    const result = detectChanges({}, patchesOf({}));
    expect(result.hasNewRepos).toBe(false);
    expect(result.hasRelocatedApps).toBe(false);
  });

  test('patches.json with a non-object value is skipped', () => {
    const result = detectChanges(
      configOf({ 'com.foo': 'foo/repo' }),
      { 'foo/repo': { 'com.foo': { Foo: true } }, 'broken/repo': 'not-an-object' },
    );
    expect(result.hasNewRepos).toBe(false);
    expect(result.hasRelocatedApps).toBe(false);
  });

  test('relocatedApps is sorted deterministically', () => {
    const config = configOf({
      'com.zeta': 'a/d',
      'com.alpha': 'a/d',
    });
    const patches = patchesOf({
      'b/d': { 'com.zeta': { Zeta: true }, 'com.alpha': { Alpha: true } },
      'a/d': {},
    });
    const result = detectChanges(config, patches);
    expect(result.relocatedApps.map((m) => m.pkg)).toEqual(['com.alpha', 'com.zeta']);
  });
});
