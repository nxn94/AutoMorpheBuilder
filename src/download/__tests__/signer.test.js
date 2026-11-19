'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseSignerOutput, findApksignerJar, judge, baseEntry, bundleApks, readSigners, checkSigner,
  UnsignedApkError, SIGNERS_FILE, HELPER,
} = require('../signer');
const { execFileSync } = require('node:child_process');

const GOOD = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const SIGNERS = { 'com.example': { sha256: [GOOD.toUpperCase()] } };
const JAR = '/sdk/build-tools/35.0.0/lib/apksigner.jar';
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

/** One APK's section of SignerDigests output. */
const certs = (digest, subject = 'CN=Example') => ({ sha256: [].concat(digest), subject });
const helperOut = (results) => results.map((r, i) => [
  `apk ${i}`,
  ...(r.error !== undefined ? [`error ${b64(r.error)}`] : [
    ...r.sha256.map((d) => `sha256 ${d}`),
    ...(r.subject ? [`subject ${b64(r.subject)}`] : []),
  ]),
].join('\n')).join('\n') + '\n';

/** A stand-in for execFileSync that answers unzip and the SignerDigests helper. */
function fakeRun({ entries = ['AndroidManifest.xml', 'classes.dex'], verify = () => certs(GOOD), java } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'unzip' && args[0] === '-Z1') return `${entries.join('\n')}\n`;
    if (cmd === 'unzip' && args[0] === '-p') return Buffer.from(`bytes of ${args[2]}`);
    if (cmd === 'java') return java ? java(args) : helperOut(args.slice(3).map(verify));
    throw new Error(`unexpected command ${cmd}`);
  };
  return { run, calls };
}
const opts = (extra) => ({ signers: SIGNERS, apksignerJar: JAR, log: () => {}, ...extra });

describe('parseSignerOutput', () => {
  test('reads each APK\'s digests, subject and error, in order', () => {
    const out = helperOut([{ sha256: [GOOD, OTHER, GOOD], subject: 'CN=A, O=B' }, { error: 'DOES NOT VERIFY: [x]' }]);
    expect(parseSignerOutput(out, 2)).toEqual([
      { sha256: [GOOD, OTHER], subject: 'CN=A, O=B', error: null },
      { sha256: [], subject: '', error: 'DOES NOT VERIFY: [x]' },
    ]);
    expect(parseSignerOutput(out.replace(/\n/g, '\r\n'), 2)).toHaveLength(2);
  });

  test('a subject with a line break stays data and can\'t add a digest', () => {
    const subject = `CN=x\nsha256 ${GOOD}\napk 1`;
    expect(parseSignerOutput(helperOut([certs(OTHER, subject)]), 1))
      .toEqual([{ sha256: [OTHER], subject, error: null }]);
  });

  test.each([
    ['an unknown line', `apk 0\nsha256 ${GOOD}\nSigner #1 certificate SHA-256 digest: ${GOOD}\n`],
    ['a digest before any APK', `sha256 ${GOOD}\napk 0\n`],
    ['an upper-case digest', `apk 0\nsha256 ${GOOD.toUpperCase()}\n`],
    ['a short digest', 'apk 0\nsha256 abc123\n'],
    ['a raw subject', 'apk 0\nsubject CN=x y\n'],
    ['APKs out of order', 'apk 1\n'],
    ['too few APKs', 'apk 0\n'],
    ['nothing', ''],
  ])('rejects %s', (_, out) => {
    expect(() => parseSignerOutput(out, out === 'apk 0\n' ? 2 : 1)).toThrow(/SignerDigests/);
  });
});

