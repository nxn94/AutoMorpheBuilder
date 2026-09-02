#!/usr/bin/env node
'use strict';

/**
 * generate-readme-tables.js — pure logic for the README table generator.
 *
 * Produces two markdown tables from `config.json patch_repos`:
 *   1. "Tested apps" — App | Package | Patch repo
 *   2. "Releases & Obtainium" — App | Release Tag Filter | Add to Obtainium
 *
 * The Obtainium "Add to" column reproduces the exact deep-link structure
 * hardcoded in README.md historically (verify against the 8 existing
 * entries; the byte-for-byte test in `__tests__/generate-readme-tables.test.js`
 * pins the encoding so a future refactor cannot silently change it).
 *
 * URL construction (matches the existing hardcoded links):
 *   const settings = { ...27 fields, only `filterReleaseTitlesByRegEx`
 *                       varies per app... };
 *   const settingsStr = JSON.stringify(settings);     // (1) escaped quotes
 *   const outer = { id, url, author, name, preferredApkIndex: 0,
 *                   additionalSettings: settingsStr };
 *   const outerStr = JSON.stringify(outer);             // (2) escaped quotes
 *   const encoded = encodeURIComponent(outerStr);
 *   const url = `https://apps.obtainium.imranr.dev/redirect?r=` +
 *               `obtainium://app/${encoded}`;
 *
 * `obtainium://app/` is intentionally NOT URL-encoded — matches the
 * historical scheme byte-for-byte (the `r=` query parameter starts with
 * the literal scheme prefix; only the JSON payload after it is encoded).
 *
 * The display name falls back to a capitalised `name` when the
 * per-app entry doesn't set `display_name`, so adding a new app is
 * a one-edit affair (no hard-fail if the pretty name isn't picked).
 *
 * Pure logic only — no I/O. `scripts/generate-readme-tables.js` is the
 * CLI wrapper that reads config.json + README.md and writes back.
 */

const REPO = 'nxn94/AutoMorpheBuilder';
const REPO_RELEASES_URL = `https://github.com/${REPO}/releases`;
const REPO_AUTHOR = 'nxn94';
const OBTAINIUM_BADGE_IMG =
  'https://raw.githubusercontent.com/ImranR98/Obtainium/main/assets/graphics/badge_obtainium.png';

/**
 * Naive capitalisation fallback for apps that omit `display_name`.
 * 'nzb360' -> 'Nzb360', 'youtube' -> 'Youtube'. The intent is "renders
 * a less-ugly default until someone sets a display_name" — not "is a
 * proper title-caser", which is why this is intentionally dumb.
 */
