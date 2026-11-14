'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../../..');
const fwd = (p) => p.split(path.sep).join('/');

// A stand-in `node` that answers only unified-downloader.js and hands every
// other call (build-plan.js, jq helpers) to the real node.
function setup(downloaderBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predownload-timeout-'));
  const bin = path.join(dir, 'bin');
  const tools = path.join(dir, 'tools');
  fs.mkdirSync(bin);
  fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'supported-versions.json'), JSON.stringify({ 'com.slow': ['1.0'], 'com.fast': ['2.0'] }));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ auto_update_urls: false, patch_repos: { 'com.slow': {}, 'com.fast': {} } }));
  fs.writeFileSync(path.join(bin, 'node'), [
    '#!/usr/bin/env bash',
    'set -eu',
    'if [[ "$1" == *unified-downloader.js ]]; then',
    downloaderBody,
    'else',
    `  exec "${fwd(process.execPath)}" "$@"`,
    'fi',
    '',
  ].join('\n'), { mode: 0o755 });
  return { dir, bin, tools, cfg };
}

function run(ctx, extraEnv) {
  return spawnSync('bash', [fwd(path.join(root, '.github/scripts/pipeline/pre_download_apks.sh'))], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fwd(ctx.bin)}:${process.env.PATH}`, CONFIG_FILE: fwd(ctx.cfg),
      TOOLS_DIR: fwd(ctx.tools), RESULTS_DIR: fwd(path.join(ctx.dir, 'results')), ...extraEnv },
    timeout: 60_000,
  });
}

test('a hung downloader is stopped at the limit, reported as a timeout, and does not hold up the others', () => {
  const ctx = setup([
    '  if [ "$2" = "com.slow" ]; then exec sleep 120; fi',
    '  printf \'{"success":true,"url":"https://example.test/app.apk"}\\n\'',
  ].join('\n'));
  try {
    const started = Date.now();
    const result = run(ctx, { PRE_DOWNLOAD_TIMEOUT_SECONDS: '2' });
    expect(Date.now() - started).toBeLessThan(40_000);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(ctx.dir, 'results/com.slow.failed'), 'utf8').trim()).toBe('FAILED:timeout');
    expect(fs.existsSync(path.join(ctx.dir, 'results/com.fast.failed'))).toBe(false);
    expect(fs.readFileSync(path.join(ctx.dir, 'results/com.fast.txt'), 'utf8')).toContain('com.fast:2.0:https://example.test/app.apk');
    expect(result.stderr).toMatch(/com\.slow\] unified-downloader timed out after 2s/);
  } finally { fs.rmSync(ctx.dir, { recursive: true, force: true }); }
});

test('an ordinary downloader failure is still reported as a download failure, not a timeout', () => {
  const ctx = setup([
    '  printf \'{"success":false,"error":"All sources failed"}\\n\'',
    '  exit 1',
  ].join('\n'));
  try {
    const result = run(ctx, { PRE_DOWNLOAD_TIMEOUT_SECONDS: '30' });
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(ctx.dir, 'results/com.slow.failed'), 'utf8').trim()).toBe('FAILED:download');
    expect(result.stderr).toMatch(/reason: All sources failed/);
  } finally { fs.rmSync(ctx.dir, { recursive: true, force: true }); }
});
