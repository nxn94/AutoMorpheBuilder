'use strict';

// Text grammar from morphe-desktop 2.0.0 ListPatchesCommand, exercised
// against captured upstream output. Never recover a partially parsed list.
const VERSION = /^[0-9]+(?:\.[0-9]+)+(?:[-+][A-Za-z0-9][A-Za-z0-9._+-]*)?$/;
function parseListPatches(stdout) {
  const lines = stdout.replace(/\r\n/g, '\n').split('\n');
  if (/^INFO: Morphe data root: .+ \(JAR-adjacent\)$/.test(lines[0])) lines.shift();
  if (lines[0]?.startsWith('INFO: Index: ')) lines[0] = lines[0].slice(6);
  let i = 0;
  const patches = [];
  const names = new Set();
  const fail = () => { throw new Error(`Malformed CLI metadata output at line ${i + 1}`); };
  const take = (re) => { const m = lines[i++]?.match(re); if (!m) fail(); return m[1]; };
  const blanks = () => { while (i < lines.length && !lines[i].trim()) i++; };
  blanks();
  while (i < lines.length) {
    if (Number(take(/^Index: (\d+)$/)) !== patches.length) fail();
    const name = take(/^Name: (\S.*)$/);
    if (names.has(name)) fail();
    names.add(name);
    const description = lines[i]?.startsWith('Description: ') ? take(/^Description: (.*)$/) : undefined;
    const use = take(/^Enabled: (true|false)$/) === 'true';
    let options = '';
    if (lines[i] === 'Options:') {
      i++;
      const start = i;
      while (i < lines.length && (lines[i].startsWith('\t') || !lines[i])) i++;
      options = lines.slice(start, i).join('\n');
      // Options are informational to these consumers, but accept only the
      // known option fields. Unrecognised output must not hide parse errors.
      if (!options || !options.includes('\tKey: ') || !options.includes('\tType: ')) fail();
      for (const line of options.split('\n')) {
        if (line.trim() && !/^\t(?:Title|Description|Required|Key|Default|Type): .*$/.test(line)) fail();
      }
    }
    const compatiblePackages = [];
    const hasPackages = lines[i] === 'Compatible packages:';
    if (hasPackages) i++;
    else compatiblePackages.push({ packageName: '(universal)', unrestricted: true, targets: [] });
    while (hasPackages && lines[i]?.startsWith('\tPackage name: ')) {
      const packageName = take(/^\tPackage name: ([A-Za-z][\w]*(?:\.[\w]+)+|\(universal\))$/);
      const targets = [];
      let unrestricted = true;
      if (lines[i] === '\tCompatible versions:') {
        i++;
        unrestricted = false;
        while (lines[i]?.startsWith('\t\t')) {
          const version = lines[i++].slice(2);
          if (!VERSION.test(version)) fail();
          targets.push({ version });
        }
        if (!targets.length) fail();
      }
      if (lines[i] === '\tVersion codes:') {
        i++;
        const seen = new Set();
        while (lines[i]?.startsWith('\t\t')) {
          const row = lines[i++].slice(2).match(/^(.+): ([A-Z][A-Z0-9_]*=[0-9]+(?:, [A-Z][A-Z0-9_]*=[0-9]+)*)$/);
          if (!row || !targets.some((t) => t.version === row[1]) || seen.has(row[1])) fail();
          const codes = row[2].split(', ').map((entry) => entry.split('='));
          if (new Set(codes.map(([abi]) => abi)).size !== codes.length
            || codes.some(([abi, code]) => !['ARM64_V8A', 'ARMEABI_V7A', 'X86_64', 'X86'].includes(abi)
              || !Number.isSafeInteger(Number(code)) || Number(code) > 2147483647)) fail();
          seen.add(row[1]);
        }
        if (!seen.size) fail();
      }
      compatiblePackages.push({ packageName, ...(unrestricted ? { unrestricted: true } : {}), targets });
    }
    if (!compatiblePackages.length) fail();
    patches.push({ name, ...(description === undefined ? {} : { description }), use, ...(options ? { options } : {}), compatiblePackages });
    blanks();
  }
  if (!patches.length) fail();
  return { generated: true, patches };
}
// Validate structure separately from absence of compatibility information.
// Historical structured lists are returned unchanged for legacy consumers.
function metadataUsable(list) {
  const patches = Array.isArray(list) ? list : list?.patches;
  const malformed = () => { throw new Error('Malformed metadata schema'); };
  if (!Array.isArray(patches)) malformed();
  if (patches.length && patches.every((p) => typeof p === 'string' && p.length)) return false;
  function validateTargets(targets) {
    if (targets == null) return;
    if (!Array.isArray(targets)) malformed();
    for (const t of targets) {
      if (typeof t === 'string' && t) continue;
      if (!t || (!(t.version === null && !list.generated) && (typeof t.version !== 'string' || !t.version))
        || (t.isExperimental != null && typeof t.isExperimental !== 'boolean')) malformed();
    }
  }
  let usable = patches.length === 0;
  const names = new Set();
  for (const patch of patches) {
    if (!patch || typeof patch.name !== 'string' || !patch.name || (list.generated && names.has(patch.name))) malformed();
    names.add(patch.name);
    const compat = Object.hasOwn(patch, 'compatiblePackages') ? patch.compatiblePackages : patch.compatible_packages;
    if (compat === undefined) malformed();
    if (patch.default != null && typeof patch.default !== 'boolean') malformed();
    if (patch.use != null && typeof patch.use !== 'boolean') malformed();
    if (compat === null) { usable = true; continue; }
    if (typeof compat !== 'object') malformed();
    if (Array.isArray(compat)) {
      for (const entry of compat) {
        if (!entry || typeof (entry.packageName || entry.name) !== 'string') malformed();
        validateTargets(entry.targets);
      }
    }
    if (!Array.isArray(compat)) {
      for (const entry of Object.values(compat)) {
        if (entry === null) continue;
        if (Array.isArray(entry)) validateTargets(entry);
        else if (typeof entry === 'object') { validateTargets(entry.targets); validateTargets(entry.versions); }
        else malformed();
      }
    }
    if (patch.use != null && typeof patch.use !== 'boolean') malformed();
    if (Object.keys(compat).length) usable = true;
  }
  return usable;
}

