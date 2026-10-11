'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildMatrix, supportedVersions } = require('../build-plan');
const { syncSelections } = require('../sync-patch-selections');
const { parseIdentity, assertIdentity, inspectIdentity } = require('../apk-identity');
const { fingerprint, appFingerprint, releaseIsCurrent } = require('../build-fingerprint');
const { verifyArchiveDigest } = require('../verify-browser-archive');
const { hasLocalInput } = require('../local-download-input');
const { detectChanges } = require('../../../scripts/detect-new-repos');

const root = path.resolve(__dirname, '../../..');
const config = { cli: { repo: 'cli/repo', branch: 'main' }, preferred_arch: 'arm64-v8a', patch_repos: {
  'com.dev': { name: 'dev-app', repo: 'a/patches', branch: 'dev' },
  'com.stable': { name: 'stable', repo: 'a/patches', branch: 'main' },
  'com.pinned': { name: 'pinned', repo: 'a/patches', branch: 'main', pin_patch_tag: 'v1' },
  'com.latest': { name: 'latest', repo: 'a/patches', branch: 'main' },
} };
const versions = { 'com.dev': 'v3-dev.1', 'com.stable': 'v2', 'com.pinned': 'v1', 'com.latest': 'v2' };

test('keeps main, dev and pins independent; deduplicates only identical repo/tag bundles', () => {
  const entries = buildMatrix(config, versions);
  expect(entries.map((entry) => entry.patchTag)).toEqual(['v3-dev.1', 'v2', 'v1', 'v2']);
  expect(new Set(entries.map((entry) => entry.patchSlug)).size).toBe(3);
  expect(entries[1].patchSlug).toBe(entries[3].patchSlug);
  expect(buildMatrix(config, { ...versions, 'com.latest': 'v4' })[3].patchSlug).not.toBe(entries[3].patchSlug);
});

test('accepts two-part versions and sorts unique supported versions numerically', () => {
  expect(supportedVersions('24.3 (1 patch)\n9.9.1\n24.3\n25.10.0\n25.2.0')).toEqual(['25.10.0', '25.2.0', '24.3', '9.9.1']);
});

test.each([false, true])('preserves a moved false toggle regardless of config order (%s)', (reverse) => {
  const entries = [['com.old', { repo: 'a/patches' }], ['com.moved', { repo: 'z/patches' }]];
  if (reverse) entries.reverse();
  const cfg = { patch_repos: Object.fromEntries(entries) };
  const original = { 'a/patches': { 'com.old': { Old: false }, 'com.moved': { Telemetry: false } } };
  const lists = {
    'a/patches|v1': [{ name: 'Old', compatiblePackages: { 'com.old': [] } }],
    'z/patches|v1': [{ name: 'Telemetry', compatible_packages: [{ packageName: 'com.moved' }] },
      { name: 'New', compatiblePackages: { 'com.moved': [] } }],
  };
  const snapshot = JSON.stringify(original);
  const result = syncSelections(cfg, original, { 'a/patches': 'v1', 'z/patches': 'v1' }, lists);
  expect(result['z/patches']['com.moved']).toEqual({ Telemetry: false, New: true });
  expect(result['a/patches']).toEqual({ 'com.old': { Old: false } });
  expect(JSON.stringify(original)).toBe(snapshot);
  delete lists['z/patches|v1'];
  expect(syncSelections(cfg, original, { 'a/patches': 'v1', 'z/patches': 'v1' }, lists)['z/patches']['com.moved'])
    .toEqual({ Telemetry: false });
});

test('syncs each app against its selected tag', () => {
  const lists = Object.fromEntries(['v1', 'v2', 'v3-dev.1'].map((tag) => [`a/patches|${tag}`, [
    { name: tag, compatiblePackages: Object.fromEntries(Object.keys(config.patch_repos).map((pkg) => [pkg, []])) },
  ]]));
  const result = syncSelections(config, {}, versions, lists)['a/patches'];
  expect(result['com.pinned']).toEqual({ v1: true });
  expect(result['com.dev']).toEqual({ 'v3-dev.1': true });
  expect(result['com.latest']).toEqual({ v2: true });
});

