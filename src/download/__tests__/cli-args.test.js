'use strict';

const {
  parseArgs,
  USAGE_ERROR,
  USAGE_EXAMPLE,
} = require('../cli-args');

describe('download/cli-args', () => {
  test('returns parsed args on valid input', () => {
    const result = parseArgs(['com.google.android.youtube', '20.44.38', './downloads']);
    expect(result).toEqual({
      packageId: 'com.google.android.youtube',
      version: '20.44.38',
      outputDir: './downloads',
    });
  });

  test('returns usage error when fewer than 3 args are provided', () => {
    expect(parseArgs(['com.x', '1.0.0'])).toEqual({
      error: USAGE_ERROR,
      example: USAGE_EXAMPLE,
    });
    expect(parseArgs([])).toMatchObject({ error: USAGE_ERROR });
  });

  test('falls back to process.argv when called with no argument', () => {
    // parseArgs() with no argument defaults to process.argv.slice(2),
    // which under Jest is Jest's own CLI flags. The test must stub
    // process.argv explicitly so the default-branch contract is
    // exercised deterministically — without the stub, the assertion
    // below would either pass or fail depending on how Jest itself
    // was launched (e.g. `npx jest foo.test.js` has 2 trailing args,
    // which trips the "fewer than 3 args" usage error).
    jest.replaceProperty(process, 'argv', ['node', 'script']);

    // Empty argv → usage error (the default branch reached the
    // fallback slice, found nothing, returned the error envelope).
    expect(parseArgs()).toMatchObject({ error: USAGE_ERROR });

    // Three valid args → parsed normally through the same fallback
    // path. This pins that the default-branch code path matches the
    // explicit-argv path on real CLI input shape.
    jest.replaceProperty(process, 'argv',
      ['node', 'script', 'com.x', '1.0.0', './downloads']);
    expect(parseArgs()).toEqual({
      packageId: 'com.x',
      version: '1.0.0',
      outputDir: './downloads',
    });
  });

  test('rejects a package_id without a dot', () => {
    expect(parseArgs(['flatname', '1.0.0', './out'])).toEqual({
      error: 'Invalid package_id. Expected format: com.example.app',
    });
  });

  test('rejects an empty package_id', () => {
    expect(parseArgs(['', '1.0.0', './out'])).toEqual({
      error: 'Invalid package_id. Expected format: com.example.app',
    });
  });

  test('rejects a version that does not start with X.Y', () => {
    expect(parseArgs(['com.x', '1', './out'])).toEqual({
      error: 'Invalid version. Expected format: X.Y.Z',
    });
    expect(parseArgs(['com.x', 'v1.0.0', './out'])).toEqual({
      error: 'Invalid version. Expected format: X.Y.Z',
    });
    expect(parseArgs(['com.x', '', './out'])).toEqual({
      error: 'Invalid version. Expected format: X.Y.Z',
    });
  });

  test('rejects an empty output_dir', () => {
    expect(parseArgs(['com.x', '1.0.0', ''])).toEqual({
      error: 'Invalid output_dir',
    });
  });

  test('accepts multi-segment versions (e.g., "20.44.38-rc0")', () => {
    const result = parseArgs(['com.x', '20.44.38-rc0', './out']);
    expect(result.version).toBe('20.44.38-rc0');
  });

  test('accepts a 2-segment major version like "1.0"', () => {
    // The validator only enforces \d+\.\d+ — three-segment versions
    // match too, but the looser shape is intentionally allowed for
    // forward-compatibility with non-semver apps.
    const result = parseArgs(['com.x', '1.0', './out']);
    expect(result.version).toBe('1.0');
  });
});
