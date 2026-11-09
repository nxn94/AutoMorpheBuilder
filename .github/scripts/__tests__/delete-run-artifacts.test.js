'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const script = path.resolve(__dirname, '../pipeline/delete_run_artifacts.sh');
let dir; let tools; let log;
const run = (failId = 'none') => spawnSync('bash', [script], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`, GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7', GH_LOG: log, FAIL_ID: failId },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  tools = path.join(dir, 'bin'); log = path.join(dir, 'gh.log');
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'gh'), `#!/usr/bin/env bash
if [ "$2" = "--paginate" ]; then printf '11\\n22\\n'; exit 0; fi
echo "$4" >> "$GH_LOG"
case "$4" in */$FAIL_ID) exit 1;; esac
exit 0
`, { mode: 0o755 });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('deletes every artifact of the run', () => {
  expect(run().status).toBe(0);
  expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['repos/o/r/actions/artifacts/11', 'repos/o/r/actions/artifacts/22']);
});

test('a failed delete only warns and carries on', () => {
  const result = run('11');
  expect(result.status).toBe(0);
  expect(result.stderr).toContain('Could not delete artifact 11');
  expect(fs.readFileSync(log, 'utf8')).toContain('artifacts/22');
});

test('artifacts survive a failed publish', () => {
  const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../workflows/morphe-build.yml'), 'utf8'));
  const step = workflow.jobs['create-release'].steps.find((s) => s.name === "Delete this run's temporary artifacts");
  expect(step.if).toContain("steps.publish.outcome == 'success'");
});
