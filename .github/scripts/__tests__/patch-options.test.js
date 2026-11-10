'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { enableArgs, optionArg } = require('../patch-metadata');
const { appFingerprint } = require('../build-fingerprint');
const { validateConfig } = require('../validate-config');

const app = 'com.example.app';
const structured = { patches: [
  { name: 'Rename', use: true, compatiblePackages: [{ packageName: app }] },
  { name: 'Opt-in', use: false, compatiblePackages: [{ packageName: app }] },
  { name: 'Shared', use: true, compatiblePackages: [{ packageName: app }] },
  { name: 'shared', default: false, compatiblePackages: null },
  { name: 'Other app', use: true, compatiblePackages: [{ packageName: 'com.other' }] },
] };
const run = (options, choices = {}, opts = {}) => {
  const warnings = [];
  const args = enableArgs(structured, app, choices, { options, warn: (m) => warnings.push(m), ...opts });
  return { args, warnings };
};

describe('patch_options flags', () => {
  test('no settings leaves the flags exactly as before', () => {
    expect(enableArgs(structured, app, { 'Opt-in': true })).toEqual([]);
    expect(enableArgs(structured, app, { 'Opt-in': true }, { honorOptIns: true })).toEqual(['-e', 'Opt-in']);
    expect(enableArgs(structured, app, { 'Opt-in': true }, { honorOptIns: true, options: {} })).toEqual(['-e', 'Opt-in']);
  });

  test("each setting is its own argument, directly after its patch's -e", () => {
    expect(run({ Rename: { appName: 'Maps', iconSize: 2, dark: true } }).args)
      .toEqual(['-e', 'Rename', '-OappName="Maps"', '-OiconSize=2', '-Odark=true']);
  });

  test('a patch already passed with -e gets its settings there, not a second -e', () => {
    const { args } = run({ 'Opt-in': { k: 'v' } }, { 'Opt-in': true }, { honorOptIns: true });
    expect(args).toEqual(['-e', 'Opt-in', '-Ok="v"']);
  });

  test('settings never switch a patch on', () => {
    const { args, warnings } = run({ 'Opt-in': { k: 'v' } });
    expect(args).toEqual([]);
    expect(warnings.join()).toMatch(/"Opt-in" ignored: the patch is off/);
  });

  test('an explicitly disabled patch stays disabled', () => {
    const { args, warnings } = run({ Rename: { appName: 'Maps' } }, { Rename: false });
    expect(args).toEqual([]);
    expect(warnings.join()).toMatch(/"Rename" ignored: it is disabled in patches.json/);
  });

  test("a patch missing from this release, or for another app, is skipped with a warning", () => {
    const { args, warnings } = run({ Gone: { k: 'v' }, 'Other app': { k: 'v' } });
    expect(args).toEqual([]);
    expect(warnings).toHaveLength(2);
  });

  test('settings fail rather than switch on a same-named patch that is off by default, whatever its case', () => {
    expect(() => run({ Shared: { k: 'v' } })).toThrow(/same-named patch that is off by default/);
  });

  test('without settings, a same-named off-by-default patch is left alone as before', () => {
    expect(run({}, { Shared: true }, { honorOptIns: true }).args).toEqual([]);
  });

  test('names must match exactly, as the patcher looks settings up by exact name', () => {
    const { args, warnings } = run({ rename: { k: 'v' } });
    expect(args).toEqual([]);
    expect(warnings.join()).toMatch(/"rename" ignored: this release spells it "Rename"/);
  });

  test('a same-named patch already switched on by -e is no reason to fail', () => {
    const { args } = run({ Shared: { k: 'v' } }, { shared: true }, { honorOptIns: true });
    expect(args).toEqual(['-e', 'shared', '-e', 'Shared', '-Ok="v"']);
  });

  test('a same-named patch set false disables this one too, so its settings are skipped', () => {
    const { args, warnings } = run({ Shared: { k: 'v' } }, { shared: false });
    expect(args).toEqual([]);
    expect(warnings.join()).toMatch(/"Shared" ignored: it is disabled/);
  });

  test('generated metadata takes settings the same way', () => {
    const generated = { generated: true, patches: [
      { name: 'Rename', use: true, compatiblePackages: null },
      { name: 'Opt-in', use: false, compatiblePackages: [{ packageName: app, targets: [] }] },
    ] };
    const options = { Rename: { appName: 'Maps' }, 'Opt-in': { k: 1 } };
    expect(enableArgs(generated, app, { 'Opt-in': true }, { options }))
      .toEqual(['-e', 'Opt-in', '-Ok=1', '-e', 'Rename', '-OappName="Maps"']);
  });
});

