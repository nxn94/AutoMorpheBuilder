'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseListPatches } = require('../patch-metadata');
const real = fs.readFileSync(path.join(__dirname, 'fixtures/patch-metadata/piko-3.74.0-cli-2.0.0.txt'), 'utf8');
test('real Piko CLI output retains exact patch names, defaults, options and version suffixes', () => {
  const list = parseListPatches(real);
  expect(list.generated).toBe(true);
  expect(list.patches).toHaveLength(52);
  expect(list.patches[0]).toMatchObject({ name: 'NewX: Remove ads', use: true,
    compatiblePackages: [{ packageName: 'com.twitter.android', targets: [
      { version: '12.38.1-prod.01' }, { version: '12.39.0-prod.01' }, { version: '12.40.1-prod.01' },
    ] }] });
  expect(list.patches[5]).toMatchObject({ use: false, options: expect.stringContaining('Key: packageName') });
});
test.each([
  real.replace('Enabled: true', 'Enabled: maybe'),
  real.replace('\t\t12.38.1-prod.01', '\t\t???'),
  real.replace('Compatible packages:', 'Unknown packages:'),
  real.replace('Name: NewX: Disable blur effects', 'Name: NewX: Remove ads'),
  real + '\nERROR: incompatible CLI\n',
  '',
])('unexpected/malformed CLI output fails closed', (text) => {
  expect(() => parseListPatches(text)).toThrow(/metadata|output/i);
});
test('package without versions is explicitly unrestricted; empty version section is malformed', () => {
  const prefix = 'Index: 0\nName: Global\nDescription: test\nEnabled: false\nCompatible packages:\n\tPackage name: com.example.app';
  expect(parseListPatches(prefix).patches[0].compatiblePackages[0]).toEqual({ packageName: 'com.example.app', unrestricted: true, targets: [] });
  expect(() => parseListPatches(prefix + '\n\tCompatible versions:')).toThrow();
});

