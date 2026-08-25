#!/usr/bin/env node
'use strict';

/**
 * compat-probe.js — actually invoke morphe-desktop per app to catch
 * bytecode-class API mismatches that the cheap patches-list.json check
 * can't.
 *
 * The matrix filter step (`check_existing_releases.js`) and the
 * pre-download step (`pre_download_apks.sh`) both shell out to
 * `morphe-desktop.jar list-versions -f <appId> --patches=<mpp>` per
 * app. If the patches .mpp was compiled against a newer morphe-patcher
 * than the morphe-desktop CLI jar ships with (e.g. hoo-dles patches
 * using `extendWithAll(Supplier)` against a morphe-desktop v1.13.0 /
 * v1.13.1 jar that doesn't yet have that method), the JVM throws
 * `NoSuchMethodError` during class init — surfacing as a cryptic
 * "Could not resolve a Morphe-supported version" 30 minutes into the
 * build, with no indication of which app or which class was the
 * trigger.
 *
 * This probe runs the same `list-versions` call once per app right
 * after `download_morphe_tools.sh`, parses stderr for the well-known
 * failure modes (NoSuchMethodError, NoClassDefFoundError, LinkageError,
 * IncompatibleClassChangeError, VerifyError), and emits:
 *
 *   - One log line per app (OK / API mismatch: <method> / FAIL: <reason>)
 *   - A markdown table to $GITHUB_STEP_SUMMARY
 *   - `::error::` lines naming the missing morphe-patcher method
 *     and the offending patches tag, so the operator immediately
 *     knows to either (a) bump `cli.branch` to a release that ships
 *     the new patcher or (b) pin `pin_patch_tag` to an older release
 *     that doesn't use the new API.
 *
 * Exit code: 0 if every app's patches load cleanly; 1 on any
 * bytecode-class mismatch (always fatal — those won't fix themselves
 * downstream); 1 on any non-empty per-app failure (a less specific
 * class of error, but better to fail fast than to discover it 30 min
 * later in the matrix).
 *
 * Pure logic (`probe(config, repoVersions, execImpl)`) is exported for
 * unit testing with a stubbed exec. The CLI wrapper at the bottom
 * shells out to the pure function.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

// Regexes for the well-known "patch was compiled against a newer
// patcher than the CLI ships" errors. Each match captures the missing
// method name (group 1) or class name when useful.
const API_MISSING_PATTERNS = [
  // Patch bytecode calls a method the runtime jar doesn't ship.
  { re: /NoSuchMethodError:.*?\.(\w+)\(/, label: 'NoSuchMethodError' },
  // Patch bytecode references a class the runtime jar doesn't ship.
  { re: /NoClassDefFoundError:.*?L?([\w$/]+);/, label: 'NoClassDefFoundError' },
  // Patch class extends/depends on something the runtime jar
  // removed or changed incompatibly.
  { re: /IncompatibleClassChangeError/, label: 'IncompatibleClassChangeError' },
  // Bytecode verification failed (usually means the runtime is older
  // than what the patch was compiled against).
  { re: /VerifyError/, label: 'VerifyError' },
  // Generic link failure for native / abstract mismatches.
  { re: /LinkageError/, label: 'LinkageError' },
];

/**
 * Pure: classify the stderr string from a `java -jar ... list-versions`
 * invocation into one of: 'api-mismatch' (with the missing symbol),
 * 'other-error', or null (no fatal error).
 */
function classifyStderr(stderr) {
  if (!stderr) return null;
  for (const { re, label } of API_MISSING_PATTERNS) {
    const m = stderr.match(re);
    if (m) {
      return {
        kind: 'api-mismatch',
        error: label,
        symbol: m[1] || null,
      };
    }
  }
  // Anything else with stderr is a non-fatal-classification failure
  // (network, malformed JSON, etc.). The caller surfaces it as an
  // error but doesn't claim it's a patcher-API mismatch.
  if (/Exception|Error|FAIL/.test(stderr)) {
    return { kind: 'other-error', error: 'unknown', symbol: null };
  }
  return null;
}

/**
 * Pure: for each (appId, repo, tag) tuple, run `java -jar morphe-desktop.jar
 * list-versions -f <appId> --patches=<mpp>`. Returns a row per app.
 *
 * `execImpl(cmd, args, opts)` defaults to child_process.execFile. Tests
 * pass a stub. The 30s timeout matches the user's worst-case cold-start
 * for a fresh `morphe-desktop.jar` (mostly JVM warmup).
 */
