'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

function retryAfterMs(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  const delay = /^\d+$/.test(text) ? Number(text) * 1000
    : /^[A-Za-z]{3}, /.test(text) ? Date.parse(text) - now : NaN;
  // Cooldown is checked without sleeping: long server delays must not turn
  // into earlier retries. Saturate huge numeric headers instead of overflowing.
  return Number.isNaN(delay) ? 30000 : Math.min(Number.MAX_SAFE_INTEGER - now, Math.max(0, delay));
}

async function withApkmirrorPacing(fn, options = {}) {
  const dir = options.dir || process.env.APKMIRROR_PACING_DIR || path.join(process.env.RUNNER_TEMP || os.tmpdir(),
    `amb-apkmirror-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 16)}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // flock owns the descriptor; EOF on stdin also releases it if Node exits.
  const lock = spawn('flock', ['-w', '45', path.join(dir, 'lock'), 'sh', '-c', 'printf ready; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => lock.once('exit', resolve));
  lock.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      lock.once('error', reject);
      lock.stdout.once('data', resolve);
      lock.once('exit', code => reject(new Error(`APKMirror pacing lock unavailable (${code})`)));
    });
    const stateFile = path.join(dir, 'state.json');
    let state = {};
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.cooldown > Date.now()) throw Object.assign(new Error('APKMirror shared cooldown (HTTP 429)'), { status: 429 });
    const wait = Math.min(1500, Math.max(0, (state.next || 0) - Date.now()));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    const save = async () => {
      await fs.writeFile(`${stateFile}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await fs.rename(`${stateFile}.tmp`, stateFile);
    };
    try {
      return await fn({ cooldown: async value => {
        const now = Date.now();
        state.cooldown = now + Math.max(1500, retryAfterMs(value, now));
        await save();
      } });
    } finally {
      state.next = Date.now() + (options.interval ?? 1500);
      await save();
    }
  } finally {
    lock.stdin.end();
    if (lock.pid) await exited;
  }
}
module.exports = { retryAfterMs, withApkmirrorPacing };
