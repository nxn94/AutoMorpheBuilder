'use strict';

const {
  buildReleasePageUrl,
  apkmirrorReleaseTailCandidates,
  apkMirrorAuthHeader,
} = require('../url');

describe('download/url', () => {
  describe('buildReleasePageUrl', () => {
    test('constructs correct URL with slug prefix', () => {
      expect(buildReleasePageUrl('google-inc/youtube', '20.44.38')).toBe(
        'https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-44-38-release/',
      );
    });

    test('handles double-digit major versions', () => {
      expect(buildReleasePageUrl('company/app', '26.07.27')).toBe(
        'https://www.apkmirror.com/apk/company/app/app-26-07-27-release/',
      );
    });

    test('derives slug from the last path component', () => {
      // a deeper apkmirrorPath still ends up with the trailing
      // component as the slug prefix the route expects.
      expect(buildReleasePageUrl('a/b/c/long-name', '1.0.0')).toBe(
        'https://www.apkmirror.com/apk/a/b/c/long-name/long-name-1-0-0-release/',
      );
    });
  });

  describe('apkmirrorReleaseTailCandidates', () => {
    test('puts the exact dashed-version tail first, then rc/beta/alpha fallbacks', () => {
      expect(apkmirrorReleaseTailCandidates('2.0.2')).toEqual([
        '-2-0-2-release/',
        '-2-0-2-rc0-release/',
        '-2-0-2-rc1-release/',
        '-2-0-2-rc2-release/',
        '-2-0-2-rc3-release/',
        '-2-0-2-rc4-release/',
        '-2-0-2-rc5-release/',
        '-2-0-2-rc6-release/',
        '-2-0-2-rc7-release/',
        '-2-0-2-rc8-release/',
        '-2-0-2-rc9-release/',
        '-2-0-2-beta-release/',
        '-2-0-2-beta1-release/',
        '-2-0-2-alpha-release/',
        '-2-0-2-alpha1-release/',
      ]);
    });

    test('handles a double-digit major version like sofascore 26.07.27', () => {
      const tails = apkmirrorReleaseTailCandidates('26.07.27');
      expect(tails[0]).toBe('-26-07-27-release/');
      expect(tails).toContain('-26-07-27-rc0-release/');
      expect(tails).toContain('-26-07-27-alpha1-release/');
    });

    test('every rc tier from rc0 through rc9 is present', () => {
      const tails = apkmirrorReleaseTailCandidates('1.0.0');
      for (let i = 0; i <= 9; i += 1) {
        expect(tails).toContain(`-1-0-0-rc${i}-release/`);
      }
    });
  });

  describe('apkMirrorAuthHeader', () => {
    test('throws when APKMIRROR_API_USER is missing', () => {
      expect(() => apkMirrorAuthHeader({
        APKMIRROR_API_PASS: 'pass',
      })).toThrow(/APKMIRROR_API_USER and\/or APKMIRROR_API_PASS are not set/);
    });

    test('throws when APKMIRROR_API_PASS is missing', () => {
      expect(() => apkMirrorAuthHeader({
        APKMIRROR_API_USER: 'user',
      })).toThrow(/APKMIRROR_API_USER and\/or APKMIRROR_API_PASS are not set/);
    });

    test('throws when both are missing', () => {
      expect(() => apkMirrorAuthHeader({})).toThrow(/APKMIRROR_API_USER and\/or APKMIRROR_API_PASS are not set/);
    });

    test('returns a Basic auth header with base64-encoded user:pass', () => {
      const header = apkMirrorAuthHeader({
        APKMIRROR_API_USER: 'alice',
        APKMIRROR_API_PASS: 's3cret',
      });
      // 'alice:s3cret' base64 = 'YWxpY2U6czNjcmV0'
      expect(header).toBe('Basic YWxpY2U6czNjcmV0');
    });

    test('accepts colon-containing passwords without mangling', () => {
      const header = apkMirrorAuthHeader({
        APKMIRROR_API_USER: 'u',
        APKMIRROR_API_PASS: 'p:p',
      });
      // 'u:p:p' base64 = 'dTpwOnA='
      expect(header).toBe('Basic dTpwOnA=');
    });
  });
});