test('opens the sync gate for a new app in an existing repository', () => {
  expect(detectChanges(config, { 'a/patches': {} }).hasMissingApps).toBe(true);
});

test('fails closed on wrong packages, wrong versions and unreadable metadata', () => {
  const identity = parseIdentity("package: name='com.expected' versionCode='1' versionName='24.3'\napplication: label='x'");
  expect(assertIdentity(identity, 'com.expected', '24.3')).toBe(identity);
  expect(() => assertIdentity(identity, 'com.other', '24.3')).toThrow('Wrong APK package');
  expect(() => assertIdentity(identity, 'com.expected', '24.4')).toThrow('Wrong APK version');
  expect(() => inspectIdentity('/file.apk', 'com.expected', '24.3', () => { throw new Error('unreadable'); }))
    .toThrow('unreadable');
});

test('invalidates release identity on patch, CLI, architecture or pipeline changes', () => {
  const patches = { 'a/patches': { 'com.dev': { Telemetry: false } } };
  const digest = appFingerprint(config, patches, 'com.dev', 'v1', 'pipeline');
  expect(appFingerprint(config, { 'a/patches': { 'com.dev': { Telemetry: true } } }, 'com.dev', 'v1', 'pipeline')).not.toBe(digest);
  expect(appFingerprint(config, patches, 'com.dev', 'v2', 'pipeline')).not.toBe(digest);
  expect(appFingerprint({ ...config, preferred_arch: 'x86_64' }, patches, 'com.dev', 'v1', 'pipeline')).not.toBe(digest);
  expect(appFingerprint(config, patches, 'com.dev', 'v1', 'changed')).not.toBe(digest);
  expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
  const release = { body: `<!-- build-input:${digest} -->`, assets: ['app.apk', 'SHA256SUMS', 'build-inputs.json'].map((name) => ({ name })) };
  expect(releaseIsCurrent(release, 'app', digest)).toBe(true);
  expect(releaseIsCurrent({ ...release, assets: release.assets.slice(1) }, 'app', digest)).toBe(false);
  expect(releaseIsCurrent(release, 'app', 'different')).toBe(false);
});

test('checks the exact browser archive digest and rejects malformed pins', () => {
  const bytes = Buffer.from('browser');
  const digest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  expect(() => verifyArchiveDigest(bytes, digest)).not.toThrow();
  expect(() => verifyArchiveDigest(Buffer.from('changed'), digest)).toThrow('mismatch');
  expect(() => verifyArchiveDigest(bytes, 'invalid')).toThrow('Invalid');
});

test('avoids browser setup only when a local candidate passes its ABI check', () => {
  const find = (dir) => dir === 'preloaded' ? '/preloaded.apk' : null;
  expect(hasLocalInput(['cache', 'preloaded'], '24.3', 'arm64-v8a', find, () => {})).toBe(true);
  expect(hasLocalInput(['cache', 'preloaded'], '24.3', 'arm64-v8a', find, () => { throw new Error('wrong ABI'); })).toBe(false);
});

test('returns the failed command status after exhausted retries and retries transient failures', () => {
  const library = path.join(root, '.github/scripts/pipeline/lib/common.sh');
  const failed = spawnSync('bash', ['-c', 'source "$1"; with_retry 1 0 bash -c "exit 23"', '_', library]);
  expect(failed.status).toBe(23);
  expect(execFileSync('bash', ['-c', 'source "$1"; count=0; attempt() { count=$((count+1)); [ "$count" -eq 2 ]; }; with_retry 2 0 attempt; echo "$count"', '_', library], { encoding: 'utf8' }).trim()).toBe('2');
});

