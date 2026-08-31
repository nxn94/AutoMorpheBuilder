#!/usr/bin/env node
'use strict';

/**
 * check-agents-doc.js — drift guard for AGENTS.md.
 *
 * Pure-Node CommonJS. No external dependencies.
 *
 * Verifies that every path AGENTS.md claims is authoritative actually
 * exists in the repo, and that every `npm run <X>` reference in the
 * "Required validation" section resolves to a real script in
 * package.json. Catches the failure mode where docs reference paths /
 * scripts that drift out of the tree (renamed script, moved file,
 * deleted template).
 *
 * Exits 0 with a one-line confirmation on success.
 * Exits 1 with a bulleted list of missing items on any failure.
 *
 * The npm-script reference is parsed with a single
 * `String.matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)` over the whole
 * AGENTS.md text, so adding a new script reference anywhere in the
 * file (not just "Required validation") is auto-validated.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const AGENTS_MD = path.join(REPO_ROOT, 'AGENTS.md');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');

/** Paths AGENTS.md must reference. Relative to repo root. */
const REQUIRED_PATHS = Object.freeze([
  'config.json',
  'patches.json',
  'README.md',
  'SETUP.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/configuration.md',
  'docs/architecture.md',
  'docs/troubleshooting.md',
  'docs/release-process.md',
  '.github/workflows/morphe-build.yml',
  '.github/workflows/update-patches.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/codeql.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/pull_request_template.md',
  '.github/CODEOWNERS',
]);

function loadAgentsText() {
  return fs.readFileSync(AGENTS_MD, 'utf8');
}

function loadPackageScripts() {
  const raw = fs.readFileSync(PACKAGE_JSON, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null
    ? parsed.scripts
    : {};
}

function findMissingPaths() {
  const missing = [];
  for (const relPath of REQUIRED_PATHS) {
    const abs = path.join(REPO_ROOT, relPath);
    if (!fs.existsSync(abs)) {
      missing.push(relPath);
    }
  }
  return missing;
}

function findMissingScripts(text, scripts) {
  const referenced = new Set();
  const regex = /npm run ([a-zA-Z0-9:_-]+)/g;
  for (const match of text.matchAll(regex)) {
    referenced.add(match[1]);
  }
  const missing = [];
  for (const name of referenced) {
    if (!Object.prototype.hasOwnProperty.call(scripts, name)) {
      missing.push(name);
    }
  }
  return [...missing].sort();
}

function fail(message, items) {
  process.stderr.write(`${message}\n`);
  for (const item of items) {
    process.stderr.write(`  - ${item}\n`);
  }
  process.exit(1);
}

function main() {
  const text = loadAgentsText();
  const scripts = loadPackageScripts();

  const missingPaths = findMissingPaths();
  if (missingPaths.length > 0) {
    fail('AGENTS.md references missing required paths:', missingPaths);
  }

  const missingScripts = findMissingScripts(text, scripts);
  if (missingScripts.length > 0) {
    const formatted = missingScripts.map((name) => `npm run ${name}`);
    fail(
      'AGENTS.md "Required validation" references npm scripts that are not in package.json:',
      formatted,
    );
  }

  process.stdout.write(
    'AGENTS.md path references and npm script references are valid.\n',
  );
  process.exit(0);
}

main();