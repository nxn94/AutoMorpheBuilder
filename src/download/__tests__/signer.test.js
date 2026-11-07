'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  certDigests, judge, baseEntry, readSigners, checkSigner, UnsignedApkError, SIGNERS_FILE,
} = require('../signer');

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
    if (cmd === 'unzip' && args[0] === '-p') return Buffer.from('base apk bytes');
    if (cmd === 'apksigner') return verify(args[args.length - 1]);
    throw new Error(`unexpected command ${cmd}`);
  };
  return { run, calls };
}

describe('certDigests', () => {
  test('reads plain and colon-separated digests, once each', () => {
    const out = `${printCerts(GOOD)}${printCerts(GOOD)}Signer #2 certificate SHA-256 digest: ${OTHER.match(/../g).join(':')}\n`;
    expect(certDigests(out)).toEqual([GOOD, OTHER]);
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

  test('skips an unlisted app without running anything', () => {
    const { run, calls } = fakeRun();
    const messages = [];
    expect(checkSigner('x.apk', 'com.unlisted', { signers: SIGNERS, run, log: (m) => messages.push(m) })).toEqual({ skipped: true });
    expect(calls).toEqual([]);
    expect(messages[0]).toMatch(/^::notice::No signer listed for com\.unlisted/);
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

  test('checks a bundle on its base.apk and removes the temporary copy', () => {
    let checked;
    const { run, calls } = fakeRun({
      entries: ['manifest.json', 'base.apk', 'split_config.arm64_v8a.apk'],
      verify: (file) => { checked = file; expect(fs.readFileSync(file, 'utf8')).toBe('base apk bytes'); return printCerts(GOOD); },
    });
    expect(checkSigner('app.apkm', 'com.example', { signers: SIGNERS, run, log }).ok).toBe(true);
    expect(calls[1]).toEqual(['unzip', '-p', 'app.apkm', 'base.apk']);
    expect(path.basename(checked)).toBe('base.apk');
    expect(fs.existsSync(path.dirname(checked))).toBe(false);
  });

  test('a bundle with no base APK fails', () => {
    const { run } = fakeRun({ entries: ['manifest.json', 'split_config.en.apk'] });
    expect(() => checkSigner('app.apks', 'com.example', { signers: SIGNERS, run, log })).toThrow(/no base APK inside app\.apks/);
  });

  test('uses the shipped list and console.log by default', () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(checkSigner('x.apk', 'com.unlisted')).toEqual({ skipped: true });
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

