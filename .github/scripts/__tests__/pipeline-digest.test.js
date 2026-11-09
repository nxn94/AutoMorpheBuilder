'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipelineDigest } = require('../build-fingerprint');

const jar = (c) => `${c.repeat(64)}  morphe-desktop.jar  # v1\n`;
let root;
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  write('checksums/tools.sha256', jar('a'));
  write('.github/workflows/build.yml', 'a');
  write('package-lock.json', '{}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('builder code and unrelated pins do not change the digest', () => {
  const before = pipelineDigest(root);
  write('.github/workflows/build.yml', 'b');
  write('package-lock.json', '{"x":1}');
  write('checksums/tools.sha256', `# note\n${jar('a')}${'c'.repeat(64)}  chrome-linux64.zip\n`);
  expect(pipelineDigest(root)).toBe(before);
});

test('a patcher pin changes the digest', () => {
  const before = pipelineDigest(root);
  write('checksums/tools.sha256', jar('b'));
  expect(pipelineDigest(root)).not.toBe(before);
});
