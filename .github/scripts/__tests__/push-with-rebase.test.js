'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../pipeline/push_with_rebase.sh');

describe('push_with_rebase.sh', () => {
  let dir; let origin; let mine; let other;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (cwd, file, text) => {
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', `change ${file}`);
  };
  const clone = (name) => {
    const to = path.join(dir, name);
    git(dir, 'clone', '-q', origin, to);
    git(to, 'config', 'user.name', 't');
    git(to, 'config', 'user.email', 't@example.test');
    return to;
  };
  const push = () => spawnSync('bash', [script, origin, 'main'], {
    cwd: mine, encoding: 'utf8', env: { ...process.env, PUSH_RETRY_DELAY: '0' },
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-rebase-'));
    origin = path.join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', '--initial-branch=main', origin);
    const seed = clone('seed');
    git(seed, 'checkout', '-q', '-B', 'main');
    commit(seed, 'shared.txt', 'base\n');
    git(seed, 'push', '-q', 'origin', 'main');
    mine = clone('mine');
    other = clone('other');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('rebases onto a commit that landed after checkout', () => {
    commit(other, 'config.json', '{}\n');
    git(other, 'push', '-q', 'origin', 'main');
    commit(mine, 'patches.json', '{}\n');
    expect(push().status).toBe(0);
    const files = git(origin, 'ls-tree', '--name-only', 'main').split('\n');
    expect(files).toEqual(expect.arrayContaining(['config.json', 'patches.json']));
  });

  test('stops on a conflict without changing the branch', () => {
    commit(other, 'patches.json', 'theirs\n');
    git(other, 'push', '-q', 'origin', 'main');
    const before = git(origin, 'rev-parse', 'main');
    commit(mine, 'patches.json', 'mine\n');
    const result = push();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Could not rebase');
    expect(git(origin, 'rev-parse', 'main')).toBe(before);
  });
});