test('honours auto_update_urls=false and defaults missing flags to true', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-flag-'));
  try {
    const file = path.join(dir, 'config.json');
    const args = ['-c', 'source "$1"; source "$2"; auto_update_urls_enabled', '_',
      path.join(root, '.github/scripts/pipeline/lib/common.sh'), path.join(root, '.github/scripts/pipeline/lib/config.sh')];
    for (const [data, status] of [[{ auto_update_urls: false }, 1], [{}, 0], [{ auto_update_urls: true }, 0]]) {
      fs.writeFileSync(file, JSON.stringify(data));
      expect(spawnSync('bash', args, { env: { ...process.env, CONFIG_FILE: file } }).status).toBe(status);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Exercise the actual workflow entry points with isolated command fixtures.
describe('pipeline integration regressions', () => {
  let dir;
  let bin;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-review-'));
    bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  function command(name, body) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
  }
  function environment(extra) {
    return { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra };
  }

  test('resolves independent main/dev/pinned selectors through the shell entry point', () => {
    const configFile = path.join(dir, 'config.json');
    const output = path.join(dir, 'output');
    fs.writeFileSync(configFile, JSON.stringify(config));
    command('gh', 'if [ "$1" = api ]; then echo v3-dev.1; else echo v2; fi');
    const result = spawnSync('bash', [path.join(root, '.github/scripts/pipeline/check_versions.sh')], {
      encoding: 'utf8', env: environment({ CONFIG_FILE: configFile, GITHUB_OUTPUT: output }),
    });
    expect(result.status).toBe(0);
    const line = fs.readFileSync(output, 'utf8').split('\n').find((value) => value.startsWith('matrix-include='));
    expect(JSON.parse(line.slice('matrix-include='.length)).map((entry) => entry.patchTag)).toEqual(['v3-dev.1', 'v2', 'v1', 'v2']);
  });

  test.each(['wrong-package', 'unreadable', 'valid'])('validates the exact cached APK through the CLI (%s)', (scenario) => {
    const apps = path.join(dir, 'apps');
    fs.mkdirSync(apps);
    const input = path.join(dir, 'input');
    fs.mkdirSync(input);
    fs.writeFileSync(path.join(input, 'AndroidManifest.xml'), 'test manifest');
    fs.writeFileSync(path.join(input, 'classes.dex'), 'test dex');
    execFileSync('zip', ['-q', path.join(apps, 'com.expected_24.3.apk'), 'AndroidManifest.xml', 'classes.dex'], { cwd: input });
    const badging = scenario === 'wrong-package'
      ? "package: name='com.other' versionName='24.3'" : "package: name='com.expected' versionName='24.3'";
    command('aapt', scenario === 'unreadable' ? 'exit 1' : `printf '%s\\n' "${badging}"`);
    command('aapt2', scenario === 'unreadable' ? 'exit 1' : `printf '%s\\n' "${badging}"`);
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ preferred_arch: '' }));
    const output = path.join(dir, 'output');
    fs.writeFileSync(output, '');
    const result = spawnSync(process.execPath, [path.join(root, '.github/scripts/download-supported-apk.js')], {
      encoding: 'utf8', timeout: 30000,
      env: environment({ APP_ID: 'com.expected', TARGET_VERSION: '24.3', APKS_DIR: apps,
        TOOLS_DIR: path.join(dir, 'tools'), CONFIG_FILE: configFile, GITHUB_OUTPUT: output }),
    });
    expect(result.status).toBe(scenario === 'valid' ? 0 : 1);
    const outputs = fs.readFileSync(output, 'utf8');
    if (scenario === 'valid') expect(outputs).toContain('version=24.3');
    else expect(outputs).not.toContain('apk=');
  });

  test('replaces existing APK/checksum/provenance assets and preserves hyphenated names', () => {
    const apks = path.join(dir, 'apks');
    fs.mkdirSync(apks);
    const filename = 'dev-app-v24.3-v3-dev.1.apk';
    fs.writeFileSync(path.join(apks, filename), 'signed fixture');
    const configFile = path.join(dir, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const calls = path.join(dir, 'calls.jsonl');
    fs.writeFileSync(calls, '');
    command('gh', 'node -e \'require("node:fs").appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(1))+"\\n")\' "$@"');
    const result = spawnSync('bash', [path.join(root, '.github/scripts/pipeline/create_release.sh')], {
      encoding: 'utf8', env: environment({ CONFIG_FILE: configFile, APKS_DIR: apks,
        CLI_VERSION: 'v1', CLI_BRANCH: 'main', REPO_VERSIONS: JSON.stringify(versions), CALLS: calls }),
    });
    expect(result.status).toBe(0);
    const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const uploads = commands.filter((args) => args[1] === 'upload');
    expect(uploads.map((args) => path.basename(args[3]))).toEqual([filename, 'SHA256SUMS', 'build-inputs.json']);
    expect(uploads.every((args) => args[2] === 'dev-app-v24.3-v3-dev.1' && args.includes('--clobber'))).toBe(true);
    expect(commands.at(-1)[1]).toBe('edit');
    expect(commands.at(-1).at(-1)).toContain('<!-- build-input:');
    expect(fs.readFileSync(path.join(apks, 'SHA256SUMS'), 'utf8')).toContain(filename);
  });
});

