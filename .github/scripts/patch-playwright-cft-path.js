#!/usr/bin/env node
'use strict';

/**
 * Playwright Chrome-for-Testing (CFT) URL path patch.
 *
 * Why this exists:
 *   Playwright's chromium + chromium-headless-shell downloads use a path
 *   template of `builds/cft/${browserVersion}/${suffix}` that gets prefixed
 *   by the chosen mirror host. The default mirror (`cdn.playwright.dev`)
 *   serves that `builds/cft/...` path; the public Chrome-for-Testing
 *   GCS bucket (`storage.googleapis.com/chrome-for-testing-public`) does
 *   NOT — it uses `<version>/<suffix>` with no `builds/cft/` prefix.
 *
 *   When `PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST` (or the equivalent
 *   `PLAYWRIGHT_DOWNLOAD_HOST`) is set to the GCS bucket, the
 *   `builds/cft/` prefix breaks the URL and the download 404s.
 *
 * What this does:
 *   Hooks `Module._resolveFilename` so that when Node resolves
 *   `playwright-core/lib/server/registry/index.js`, we serve a
 *   patched sibling (`*.patched.js`) with the `builds/cft/` prefix
 *   stripped from the cft URL template. The original file is
 *   untouched; the patch is idempotent and cheap on re-runs.
 *
 * Usage:
 *   NODE_OPTIONS="--require=$GITHUB_WORKSPACE/.github/scripts/patch-playwright-cft-path.js" \
 *     npx playwright install chromium
 *
 * Notes:
 *   - This patches the cft template only. Other browsers (firefox,
 *     webkit) keep their default `builds/<browser>/%s/...` paths
 *     and are unaffected.
 *   - The patch is a no-op if the template is already updated
 *     upstream; the regex will simply not match.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const REGISTRY_PATH_FRAGMENT = path.join('playwright-core', 'lib', 'server', 'registry', 'index.js');
// Match the literal cft template: `builds/cft/${browserVersion}/${suffix}`
// Both `browserVersion` and `suffix` are template-literal substitutions, hence `\$\{...\}` in the regex.
const CFT_TEMPLATE_REGEX = /`builds\/cft\/\$\{browserVersion\}\/\$\{suffix\}`/g;
const PATCHED_TEMPLATE = '`${browserVersion}/${suffix}`';

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, parent, ...rest) {
  const resolved = origResolve.call(this, req, parent, ...rest);
  if (typeof resolved !== 'string' || !resolved.includes(REGISTRY_PATH_FRAGMENT)) {
    return resolved;
  }
  try {
    const original = fs.readFileSync(resolved, 'utf8');
    const patched = original.replace(CFT_TEMPLATE_REGEX, PATCHED_TEMPLATE);
    if (patched === original) {
      // No change needed. Two possible reasons:
      //   1. The file has already been patched in a previous run.
      //   2. Upstream renamed or removed the `builds/cft/${browserVersion}/${suffix}`
      //      template — this file's regex no longer matches anything, so we
      //      silently fall through to the unmodified upstream file.
      //
      // Case (2) is the dangerous one: when PLAYWRIGHT_CHROMIUM_DOWNLOAD_HOST
      // is set to the chrome-for-testing GCS bucket, the unpatched template
      // produces a 404 from the bucket. Print a clear warning so a future
      // playwright upgrade that moves the template lands here instead of as
      // a confusing download failure in install-playwright-browsers.js.
      console.error(
        '::warning::patch-playwright-cft-path: regex did not match anything in ' +
        'playwright-core registry/index.js. Either Playwright already ships the ' +
        'patched template (good) or the upstream template was renamed and the ' +
        'download will 404. If installs start failing, update CFT_TEMPLATE_REGEX ' +
        'in this file to match the new template name.',
      );
      return resolved;
    }
    const sibling = resolved + '.patched.js';
    // Idempotent: skip write if the sibling already has the exact patched content.
    if (!fs.existsSync(sibling) || fs.readFileSync(sibling, 'utf8') !== patched) {
      fs.writeFileSync(sibling, patched);
    }
    return sibling;
  } catch (_err) {
    // If anything goes wrong reading/rewriting, fall back to the original file
    // so Playwright still runs (it will just hit the unmodified cft path).
    return resolved;
  }
};
