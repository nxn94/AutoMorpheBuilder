'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const versionCodes = require('./goopdl-version-codes.json');
const { loadConfig } = require('../../src/download/config');
const { validateDownloadedApkAbi } = require('./apk-abi-validator');

/** Download an exact Play build; return the same file contract as other providers. */
async function downloadWithGoopdl(packageId, version, outputDir, opts = {}) {
  const arch = opts.preferredArch || process.env.PREFERRED_ARCH || loadConfig().preferred_arch || 'arm64-v8a';
  if (arch !== 'arm64-v8a') throw new Error('Google Play version codes not verified for requested architecture');
  const code = (opts.versionCodes || versionCodes)[packageId]?.[version];
  if (!Number.isSafeInteger(code) || code <= 0) throw new Error('No verified Google Play version code for requested version');
  if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+$/.test(packageId) || !/^\d+(?:\.\d+)*$/.test(version)) {
    throw new Error('Invalid package or version');
  }
  const exec = opts.execFileImpl || promisify(execFile);
  const output = path.resolve(outputDir);
  fs.mkdirSync(output, { recursive: true });
  // Share only the anonymous pool, not download scratch files or the user's HOME.
  const home = path.resolve(opts.homeDir || path.join(process.env.TOOLS_DIR || 'tools', 'goopdl-home'));
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const env = { ...process.env, HOME: home };
  // Do not inherit personal account credentials; use anonymous authentication only.
  delete env.GOOPDL_ACCOUNT_EMAIL;
  delete env.GOOPDL_AAS_TOKEN;
  const runOpts = { encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env };
  const temp = fs.mkdtempSync(path.join(output, '.goopdl-'));
  const manifestPath = path.join(temp, 'integrity.json');
  const artifact = path.join(temp, 'artifact.apkm');
  try {
    try {
      // -F replaces flock with goopdl, so timeout cancellation also kills the downloader.
      await exec('flock', ['-F', '-w', '30', path.join(home, '.lock'),
        opts.goopdlBin || process.env.GOOPDL_BIN || path.resolve(process.env.TOOLS_DIR || 'tools', 'goopdl/bin/goopdl'),
        'download', packageId, '--version', String(code), '--arch', 'arm64',
        '--splits', '--no-extras', '--profile', 'Pv',
        '--integrity-manifest', manifestPath, '-o', temp,
      ], runOpts);
    } catch {
      // Upstream stderr can include token/delivery URLs; never forward it to CI logs.
      throw new Error('Google Play download unavailable or timed out');
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Empty Google Play delivery manifest');
    const names = new Set();
    let base;
    for (const item of manifest.files) {
      if (typeof item.path !== 'string' || !/^[\w.-]+\.apk$/.test(item.path) || names.has(item.path)) {
        throw new Error('Invalid Google Play artifact path');
      }
      names.add(item.path);
      const file = path.join(temp, item.path);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size || item.algorithm !== 'sha256') {
        throw new Error('Invalid Google Play artifact metadata');
      }
      const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('base64url');
      if (digest !== item.digest) throw new Error('Google Play artifact digest mismatch');
      const { stdout } = await exec('aapt', ['dump', 'badging', file], runOpts);
      const line = stdout.split('\n').find(line => line.startsWith('package:')) || '';
      const attrs = Object.fromEntries([...line.matchAll(/(\w+)='([^']*)'/g)].map(match => [match[1], match[2]]));
      if (attrs.name !== packageId || attrs.versionCode !== String(code)) throw new Error('Google Play package/version code mismatch');
      if (!attrs.split) {
        if (base || attrs.versionName !== version) throw new Error('Google Play base/version mismatch');
        base = item.path;
      }
    }
    if (!base) throw new Error('Google Play delivery has no base APK');
    // The existing APKEditor merge path accepts zip-of-APKs; never expose loose splits.
    fs.renameSync(path.join(temp, base), path.join(temp, 'base.apk'));
    const files = ['base.apk', ...[...names].filter(name => name !== base)];
    const bundled = files.length > 1;
    if (bundled) await exec('zip', ['-0', '-q', '-j', artifact, ...files.map(name => path.join(temp, name))], runOpts);
    const source = bundled ? artifact : path.join(temp, 'base.apk');
    validateDownloadedApkAbi(source, arch);
    const file = path.join(output, `${packageId}_${version}_goopdl.${bundled ? 'apkm' : 'apk'}`);
    fs.renameSync(source, file);
    return { success: true, file, source: 'goopdl', version };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = { downloadWithGoopdl };
