#!/usr/bin/env node
'use strict';

/**
 * validate-config.js — schema gate for config.json.
 *
 * The build pipeline previously had ZERO per-app validation between
 * `config.json` and the matrix spin-up. Adding a new app (typo'd slug,
 * wrong patch-repo, missing `apkmirror_path`) silently fell through to
 * a `Could not resolve a Morphe-supported version` or
 * `Chosen APK has no classes.dex` failure an hour into the build.
 *
 * This script makes those mistakes impossible to merge: every PR that
 * touches `config.json` runs this as a CI step, and any error here
 * fails the PR check before it can be merged.
 *
 * Pure logic (validateConfig) is exported so the jest test suite can
 * exercise every rule without spinning up Node child processes or
 * touching disk. The CLI wrapper at the bottom of this file just
 * shells out to the pure function and formats the result for the
 * workflow log.
 *
 * What this validates:
 *   - Top-level shape: patch_repos (object, non-empty), cli.repo /
 *     cli.branch, preferred_arch (optional, known ABI).
 *   - Each per-app entry has name / repo / branch / apkmirror_path
 *     with the right shape.
 *   - pin_version / pin_patch_tag, when present, look like real
 *     version strings and tag strings (catches typos like "v1,18.3").
 *   - No duplicate `name` values (release-tag collisions) or
 *     duplicate `packageId` keys (the keyset already implies the
 *     latter, but spelled out for clarity).
 *   - No unknown top-level keys (typo guard for `pach_repos` etc.).
 *
 * What this does NOT validate (covered by Layer B / preflight-apps):
 *   - Whether the patch repo actually exists on GitHub.
 *   - Whether the app's package id appears in patches-list.json.
 *   - Whether APKMirror has a release for the resolved version.
 *
 * Exit code: 0 on success, 1 on any error (warnings don't fail).
 */

const fs = require('node:fs');

/** Known Android ABIs that AGENTS.md / unified-downloader.js accept. */
const KNOWN_ABIS = new Set([
  'arm64-v8a',
  'armeabi-v7a',
  'x86',
  'x86_64',
]);

/** Keys config.json may contain at the top level. Anything else is a typo. */
const KNOWN_TOP_LEVEL = new Set([
  'preferred_arch',
  'auto_update_urls',
  'patch_repos',
  'cli',
  'download_urls',
]);

/** Keys each per-app entry may contain. */
const KNOWN_APP_KEYS = new Set([
  'name',
  'repo',
  'branch',
  'apkmirror_path',
  'pin_version',
  'pin_patch_tag',
]);

/** owner/repo slug — used by every <owner>/<repo> entry. */
const REPO_RE = /^[^/\s]+\/[^/\s]+$/;

/** APKMirror path — `publisher/package-name`, no slashes beyond the one. */
const APK_PATH_RE = /^[^/\s]+\/[^/\s]+$/;

/** release-name / slug — lowercase letters, digits, hyphens. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Android package id — `com.example.foo`. At least one dot, each
 * segment starts with a letter, contains `[a-z0-9_]`. */
const PACKAGE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** Numeric `X[.Y[.Z...]]` — what `pin_version` should look like. */
const PIN_VERSION_RE = /^\d+(\.\d+)+$/;

/** `v` followed by digits + dots, OR just digits + dots. Matches both
 * `v1.18.3` and `1.18.3`. The leading `v` is optional because some
 * patch repos tag their releases without it. */
const PIN_TAG_RE = /^v?\d+(\.\d+)+([-.+][\w.-]+)?$/;

/** `validateConfig` returns an array of `{ level, appId, message }`.
 * `level` is `'error'` (fails the build) or `'warning'`
 * (logged but doesn't fail). Pure function — no I/O, no globals. */
