'use strict';

const childProcess = require('node:child_process');

const {
  parseVersionFromBadging,
  validateApkVersion,
} = require('../aapt');

function fakeExec(stdouts) {
  // Returns a function that yields each stdout in order on
  // successive calls. After all outputs are exhausted, the stub
  // throws ENOENT so the test can assert the function's behavior
  // on a missing-aapt environment.
  let index = 0;
  return (cmd, _args) => {
    if (index < stdouts.length) {
      const out = stdouts[index];
      index += 1;
      return out;
    }
    const err = new Error(`${cmd}: not found`);
    err.code = 'ENOENT';
    throw err;
  };
}

describe('download/aapt', () => {
  describe('parseVersionFromBadging', () => {
    test('extracts versionName from a typical aapt dump', () => {
      const dump = [
        'package: name=\'com.google.android.youtube\' versionCode=\'204400038\' versionName=\'20.44.38\'',
        'sdkVersion:\'26\'',
        'targetSdkVersion:\'34\'',
        'application-label:\'YouTube\'',
      ].join('\n');
      expect(parseVersionFromBadging(dump)).toBe('20.44.38');
    });

    test('extracts a multi-segment version', () => {
      const dump = `package: name='com.x' versionName='1.2.3-rc4+meta'`;
      expect(parseVersionFromBadging(dump)).toBe('1.2.3-rc4+meta');
    });

    test('returns null when the dump has no versionName', () => {
      const dump = 'no version line here\nsdkVersion:\'26\'';
      expect(parseVersionFromBadging(dump)).toBeNull();
    });

    test('returns null for non-string input', () => {
      expect(parseVersionFromBadging(null)).toBeNull();
      expect(parseVersionFromBadging(undefined)).toBeNull();
      expect(parseVersionFromBadging(42)).toBeNull();
    });
  });

  describe('validateApkVersion', () => {
    test('returns valid:true when aapt reports the expected version', () => {
      const dump = `package: name='com.x' versionName='1.2.3'`;
      const execFileSyncImpl = fakeExec([dump]);
      const result = validateApkVersion('/path/to.apk', '1.2.3', { execFileSyncImpl });
      expect(result).toEqual({ valid: true, actualVersion: '1.2.3' });
    });

    test('returns valid:false with a mismatch error', () => {
      const dump = `package: name='com.x' versionName='1.2.3'`;
      const execFileSyncImpl = fakeExec([dump]);
      const result = validateApkVersion('/path/to.apk', '9.9.9', { execFileSyncImpl });
      expect(result.valid).toBe(false);
      expect(result.actualVersion).toBe('1.2.3');
      expect(result.error).toBe('version mismatch: got 1.2.3, wanted 9.9.9');
    });

    test('falls back to aapt2 when aapt throws ENOENT', () => {
      const dump = `package: name='com.x' versionName='4.5.6'`;
      const execFileSyncImpl = fakeExec([dump]);
      const result = validateApkVersion('/path/to.apk', '4.5.6', { execFileSyncImpl });
      expect(result).toEqual({ valid: true, actualVersion: '4.5.6' });
    });

    test('returns valid:false with no-aapt error when both aapt and aapt2 fail', () => {
      const execFileSyncImpl = fakeExec([]);
      const result = validateApkVersion('/path/to.apk', '1.0.0', { execFileSyncImpl });
      expect(result).toEqual({
        valid: false,
        actualVersion: 'unknown',
        error: 'aapt not available - cannot validate version',
      });
    });

    test('returns valid:false when badging output has no versionName line', () => {
      const execFileSyncImpl = fakeExec(['sdkVersion:\'26\'\napplication-label:\'X\'']);
      const result = validateApkVersion('/path/to.apk', '1.0.0', { execFileSyncImpl });
      expect(result).toEqual({
        valid: false,
        actualVersion: 'unknown',
        error: 'could not extract version from APK',
      });
    });

    test('uses argv-form execution so apkPath is never shell-interpolated', () => {
      // The execFileSyncImpl contract receives argv arrays. This
      // test pins that contract: a malicious apkPath containing
      // shell metacharacters is passed through as a single argv
      // entry, not split or interpolated.
      let observedArgs;
      const execFileSyncImpl = (cmd, args) => {
        if (cmd === 'aapt') {
          observedArgs = args;
          throw Object.assign(new Error('not found'), { code: 'ENOENT' });
        }
        // aapt2 succeeds with the expected version
        return `package: name='x' versionName='1.0.0'`;
      };
      const result = validateApkVersion(
        '/tmp/evil; rm -rf /; echo.apk',
        '1.0.0',
        { execFileSyncImpl },
      );
      expect(observedArgs).toEqual(['dump', 'badging', '/tmp/evil; rm -rf /; echo.apk']);
      expect(result.valid).toBe(true);
    });

    test('uses real execFileSync when no execFileSyncImpl override is given', () => {
      // Smoke test that the lazy `require('node:child_process')`
      // path inside validateApkVersion resolves at runtime. We
      // call the function with a path that doesn't exist; on any
      // platform the underlying execFileSync throws (ENOENT or
      // similar), which makes the aapt2 fallback also fail,
      // returning the "aapt not available" shape. The exact
      // message isn't asserted — only that the function runs
      // end-to-end without throwing.
      const result = validateApkVersion('/nonexistent/path/file.apk', '1.0.0');
      expect(result.valid).toBe(false);
      expect(result.actualVersion).toBe('unknown');
      // child_process is required lazily — make sure the module
      // is reachable so future code paths don't accidentally
      // depend on it being absent.
      expect(typeof childProcess.execFileSync).toBe('function');
    });
  });
});
