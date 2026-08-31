'use strict';

const {
  ApkNotFoundError,
  AutoMorpheError,
  ConfigurationError,
  InvalidApkError,
  PackageMismatchError,
  SigningError,
  SplitMergeError,
  UpstreamRateLimitError,
  VerificationError,
  VersionMismatchError,
  formatError,
} = require('../index');

describe('errors', () => {
  describe('AutoMorpheError', () => {
    test('sets name, code, retryable, and details from options', () => {
      const cause = new Error('upstream failure');
      const error = new AutoMorpheError('boom', {
        code: 'CUSTOM_CODE',
        retryable: true,
        details: { app: 'youtube' },
        cause,
      });

      expect(error.name).toBe('AutoMorpheError');
      expect(error.code).toBe('CUSTOM_CODE');
      expect(error.retryable).toBe(true);
      expect(error.details).toEqual({ app: 'youtube' });
      expect(error.cause).toBe(cause);
    });

    test('defaults code to AUTOMORPHE_ERROR and retryable to false', () => {
      const error = new AutoMorpheError('boom');

      expect(error.code).toBe('AUTOMORPHE_ERROR');
      expect(error.retryable).toBe(false);
      expect(error.details).toEqual({});
      expect(error.cause).toBeUndefined();
    });

    test('is instanceof Error', () => {
      expect(new AutoMorpheError('x')).toBeInstanceOf(Error);
    });
  });

  describe('subclass codes', () => {
    test.each([
      [ConfigurationError, 'CONFIGURATION_ERROR', false],
      [ApkNotFoundError, 'APK_NOT_FOUND', true],
      [InvalidApkError, 'INVALID_APK', false],
      [SplitMergeError, 'SPLIT_MERGE_ERROR', false],
      [UpstreamRateLimitError, 'UPSTREAM_RATE_LIMIT', true],
      [SigningError, 'SIGNING_ERROR', false],
      [VerificationError, 'VERIFICATION_ERROR', false],
    ])(
      '%p.code === %p and retryable === %p',
      (Klass, expectedCode, expectedRetryable) => {
        const error = new Klass('msg');

        expect(error.code).toBe(expectedCode);
        expect(error.retryable).toBe(expectedRetryable);
      },
    );

    test('PackageMismatchError is instanceof InvalidApkError/AutoMorpheError', () => {
      const error = new PackageMismatchError('pkg mismatch');

      // NOTE: The verbatim source's spread+override in InvalidApkError
      // causes PackageMismatchError.code to resolve to 'INVALID_APK' (not
      // 'PACKAGE_MISMATCH'). This documents that bug; see PR-5a report.
      expect(error.code).toBe('INVALID_APK');
      expect(error.retryable).toBe(false);
      expect(error).toBeInstanceOf(InvalidApkError);
      expect(error).toBeInstanceOf(AutoMorpheError);
    });

    test('VersionMismatchError is instanceof InvalidApkError/AutoMorpheError', () => {
      const error = new VersionMismatchError('version mismatch');

      // See note on PackageMismatchError above: source currently collapses
      // code back to 'INVALID_APK'.
      expect(error.code).toBe('INVALID_APK');
      expect(error.retryable).toBe(false);
      expect(error).toBeInstanceOf(InvalidApkError);
      expect(error).toBeInstanceOf(AutoMorpheError);
    });
  });

  describe('subclass name field', () => {
    test.each([
      ConfigurationError,
      ApkNotFoundError,
      InvalidApkError,
      PackageMismatchError,
      VersionMismatchError,
      SplitMergeError,
      UpstreamRateLimitError,
      SigningError,
      VerificationError,
    ])('%p.name === %p.name', (Klass) => {
      const error = new Klass('msg');

      expect(error.name).toBe(Klass.name);
    });
  });

  describe('subclass options merging', () => {
    test('caller-supplied details are preserved alongside defaults', () => {
      const error = new ConfigurationError('bad config', {
        details: { field: 'preferred_arch' },
      });

      expect(error.code).toBe('CONFIGURATION_ERROR');
      expect(error.retryable).toBe(false);
      expect(error.details).toEqual({ field: 'preferred_arch' });
    });

    test('subclass retryable cannot be overridden by options.retryable', () => {
      const error = new ApkNotFoundError('missing', { retryable: false });

      expect(error.retryable).toBe(true);
    });

    test('subclass code cannot be overridden by options.code', () => {
      const error = new SigningError('keystore', { code: 'OVERRIDE_ME' });

      expect(error.code).toBe('SIGNING_ERROR');
    });
  });

  describe('formatError', () => {
    test('renders AutoMorpheError with code, message, and retryable', () => {
      const error = new ApkNotFoundError('not in mirror', {
        details: { app: 'youtube' },
      });
      const rendered = formatError(error);

      expect(rendered).toContain('[APK_NOT_FOUND] not in mirror');
      expect(rendered).toContain('Retryable: true');
      expect(rendered.split('\n')).toHaveLength(3);
    });

    test('renders details as comma-separated key=value pairs', () => {
      const error = new ConfigurationError('bad', {
        details: { app: 'youtube', arch: 'arm64-v8a' },
      });
      const rendered = formatError(error);

      expect(rendered).toContain('Details: app=youtube, arch=arm64-v8a');
    });

    test('omits details line when details object is empty', () => {
      const error = new SigningError('keystore missing');

      expect(formatError(error)).toBe(
        '[SIGNING_ERROR] keystore missing\nRetryable: false',
      );
    });

    test('falls back to UNEXPECTED_ERROR for plain Error', () => {
      const error = new Error('boom');
      const rendered = formatError(error);

      expect(rendered.startsWith('[UNEXPECTED_ERROR] ')).toBe(true);
      expect(rendered).toContain('boom');
    });
  });
});