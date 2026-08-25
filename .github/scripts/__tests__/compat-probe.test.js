// .github/scripts/__tests__/compat-probe.test.js
'use strict';

const {
  probe,
  classifyStderr,
  renderTable,
  API_MISSING_PATTERNS,
} = require('../compat-probe');

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const mimoConfig = () => ({
  patch_repos: {
    'com.getmimo': {
      name: 'mimo',
      repo: 'hoo-dles/morphe-patches',
      branch: 'main',
      apkmirror_path: 'mimohello-gmbh/mimo-learn-to-code',
    },
  },
  cli: { repo: 'MorpheApp/morphe-desktop', branch: 'main' },
});

// --- classifyStderr -------------------------------------------------------

describe('classifyStderr', () => {
  test('NoSuchMethodError with method name captures the method', () => {
    const stderr = `
      java.lang.NoSuchMethodError: 'app.morphe.patcher.patch.BytecodePatchBuilder app.morphe.patcher.patch.BytecodePatchBuilder.extendWithAll(java.util.function.Supplier)'
        at hoodles.morphe.patches.shared.misc.pairip.resources.PairipResourcesPatchKt.mergeDexPatch$lambda$0(PairipResourcesPatch.kt:14)
    `;
    const r = classifyStderr(stderr);
    expect(r.kind).toBe('api-mismatch');
    expect(r.error).toBe('NoSuchMethodError');
    expect(r.symbol).toBe('extendWithAll');
  });

  test('NoClassDefFoundError captures the class', () => {
    const stderr = `java.lang.NoClassDefFoundError: Lapp/morphe/patcher/some/NewerThing;`;
    const r = classifyStderr(stderr);
    expect(r.kind).toBe('api-mismatch');
    expect(r.error).toBe('NoClassDefFoundError');
  });

  test('IncompatibleClassChangeError is captured but symbol may be null', () => {
    const r = classifyStderr('java.lang.IncompatibleClassChangeError');
    expect(r.kind).toBe('api-mismatch');
    expect(r.error).toBe('IncompatibleClassChangeError');
    expect(r.symbol).toBeNull();
  });

  test('VerifyError is captured', () => {
    const r = classifyStderr('java.lang.VerifyError: Bad type on operand stack');
    expect(r.kind).toBe('api-mismatch');
    expect(r.error).toBe('VerifyError');
  });

  test('LinkageError is captured', () => {
    const r = classifyStderr('java.lang.LinkageError: loader constraints violated');
    expect(r.kind).toBe('api-mismatch');
    expect(r.error).toBe('LinkageError');
  });

  test('plain non-error stderr returns null', () => {
    expect(classifyStderr('Most common compatible versions: 9.24')).toBeNull();
  });

  test('empty stderr returns null', () => {
    expect(classifyStderr('')).toBeNull();
  });

  test('unknown exception in stderr returns other-error', () => {
    const r = classifyStderr('java.io.IOException: connection refused');
    expect(r.kind).toBe('other-error');
  });
});

// --- renderTable ----------------------------------------------------------

describe('renderTable', () => {
  test('empty', () => {
    expect(renderTable([])).toBe('_(no apps)_');
  });

  test('OK row', () => {
    const md = renderTable([
      { appId: 'com.getmimo', repo: 'hoo-dles/morphe-patches', tag: 'v1.42.0-dev.2', status: 'OK' },
    ]);
    expect(md).toContain('| com.getmimo | hoo-dles/morphe-patches@v1.42.0-dev.2 | OK |');
  });

  test('API_MISMATCH row shows symbol in code-fence', () => {
    const md = renderTable([
      { appId: 'com.getmimo', repo: 'hoo-dles/morphe-patches', tag: 'v1.42.0-dev.2', status: 'API_MISMATCH', error: 'NoSuchMethodError', symbol: 'extendWithAll' },
    ]);
    expect(md).toContain('API_MISMATCH');
    expect(md).toContain('missing `extendWithAll`');
  });

  test('top-level config error row omits the app column content', () => {
    const md = renderTable([{ appId: null, error: 'broken config' }]);
    expect(md).toContain('_config_');
    expect(md).toContain('broken config');
  });

  test('error strings escape backslashes AND pipes (no stray backslash survives)', () => {
    // CodeQL js/incomplete-string-escaping — both `\` and `|` need to be
    // escaped for the GFM table to render the literal characters instead
    // of treating them as table syntax or markdown escape sequences.
    const md = renderTable([
      { appId: 'com.x', repo: 'a/b', tag: 'v1', status: 'ERROR', error: 'path\\to\\file | with|pipe' },
    ]);
    // The literal `\`, `|` from the input must appear escaped in the
    // rendered table (the backslashes doubled, the pipes escaped).
    expect(md).toContain('path\\\\to\\\\file \\| with\\|pipe');
    // And the raw, unescaped input sequence (`\\|file | with|`) must NOT
    // survive — only its escaped form should be present in the body.
    const dataRow = md.split('\n').slice(-1)[0];
    expect(dataRow).not.toContain('file | with|');
  });

  test('newlines in error strings are flattened to spaces (one row, one line)', () => {
    const md = renderTable([
      { appId: 'com.x', repo: 'a/b', tag: 'v1', status: 'ERROR', error: 'line1\nline2' },
    ]);
    expect(md).toContain('line1 line2');
    expect(md).not.toContain('line1\nline2');
    // Header (1 line, contains \n internally) + body = 3 physical lines.
    expect(md.split('\n')).toHaveLength(3); // header, separator, body
  });
});

// --- probe (integration) -------------------------------------------------

/**
 * Stub execImpl matching the promisified child_process.execFile
 * shape: `(cmd, args, opts) -> Promise<{ stdout, stderr }>` or throws
 * an Error whose `.stderr` carries the captured output.
 */
