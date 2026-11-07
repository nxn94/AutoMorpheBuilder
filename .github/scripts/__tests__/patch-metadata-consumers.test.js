'use strict';
const { preflight } = require('../preflight-apps');
const { syncSelections } = require('../sync-patch-selections');
const { generatedVersions, enableArgs } = require('../patch-metadata');
const { supportedVersions } = require('../build-plan');
const config = { patch_repos: { 'com.example.app': { repo: 'owner/repo', name: 'example' } } };
const versions = { 'com.example.app': 'v1' };
const patch = (name, use, targets, unrestricted = false) => ({ name, use, compatiblePackages: [{ packageName: 'com.example.app', targets, unrestricted }] });
const list = { generated: true, patches: [patch('Default', true, [{ version: '12.40.1-prod.01' }, { version: '12.39.0-prod.01' }]), patch('Opt-in', false, [{ version: '12.39.0-prod.01' }]), patch('Unrestricted', true, [], true)] };
test('missing metadata preflight is explicitly deferred, never unsupported', async () => {
  const resolveMetadata = jest.fn(async () => ({ status: 'deferred', provenance: 'mpp', list: null }));
  const result = await preflight({ config, repoVersions: versions, resolveMetadata });
  expect(result.errors).toEqual([]);
  expect(result.rows[0]).toMatchObject({ status: 'deferred', pkgListed: '?', fetchOk: 'deferred' });
  expect(result.warnings[0].message).toMatch(/deferred/i);
});
test('post-download preflight rejects unsupported package from generated metadata', async () => {
  const result = await preflight({ config, repoVersions: versions, resolveMetadata: async () => ({ status: 'ready', list: { generated: true, patches: [patch('Other', true, [])].map((p) => ({ ...p, compatiblePackages: [] })) } }) });
  expect(result.errors[0].message).toMatch(/not listed/);
});
test('generated sync honors defaults and preserves moved explicit true/false; failure preserves all choices', () => {
  const original = { previous: { 'com.example.app': { Default: false, 'Opt-in': true, Removed: false } } };
  expect(syncSelections(config, original, versions, { 'owner/repo|v1': list })['owner/repo']['com.example.app']).toEqual({ Default: false, 'Opt-in': true, Unrestricted: true });
  expect(syncSelections(config, original, versions, {})['owner/repo']['com.example.app']).toEqual(original.previous['com.example.app']);
  expect(syncSelections(config, {}, versions, { 'owner/repo|v1': list })['owner/repo']['com.example.app']['Opt-in']).toBe(false);
});
test('generated version intersection follows explicit selections/defaults, excludes experimental, preserves tokens', () => {
  expect(generatedVersions(list, 'com.example.app', {})).toEqual(['12.40.1-prod.01', '12.39.0-prod.01']);
  expect(generatedVersions(list, 'com.example.app', { 'Opt-in': true })).toEqual(['12.39.0-prod.01']);
  expect(generatedVersions(list, 'com.example.app', { Default: false, Unrestricted: false })).toEqual([]);
  expect(generatedVersions({ ...list, patches: [patch('Experimental', true, [{ version: '99.0', isExperimental: true }])] }, 'com.example.app', {})).toEqual([]);
  expect(generatedVersions(list, 'com.example.app', {}, '12.40.1-prod.01')).toEqual(['12.40.1-prod.01']);
  expect(() => generatedVersions(list, 'com.example.app', { 'Opt-in': true }, '12.40.1-prod.01')).toThrow(/pin/i);
  expect(generatedVersions({ ...list, patches: [list.patches[2]] }, 'com.example.app', {}, '7.8-prod.01')).toEqual(['7.8-prod.01']);
});
test('only generated metadata enables explicit opt-ins; unrelated or default-false patches stay off', () => {
  expect(enableArgs(list, 'com.example.app', { 'Opt-in': true, Other: true, Default: false })).toEqual(['-e', 'Opt-in']);
  expect(enableArgs({ patches: list.patches }, 'com.example.app', { 'Opt-in': true })).toEqual([]);
});
test('shared version token extractor keeps complete suffixes', () => {
  expect(supportedVersions('INFO: Most common compatible versions:\n12.40.1-prod.01 (3 patches)\n12.39.0-prod.01 (2 patches)')).toEqual(['12.40.1-prod.01', '12.39.0-prod.01']);
});

