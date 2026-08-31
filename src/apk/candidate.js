'use strict';

/**
 * Uniform APK candidate shape used by every resolver in the build pipeline.
 *
 * Every resolver function (`resolveApkeep`, `resolveApkmirrorApi`,
 * `resolveApkmirror`, ...) must return one or more candidates produced
 * by `createCandidate(input)`. Centralizing the shape means the
 * downstream ranking, selection, and validation code can rely on a
 * single set of fields.
 *
 * Optional fields default to safe sentinels so consumers don't have to
 * handle `undefined` in hot loops:
 *   - `versionName`, `versionCode`: `null`
 *   - `architecture`, `dpi`, `format`: `'unknown'`
 *   - `sizeBytes`: `null`
 *   - `variantLabel`: `null`
 *   - `metadata`: `{}`
 */

const SUPPORTED_FORMATS = new Set([
  'apk',
  'xapk',
  'apkm',
  'apks',
]);

function createCandidate(input) {
  const candidate = {
    source: input.source,
    url: input.url,
    packageName: input.packageName,
    versionName: input.versionName ?? null,
    versionCode: input.versionCode ?? null,
    architecture: input.architecture ?? 'unknown',
    dpi: input.dpi ?? 'unknown',
    format: input.format ?? 'unknown',
    sizeBytes: input.sizeBytes ?? null,
    variantLabel: input.variantLabel ?? null,
    metadata: input.metadata ?? {},
  };

  if (!candidate.source) {
    throw new TypeError('Candidate source is required');
  }

  if (!candidate.url) {
    throw new TypeError('Candidate URL is required');
  }

  if (!candidate.packageName) {
    throw new TypeError('Candidate packageName is required');
  }

  if (
    candidate.format !== 'unknown' &&
    !SUPPORTED_FORMATS.has(candidate.format)
  ) {
    throw new TypeError(`Unsupported candidate format: ${candidate.format}`);
  }

  return Object.freeze(candidate);
}

module.exports = {
  createCandidate,
  SUPPORTED_FORMATS,
};