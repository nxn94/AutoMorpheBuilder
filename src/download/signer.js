'use strict';

/**
 * Was the original APK signed by the app's real developer?
 *
 * Before an APK is patched, the SHA-256 of its signing certificate must
 * be one listed for the app in .github/scripts/apk-signers.json (taken
 * from APKMirror's "APK certificate fingerprints"). If a mirror or a
 * fallback source serves a repackaged APK, the build fails instead of
 * patching and publishing it.
 *
 * Bundles (.apkm/.xapk/.apks, or a bundle saved as .apk) are checked on
 * their base.apk, before APKEditor merges them (the merged APK is
 * unsigned). Apps not in the list are skipped with a notice. A wrong
 * signer fails. So does an APK that apksigner can't verify, because an
 * unsigned or broken original can't be trusted either.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIGNERS_FILE = path.join(__dirname, '..', '..', '.github', 'scripts', 'apk-signers.json');
const LIST_BUFFER = 64 * 1024 * 1024;
const APK_BUFFER = 2 * 1024 * 1024 * 1024;

/** apksigner found no valid signature (e.g. our own APKEditor merge), as opposed to a wrong one. */
class UnsignedApkError extends Error {}

/** Certificate SHA-256 digests from `apksigner verify --print-certs` output. */
function certDigests(stdout) {
  const out = new Set();
  for (const m of String(stdout || '').matchAll(/certificate SHA-256 digest:\s*([0-9a-fA-F:]{64,95})/g)) {
    const digest = m[1].replace(/:/g, '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(digest)) out.add(digest);
  }
  return [...out];
}

/** The fingerprints listed for an app, lower-cased. */
function knownDigests(signers, appId) {
  const entry = signers && Object.prototype.hasOwnProperty.call(signers, appId) ? signers[appId] : null;
  return Array.isArray(entry && entry.sha256) ? entry.sha256.map((s) => String(s).toLowerCase()) : [];
}

/** { ok, known, got, skipped } for the digests apksigner found. */
function judge(signers, appId, digests) {
  const known = knownDigests(signers, appId);
  if (!known.length) return { ok: true, known, got: digests, skipped: true };
  return { ok: digests.some((d) => known.includes(d)), known, got: digests, skipped: false };
}

/** Which entry of a bundle holds the base APK, from its entry names. */
function baseEntry(names) {
  const apks = names.filter((n) => /\.apk$/i.test(n) && !n.includes('/'));
  return apks.find((n) => /^base\.apk$/i.test(n))
    || apks.find((n) => !/split|config\./i.test(n))
    || null;
}

/** The fingerprint list. A missing or broken file throws: it must never turn the check off. */
function readSigners(file = SIGNERS_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Throws when the APK at `file` isn't signed by a listed signer for `appId`.
 *
 * @param {string} file
 * @param {string} appId
 * @param {object} [opts]
 * @param {object} [opts.signers] parsed apk-signers.json
 * @param {string} [opts.apksigner] apksigner binary (on PATH after install_aapt.sh)
 * @param {Function} [opts.run] execFileSync stand-in, for tests
 * @param {Function} [opts.log]
 */
function checkSigner(file, appId, { signers = readSigners(), apksigner = 'apksigner', run = execFileSync, log = console.log } = {}) {
  const known = knownDigests(signers, appId);
  if (!known.length) {
    log(`::notice::No signer listed for ${appId} in .github/scripts/apk-signers.json; signature not checked.`);
    return { skipped: true };
  }
  const names = run('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: LIST_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map((n) => n.trim()).filter(Boolean);
  const isBundle = !names.includes('AndroidManifest.xml');
  let target = file;
  let tmp = null;
  let out;
  try {
    if (isBundle) {
      const base = baseEntry(names);
      if (!base) throw new Error(`no base APK inside ${path.basename(file)} to check the signature of`);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-'));
      target = path.join(tmp, 'base.apk');
      fs.writeFileSync(target, run('unzip', ['-p', file, base], { maxBuffer: APK_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }));
    }
    try {
      out = run(apksigner, ['verify', '--print-certs', target], {
        encoding: 'utf8', maxBuffer: LIST_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      // A missing apksigner is a broken runner, not an unsigned APK.
      if (e && e.code === 'ENOENT') throw new Error(`${apksigner} not found; is Android build-tools on PATH?`, { cause: e });
      const why = String((e && (e.stderr || e.message)) || '').split('\n').find(Boolean) || 'unknown error';
      throw new UnsignedApkError(`apksigner could not verify ${path.basename(file)}${isBundle ? ' (base.apk)' : ''}: ${why}`, { cause: e });
    }
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
  const verdict = judge(signers, appId, certDigests(out));
  if (!verdict.ok) {
    throw new Error(`${path.basename(file)} is signed by ${verdict.got.join(', ') || 'nothing apksigner recognised'}, `
      + `not by ${appId}'s developer (${verdict.known.join(', ')} in .github/scripts/apk-signers.json). `
      + 'The source may be serving a modified APK. If the developer really changed their key, add the new '
      + 'fingerprint from APKMirror to .github/scripts/apk-signers.json.');
  }
  log(`Signer of ${path.basename(file)} matches apk-signers.json (${verdict.got.find((d) => verdict.known.includes(d))}).`);
  return verdict;
}

module.exports = { certDigests, judge, baseEntry, readSigners, checkSigner, UnsignedApkError, SIGNERS_FILE };
