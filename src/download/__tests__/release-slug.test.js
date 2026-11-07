'use strict';

const { inferReleaseUrl, releaseNamePrefix } = require('../release-slug');

describe('inferReleaseUrl', () => {
  const li = (v) => `/apk/linkedin/linkedin-linkedin/linkedin-community-network-${v}-release/`;

  test('a version missing from /all-versions/ gets the listed releases\' name (LinkedIn)', () => {
    const hrefs = [li('4-1-1271'), li('4-1-1270-beta'), li('4-1-1269'), li('4-1-1262'), '/apk/linkedin/', '/apk/other/app/x-1-0-release/'];
    expect(inferReleaseUrl(hrefs, 'linkedin/linkedin-linkedin', '4.1.1261'))
      .toBe('https://www.apkmirror.com/apk/linkedin/linkedin-linkedin/linkedin-community-network-4-1-1261-release/');
  });

  test('a name ending in a number splits by the version length', () => {
    const p = 'flightradar24-ab/flightradar24-flight-tracker-2';
    const hrefs = [`/apk/${p}/flightradar24-flight-tracker-2-11-12-0-release/`, `/apk/${p}/flightradar24-flight-tracker-2-11-11-0-release/`];
    expect(inferReleaseUrl(hrefs, p, '11.10.0')).toBe(`https://www.apkmirror.com/apk/${p}/flightradar24-flight-tracker-2-11-10-0-release/`);
  });

  test('the most common name wins, and absolute links count', () => {
    const p = 'sofascore/soccer-scores';
    const hrefs = [
      `https://www.apkmirror.com/apk/${p}/sofascore-live-sports-scores-26-08-18-release/`,
      `/apk/${p}/sofascore-live-sports-scores-26-08-17-release/`,
      `/apk/${p}/soccer-scores-26-08-01-release/`,
    ];
    expect(inferReleaseUrl(hrefs, p, '26.07.27')).toBe(`https://www.apkmirror.com/apk/${p}/sofascore-live-sports-scores-26-07-27-release/`);
  });

  test('accepts canonical same-origin absolute URLs with a default HTTPS port', () => {
    expect(inferReleaseUrl([
      'https://WWW.APKMIRROR.COM:443/apk/linkedin/linkedin-linkedin/linkedin-community-network-4-1-1271-release/',
    ], 'linkedin/linkedin-linkedin', '4.1.1261'))
      .toBe('https://www.apkmirror.com/apk/linkedin/linkedin-linkedin/linkedin-community-network-4-1-1261-release/');
  });

  test.each([
    'https://www.apkmirror.com.evil.example',
    'https://www.apkmirror.com@evil.example',
    'https://evil.example',
    'http://www.apkmirror.com',
    'https://www.apkmirror.com:444',
    'https://user:password@www.apkmirror.com',
  ])('ignores release links from an untrusted origin or credentials: %s', (origin) => {
    expect(inferReleaseUrl([
      `${origin}/apk/linkedin/linkedin-linkedin/linkedin-community-network-4-1-1271-release/`,
    ], 'linkedin/linkedin-linkedin', '4.1.1261')).toBeNull();
  });

  test('nothing usable gives null', () => {
    expect(inferReleaseUrl([], 'a/b', '1.0')).toBeNull();
    expect(inferReleaseUrl(undefined, 'a/b', '1.0')).toBeNull();
    expect(inferReleaseUrl(['/apk/a/b/variant-page/', '/apk/a/b/c-1-0-release/x/'], 'a/b', '1.0')).toBeNull();
    expect(inferReleaseUrl([null, 42, '/apk/a/b/', '/apk/a/b/c-d-release/'], 'a/b', '1.0')).toBeNull();
  });
});

describe('releaseNamePrefix', () => {
  test('splits off a version of the given length', () => {
    expect(releaseNamePrefix('gboard-the-google-keyboard-18-5-11-993608717-release', 4)).toBe('gboard-the-google-keyboard');
  });

  test('ignores a pre-release suffix', () => {
    expect(releaseNamePrefix('sd-maid-2-0-2-rc0-release', 3)).toBe('sd-maid');
  });

  test('no name left, or not a release directory, gives null', () => {
    expect(releaseNamePrefix('x-1-0-release', 3)).toBeNull();
    expect(releaseNamePrefix('linkedin-community-network-4-1-1271', 3)).toBeNull();
    expect(releaseNamePrefix('my-app-name-x-release', 2)).toBeNull();
  });
});
