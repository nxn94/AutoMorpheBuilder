'use strict';

const { apkeditorMergeArgs } = require('../merge-args');

describe('download/merge-args', () => {
  test('builds the APKEditor merge argv', () => {
    expect(apkeditorMergeArgs('tools/APKEditor.jar', 'apps/bundle.apk', 'apps/merged.apk'))
      .toEqual([
        '-jar', 'tools/APKEditor.jar',
        'm',
        '-i', 'apps/bundle.apk',
        '-o', 'apps/merged.apk',
      ]);
  });

  // Regression: -clean-meta deletes the bundle's META-INF, which patches
  // that read the original APK's metadata need. SigningDataPatch
  // (AliExpress) and BypassSignatureCheckPatch (iiec) both abort when it
  // is missing. morphe-desktop's signer replaces the v1 signature files,
  // so keeping the directory ships nothing stale.
  test('does not strip META-INF from the input bundle', () => {
    const args = apkeditorMergeArgs('j.jar', 'in.apk', 'out.apk');
    expect(args).not.toContain('-clean-meta');
  });

  test('passes paths as separate argv entries, never shell-quoted', () => {
    const args = apkeditorMergeArgs('a b.jar', 'in put.apk', 'out put.apk');
    expect(args[1]).toBe('a b.jar');
    expect(args[4]).toBe('in put.apk');
    expect(args[6]).toBe('out put.apk');
    expect(args.join(' ')).not.toContain('"');
  });
});
