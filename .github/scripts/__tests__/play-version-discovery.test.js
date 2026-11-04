'use strict';
jest.mock('../apkmirror-browser', () => ({
  ...jest.requireActual('../apkmirror-browser'),
  openApkmirror: jest.fn(),
  navigateApkmirror: jest.fn(),
}));
const { openApkmirror, navigateApkmirror } = require('../apkmirror-browser');
const { resolveGooglePlayVersionCode } = require('../unified-downloader');
let close;
const releasePath = '/apk/redditinc/reddit/reddit-2026-40-0-release/';
function setup({ arch = 'arm64-v8a', packageId = 'com.reddit.frontpage', version = '2026.40.0' } = {}) {
  close = jest.fn();
  const page = { content: jest.fn()
    .mockResolvedValueOnce(`<a href="${releasePath}">2026.40.0</a>`)
    .mockResolvedValueOnce(`<div class="table-row"><div class="table-cell"><a class="accent_color" href="${releasePath}reddit-2026-40-0-7-android-apk-download/">2640091</a><span>BUNDLE</span></div><div class="table-cell">${arch}</div><div class="table-cell">Android 9+</div><div class="table-cell">nodpi</div></div>`)
    .mockResolvedValueOnce(`<div class="appspec-value">Version: ${version} (2640091)<br>Package: ${packageId}</div>`) };
  openApkmirror.mockResolvedValue({ browser: { close }, page });
}
beforeEach(() => { jest.clearAllMocks(); });

test('discovers exact ARM64 metadata from the release listing without a static code', async () => {
  setup();
  await expect(resolveGooglePlayVersionCode('com.reddit.frontpage', '2026.40.0', 'arm64-v8a')).resolves.toBe(2640091);
  expect(navigateApkmirror).toHaveBeenLastCalledWith(expect.any(Object), `https://www.apkmirror.com${releasePath}reddit-2026-40-0-7-android-apk-download/`);
  expect(close).toHaveBeenCalledTimes(1);
});

test.each([
  [{ arch: 'armeabi-v7a' }, /No matching variant/],
  [{ arch: 'universal' }, /No matching variant/],
  [{ packageId: 'com.other.app' }, /package/],
  [{ version: '2026.41.0' }, /version/],
])('refuses incompatible discovery metadata %j and closes the browser', async (fixture, error) => {
  setup(fixture);
  await expect(resolveGooglePlayVersionCode('com.reddit.frontpage', '2026.40.0', 'arm64-v8a')).rejects.toThrow(error);
  expect(close).toHaveBeenCalledTimes(1);
});

test('unknown apps never start a browser', async () => {
  await expect(resolveGooglePlayVersionCode('com.unknown.app', '1.2.3', 'arm64-v8a')).rejects.toThrow(/No APKMirror mapping/);
  expect(openApkmirror).not.toHaveBeenCalled();
});
