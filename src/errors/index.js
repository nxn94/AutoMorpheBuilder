'use strict';

/**
 * Typed error hierarchy for AutoMorpheBuilder.
 *
 * All thrown errors in the build pipeline should be (or extend) an
 * AutoMorpheError so that callers can distinguish retryable upstream
 * failures (network, rate limits, missing APK) from non-retryable
 * failures (invalid configuration, signature verification, package
 * mismatch, signing failure).
 *
 * Use `formatError(error)` for stable, log-friendly rendering. The
 * workflow's `::error title=...::...` annotations can be derived from
 * the error code (see `escapeWorkflowCommand` if you need it).
 */

class AutoMorpheError extends Error {
  constructor(message, options = {}) {
    super(message, {
      cause: options.cause,
    });

    this.name = new.target.name;
    this.code = options.code ?? 'AUTOMORPHE_ERROR';
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};

    Error.captureStackTrace?.(this, new.target);
  }
}

class ConfigurationError extends AutoMorpheError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: 'CONFIGURATION_ERROR',
      retryable: false,
    });
  }
}

class ApkNotFoundError extends AutoMorpheError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: 'APK_NOT_FOUND',
      retryable: true,
    });
  }
}

class InvalidApkError extends AutoMorpheError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code ?? 'INVALID_APK',
      retryable: false,
    });
  }
}

class PackageMismatchError extends InvalidApkError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: 'PACKAGE_MISMATCH',
    });
  }
}

class VersionMismatchError extends InvalidApkError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: 'VERSION_MISMATCH',
    });
  }
}

class SplitMergeError extends AutoMorpheError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: 'SPLIT_MERGE_ERROR',
      retryable: false,
    });
  }
}

class UpstreamRateLimitError extends AutoMorpheError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: 'UPSTREAM_RATE_LIMIT',
      retryable: true,
    });
  }
}

class SigningError extends AutoMorpheError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: 'SIGNING_ERROR',
      retryable: false,
    });
  }
}

class VerificationError extends AutoMorpheError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: 'VERIFICATION_ERROR',
      retryable: false,
    });
  }
}

function formatError(error) {
  if (error instanceof AutoMorpheError) {
    const details = Object.entries(error.details)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');

    return [
      `[${error.code}] ${error.message}`,
      details ? `Details: ${details}` : null,
      `Retryable: ${error.retryable}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  return `[UNEXPECTED_ERROR] ${error.stack ?? error.message}`;
}

module.exports = {
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
};