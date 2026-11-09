'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pipeline = path.resolve(__dirname, '../pipeline').replace(/\\/g, '/');
let dir; let tools;
const stub = (name, body) => fs.writeFileSync(path.join(tools, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
const run = (fails, output = 'dev-tag') => spawnSync('bash', ['-c',
  `. "${pipeline}/lib/common.sh"; . "${pipeline}/resolve-tag.sh"; resolve_release_tag owner/repo dev`], {
  encoding: 'utf8',
  env: { ...process.env, PATH: `${tools}${path.delimiter}${process.env.PATH}`, COUNT: path.join(dir, 'count'), FAILS: String(fails), OUTPUT: output },
});
const calls = () => fs.readFileSync(path.join(dir, 'count'), 'utf8').length;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-tag-'));
  tools = path.join(dir, 'bin');
  fs.mkdirSync(tools);
  stub('sleep', 'exit 0');
  stub('gh', `if [ "$1" = release ]; then echo stable-tag; exit 0; fi
printf x >> "$COUNT"
[ "$(wc -c < "$COUNT")" -le "$FAILS" ] && exit 1
[ -n "$OUTPUT" ] && echo "$OUTPUT"
exit 0`);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a passing retry returns the listed tag', () => {
  const result = run(1);
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('dev-tag');
  expect(calls()).toBe(2);
});

test('persistent API errors stop instead of using another tag', () => {
  const result = run(3);
  expect(result.status).toBe(1);
  expect(result.stdout.trim()).toBe('');
  expect(result.stderr).toContain('Could not list releases');
  expect(calls()).toBe(3);
});

test('a real empty answer still falls back to the stable tag', () => {
  const result = run(0, '');
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('stable-tag');
});
