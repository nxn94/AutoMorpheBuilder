// .github/scripts/__tests__/checksums-helpers.test.js
'use strict';

// Jest tests for the bash helpers in `.github/scripts/pipeline/lib/checksums.sh`.
// These helpers drive the SHA-256 pin-tripwire in `download_morphe_tools.sh`
// and `fetch_morphe_tools.sh`; a regression in the regex used to extract the
// pin row's `# vX.Y.Z` annotation would silently flip a "CLI bump" warning
// into a "tamper signal" hard-fail on the next release.
//
// The helpers are shell-only, so each test spawns `bash -c` against a
// fixture manifest written to a tmpdir. Tests are skipped when bash is
// unavailable.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CHECKSUMS_LIB = path.join(
  REPO_ROOT,
  '.github',
  'scripts',
  'pipeline',
  'lib',
  'checksums.sh',
);

function bashAvailable() {
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// writeManifest <tmpDir> <body>
//   Drop <body> at <tmpDir>/tools.sha256 so the helper under test can be
//   pointed at it via CHECKSUMS_FILE.
function writeManifest(tmpDir, body) {
  fs.mkdirSync(path.join(tmpDir, 'checksums'), { recursive: true });
  const file = path.join(tmpDir, 'checksums', 'tools.sha256');
  fs.writeFileSync(file, body);
  return file;
}

// runHelper <manifestFile> <artifact>
//   Source the lib in a fresh bash subshell and invoke the requested
//   helper. Returns the captured stdout, trimmed. Exit code is exposed
//   via the second tuple element when callers care.
function runHelper(manifestFile, artifact, helper) {
  const script =
    `set -e\n` +
    `CHECKSUMS_FILE='${manifestFile}'\n` +
    `. '${CHECKSUMS_LIB}'\n` +
    `${helper} '${artifact}'\n`;
  const out = execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return out.replace(/\n$/, '');
}

describe('lib/checksums.sh helpers', () => {
  const skipAll = !bashAvailable();

  beforeAll(() => {
    if (skipAll) {
      console.warn('bash not on PATH; skipping checksums-helpers tests');
    }
  });

  describe('tools_sha_lookup', () => {
    test('returns the SHA for a real pin row', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        [
          '# header comment',
          'a'.repeat(64) + "  morphe-desktop.jar  # v1.15.1",
          'b'.repeat(64) + "  APKEditor.jar  # V1.4.9",
          '',
        ].join('\n'),
      );
      expect(runHelper(file, 'morphe-desktop.jar', 'tools_sha_lookup')).toBe(
        'a'.repeat(64),
      );
      expect(runHelper(file, 'APKEditor.jar', 'tools_sha_lookup')).toBe(
        'b'.repeat(64),
      );
    });

    test('returns empty string for unknown artifact or missing manifest', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        'a'.repeat(64) + "  morphe-desktop.jar  # v1.15.1\n",
      );
      expect(runHelper(file, 'nope.jar', 'tools_sha_lookup')).toBe('');
    });
  });

  describe('tools_sha_pinned', () => {
    test('returns success when the artifact is pinned', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        'a'.repeat(64) + "  morphe-desktop.jar  # v1.15.1\n",
      );
      const script =
        `set -e\n` +
        `CHECKSUMS_FILE='${file}'\n` +
        `. '${CHECKSUMS_LIB}'\n` +
        `if tools_sha_pinned morphe-desktop.jar; then echo pinned; else echo nope; fi\n`;
      const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(out.trim()).toBe('pinned');
    });

    test('returns failure for unknown artifact', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        'a'.repeat(64) + "  morphe-desktop.jar  # v1.15.1\n",
      );
      const script =
        `set -e\n` +
        `CHECKSUMS_FILE='${file}'\n` +
        `. '${CHECKSUMS_LIB}'\n` +
        `if tools_sha_pinned nope.jar; then echo pinned; else echo nope; fi\n`;
      const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
      expect(out.trim()).toBe('nope');
    });
  });

  describe('tools_sha_pinned_version', () => {
    const sha = 'a'.repeat(64);
    const sha2 = 'b'.repeat(64);

    test('returns lowercase "vX.Y.Z" preserving the leading v', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        `${sha}  morphe-desktop.jar  # v1.15.1\n`,
      );
      expect(runHelper(file, 'morphe-desktop.jar', 'tools_sha_pinned_version'))
        .toBe('v1.15.1');
    });

    test('returns uppercase "V" prefix as-is (APKEditor case)', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        `${sha}  APKEditor.jar  # V1.4.9\n`,
      );
      expect(runHelper(file, 'APKEditor.jar', 'tools_sha_pinned_version'))
        .toBe('V1.4.9');
    });

    test('returns version without leading v when none is present', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        `${sha}  some.jar  # 2.0.0\n`,
      );
      expect(runHelper(file, 'some.jar', 'tools_sha_pinned_version'))
        .toBe('2.0.0');
    });

    test('returns empty when the row carries no version annotation', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        `${sha}  some.jar  # verified via foo + sha256sum\n`,
      );
      expect(runHelper(file, 'some.jar', 'tools_sha_pinned_version'))
        .toBe('');
    });

    test('returns empty when the artifact is not pinned', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        `${sha}  morphe-desktop.jar  # v1.15.1\n`,
      );
      expect(runHelper(file, 'nope.jar', 'tools_sha_pinned_version'))
        .toBe('');
    });

    test('returns empty when the manifest is missing', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const missing = path.join(tmp, 'checksums', 'tools.sha256');
      // Do NOT write the file; the helper should tolerate absence.
      expect(runHelper(missing, 'morphe-desktop.jar', 'tools_sha_pinned_version'))
        .toBe('');
    });

    test('captures pre-release tags like v2.0.0-rc.1', () => {
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        `${sha}  pre.jar  # v2.0.0-rc.1\n`,
      );
      expect(runHelper(file, 'pre.jar', 'tools_sha_pinned_version'))
        .toBe('v2.0.0-rc.1');
    });

    test('returns the first artifact when multiple rows match (defensive)', () => {
      // The helper reads the first row whose pin matches; a duplicate
      // row would normally be a manifest bug. Document the behaviour
      // so a future refactor doesn't accidentally flip ordering.
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      const file = writeManifest(
        tmp,
        [
          `${sha}  morphe-desktop.jar  # v1.15.0`,
          `${sha2}  morphe-desktop.jar  # v1.15.1`,
          '',
        ].join('\n'),
      );
      expect(runHelper(file, 'morphe-desktop.jar', 'tools_sha_pinned_version'))
        .toBe('v1.15.0');
    });

    test('is unaffected by CR/LF endings and trailing whitespace', () => {
      // The helper is consumed by download scripts that may receive
      // manifest files with CRLF endings (e.g. checked out on Windows
      // runners). `grep` and `sed` should still extract the version.
      if (skipAll) return;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chk-'));
      fs.mkdirSync(path.join(tmp, 'checksums'), { recursive: true });
      const file = path.join(tmp, 'checksums', 'tools.sha256');
      fs.writeFileSync(
        file,
        `${sha}  morphe-desktop.jar  # v1.15.1   \r\n`,
      );
      expect(runHelper(file, 'morphe-desktop.jar', 'tools_sha_pinned_version'))
        .toBe('v1.15.1');
    });
  });
});
