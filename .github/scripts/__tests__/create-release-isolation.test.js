'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../pipeline/create_release.sh');
let dir; let apks; let tools; let log;
const stub = (name, body) => fs.writeFileSync(path.join(tools, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const run = () => spawnSync('bash', [script], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`, APKS_DIR: apks, CLI_VERSION: 'v1', REPO_VERSIONS: '{}', GH_LOG: log },
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-release-'));
  apks = path.join(dir, 'apks'); tools = path.join(dir, 'bin'); log = path.join(dir, 'gh.log');
  fs.mkdirSync(apks); fs.mkdirSync(tools);
  for (const app of ['aa', 'bb', 'cc']) fs.writeFileSync(path.join(apks, `${app}-v1-p1.apk`), app);
  stub('node', 'echo "{}"');
  stub('jq', 'echo digest');
  stub('gh', `echo "$1 $2 $3" >> "$GH_LOG"
[ "$2" = view ] && exit 1
if [ "$2" = create ] && [ "\${3#\${FAIL_APP:-none}}" != "$3" ]; then exit 1; fi
exit 0`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('one failed app does not stop the others, and the run still fails', () => {
  process.env.FAIL_APP = 'bb';
  const result = run();
  delete process.env.FAIL_APP;
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Not published: bb');
  const published = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('release edit')).map((l) => l.split(' ')[2]);
  expect(published).toEqual(['aa-v1-p1', 'cc-v1-p1']);
});

test('exits cleanly when every app publishes', () => {
  const result = run();
  expect(result.status).toBe(0);
  expect(result.stderr).not.toContain('Not published');
});
