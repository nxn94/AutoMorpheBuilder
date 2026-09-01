'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cheerio = require('cheerio');
const {
  buildVariantPriorities,
  selectVariant,
} = require('../../../.github/scripts/unified-downloader');

const fixtureDir = __dirname;

function readFixture(name) {
  return fs.readFileSync(path.join(fixtureDir, '..', 'apkmirror', name), 'utf8');
}

function parseApkmirrorFixture({ preferredArch = 'arm64-v8a' } = {}) {
  const allVersionsHtml = readFixture('all-versions.html');
  if (!allVersionsHtml.includes('20-44-38-release/')) {
    throw new Error('Sanitized APKMirror all-versions fixture is missing the release link');
  }

  const releaseHtml = readFixture('release.html');
  const variantHtml = readFixture('variant.html');
  const downloadHtml = readFixture('download.html');
  const release = cheerio.load(releaseHtml);
  const variantHref = selectVariant(
    release,
    buildVariantPriorities(preferredArch),
  );

  const variant = cheerio.load(variantHtml);
  if (!variantHref || !variant('a.downloadButton[href]').attr('href')) {
    throw new Error('Sanitized APKMirror fixture is missing a variant download link');
  }

  const download = cheerio.load(downloadHtml);
  const finalHref = download('#download-link[href]').attr('href');
  if (!finalHref) {
    throw new Error('Sanitized APKMirror fixture is missing a final download link');
  }
  return finalHref;
}

module.exports = { parseApkmirrorFixture, readFixture };
