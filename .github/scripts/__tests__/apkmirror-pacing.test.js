'use strict';
const { retryAfterMs, withApkmirrorPacing } = require('../apkmirror-pacing');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test.each([['2', 2000], ['invalid', 30000], ['999999', 999999000], ['-1', 30000], ['9'.repeat(400), Number.MAX_SAFE_INTEGER]])('honors Retry-After without shortening %s', (value, expected) => {
  expect(retryAfterMs(value, 0)).toBe(expected);
});
test('supports HTTP dates and expired dates', () => {
  expect(retryAfterMs('Thu, 01 Jan 1970 00:00:10 GMT', 0)).toBe(10000);
  expect(retryAfterMs('Thu, 01 Jan 1970 00:00:00 GMT', 1000)).toBe(0);
});
test('preserves valid shared state when an owner is killed during save', async () => {
  const { spawn, execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apkmirror-save-'));
  const options = { dir, interval: 0 };
  const prefix = `const {withApkmirrorPacing}=require(${JSON.stringify(require.resolve('../apkmirror-pacing'))}); const options=${JSON.stringify(options)};`;
  let child;
  let exited;
  try {
    await withApkmirrorPacing(async () => {}, options);
    const existing = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
    child = spawn(process.execPath, ['-e', `${prefix}
      const fs = require('node:fs/promises');
      const writeFile = fs.writeFile.bind(fs);
      fs.writeFile = async (target, data, options) => {
        await writeFile(target, '', options);
        console.log('truncated');
        await new Promise(() => {});
      };
      withApkmirrorPacing(async () => {}, options);
      setInterval(() => {}, 1000);
    `], { timeout: 5000 });
    exited = new Promise(resolve => child.once('exit', resolve));
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('child exited before truncating')));
      child.stdout.once('data', data => {
        try { expect(data.toString().trim()).toBe('truncated'); resolve(); } catch (error) { reject(error); }
      });
    });
    child.kill('SIGKILL');
    await exited;
    const result = await promisify(execFile)(process.execPath, ['-e', `${prefix}
      withApkmirrorPacing(async () => {
        console.log(await require('node:fs/promises').readFile(require('node:path').join(options.dir, 'state.json'), 'utf8'));
      }, options).catch(error => { console.error(error); process.exitCode = 1; });
    `], { timeout: 5000 });
    expect(JSON.parse(result.stdout)).toEqual(existing);
  } finally {
    if (child) { child.kill('SIGKILL'); await exited; }
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 15000);
test('queues callers, releases after throw, and shares cooldown', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apkmirror-test-'));
  const options = { dir, interval: 10 };
  const order = [];
  try {
    await Promise.all([1, 2, 3].map(n => withApkmirrorPacing(async () => { order.push(n); }, options)));
    expect(order).toHaveLength(3);
    await expect(withApkmirrorPacing(async () => { throw new Error('fixture'); }, options)).rejects.toThrow('fixture');
    await withApkmirrorPacing(async gate => gate.cooldown('2'), options);
    await expect(withApkmirrorPacing(async () => { throw new Error('must not request'); }, options)).rejects.toMatchObject({ status: 429 });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Linux flock coordinates separate Node processes and releases on process exit', async () => {
  const { spawn } = require('node:child_process');
  const { promisify } = require('node:util');
  const execFile = promisify(require('node:child_process').execFile);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apkmirror-process-'));
  const modulePath = require.resolve('../apkmirror-pacing');
  const run = code => execFile(process.execPath, ['-e', code], { timeout: 5000 });
  const prefix = `const {withApkmirrorPacing}=require(${JSON.stringify(modulePath)}); const options=${JSON.stringify({ dir, interval: 50 })};`;
  try {
    const results = await Promise.all([1, 2].map(() => run(`${prefix} withApkmirrorPacing(async()=>{ console.log(Date.now()); await new Promise(r=>setTimeout(r,50)); },options);`)));
    const times = results.map(r => Number(r.stdout.trim())).sort((a,b) => a-b);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(90);
    const child = spawn(process.execPath, ['-e', `${prefix} withApkmirrorPacing(async()=>{ console.log('locked'); await new Promise(()=>{}); },options); setInterval(()=>{},1000);`]);
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    await run(`${prefix} withApkmirrorPacing(async gate=>gate.cooldown('2'),options);`);
    const result = await run(`${prefix} withApkmirrorPacing(()=>{throw Error('request');},options).catch(e=>console.log(e.status));`);
    expect(result.stdout.trim()).toBe('429');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
