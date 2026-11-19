'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  certDigests, certSubject, judge, baseEntry, bundleApks, readSigners, checkSigner, UnsignedApkError, SIGNERS_FILE,
} = require('../signer');
const { execFileSync } = require('node:child_process');

const GOOD = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const SIGNERS = { 'com.example': { sha256: [GOOD.toUpperCase()] } };
const printCerts = (digest) => `Signer #1 certificate DN: CN=Example\nSigner #1 certificate SHA-256 digest: ${digest}\n`;

/** A stand-in for execFileSync that answers unzip and apksigner. */
function fakeRun({ entries = ['AndroidManifest.xml', 'classes.dex'], verify = () => printCerts(GOOD) } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'unzip' && args[0] === '-Z1') return `${entries.join('\n')}\n`;
    if (cmd === 'unzip' && args[0] === '-p') return Buffer.from(`bytes of ${args[2]}`);
    if (cmd === 'apksigner') return verify(args[args.length - 1]);
    throw new Error(`unexpected command ${cmd}`);
  };
  return { run, calls };
}

describe('certDigests', () => {
  test('reads one digest per signer, each once', () => {
    const out = `${printCerts(GOOD)}Signer #2 certificate SHA-256 digest: ${OTHER}\r\n`
      + `Signer (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${GOOD}\n`;
    expect(certDigests(out)).toEqual([GOOD, OTHER]);
  });

  test('takes no digest from a subject or any other field', () => {
    const inDn = `Signer #1 certificate DN: CN=x certificate SHA-256 digest: ${GOOD}\n`
      + `Signer #1 certificate SHA-256 digest: ${OTHER}\n`;
    expect(certDigests(inDn)).toEqual([OTHER]);
    expect(certDigests(`Signer #1 certificate SHA-1 digest: ${GOOD}\nSigner #1 public key SHA-256 digest: ${GOOD}\n`)).toEqual([]);
    expect(certDigests(`WARNING: Signer #1 certificate SHA-256 digest: ${GOOD}\n`)).toEqual([]);
    expect(certDigests(`Signer #1 certificate SHA-256 digest: ${GOOD} trailing\n`)).toEqual([]);
    expect(certDigests(`Signer #1 certificate SHA-256 digest: ${GOOD.toUpperCase()}\n`)).toEqual([]);
    expect(certDigests(`Signer #1 certificate SHA-256 digest: ${GOOD.match(/../g).join(':')}\n`)).toEqual([]);
  });

  test('trusts nothing when a subject\'s line break forges a digest line', () => {
    const forged = `Signer #1 certificate DN: CN=x\nSigner #1 certificate SHA-256 digest: ${GOOD}\n`
      + `Signer #1 certificate SHA-256 digest: ${OTHER}\n`;
    expect(certDigests(forged)).toEqual([]);
  });

  test('ignores the store\'s source-stamp certificate', () => {
    const stamp = `Source Stamp Signer certificate DN: CN=Play\nSource Stamp Signer certificate SHA-256 digest: ${OTHER}\n`;
    expect(certDigests(`${printCerts(GOOD)}${stamp}`)).toEqual([GOOD]);
    expect(certSubject(`${stamp}${printCerts(GOOD)}`)).toBe('CN=Example');
  });

  test('ignores anything that is not a full SHA-256', () => {
    expect(certDigests('Signer #1 certificate SHA-256 digest: abc123')).toEqual([]);
    expect(certDigests(`Signer #1 certificate SHA-256 digest: ${'ab:'.repeat(21)}a`)).toEqual([]);
    expect(certDigests('')).toEqual([]);
    expect(certDigests(undefined)).toEqual([]);
  });
});

describe('judge', () => {
  test('a listed fingerprint passes, ignoring case', () => {
    expect(judge(SIGNERS, 'com.example', [GOOD])).toMatchObject({ ok: true, skipped: false });
  });

  test('a different fingerprint, or none, fails', () => {
    expect(judge(SIGNERS, 'com.example', [OTHER]).ok).toBe(false);
    expect(judge(SIGNERS, 'com.example', []).ok).toBe(false);
  });

  test('an app that is not listed is skipped', () => {
    expect(judge(SIGNERS, 'com.unlisted', [OTHER])).toMatchObject({ ok: true, skipped: true });
    expect(judge(SIGNERS, 'constructor', [OTHER])).toMatchObject({ skipped: true });
    expect(judge({ 'com.example': {} }, 'com.example', [OTHER])).toMatchObject({ skipped: true });
  });
});

