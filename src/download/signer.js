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
 * The digests come from apksig's verification result (SignerDigests.java,
 * run against apksigner.jar from build-tools): the SHA-256 of each verified
 * certificate's DER bytes. apksigner's text output isn't parsed, because it
 * also prints the certificate subject, which whoever signed the APK chooses
 * and which can hold a line break.
 *
 * In a bundle (.apkm/.xapk/.apks, or a bundle saved as .apk) every APK
 * is checked, base and splits, before APKEditor merges them (the merged
 * APK is unsigned): the merge takes all of them, so a genuine base with a
 * swapped split must fail too. A wrong signer fails. So does an APK that
 * doesn't verify, because an unsigned or broken original can't be trusted
 * either.
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
const HELPER = path.join(__dirname, 'SignerDigests.java');
const LIST_BUFFER = 64 * 1024 * 1024;
const APK_BUFFER = 2 * 1024 * 1024 * 1024;

/** The APK doesn't verify (e.g. our own APKEditor merge), as opposed to a wrong signer. */
class UnsignedApkError extends Error {}

/**
 * Parses SignerDigests.java's output for `count` APKs into
 * [{ sha256: [...], subject, error }]. The format is ours and nothing in it
 * comes from an APK unencoded, so any other line means the helper broke.
 */
function parseSignerOutput(stdout, count) {
  const out = [];
  let cur = null;
  const decode = (b64) => Buffer.from(b64, 'base64').toString('utf8');
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line) continue;
    let m;
    if ((m = /^apk (\d+)$/.exec(line)) && Number(m[1]) === out.length) {
      cur = { sha256: [], subject: '', error: null };
      out.push(cur);
    } else if (cur && (m = /^sha256 ([0-9a-f]{64})$/.exec(line))) {
      if (!cur.sha256.includes(m[1])) cur.sha256.push(m[1]);
    } else if (cur && (m = /^subject ([A-Za-z0-9+/]*={0,2})$/.exec(line))) {
      cur.subject = decode(m[1]);
    } else if (cur && (m = /^error ([A-Za-z0-9+/]*={0,2})$/.exec(line))) {
      cur.error = decode(m[1]) || 'unknown error';
    } else {
      throw new Error(`unexpected output from SignerDigests: ${JSON.stringify(line.slice(0, 80))}`);
    }
  }
  if (out.length !== count) throw new Error(`SignerDigests reported ${out.length} of ${count} APKs`);
  return out;
}

/** apksigner.jar of the installed build-tools (install_aapt.sh puts their folder on PATH). */
function findApksignerJar(env = process.env) {
  const dirs = [];
  if (env.ANDROID_HOME && env.ANDROID_BUILD_TOOLS_VERSION) {
    dirs.push(path.join(env.ANDROID_HOME, 'build-tools', env.ANDROID_BUILD_TOOLS_VERSION));
  }
  dirs.push(...String(env.PATH || '').split(path.delimiter).filter(Boolean));
  for (const dir of dirs) {
    const jar = path.join(dir, 'lib', 'apksigner.jar');
    if (fs.existsSync(jar)) return jar;
  }
  return null;
}

/** The fingerprints listed for an app, lower-cased. */
function knownDigests(signers, appId) {
  const entry = signers && Object.prototype.hasOwnProperty.call(signers, appId) ? signers[appId] : null;
  return Array.isArray(entry && entry.sha256) ? entry.sha256.map((s) => String(s).toLowerCase()) : [];
}

/** { ok, known, got, skipped } for the digests found. */
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
 * @param {string} [opts.apksignerJar] apksigner.jar (found next to apksigner on PATH after install_aapt.sh)
 * @param {string} [opts.java] java binary
 * @param {Function} [opts.run] execFileSync stand-in, for tests
 * @param {Function} [opts.log]
 * @param {string} [opts.version] version being built, for the suggested entry's "seen"
 * @param {string} [opts.summary] file the suggested entry is appended to ($GITHUB_STEP_SUMMARY)
 */
