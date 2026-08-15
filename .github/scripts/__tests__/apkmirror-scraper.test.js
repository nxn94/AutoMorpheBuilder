// .github/scripts/__tests__/apkmirror-scraper.test.js
'use strict';

// We'll import helpers once they're exported from unified-downloader.js
const {
  buildReleasePageUrl,
  buildVariantPriorities,
  selectVariant,
  collectCookies,
  resolveApkmirrorReleaseSlug,
} = require('../unified-downloader');

const cheerio = require('cheerio');

describe('buildReleasePageUrl', () => {
  test('constructs correct URL with slug prefix', () => {
    const url = buildReleasePageUrl('google-inc/youtube', '20.44.38');
    expect(url).toBe(
      'https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-44-38-release/'
    );
  });

  test('constructs correct URL for youtube music', () => {
    const url = buildReleasePageUrl('google-inc/youtube-music', '8.44.54');
    expect(url).toBe(
      'https://www.apkmirror.com/apk/google-inc/youtube-music/youtube-music-8-44-54-release/'
    );
  });
});

describe('buildVariantPriorities', () => {
  test('preferred_arch is first priority as APK', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[0]).toEqual({ arch: 'arm64-v8a', dpi: 'nodpi', type: 'APK' });
  });

  test('universal APK is third priority', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[2]).toEqual({ arch: 'universal', dpi: 'nodpi', type: 'APK' });
  });

  test('noarch APK is fifth priority', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(priorities[4]).toEqual({ arch: 'noarch', dpi: 'nodpi', type: 'APK' });
  });

  test('returns 25 priorities total (5 arch/type combos × 5 DPIs)', () => {
    // 5 DPIs × 5 arch/type combos per DPI (preferredArch APK,
    // preferredArch BUNDLE, universal APK, universal BUNDLE, noarch APK)
    // = 25. If you add or remove a DPI tier, this number must move with
    // it — otherwise the per-tier ordering assertions below silently
    // index past the end of the array.
    expect(buildVariantPriorities('arm64-v8a')).toHaveLength(25);
  });

  test('DPI tiers are ordered outer-loop: nodpi → 120-640 → 480-640 → 120-480 → 240-480', () => {
    // Outer loop = DPI, inner loop = arch/type. The first arm64-v8a APK
    // for each DPI tier should land at indices 0, 5, 10, 15, 20.
    const priorities = buildVariantPriorities('arm64-v8a');
    const orderedDpis = ['nodpi', '120-640dpi', '480-640dpi', '120-480dpi', '240-480dpi'];
    const firstArm64ApkIndices = orderedDpis.map(dpi =>
      priorities.findIndex(p => p.dpi === dpi && p.arch === 'arm64-v8a' && p.type === 'APK')
    );
    expect(firstArm64ApkIndices).toEqual([0, 5, 10, 15, 20]);
  });

  test('480-640dpi tier comes between 120-640dpi and 120-480dpi', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    const first120 = priorities.findIndex(p => p.dpi === '120-640dpi');
    const first480 = priorities.findIndex(p => p.dpi === '480-640dpi');
    const first120to480 = priorities.findIndex(p => p.dpi === '120-480dpi');
    expect(first120).toBeLessThan(first480);
    expect(first480).toBeLessThan(first120to480);
  });

  test('240-480dpi entries still come last', () => {
    const priorities = buildVariantPriorities('arm64-v8a');
    const first240 = priorities.findIndex(p => p.dpi === '240-480dpi');
    const allOtherDpis = priorities.filter(p => p.dpi !== '240-480dpi');
    const lastOtherDpiIndex = priorities.lastIndexOf(allOtherDpis[allOtherDpis.length - 1]);
    expect(first240).toBeGreaterThan(lastOtherDpiIndex);
  });
});