test('probe uses generated selection intersection instead of CLI default counts', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { probe } = require('../compat-probe'); const { patchSlug } = require('../build-plan');
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-metadata-'));
  try {
    fs.writeFileSync(path.join(toolsDir, 'morphe-desktop.jar'), 'stub');
    const slug = patchSlug('com.example.app', config.patch_repos['com.example.app'], versions);
    fs.writeFileSync(path.join(toolsDir, `${slug}.mpp`), 'stub');
    fs.writeFileSync(path.join(toolsDir, `${slug}.metadata.json`), JSON.stringify(list));
    const rows = await probe({ config, repoVersions: versions, toolsDir, selections: { 'owner/repo': { 'com.example.app': { 'Opt-in': true } } },
      execImpl: async () => ({ stdout: '12.40.1-prod.01', stderr: '' }) });
    expect(rows[0].versions).toEqual(['12.39.0-prod.01']);
  } finally { fs.rmSync(toolsDir, { recursive: true, force: true }); }
});
test('workflow resolves deferred packages immediately after verified download and before probe/filter', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const workflow = fs.readFileSync(path.join(__dirname, '../../workflows/morphe-build.yml'), 'utf8');
  const download = workflow.indexOf('run: bash .github/scripts/pipeline/download_morphe_tools.sh');
  const finish = workflow.indexOf('name: Validate deferred patch metadata');
  expect(finish).toBeGreaterThan(download);
  expect(finish).toBeLessThan(workflow.indexOf('name: Compat probe'));
  const fetch = fs.readFileSync(path.join(__dirname, '../pipeline/fetch_morphe_tools.sh'), 'utf8');
  expect(fetch).not.toContain('raw.githubusercontent.com');
  expect(fetch.indexOf('node "$(dirname "$0")/../patch-metadata-runtime.js" resolve')).toBeGreaterThan(fetch.indexOf('# --- APKEditor'));
});