function validateConfig(config) {
  const issues = [];

  // --- top-level shape --------------------------------------------------
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    issues.push({
      level: 'error',
      appId: null,
      message: 'config.json must be a JSON object at the top level.',
    });
    return issues;
  }

  for (const key of Object.keys(config)) {
    if (!KNOWN_TOP_LEVEL.has(key)) {
      issues.push({
        level: 'warning',
        appId: null,
        message:
          `Unknown top-level key "${key}". ` +
          `Did you mean one of: ${[...KNOWN_TOP_LEVEL].join(', ')}?`,
      });
    }
  }

  if ('preferred_arch' in config && !KNOWN_ABIS.has(config.preferred_arch)) {
    issues.push({
      level: 'error',
      appId: null,
      message:
        `preferred_arch "${config.preferred_arch}" is not a known Android ABI. ` +
        `Expected one of: ${[...KNOWN_ABIS].join(', ')}.`,
    });
  }

  if ('auto_update_urls' in config && typeof config.auto_update_urls !== 'boolean') {
    issues.push({
      level: 'error',
      appId: null,
      message: `auto_update_urls must be a boolean (got ${typeof config.auto_update_urls}).`,
    });
  }

  // --- cli ---------------------------------------------------------------
  if (!config.cli || typeof config.cli !== 'object') {
    issues.push({
      level: 'error',
      appId: null,
      message: "config.json is missing 'cli' (with .repo and .branch).",
    });
  } else {
    if (typeof config.cli.repo !== 'string' || !REPO_RE.test(config.cli.repo)) {
      issues.push({
        level: 'error',
        appId: null,
        message:
          `cli.repo must be an "owner/repo" slug ` +
          `(no slashes, no whitespace). Got: ${JSON.stringify(config.cli.repo)}.`,
      });
    }
    if (typeof config.cli.branch !== 'string' || !config.cli.branch) {
      issues.push({
        level: 'error',
        appId: null,
        message: 'cli.branch must be a non-empty string ("main" or "dev").',
      });
    } else if (!['main', 'dev'].includes(config.cli.branch.toLowerCase())) {
      issues.push({
        level: 'error',
        appId: null,
        message:
          `cli.branch must be "main" or "dev" ` +
          `(got "${config.cli.branch}"). Other branches aren't ` +
          `supported by resolve-tag.sh.`,
      });
    }
  }

  // --- patch_repos -------------------------------------------------------
  if (!config.patch_repos || typeof config.patch_repos !== 'object' || Array.isArray(config.patch_repos)) {
    issues.push({
      level: 'error',
      appId: null,
      message: "config.json is missing or invalid 'patch_repos' (must be a non-empty object).",
    });
    return issues;
  }
  const appIds = Object.keys(config.patch_repos);
  if (appIds.length === 0) {
    issues.push({
      level: 'error',
      appId: null,
      message: "'patch_repos' is empty. Add at least one app entry.",
    });
  }

  const seenNames = new Map(); // name -> first appId using it
  for (const appId of appIds) {
    const entry = config.patch_repos[appId];

    if (!PACKAGE_ID_RE.test(appId)) {
      issues.push({
        level: 'error',
        appId,
        message:
          `package id "${appId}" doesn't look like a valid Android ` +
          `package (expected com.example.foo — lowercase letters, ` +
          `digits, underscores, at least one dot).`,
      });
    }

    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({
        level: 'error',
        appId,
        message: `patch_repos["${appId}"] must be a JSON object.`,
      });
      continue;
    }

    for (const key of Object.keys(entry)) {
      if (!KNOWN_APP_KEYS.has(key)) {
        issues.push({
          level: 'warning',
          appId,
          message:
            `Unknown key "${key}" under patch_repos["${appId}"]. ` +
            `Did you mean one of: ${[...KNOWN_APP_KEYS].join(', ')}?`,
        });
      }
    }

    // name
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      issues.push({
        level: 'error',
        appId,
        message: `patch_repos["${appId}"].name is required (used in release tags like "<name>-v<ver>-<patches>").`,
      });
    } else if (!NAME_RE.test(entry.name)) {
      issues.push({
        level: 'error',
        appId,
        message:
          `name "${entry.name}" must match ${NAME_RE} ` +
          `(lowercase letters, digits, hyphens — used directly in ` +
          `GitHub release tags).`,
      });
    } else {
      const prior = seenNames.get(entry.name);
      if (prior !== undefined) {
        issues.push({
          level: 'error',
          appId,
          message:
            `Duplicate name "${entry.name}" (also used by "${prior}"). ` +
            `Release tags would collide.`,
        });
      } else {
        seenNames.set(entry.name, appId);
      }
    }

    // repo
    if (typeof entry.repo !== 'string' || !REPO_RE.test(entry.repo)) {
      issues.push({
        level: 'error',
        appId,
        message:
          `repo must be an "owner/repo" slug ` +
          `(no slashes, no whitespace). Got: ${JSON.stringify(entry.repo)}.`,
      });
    }

    // branch
    if (typeof entry.branch !== 'string' || entry.branch.length === 0) {
      issues.push({
        level: 'error',
        appId,
        message: `branch is required (e.g. "main" or "dev").`,
      });
    } else if (!/^[A-Za-z0-9._/-]+$/.test(entry.branch)) {
      issues.push({
        level: 'error',
        appId,
        message:
          `branch "${entry.branch}" contains characters that aren't ` +
          `legal in a git ref.`,
      });
    }

    // apkmirror_path
    if (typeof entry.apkmirror_path !== 'string' || entry.apkmirror_path.length === 0) {
      issues.push({
        level: 'error',
        appId,
        message:
          `apkmirror_path is required (the APKMirror URL slug for this ` +
          `package, e.g. "google-inc/youtube").`,
      });
    } else if (!APK_PATH_RE.test(entry.apkmirror_path)) {
      issues.push({
        level: 'error',
        appId,
        message:
          `apkmirror_path "${entry.apkmirror_path}" must look like ` +
          `"publisher-slug/package-slug" (no slashes beyond the ` +
          `separator, no whitespace).`,
      });
    }

    // pin_version
    if ('pin_version' in entry) {
      if (typeof entry.pin_version !== 'string' || !PIN_VERSION_RE.test(entry.pin_version)) {
        issues.push({
          level: 'error',
          appId,
          message:
            `pin_version "${entry.pin_version}" must be a numeric ` +
            `version like "20.44.38" or "26.07.27" (digits + dots).`,
        });
      }
    }

    // pin_patch_tag
    if ('pin_patch_tag' in entry) {
      if (typeof entry.pin_patch_tag !== 'string' || !PIN_TAG_RE.test(entry.pin_patch_tag)) {
        issues.push({
          level: 'error',
          appId,
          message:
            `pin_patch_tag "${entry.pin_patch_tag}" must look like a ` +
            `release tag, e.g. "v1.18.3" or "v1.24.0-dev.8".`,
        });
      }
    }
  }

  // --- download_urls (loose shape check) --------------------------------
  if ('download_urls' in config && config.download_urls !== null) {
    if (typeof config.download_urls !== 'object' || Array.isArray(config.download_urls)) {
      issues.push({
        level: 'error',
        appId: null,
        message: 'download_urls must be an object keyed by package id (or absent).',
      });
    } else {
      for (const [pkgId, urls] of Object.entries(config.download_urls)) {
        if (typeof urls !== 'object' || urls === null || Array.isArray(urls)) {
          issues.push({
            level: 'error',
            appId: pkgId,
            message: `download_urls["${pkgId}"] must be an object of {version: url}.`,
          });
        }
      }
    }
  }

  return issues;
}

