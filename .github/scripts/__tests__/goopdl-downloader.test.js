'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// Lazy import makes the initial RED failure describe the missing implementation.
const download = (...args) => require('../goopdl-downloader').downloadWithGoopdl(...args);
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goopdl-test-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function fixture({ wrongVersion = false, corrupt = false, traversal = false, wrongAbi = false } = {}) {
  const wrapped = jest.fn(async (command, args, opts) => {
    if (command === 'flock') return wrapped(args[4], args.slice(5), opts);
    if (command === 'fixture-goopdl') {
      const output = args[args.indexOf('-o') + 1];
      const files = ['com.test-123.apk', 'com.test-123-config.arm64_v8a.apk'].map(name => {
        const file = path.join(output, name);
        if (wrongAbi && name.includes('config.')) {
          const contents = path.join(output, 'contents');
          fs.mkdirSync(path.join(contents, 'lib/armeabi-v7a'), { recursive: true });
          fs.writeFileSync(path.join(contents, 'AndroidManifest.xml'), 'fixture');
          fs.writeFileSync(path.join(contents, 'lib/armeabi-v7a/libfixture.so'), 'fixture');
          execFileSync('zip', ['-q', file, 'AndroidManifest.xml', 'lib/armeabi-v7a/libfixture.so'], { cwd: contents });
        } else fs.writeFileSync(file, name);
        const raw = fs.readFileSync(file);
        return { path: traversal ? '../escape.apk' : name, size: raw.length, algorithm: 'sha256', digest: corrupt ? 'incorrect' : crypto.createHash('sha256').update(raw).digest('base64url') };
      });
      fs.writeFileSync(args[args.indexOf('--integrity-manifest') + 1], JSON.stringify({ files }));
      expect(opts.env.HOME).not.toBe(os.homedir());
      return { stdout: '' };
    }
    if (command === 'aapt') {
      const split = args[2].includes('config.') ? " split='config.arm64_v8a'" : '';
      return { stdout: `package: name='com.test' versionCode='123' versionName='${wrongVersion ? '9.9' : '1.2'}'${split}\n` };
    }
    return { stdout: execFileSync(command, args, opts) };
  });
  return wrapped;
}
test.each([
  ['wrongVersion', /base\/version mismatch/],
  ['corrupt', /digest mismatch/],
  ['traversal', /artifact path/],
  ['wrongAbi', /no split containing lib\/arm64-v8a/],
])('rejects %s and removes temporary artifacts', async (failure, message) => {
  const exec = fixture({ [failure]: true });
  await expect(download('com.test', '1.2', dir, options(exec))).rejects.toThrow(message);
  expect(fs.readdirSync(dir).filter(name => name !== 'pool')).toEqual([]);
});

test('artifact validation opens files without following links before inspecting their bytes', async () => {
  const open = jest.spyOn(fs, 'openSync');
  try {
    await download('com.test', '1.2', dir, options(fixture()));
    expect(open.mock.calls.some(([file, flags]) =>
      String(file).endsWith('.apk') && typeof flags === 'number' && (flags & fs.constants.O_NOFOLLOW) !== 0,
    )).toBe(true);
  } finally { open.mockRestore(); }
});

test('unverified architecture variants retain the original fallback path', async () => {
  const exec = fixture();
  await expect(download('com.test', '1.2', dir, { ...options(exec), preferredArch: 'x86_64' })).rejects.toThrow('not verified for requested architecture');
  expect(exec).not.toHaveBeenCalled();
});

test('unknown historical versions skip Play without probing rollout cohorts', async () => {
  const exec = fixture();
  await expect(download('com.test', '7.8', dir, options(exec))).rejects.toThrow('No verified Google Play version code');
  expect(exec).not.toHaveBeenCalled();
});

test('upstream error output is redacted and incomplete downloads are removed', async () => {
  const exec = jest.fn(async () => { throw new Error('sensitive token and delivery URL'); });
  await expect(download('com.test', '1.2', dir, options(exec))).rejects.toThrow(/^Google Play download unavailable or timed out$/);
  expect(fs.readdirSync(dir).filter(name => name !== 'pool')).toEqual([]);
});

const options = (execFileImpl) => ({ execFileImpl, homeDir: path.join(dir, 'pool'), goopdlBin: 'fixture-goopdl', versionCodes: { 'com.test': { '1.2': 123 } } });

test('downloads exact numeric code, validates delivery and packages splits for the existing merger', async () => {
  const exec = fixture();
  const result = await download('com.test', '1.2', dir, options(exec));
  expect(result).toMatchObject({ success: true, source: 'goopdl' });
  expect(result.url).toBeUndefined();
  expect(result.file).toMatch(/\.apkm$/);
  expect(execFileSync('unzip', ['-Z1', result.file], { encoding: 'utf8' }).trim().split('\n')).toEqual(['base.apk', 'com.test-123-config.arm64_v8a.apk']);
  const [command, args] = exec.mock.calls[0];
  expect(command).toBe('flock');
  expect(args.slice(0, 5)).toEqual(['-F', '-w', '30', path.join(dir, 'pool', '.lock'), 'fixture-goopdl']);
  expect(exec.mock.calls[0][2].env.HOME).toBe(path.join(dir, 'pool'));
  expect(args).toEqual(expect.arrayContaining(['--version', '123', '--splits', '--no-extras', '--arch', 'arm64']));
  expect(fs.readdirSync(dir).filter(name => name !== 'pool')).toEqual([path.basename(result.file)]);
});
