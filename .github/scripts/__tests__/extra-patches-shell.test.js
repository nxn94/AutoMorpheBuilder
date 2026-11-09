'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { extraBundlePath } = require('../extra-patches');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'extra-bundles-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function download(mode = '') {
  const bin = path.join(root, 'bin');
  const tools = path.join(root, 'tools with spaces');
  fs.mkdirSync(bin);
  fs.mkdirSync(tools);
  const config = path.join(root, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ patch_repos: { 'com.example': { extra_patches: {
    'owner/repo-one': ['First'], 'owner-repo/one': ['Second'],
  } } } }));
  // Fake only the GitHub boundary; exercise the real shell, hashing and argv.
  fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const crypto = require('node:crypto');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const repo = value('--repo');
const bytes = Buffer.from('bundle for ' + repo);
if (args[1] === 'download') fs.writeFileSync(value('--output'), bytes);
else if (value('--json') === 'tagName') console.log('v1');
else if (value('--json') === 'assets') {
  const digest = process.env.FAIL_MODE === 'missing' ? '' :
    'sha256:' + crypto.createHash('sha256').update(process.env.FAIL_MODE === 'mismatch' ? 'wrong bytes' : bytes).digest('hex');
  console.log('patches-v1.mpp\\t' + digest);
} else process.exit(2);
`, { mode: 0o755 });
  const result = spawnSync('bash', [path.resolve(__dirname, '../pipeline/extra_patch_args.sh')], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      CONFIG_FILE: config, APP_ID: 'com.example', PATCH_REPO: 'main/repo',
      TOOLS_DIR: tools, EXTRA_PATCH_TAGS: '{}', FAIL_MODE: mode },
  });
  return { result, tools };
}

test('distinct repository slugs retain their own verified bytes and arguments', () => {
  const { result, tools } = download();
  expect(result.status).toBe(0);
  const first = extraBundlePath(tools, 'owner/repo-one');
  const second = extraBundlePath(tools, 'owner-repo/one');
  expect(first).not.toBe(second);
  expect(fs.readFileSync(first, 'utf8')).toBe('bundle for owner/repo-one');
  expect(fs.readFileSync(second, 'utf8')).toBe('bundle for owner-repo/one');
  expect(result.stdout.split('\0').filter(Boolean)).toEqual([
    `--patches=${first}`, '-e', 'First', `--patches=${second}`, '-e', 'Second',
  ]);
});

test.each(['missing', 'mismatch'])('rejects a %s digest without emitting patch arguments', (mode) => {
  const { result } = download(mode);
  expect(result.status).not.toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toMatch(/SHA-256/);
});
