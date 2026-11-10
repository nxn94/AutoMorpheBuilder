'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../workflows/morphe-build.yml'), 'utf8'));

test('a run limited to named apps says so in its title', () => {
  expect(workflow['run-name']).toContain("format('Build only {0}', inputs.apps)");
});

test('any other run keeps the workflow name as its title', () => {
  expect(workflow['run-name']).toContain(`|| '${workflow.name}'`);
});