// --- CLI wrapper ----------------------------------------------------------

function formatIssue(issue) {
  const where = issue.appId ? `${issue.appId}` : '<top-level>';
  const tag = issue.level === 'error' ? '::error::' : '::warning::';
  return `${tag}[${where}] ${issue.message}`;
}

if (require.main === module) {
  const configPath = process.argv[2] || './config.json';
  if (!fs.existsSync(configPath)) {
    console.error(`::error::config file not found: ${configPath}`);
    process.exit(1);
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`::error::${configPath} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  const issues = validateConfig(config);
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.level === 'error') errors++; else warnings++;
    console.error(formatIssue(issue));
  }
  if (errors > 0) {
    console.error(`\n::error::${errors} error(s), ${warnings} warning(s) in ${configPath}`);
    process.exit(1);
  }
  if (warnings > 0) {
    console.error(`\n::notice::${warnings} warning(s) in ${configPath}`);
  }
  process.exit(0);
}

module.exports = {
  validateConfig,
  KNOWN_ABIS,
  KNOWN_TOP_LEVEL,
  KNOWN_APP_KEYS,
  REPO_RE,
  APK_PATH_RE,
  NAME_RE,
  PACKAGE_ID_RE,
  PIN_VERSION_RE,
  PIN_TAG_RE,
};