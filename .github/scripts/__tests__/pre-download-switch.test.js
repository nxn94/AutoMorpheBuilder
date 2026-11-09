'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const { jobs } = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../workflows/morphe-build.yml'), 'utf8'));

test.each([
  ['check-versions', 'Pre-download APKs (parallel)'],
  ['check-versions', 'Upload pre-downloaded APKs'],
  ['build', 'Restore pre-downloaded APKs from check-versions'],
])('%s: %s honours PRE_DOWNLOAD=off', (job, name) => {
  expect(jobs[job].steps.find((s) => s.name === name).if).toContain("vars.PRE_DOWNLOAD != 'off'");
});

test('a build job can run without the pre-downloaded artifact', () => {
  const step = jobs.build.steps.find((s) => s.name === 'Restore pre-downloaded APKs from check-versions');
  expect(step['continue-on-error']).toBe(true);
});
