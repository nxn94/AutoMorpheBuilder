'use strict';

const { supportedVersions, compareVersionsDesc } = require('../build-plan');
const { generatedVersions } = require('../patch-metadata');

const sorted = (versions) => [...versions].sort(compareVersionsDesc);

describe('compareVersionsDesc', () => {
  test('a plain version outranks a labelled one with the same core', () => {
    expect(sorted(['1.2.3-beta', '1.2.3', '1.2.3-rc.1'])).toEqual(['1.2.3', '1.2.3-rc.1', '1.2.3-beta']);
  });

  test('the numeric core still decides before any label', () => {
    expect(sorted(['1.2.3', '1.2.4-beta', '1.10.0-alpha', '1.9.9'])).toEqual(['1.10.0-alpha', '1.9.9', '1.2.4-beta', '1.2.3']);
  });

  test('labelled versions of one core compare their labels numerically', () => {
    expect(sorted(['12.39.0-prod.02', '12.39.0-prod.10', '12.39.0-prod.01']))
      .toEqual(['12.39.0-prod.10', '12.39.0-prod.02', '12.39.0-prod.01']);
  });

  test('a longer core outranks its own prefix, as before', () => {
    expect(sorted(['24.3', '24.3.1', '24.3.0'])).toEqual(['24.3.1', '24.3.0', '24.3']);
  });

  test('build metadata is not treated as a prerelease', () => {
    expect(sorted(['1.2.3', '1.2.3+5', '1.2.3-beta'])).toEqual(['1.2.3+5', '1.2.3', '1.2.3-beta']);
  });
});

test('supportedVersions picks the stable build first when a prerelease shares its core', () => {
  expect(supportedVersions('1.2.3-beta (2 patches)\n1.2.3 (3 patches)\n1.2.2')).toEqual(['1.2.3', '1.2.3-beta', '1.2.2']);
});

test('supportedVersions keeps legitimate label-only versions in numeric order', () => {
  expect(supportedVersions('12.39.0-prod.01\n12.40.1-prod.01')).toEqual(['12.40.1-prod.01', '12.39.0-prod.01']);
});

test('generatedVersions ranks the plain version above a prerelease of the same core', () => {
  const target = (version) => ({ version, isExperimental: false });
  const list = { patches: [{ name: 'P', use: true, compatiblePackages: [{ packageName: 'com.example.app', targets: [target('1.2.3-beta'), target('1.2.3'), target('1.2.2')] }] }] };
  expect(generatedVersions(list, 'com.example.app', {})).toEqual(['1.2.3', '1.2.3-beta', '1.2.2']);
});
