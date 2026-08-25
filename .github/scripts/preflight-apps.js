#!/usr/bin/env node
'use strict';

/**
 * preflight-apps.js — per-app validation before the matrix spins up.
 *
 * For every (appId, patchRepo, tag) tuple derived from config.json +
 * the tags resolved by check_versions.sh, fetch the upstream
 * `patches-list.json` at that tag and verify:
 *
 *   1. The tag exists upstream (the fetch itself doesn't 404).
 *   2. The `compatiblePackages` / `compatible_packages` array lists
 *      the app's package id (so `morphe-desktop list-versions -f <pkg>`
 *      won't return an empty list and trip the
 *      "Could not resolve a Morphe-supported version" hard-fail
 *      mid-build).
 *
 * This is Layer B of the "adding a new app must just work" robustness
 * fix. Without it, an upstream patch repo rename or a typo in the
 * package id surfaces as a hard fail 30 minutes into the build, with
 * the operator none the wiser about which app is the cause.
 *
 * Network is abstracted through `fetchImpl` (defaults to global
 * `fetch`) so the jest suite can stub it. The pure function
 * `preflight(config, repoVersions, fetchImpl)` returns:
 *
 *   {
 *     rows:     [{appId, name, repo, tag, pkgListed, fetchOk, error?}, ...],
 *     errors:   [{appId, message}, ...],
 *     warnings: [{appId, message}, ...],
 *   }
 *
 * Per (repo, tag) we cache one patches-list.json response across all
 * apps that share the (repo, tag), so a config with N apps on M repos
 * — and apps with mixed pin_patch_tag overrides — does exactly the
 * minimum number of upstream GETs.
 *
 * CLI: reads $CONFIG_FILE + $REPO_VERSIONS from env, calls `preflight`,
 * writes a markdown table to $GITHUB_STEP_SUMMARY, prints one log
 * line per row, and exits non-zero on any error.
 */

const fs = require('node:fs');

const RAW_BASE = 'https://raw.githubusercontent.com';

/**
 * Extract package id names from a single patch entry's compatiblePackages.
 * Mirrors the COMPAT_FN in sync-patches.sh so the shell pipeline and
 * this Node pre-flight agree on which package IDs a patch supports.
 * Handles four historical shapes:
 *   1. compatiblePackages as object (old): keys ARE the package IDs.
 *   2. compatible_packages as object (old): keys ARE the package IDs.
 *   3. compatiblePackages as array (current): each entry has .name
 *      AND .packageName — return both.
 *   4. compatible_packages as array: same as #3.
 */
function compatPkgNames(patch) {
  if (!patch || typeof patch !== 'object') return [];
  const keys = ['compatiblePackages', 'compatible_packages'];
  for (const k of keys) {
    const v = patch[k];
    if (!v) continue;
    if (Array.isArray(v)) {
      return [...new Set(
        v.flatMap((e) => (e && typeof e === 'object' ? [e.name, e.packageName] : []))
          .filter((s) => typeof s === 'string' && s.length > 0),
      )];
    }
    if (typeof v === 'object') {
      return Object.keys(v);
    }
  }
  return [];
}

/**
 * Walk patches-list.json and return the set of all package ids listed
 * under any patch's compatiblePackages. Tolerates all four historical
 * shapes via compatPkgNames().
 */
function collectPkgIds(patchesList) {
  const set = new Set();
  const patches = Array.isArray(patchesList) ? patchesList : (patchesList.patches || []);
  for (const patch of patches) {
    for (const name of compatPkgNames(patch)) set.add(name);
  }
  return set;
}

/**
 * Pure: for each (repo, tag) tuple in `repoVersions`, build a row per
 * app assigned to that repo. Caches patches-list.json per (repo, tag)
 * so we fetch each upstream URL at most once regardless of app count.
 *
 * `fetchImpl(url) -> Promise<{ok:boolean, status:number, json:any}>`
 * is the network abstraction. Tests pass a stub; production uses
 * global `fetch`.
 */
