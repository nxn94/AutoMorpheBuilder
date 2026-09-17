'use strict';

const { mergeRepoEntries, pruneInactiveRepos } = require('../../../scripts/merge-patches');

describe('mergeRepoEntries', () => {
  test('legacy case: app already under targetRepo, user toggles preserved', () => {
    const defaults = {
      'com.example.app': { Foo: true, Bar: true },
    };
    const base = {
      'owner/repo': {
        'com.example.app': { Foo: false, Bar: true },
      },
    };
    const merged = mergeRepoEntries({ defaultsForTargetRepo: defaults, baseAllRepos: base, targetRepo: 'owner/repo' });
    expect(merged).toEqual({
      'com.example.app': { Foo: false, Bar: true },
    });
  });

  test('relocated app: toggles migrate from old repo to target repo', () => {
    // Classic sofascore case. Defaults for the destination repo include
    // both sofascore (newly assigned) and mimo (long-time resident).
    // sofascore's existing toggles live under the OLD repo and would be
    // lost if we only looked at base[targetRepo].
    const defaults = {
      'com.getmimo': { 'Enable Pro': true, 'Disable telemetry': true },
      'com.sofascore.results': {
        'Disable ads': true,
        'Disable telemetry': true,
        'Hide ads': true,
      },
    };
    const base = {
      'hoo-dles/morphe-patches': {
        'com.getmimo': { 'Enable Pro': true },
      },
      'heval99/morphe-patches': {
        'com.sofascore.results': {
          'Disable ads': true,
          'Disable telemetry': false, // user opted OUT — must survive the move
          'Hide ads': true,
        },
      },
    };
    const merged = mergeRepoEntries({
      defaultsForTargetRepo: defaults,
      baseAllRepos: base,
      targetRepo: 'hoo-dles/morphe-patches',
    });
    expect(merged).toEqual({
      'com.getmimo': { 'Enable Pro': true, 'Disable telemetry': true },
      'com.sofascore.results': {
        'Disable ads': true,
        'Disable telemetry': false, // preserved across the repo move
        'Hide ads': true,
      },
    });
  });

  test('upstream introduces a new patch name: defaults to true even if user set others to false', () => {
    const defaults = {
      'com.example.app': { ExistingPatch: true, NewUpstreamPatch: true },
    };
    const base = {
      'owner/repo': {
        'com.example.app': { ExistingPatch: false },
      },
    };
    const merged = mergeRepoEntries({
      defaultsForTargetRepo: defaults,
      baseAllRepos: base,
      targetRepo: 'owner/repo',
    });
    expect(merged).toEqual({
      'com.example.app': { ExistingPatch: false, NewUpstreamPatch: true },
    });
  });

  test('user removed a patch upstream (no longer in defaults): dropped from merged', () => {
    // Stale keys are dropped — the merged section is only the upstream
    // patch set; existing user toggles for vanished patches are
    // deliberately discarded.
    const defaults = {
      'com.example.app': { KeptPatch: true },
    };
    const base = {
      'owner/repo': {
        'com.example.app': { KeptPatch: true, RemovedPatch: false },
      },
    };
    const merged = mergeRepoEntries({
      defaultsForTargetRepo: defaults,
      baseAllRepos: base,
      targetRepo: 'owner/repo',
    });
    expect(merged).toEqual({
      'com.example.app': { KeptPatch: true },
    });
  });

  test('app in defaults but absent from both own and old sections: all default true', () => {
    const defaults = {
      'com.example.app': { Foo: true, Bar: true },
    };
    const base = {
      'owner/repo': {},
    };
    const merged = mergeRepoEntries({
      defaultsForTargetRepo: defaults,
      baseAllRepos: base,
      targetRepo: 'owner/repo',
    });
    expect(merged).toEqual({
      'com.example.app': { Foo: true, Bar: true },
    });
  });

  test('app present under target AND under an old repo: target wins', () => {
    const defaults = {
      'com.example.app': { Foo: true },
    };
    const base = {
      'owner/repo': { 'com.example.app': { Foo: false } },
      'old/repo': { 'com.example.app': { Foo: true } }, // stale duplicate
    };
    const merged = mergeRepoEntries({
      defaultsForTargetRepo: defaults,
      baseAllRepos: base,
      targetRepo: 'owner/repo',
    });
    expect(merged).toEqual({
      'com.example.app': { Foo: false },
    });
  });

  test('multiple apps: each looked up independently across repos', () => {
    const defaults = {
      'com.a': { A1: true },
      'com.b': { B1: true },
      'com.c': { C1: true },
    };
    const base = {
      'dest/repo': { 'com.a': { A1: false } },
      'src/repo': { 'com.b': { B1: false } },
    };
    const merged = mergeRepoEntries({
      defaultsForTargetRepo: defaults,
      baseAllRepos: base,
      targetRepo: 'dest/repo',
    });
    expect(merged).toEqual({
      'com.a': { A1: false }, // own lookup
      'com.b': { B1: false }, // migrated
      'com.c': { C1: true },  // fresh default
    });
  });

  test('empty defaults returns empty merged section (no apps for this repo)', () => {
    expect(mergeRepoEntries({ defaultsForTargetRepo: {}, baseAllRepos: {}, targetRepo: 'any/repo' })).toEqual({});
  });

  test('non-object ownSection (corrupt patches.json) does not crash', () => {
    const defaults = { 'com.a': { A: true } };
    const base = { 'owner/repo': 'not-an-object' };
    const merged = mergeRepoEntries({
      defaultsForTargetRepo: defaults,
      baseAllRepos: base,
      targetRepo: 'owner/repo',
    });
    expect(merged).toEqual({ 'com.a': { A: true } });
  });
});

describe('pruneInactiveRepos', () => {
  test('drops repo keys not in activeRepos', () => {
    const patches = {
      'a/r': { 'com.x': {} },
      'b/r': { 'com.y': {} },
      'c/r': { 'com.z': {} },
    };
    const out = pruneInactiveRepos(patches, new Set(['a/r', 'c/r']));
    expect(Object.keys(out)).toEqual(['a/r', 'c/r']);
  });

  test('accepts an array of active repos', () => {
    const patches = { 'a/r': {}, 'b/r': {} };
    expect(Object.keys(pruneInactiveRepos(patches, ['a/r']))).toEqual(['a/r']);
  });

  test('empty activeRepos drops everything', () => {
    const patches = { 'a/r': {}, 'b/r': {} };
    expect(pruneInactiveRepos(patches, new Set())).toEqual({});
  });
});