const { createMetadataResolver } = require('../patch-metadata');
const legacy = [{ name: 'Patch', compatiblePackages: { 'com.example.app': ['1.2.3'] } }];
function network(routes) {
  return jest.fn(async (url) => {
    const [status, value] = routes[url] || [404, null];
    return { ok: status === 200, status, json: async () => value };
  });
}
const raw = 'https://raw.githubusercontent.com/owner/repo/v1/patches-list.json';
const release = 'https://api.github.com/repos/owner/repo/releases/tags/v1';
test('usable tagged raw metadata keeps legacy format and one request', async () => {
  const fetchImpl = network({ [raw]: [200, legacy] });
  const resolve = createMetadataResolver({ fetchImpl });
  expect(await resolve({ repo: 'owner/repo', tag: 'v1' })).toMatchObject({ list: legacy, provenance: 'raw', status: 'ready' });
  await resolve({ repo: 'owner/repo', tag: 'v1' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('absent raw uses only same-release structured list', async () => {
  const url = 'https://github.com/owner/repo/releases/download/v1/patches-list.json';
  const fetchImpl = network({ [release]: [200, { assets: [{ name: 'patches-list.json', browser_download_url: url }] }], [url]: [200, legacy] });
  const resolve = createMetadataResolver({ fetchImpl });
  expect(await resolve({ repo: 'owner/repo', tag: 'v1' })).toMatchObject({ list: legacy, provenance: 'release' });
  expect(fetchImpl.mock.calls.flat().join(' ')).not.toContain('/latest');
});
test('names-only metadata defers until verified tools are available, then derives MPP metadata', async () => {
  const fetchImpl = network({ [raw]: [200, ['Patch']], [release]: [200, { assets: [] }] });
  const derive = jest.fn(async () => parseListPatches(real));
  const resolve = createMetadataResolver({ fetchImpl, derive });
  expect(await resolve({ repo: 'owner/repo', tag: 'v1' })).toMatchObject({ status: 'deferred' });
  expect(derive).not.toHaveBeenCalled();
  expect(await resolve({ repo: 'owner/repo', tag: 'v1', cli: { repo: 'cli/repo', tag: 'v2' } })).toMatchObject({ status: 'ready', provenance: 'mpp', list: { generated: true } });
  expect(derive).toHaveBeenCalledTimes(1);
});
test.each([401, 403, 429, 500])('HTTP %s is never mistaken for missing metadata', async (status) => {
  const fetchImpl = network({ [raw]: [status, null] });
  await expect(createMetadataResolver({ fetchImpl, retryDelay: 0 })({ repo: 'owner/repo', tag: 'v1' })).rejects.toThrow(`HTTP ${status}`);
  expect(fetchImpl.mock.calls.every(([url]) => url === raw)).toBe(true);
  expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(3);
});
test.each([{}, [{ name: 'Patch', compatiblePackages: 'wrong' }], [{ name: 4 }]])('malformed schemas fail distinctly', async (body) => {
  await expect(createMetadataResolver({ fetchImpl: network({ [raw]: [200, body] }) })({ repo: 'owner/repo', tag: 'v1' })).rejects.toThrow(/Malformed metadata/);
});
test('missing exact release is an error; pins and CLI tags do not share results', async () => {
  const fetchImpl = network({ [raw]: [200, ['Patch']], [release]: [200, { assets: [] }] });
  const derive = jest.fn(async () => parseListPatches(real));
  const resolve = createMetadataResolver({ fetchImpl, derive });
  await resolve({ repo: 'owner/repo', tag: 'v1', cli: { repo: 'cli/repo', tag: 'v2' } });
  await resolve({ repo: 'owner/repo', tag: 'v1', cli: { repo: 'cli/repo', tag: 'v3' } });
  expect(derive).toHaveBeenCalledTimes(2);
  await expect(resolve({ repo: 'owner/repo', tag: 'v0' })).rejects.toThrow(/HTTP 404/);
});

const os = require('node:os');
const crypto = require('node:crypto');
const { deriveMetadata } = require('../patch-metadata');
function digest(bytes) { return 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex'); }
test('MPP fallback verifies exact release bytes, isolates execution, and fails on incompatible CLI', async () => {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-test-'));
  const mpp = Buffer.from('bundle');
  const jar = Buffer.from('CLI');
  const asset = (name, bytes) => ({ name, digest: digest(bytes), browser_download_url: `https://example.com/${name}` });
  const release = { assets: [asset('patches-1.mpp', mpp)] };
  const request = jest.fn(async (url) => url.includes('/releases/tags/')
    ? { assets: [asset('morphe-desktop-2-all.jar', jar)] } : url.endsWith('.mpp') ? mpp : jar);
  const execImpl = jest.fn(async (_cmd, args, opts) => {
    expect(args).toContain('list-patches');
    expect(args).toContain('--with-descriptions=false');
    expect(args).not.toContain('-o');
    expect(args).not.toContain('-x');
    expect(opts.timeout).toBe(60000);
    expect(opts.cwd.startsWith(toolsDir)).toBe(true);
    return { stdout: real, stderr: '' };
  });
  const options = { repo: 'owner/repo', tag: 'v1', cli: { repo: 'cli/repo', tag: 'v2' }, release, request, toolsDir, execImpl };
  try {
    expect((await deriveMetadata(options)).patches).toHaveLength(52);
    expect(execImpl).toHaveBeenCalledTimes(1);
    await expect(deriveMetadata({ ...options, execImpl: async () => { throw new Error('NoSuchMethodError'); } })).rejects.toThrow(/NoSuchMethodError/);
    await expect(deriveMetadata({ ...options, release: { assets: [asset('patches-1.mpp', Buffer.from('wrong'))] } })).rejects.toThrow(/SHA-256/);
    await expect(deriveMetadata({ ...options, release: { assets: [{ name: 'patches-1.mpp' }] } })).rejects.toThrow(/digest/);
  } finally { fs.rmSync(toolsDir, { recursive: true, force: true }); }
});

test('experimental-only packages cannot masquerade as unrestricted CLI output', () => {
  const { reconcileExperimental } = require('../patch-metadata');
  const prefix = 'Index: 0\nName: Experimental\nDescription: test\nEnabled: true\nCompatible packages:\n\tPackage name: com.example.app';
  const stable = parseListPatches(prefix);
  const all = parseListPatches(prefix + '\n\tCompatible versions:\n\t\t99.0');
  expect(reconcileExperimental(stable, all).patches[0].compatiblePackages[0]).toMatchObject({ unrestricted: false, targets: [] });
  expect(() => reconcileExperimental(stable, { patches: [] })).toThrow();
});
test('unknown fields inside options are malformed, even if Key and Type exist', () => {
  expect(() => parseListPatches(real.replace('\tKey: packageName', '\tUnknown: surprise\n\tKey: packageName'))).toThrow();
});
test.each([
  [[{ name: 'Bad', compatiblePackages: { 'com.example.app': { versions: 'broken' } } }]],
  [[{ name: 'Bad', compatiblePackages: [{ packageName: 'com.example.app', targets: [{ version: 3 }] }] }]],
])('malformed compatibility targets do not get accepted as metadata', (list) => {
  expect(() => require('../patch-metadata').metadataUsable(list)).toThrow(/Malformed metadata/);
});

test('a JSON null document is malformed, not HTTP absence', async () => {
  await expect(createMetadataResolver({ fetchImpl: network({ [raw]: [200, null] }) })({ repo: 'owner/repo', tag: 'v1' })).rejects.toThrow(/Malformed metadata/);
});
test('valid local artifacts cannot cause an already-corrupt content cache to be executed', async () => {
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-cache-'));
  const bytes = Buffer.from('valid');
  const hash = digest(bytes).slice(7);
  const root = path.join(toolsDir, 'metadata-artifacts'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, hash + '.mpp'), 'corrupt');
  const local = path.join(toolsDir, 'local.mpp'); fs.writeFileSync(local, bytes);
  const asset = (name) => ({ name, digest: digest(bytes), browser_download_url: `https://example.com/${name}` });
  try {
    await deriveMetadata({ repo: 'owner/repo', tag: 'v1', cli: { repo: 'cli/repo', tag: 'v2' }, toolsDir, mppPath: local,
      release: { assets: [asset('patches-1.mpp')] }, request: async (url) => url.includes('/releases/') ? { assets: [asset('morphe-desktop-2-all.jar')] } : bytes,
      execImpl: async (_cmd, args) => {
        const mpp = args.find(a => a.startsWith('--patches=')).slice(10);
        expect(fs.readFileSync(mpp)).toEqual(bytes);
        return { stdout: real, stderr: '' };
      } });
  } finally { fs.rmSync(toolsDir, { recursive: true, force: true }); }
});

// Source-shaped synthetic output; not a live artifact capture.
const synthetic = fs.readFileSync(path.join(__dirname, 'fixtures/patch-metadata/synthetic-optional.txt'), 'utf8');
test('minimal listing accepts universal compatibility and strictly formatted version codes', () => {
  const { metadataUsable, generatedVersions, enableArgs } = require('../patch-metadata');
  const list = parseListPatches(synthetic);
  expect(metadataUsable(list)).toBe(true);
  expect(list.patches[0].compatiblePackages).toEqual([{ packageName: '(universal)', unrestricted: true, targets: [] }]);
  expect(generatedVersions(list, 'com.example.app')).toEqual(['12.40.1-prod.01']);
  expect(enableArgs(list, 'com.example.app', { 'Universal opt-in': true })).toEqual(['-e', 'Universal opt-in']);
  const unrestricted = { ...list, patches: list.patches.slice(0, 2) };
  expect(generatedVersions(unrestricted, 'com.example.app')).toEqual([]);
  expect(generatedVersions(unrestricted, 'com.example.app', {}, '1.2')).toEqual(['1.2']);
  for (const text of [synthetic.replace('Compatible packages:\n', ''), synthetic.replace('ARM64_V8A=123', 'ARM64_V8A=bad'), synthetic.replace('ARM64_V8A=123', 'UNKNOWN=123'), synthetic.replace('ARMEABI_V7A=124', 'ARM64_V8A=124'), synthetic.replace('Version codes:', 'Unknown codes:'), synthetic.replace('12.40.1-prod.01: ARM', '99.0: ARM'), synthetic.replace('(universal)', 'bad-package')]) {
    expect(() => parseListPatches(text)).toThrow();
  }
});
test('universal experimental-only versions stay excluded even with an explicit pin', () => {
  const { reconcileExperimental, generatedVersions } = require('../patch-metadata');
  const prefix = 'Index: 0\nName: Experimental universal\nEnabled: true\nCompatible packages:\n\tPackage name: (universal)';
  const stable = parseListPatches(prefix);
  const all = parseListPatches(prefix + '\n\tCompatible versions:\n\t\t99.0');
  const result = reconcileExperimental(stable, all);
  expect(generatedVersions(result, 'com.example.app')).toEqual([]);
  expect(() => generatedVersions(result, 'com.example.app', {}, '99.0')).toThrow(/Pinned/);
});

const morphe = require('./fixtures/patch-metadata/morphe-2.1.0-excerpt.json');
test('authentic Morphe null universals resolve directly from exact raw without fallback', async () => {
  const universals = { ...morphe, patches: morphe.patches.filter(p => p.compatiblePackages === null) };
  const fetchImpl = network({ [raw]: [200, universals] });
  const derive = jest.fn();
  expect(await createMetadataResolver({ fetchImpl, derive })({ repo: 'owner/repo', tag: 'v1' }))
    .toMatchObject({ status: 'ready', provenance: 'raw', list: universals });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(derive).not.toHaveBeenCalled();
});
test.each([undefined, 'wrong', 42, false])('missing or malformed compatibility %s fails even beside valid metadata', (value) => {
  const bad = { name: 'Bad' };
  if (value !== undefined) bad.compatiblePackages = value;
  expect(() => require('../patch-metadata').metadataUsable({ patches: [...morphe.patches, bad] })).toThrow(/Malformed metadata/);
});

test('authentic structured metadata permits repeated names across package declarations', async () => {
  const fetchImpl = network({ [raw]: [200, morphe] });
  expect(await createMetadataResolver({ fetchImpl })({ repo: 'owner/repo', tag: 'v1' }))
    .toMatchObject({ status: 'ready', provenance: 'raw', list: morphe });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(() => require('../patch-metadata').metadataUsable({ ...morphe, generated: true })).toThrow(/Malformed metadata/);
});

test('authentic hoo-dles explicit null target resolves raw; omitted version remains malformed', async () => {
  const list = require('./fixtures/patch-metadata/hoodles-1.47.0-excerpt.json');
  const fetchImpl = network({ [raw]: [200, list] });
  expect(await createMetadataResolver({ fetchImpl })({ repo: 'owner/repo', tag: 'v1' }))
    .toMatchObject({ status: 'ready', provenance: 'raw', list });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const bad = JSON.parse(JSON.stringify(list));
  delete bad.patches[0].compatiblePackages[0].targets[0].version;
  expect(() => require('../patch-metadata').metadataUsable(bad)).toThrow(/Malformed metadata/);
});

describe('release asset routes', () => {
  const apiUrl = 'https://api.github.com/repos/owner/repo/releases/assets/7';
  const downloadUrl = 'https://github.com/owner/repo/releases/download/v1/patches-list.json';
  const asset = { name: 'patches-list.json', url: apiUrl, browser_download_url: downloadUrl };
  const options = { repo: 'owner/repo', tag: 'v1' };
  const token = process.env.GH_TOKEN;
  beforeEach(() => { process.env.GH_TOKEN = 'test-token'; });
  afterAll(() => { if (token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = token; });
  const routed = (apiRoute, downloadRoute, item = asset) => network({
    [release]: [200, { assets: [item] }], [apiUrl]: apiRoute, [downloadUrl]: downloadRoute,
  });
  const calls = (fetchImpl, url) => fetchImpl.mock.calls.filter(([u]) => u === url);

  test('download URL outage does not matter when the API route answers', async () => {
    const fetchImpl = routed([200, legacy], [504, null]);
    const resolve = createMetadataResolver({ fetchImpl, retryDelay: 0, log: () => {} });
    expect(await resolve(options)).toMatchObject({ list: legacy, provenance: 'release', status: 'ready' });
    expect(calls(fetchImpl, downloadUrl)).toHaveLength(0);
    expect(calls(fetchImpl, apiUrl)[0][1].headers).toMatchObject({ Accept: 'application/octet-stream', Authorization: 'Bearer test-token' });
  });
  test.each([403, 404, 503])('API HTTP %s falls back to the download URL without sending the token', async (status) => {
    const log = jest.fn();
    const fetchImpl = routed([status, null], [200, legacy]);
    const resolve = createMetadataResolver({ fetchImpl, retryDelay: 0, log });
    expect(await resolve(options)).toMatchObject({ list: legacy, provenance: 'release' });
    expect(calls(fetchImpl, downloadUrl)[0][1].headers).toEqual({});
    expect(log.mock.calls.flat().join(' ')).toContain(`HTTP ${status}`);
  });
  test('both routes down stops resolution: never deferred, never derived', async () => {
    const derive = jest.fn();
    const fetchImpl = routed([504, null], [504, null]);
    const resolve = createMetadataResolver({ fetchImpl, derive, retryDelay: 0, log: () => {} });
    await expect(resolve({ ...options, cli: { repo: 'cli/repo', tag: 'v2' } })).rejects.toThrow('HTTP 504');
    expect(derive).not.toHaveBeenCalled();
    expect(calls(fetchImpl, apiUrl)).toHaveLength(3);
    expect(calls(fetchImpl, downloadUrl)).toHaveLength(3);
  });
  test('malformed content is final and does not switch routes', async () => {
    const fetchImpl = jest.fn(async (url) => url === release
      ? { ok: true, status: 200, json: async () => ({ assets: [asset] }) }
      : url === apiUrl
        ? { ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }
        : { ok: false, status: 404, json: async () => null });
    await expect(createMetadataResolver({ fetchImpl, retryDelay: 0, log: () => {} })(options)).rejects.toThrow('Malformed metadata JSON');
    expect(calls(fetchImpl, downloadUrl)).toHaveLength(0);
  });
  test.each([
    ['missing', undefined],
    ['another host', 'https://example.com/repos/owner/repo/releases/assets/7'],
    ['not an asset', 'https://api.github.com/repos/owner/repo/releases/7'],
  ])('%s asset API URL uses only the download URL', async (_label, url) => {
    const fetchImpl = routed([200, []], [200, legacy], { ...asset, url });
    expect(await createMetadataResolver({ fetchImpl, retryDelay: 0, log: () => {} })(options)).toMatchObject({ list: legacy });
    expect(fetchImpl.mock.calls.flatMap(([, init]) => (init.headers.Authorization ? [] : [init.headers.Accept])).filter(Boolean)).toEqual([]);
  });
  test('MPP and CLI bytes use the API route and are still digest-verified', async () => {
    const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metadata-routes-'));
    const mpp = Buffer.from('bundle');
    const jar = Buffer.from('CLI');
    const mppAsset = { name: 'patches-1.mpp', digest: digest(mpp), url: 'https://api.github.com/repos/owner/repo/releases/assets/8', browser_download_url: 'https://github.com/owner/repo/releases/download/v1/patches-1.mpp' };
    const jarAsset = { name: 'morphe-desktop-2-all.jar', digest: digest(jar), url: 'https://api.github.com/repos/cli/repo/releases/assets/9', browser_download_url: 'https://github.com/cli/repo/releases/download/v2/morphe-desktop-2-all.jar' };
    const cliRelease = 'https://api.github.com/repos/cli/repo/releases/tags/v2';
    const bytes = (body) => ({ ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) });
    const fetchImpl = jest.fn(async (url) => {
      if (url === raw) return { ok: true, status: 200, json: async () => ['Patch'] };
      if (url === release) return { ok: true, status: 200, json: async () => ({ assets: [mppAsset] }) };
      if (url === cliRelease) return { ok: true, status: 200, json: async () => ({ assets: [jarAsset] }) };
      if (url === mppAsset.url) return bytes(fetchImpl.corrupt ? Buffer.from('wrong') : mpp);
      if (url === jarAsset.url) return bytes(jar);
      return { ok: false, status: 504, json: async () => null };
    });
    const derive = (o) => deriveMetadata({ ...o, toolsDir, execImpl: async () => ({ stdout: real, stderr: '' }) });
    const cliOption = { ...options, cli: { repo: 'cli/repo', tag: 'v2' } };
    try {
      expect(await createMetadataResolver({ fetchImpl, derive, retryDelay: 0, log: () => {} })(cliOption)).toMatchObject({ provenance: 'mpp', status: 'ready' });
      expect(fetchImpl.mock.calls.some(([url]) => url.includes('/releases/download/'))).toBe(false);
      fs.rmSync(toolsDir, { recursive: true, force: true });
      fetchImpl.corrupt = true;
      await expect(createMetadataResolver({ fetchImpl, derive, retryDelay: 0, log: () => {} })(cliOption)).rejects.toThrow(/SHA-256/);
    } finally { fs.rmSync(toolsDir, { recursive: true, force: true }); }
  });
});
