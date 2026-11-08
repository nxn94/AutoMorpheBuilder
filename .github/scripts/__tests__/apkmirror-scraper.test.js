'use strict';
jest.mock('../apkmirror-pacing', () => ({ withApkmirrorPacing: jest.fn(fn => fn({ cooldown: jest.fn() })) }));
// .github/scripts/__tests__/apkmirror-scraper.test.js

// We'll import helpers once they're exported from unified-downloader.js
const {
  buildReleasePageUrl,
  buildVariantPriorities,
  apkmirrorReleaseTailCandidates,
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

  // /all-versions/ lists only the newest releases. LinkedIn 4.1.1261 had
  // dropped off it, and its release pages are named
  // `linkedin-community-network-<ver>-release`, not after the path's last
  // part, so the path-slug fallback 404'd.
  test('infers the release name from listed releases when the version is not listed', async () => {
    const p = 'linkedin/linkedin-linkedin';
    const html = `
      <html><body>
        <a class="fontBlack" href="/apk/${p}/linkedin-community-network-4-1-1271-release/">4.1.1271</a>
        <a class="fontBlack" href="/apk/${p}/linkedin-community-network-4-1-1269-release/">4.1.1269</a>
      </body></html>
    `;
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(html) })
    );

    const url = await resolveApkmirrorReleaseSlug(p, '4.1.1261', { fetchImpl });

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${p}/linkedin-community-network-4-1-1261-release/`
    );
  });

  test('retains the legacy release URL when an inferred rename returns 404', async () => {
    const path = 'example/old-app-name';
    const listUrl = `https://www.apkmirror.com/apk/${path}/all-versions/`;
    const inferredUrl = `https://www.apkmirror.com/apk/${path}/new-app-name-1-0-0-release/`;
    const legacyUrl = `https://www.apkmirror.com/apk/${path}/old-app-name-1-0-0-release/`;
    const html = `<a href="/apk/${path}/new-app-name-2-0-0-release/">2.0.0</a>`;
    const fetchImpl = jest.fn(async (url) => {
      if (url === listUrl) return { ok: true, text: async () => html };
      if (url === inferredUrl) return { ok: false, status: 404 };
      if (url === legacyUrl) return { ok: true, status: 200 };
      throw new Error(`Unexpected URL ${url}`);
    });

    const url = await resolveApkmirrorReleaseSlug(path, '1.0.0', { fetchImpl });

    expect(url).toBe(legacyUrl);
    expect((await fetchImpl(url)).ok).toBe(true);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([listUrl, inferredUrl, legacyUrl]);
  });

  test('retains the legacy candidate when the real curl status parser reports inferred 404', async () => {
    const path = 'example/old-app-name';
    const html = `<a href="/apk/${path}/new-app-name-2-0-0-release/">2.0.0</a>`;
    const execAsync = jest.fn()
      .mockResolvedValueOnce({ stdout: `${html}\n200` })
      .mockResolvedValueOnce({ stdout: 'Not found\n404' });
    const promisify = jest.spyOn(require('node:util'), 'promisify').mockReturnValue(execAsync);
    try {
      await expect(resolveApkmirrorReleaseSlug(path, '1.0.0')).resolves.toBe(
        `https://www.apkmirror.com/apk/${path}/old-app-name-1-0-0-release/`
      );
      expect(execAsync).toHaveBeenCalledTimes(2);
    } finally {
      promisify.mockRestore();
    }
  });

  test('retains the legacy release URL after a browser-confirmed inferred 404', async () => {
    const path = 'example/old-app-name';
    const inferredUrl = `https://www.apkmirror.com/apk/${path}/new-app-name-1-0-0-release/`;
    const page = {
      goto: jest.fn(async (url) => ({ status: () => url === inferredUrl ? 404 : 200 })),
      waitForTimeout: jest.fn().mockResolvedValue(),
      title: jest.fn().mockResolvedValue('APKMirror'),
      content: jest.fn().mockResolvedValue(`<a href="/apk/${path}/new-app-name-2-0-0-release/">2.0.0</a>`),
    };

    await expect(resolveApkmirrorReleaseSlug(path, '1.0.0', { page })).resolves.toBe(
      `https://www.apkmirror.com/apk/${path}/old-app-name-1-0-0-release/`
    );
    expect(page.goto.mock.calls.map(([url]) => url)).toEqual([
      `https://www.apkmirror.com/apk/${path}/all-versions/`, inferredUrl,
    ]);
  });

  test.each([403, 429, 500])('does not treat an inferred HTTP %i as a missing release', async (status) => {
    const path = 'example/old-app-name';
    const html = `<a href="/apk/${path}/new-app-name-2-0-0-release/">2.0.0</a>`;
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => html })
      .mockResolvedValueOnce({ ok: false, status });

    await expect(resolveApkmirrorReleaseSlug(path, '1.0.0', { fetchImpl })).rejects.toMatchObject({ status });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('propagates network errors while checking an inferred release', async () => {
    const path = 'example/old-app-name';
    const html = `<a href="/apk/${path}/new-app-name-2-0-0-release/">2.0.0</a>`;
    const error = new Error('connection reset');
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => html })
      .mockRejectedValueOnce(error);

    await expect(resolveApkmirrorReleaseSlug(path, '1.0.0', { fetchImpl })).rejects.toBe(error);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('keeps a reachable inferred release and does not try the legacy URL', async () => {
    const path = 'example/old-app-name';
    const html = `<a href="/apk/${path}/new-app-name-2-0-0-release/">2.0.0</a>`;
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => html })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await expect(resolveApkmirrorReleaseSlug(path, '1.0.0', { fetchImpl })).resolves.toBe(
      `https://www.apkmirror.com/apk/${path}/new-app-name-1-0-0-release/`
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('does not probe an inferred URL identical to the legacy candidate', async () => {
    const path = 'example/old-app-name';
    const html = `<a href="/apk/${path}/old-app-name-2-0-0-release/">2.0.0</a>`;
    const fetchImpl = jest.fn().mockResolvedValueOnce({ ok: true, text: async () => html });

    await expect(resolveApkmirrorReleaseSlug(path, '1.0.0', { fetchImpl })).resolves.toBe(
      `https://www.apkmirror.com/apk/${path}/old-app-name-1-0-0-release/`
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('does not treat a browser challenge with HTTP 404 as a missing release', async () => {
    const path = 'example/old-app-name';
    const page = {
      goto: jest.fn()
        .mockResolvedValueOnce({ status: () => 200 })
        .mockResolvedValue({ status: () => 404 }),
      waitForTimeout: jest.fn().mockResolvedValue(),
      title: jest.fn().mockResolvedValueOnce('APKMirror').mockResolvedValue('Just a moment'),
      content: jest.fn().mockResolvedValue(`<a href="/apk/${path}/new-app-name-2-0-0-release/">2.0.0</a>`),
    };

    await expect(resolveApkmirrorReleaseSlug(path, '1.0.0', { page })).rejects.toThrow('Cloudflare block');
    expect(page.goto).toHaveBeenCalledTimes(2);
  });

  // SD Maid (darken) ships its upstream tag as `2.0.2` but APKMirror
  // lists the same build under `/sd-maid-2-se-system-cleaner-2-0-2-rc0-release/`.
  // The exact `-2-0-2-release/` match misses; the rc0 fallback must pick
  // it up without per-app configuration.
  test('matches an -rc0 release when upstream lists the bare version only', async () => {
    const sdmaidPath = 'darken/sd-maid-2-se-system-cleaner';
    const html = `
      <html><body>
        <a class="fontBlack" href="/apk/${sdmaidPath}/sd-maid-2-se-system-cleaner-2-0-2-rc0-release/">2.0.2</a>
        <a class="fontBlack" href="/apk/${sdmaidPath}/sd-maid-2-se-system-cleaner-2-0-1-release/">2.0.1</a>
      </body></html>
    `;
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(html) })
    );

    const url = await resolveApkmirrorReleaseSlug(sdmaidPath, '2.0.2', { fetchImpl });

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${sdmaidPath}/sd-maid-2-se-system-cleaner-2-0-2-rc0-release/`
    );
  });

  test('prefers the exact tail when both exact and rcX match in the same listing', async () => {
    // Belt-and-braces for apps that ship both a stable AND a tagged
    // pre-release on the same major version: the resolver must keep
    // preferring the stable URL (matching original behavior) and only
    // broaden when the exact tail is absent.
    const path = 'example/example-app';
    const html = `
      <html><body>
        <a class="fontBlack" href="/apk/${path}/example-app-1-2-3-release/">1.2.3</a>
        <a class="fontBlack" href="/apk/${path}/example-app-1-2-3-rc0-release/">1.2.3-rc0</a>
      </body></html>
    `;
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(html) })
    );

    const url = await resolveApkmirrorReleaseSlug(path, '1.2.3', { fetchImpl });

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${path}/example-app-1-2-3-release/`
    );
  });

  test('falls through rc0..rc9 and lands on rc1', async () => {
    const path = 'example/another-app';
    const html = `
      <html><body>
        <a class="fontBlack" href="/apk/${path}/another-app-3-1-4-rc1-release/">3.1.4-rc1</a>
      </body></html>
    `;
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(html) })
    );

    const url = await resolveApkmirrorReleaseSlug(path, '3.1.4', { fetchImpl });

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${path}/another-app-3-1-4-rc1-release/`
    );
  });

  test('matches -beta suffix when no exact or rc tail is present', async () => {
    const path = 'example/beta-app';
    const html = `
      <html><body>
        <a class="fontBlack" href="/apk/${path}/beta-app-0-9-0-beta-release/">0.9.0-beta</a>
      </body></html>
    `;
    const fetchImpl = jest.fn(() =>
      Promise.resolve({ ok: true, text: () => Promise.resolve(html) })
    );

    const url = await resolveApkmirrorReleaseSlug(path, '0.9.0', { fetchImpl });

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${path}/beta-app-0-9-0-beta-release/`
    );
  });

  // GitHub Actions runner's outbound IP block trips Cloudflare's bot
  // edge on /all-versions/ — BOTH Node fetch AND curl subprocess get
  // HTTP 403. The Playwright path already has Chromium running, so we
  // reuse it for the slug scrape: Chromium's TLS fingerprint passes
  // Cloudflare. This test exercises that path end-to-end.
  test('resolves the slug via a Playwright page when provided', async () => {
    const goto = jest.fn(() => Promise.resolve({ status: () => 200 }));
    const content = jest.fn(() => Promise.resolve(sofascoreAllVersionsHtml));
    const page = { goto, content, title: async () => 'APKMirror', waitForTimeout: jest.fn() };

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
      title: async () => 'Attention Required! | Cloudflare', waitForTimeout: jest.fn(),
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
    const goto = jest.fn(() => Promise.resolve({ status: () => 200 }));
    const content = jest.fn(() => Promise.resolve(sofascoreAllVersionsHtml));
    const newPage = jest.fn(() => Promise.resolve({ goto, content, title: async () => 'APKMirror', waitForTimeout: jest.fn() }));
    const close = jest.fn(() => Promise.resolve());
    const newContext = jest.fn(() => Promise.resolve({ newPage }));
    const launch = jest.fn(() => Promise.resolve({ newContext, close, version: () => '151.0.0.0' }));

    jest.doMock('playwright', () => ({ chromium: { launch } }));

    const { resolveApkmirrorReleaseSlugViaChromium } = require('../unified-downloader');
    const url = await resolveApkmirrorReleaseSlugViaChromium(sofascorePath, '26.07.27');

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/sofascore-live-sports-scores-26-07-27-release/`
    );
    expect(launch).toHaveBeenCalledTimes(1);
    expect(newContext).toHaveBeenCalledTimes(1);
    expect(newPage).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledTimes(2);
    expect(goto.mock.calls[0][0]).toBe('https://www.apkmirror.com/');
    expect(goto.mock.calls[1][0]).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/all-versions/`
    );
    expect(content).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  test('returns the path-slug fallback when Chromium also fails on /all-versions/', async () => {
    const goto = jest.fn(url => Promise.resolve({ status: () => url === 'https://www.apkmirror.com/' ? 200 : 403 }));
    const newPage = jest.fn(() => Promise.resolve({ goto, content: jest.fn(), title: async () => 'APKMirror', waitForTimeout: jest.fn() }));
    const close = jest.fn(() => Promise.resolve());
    const newContext = jest.fn(() => Promise.resolve({ newPage }));
    const launch = jest.fn(() => Promise.resolve({ newContext, close, version: () => '151.0.0.0' }));

    jest.doMock('playwright', () => ({ chromium: { launch } }));

    const { resolveApkmirrorReleaseSlugViaChromium } = require('../unified-downloader');
    const url = await resolveApkmirrorReleaseSlugViaChromium(sofascorePath, '26.07.27');

    expect(url).toBe(
      `https://www.apkmirror.com/apk/${sofascorePath}/soccer-scores-and-sports-livescore-sofascore-26-07-27-release/`
    );
    expect(close).toHaveBeenCalledTimes(1);
  });
});

test('list-page 429 propagates rather than requesting a fallback release', async () => {
  const fetchImpl = jest.fn(async () => { throw Object.assign(new Error('throttled'), { status: 429 }); });
  await expect(resolveApkmirrorReleaseSlug('example/app', '1.0', { fetchImpl })).rejects.toMatchObject({ status: 429 });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test.each(['2', 'Sun, 08 Nov 2026 12:00:00 GMT', 'invalid', '999999'])('curl HTML 429 shares Retry-After %s and does not resolve another slug', async value => {
  const { resolveApkmirrorReleaseSlug } = require('../unified-downloader');
  const cooldown = jest.fn();
  const { withApkmirrorPacing } = require('../apkmirror-pacing');
  withApkmirrorPacing.mockImplementationOnce(fn => fn({ cooldown }));
  const execAsync = jest.fn(async () => ({ stdout: `HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${value}\r\n\r\nblocked\n429` }));
  const spy = jest.spyOn(require('node:util'), 'promisify').mockReturnValue(execAsync);
  try {
    await expect(resolveApkmirrorReleaseSlug('example/app', '1.0')).rejects.toMatchObject({ status: 429 });
    expect(cooldown).toHaveBeenCalledWith(value);
    expect(execAsync).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});