function makeExecStub(behaviors) {
  // behaviors: array of { match: RegExp | 'default', result, error }
  return async (cmd, args) => {
    const argStr = args.join(' ');
    for (const b of behaviors) {
      if (b.match === 'default' || (b.match instanceof RegExp && b.match.test(argStr))) {
        if (b.error) {
          const err = new Error(b.error.message || 'mocked failure');
          err.stderr = b.error.stderr || '';
          err.stdout = b.error.stdout || '';
          throw err;
        }
        return { stdout: b.stdout || '', stderr: b.stderr || '' };
      }
    }
    throw new Error(`unmocked exec call: ${cmd} ${argStr}`);
  };
}

describe('probe', () => {
  test('returns config-error row when patch_repos missing', async () => {
    const rows = await probe({
      config: { cli: { repo: 'a/b', branch: 'main' } },
      repoVersions: {},
      execImpl: makeExecStub([]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].appId).toBeNull();
    expect(rows[0].error).toMatch(/patch_repos/);
  });

  test('returns error row when morphe-desktop.jar missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-probe-'));
    try {
      const rows = await probe({
        config: mimoConfig(),
        repoVersions: { 'hoo-dles/morphe-patches': 'v1.42.0-dev.2' },
        toolsDir: tmp,
        execImpl: makeExecStub([]),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].error).toMatch(/morphe-desktop\.jar not found/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns NO_MPP row when .mpp missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-probe-'));
    try {
      fs.writeFileSync(path.join(tmp, 'morphe-desktop.jar'), 'fake');
      const rows = await probe({
        config: mimoConfig(),
        repoVersions: { 'hoo-dles/morphe-patches': 'v1.42.0-dev.2' },
        toolsDir: tmp,
        execImpl: makeExecStub([]),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('NO_MPP');
      expect(rows[0].error).toMatch(/hoo-dles-morphe-patches\.mpp/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('OK row when java exits 0', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-probe-'));
    try {
      fs.writeFileSync(path.join(tmp, 'morphe-desktop.jar'), 'fake');
      fs.writeFileSync(path.join(tmp, 'hoo-dles-morphe-patches.mpp'), 'fake');
      const rows = await probe({
        config: mimoConfig(),
        repoVersions: { 'hoo-dles/morphe-patches': 'v1.42.0-dev.2' },
        toolsDir: tmp,
        execImpl: makeExecStub([{
          match: /list-versions/,
          stdout: 'Most common compatible versions: 9.24',
          stderr: '',
        }]),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('OK');
      expect(rows[0].error).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('API_MISMATCH row when stderr carries NoSuchMethodError', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-probe-'));
    try {
      fs.writeFileSync(path.join(tmp, 'morphe-desktop.jar'), 'fake');
      fs.writeFileSync(path.join(tmp, 'hoo-dles-morphe-patches.mpp'), 'fake');
      const rows = await probe({
        config: mimoConfig(),
        repoVersions: { 'hoo-dles/morphe-patches': 'v1.42.0-dev.2' },
        toolsDir: tmp,
        execImpl: makeExecStub([{
          match: /list-versions/,
          error: {
            message: 'Command failed: exit 1',
            stderr: "Exception in thread \"main\" java.lang.NoSuchMethodError: '...BytecodePatchBuilder.extendWithAll(java.util.function.Supplier)'",
          },
        }]),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('API_MISMATCH');
      expect(rows[0].symbol).toBe('extendWithAll');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('FAIL row when stderr is non-empty but not an API mismatch', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-probe-'));
    try {
      fs.writeFileSync(path.join(tmp, 'morphe-desktop.jar'), 'fake');
      fs.writeFileSync(path.join(tmp, 'hoo-dles-morphe-patches.mpp'), 'fake');
      const rows = await probe({
        config: mimoConfig(),
        repoVersions: { 'hoo-dles/morphe-patches': 'v1.42.0-dev.2' },
        toolsDir: tmp,
        execImpl: makeExecStub([{
          match: /list-versions/,
          error: {
            message: 'Command failed: exit 137',
            stderr: 'Killed (out of memory)',
          },
        }]),
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('FAIL');
      expect(rows[0].symbol).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('honours pin_patch_tag over repoVersions', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-probe-'));
    try {
      fs.writeFileSync(path.join(tmp, 'morphe-desktop.jar'), 'fake');
      fs.writeFileSync(path.join(tmp, 'hoo-dles-morphe-patches.mpp'), 'fake');
      const config = {
        patch_repos: {
          'com.getmimo': {
            name: 'mimo', repo: 'hoo-dles/morphe-patches', branch: 'main',
            apkmirror_path: 'x/y', pin_patch_tag: 'v1.40.0',
          },
        },
        cli: { repo: 'a/b', branch: 'main' },
      };
      const rows = await probe({
        config,
        repoVersions: { 'hoo-dles/morphe-patches': 'v1.42.0-dev.2' },
        toolsDir: tmp,
        execImpl: makeExecStub([{
          match: /list-versions/,
          stdout: '', stderr: '',
        }]),
      });
      expect(rows[0].tag).toBe('v1.40.0');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// --- API_MISSING_PATTERNS exposed ------------------------------------------

describe('API_MISSING_PATTERNS', () => {
  test('exports five well-known patcher-API error patterns', () => {
    expect(API_MISSING_PATTERNS).toHaveLength(5);
    const labels = API_MISSING_PATTERNS.map((p) => p.label);
    expect(labels).toEqual([
      'NoSuchMethodError',
      'NoClassDefFoundError',
      'IncompatibleClassChangeError',
      'VerifyError',
      'LinkageError',
    ]);
  });
});