'use strict';

// A mockListing over the buffer makes execFileSync throw ENOBUFS, as Node does.
const mockListing = `AndroidManifest.xml\nclasses.dex\nlib/arm64-v8a/a.so\n${`res/${'x'.repeat(96)}\n`.repeat(20000)}`;

jest.mock('node:child_process', () => ({
  ...jest.requireActual('node:child_process'),
  execFileSync: jest.fn((_cmd, _args, options = {}) => {
    if (mockListing.length > (options.maxBuffer ?? 1024 * 1024)) throw Object.assign(new Error('ENOBUFS'), { code: 'ENOBUFS' });
    return mockListing;
  }),
}));

const { detectApkShape, apkHasDex, apkHasNativeLibsForArch, listApkAbis } = require('../apk-selection');

test('reads archive listings larger than the default buffer', () => {
  expect(mockListing.length).toBeGreaterThan(1024 * 1024);
  expect(detectApkShape('/fixture.apk')).toBe('apk');
  expect(apkHasDex('/fixture.apk')).toBe(true);
  expect(apkHasNativeLibsForArch('/fixture.apk', 'arm64-v8a')).toBe(true);
  expect(listApkAbis('/fixture.apk')).toEqual(['arm64-v8a']);
});