function capitalizeFirst(str) {
  if (typeof str !== 'string' || str.length === 0) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Resolve the display name for one patch_repos entry. */
function displayNameFor(entry) {
  if (typeof entry.display_name === 'string' && entry.display_name.length > 0) {
    return entry.display_name;
  }
  return capitalizeFirst(entry.name);
}

/**
 * Build the 27-field additionalSettings object. Only
 * `filterReleaseTitlesByRegEx` varies per app; every other field is
 * the same constant block (matches the historical hardcoded links
 * byte-for-byte — verified by the golden-fixture test).
 */
function buildAdditionalSettings(name) {
  return {
    includePrereleases: false,
    fallbackToOlderReleases: true,
    filterReleaseTitlesByRegEx: `^${name}`,
    filterReleaseNotesByRegEx: '',
    verifyLatestTag: false,
    sortMethodChoice: 'date',
    useLatestAssetDateAsReleaseDate: false,
    releaseTitleAsVersion: false,
    trackOnly: false,
    versionExtractionRegEx: '',
    matchGroupToUse: '',
    versionDetection: true,
    releaseDateAsVersion: false,
    useVersionCodeAsOSVersion: false,
    apkFilterRegEx: '',
    invertAPKFilter: false,
    autoApkFilterByArch: true,
    appName: '',
    appAuthor: '',
    shizukuPretendToBeGooglePlay: false,
    allowInsecure: false,
    exemptFromBackgroundUpdates: false,
    skipUpdateNotifications: false,
    about: '',
    refreshBeforeDownload: false,
    includeZips: false,
    zippedApkFilterRegEx: '',
  };
}

/**
 * Build the Obtainium deep-link for one app.
 * Returns the FULL URL ready to drop into an `<a href="...">`.
 */
function obtainiumUrlFor(packageId, name, displayName) {
  const settings = buildAdditionalSettings(name);
  const settingsStr = JSON.stringify(settings);
  const outer = {
    id: packageId,
    url: REPO_RELEASES_URL,
    author: REPO_AUTHOR,
    name: displayName,
    preferredApkIndex: 0,
    additionalSettings: settingsStr,
  };
  const outerStr = JSON.stringify(outer);
  const encoded = encodeURIComponent(outerStr);
  return `https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/${encoded}`;
}

/** Format one row of the Tested apps table (returns Markdown row, no trailing newline). */
function testedAppsRow(packageId, entry) {
  const displayName = displayNameFor(entry);
  return `| ${displayName} | \`${packageId}\` | \`${entry.repo}\` |`;
}

/** Format one row of the Obtainium table. */
function obtainiumRow(packageId, entry) {
  const displayName = displayNameFor(entry);
  const url = obtainiumUrlFor(packageId, entry.name, displayName);
  const linkHtml = `<a href="${url}"><img src="${OBTAINIUM_BADGE_IMG}" alt="Add to Obtainium" height="50"></a>`;
  return `| ${displayName} | \`^${entry.name}\` | ${linkHtml} |`;
}

/**
 * Build the full "Tested apps" markdown block — header + separator + body.
 * No leading/trailing newline so callers can splice it into the marker block.
 */
function buildTestedAppsTable(config) {
  const appIds = Object.keys(config.patch_repos || {});
  const header = '| App | Package | Patch repo |';
  const separator = '|-----|---------|------------|';
  const body = appIds.map((id) => testedAppsRow(id, config.patch_repos[id]));
  return [header, separator, ...body].join('\n');
}

/**
 * Build the full "Releases & Obtainium" markdown block.
 */
function buildObtainiumTable(config) {
  const appIds = Object.keys(config.patch_repos || {});
  const header = '| App | Release Tag Filter | Add to Obtainium |';
  const separator = '|-----|--------------------|------------------|';
  const body = appIds.map((id) => obtainiumRow(id, config.patch_repos[id]));
  return [header, separator, ...body].join('\n');
}

/* ------------------------------------------------------------------ */
/* Marker-based splice into README.md                                  */
/* ------------------------------------------------------------------ */

const MARKER_TESTED_APPS_BEGIN = '<!-- BEGIN AUTOGENERATED: tested-apps -->';
const MARKER_TESTED_APPS_END = '<!-- END AUTOGENERATED: tested-apps -->';
const MARKER_OBTAINIUM_BEGIN = '<!-- BEGIN AUTOGENERATED: obtainium-table -->';
const MARKER_OBTAINIUM_END = '<!-- END AUTOGENERATED: obtainium-table -->';

/**
 * Splice generated tables into the README between markers.
 * Returns a new README string with both blocks replaced.
 * Throws if either marker pair is missing or malformed.
 */
function spliceReadmeBlocks(readmeText, testedAppsTable, obtainiumTable) {
  const replaced = readmeText
    .replace(
      new RegExp(`${MARKER_TESTED_APPS_BEGIN}[\\s\\S]*?${MARKER_TESTED_APPS_END}`),
      `${MARKER_TESTED_APPS_BEGIN}\n${testedAppsTable}\n${MARKER_TESTED_APPS_END}`,
    )
    .replace(
      new RegExp(`${MARKER_OBTAINIUM_BEGIN}[\\s\\S]*?${MARKER_OBTAINIUM_END}`),
      `${MARKER_OBTAINIUM_BEGIN}\n${obtainiumTable}\n${MARKER_OBTAINIUM_END}`,
    );
  if (!replaced.includes(MARKER_TESTED_APPS_BEGIN)) {
    throw new Error(
      `README is missing marker pair:\n  ${MARKER_TESTED_APPS_BEGIN}\n  ${MARKER_TESTED_APPS_END}`,
    );
  }
  if (!replaced.includes(MARKER_OBTAINIUM_BEGIN)) {
    throw new Error(
      `README is missing marker pair:\n  ${MARKER_OBTAINIUM_BEGIN}\n  ${MARKER_OBTAINIUM_END}`,
    );
  }
  return replaced;
}

/**
 * Build a textual diff for --check mode. Lightweight line-by-line diff
 * — sufficient for human review without bringing in a diff library.
 */
function lineDiff(expected, actual) {
  const e = expected.split('\n');
  const a = actual.split('\n');
  const max = Math.max(e.length, a.length);
  const out = [];
  let mismatches = 0;
  for (let i = 0; i < max; i++) {
    const el = e[i] ?? '<EOF>';
    const al = a[i] ?? '<EOF>';
    if (el !== al) {
      mismatches++;
      if (out.length < 200) {
        out.push(`@@ line ${i + 1} @@\n  - ${el}\n  + ${al}`);
      }
    }
  }
  if (out.length === 0) return 'no line-level differences found';
  const header = `${mismatches} line(s) differ (showing up to 200):`;
  return [header, ...out].join('\n');
}

module.exports = {
  // Pure logic — exported for tests.
  capitalizeFirst,
  displayNameFor,
  buildAdditionalSettings,
  obtainiumUrlFor,
  testedAppsRow,
  obtainiumRow,
  buildTestedAppsTable,
  buildObtainiumTable,
  spliceReadmeBlocks,
  lineDiff,
  // Constants — exported so the CLI wrapper and tests share the same strings.
  MARKER_TESTED_APPS_BEGIN,
  MARKER_TESTED_APPS_END,
  MARKER_OBTAINIUM_BEGIN,
  MARKER_OBTAINIUM_END,
  REPO,
  REPO_RELEASES_URL,
  REPO_AUTHOR,
  OBTAINIUM_BADGE_IMG,
};
