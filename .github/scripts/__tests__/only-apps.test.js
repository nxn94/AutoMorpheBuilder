'use strict';

const { parseOnlyApps, selectApps } = require('../only-apps');

const matrix = [
  { name: 'reddit', appId: 'com.reddit.frontpage' },
  { name: 'maps', appId: 'com.google.android.apps.maps' },
  { name: 'gboard', appId: 'com.google.android.inputmethod.latin' },
];

test('accepts commas or spaces, any case', () => {
  expect(parseOnlyApps(' Maps, reddit  x ')).toEqual(['maps', 'reddit', 'x']);
});

test('selects by name or package id and skips the rest', () => {
  const selection = selectApps(matrix, 'REDDIT,com.google.android.apps.maps');
  expect(selection.matrix.map((e) => e.name)).toEqual(['reddit', 'maps']);
  expect(selection.skipList).toEqual(['com.google.android.inputmethod.latin']);
  expect(selection.unknown).toEqual([]);
});

test('reports unknown names', () => {
  const selection = selectApps(matrix, 'maps,nope');
  expect(selection.unknown).toEqual(['nope']);
});

test.each(['', ' , ', undefined])('nothing selected for %j', (value) => {
  expect(selectApps(matrix, value)).toBeNull();
});