describe('selectVariant', () => {
  // Matches real APKMirror DOM:
  // cells[0] = variant name + type text + a.accent_color link
  // cells[1] = architecture
  // cells[2] = min android version (ignored)
  // cells[3] = screen DPI
  const makeHtml = (rows) => `
    <div class="variants-table">
      ${rows.map(r => `
        <div class="table-row">
          <div class="table-cell"><a class="accent_color" href="${r.href}">${r.version} ${r.type}</a></div>
          <div class="table-cell">${r.arch}</div>
          <div class="table-cell">Android 9.0+</div>
          <div class="table-cell">${r.dpi}</div>
          <div class="table-cell"></div>
        </div>
      `).join('')}
    </div>
  `;

  test('selects arm64-v8a APK nodpi as first priority', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/arm64' },
      { version: '20.44.38', dpi: 'nodpi', arch: 'universal', type: 'APK', href: '/apk/universal' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/arm64');
  });

  test('falls back to universal when preferred_arch not found', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'universal', type: 'APK', href: '/apk/universal' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/universal');
  });

  test('falls back to 120-640dpi when nodpi not found', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: '120-640dpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/120dpi' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/120dpi');
  });

  test('falls back to 480-640dpi when nodpi and 120-640dpi not found', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: '480-640dpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/480dpi' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/480dpi');
  });

  test('falls back to 120-480dpi when nodpi, 120-640dpi, and 480-640dpi not found', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: '120-480dpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/120to480dpi' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/120to480dpi');
  });

  test('falls back to 240-480dpi when all higher-priority DPI tiers are missing', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: '240-480dpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/240dpi' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/240dpi');
  });

  test('prefers 480-640dpi over 120-480dpi when both are offered', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: '120-480dpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/120to480dpi' },
      { version: '20.44.38', dpi: '480-640dpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/480dpi' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/480dpi');
  });

  test('throws with list of available variants when nothing matches', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: '320dpi', arch: 'x86_64', type: 'APK', href: '/apk/x86' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(() => selectVariant($, priorities)).toThrow(/No matching variant/);
  });

  test('prefers APK over BUNDLE for same arch', () => {
    const html = makeHtml([
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'BUNDLE', href: '/apk/bundle' },
      { version: '20.44.38', dpi: 'nodpi', arch: 'arm64-v8a', type: 'APK', href: '/apk/apk' },
    ]);
    const $ = cheerio.load(html);
    const priorities = buildVariantPriorities('arm64-v8a');
    expect(selectVariant($, priorities)).toBe('/apk/apk');
  });
});

describe('collectCookies', () => {
  // Mock uses getSetCookie() returning string[] — matches the Headers API
  const makeResponse = (cookieStrings) => ({
    headers: { getSetCookie: () => cookieStrings }
  });

  test('collects a single cookie', () => {
    const resp = makeResponse(['session=abc123; Path=/']);
    const cookies = collectCookies(resp, {});
    expect(cookies).toEqual({ session: 'abc123' });
  });

  test('collects multiple cookies from separate Set-Cookie headers', () => {
    const resp = makeResponse(['session=abc123; Path=/', 'token=xyz; HttpOnly']);
    const cookies = collectCookies(resp, {});
    expect(cookies).toEqual({ session: 'abc123', token: 'xyz' });
  });

  test('merges with existing cookies', () => {
    const resp = makeResponse(['new=val; Path=/']);
    const cookies = collectCookies(resp, { existing: 'keep' });
    expect(cookies).toEqual({ existing: 'keep', new: 'val' });
  });

  test('returns existing when no Set-Cookie headers', () => {
    const resp = makeResponse([]);
    const cookies = collectCookies(resp, { keep: 'me' });
    expect(cookies).toEqual({ keep: 'me' });
  });
});