const { parsePatchSource, resolveGitlabBundle, gitlabRawFileUrl } = require('./patch-source');

const RELEASE_ASSET_API = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/;

// Only explicit 404 is absence. HTTP/auth/rate-limit and transport failures
// retain bounded retries and an abort deadline including response-body reads.
function createMetadataResolver({ fetchImpl = fetch, derive = deriveMetadata, retryDelay = 1000, log = console.error } = {}) {
  const absent = Symbol('HTTP 404');
  const requests = new Map();
  const results = new Map();
  async function request(url, { optional = false, binary = false, accept } = {}) {
    const key = `${url}|${binary}`;
    if (!requests.has(key)) requests.set(key, (async () => {
      for (let attempt = 0; ; attempt++) {
        let retryable = true;
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Metadata requires credential-free HTTPS');
          // gitlab.com's unauthenticated API is rate limited hard enough to
          // fail a build; an optional token raises the ceiling. Never logged.
          const headers = parsed.hostname === 'api.github.com' && process.env.GH_TOKEN
            ? { Authorization: `Bearer ${process.env.GH_TOKEN}` }
            : parsed.hostname === 'gitlab.com' && process.env.GITLAB_TOKEN
              ? { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN } : {};
          if (accept) headers.Accept = accept;
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000), headers });
          if (optional && response.status === 404) return absent;
          if (!response.ok) {
            retryable = response.status === 429 || response.status >= 500;
            throw new Error(`HTTP ${response.status} fetching metadata`);
          }
          return binary ? Buffer.from(await response.arrayBuffer()) : await response.json();
        } catch (error) {
          if (error instanceof SyntaxError) throw new Error('Malformed metadata JSON', { cause: error });
          if (!retryable || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    })());
    return requests.get(key);
  }
  // Two routes to the same release asset: the REST asset endpoint (the route
  // `gh release download` uses), then the public download URL. Unavailability
  // of one route is not absence; the asset is still required from the other.
  // Bad content is final, because both routes serve the same bytes.
  async function requestAsset(asset, options = {}) {
    if (!RELEASE_ASSET_API.test(asset.url || '')) return request(asset.browser_download_url, options);
    try {
      return await request(asset.url, { ...options, accept: 'application/octet-stream' });
    } catch (error) {
      if (error.message.startsWith('Malformed metadata') || !asset.browser_download_url) throw error;
      log(`[metadata] release asset ${asset.name}: API route failed (${error.message}); trying download URL`);
      return request(asset.browser_download_url, options);
    }
  }
  async function resolve(options) {
    const { repo, tag, cli } = options;
    if (!tag) throw new Error(`No resolved tag for ${repo}`);
    const key = JSON.stringify([repo, tag, cli, options.mppPath, options.jarPath]);
    if (!results.has(key)) results.set(key, (async () => {
      const source = parsePatchSource(repo);
      // GitLab keeps the same two-step shape as GitHub: the exact tagged raw
      // patches-list.json first, then metadata derived from the digest-verified
      // MPP. What has no GitLab equivalent is the middle step — GitLab's
      // release assets are bare links with no digest — so the bundle is taken
      // from the generic package registry, the only route that publishes a
      // per-file SHA-256 for `verifiedAsset` to enforce.
      if (source.host === 'gitlab') {
        const gitlabRaw = await request(gitlabRawFileUrl(source, tag, 'patches-list.json'), { optional: true });
        if (gitlabRaw !== absent && metadataUsable(gitlabRaw)) {
          log(`[metadata] ${repo}@${tag}: raw`);
          return { status: 'ready', provenance: 'raw', list: gitlabRaw };
        }
        if (!cli?.repo || !cli?.tag) {
          log(`[metadata] ${repo}@${tag}: deferred; verified MPP + configured CLI required`);
          return { status: 'deferred', provenance: 'mpp', list: null };
        }
        const bundle = await resolveGitlabBundle(source, { tag, branch: options.branch, request });
        const derived = await derive({ ...options, release: bundle, request, requestAsset });
        if (!metadataUsable(derived)) throw new Error('Malformed metadata from CLI');
        log(`[metadata] ${repo}@${tag}: mpp (${cli.repo}@${cli.tag})`);
        return { status: 'ready', provenance: 'mpp', list: derived };
      }
      const raw = await request(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(tag)}/patches-list.json`, { optional: true });
      let list = raw;
      let provenance = 'raw';
      let release;
      if (list === absent || !metadataUsable(list)) {
        release = await request(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
        if (!Array.isArray(release?.assets)) throw new Error('Malformed metadata release assets');
        const asset = release.assets.find((a) => a.name === 'patches-list.json');
        list = asset ? await requestAsset(asset) : absent;
        provenance = 'release';
      }
      if (list === absent || !metadataUsable(list)) {
        if (!cli?.repo || !cli?.tag) {
          log(`[metadata] ${repo}@${tag}: deferred; verified MPP + configured CLI required`);
          return { status: 'deferred', provenance: 'mpp', list: null };
        }
        list = await derive({ ...options, release, request, requestAsset });
        if (!metadataUsable(list)) throw new Error('Malformed metadata from CLI');
        provenance = 'mpp';
      }
      log(`[metadata] ${repo}@${tag}: ${provenance}${provenance === 'mpp' ? ` (${cli.repo}@${cli.tag})` : ''}`);
      return { status: 'ready', provenance, list };
    })());
    return results.get(key);
  }
  return resolve;
}

async function deriveMetadata({ repo, tag, cli, release, request, requestAsset = (asset, options) => request(asset.browser_download_url, options), toolsDir = './tools', mppPath, jarPath,
  execImpl = require('node:util').promisify(require('node:child_process').execFile) }) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const root = path.resolve(toolsDir, 'metadata-artifacts');
  fs.mkdirSync(root, { recursive: true });
  async function verifiedAsset(assets, pattern, localPath) {
    const matches = assets?.filter((a) => pattern.test(a.name));
    if (matches?.length !== 1) throw new Error('Expected exactly one metadata tool asset');
    const asset = matches[0];
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error('Missing SHA-256 asset digest for metadata execution');
    const expected = asset.digest.slice(7);
    // Content addressing isolates tags, CLI versions and republished bytes.
    // Local pipeline paths are accepted only after matching this exact release.
    const dest = path.join(root, expected + path.extname(asset.name));
    let bytes;
    if (localPath && fs.existsSync(localPath)) bytes = fs.readFileSync(localPath);
    else if (fs.existsSync(dest)) bytes = fs.readFileSync(dest);
    else bytes = await requestAsset(asset, { binary: true });
    if (sha(bytes) !== expected) throw new Error(`SHA-256 mismatch for metadata asset ${asset.name}`);
    atomicWrite(dest, bytes);
    return dest;
  }
  const mpp = await verifiedAsset(release.assets, /^patches-.*\.mpp$/, mppPath);
  const cliRelease = await request(`https://api.github.com/repos/${cli.repo}/releases/tags/${encodeURIComponent(cli.tag)}`);
  const jar = await verifiedAsset(cliRelease.assets, /^morphe-(?:desktop|cli)-.*-all\.jar$/, jarPath);
  const scratch = fs.mkdtempSync(path.join(root, 'run-'));
  try {
    // The CLI writes morphe-data beside its JAR. Keep that side effect inside
    // a disposable directory; never load user state from a normal CLI home.
    const runJar = path.join(scratch, 'morphe-desktop.jar');
    fs.copyFileSync(jar, runJar);
    async function listing(extra = []) {
      const { stdout, stderr } = await execImpl('java', ['-jar', runJar, 'list-patches', `--patches=${mpp}`, '-p', '-v', '--with-descriptions=false', ...extra],
        { cwd: scratch, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      if (/Exception|Error|FAIL/.test(stderr || '')) throw new Error(`CLI incompatible with ${repo}@${tag}`);
      return parseListPatches(stdout);
    }
    const stable = await listing();
    // CLI display drops experimental targets and then prints an empty target
    // set exactly like unrestricted compatibility. Consult -x only to remove
    // that ambiguity; its extra versions are never enabled or selected.
    if (stable.patches.some((p) => p.compatiblePackages.some((c) => c.unrestricted))) {
      return reconcileExperimental(stable, await listing(['-x']));
    }
    return stable;
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

function reconcileExperimental(stable, all) {
  if (stable.patches.length !== all.patches.length) throw new Error('Inconsistent CLI metadata output');
  return { ...stable, patches: stable.patches.map((patch, i) => {
    const other = all.patches[i];
    if (other.name !== patch.name || other.use !== patch.use || other.compatiblePackages.length !== patch.compatiblePackages.length) throw new Error('Inconsistent CLI metadata output');
    return { ...patch, compatiblePackages: patch.compatiblePackages.map((c, j) => {
      const full = other.compatiblePackages[j];
      if (full.packageName !== c.packageName || c.targets.some((t) => !full.targets.some((v) => v.version === t.version))) throw new Error('Inconsistent CLI metadata output');
      return c.unrestricted && !full.unrestricted ? { ...c, unrestricted: false } : c;
    }) };
  }) };
}

function atomicWrite(dest, data) {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const temp = `${dest}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, data, { flag: 'wx' });
    fs.renameSync(temp, dest);
  } finally { fs.rmSync(temp, { force: true }); }
}
function matchesPackage(packageName, appId) {
  return packageName === null || packageName === '(universal)' || packageName === appId;
}
function effectivePatches(list, appId, choices) {
  return list.patches.filter((p) => (choices[p.name] ?? p.use) === true
    && (p.compatiblePackages === null || p.compatiblePackages.some((c) => matchesPackage(c.packageName, appId))));
}
function generatedVersions(list, appId, choices = {}, pin = '') {
  const patches = effectivePatches(list, appId, choices);
  if (!patches.length) return [];
  const compat = patches.map((p) => p.compatiblePackages === null
    ? { unrestricted: true, targets: [] } : p.compatiblePackages.find((c) => matchesPackage(c.packageName, appId)));
  const restricted = compat.filter((c) => !c.unrestricted)
    .map((c) => c.targets.filter((t) => !t.isExperimental).map((t) => t.version));
  if (pin) {
    if (!VERSION.test(pin) || restricted.some((targets) => !targets.includes(pin))) throw new Error(`Pinned version ${pin} incompatible with enabled patches for ${appId}`);
    return [pin];
  }
  if (!restricted.length) return []; // unrestricted never means implicit latest
  return [...new Set(restricted.reduce((a, b) => a.filter((v) => b.includes(v))))]
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}
function structuredPackages(patch) {
  const raw = patch.compatiblePackages ?? patch.compatible_packages ?? null;
  if (raw === null) return null;
  return Array.isArray(raw) ? raw.map((c) => c.packageName ?? c.name) : Object.keys(raw);
}
// -e only for a chosen patch that is off by default: the CLI acts on every patch
// of that name, so enabling a default-on one can switch on a same-named universal
// patch that should stay off.
function structuredEnableArgs(list, appId, choices) {
  const applies = (p) => (structuredPackages(p) ?? []).some((name) => matchesPackage(name, appId));
  const offByDefault = (name) => {
    const named = (list.patches || []).filter((p) => p.name === name);
    const own = named.filter(applies);
    const used = own.length ? own : named.filter((p) => structuredPackages(p) === null);
    return used.some((p) => (p.use ?? p.default) === false);
  };
  return Object.keys(choices).filter((name) => choices[name] === true && offByDefault(name)).flatMap((name) => ['-e', name]);
}
function enableArgs(list, appId, choices, { honorOptIns = false } = {}) {
  if (!list.generated) return honorOptIns ? structuredEnableArgs(list, appId, choices) : [];
  return effectivePatches(list, appId, choices).filter((p) => choices[p.name] === true && !p.use)
    .flatMap((p) => ['-e', p.name]);
}
module.exports = { matchesPackage, reconcileExperimental, generatedVersions, enableArgs, parseListPatches, VERSION, metadataUsable, createMetadataResolver, deriveMetadata, atomicWrite };
