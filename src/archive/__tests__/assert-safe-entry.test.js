'use strict';

const { assertSafeArchiveEntry } = require('../assert-safe-entry');

describe('archive/assert-safe-entry', () => {
  describe('safe entries', () => {
    test.each([
      ['splits/base.apk'],
      ['config.arm64_v8a.apk'],
      ['META-INF/CERT.RSA'],
      ['AndroidManifest.xml'],
      ['classes.dex'],
      ['lib/arm64-v8a/libfoo.so'],
      ['a/b/c/d/e.txt'],
      ['.hidden'],
    ])('accepts %p', (entry) => {
      expect(() => assertSafeArchiveEntry(entry)).not.toThrow();
    });

    test('returns the POSIX-normalized path for inputs that need normalization', () => {
      expect(assertSafeArchiveEntry('a/./b/c')).toBe('a/b/c');
      expect(assertSafeArchiveEntry('a//b/c')).toBe('a/b/c');
      expect(assertSafeArchiveEntry('a/b/./c/')).toBe('a/b/c/');
    });
  });

  describe('unsafe entries', () => {
    test.each([
      '../secret',
      '../../etc/passwd',
      'safe/../../secret',
      'a/b/../../../etc/passwd',
    ])('throws on path traversal %p', (entry) => {
      expect(() => assertSafeArchiveEntry(entry)).toThrow(/path traversal/);
    });

    test('throws on bare ..', () => {
      expect(() => assertSafeArchiveEntry('..')).toThrow(/path traversal/);
    });

    test.each([
      '/etc/passwd',
      '/absolute/path/to/file',
      '/',
    ])('throws on POSIX absolute path %p', (entry) => {
      expect(() => assertSafeArchiveEntry(entry)).toThrow(/absolute path/);
    });

    test.each(['', null, undefined, 0, 123, {}, [], true])(
      'throws on non-string or empty input %p',
      (value) => {
        expect(() => assertSafeArchiveEntry(value)).toThrow(
          /non-empty string/,
        );
      },
    );
  });

  describe('platform-specific behavior', () => {
    // NOTE: Windows-style backslash separators are intentionally NOT a
    // traversal signal on POSIX — `..\secret` is treated as a single
    // filename segment, not a parent-dir reference. The build runners
    // are Linux (see docs/architecture.md); Windows is out of scope.
    test('backslash-separated path is not treated as traversal', () => {
      expect(() => assertSafeArchiveEntry('..\\secret')).not.toThrow();
    });
  });
});