describe('resolveApkmirrorReleaseSlug', () => {
  const sofascorePath = 'sofascore/soccer-scores-and-sports-livescore-sofascore';
  const youtubePath = 'google-inc/youtube';
  const sofascoreAllVersionsHtml = `
    <html><body>
      <a class="fontBlack" href="/apk/${sofascorePath}/soccer-scores-and-sports-livescore-sofascore-26-06-29-release/">26.06.29</a>
      <a class="fontBlack" href="/apk/${sofascorePath}/sofascore-live-sports-scores-26-07-27-release/">26.07.27</a>
      <a class="fontBlack" href="/apk/${sofascorePath}/sofascore-live-sports-scores-26-08-03-release/">26.08.03</a>
    </body></html>
  `;
  const youtubeAllVersionsHtml = `
    <html><body>
      <a class="fontBlack" href="/apk/${youtubePath}/youtube-21-29-366-release/">21.29.366</a>
      <a class="fontBlack" href="/apk/${youtubePath}/youtube-21-31-529-release/">21.31.529</a>
    </body></html>
  `;

  test('resolves the slug from /all-versions/ when it differs from the path slug', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(sofascoreAllVersionsHtml) })
    );

    const url = await resolveApkmirrorReleaseSlug(sofascorePath, '26.07.27', { fetchImpl });

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/sofascore-live-sports-scores-26-07-27-release/`
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/all-versions/`
    );
  });

  test('falls back to path-slug URL when /all-versions/ fetch fails', async () => {
    const fetchImpl = jest.fn(() => Promise.reject(new Error('network down (mocked)')));

    const url = await resolveApkmirrorReleaseSlug(youtubePath, '20.44.38', { fetchImpl });

    expect(url).toBe(
      'https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-44-38-release/'
    );
  });

  test('falls back to path-slug URL when version not listed on /all-versions/', async () => {
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(youtubeAllVersionsHtml) })
    );

    const url = await resolveApkmirrorReleaseSlug(youtubePath, '20.44.38', { fetchImpl });

    expect(url).toBe(
      'https://www.apkmirror.com/apk/google-inc/youtube/youtube-20-44-38-release/'
    );
  });

  // GitHub Actions runner's outbound IP block trips Cloudflare's bot
  // edge on /all-versions/ — BOTH Node fetch AND curl subprocess get
  // HTTP 403. The Playwright path already has Chromium running, so we
  // reuse it for the slug scrape: Chromium's TLS fingerprint passes
  // Cloudflare. This test exercises that path end-to-end.
  test('resolves the slug via a Playwright page when provided', async () => {
    const goto = jest.fn(() => Promise.resolve({ ok: () => true }));
    const content = jest.fn(() => Promise.resolve(sofascoreAllVersionsHtml));
    const page = { goto, content };

    const url = await resolveApkmirrorReleaseSlug(sofascorePath, '26.07.27', { page });

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/sofascore-live-sports-scores-26-07-27-release/`
    );
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0][0]).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/all-versions/`
    );
    expect(content).toHaveBeenCalledTimes(1);
  });

  test('falls back to buildReleasePageUrl when the Playwright page goto fails', async () => {
    const page = {
      goto: jest.fn(() => Promise.resolve({ ok: () => false, status: () => 403 })),
      content: jest.fn(),
    };

    const url = await resolveApkmirrorReleaseSlug(sofascorePath, '26.07.27', { page });

    // Falls back to the path-slug URL — same wrong URL the production
    // failure was hitting before this fix. Better than throwing: the
    // outer Playwright code can still try to navigate it and detect
    // the 404 / variant table empty state downstream.
    expect(url).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/soccer-scores-and-sports-livescore-sofascore-26-07-27-release/`
    );
    expect(page.content).not.toHaveBeenCalled();
  });
});

describe('resolveApkmirrorReleaseSlugViaChromium', () => {
  // The chromium fallback is a separate function that gets called from
  // resolveApkmirrorUrlViaCurl when curl hits 403 on /all-versions/.
  // The fallback reuses resolveApkmirrorReleaseSlug with a chromium page,
  // so the contract is identical: Chromium gets the fresh slug, the
  // function returns the resolved URL.
  //
  // We mock playwright at the module level so the function uses a
  // jest.fn() page instead of launching a real browser.
  const sofascorePath = 'sofascore/soccer-scores-and-sports-livescore-sofascore';
  const sofascoreAllVersionsHtml = `
    <html><body>
      <a class="fontBlack" href="/apk/${sofascorePath}/sofascore-live-sports-scores-26-07-27-release/">26.07.27</a>
    </body></html>
  `;

  beforeEach(() => {
    jest.resetModules();
  });

  test('launches Chromium, navigates to /all-versions/, and returns the resolved slug', async () => {
    const goto = jest.fn(() => Promise.resolve({ ok: () => true }));
    const content = jest.fn(() => Promise.resolve(sofascoreAllVersionsHtml));
    const newPage = jest.fn(() => Promise.resolve({ goto, content }));
    const close = jest.fn(() => Promise.resolve());
    const newContext = jest.fn(() => Promise.resolve({ newPage }));
    const launch = jest.fn(() => Promise.resolve({ newContext, close }));

    jest.doMock('playwright', () => ({ chromium: { launch } }));

    const { resolveApkmirrorReleaseSlugViaChromium } = require('../unified-downloader');
    const url = await resolveApkmirrorReleaseSlugViaChromium(sofascorePath, '26.07.27');

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/sofascore-live-sports-scores-26-07-27-release/`
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(newContext).toHaveBeenCalledTimes(1);
    expect(newPage).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0][0]).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/all-versions/`
    );
    expect(content).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('returns the path-slug fallback when Chromium also fails on /all-versions/', async () => {
    const goto = jest.fn(() => Promise.resolve({ ok: () => false, status: () => 403 }));
    const newPage = jest.fn(() => Promise.resolve({ goto, content: jest.fn() }));
    const close = jest.fn(() => Promise.resolve());
    const newContext = jest.fn(() => Promise.resolve({ newPage }));
    const launch = jest.fn(() => Promise.resolve({ newContext, close }));

    jest.doMock('playwright', () => ({ chromium: { launch } }));

    const { resolveApkmirrorReleaseSlugViaChromium } = require('../unified-downloader');
    const url = await resolveApkmirrorReleaseSlugViaChromium(sofascorePath, '26.07.27');

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/soccer-scores-and-sports-livescore-sofascore-26-07-27-release/`
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});
