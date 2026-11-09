'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../pipeline/sign_apks.sh');

describe('sign_apks.sh', () => {
  let dir; let apks; let tools;
  const stub = (name, body) => fs.writeFileSync(path.join(tools, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const run = (extra = {}) => spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env, APKS_DIR: apks, RUNNER_TEMP: dir, ANDROID_HOME: path.join(dir, 'sdk'),
      ANDROID_BUILD_TOOLS_VERSION: '35', KEYSTORE_BASE64: 'a2V5', KEYSTORE_PASSWORD: 'pw', KEY_ALIAS: 'alias', ...extra,
    },
  });
  const signer = (verifyExit = 0) => stub('apksigner', `
if [ "$1" = verify ]; then exit ${verifyExit}; fi
while [ "$#" -gt 1 ]; do [ "$1" = --out ] && out="$2"; shift; done
printf signed > "$out"`);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-apks-'));
    apks = path.join(dir, 'apks');
    tools = path.join(dir, 'sdk/build-tools/35');
    fs.mkdirSync(apks);
    fs.mkdirSync(tools, { recursive: true });
    fs.writeFileSync(path.join(apks, 'a-v1-v2.apk'), 'unsigned');
    stub('zipalign', 'exit 0');
    signer();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('replaces the APK with its signed copy and removes the keystore', () => {
    expect(run().status).toBe(0);
    expect(fs.readFileSync(path.join(apks, 'a-v1-v2.apk'), 'utf8')).toBe('signed');
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('sign.'))).toEqual([]);
  });

  test('leaves the APK unchanged when verification fails', () => {
    signer(1);
    expect(run().status).not.toBe(0);
    expect(fs.readFileSync(path.join(apks, 'a-v1-v2.apk'), 'utf8')).toBe('unsigned');
  });

  test('fails without the keystore secret', () => {
    const result = run({ KEYSTORE_BASE64: '' });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain('KEYSTORE_BASE64');
  });
});
