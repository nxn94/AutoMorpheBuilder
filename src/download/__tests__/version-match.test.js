'use strict';

const { versionMatches } = require('../version-match');

describe('versionMatches', () => {
  test('exact match', () => {
    expect(versionMatches('2026.40.0', '2026.40.0')).toBe(true);
  });

  test('a label after a hyphen (Gboard)', () => {
    expect(versionMatches('18.5.4.993608717-release-arm64-v8a', '18.5.4.993608717')).toBe(true);
  });

  test('a label after a space (Discord)', () => {
    expect(versionMatches('351.11 - Stable', '351.11')).toBe(true);
  });

  test('a different version number is rejected', () => {
    expect(versionMatches('2026.41.0', '2026.40.0')).toBe(false);
    expect(versionMatches('18.5.4.99360871-release', '18.5.4.993608717')).toBe(false);
    expect(versionMatches('351.110 - Stable', '351.11')).toBe(false);
  });

  test('a longer version number is not a prefix match', () => {
    expect(versionMatches('2026.40.01', '2026.40.0')).toBe(false);
    expect(versionMatches('2026.40.0.1', '2026.40.0')).toBe(false);
    expect(versionMatches('2026.40.0_1', '2026.40.0')).toBe(false);
  });

  test.each([
    '351.11-beta2', '351.11 - Alpha', '351.11-alpha.1', '351.11-rc1',
    '351.11 RC', '351.11-dev', '351.11-canary', '351.11-preview', '351.11-nightly',
    '351.11-SNAPSHOT', '351.11-debug', '351.11-internal', '351.11-release-beta',
  ])('a pre-release label is not the stable version: %s', (actual) => {
    expect(versionMatches(actual, '351.11')).toBe(false);
  });

  test('other words in the label are fine', () => {
    expect(versionMatches('351.11 - Stable-Release', '351.11')).toBe(true);
    expect(versionMatches('1.0-developer', '1.0')).toBe(true);
  });

  test('a pre-release asked for exactly still matches', () => {
    expect(versionMatches('1.2-beta', '1.2-beta')).toBe(true);
  });

  test('empty or missing values are rejected', () => {
    expect(versionMatches('', '1.0')).toBe(false);
    expect(versionMatches('1.0', '')).toBe(false);
    expect(versionMatches('', '')).toBe(false);
    expect(versionMatches(undefined, '1.0')).toBe(false);
    expect(versionMatches('1.0', null)).toBe(false);
  });
});