test('both target-version entry points honor generated explicit opt-ins and exact suffixes', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'target-metadata-'));
  try {
    fs.writeFileSync(path.join(tmp, 'patches-list.json'), JSON.stringify(list));
    fs.writeFileSync(path.join(tmp, 'morphe-desktop.jar'), 'stub');
    fs.writeFileSync(path.join(tmp, 'owner-repo.mpp'), 'stub');
    const patchesFile = path.join(tmp, 'choices.json');
    fs.writeFileSync(patchesFile, JSON.stringify({ 'owner/repo': { 'com.example.app': { 'Opt-in': true } } }));
    for (const [cmd, args] of [['bash', ['scripts/resolve-target-version.sh']], ['node', ['.github/scripts/resolve-supported-version.js']]]) {
      const output = path.join(tmp, 'output'); fs.writeFileSync(output, '');
      execFileSync(cmd, args, { env: { ...process.env, APP_ID: 'com.example.app', PATCH_REPO: 'owner/repo', TOOLS_DIR: tmp, PATCHES_FILE: patchesFile, PINNED_VERSION: '', RESOLVED_VERSION: '', GITHUB_OUTPUT: output }, stdio: 'pipe' });
      expect(fs.readFileSync(output, 'utf8')).toContain('version=12.39.0-prod.01\n');
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
test('shell version fallbacks and generated patch opt-ins delegate to shared runtime', () => {
  const fs = require('node:fs'); const path = require('node:path');
  for (const file of ['../pipeline/pre_download_apks.sh', '../pipeline/patch_apk.sh']) {
    expect(fs.readFileSync(path.join(__dirname, file), 'utf8')).toContain('patch-metadata-runtime.js');
  }
});

test('predownload validates generated pins against selected patches before accepting them', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'predownload-metadata-'));
  try {
    const scriptPath = path.join(__dirname, '../pipeline/pre_download_apks.sh');
    const source = fs.readFileSync(scriptPath, 'utf8').split('\ndownload_for()')[0]
      .replaceAll('$(dirname "$0")', path.dirname(scriptPath));
    const configFile = path.join(tmp, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify({ patch_repos: { 'com.example.app': { repo: 'owner/repo', pin_version: '12.40.1-prod.01' } } }));
    const patchesFile = path.join(tmp, 'patches.json');
    fs.writeFileSync(patchesFile, JSON.stringify({ 'owner/repo': { 'com.example.app': { 'Opt-in': true } } }));
    fs.writeFileSync(path.join(tmp, 'owner-repo.metadata.json'), JSON.stringify(list));
    expect(() => execFileSync('bash', ['-c', source + '\nresolve_version_for com.example.app'], { stdio: 'pipe', env: { ...process.env,
      CONFIG_FILE: configFile, PATCHES_FILE: patchesFile, TOOLS_DIR: tmp, APK_DIR: path.join(tmp, 'apks'), RESULTS_DIR: path.join(tmp, 'results'), REPO_VERSIONS: '{}' } })).toThrow();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('release filter fallback also honors generated selections when probe output is unavailable', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { resolveApkVersion } = require('../check-existing-releases');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-metadata-'));
  try {
    fs.writeFileSync(path.join(tmp, 'owner-repo.metadata.json'), JSON.stringify(list));
    expect(resolveApkVersion('com.example.app', path.join(tmp, 'morphe-desktop.jar'), path.join(tmp, 'owner-repo.mpp'), config,
      { 'owner/repo': { 'com.example.app': { 'Opt-in': true } } })).toBe('12.39.0-prod.01');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('matrix resolution removes prior handoffs on failure and replaces both on success', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { resolveToFiles } = require('../patch-metadata-runtime');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-handoff-'));
  const outputs = [path.join(tmp, 'patches-list.json'), path.join(tmp, 'owner-repo.metadata.json')];
  try {
    for (const file of outputs) fs.writeFileSync(file, 'stale');
    await expect(resolveToFiles({ toolsDir: tmp, slug: 'owner-repo' }, async () => { throw new Error('failure'); })).rejects.toThrow('failure');
    expect(outputs.every(file => !fs.existsSync(file))).toBe(true);
    await resolveToFiles({ toolsDir: tmp, slug: 'owner-repo' }, async () => ({ status: 'ready', list }));
    for (const file of outputs) expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(list);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('universal generated patches participate in preflight and sync alongside validated explicit packages', async () => {
  const { parseListPatches } = require('../patch-metadata');
  const universal = parseListPatches(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/patch-metadata/synthetic-optional.txt'), 'utf8'));
  const result = await preflight({ config, repoVersions: versions, resolveMetadata: async () => ({ status: 'ready', list: universal }) });
  expect(result.errors).toEqual([]);
  expect(result.rows[0].pkgListed).toBe('yes');
  expect(syncSelections(config, {}, versions, { 'owner/repo|v1': universal })['owner/repo']['com.example.app']).toEqual({ Universal: true, 'Universal opt-in': false, 'Versioned universal': true });
  expect(() => parseListPatches('Index: 0\nName: Bad\nEnabled: true\nCompatible packages:\n\tPackage name: invalid')).toThrow();
});

test('authentic null universal filtering and explicit generated opt-ins agree', async () => {
  const raw = require('./fixtures/patch-metadata/morphe-2.1.0-excerpt.json');
  const { compatiblePackages } = require('../sync-patch-selections');
  const universal = raw.patches.find(p => p.name === 'Clone app');
  expect(compatiblePackages(universal)).toEqual(['(universal)']);
  const result = await preflight({ config, repoVersions: versions, resolveMetadata: async () => ({ status: 'ready', list: raw }) });
  expect(result.errors).toEqual([]);
  const generated = { generated: true, patches: [{ ...universal, use: false }, list.patches[0]] };
  expect(enableArgs(generated, 'com.example.app', { 'Clone app': true })).toEqual(['-e', 'Clone app']);
  expect(enableArgs(generated, 'com.example.app', {})).toEqual([]);
  expect(generatedVersions(generated, 'com.example.app', { 'Clone app': true })).toEqual(['12.40.1-prod.01', '12.39.0-prod.01']);
});
test('production sync entrypoint preserves explicit null-universal choices and disables new default-false patches', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-null-'));
  try {
    const fixture = path.join(__dirname, 'fixtures/patch-metadata/morphe-2.1.0-excerpt.json');
    const preload = path.join(tmp, 'fetch.cjs');
    fs.writeFileSync(preload, `global.fetch = async () => ({ ok: true, status: 200, json: async () => require(${JSON.stringify(fixture)}) });`);
    const configFile = path.join(tmp, 'config.json'); const patchesFile = path.join(tmp, 'choices.json');
    fs.writeFileSync(configFile, JSON.stringify({ ...config, cli: { repo: 'cli/repo' } }));
    fs.writeFileSync(patchesFile, JSON.stringify({ 'owner/repo': { 'com.example.app': { 'Clone app': true, 'Spoof signature': false } } }));
    execFileSync('bash', ['.github/scripts/pipeline/sync-patches.sh'], { env: { ...process.env, NODE_OPTIONS: `--require=${preload}`, CONFIG_FILE: configFile, PATCHES_FILE: patchesFile, REPO_VERSIONS: JSON.stringify(versions) }, stdio: 'pipe' });
    expect(JSON.parse(fs.readFileSync(patchesFile))['owner/repo']['com.example.app']).toEqual({
      'Change installer source': false, 'Clone app': true, 'Disable Play Store updates': false, 'Override certificate pinning': false, 'Spoof signature': false,
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
