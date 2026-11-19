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
 * In a bundle (.apkm/.xapk/.apks, or a bundle saved as .apk) every APK
 * is checked, base and splits, before APKEditor merges them (the merged
 * APK is unsigned): the merge takes all of them, so a genuine base with a
 * swapped split must fail too. A wrong signer fails. So does an APK that
 * apksigner can't verify, because an unsigned or broken original can't be
 * trusted either.
 *
 * Apps not in the list aren't checked. Their base APK's signer is still
 * read and printed with an apk-signers.json entry ready to paste, so
 * adding an app is a copy once the digest has been compared with
 * APKMirror's. Nothing is added automatically: the download comes from the
 * same sources the check exists to distrust.
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

/**
 * Certificate SHA-256 digests from `apksigner verify --print-certs` output.
 * A "Source Stamp Signer" line is the store's stamp key (shared by every
 * app it distributes), not the developer's, so it never counts.
 */
function certDigests(stdout) {
  const out = new Set();
  for (const m of String(stdout || '').matchAll(/^(?!Source Stamp)[^\r\n]*certificate SHA-256 digest:[ \t]*([0-9a-fA-F:]{64,95})/gm)) {
    const digest = m[1].replace(/:/g, '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(digest)) out.add(digest);
  }
  return [...out];
}

/** The first signer's certificate DN from `apksigner verify --print-certs` output, or ''. */
function certSubject(stdout) {
  const m = String(stdout || '').match(/^(?!Source Stamp)[^\r\n]*certificate DN:[ \t]*([^\r\n]+)/m);
  return m ? m[1].trim() : '';
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
 * For an app with no listed signer, reports the APK's signer instead and
 * returns { skipped: true, entry }, entry being null when it couldn't be read.
 *
 * @param {string} file
 * @param {string} appId
 * @param {object} [opts]
 * @param {object} [opts.signers] parsed apk-signers.json
 * @param {string} [opts.apksigner] apksigner binary (on PATH after install_aapt.sh)
 * @param {Function} [opts.run] execFileSync stand-in, for tests
 * @param {Function} [opts.log]
 * @param {string} [opts.version] version being built, for the suggested entry's "seen"
 * @param {string} [opts.summary] file the suggested entry is appended to ($GITHUB_STEP_SUMMARY)
 */
function checkSigner(file, appId, {
  signers = readSigners(), apksigner = 'apksigner', run = execFileSync, log = console.log,
  version = '', summary = process.env.GITHUB_STEP_SUMMARY || '',
} = {}) {
  const known = knownDigests(signers, appId);
  if (!known.length) return reportUnlisted(file, appId, { apksigner, run, log, version, summary });
  const names = listEntries(file, run);
  const isBundle = !names.includes('AndroidManifest.xml');
  if (!isBundle) {
    const verdict = expectSigner(signers, appId, path.basename(file), verifyCerts(file, path.basename(file), apksigner, run));
    log(`Signer of ${path.basename(file)} matches apk-signers.json (${verdict.matched}).`);
    return verdict;
  }
  if (!baseEntry(names)) throw new Error(`no base APK inside ${path.basename(file)} to check the signature of`);
  // APKEditor merges every APK in the bundle, so every one of them must be
  // the developer's: a genuine base with a swapped split must not pass.
  const entries = bundleApks(names);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-'));
  let verdict;
  try {
    entries.forEach((entry, i) => {
      const label = `${path.basename(file)} (${entry})`;
      const target = path.join(tmp, `${i}.apk`);
      fs.writeFileSync(target, run('unzip', ['-p', file, entry], { maxBuffer: APK_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }));
      verdict = expectSigner(signers, appId, label, verifyCerts(target, label, apksigner, run));
      fs.rmSync(target, { force: true });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  log(`Signers of all ${entries.length} APKs in ${path.basename(file)} match apk-signers.json (${verdict.matched}).`);
  return verdict;
}

/** Entry names of a zip (an APK or a bundle). */
function listEntries(file, run) {
  return run('unzip', ['-Z1', file], { encoding: 'utf8', maxBuffer: LIST_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] })
    .split('\n').map((n) => n.trim()).filter(Boolean);
}

/**
 * An unlisted app isn't checked, but its signer is printed with an entry
 * ready for apk-signers.json. Never throws: unlisted apps built without
 * the check before this, and still do.
 */
function reportUnlisted(file, appId, { apksigner, run, log, version, summary }) {
  const notice = `::notice::No signer listed for ${appId} in .github/scripts/apk-signers.json; signature not checked.`;
  let entry;
  try {
    entry = unlistedEntry(file, apksigner, run, version);
  } catch (e) {
    log(`${notice} Its signer couldn't be read either: ${String((e && e.message) || e).split('\n')[0]}`);
    return { skipped: true, entry: null };
  }
  const line = `${JSON.stringify(appId)}: ${JSON.stringify(entry)}`;
  // The subject comes from the APK. Escape it as workflow-command data, so
  // the annotation shows what the log shows.
  log(`${notice} This APK is signed by ${entry.sha256.join(', ')}. If that matches APKMirror's `
    + `"APK certificate fingerprints" for the app, add it to apk-signers.json: ${commandData(line)}`);
  if (summary) {
    // A fence longer than any backtick run in the entry, which it can't close.
    const fence = '`'.repeat(Math.max(3, ...(line.match(/`+/g) || []).map((r) => r.length + 1)));
    const md = `### No signer listed for ${appId}\n\n`
      + 'Signature not checked. If the digest matches APKMirror\'s "APK certificate fingerprints" for the app, '
      + `add this to \`.github/scripts/apk-signers.json\`:\n\n${fence}json\n${line},\n${fence}\n\n`;
    try {
      fs.appendFileSync(summary, md);
    } catch (e) {
      log(`::warning::could not write $GITHUB_STEP_SUMMARY (${e.message})`);
    }
  }
  return { skipped: true, entry };
}

/** Text made safe as workflow-command data (the toolkit's escapeData). */
function commandData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** { sha256, subject?, seen? } for the base APK of `file`; throws when it can't be read. */
function unlistedEntry(file, apksigner, run, version) {
  const names = listEntries(file, run);
  let out;
  if (names.includes('AndroidManifest.xml')) {
    out = printCerts(file, path.basename(file), apksigner, run);
  } else {
    const base = baseEntry(names);
    if (!base) throw new Error(`no base APK inside ${path.basename(file)}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-'));
    try {
      const target = path.join(tmp, 'base.apk');
      fs.writeFileSync(target, run('unzip', ['-p', file, base], { maxBuffer: APK_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }));
      out = printCerts(target, `${path.basename(file)} (${base})`, apksigner, run);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  const sha256 = certDigests(out);
  if (!sha256.length) throw new Error('apksigner printed no certificate digest');
  const entry = { sha256 };
  const subject = certSubject(out);
  if (subject) entry.subject = subject;
  if (version) entry.seen = String(version);
  return entry;
}

/** Every APK inside a bundle, at any depth: APKEditor merges whatever it finds. */
function bundleApks(names) {
  return names.filter((n) => /\.apk$/i.test(n) && !n.endsWith('/'));
}

/** The certificate digests apksigner reports for one APK. */
function verifyCerts(target, label, apksigner, run) {
  return certDigests(printCerts(target, label, apksigner, run));
}

/** `apksigner verify --print-certs` output for one APK. */
function printCerts(target, label, apksigner, run) {
  try {
    return String(run(apksigner, ['verify', '--print-certs', target], {
      encoding: 'utf8', maxBuffer: LIST_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    }));
  } catch (e) {
    // A missing apksigner is a broken runner, not an unsigned APK.
    if (e && e.code === 'ENOENT') throw new Error(`${apksigner} not found; is Android build-tools on PATH?`, { cause: e });
    const why = String((e && (e.stderr || e.message)) || '').split('\n').find(Boolean) || 'unknown error';
    throw new UnsignedApkError(`apksigner could not verify ${label}: ${why}`, { cause: e });
  }
}

/** The verdict for one APK, or the "wrong signer" error. */
function expectSigner(signers, appId, label, digests) {
  const verdict = judge(signers, appId, digests);
  if (!verdict.ok) {
    throw new Error(`${label} is signed by ${verdict.got.join(', ') || 'nothing apksigner recognised'}, `
      + `not by ${appId}'s developer (${verdict.known.join(', ')} in .github/scripts/apk-signers.json). `
      + 'The source may be serving a modified APK. If the developer really changed their key, add the new '
      + 'fingerprint from APKMirror to .github/scripts/apk-signers.json.');
  }
  return { ...verdict, matched: verdict.got.find((d) => verdict.known.includes(d)) };
}

module.exports = {
  certDigests, certSubject, judge, baseEntry, bundleApks, readSigners, checkSigner, UnsignedApkError, SIGNERS_FILE,
};