describe('baseEntry', () => {
  test('prefers base.apk, then a top-level APK that is not a split', () => {
    expect(baseEntry(['split_config.arm64_v8a.apk', 'base.apk', 'icon.png'])).toBe('base.apk');
    expect(baseEntry(['config.en.apk', 'com.example.apk', 'manifest.json'])).toBe('com.example.apk');
  });

  test('ignores nested APKs and returns null when there is no base', () => {
    expect(baseEntry(['assets/base.apk', 'split_config.en.apk'])).toBeNull();
  });
});

describe('bundleApks', () => {
  test('every APK at any depth, but no folders or other files', () => {
    expect(bundleApks(['base.apk', 'splits/', 'splits/split_config.en.apk', 'manifest.json', 'icon.png', 'Split.APK']))
      .toEqual(['base.apk', 'splits/split_config.en.apk', 'Split.APK']);
  });
});

describe('readSigners', () => {
  test('the shipped list parses and every fingerprint is a SHA-256', () => {
    const signers = readSigners();
    const apps = Object.keys(signers).filter((k) => !k.startsWith('_'));
    expect(apps.length).toBeGreaterThan(0);
    for (const app of apps) {
      expect(signers[app].sha256.length).toBeGreaterThan(0);
      for (const digest of signers[app].sha256) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(SIGNERS_FILE.endsWith(path.join('.github', 'scripts', 'apk-signers.json'))).toBe(true);
  });

  test('a broken list throws instead of turning the check off', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signers-'));
    const file = path.join(dir, 'apk-signers.json');
    fs.writeFileSync(file, '{ not json');
    try {
      expect(() => readSigners(file)).toThrow();
      expect(() => readSigners(path.join(dir, 'missing.json'))).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkSigner', () => {
  const log = () => {};

  describe('an unlisted app', () => {
    const SIGNED = `Signer #1 certificate DN: CN=Someone, O=Example\n${printCerts(OTHER)}`;
    const tmpSummary = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'summary-')), 'summary.md');

    test('is not checked, but its signer is printed as a ready entry', () => {
      const { run, calls } = fakeRun({ verify: () => SIGNED });
      const messages = [];
      const summary = tmpSummary();
      const result = checkSigner('x.apk', 'com.unlisted', {
        signers: SIGNERS, run, log: (m) => messages.push(m), version: '1.2.3', summary,
      });
      const entry = { sha256: [OTHER], subject: 'CN=Someone, O=Example', seen: '1.2.3' };
      expect(result).toEqual({ skipped: true, entry });
      expect(calls).toEqual([['unzip', '-Z1', 'x.apk'], ['apksigner', 'verify', '--print-certs', 'x.apk']]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/^::notice::No signer listed for com\.unlisted in .*; signature not checked\. This APK is signed by b{64}\./);
      expect(messages[0]).toContain(`"com.unlisted": ${JSON.stringify(entry)}`);
      const md = fs.readFileSync(summary, 'utf8');
      expect(md).toContain('### No signer listed for com.unlisted');
      const pasted = md.match(/```json\n([\s\S]*?)\n```/)[1];
      expect(JSON.parse(`{${pasted.replace(/,$/, '')}}`)).toEqual({ 'com.unlisted': entry });
    });

    test('in a bundle, only the base APK is read, and the copy is removed', () => {
      const { run, calls } = fakeRun({ entries: ['base.apk', 'split_config.arm64_v8a.apk'], verify: () => printCerts(OTHER) });
      const result = checkSigner('app.apkm', 'com.unlisted', { signers: SIGNERS, run, log, summary: '' });
      expect(result).toEqual({ skipped: true, entry: { sha256: [OTHER], subject: 'CN=Example' } });
      expect(calls.filter(([cmd]) => cmd === 'apksigner')).toHaveLength(1);
      expect(calls).toContainEqual(['unzip', '-p', 'app.apkm', 'base.apk']);
      const copy = calls.find(([cmd]) => cmd === 'apksigner')[3];
      expect(fs.existsSync(path.dirname(copy))).toBe(false);
    });

    test.each([
      ['an unsigned APK', { verify: () => { throw new Error('DOES NOT VERIFY'); } }, /apksigner could not verify x\.apk: DOES NOT VERIFY/],
      ['no certificate in the output', { verify: () => 'Verifies\n' }, /apksigner printed no certificate digest/],
      ['a bundle with no base APK', { entries: ['split_config.en.apk'] }, /no base APK inside x\.apk/],
    ])('still builds when its signer can\'t be read (%s)', (_, opts, why) => {
      const { run } = fakeRun(opts);
      const messages = [];
      const summary = tmpSummary();
      expect(checkSigner('x.apk', 'com.unlisted', { signers: SIGNERS, run, log: (m) => messages.push(m), summary }))
        .toEqual({ skipped: true, entry: null });
      expect(messages[0]).toMatch(/^::notice::No signer listed for com\.unlisted/);
      expect(messages[0]).toMatch(why);
      expect(fs.existsSync(summary)).toBe(false);
    });

    test('a subject from the APK can\'t close the fence or start a workflow command', () => {
      const subject = 'CN=x```` %0A::error::pwned';
      const { run } = fakeRun({ verify: () => `Signer #1 certificate DN: ${subject}\n${printCerts(OTHER)}` });
      const messages = [];
      const summary = tmpSummary();
      checkSigner('x.apk', 'com.unlisted', { signers: SIGNERS, run, log: (m) => messages.push(m), summary });
      expect(messages[0]).toContain('CN=x```` %250A::error::pwned');
      const md = fs.readFileSync(summary, 'utf8');
      const pasted = md.match(/^`````json\n([^\n]*)\n`````$/m)[1];
      expect(JSON.parse(`{${pasted.replace(/,$/, '')}}`)['com.unlisted'].subject).toBe(subject);
    });

    test('a summary that can\'t be written is a warning, not a failure', () => {
      const { run } = fakeRun({ verify: () => printCerts(OTHER) });
      const messages = [];
      const summary = path.join(os.tmpdir(), 'no-such-dir-for-signer-test', 'summary.md');
      expect(checkSigner('x.apk', 'com.unlisted', { signers: SIGNERS, run, log: (m) => messages.push(m), summary }).entry)
        .toEqual({ sha256: [OTHER], subject: 'CN=Example' });
      expect(messages[1]).toMatch(/^::warning::could not write \$GITHUB_STEP_SUMMARY/);
    });
  });

  test('passes an APK signed by the listed key', () => {
    const { run, calls } = fakeRun();
    expect(checkSigner('/apks/app.apk', 'com.example', { signers: SIGNERS, run, log }).ok).toBe(true);
    expect(calls[1]).toEqual(['apksigner', 'verify', '--print-certs', '/apks/app.apk']);
  });

  test('fails an APK signed by another key, and it is not treated as unsigned', () => {
    const { run } = fakeRun({ verify: () => printCerts(OTHER) });
    let error;
    try { checkSigner('app.apk', 'com.example', { signers: SIGNERS, run, log }); } catch (e) { error = e; }
    expect(error.message).toMatch(/is signed by b{64}, not by com\.example's developer/);
    expect(error).not.toBeInstanceOf(UnsignedApkError);
  });

  test('an APK apksigner cannot verify is reported as unsigned', () => {
    const { run } = fakeRun({ verify: () => { throw Object.assign(new Error('exit 1'), { stderr: 'DOES NOT VERIFY\nmore' }); } });
    let error;
    try { checkSigner('app.apk', 'com.example', { signers: SIGNERS, run, log }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(UnsignedApkError);
    expect(error.message).toBe('apksigner could not verify app.apk: DOES NOT VERIFY');
  });

  test('a missing apksigner is a plain error, not an unsigned APK', () => {
    const { run } = fakeRun({ verify: () => { throw Object.assign(new Error('spawn apksigner ENOENT'), { code: 'ENOENT' }); } });
    let error;
    try { checkSigner('app.apk', 'com.example', { signers: SIGNERS, run, log }); } catch (e) { error = e; }
    expect(error.message).toMatch(/apksigner not found/);
    expect(error).not.toBeInstanceOf(UnsignedApkError);
  });

  test('checks every APK in a bundle and removes the temporary copies', () => {
    const checked = [];
    const { run, calls } = fakeRun({
      entries: ['manifest.json', 'base.apk', 'split_config.arm64_v8a.apk', 'splits/split_config.en.apk'],
      verify: (file) => { checked.push([file, fs.readFileSync(file, 'utf8')]); return printCerts(GOOD); },
    });
    expect(checkSigner('app.apkm', 'com.example', { signers: SIGNERS, run, log }).ok).toBe(true);
    expect(calls.filter(([cmd, flag]) => cmd === 'unzip' && flag === '-p').map((c) => c[3]))
      .toEqual(['base.apk', 'split_config.arm64_v8a.apk', 'splits/split_config.en.apk']);
    expect(checked.map(([, bytes]) => bytes))
      .toEqual(['bytes of base.apk', 'bytes of split_config.arm64_v8a.apk', 'bytes of splits/split_config.en.apk']);
    expect(fs.existsSync(path.dirname(checked[0][0]))).toBe(false);
  });

  test('a genuine base with a split signed by someone else fails, naming the split', () => {
    const { run } = fakeRun({
      entries: ['base.apk', 'split_config.arm64_v8a.apk'],
      verify: (file) => printCerts(fs.readFileSync(file, 'utf8').includes('split_') ? OTHER : GOOD),
    });
    expect(() => checkSigner('app.apkm', 'com.example', { signers: SIGNERS, run, log }))
      .toThrow(/app\.apkm \(split_config\.arm64_v8a\.apk\) is signed by b{64}, not by com\.example's developer/);
  });

  test('a genuine base with an unsigned split fails as unsigned, naming the split', () => {
    const { run } = fakeRun({
      entries: ['base.apk', 'split_config.arm64_v8a.apk'],
      verify: (file) => {
        if (fs.readFileSync(file, 'utf8').includes('split_')) throw new Error('DOES NOT VERIFY');
        return printCerts(GOOD);
      },
    });
    let error;
    try { checkSigner('app.apkm', 'com.example', { signers: SIGNERS, run, log }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(UnsignedApkError);
    expect(error.message).toBe('apksigner could not verify app.apkm (split_config.arm64_v8a.apk): DOES NOT VERIFY');
  });

  // A real zip, saved with an .apk name as the downloader does: only
  // apksigner is faked, and it trusts the base's bytes but not the split's.
  const zipOk = (() => { try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  (zipOk ? test : test.skip)('a real bundle saved as .apk with a swapped split fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-zip-'));
    try {
      fs.writeFileSync(path.join(dir, 'base.apk'), 'genuine');
      fs.writeFileSync(path.join(dir, 'split_config.arm64_v8a.apk'), 'tampered');
      const bundle = path.join(dir, 'app.apk');
      execFileSync('zip', ['-q', '-j', bundle, path.join(dir, 'base.apk'), path.join(dir, 'split_config.arm64_v8a.apk')]);
      const verified = [];
      const run = (cmd, args, opts) => {
        if (cmd !== 'apksigner') return execFileSync(cmd, args, opts);
        const bytes = fs.readFileSync(args[args.length - 1], 'utf8');
        verified.push(bytes);
        return printCerts(bytes === 'genuine' ? GOOD : OTHER);
      };
      expect(() => checkSigner(bundle, 'com.example', { signers: SIGNERS, run, log }))
        .toThrow(/app\.apk \(split_config\.arm64_v8a\.apk\) is signed by b{64}/);
      expect(verified).toEqual(['genuine', 'tampered']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bundle with no base APK fails', () => {
    const { run } = fakeRun({ entries: ['manifest.json', 'split_config.en.apk'] });
    expect(() => checkSigner('app.apks', 'com.example', { signers: SIGNERS, run, log })).toThrow(/no base APK inside app\.apks/);
  });

  test('uses the shipped list and console.log by default', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // x.apk doesn't exist, so its signer can't be read and no summary is written.
      expect(checkSigner('x.apk', 'com.unlisted')).toEqual({ skipped: true, entry: null });
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^::notice::No signer listed for com\.unlisted/));
    } finally {
      spy.mockRestore();
    }
  });

  test('says when apksigner printed no certificate at all', () => {
    const { run } = fakeRun({ verify: () => 'Verifies\n' });
    expect(() => checkSigner('app.apk', 'com.example', { signers: SIGNERS, run, log }))
      .toThrow(/is signed by nothing apksigner recognised/);
  });

  test.each([
    ['only a message', () => new Error('exit 1\nmore'), 'exit 1'],
    ['nothing to say', () => new Error(''), 'unknown error'],
  ])('an unverifiable APK with %s is still reported', (_, make, why) => {
    const { run } = fakeRun({ verify: () => { throw make(); } });
    expect(() => checkSigner('app.apk', 'com.example', { signers: SIGNERS, run, log }))
      .toThrow(`apksigner could not verify app.apk: ${why}`);
  });

  test('an unverifiable bundle names its base.apk', () => {
    const { run } = fakeRun({ entries: ['base.apk'], verify: () => { throw new Error('DOES NOT VERIFY'); } });
    expect(() => checkSigner('app.apkm', 'com.example', { signers: SIGNERS, run, log }))
      .toThrow('apksigner could not verify app.apkm (base.apk): DOES NOT VERIFY');
  });
});

