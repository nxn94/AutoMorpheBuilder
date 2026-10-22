const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const workflow = name => yaml.load(fs.readFileSync(path.join(__dirname, '../../workflows', name), 'utf8'));

test('CI shares one validation job without checking out workflow_run head data', () => {
  const ci = workflow('ci.yml');
  expect(Object.keys(ci.jobs)).toEqual(['test']);
  expect(ci.jobs.test.if).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(ci.jobs.test.if).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
  const checkouts = ci.jobs.test.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
  expect(checkouts).toHaveLength(2);
  expect(checkouts[0].if).toContain("github.event_name != 'workflow_run'");
  expect(checkouts[1].if).toContain("github.event_name == 'workflow_run'");
  expect(checkouts[1].with.ref).toBe('refs/heads/main');
  for (const checkout of checkouts) expect(checkout.with['persist-credentials']).toBe(false);
  const setup = ci.jobs.test.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  expect(setup.with.cache).toBe('npm');
});

test('metadata updates and release publishing share a non-cancelling write lock', () => {
  const update = workflow('update-patches.yml');
  const release = workflow('morphe-build.yml').jobs['create-release'];
  expect(release.concurrency).toEqual(update.concurrency);
  expect(update.concurrency['cancel-in-progress']).toBe(false);
  expect(update.permissions).toEqual({ contents: 'read' });
  expect(update.jobs['update-patches'].permissions).toEqual({ contents: 'write' });
});

test('build avoids recompressing APKs and skips redundant npm audit requests', () => {
  const build = workflow('morphe-build.yml');
  const upload = build.jobs['check-versions'].steps.find(step => step.with?.name === 'pre-downloaded-apks');
  expect(upload.with['compression-level']).toBe(0);
  for (const job of Object.values(build.jobs)) {
    for (const step of job.steps) {
      if (step.run?.startsWith('npm ci')) expect(step.run).toContain('--no-audit --no-fund');
    }
  }
});
