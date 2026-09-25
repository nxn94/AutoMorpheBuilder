'use strict';

/**
 * APKMirror variant selection extracted from
 * `.github/scripts/unified-downloader.js`.
 *
 * The play is:
 *   1. `buildVariantPriorities(preferredArch)` builds the ordered
 *      list of (arch, dpi, type) triples to try. Outer loop = DPI
 *      tier (more important), inner loop = arch/type combo.
 *   2. `selectVariant($, priorities)` parses a cheerio-loaded
 *      release page's variant table and returns the href of the
 *      first row matching the priority list, throwing with the
 *      available variants if none matches.
 *
 * Both helpers are pure (no I/O, no network): `buildVariantPriorities`
 * just enumerates a fixed cartesian product, and `selectVariant` walks
 * a pre-loaded DOM. cheerio's `load` is HTML-parsing, not network —
 * the downloader hands us `$`, we walk it and return a string.
 *
 * DPI preference is APKMirror-only. APKMirror exposes a variant table
 * with explicit DPI columns, so we can pick a precise target. APKPure
 * (via apkeep) doesn't expose DPI as a selectable axis — the apkeep
 * path takes whatever APKPure serves, then validates the resulting
 * .apk against `preferred_arch` post-download and falls back to the
 * next source if the ABI doesn't match.
 *
 * Tiers ordered by band tightness:
 *   nodpi        → no DPI-specific resources, runs on any density.
 *   120-640dpi   → assets-up to 640, asset-densities up to 480 — a
 *                  wide umbrella that covers every shipping device.
 *   480-640dpi   → upper-density-only, falls back to lower densities
 *                  visually (smaller assets on a phone but fine).
 *   120-480dpi   → explicit upper bound of 480 (xxxhdpi excluded).
 *   240-480dpi   → narrower band than 120-480dpi, last resort.
 *
 * Within each DPI tier: preferred APK → preferred BUNDLE → universal
 * APK → universal BUNDLE → noarch APK. BUNDLE is skipped for the
 * noarch tier (noarch never ships as a split package).
 */

/**
 * @param {string} preferredArch
 * @returns {Array<{ arch: string, dpi: string, type: 'APK' | 'BUNDLE' }>}
 *          The full priority list, in iteration order.
 */
function buildVariantPriorities(preferredArch) {
  const archs = [preferredArch, 'universal', 'noarch'];
  const dpis = ['nodpi', '120-640dpi', '480-640dpi', '120-480dpi', '240-480dpi'];
  const priorities = [];
  for (const dpi of dpis) {
    for (const arch of archs) {
      priorities.push({ arch, dpi, type: 'APK' });
      if (arch !== 'noarch') priorities.push({ arch, dpi, type: 'BUNDLE' });
    }
  }
  return priorities;
}

/**
 * Parse variant table rows from a cheerio-loaded release page.
 * Returns the href of the first row matching the priority list.
 * Throws with available variants if nothing matches.
 *
 * @param {object} $ A cheerio root handle (from `cheerio.load(html)`).
 * @param {Array<{ arch: string, dpi: string, type: string }>} priorities
 * @returns {string} The href of the first matching row.
 * @throws {Error} With the available `(arch/dpi/type)` triples if no
 *                  row matched.
 */
function selectVariant($, priorities) {
  const rows = [];
  $('.table-row').each((_, row) => {
    const cells = $(row).find('.table-cell');
    if (cells.length < 4) return;
    // Real APKMirror DOM: cells[0]=variant name+type+link,
    // cells[1]=arch, cells[2]=minver, cells[3]=dpi
    const href = $(cells[0]).find('a.accent_color[href], a[href*="/apk/"]').attr('href');
    if (!href || href.includes('#')) return; // Skip anchor-only sidebar links
    const variantText = $(cells[0]).text().toUpperCase();
    const type = variantText.includes('BUNDLE') ? 'BUNDLE' : 'APK';
    rows.push({
      dpi: $(cells[3]).text().trim().toLowerCase(),
      arch: $(cells[1]).text().trim().toLowerCase(),
      type,
      href,
    });
  });

  for (const { arch, dpi, type } of priorities) {
    const match = rows.find((r) =>
      r.arch.includes(arch.toLowerCase()) &&
      r.dpi === dpi.toLowerCase() &&
      r.type === type);
    if (match) return match.href;
  }

  const found = rows.map((r) => `${r.arch}/${r.dpi}/${r.type}`).join(', ') || 'none';
  throw new Error(`No matching variant found on APKMirror. Available: ${found}`);
}

module.exports = {
  buildVariantPriorities,
  selectVariant,
};