describe('option values', () => {
  test.each([
    ['Ungoogle Maps', '-Ok="Ungoogle Maps"'],
    ['Tom\'s "Maps" & co; $(id) `x`', '-Ok="Tom\'s "Maps" & co; $(id) `x`"'],
    ['true', '-Ok="true"'],
    ['1', '-Ok="1"'],
    ['null', '-Ok="null"'],
    ['', '-Ok=""'],
    ['a=b', '-Ok="a=b"'],
    [true, '-Ok=true'],
    [false, '-Ok=false'],
    [42, '-Ok=42'],
    [-1.5, '-Ok=-1.5'],
  ])('%p is passed as %s', (value, arg) => {
    expect(optionArg('k', value)).toBe(arg);
  });

  test('the runtime prints the exact arguments, spaces and quotes included', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-options-'));
    try {
      const write = (name, value) => { const file = path.join(dir, name); fs.writeFileSync(file, JSON.stringify(value)); return file; };
      const tools = path.join(dir, 'tools');
      fs.mkdirSync(tools);
      fs.writeFileSync(path.join(tools, 'patches-list.json'), JSON.stringify(structured));
      const name = 'My "Maps" app\'s  name';
      const env = {
        ...process.env,
        TOOLS_DIR: tools,
        PATCH_REPO: 'own/patches',
        APP_ID: app,
        PATCHES_FILE: write('patches.json', { 'own/patches': { [app]: { 'Opt-in': false } } }),
        CONFIG_FILE: write('config.json', { patch_repos: { [app]: { patch_options: { Rename: { appName: name }, 'Opt-in': { k: 'v' } } } } }),
      };
      const out = execFileSync(process.execPath, [path.resolve(__dirname, '../patch-metadata-runtime.js'), 'enables'],
        { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      expect(JSON.parse(out)).toEqual(['-e', 'Rename', `-OappName="${name}"`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('patch_apk.sh splits the arguments on NUL only, so values keep their spaces and quotes', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../pipeline/patch_apk.sh'), 'utf8');
    expect(script).toContain('patch-metadata-runtime.js" enables)"');
    expect(script).toContain(`mapfile -d '' -t ENABLE_ARGS < <(jq -j '.[] + "\\u0000"' <<< "$ENABLE_ARGS_JSON")`);
  });

  test('patch_apk.sh fails when the patcher logs a setting it could not apply', () => {
    const script = fs.readFileSync(path.resolve(__dirname, '../pipeline/patch_apk.sh'), 'utf8');
    const check = script.indexOf("if grep -F 'Could not set option' \"$PATCH_LOG\"");
    expect(check).toBeGreaterThan(script.indexOf('if ! run_patch unsigned'));
    expect(script.slice(check, script.indexOf('fi\n', check))).toMatch(/exit 1/);
  });
});

describe('validation', () => {
  const config = (patchOptions) => ({
    cli: { repo: 'MorpheApp/morphe-desktop', branch: 'main' },
    patch_repos: { [app]: { name: 'example', repo: 'own/patches', branch: 'main', apkmirror_path: 'p/a', patch_options: patchOptions } },
  });
  const errors = (patchOptions) => validateConfig(config(patchOptions)).filter((i) => i.level === 'error').map((i) => i.message);

  test('accepts strings, Booleans and plain numbers', () => {
    expect(errors({ Rename: { appName: 'Tom\'s "Maps"', n: 2, d: -1.5, b: false } })).toEqual([]);
  });

  test.each([
    ['not an object', ['x']],
    ['empty settings', { Rename: {} }],
    ['settings not an object', { Rename: 'x' }],
    ['a key with a space', { Rename: { 'app name': 'x' } }],
    ['a key with =', { Rename: { 'a=b': 'x' } }],
    ['null', { Rename: { k: null } }],
    ['a list', { Rename: { k: ['a'] } }],
    ['an object', { Rename: { k: {} } }],
    ['an exponent', { Rename: { k: 1e21 } }],
    ['a whole number past 2^53', { Rename: { k: 2 ** 53 } }],
    ['a NUL', { Rename: { k: 'a\u0000b' } }],
    ['patch names differing only in case', { Rename: { k: 'a' }, rename: { k: 'b' } }],
  ])('rejects %s', (_, patchOptions) => {
    expect(errors(patchOptions).join()).toMatch(/patch_options/);
  });

  test('the JSON schema accepts the field and checks its shape', () => {
    const Ajv = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv({ allErrors: true, strict: true });
    addFormats(ajv);
    const schema = ajv.compile(JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../schemas/config.schema.json'), 'utf8')));
    const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../config.json'), 'utf8'));
    const [id] = Object.keys(real.patch_repos);
    const withOptions = (patchOptions) => ({ ...real, patch_repos: { ...real.patch_repos, [id]: { ...real.patch_repos[id], patch_options: patchOptions } } });
    expect(schema(real)).toBe(true);
    expect(schema(withOptions({ Rename: { appName: 'My Maps', n: 2, b: true } }))).toBe(true);
    for (const bad of [{ Rename: {} }, { Rename: { 'a b': 'x' } }, { Rename: { k: null } }, { Rename: { k: ['a'] } }, []]) {
      expect(schema(withOptions(bad))).toBe(false);
    }
  });
});

describe('fingerprint', () => {
  const entry = (patchOptions) => ({ name: 'a', repo: 'own/a', branch: 'main', apkmirror_path: 'p/a', ...(patchOptions && { patch_options: patchOptions }) });
  const both = (a, b) => ({ cli: {}, patch_repos: { 'com.a': entry(a), 'com.b': entry(b) } });
  const print = (config, id) => appFingerprint(config, {}, id, 'v1', 'pipe');

  test('changing one app\'s settings rebuilds that app only', () => {
    const before = both({ Rename: { appName: 'A' } }, undefined);
    const after = both({ Rename: { appName: 'B' } }, undefined);
    expect(print(after, 'com.a')).not.toBe(print(before, 'com.a'));
    expect(print(after, 'com.b')).toBe(print(before, 'com.b'));
  });

  test('apps without settings keep their fingerprint', () => {
    expect(print(both(undefined, undefined), 'com.a')).toBe(appFingerprint({ cli: {}, patch_repos: { 'com.a': entry() } }, {}, 'com.a', 'v1', 'pipe'));
  });
});
