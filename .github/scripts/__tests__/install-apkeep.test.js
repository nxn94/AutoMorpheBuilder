'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const pipeline = path.resolve(__dirname, '../pipeline');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const fwd = (p) => p.split(path.sep).join('/');
let root;

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkeep-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// Run the real script with only the pinned digest swapped for the digest of
// `pinned`, and a fake curl that "downloads" `released`. The real match,
// mismatch and install logic runs.
function run({ pinned, released = pinned, existing }) {
  const dir = path.join(root, 'pipeline');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(pipeline, 'lib/common.sh'), path.join(dir, 'lib/common.sh'));
  const script = fs.readFileSync(path.join(pipeline, 'install_apkeep.sh'), 'utf8')
    .replace(/^APKEEP_SHA256="[0-9a-f]{64}"$/m, `APKEEP_SHA256="${sha(pinned)}"`);
  expect(script).toContain(sha(pinned));
  fs.writeFileSync(path.join(dir, 'install_apkeep.sh'), script);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const target = path.join(root, 'apkeep');
  if (existing !== undefined) fs.writeFileSync(target, existing, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'released'), released);
  const log = fwd(path.join(root, 'curl.log'));
  fs.writeFileSync(path.join(bin, 'curl'), [
    '#!/bin/sh',
    `echo called >> "${log}"`,
    'while [ $# -gt 0 ]; do',
    `  if [ "$1" = "--output" ]; then cp "${fwd(path.join(root, 'released'))}" "$2"; fi`,
    '  shift',
    'done',
    '',
  ].join('\n'), { mode: 0o755 });
  const result = spawnSync('bash', [fwd(path.join(dir, 'install_apkeep.sh'))], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fwd(bin)}:${process.env.PATH}`, APKEEP_PATH: fwd(target) },
  });
  const downloads = fs.existsSync(path.join(root, 'curl.log'))
    ? fs.readFileSync(path.join(root, 'curl.log'), 'utf8').trim().split('\n').length : 0;
  return { result, downloads, installed: fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null };
}

const pinned = '#!/bin/sh\necho "apkeep 0.18.0"\n';

test('an existing binary that matches the pin is kept without downloading', () => {
  const { result, downloads, installed } = run({ pinned, existing: pinned });
  expect(result.status).toBe(0);
  expect(downloads).toBe(0);
  expect(installed).toBe(pinned);
});

test('an existing binary that does not match the pin is replaced by a verified download', () => {
  const { result, downloads, installed } = run({ pinned, existing: '#!/bin/sh\necho "apkeep 0.17.0"\n' });
  expect(result.status).toBe(0);
  expect(downloads).toBe(1);
  expect(installed).toBe(pinned);
  expect(result.stderr).toMatch(/does not match the pinned/);
});

test('a download that does not match the pin is refused and the old binary is left alone', () => {
  const old = '#!/bin/sh\necho old\n';
  const { result, installed } = run({ pinned, released: 'tampered', existing: old });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/sha256 mismatch/);
  expect(installed).toBe(old);
});

test('a missing binary is downloaded and installed', () => {
  const { result, downloads, installed } = run({ pinned });
  expect(result.status).toBe(0);
  expect(downloads).toBe(1);
  expect(installed).toBe(pinned);
});

test('the workflow cache key changes with the install script', () => {
  const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../workflows/morphe-build.yml'), 'utf8'));
  const step = workflow.jobs['check-versions'].steps.find((s) => s.id === 'cache-apkeep');
  expect(step.with.key).toContain("hashFiles('.github/scripts/pipeline/install_apkeep.sh')");
});
