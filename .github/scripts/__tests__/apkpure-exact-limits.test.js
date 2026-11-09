'use strict';

// Drives the real downloadWithUrl validators with only the subprocess boundary
// faked, so every check it runs must carry the remaining time.
jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), execFileSync: jest.fn() }));
jest.mock('../../../src/download/config', () => ({
  ...jest.requireActual('../../../src/download/config'),
  loadConfig: () => ({ preferred_arch: 'arm64-v8a' }),
}));

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { downloadWithUrl } = require('../unified-downloader');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-limits-')); execFileSync.mockReset(); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const curl = (outputDir) => jest.fn(() => {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    fs.writeFileSync(path.join(outputDir, 'com.app_1.2.apk'), Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(20000)]));
    child.emit('close', 0);
  });
  return child;
});

const fakeBundle = (innerListing) => (tool, args) => {
  if (tool !== 'unzip') throw new Error(`unexpected ${tool}`);
  if (args[0] === '-t') return '';
  if (args[0] === '-q') {
    fs.writeFileSync(path.join(args[args.length - 1], 'base.apk'), 'x');
    return '';
  }
  return String(args[1]).endsWith('com.app_1.2.apk') ? 'base.apk\nsplit.apk\n' : innerListing;
};

test('every check on a bundle gets the remaining time', async () => {
  execFileSync.mockImplementation(fakeBundle('lib/arm64-v8a/a.so\n'));
  const result = await downloadWithUrl('https://example.test/a.apk', dir, 'com.app', '1.2', { spawnImpl: curl(dir), timeoutMs: () => 777, expired: () => false });
  expect(result.success).toBe(true);
  const unzip = execFileSync.mock.calls.map(([, args, options]) => [args[0], options.timeout]);
  expect(unzip.map(([flag]) => flag)).toEqual(expect.arrayContaining(['-Z1', '-t', '-q']));
  expect(unzip.every(([, timeout]) => timeout === 777)).toBe(true);
});

test('no retry once the end time has passed', async () => {
  execFileSync.mockImplementation(fakeBundle('lib/x86/a.so\n'));
  const sleepImpl = jest.fn(async () => {});
  let checks = 0; // still in time for the bundle check, past it by the retry decision
  const expired = () => checks++ > 0;
  await expect(downloadWithUrl('https://example.test/a.apk', dir, 'com.app', '1.2', { spawnImpl: curl(dir), sleepImpl, timeoutMs: () => 1, expired }))
    .rejects.toThrow();
  expect(sleepImpl).not.toHaveBeenCalled();
});

test('no limit passed means no timeout, as before', async () => {
  execFileSync.mockImplementation(fakeBundle('lib/arm64-v8a/a.so\n'));
  await downloadWithUrl('https://example.test/a.apk', dir, 'com.app', '1.2', { spawnImpl: curl(dir) });
  expect(execFileSync.mock.calls.every(([, , options]) => options.timeout === undefined)).toBe(true);
});
