'use strict';

const { downloadReasons, patchFailureAnnotation } = require('../failure-reasons');

describe('downloadReasons', () => {
  test('names each source tried and skips unconfigured ones', () => {
    expect(downloadReasons([
      '[apkeep] Failed: APKPure does not have com.x@1 - version not available',
      '[apkmirror-api] Failed: APKMIRROR_API_USER and/or APKMIRROR_API_PASS are not set.',
      '[apkmirror] Failed: APKMirror Cloudflare block (HTTP 403)',
    ].join('\n'))).toEqual(["APKPure doesn't have this version", 'APKMirror blocked the runner (Cloudflare)']);
  });

  test("APKPure's real cause wins over its generic rethrow", () => {
    expect(downloadReasons([
      '[apkeep] Failed: connection reset',
      '[apkeep] Failed: APKPure does not have com.x@1 - version not available',
    ].join('\n'))).toEqual(['APKPure failed (connection reset)']);
  });

  test('empty output gives no reasons', () => expect(downloadReasons('')).toEqual([]));
});

describe('patchFailureAnnotation', () => {
  test('uses the root PatchException and names the failed patches', () => {
    expect(patchFailureAnnotation([
      'SEVERE: ERROR: Failed: Spoof, signature: x',
      'Caused by: a.PatchException: outer',
      'Caused by: b.PatchException: 100% broken',
    ].join('\n'))).toBe('::error title=Patch failed (Spoof signature x)::100%25 broken');
  });

  test('falls back to the aborted line', () => {
    expect(patchFailureAnnotation('x ERROR: Patching aborted: bad input')).toBe('::error title=Patch failed::Patching aborted: bad input');
  });

  test('gives nothing when the log has no reason', () => expect(patchFailureAnnotation('exit 1')).toBeNull());
});