test('parallel pre-download attempts receive separate package directories', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'predownload-isolation-'));
  try {
    const bin = path.join(dir, 'bin');
    const tools = path.join(dir, 'tools');
    fs.mkdirSync(bin);
    fs.mkdirSync(tools);
    fs.writeFileSync(path.join(tools, 'supported-versions.json'), JSON.stringify({ 'com.one': ['24.3'], 'com.two': ['24.3'] }));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ auto_update_urls: false, patch_repos: { 'com.one': {}, 'com.two': {} } }));
    // Model apkeep's destructive cleanup: if the output directory is shared,
    // the second attempt deletes the first attempt's completed result.
    fs.writeFileSync(path.join(bin, 'node'), `#!/usr/bin/env bash\nset -eu\nif [[ "$1" == *unified-downloader.js ]]; then\n mkdir -p "$4"\n rm -f "$4"/*.apk\n printf fixture > "$4/$2_$3.apk"\n printf '{"success":true,"url":"https://example.test/app.apk"}\\n'\nelse\n exec "${process.execPath}" "$@"\nfi\n`, { mode: 0o755 });
    const result = spawnSync('bash', [path.join(root, '.github/scripts/pipeline/pre_download_apks.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONFIG_FILE: cfg,
        TOOLS_DIR: tools, RESULTS_DIR: path.join(dir, 'results') },
    });
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tools, 'apks/com.one/com.one_24.3.apk'))).toBe(true);
    expect(fs.existsSync(path.join(tools, 'apks/com.two/com.two_24.3.apk'))).toBe(true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recognizes a bundle with an outer manifest and accepts a validated pure-Java APK', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-shape-'));
  try {
    fs.writeFileSync(path.join(dir, 'AndroidManifest.xml'), 'manifest');
    fs.writeFileSync(path.join(dir, 'classes.dex'), 'dex');
    const base = path.join(dir, 'base.apk');
    execFileSync('zip', ['-q', base, 'AndroidManifest.xml', 'classes.dex'], { cwd: dir });
    const bundle = path.join(dir, 'bundle.apk');
    execFileSync('zip', ['-q', bundle, 'AndroidManifest.xml', 'base.apk'], { cwd: dir });
    const { detectApkShape } = require('../apk-selection');
    const { validateDownloadedApkAbi } = require('../apk-abi-validator');
    expect(detectApkShape(bundle)).toBe('bundle');
    expect(() => validateDownloadedApkAbi(base, 'arm64-v8a')).not.toThrow();
    expect(() => validateDownloadedApkAbi(bundle, 'arm64-v8a')).not.toThrow();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
