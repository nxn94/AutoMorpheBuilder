'use strict';

const cheerio = require('cheerio');
const { buildVariantPriorities, selectVariant } = require('../variant');

function makeRowHtml(row) {
  return `
    <div class="table-row">
      <div class="table-cell"><a class="accent_color" href="${row.href}">${row.name || ''}</a></div>
      <div class="table-cell">${row.arch}</div>
      <div class="table-cell">minver</div>
      <div class="table-cell">${row.dpi}</div>
    </div>`;
}

function makePageHtml(rows) {
  return `<html><body><div class="listDetails">${rows.map(makeRowHtml).join('')}</div></body></html>`;
}

describe('download/variant', () => {
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
      // = 25. noarch skips the BUNDLE entry, so 4 BUNDLE + 5 APK per tier.
      expect(buildVariantPriorities('arm64-v8a')).toHaveLength(25);
    });

    test('order within a DPI tier: preferred APK, preferred BUNDLE, universal APK, universal BUNDLE, noarch APK', () => {
      const priorities = buildVariantPriorities('arm64-v8a');
      // Take the first tier (nodpi) and verify the inner-loop order.
      const tier = priorities.slice(0, 5);
      expect(tier).toEqual([
        { arch: 'arm64-v8a', dpi: 'nodpi', type: 'APK' },
        { arch: 'arm64-v8a', dpi: 'nodpi', type: 'BUNDLE' },
        { arch: 'universal', dpi: 'nodpi', type: 'APK' },
        { arch: 'universal', dpi: 'nodpi', type: 'BUNDLE' },
        { arch: 'noarch', dpi: 'nodpi', type: 'APK' },
      ]);
    });

    test('outer loop is the DPI tier', () => {
      const priorities = buildVariantPriorities('arm64-v8a');
      // The 6th entry starts the next DPI tier.
      expect(priorities[5]).toEqual({ arch: 'arm64-v8a', dpi: '120-640dpi', type: 'APK' });
    });
  });

  describe('selectVariant', () => {
    test('returns the first priority that matches a row', () => {
      const html = makePageHtml([
        { arch: 'arm64-v8a', dpi: 'nodpi', type: 'APK', href: '/apk/arm64-apk-nodpi/' },
        { arch: 'arm64-v8a', dpi: 'nodpi', type: 'BUNDLE', href: '/apk/arm64-bundle-nodpi/' },
      ]);
      const $ = cheerio.load(html);
      const priorities = buildVariantPriorities('arm64-v8a');
      // The nodpi APK is priority 0 and exists in the table, so it
      // wins before any later entry.
      expect(selectVariant($, priorities)).toBe('/apk/arm64-apk-nodpi/');
    });

    test('falls through to a later priority when earlier ones are missing', () => {
      const html = makePageHtml([
        // Only one row available: universal bundle at nodpi.
        { arch: 'universal', dpi: 'nodpi', type: 'BUNDLE', href: '/apk/universal-bundle-nodpi/' },
      ]);
      const $ = cheerio.load(html);
      const priorities = buildVariantPriorities('arm64-v8a');
      // Skip preferred APK (no row), skip preferred BUNDLE (no row),
      // skip universal APK (no row) → pick universal BUNDLE.
      expect(selectVariant($, priorities)).toBe('/apk/universal-bundle-nodpi/');
    });

    test('throws with the available variants when nothing matches', () => {
      const html = makePageHtml([
        { arch: 'x86', dpi: 'nodpi', type: 'APK', href: '/apk/x86-apk/' },
      ]);
      const $ = cheerio.load(html);
      // Ask for arm64-v8a; x86 doesn't match any priority.
      expect(() => selectVariant($, buildVariantPriorities('arm64-v8a'))).toThrow(
        /No matching variant found on APKMirror\. Available: x86\/nodpi\/APK/,
      );
    });

    test('skips anchor-only links (href contains #)', () => {
      const html = makePageHtml([
        // The variant row link is #foo, the parent <a href="/apk/..."> is
        // absent. Per the implementation, href.includes('#') → skip.
        { arch: 'arm64-v8a', dpi: 'nodpi', type: 'APK', href: '#sidebar' },
      ]);
      const $ = cheerio.load(html);
      expect(() => selectVariant($, buildVariantPriorities('arm64-v8a'))).toThrow(
        /Available: none/,
      );
    });

    test('BUNDLE is detected from the row label even when no href text contains the word', () => {
      const html = makePageHtml([
        { name: 'APK + bundle', arch: 'arm64-v8a', dpi: 'nodpi', type: 'BUNDLE', href: '/apk/arm64-bundle/' },
      ]);
      const $ = cheerio.load(html);
      // After falling through the APK slots, the BUNDLE slot picks it up.
      expect(selectVariant($, buildVariantPriorities('arm64-v8a'))).toBe('/apk/arm64-bundle/');
    });
  });
});