async function preflight({ config, repoVersions, fetchImpl = fetch }) {
  const rows = [];
  const errors = [];
  const warnings = [];

  if (!config || !config.patch_repos || typeof config.patch_repos !== 'object') {
    errors.push({ appId: null, message: 'config.patch_repos missing or invalid.' });
    return { rows, errors, warnings };
  }

  // Group apps by repo so we can dedupe upstream fetches.
  const appsByRepo = new Map(); // repo -> [{appId, entry, tag}]
  for (const [appId, entry] of Object.entries(config.patch_repos)) {
    const repo = entry.repo;
    // pin_patch_tag overrides the resolved tag for this app's repo
    // (mirror check_versions.sh lines 63-69).
    const effectiveTag = entry.pin_patch_tag || repoVersions[repo] || '';
    if (!appsByRepo.has(repo)) appsByRepo.set(repo, []);
    appsByRepo.get(repo).push({ appId, entry, tag: effectiveTag });
  }

  // Per-(repo, tag) patches-list.json cache: key by "repo|tag" so two
  // apps on the same repo with different pin_patch_tag values get
  // independent fetches.
  const listCache = new Map();

  async function loadList(repo, tag) {
    const cacheKey = `${repo}|${tag}`;
    if (listCache.has(cacheKey)) return listCache.get(cacheKey);
    if (!tag) {
      const p = Promise.resolve({
        ok: false, status: 0, json: null,
        error: `No resolved tag for ${repo}`,
      });
      listCache.set(cacheKey, p);
      return p;
    }
    const url = `${RAW_BASE}/${repo}/${tag}/patches-list.json`;
    const p = (async () => {
      try {
        const resp = await fetchImpl(url);
        if (!resp || !resp.ok) {
          return {
            ok: false, status: resp ? resp.status : 0, json: null,
            error: `HTTP ${resp ? resp.status : 'no response'} fetching ${url}`,
          };
        }
        const json = await resp.json();
        return { ok: true, status: resp.status, json, error: null };
      } catch (e) {
        return { ok: false, status: 0, json: null, error: `${e.message} fetching ${url}` };
      }
    })();
    listCache.set(cacheKey, p);
    return p;
  }

  for (const [repo, apps] of appsByRepo) {
    // Group apps by their *effective* tag so apps with different
    // pin_patch_tag values on the same repo don't share a fetch.
    const appsByTag = new Map();
    for (const a of apps) {
      const t = a.tag;
      if (!appsByTag.has(t)) appsByTag.set(t, []);
      appsByTag.get(t).push(a);
    }

    for (const [tag, group] of appsByTag) {
      const listResult = await loadList(repo, tag);
      const pkgIdsInList = listResult.ok && listResult.json
        ? collectPkgIds(listResult.json)
        : new Set();

      for (const { appId, entry, tag: appTag } of group) {
        const pkgListed = listResult.ok
          ? pkgIdsInList.has(appId)
          : null; // null = unknown (fetch failed)

        let error;
        if (!listResult.ok) {
          error = listResult.error;
          errors.push({
            appId,
            message:
              `[${repo}@${tag}] could not fetch patches-list.json: ${listResult.error}. ` +
              `Either the tag doesn't exist upstream or GitHub is rate-limiting. ` +
              `Run \`gh release view --repo ${repo} --json tagName\` to verify the tag.`,
          });
        } else if (!pkgListed) {
          const sample = [...pkgIdsInList].slice(0, 5).join(', ') || '(none)';
          error = `package id "${appId}" not listed in ${repo}@${tag}'s patches-list.json ` +
                  `(sample of what IS listed: ${sample}). ` +
                  `Did you typo the package id, or does the patch repo not yet ship patches for it?`;
          errors.push({ appId, message: error });
        }

        rows.push({
          appId,
          name: entry.name || '',
          repo,
          tag: appTag,
          pkgListed: pkgListed === null ? '?' : pkgListed ? 'yes' : 'NO',
          fetchOk: listResult.ok ? 'yes' : 'NO',
          error,
        });
      }
    }
  }

  return { rows, errors, warnings };
}

/**
 * Render rows as a GitHub-flavored markdown table suitable for
 * $GITHUB_STEP_SUMMARY. Pure — does not include the section heading;
 * the CLI wrapper writes that.
 */
function renderTable(rows) {
  if (rows.length === 0) return '_(no apps configured)_';
  const header = '| app | name | repo | pkg listed | upstream fetch |\n'
    + '|---|---|---|---|---|';
  const body = rows.map((r) =>
    `| ${r.appId} | ${r.name} | ${r.repo}@${r.tag} | ${r.pkgListed} | ${r.fetchOk}`
    + `${r.error ? `<br/>:warning: ${r.error.replace(/\|/g, '\\|')}` : ''} |`,
  ).join('\n');
  return `${header}\n${body}`;
}

// --- CLI wrapper ----------------------------------------------------------

if (require.main === module) {
  const configPath = process.env.CONFIG_FILE || './config.json';
  const repoVersionsJson = process.env.REPO_VERSIONS || '{}';
  const summaryPath = process.env.GITHUB_STEP_SUMMARY || '';

  if (!fs.existsSync(configPath)) {
    console.error(`::error::config file not found: ${configPath}`);
    process.exit(1);
  }

  let config;
  let repoVersions;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`::error::${configPath} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  try {
    repoVersions = JSON.parse(repoVersionsJson);
  } catch (e) {
    console.error(`::error::REPO_VERSIONS env is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  preflight({ config, repoVersions }).then(({ rows, errors, warnings }) => {
    // Log a one-line-per-app summary to the workflow log.
    for (const r of rows) {
      const tag = r.error ? '::error::' : '';
      console.error(`${tag}[${r.appId}] ${r.repo}@${r.tag} pkg=${r.pkgListed} fetch=${r.fetchOk}`);
    }
    for (const e of errors) {
      console.error(`::error::[${e.appId || '<top-level>'}] ${e.message}`);
    }
    for (const w of warnings) {
      console.error(`::warning::[${w.appId || '<top-level>'}] ${w.message}`);
    }

    if (summaryPath) {
      try {
        fs.appendFileSync(summaryPath,
          `\n## App preflight\n\n${renderTable(rows)}\n\n` +
          (errors.length > 0 ? `**${errors.length} error(s)** — see workflow log.\n` : ''),
        );
      } catch (e) {
        console.error(`::warning::could not write $GITHUB_STEP_SUMMARY (${e.message})`);
      }
    }

    if (errors.length > 0) {
      console.error(`\n::error::preflight: ${errors.length} error(s). See table above.`);
      process.exit(1);
    }
    process.exit(0);
  }).catch((e) => {
    console.error(`::error::preflight threw: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  preflight,
  compatPkgNames,
  collectPkgIds,
  renderTable,
};