#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    console.log(`${name}=${value}`);
    return;
  }
  const delimiter = `EOF_${Date.now()}_${process.pid}`;
  fs.appendFileSync(
    outputFile,
    `${name}<<${delimiter}\n${value}\n${delimiter}\n`,
    'utf8',
  );
}

function main() {
  const configPath = process.env.CONFIG_FILE || 'config.json';
  const patchesPath = process.env.PATCHES_FILE || 'patches.json';
  const config = readJson(configPath);
  const patches = readJson(patchesPath);

  const configRepos = new Set(
    Object.values(config.patch_repos || {}).map((entry) => entry.repo),
  );
  const patchesRepos = new Set(Object.keys(patches));
  const newRepos = [...configRepos]
    .filter((repo) => !patchesRepos.has(repo))
    .sort();

  if (newRepos.length === 0) {
    writeOutput('has_new_repos', 'false');
    console.log('::notice::No new patch repos in config.json; skipping sync.');
    return;
  }

  writeOutput('has_new_repos', 'true');
  console.log('New patch repos to seed:');
  for (const repo of newRepos) {
    console.log(`  - ${repo}`);
  }
}

main();