describe('findApksignerJar', () => {
  test('finds lib/apksigner.jar in a PATH folder, preferring ANDROID_HOME\'s build-tools', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-'));
    const make = (dir) => {
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lib', 'apksigner.jar'), '');
      return path.join(dir, 'lib', 'apksigner.jar');
    };
    try {
      const onPath = make(path.join(root, 'onpath'));
      const sdk = make(path.join(root, 'sdk', 'build-tools', '35.0.0'));
      const PATH = [path.join(root, 'empty'), path.join(root, 'onpath')].join(path.delimiter);
      expect(findApksignerJar({ PATH })).toBe(onPath);
      expect(findApksignerJar({ PATH, ANDROID_HOME: path.join(root, 'sdk'), ANDROID_BUILD_TOOLS_VERSION: '35.0.0' })).toBe(sdk);
      expect(findApksignerJar({ PATH: path.join(root, 'empty') })).toBeNull();
      expect(findApksignerJar({})).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
  const helperCall = (...apks) => ['java', '-cp', JAR, HELPER, ...apks];

  describe('an unlisted app', () => {
    const tmpSummary = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'summary-')), 'summary.md');

    test('is not checked, but its signer is printed as a ready entry', () => {
      const { run, calls } = fakeRun({ verify: () => certs(OTHER, 'CN=Someone, O=Example') });
      const messages = [];
      const summary = tmpSummary();
      const result = checkSigner('x.apk', 'com.unlisted', opts({ run, log: (m) => messages.push(m), version: '1.2.3', summary }));
      const entry = { sha256: [OTHER], subject: 'CN=Someone, O=Example', seen: '1.2.3' };
      expect(result).toEqual({ skipped: true, entry });
      expect(calls).toEqual([['unzip', '-Z1', 'x.apk'], helperCall('x.apk')]);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatch(/^::notice::No signer listed for com\.unlisted in .*; signature not checked\. This APK is signed by b{64}\./);
      expect(messages[0]).toContain(`"com.unlisted": ${JSON.stringify(entry)}`);
      const md = fs.readFileSync(summary, 'utf8');
      expect(md).toContain('### No signer listed for com.unlisted');
      const pasted = md.match(/```json\n([\s\S]*?)\n```/)[1];
      expect(JSON.parse(`{${pasted.replace(/,$/, '')}}`)).toEqual({ 'com.unlisted': entry });
    });

    test('in a bundle, only the base APK is read, and the copy is removed', () => {
      const { run, calls } = fakeRun({ entries: ['base.apk', 'split_config.arm64_v8a.apk'], verify: () => certs(OTHER) });
      const result = checkSigner('app.apkm', 'com.unlisted', opts({ run, summary: '' }));
      expect(result).toEqual({ skipped: true, entry: { sha256: [OTHER], subject: 'CN=Example' } });
      const java = calls.filter(([cmd]) => cmd === 'java');
      expect(java).toHaveLength(1);
      expect(java[0]).toHaveLength(5);
      expect(calls).toContainEqual(['unzip', '-p', 'app.apkm', 'base.apk']);
      expect(fs.existsSync(path.dirname(java[0][4]))).toBe(false);
    });

    test.each([
      ['an unsigned APK', { verify: () => ({ error: 'DOES NOT VERIFY: [x]\nmore' }) }, /apksig could not verify x\.apk: DOES NOT VERIFY: \[x\]$/],
      ['no certificate', { verify: () => ({ sha256: [] }) }, /apksig reported no signer certificate/],
      ['a bundle with no base APK', { entries: ['split_config.en.apk'] }, /no base APK inside x\.apk/],
      ['a broken helper', { java: () => 'garbage\n' }, /unexpected output from SignerDigests/],
    ])('still builds when its signer can\'t be read (%s)', (_, fake, why) => {
      const { run } = fakeRun(fake);
      const messages = [];
      const summary = tmpSummary();
      expect(checkSigner('x.apk', 'com.unlisted', opts({ run, log: (m) => messages.push(m), summary })))
        .toEqual({ skipped: true, entry: null });
      expect(messages[0]).toMatch(/^::notice::No signer listed for com\.unlisted/);
      expect(messages[0]).toMatch(why);
      expect(fs.existsSync(summary)).toBe(false);
    });

    test('a subject from the APK can\'t close the fence or start a workflow command', () => {
      const subject = 'CN=x```` %0A::error::pwned\nsha256 x';
      const { run } = fakeRun({ verify: () => certs(OTHER, subject) });
      const messages = [];
      const summary = tmpSummary();
      checkSigner('x.apk', 'com.unlisted', opts({ run, log: (m) => messages.push(m), summary }));
      expect(messages[0]).toContain('CN=x```` %250A::error::pwned\\nsha256 x');
      const md = fs.readFileSync(summary, 'utf8');
      const pasted = md.match(/^`````json\n([^\n]*)\n`````$/m)[1];
      expect(JSON.parse(`{${pasted.replace(/,$/, '')}}`)['com.unlisted'].subject).toBe(subject);
    });

    test('a summary that can\'t be written is a warning, not a failure', () => {
      const { run } = fakeRun({ verify: () => certs(OTHER) });
      const messages = [];
      const summary = path.join(os.tmpdir(), 'no-such-dir-for-signer-test', 'summary.md');
      expect(checkSigner('x.apk', 'com.unlisted', opts({ run, log: (m) => messages.push(m), summary })).entry)
        .toEqual({ sha256: [OTHER], subject: 'CN=Example' });
      expect(messages[1]).toMatch(/^::warning::could not write \$GITHUB_STEP_SUMMARY/);
    });
  });

  test('passes an APK signed by the listed key', () => {
    const { run, calls } = fakeRun();
    expect(checkSigner('/apks/app.apk', 'com.example', opts({ run })).ok).toBe(true);
    expect(calls[1]).toEqual(helperCall('/apks/app.apk'));
  });

  test('passes when one of several signers is listed', () => {
    const { run } = fakeRun({ verify: () => certs([OTHER, GOOD]) });
    expect(checkSigner('app.apk', 'com.example', opts({ run })).matched).toBe(GOOD);
  });

  test('fails an APK signed by another key, and it is not treated as unsigned', () => {
    const { run } = fakeRun({ verify: () => certs(OTHER) });
    let error;
    try { checkSigner('app.apk', 'com.example', opts({ run })); } catch (e) { error = e; }
    expect(error.message).toMatch(/is signed by b{64}, not by com\.example's developer/);
    expect(error).not.toBeInstanceOf(UnsignedApkError);
  });

  test('a genuine digest written into the subject doesn\'t count', () => {
    const subject = `CN=x\nSigner #2 certificate SHA-256 digest: ${GOOD}\nsha256 ${GOOD}`;
    const { run } = fakeRun({ verify: () => certs(OTHER, subject) });
    expect(() => checkSigner('app.apk', 'com.example', opts({ run }))).toThrow(/is signed by b{64}, not by/);
  });

  test('an APK apksig cannot verify is reported as unsigned', () => {
    const { run } = fakeRun({ verify: () => ({ error: '\nDOES NOT VERIFY\nmore' }) });
    let error;
    try { checkSigner('app.apk', 'com.example', opts({ run })); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(UnsignedApkError);
    expect(error.message).toBe('apksig could not verify app.apk: DOES NOT VERIFY');
  });

  test.each([
    ['java is missing', () => { throw Object.assign(new Error('spawn java ENOENT'), { code: 'ENOENT' }); }, /^java not found/],
    ['the helper fails', () => { throw Object.assign(new Error('exit 1'), { stderr: 'error: class not found\nmore' }); }, /^SignerDigests failed: error: class not found$/],
    ['the helper fails silently', () => { throw new Error(''); }, /^SignerDigests failed: unknown error$/],
    ['the helper prints something else', () => `Signer #1 certificate SHA-256 digest: ${GOOD}\n`, /^unexpected output from SignerDigests/],
    ['the helper skips an APK', () => '', /^SignerDigests reported 0 of 1 APKs$/],
  ])('a broken runner is a plain error, not an unsigned APK (%s)', (_, java, why) => {
    const { run } = fakeRun({ java });
    let error;
    try { checkSigner('app.apk', 'com.example', opts({ run })); } catch (e) { error = e; }
    expect(error.message).toMatch(why);
    expect(error).not.toBeInstanceOf(UnsignedApkError);
  });

  test('a missing apksigner.jar is a plain error', () => {
    const { run } = fakeRun();
    const env = process.env;
    try {
      process.env = { ...env, PATH: '' };
      delete process.env.ANDROID_HOME;
      expect(() => checkSigner('app.apk', 'com.example', opts({ run, apksignerJar: undefined })))
        .toThrow(/^apksigner\.jar not found; is Android build-tools on PATH\?$/);
    } finally {
      process.env = env;
    }
  });

  test('checks every APK in a bundle in one helper run and removes the temporary copies', () => {
    const checked = [];
    const { run, calls } = fakeRun({
      entries: ['manifest.json', 'base.apk', 'split_config.arm64_v8a.apk', 'splits/split_config.en.apk'],
      verify: (file) => { checked.push([file, fs.readFileSync(file, 'utf8')]); return certs(GOOD); },
    });
    expect(checkSigner('app.apkm', 'com.example', opts({ run })).ok).toBe(true);
    expect(calls.filter(([cmd, flag]) => cmd === 'unzip' && flag === '-p').map((c) => c[3]))
      .toEqual(['base.apk', 'split_config.arm64_v8a.apk', 'splits/split_config.en.apk']);
    expect(calls.filter(([cmd]) => cmd === 'java')).toHaveLength(1);
    expect(checked.map(([, bytes]) => bytes))
      .toEqual(['bytes of base.apk', 'bytes of split_config.arm64_v8a.apk', 'bytes of splits/split_config.en.apk']);
    expect(fs.existsSync(path.dirname(checked[0][0]))).toBe(false);
  });

  test('a genuine base with a split signed by someone else fails, naming the split', () => {
    const { run } = fakeRun({
      entries: ['base.apk', 'split_config.arm64_v8a.apk'],
      verify: (file) => certs(fs.readFileSync(file, 'utf8').includes('split_') ? OTHER : GOOD),
    });
    expect(() => checkSigner('app.apkm', 'com.example', opts({ run })))
      .toThrow(/app\.apkm \(split_config\.arm64_v8a\.apk\) is signed by b{64}, not by com\.example's developer/);
  });

  test('a genuine base with an unsigned split fails as unsigned, naming the split', () => {
    const { run } = fakeRun({
      entries: ['base.apk', 'split_config.arm64_v8a.apk'],
      verify: (file) => (fs.readFileSync(file, 'utf8').includes('split_') ? { error: 'DOES NOT VERIFY' } : certs(GOOD)),
    });
    let error;
    try { checkSigner('app.apkm', 'com.example', opts({ run })); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(UnsignedApkError);
    expect(error.message).toBe('apksig could not verify app.apkm (split_config.arm64_v8a.apk): DOES NOT VERIFY');
  });

  // A real zip, saved with an .apk name as the downloader does: only the
  // helper is faked, and it trusts the base's bytes but not the split's.
  const zipOk = (() => { try { execFileSync('zip', ['-v'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  (zipOk ? test : test.skip)('a real bundle saved as .apk with a swapped split fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-zip-'));
    try {
      fs.writeFileSync(path.join(dir, 'base.apk'), 'genuine');
      fs.writeFileSync(path.join(dir, 'split_config.arm64_v8a.apk'), 'tampered');
      const bundle = path.join(dir, 'app.apk');
      execFileSync('zip', ['-q', '-j', bundle, path.join(dir, 'base.apk'), path.join(dir, 'split_config.arm64_v8a.apk')]);
      const verified = [];
      const run = (cmd, args, o) => {
        if (cmd !== 'java') return execFileSync(cmd, args, o);
        return helperOut(args.slice(3).map((f) => {
          const bytes = fs.readFileSync(f, 'utf8');
          verified.push(bytes);
          return certs(bytes === 'genuine' ? GOOD : OTHER);
        }));
      };
      expect(() => checkSigner(bundle, 'com.example', opts({ run })))
        .toThrow(/app\.apk \(split_config\.arm64_v8a\.apk\) is signed by b{64}/);
      expect(verified).toEqual(['genuine', 'tampered']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a bundle with no base APK fails', () => {
    const { run } = fakeRun({ entries: ['manifest.json', 'split_config.en.apk'] });
    expect(() => checkSigner('app.apks', 'com.example', opts({ run }))).toThrow(/no base APK inside app\.apks/);
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

  test('says when apksig reported no certificate at all', () => {
    const { run } = fakeRun({ verify: () => ({ sha256: [] }) });
    expect(() => checkSigner('app.apk', 'com.example', opts({ run })))
      .toThrow(/is signed by no certificate apksig recognised/);
  });

  test('an unverifiable bundle names its base.apk', () => {
    const { run } = fakeRun({ entries: ['base.apk'], verify: () => ({ error: 'DOES NOT VERIFY' }) });
    expect(() => checkSigner('app.apkm', 'com.example', opts({ run })))
      .toThrow('apksig could not verify app.apkm (base.apk): DOES NOT VERIFY');
  });
});

// The real helper, when Java and build-tools are installed. A file that isn't
// an APK must come back as an error for that APK, not as a crash.
const realJar = findApksignerJar();
const javaOk = (() => { try { execFileSync('java', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
(realJar && javaOk ? test : test.skip)('SignerDigests.java compiles and reports a non-APK as unverifiable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signer-real-'));
  try {
    const junk = path.join(dir, 'junk.apk');
    fs.writeFileSync(junk, 'not a zip');
    const out = execFileSync('java', ['-cp', realJar, HELPER, junk, junk], { encoding: 'utf8' });
    const [first, second] = parseSignerOutput(out, 2);
    expect(first.sha256).toEqual([]);
    expect(first.error).toBeTruthy();
    expect(second.error).toBe(first.error);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
