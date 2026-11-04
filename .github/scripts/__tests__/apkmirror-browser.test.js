'use strict';
const cheerio = require('cheerio');
const { openApkmirror, navigateApkmirror, extractVersionCode } = require('../apkmirror-browser');

test('uses full Chromium and warms the same session without a mismatched Firefox UA', async () => {
  const page = { goto: jest.fn(async () => ({ status: () => 200 })), title: jest.fn(async () => 'APKMirror'), waitForTimeout: jest.fn() };
  const context = { newPage: jest.fn(async () => page) };
  const browser = { newContext: jest.fn(async () => context), close: jest.fn(), version: () => '151.0.0.0' };
  const chromium = { launch: jest.fn(async () => browser) };
  const session = await openApkmirror(chromium);
  expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({ channel: 'chromium' }));
  expect(browser.newContext.mock.calls[0][0].userAgent).toContain('Chrome/151.0.0.0');
  expect(browser.newContext.mock.calls[0][0].userAgent).not.toMatch(/Firefox|HeadlessChrome/);
  expect(page.goto).toHaveBeenCalledWith('https://www.apkmirror.com/', expect.any(Object));
  expect(session.page).toBe(page);
});

test('does not parse a persistent Cloudflare block as an absent download button', async () => {
  const page = { goto: jest.fn(async () => ({ status: () => 403 })), title: jest.fn(async () => 'Attention Required! | Cloudflare'), waitForTimeout: jest.fn() };
  await expect(navigateApkmirror(page, 'https://www.apkmirror.com/apk/test/')).rejects.toThrow(/Cloudflare.*403/);
  expect(page.goto).toHaveBeenCalledTimes(2);
});

test('rejects off-site and credential-bearing navigation', async () => {
  for (const url of ['https://evil.example/', 'https://user:pass@www.apkmirror.com/']) {
    await expect(navigateApkmirror({}, url)).rejects.toThrow(/APKMirror URL/);
  }
});

test('reads the exact package and version code from the user-provided Reddit variant metadata', () => {
  const $ = cheerio.load('<div class="appspec-value">Version: 2026.40.0 (2640091)<br>Package: com.reddit.frontpage</div>');
  expect(extractVersionCode($, 'com.reddit.frontpage', '2026.40.0')).toBe(2640091);
  expect(() => extractVersionCode($, 'com.reddit.frontpage', '2026.41.0')).toThrow(/version/);
  expect(() => extractVersionCode($, 'com.other.app', '2026.40.0')).toThrow(/package/);
});
