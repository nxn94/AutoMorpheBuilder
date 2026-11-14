'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pipelineDigest, NON_OUTPUT_FILES, lockfileForDigest } = require('../build-fingerprint');

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
  '.github/scripts/download-supported-apk.js', 'src/download/signer.js', '.github/scripts/apk-signers.json',
  '.github/scripts/pipeline/some-new-step.sh', // not listed anywhere: hashed by default
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

test.each([...NON_OUTPUT_FILES])('housekeeping file %s does not change the digest', (file) => {
  write(file, 'before');
  const before = pipelineDigest(root);
  write(file, 'after');
  expect(pipelineDigest(root)).toBe(before);
});

test('every excluded file is a path the scanner would otherwise hash', () => {
  for (const file of NON_OUTPUT_FILES) {
    expect(file).toMatch(/^(src|\.github\/scripts|scripts)\/.*\.(js|sh|json)$/);
  }
});

describe('package-lock.json', () => {
  const lock = (extra = {}) => JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'x', dependencies: { ajv: '^8' }, devDependencies: { jest: '^30' } },
      'node_modules/ajv': { version: '8.0.0', resolved: 'https://r/ajv', integrity: 'sha512-a' },
      'node_modules/jest': { version: '30.0.0', dev: true },
      ...extra,
    },
  });

  test('a devDependency change does not change the digest', () => {
    write('package-lock.json', lock());
    const before = pipelineDigest(root);
    write('package-lock.json', lock({ 'node_modules/jest-extra': { version: '1.0.0', dev: true } })
      .replace('"jest":"^30"', '"jest":"^31"'));
    expect(pipelineDigest(root)).toBe(before);
  });

  test('a runtime dependency change changes the digest', () => {
    write('package-lock.json', lock());
    const before = pipelineDigest(root);
    write('package-lock.json', lock({ 'node_modules/ajv': { version: '8.1.0', resolved: 'https://r/ajv', integrity: 'sha512-b' } }));
    expect(pipelineDigest(root)).not.toBe(before);
  });

  test('an unparsable or unrecognised lockfile is hashed as-is', () => {
    expect(lockfileForDigest('not json')).toBe('not json');
    expect(lockfileForDigest('{}')).toBe('{}');
    write('package-lock.json', 'a');
    const before = pipelineDigest(root);
    write('package-lock.json', 'b');
    expect(pipelineDigest(root)).not.toBe(before);
  });
});

test('every excluded path exists in the repository (no stale entries)', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  for (const file of NON_OUTPUT_FILES) expect(fs.existsSync(path.join(repoRoot, file))).toBe(true);
});
