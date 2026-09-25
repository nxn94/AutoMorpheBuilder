'use strict';

/**
 * CLI argument parsing for the unified-downloader.js entrypoint.
 *
 * Pure function with no I/O. Takes the raw argv tail (excluding
 * the node executable and the script path) and returns either:
 *   - { packageId, version, outputDir } on success
 *   - { error, example? } with a human-readable message when the
 *     argv is missing required arguments or one fails validation.
 *
 * The orchestrator in unified-downloader.js#main inspects the result
 * and either starts a download or prints the usage line.
 *
 * Validation contract — modeled after Java/Android conventions so
 * the entrypoint and the test suite catch the same malformed input:
 *   package_id is "com.example.app" — must contain a ".".
 *   version is "X.Y.Z..."           — must start with \d+\.\d+.
 *   output_dir is any non-empty string. (The downloader will fail
 *                                     later if the dir isn't writable.)
 */

const PACKAGE_PATTERN = /\./;
const VERSION_PATTERN = /^\d+\.\d+/;

const USAGE_ERROR =
  'Usage: unified-downloader.js <package_id> <version> <output_dir>';
const USAGE_EXAMPLE =
  'Example: unified-downloader.js com.google.android.youtube 20.40.45 ./downloads';

/**
 * @param {string[]} argv process.argv.slice(2) by default; tests can
 *                       pass a stub.
 * @returns {{ packageId: string, version: string, outputDir: string }
 *           | { error: string, example?: string }}
 */
function parseArgs(argv) {
  const source = argv === undefined ? process.argv.slice(2) : argv;
  if (source.length < 3) {
    return { error: USAGE_ERROR, example: USAGE_EXAMPLE };
  }

  const [packageId, version, outputDir] = source;

  if (!packageId || !PACKAGE_PATTERN.test(packageId)) {
    return { error: 'Invalid package_id. Expected format: com.example.app' };
  }
  if (!version || !VERSION_PATTERN.test(version)) {
    return { error: 'Invalid version. Expected format: X.Y.Z' };
  }
  if (!outputDir) {
    return { error: 'Invalid output_dir' };
  }

  return { packageId, version, outputDir };
}

module.exports = {
  parseArgs,
  USAGE_ERROR,
  USAGE_EXAMPLE,
};
