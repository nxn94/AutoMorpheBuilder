'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Runs the real retry script in a fake workspace whose download script and
// patch_apk.sh are stubs (the script finds both under GITHUB_WORKSPACE).
let dir;
let apps;
let log;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-fresh-'));
  apps = path.join(dir, 'apps');
  fs.mkdirSync(apps);
  fs.mkdirSync(path.join(dir, 'ws/.github/scripts/pipeline'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ws/.github/scripts/pipeline/patch_apk.sh'),
    '#!/usr/bin/env bash\necho "patched $APK $APK_VERSION" > "$RUNNER_TEMP/patched"\necho output=x.apk >> "$GITHUB_OUTPUT"\n');
  log = path.join(dir, 'morphe_patch_App.log');
  fs.writeFileSync(log, 'Failed to match the fingerprint');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// The stub download writes `content` (a list of originals) into apps/ and emits apk/version.
function run(downloaded) {
  fs.writeFileSync(path.join(dir, 'ws/.github/scripts/download-supported-apk.js'), `
const fs = require('node:fs');
const files = ${JSON.stringify(downloaded)};
for (const f of fs.readdirSync(${JSON.stringify(apps)})) fs.unlinkSync(${JSON.stringify(apps)} + '/' + f);
for (const [n, c] of Object.entries(files)) fs.writeFileSync(${JSON.stringify(apps)} + '/' + n, c);
if (process.env.FRESH_DOWNLOAD !== '1') process.exit(3);
fs.appendFileSync(process.env.GITHUB_OUTPUT, 'apk=/a/fresh.apk\\nversion=1.2\\n');
`);
  const output = path.join(dir, 'output');
  fs.writeFileSync(output, '');
  const result = spawnSync('bash', [path.resolve(__dirname, '../pipeline/retry_fresh_original.sh')], {
    encoding: 'utf8',
    env: { ...process.env, APP_ID: 'com.x', APP_NAME: 'App', APKS_DIR: apps, RUNNER_TEMP: dir,
      GITHUB_WORKSPACE: path.join(dir, 'ws'), GITHUB_OUTPUT: output },
  });
  return { ...result, outputs: fs.readFileSync(output, 'utf8') };
}

test('patches again when the fresh original differs', () => {
  fs.writeFileSync(path.join(apps, 'a.apk'), 'old');
  fs.writeFileSync(path.join(apps, 'com.x.apk'), 'merged');
  const r = run({ 'a.apk': 'new' });
  expect(r.status).toBe(0);
  expect(r.outputs).toContain('fresh=true');
  expect(r.outputs).toContain('output=x.apk');
  expect(fs.readFileSync(path.join(dir, 'patched'), 'utf8')).toBe('patched /a/fresh.apk 1.2\n');
  expect(r.stdout).toContain('::notice::');
});

test('fails without patching when the fresh original is identical', () => {
  fs.writeFileSync(path.join(apps, 'a.apk'), 'same');
  fs.writeFileSync(path.join(apps, 'b.apk'), 'same2');
  const r = run({ 'b.apk': 'same2', 'a.apk': 'same' });
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('::error::');
  expect(fs.existsSync(path.join(dir, 'patched'))).toBe(false);
});

test('does not retry a failure that is not a fingerprint mismatch', () => {
  fs.writeFileSync(log, 'OutOfMemoryError');
  const r = run({ 'a.apk': 'new' });
  expect(r.status).toBe(1);
  expect(r.stdout).toContain('not retrying');
  expect(fs.existsSync(path.join(dir, 'patched'))).toBe(false);
});
