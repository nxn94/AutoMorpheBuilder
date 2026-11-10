'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../workflows/morphe-build.yml'), 'utf8'));

const notPaused = "vars.DAILY_BUILDS != 'paused'";

test('DAILY_BUILDS=paused stops only scheduled runs at the first job', () => {
  expect(workflow.jobs['check-versions'].if).toBe(`github.event_name != 'schedule' || ${notPaused}`);
});

test('every later job depends on check-versions, so a paused run does nothing', () => {
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'check-versions') expect([job.needs].flat()).toContain('check-versions');
  }
});

test('a paused scheduled run cannot replace a manual run waiting in the queue', () => {
  const { group } = workflow.concurrency;
  expect(group).toContain("github.event_name == 'schedule' && vars.DAILY_BUILDS == 'paused'");
  expect(group).toContain("'morphe-build-skipped'");
  expect(group).toContain("|| 'morphe-build'");
});
