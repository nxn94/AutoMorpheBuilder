'use strict';
const { withApkmirrorPacing } = require('./apkmirror-pacing');

async function navigateApkmirror(page, url) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.hostname !== 'www.apkmirror.com' || target.username || target.password || target.port) {
    throw new Error('Invalid APKMirror URL');
  }
  return withApkmirrorPacing(async gate => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let latest;
      const onResponse = response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) latest = response;
      };
      page.on?.('response', onResponse);
      try {
        const initial = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Automatic challenge navigations replace goto's original response.
        if (!latest) latest = initial;
        await page.waitForTimeout(attempt ? 8000 : 1500);
        const challengeTitle = /attention required|just a moment|checking your browser|cloudflare/i;
        let title = await page.title();
        if (challengeTitle.test(title) && ![404, 429].includes(latest?.status())) {
          // Give the current challenge a bounded chance to navigate itself.
          await page.waitForTimeout(8000);
          title = await page.title();
        }
        const status = latest?.status() || 0;
        const blocked = challengeTitle.test(title);
        if (!blocked && status >= 200 && status < 400) return;
        const error = Object.assign(new Error(`APKMirror ${blocked ? 'Cloudflare block' : 'navigation failure'} (HTTP ${status})`), { status });
        if (status === 429) await gate.cooldown((await latest.allHeaders?.())?.['retry-after']);
        if (attempt || !blocked || status === 404 || status === 429) throw error;
      } finally {
        page.off?.('response', onResponse);
      }
    }
  });
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
