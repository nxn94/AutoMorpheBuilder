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
  write('.github/workflows/morphe-build.yml', 'a');
  write('package-lock.json', '{}');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test.each([
  'src/patch.js', '.github/scripts/pipeline/patch_apk.sh',
  '.github/workflows/morphe-build.yml', 'scripts/download-tool.sh',
  'package-lock.json', '.github/scripts/apk-signers.json',
])('output or validation input %s changes the digest', (file) => {
  write(file, 'before');
  const before = pipelineDigest(root);
  write(file, 'after');
  expect(pipelineDigest(root)).not.toBe(before);
});

test('CI-only files and unrelated pins do not change the digest', () => {
  const before = pipelineDigest(root);
  write('.github/workflows/ci.yml', 'new CI');
  write('.github/workflows/codeql.yml', 'new analysis');
  write('docs/release-process.md', 'new docs');
  write('src/__tests__/patch.test.js', 'new test');
  write('scripts/check-agents-doc.js', 'new doc check');
  write('checksums/tools.sha256', `# note\n${jar('a')}${'c'.repeat(64)}  chrome-linux64.zip\n`);
  expect(pipelineDigest(root)).toBe(before);
});

test('a patcher pin changes the digest', () => {
  const before = pipelineDigest(root);
  write('checksums/tools.sha256', jar('b'));
  expect(pipelineDigest(root)).not.toBe(before);
});