async function probe({ config, repoVersions, toolsDir = './tools', execImpl = execFileAsync }) {
  const rows = [];

  if (!config || !config.patch_repos || typeof config.patch_repos !== 'object') {
    rows.push({
      appId: null,
      error: 'config.patch_repos missing or invalid.',
    });
    return rows;
  }

  const jarPath = path.join(toolsDir, 'morphe-desktop.jar');
  const jarExists = fs.existsSync(jarPath);
  if (!jarExists) {
    rows.push({
      appId: null,
      error: `${jarPath} not found; cannot probe. download_morphe_tools.sh must run first.`,
    });
    return rows;
  }

  for (const [appId, entry] of Object.entries(config.patch_repos)) {
    const repo = entry.repo;
    const tag = entry.pin_patch_tag || repoVersions[repo] || '';
    const mppPath = path.join(toolsDir, `${repo.replace(/\//g, '-')}.mpp`);
    const mppExists = fs.existsSync(mppPath);

    if (!mppExists) {
      rows.push({
        appId,
        repo,
        tag,
        status: 'NO_MPP',
        error: `patches mpp missing: ${mppPath}`,
      });
      continue;
    }

    const cmd = 'java';
    const args = [
      '-jar', jarPath,
      'list-versions',
      '-f', appId,
      `--patches=${mppPath}`,
    ];

    try {
      const out = await execImpl(cmd, args, {
        timeout: 30_000,
        // Capture stderr only — stdout is the version list, which we
        // don't need for the probe. Separating them keeps the
        // classification regex focused on errors.
        windowsHide: true,
      });
      // Successful exit: even if list-versions returned zero versions,
      // the patches loaded cleanly. Anything we want to flag is in
      // stderr.
      const stderr = (out && out.stderr) || '';
      rows.push({
        appId,
        repo,
        tag,
        status: stderr ? 'STDOUT_ERROR' : 'OK',
        symbol: null,
        error: stderr ? stderr.trim().split('\n').slice(0, 3).join(' | ') : null,
      });
    } catch (e) {
      // Some failures exit non-zero without writing stderr that the
      // promisified execFile forwards (older Node + ENOENT, etc.).
      const rawStderr = (e && e.stderr) || (e && e.message) || String(e);
      const cls = classifyStderr(rawStderr);
      if (cls && cls.kind === 'api-mismatch') {
        rows.push({
          appId,
          repo,
          tag,
          status: 'API_MISMATCH',
          symbol: cls.symbol,
          error: cls.error,
        });
      } else {
        rows.push({
          appId,
          repo,
          tag,
          status: 'FAIL',
          symbol: null,
          error: rawStderr.trim().split('\n').slice(0, 3).join(' | '),
        });
      }
    }
  }

  return rows;
}

/**
 * Render rows as a markdown table for $GITHUB_STEP_SUMMARY. Pure.
 */
function renderTable(rows) {
  if (rows.length === 0) return '_(no apps)_';
  const header = '| app | repo | status | detail |\n|---|---|---|---|';
  const escapeMd = (s) => String(s || '')
    // Backslashes first so the pipe-escape below doesn't re-escape them.
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
  const body = rows.map((r) => {
    if (r.appId === null) {
      return `| _config_ | _-_ | _ERROR_ | ${escapeMd(r.error)} |`;
    }
    const detail = (r.symbol ? `missing \`${r.symbol}\` ` : '') + escapeMd(r.error);
    return `| ${r.appId} | ${r.repo}@${r.tag || '?'} | ${r.status} | ${detail} |`;
  }).join('\n');
  return `${header}\n${body}`;
}

// --- CLI wrapper ----------------------------------------------------------

if (require.main === module) {
  const configPath = process.env.CONFIG_FILE || './config.json';
  const repoVersionsJson = process.env.REPO_VERSIONS || '{}';
  const summaryPath = process.env.GITHUB_STEP_SUMMARY || '';
  const toolsDir = process.env.TOOLS_DIR || './tools';

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

  probe({ config, repoVersions, toolsDir }).then((rows) => {
    let errors = 0;
    for (const r of rows) {
      if (r.appId === null) {
        console.error(`::error::[config] ${r.error}`);
        errors++;
        continue;
      }
      const tag = r.status === 'OK' ? '' : '::error::';
      console.error(`${tag}[${r.appId}] ${r.repo}@${r.tag} ${r.status} ${r.symbol || r.error || ''}`.trimEnd());
      if (r.status !== 'OK') errors++;
    }

    if (summaryPath) {
      try {
        fs.appendFileSync(summaryPath,
          `\n## Patch compat probe\n\n${renderTable(rows)}\n\n`,
        );
      } catch (e) {
        console.error(`::warning::could not write $GITHUB_STEP_SUMMARY (${e.message})`);
      }
    }

    if (errors > 0) {
      const apiMismatch = rows.filter((r) => r.status === 'API_MISMATCH');
      if (apiMismatch.length > 0) {
        console.error('');
        console.error(
          `::error::${apiMismatch.length} app(s) hit patcher-API mismatches against morphe-desktop. ` +
          `This is exactly the v1.13.0/1 -> v1.13.2 issue: the patches at these repos were built ` +
          `against a newer morphe-patcher than the cached CLI jar carries. Fix by either:`,
        );
        console.error(
          `::error::  1. bump cli (e.g. switch cli.branch to a release that ships the newer patcher), OR`,
        );
        console.error(
          `::error::  2. pin each affected app to an older patch tag that doesn't use the missing API ` +
          `(e.g. pin_patch_tag: "<older tag>").`,
        );
      }
      process.exit(1);
    }
    process.exit(0);
  }).catch((e) => {
    console.error(`::error::probe threw: ${e.stack || e.message}`);
    process.exit(1);
  });
}

module.exports = {
  probe,
  classifyStderr,
  renderTable,
  API_MISSING_PATTERNS,
};