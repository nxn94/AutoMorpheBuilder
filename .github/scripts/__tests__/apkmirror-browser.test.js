jest.mock('../apkmirror-pacing', () => ({ withApkmirrorPacing: jest.fn((fn) => fn({ cooldown: async () => {} })) }), { virtual: true });
'use strict';
const cheerio = require('cheerio');
const { openApkmirror, navigateApkmirror, extractVersionCode } = require('../apkmirror-browser');

test('uses full Chromium and warms the same session without a mismatched Firefox UA', async () => {
  const page = { goto: jest.fn(async () => ({ status: () => 200 })), title: jest.fn(async () => 'APKMirror'), waitForTimeout: jest.fn() };
  const context = { newPage: jest.fn(async () => page) };
  const browser = { newContext: jest.fn(async () => context), close: jest.fn(), version: () => '151.0.0.0' };
  const chromium = { launch: jest.fn(async () => browser) };
  const session = await openApkmirror(chromium);
  expect(chromium.launch).toHaveBeenCalledWith(expect.objectContaining({
    channel: 'chromium',
    // This reliability change must preserve the existing launch configuration.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  }));
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

function respondingPage(status, title = 'APKMirror') {
  const { EventEmitter } = require('node:events');
  const page = new EventEmitter();
  page.mainFrame = () => page;
  page.goto = jest.fn(async () => ({ status: () => status }));
  page.title = jest.fn(async () => title);
  page.waitForTimeout = jest.fn(async () => {});
  return page;
}
test('accepts an automatic main document recovery without reloading and removes listener', async () => {
  const page = respondingPage(403);
  page.waitForTimeout.mockImplementation(async () => page.emit('response', {
    status: () => 200, request: () => ({ isNavigationRequest: () => true }), frame: () => page,
  }));
  await navigateApkmirror(page, 'https://www.apkmirror.com/');
  expect(page.goto).toHaveBeenCalledTimes(1);
  expect(page.listenerCount('response')).toBe(0);
});
test.each([404, 500])('does not retry genuine HTTP %i, preserves status and cleans up', async status => {
  const page = respondingPage(status);
  await expect(navigateApkmirror(page, 'https://www.apkmirror.com/')).rejects.toMatchObject({ status });
  expect(page.goto).toHaveBeenCalledTimes(1);
  expect(page.listenerCount('response')).toBe(0);
});

test('coordinates navigation and never retries 429 in a fresh navigation', async () => {
  const { withApkmirrorPacing } = require('../apkmirror-pacing');
  withApkmirrorPacing.mockClear();
  const page = respondingPage(429, 'Just a moment');
  await expect(navigateApkmirror(page, 'https://www.apkmirror.com/')).rejects.toMatchObject({ status: 429 });
  expect(withApkmirrorPacing).toHaveBeenCalled();
  expect(page.goto).toHaveBeenCalledTimes(1);
});

test.each(['iframe', 'subresource'])('ignores %s success after a normal-looking 403', async kind => {
  const page = respondingPage(403);
  page.waitForTimeout.mockImplementation(async () => page.emit('response', {
    status: () => 200, request: () => ({ isNavigationRequest: () => kind !== 'subresource' }),
    frame: () => kind === 'iframe' ? {} : page,
  }));
  await expect(navigateApkmirror(page, 'https://www.apkmirror.com/')).rejects.toMatchObject({ status: 403 });
  expect(page.listenerCount('response')).toBe(0);
});
test('removes listener after goto throws', async () => {
  const page = respondingPage(200);
  page.goto.mockRejectedValue(new Error('offline fixture'));
  await expect(navigateApkmirror(page, 'https://www.apkmirror.com/')).rejects.toThrow('offline fixture');
  expect(page.listenerCount('response')).toBe(0);
});
test('closes browser on context failure and propagates launch failure', async () => {
  const browser = { version: () => '151.0', newContext: jest.fn(async () => { throw new Error('context'); }), close: jest.fn() };
  await expect(openApkmirror({ launch: async () => browser })).rejects.toThrow('context');
  expect(browser.close).toHaveBeenCalledTimes(1);
  await expect(openApkmirror({ launch: async () => { throw new Error('launch'); } })).rejects.toThrow('launch');
});

test('waits for a later automatic challenge recovery before considering reload', async () => {
  const page = respondingPage(403);
  let waits = 0;
  page.title.mockImplementation(async () => waits < 2 ? 'Just a moment' : 'APKMirror');
  page.waitForTimeout.mockImplementation(async () => {
    if (++waits === 2) page.emit('response', {
      status: () => 200, request: () => ({ isNavigationRequest: () => true }), frame: () => page,
    });
  });
  await navigateApkmirror(page, 'https://www.apkmirror.com/');
  expect(page.goto).toHaveBeenCalledTimes(1);
});

test.each(['2', 'Sun, 08 Nov 2026 12:00:00 GMT', undefined])('browser passes Retry-After %s to shared cooldown', async value => {
  const cooldown = jest.fn();
  require('../apkmirror-pacing').withApkmirrorPacing.mockImplementationOnce(fn => fn({ cooldown }));
  const page = respondingPage(429, 'Cloudflare');
  page.goto.mockResolvedValue({ status: () => 429, allHeaders: async () => ({ 'retry-after': value }) });
  await expect(navigateApkmirror(page, 'https://www.apkmirror.com/')).rejects.toMatchObject({ status: 429 });
  expect(cooldown).toHaveBeenCalledWith(value);
});