function checkSigner(file, appId, {
  signers = readSigners(), apksignerJar, java = 'java', run = execFileSync, log = console.log,
  version = '', summary = process.env.GITHUB_STEP_SUMMARY || '',
} = {}) {
  const tool = { apksignerJar, java, run };
  const known = knownDigests(signers, appId);
  if (!known.length) return reportUnlisted(file, appId, { tool, log, version, summary });
  const names = listEntries(file, run);
  const isBundle = !names.includes('AndroidManifest.xml');
  if (!isBundle) {
    const [certs] = readCerts([file], tool);
    const verdict = expectSigner(signers, appId, path.basename(file), certs);
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
    const targets = entries.map((entry, i) => {
      const target = path.join(tmp, `${i}.apk`);
      fs.writeFileSync(target, run('unzip', ['-p', file, entry], { maxBuffer: APK_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }));
      return target;
    });
    readCerts(targets, tool).forEach((certs, i) => {
      verdict = expectSigner(signers, appId, `${path.basename(file)} (${entries[i]})`, certs);
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
function reportUnlisted(file, appId, { tool, log, version, summary }) {
  const notice = `::notice::No signer listed for ${appId} in .github/scripts/apk-signers.json; signature not checked.`;
  let entry;
  try {
    entry = unlistedEntry(file, tool, version);
  } catch (e) {
    log(`${notice} Its signer couldn't be read either: ${commandData(String((e && e.message) || e).split('\n')[0])}`);
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
function unlistedEntry(file, tool, version) {
  const names = listEntries(file, tool.run);
  let certs;
  if (names.includes('AndroidManifest.xml')) {
    certs = expectVerified(readCerts([file], tool)[0], path.basename(file));
  } else {
    const base = baseEntry(names);
    if (!base) throw new Error(`no base APK inside ${path.basename(file)}`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-'));
    try {
      const target = path.join(tmp, 'base.apk');
      fs.writeFileSync(target, tool.run('unzip', ['-p', file, base], { maxBuffer: APK_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] }));
      certs = expectVerified(readCerts([target], tool)[0], `${path.basename(file)} (${base})`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (!certs.sha256.length) throw new Error('apksig reported no signer certificate');
  const entry = { sha256: certs.sha256 };
  if (certs.subject) entry.subject = certs.subject;
  if (version) entry.seen = String(version);
  return entry;
}

/** Every APK inside a bundle, at any depth: APKEditor merges whatever it finds. */
function bundleApks(names) {
  return names.filter((n) => /\.apk$/i.test(n) && !n.endsWith('/'));
}

/** SignerDigests.java's result for each of `targets`, in one JVM. */
function readCerts(targets, { apksignerJar, java, run }) {
  const jar = apksignerJar || findApksignerJar();
  if (!jar) throw new Error('apksigner.jar not found; is Android build-tools on PATH?');
  let out;
  try {
    out = run(java, ['-cp', jar, HELPER, ...targets], {
      encoding: 'utf8', maxBuffer: LIST_BUFFER, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // The helper reports an APK that doesn't verify in its output, so a
    // failed run is a broken runner, never an unsigned APK.
    if (e && e.code === 'ENOENT') throw new Error(`${java} not found; is Java on PATH?`, { cause: e });
    const why = String((e && (e.stderr || e.message)) || '').split('\n').find(Boolean) || 'unknown error';
    throw new Error(`SignerDigests failed: ${why}`, { cause: e });
  }
  return parseSignerOutput(out, targets.length);
}

/** The certs of an APK that verified, or the "unsigned" error. */
function expectVerified(certs, label) {
  if (certs.error) {
    throw new UnsignedApkError(`apksig could not verify ${label}: ${certs.error.split('\n').find(Boolean) || 'unknown error'}`);
  }
  return certs;
}

/** The verdict for one APK, or the "wrong signer" / "unsigned" error. */
function expectSigner(signers, appId, label, certs) {
  const verdict = judge(signers, appId, expectVerified(certs, label).sha256);
  if (!verdict.ok) {
    throw new Error(`${label} is signed by ${verdict.got.join(', ') || 'no certificate apksig recognised'}, `
      + `not by ${appId}'s developer (${verdict.known.join(', ')} in .github/scripts/apk-signers.json). `
      + 'The source may be serving a modified APK. If the developer really changed their key, add the new '
      + 'fingerprint from APKMirror to .github/scripts/apk-signers.json.');
  }
  return { ...verdict, matched: verdict.got.find((d) => verdict.known.includes(d)) };
}

module.exports = {
  parseSignerOutput, findApksignerJar, judge, baseEntry, bundleApks, readSigners, checkSigner,
  UnsignedApkError, SIGNERS_FILE, HELPER,
};
