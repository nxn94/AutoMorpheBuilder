'use strict';

async function navigateApkmirror(page, url) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== 'www.apkmirror.com' || target.username || target.password || target.port) {
    throw new Error('Invalid APKMirror URL');
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Let browser challenges complete before checking status or parsing the DOM.
    await page.waitForTimeout(attempt ? 8000 : 1500);
    const title = await page.title();
    const status = response?.status() || 0;
    const blocked = /attention required|just a moment|checking your browser|cloudflare/i.test(title);
    if (!blocked && status >= 200 && status < 400) return;
    if (attempt) {
      const error = new Error(`APKMirror ${blocked ? 'Cloudflare block' : 'navigation failure'} (HTTP ${status})`);
      if (!blocked) error.status = status;
      throw error;
    }
  }
}

async function openApkmirror(chromium) {
  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({
      // Keep Chromium's real version while removing the HeadlessChrome product token.
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`,
      locale: 'en-US', acceptDownloads: true,
    });
    const page = await context.newPage();
    await navigateApkmirror(page, 'https://www.apkmirror.com/');
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

function extractVersionCode($, packageId, version) {
  const text = $('.appspec-value').text();
  const foundPackage = text.match(/Package:\s*([\w.]+)/)?.[1];
  if (foundPackage !== packageId) throw new Error('APKMirror package metadata mismatch');
  const match = text.match(/Version:\s*([^\s]+)\s*\((\d+)\)/);
  if (!match || match[1] !== version || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0) {
    throw new Error('APKMirror version metadata mismatch');
  }
  return Number(match[2]);
}

module.exports = { openApkmirror, navigateApkmirror, extractVersionCode };
