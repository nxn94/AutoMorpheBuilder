'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipelineDigest } = require('../build-fingerprint');

let root;
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  for (const file of ['checksums/tools.sha256', 'package-lock.json', '.github/workflows/ci.yml', '.github/workflows/morphe-build.yml',
    '.github/scripts/pipeline/patch_apk.sh', 'src/patch.js', 'scripts/check-agents-doc.js']) write(file, 'a');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test.each(['.github/workflows/ci.yml', 'scripts/check-agents-doc.js'])('%s does not change the digest', (file) => {
  const before = pipelineDigest(root);
  write(file, 'b');
  expect(pipelineDigest(root)).toBe(before);
});

test.each(['src/patch.js', '.github/scripts/pipeline/patch_apk.sh', '.github/workflows/morphe-build.yml', 'package-lock.json', 'checksums/tools.sha256'])('%s changes the digest', (file) => {
  const before = pipelineDigest(root);
  write(file, 'b');
  expect(pipelineDigest(root)).not.toBe(before);
});
