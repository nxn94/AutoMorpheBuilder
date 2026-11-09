#!/usr/bin/env node
'use strict';

/**
 * Plain reasons for a failed APK download or patch, as read from the tools' own
 * output, so the run's annotation says why and not only "exit code 1".
 */

const SOURCES = [
  { tag: 'apkeep', name: 'APKPure' },
  { tag: 'apkmirror-api', name: 'APKMirror API' },
  { tag: 'apkmirror', name: 'APKMirror' },
];

/** Pure. One short reason per source that was tried, from the downloader's stderr. */
function downloadReasons(stderr) {
  const lines = String(stderr || '').split('\n');
  const out = [];
  for (const { tag, name } of SOURCES) {
    const marker = `[${tag}] Failed: `;
    const whys = lines.filter((l) => l.includes(marker)).map((l) => l.slice(l.indexOf(marker) + marker.length).trim());
    if (!whys.length) continue;
    // APKPure logs the real cause, then always rethrows "version not available".
    const generic = (w) => /version not available/i.test(w);
    const why = [...whys].reverse().find((w) => !generic(w)) || whys[whys.length - 1];
    if (/not set/i.test(why)) continue; // not configured, so never really tried
    if (generic(why)) out.push(`${name} doesn't have this version`);
    else if (/cloudflare/i.test(why)) out.push(`${name} blocked the runner (Cloudflare)`);
    else out.push(`${name} failed (${why.slice(0, 160)})`);
  }
  return out;
}

/** Pure. The GitHub annotation for a failed patch log, or null if the log gives no reason. */
function patchFailureAnnotation(log) {
  const lines = String(log || '').split('\n');
  const last = (re) => lines.filter((l) => re.test(l)).pop();
  const caused = last(/Caused by: .*PatchException: /);
  const aborted = last(/ERROR: Patching aborted/);
  const why = caused ? caused.replace(/^.*PatchException: /, '') : aborted && aborted.replace(/^.*ERROR: /, '');
  if (!why) return null;
  // Commas and colons would end the title property.
  const failed = lines.filter((l) => /ERROR: Failed: /.test(l))
    .map((l) => l.replace(/^.*ERROR: Failed: /, '').replace(/[,:%]/g, '').trim()).join('; ');
  return `::error title=Patch failed${failed ? ` (${failed})` : ''}::${why.trim().replace(/%/g, '%25')}`;
}

if (require.main === module) {
  const annotation = patchFailureAnnotation(require('node:fs').readFileSync(process.argv[2], 'utf8'));
  if (annotation) console.log(annotation);
}

module.exports = { downloadReasons, patchFailureAnnotation };
