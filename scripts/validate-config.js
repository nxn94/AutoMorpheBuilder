#!/usr/bin/env node
'use strict';

/**
 * scripts/validate-config.js — CLI entry for config + patches validation.
 *
 * Uses ajv for structural validation against schemas/config.schema.json
 * and schemas/patches.schema.json, then runs the hand-rolled semantic
 * rules from .github/scripts/validate-config.js on top.
 *
 * Pure logic (the semantic rules) lives in .github/scripts/validate-config.js
 * so the Jest suite can exercise it without spinning up ajv. This file
 * is only the CLI orchestrator.
 *
 * Exit code: 0 on success, 1 on any error. Warnings don't fail.
 *
 * Pipeline:
 *   1. ajv compiles config.schema.json + patches.schema.json.
 *   2. ajv validates config.json + patches.json (allErrors: true so we
 *      see every violation in one pass — better DX than fixing one at
 *      a time).
 *   3. validateConfig(config) (semantic rules) runs on top.
 *      Errors fail the build; warnings log as ::warning:: annotations
 *      but don't fail.
 */

const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const { validateConfig: validateSemantics } = require('../.github/scripts/validate-config.js');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${filePath}: ${error.message}`, {
      cause: error,
    });
  }
}

function formatAjvErrors(filePath, errors = []) {
  return errors.map((error) => {
    // JSON Pointer escapes '/' as '~1' and '~' as '~0'. For
    // patches.json (top-level keys are owner/repo slugs) this yields
    // paths like "/MorpheApp~1morphe-patches" — readable enough.
    const location = error.instancePath || '/';
    return `${filePath} ${location}: ${error.message}`;
  });
}

function main() {
  const root = path.resolve(__dirname, '..');
  const configPath = path.join(root, 'config.json');
  const patchesPath = path.join(root, 'patches.json');
  const configSchemaPath = path.join(root, 'schemas', 'config.schema.json');
  const patchesSchemaPath = path.join(root, 'schemas', 'patches.schema.json');

  const config = readJson(configPath);
  const patches = readJson(patchesPath);
  const configSchema = readJson(configSchemaPath);
  const patchesSchema = readJson(patchesSchemaPath);

  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);

  const errors = [];

  const validateConfigSchema = ajv.compile(configSchema);
  if (!validateConfigSchema(config)) {
    errors.push(...formatAjvErrors('config.json', validateConfigSchema.errors));
  }

  const validatePatchesSchema = ajv.compile(patchesSchema);
  if (!validatePatchesSchema(patches)) {
    errors.push(...formatAjvErrors('patches.json', validatePatchesSchema.errors));
  }

  // Semantic rules on top of structural validation. ajv has already
  // enforced shape (types, enums, regexes, required keys); this layer
  // catches cross-key invariants ajv can't express — duplicate
  // release-name slugs, ABI enum drift, etc.
  for (const issue of validateSemantics(config)) {
    const where = issue.appId
      ? `config.json patch_repos["${issue.appId}"]`
      : 'config.json <top-level>';
    if (issue.level === 'error') {
      errors.push(`${where}: ${issue.message}`);
    } else if (issue.level === 'warning') {
      console.warn(`::warning::${where}: ${issue.message}`);
    }
  }

  if (errors.length > 0) {
    console.error(`Configuration validation failed (${errors.length} error(s)):`);
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('Configuration validation passed.');
}

main();