'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  certDigests, judge, baseEntry, bundleApks, readSigners, checkSigner, UnsignedApkError, SIGNERS_FILE,
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

