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
let fetchSpy;
beforeEach(() => {
  jest.clearAllMocks();
  // APKPure is only asked when APKMirror can't give the number; keep tests offline.
  fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('offline'));
});
afterEach(() => fetchSpy.mockRestore());

// One APKPure listing URL; the build number sits in its `c` param.
function apkpureUrl(vn, vc, size) {
  const inner = Buffer.from(`dev=x&t=xapk&s=${size}&vn=${vn}&vc=${vc}`).toString('base64');
  return `https://download.pureapk.com/b/XAPK/abc?_fn=x&c=1|APP|${inner}`;
}
function apkpureListing(...urls) {
  const body = urls.map((u) => `\n${u}\u00d2\u0001`).join('');
  return { ok: true, status: 200, text: async () => body };
}

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

test("uses APKPure's build number when APKMirror has no mapping", async () => {
  fetchSpy.mockResolvedValue(apkpureListing(apkpureUrl('1.2.3', 456, 900), apkpureUrl('1.2.3', 455, 500), apkpureUrl('1.2.4', 470, 100)));
  await expect(resolveGooglePlayVersionCode('com.unknown.app', '1.2.3', 'arm64-v8a')).resolves.toBe(455);
  expect(openApkmirror).not.toHaveBeenCalled();
  expect(fetchSpy.mock.calls[0][0]).toBe('https://api.pureapk.com/m/v3/cms/app_version?hl=en-US&package_name=com.unknown.app');
});

test("uses APKPure's build number when APKMirror is blocked", async () => {
  openApkmirror.mockRejectedValue(new Error('APKMirror Cloudflare block (HTTP 403)'));
  fetchSpy.mockResolvedValue(apkpureListing(apkpureUrl('2026.40.0', 2640091, 500)));
  await expect(resolveGooglePlayVersionCode('com.reddit.frontpage', '2026.40.0', 'arm64-v8a')).resolves.toBe(2640091);
});

test.each([
  ['no listing for the version', () => apkpureListing(apkpureUrl('9.9.9', 1, 1)), /no build number listed/],
  ['a non-numeric build number', () => apkpureListing(apkpureUrl('1.2.3', '12a', 1)), /no build number listed/],
  ['a zero build number', () => apkpureListing(apkpureUrl('1.2.3', 0, 1)), /no build number listed/],
  ['an HTTP error', () => ({ ok: false, status: 403 }), /APKPure API returned 403/],
])('reports both sources when APKPure has %s', async (_, response, error) => {
  fetchSpy.mockResolvedValue(response());
  const result = resolveGooglePlayVersionCode('com.unknown.app', '1.2.3', 'arm64-v8a');
  await expect(result).rejects.toThrow(/No APKMirror mapping/);
  await expect(result).rejects.toThrow(error);
});

test('never asks APKPure for another CPU type', async () => {
  await expect(resolveGooglePlayVersionCode('com.unknown.app', '1.2.3', 'armeabi-v7a')).rejects.toThrow(/no armeabi-v7a build numbers/);
  expect(fetchSpy).not.toHaveBeenCalled();
});
