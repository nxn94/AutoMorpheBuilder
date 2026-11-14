'use strict';

const { downloadReasons, patchFailureAnnotation, parseDownloaderOutput, wrongBuildAnnotation, wrongBuildFromStderr } = require('../failure-reasons');

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

describe('Wrong build annotation', () => {
  const message = 'Wrong build: every download of com.facebook.katana 586.0.0.52.53 was for older Android (API 28+); the patches need API 30+. Patch the arm64-v8a (Android 11+) build of com.facebook.katana instead.';

  test("the downloader's failure JSON on stdout becomes its own ::error:: line", () => {
    const parsed = parseDownloaderOutput(JSON.stringify({ success: false, error: message }));
    expect(parsed).toEqual({ ok: false, error: message });
    expect(wrongBuildAnnotation(parsed.error)).toBe(`::error title=Wrong build::${message}`);
  });

  test('other errors, and no output at all, give no such annotation', () => {
    expect(wrongBuildAnnotation('All sources failed')).toBeNull();
    expect(wrongBuildAnnotation(parseDownloaderOutput('').error)).toBeNull();
    expect(wrongBuildAnnotation(undefined)).toBeNull();
  });

  test('escapes characters that would break the annotation', () => {
    expect(wrongBuildAnnotation('Wrong build: 100%\nnext')).toBe('::error title=Wrong build::Wrong build: 100%25%0Anext');
  });

  test('parseDownloaderOutput reads success and garbage', () => {
    expect(parseDownloaderOutput('{"success":true,"path":"x"}')).toEqual({ ok: true, result: { success: true, path: 'x' } });
    expect(parseDownloaderOutput('not json').error).toMatch(/could not parse/);
  });
});

describe('Wrong build rebuilt from the downloader log (it was killed before printing its error)', () => {
  const info = { appId: 'com.facebook.katana', version: '586.0.0.52.53', arch: 'arm64-v8a' };
  const stderr = [
    '[download] Trying cache for com.facebook.katana v586.0.0.52.53',
    '[min-sdk] url-cache: build is for Android API 28+, the patches need API 30+',
    '[min-sdk] apkeep: build is for Android API 26+, the patches need API 30+',
    '[apkeep] Attempting download',
  ].join('\n');

  test('names the highest rejected API and the floor', () => {
    expect(wrongBuildFromStderr(stderr, info)).toBe('Wrong build: every download of com.facebook.katana 586.0.0.52.53 was for older Android (API 28+); '
      + 'the patches need API 30+. Patch the arm64-v8a (Android 11+) build of com.facebook.katana instead.');
    expect(wrongBuildAnnotation(wrongBuildFromStderr(stderr, info))).toMatch(/^::error title=Wrong build::Wrong build:/);
  });

  test('null when nothing was rejected', () => {
    expect(wrongBuildFromStderr('[min-sdk] apkeep: minimum Android unknown; keeping the file', info)).toBeNull();
    expect(wrongBuildFromStderr('', info)).toBeNull();
    expect(wrongBuildFromStderr(undefined, info)).toBeNull();
  });
});
