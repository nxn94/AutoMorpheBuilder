'use strict';

const { createCandidate, SUPPORTED_FORMATS } = require('../candidate');

describe('apk/candidate', () => {
  describe('createCandidate', () => {
    test('returns a frozen candidate with minimal required fields', () => {
      const candidate = createCandidate({
        source: 'apkmirror',
        url: 'https://example.com/foo.apk',
        packageName: 'com.example.app',
      });

      expect(candidate).toEqual({
        source: 'apkmirror',
        url: 'https://example.com/foo.apk',
        packageName: 'com.example.app',
        versionName: null,
        versionCode: null,
        architecture: 'unknown',
        dpi: 'unknown',
        format: 'unknown',
        sizeBytes: null,
        variantLabel: null,
        metadata: {},
      });
      expect(Object.isFrozen(candidate)).toBe(true);
    });

    test('preserves explicit overrides for all optional fields', () => {
      const metadata = { mirrorVariantId: 42 };
      const candidate = createCandidate({
        source: 'apkeep',
        url: 'https://example.com/x.apk',
        packageName: 'com.example.app',
        versionName: '1.2.3',
        versionCode: 1230,
        architecture: 'arm64-v8a',
        dpi: '480',
        format: 'apk',
        sizeBytes: 12_345_678,
        variantLabel: 'nodpi',
        metadata,
      });

      expect(candidate.versionName).toBe('1.2.3');
      expect(candidate.versionCode).toBe(1230);
      expect(candidate.architecture).toBe('arm64-v8a');
      expect(candidate.dpi).toBe('480');
      expect(candidate.format).toBe('apk');
      expect(candidate.sizeBytes).toBe(12_345_678);
      expect(candidate.variantLabel).toBe('nodpi');
      expect(candidate.metadata).toBe(metadata);
      expect(Object.isFrozen(candidate)).toBe(true);
    });

    test.each([
      ['source'],
      ['url'],
      ['packageName'],
    ])('throws TypeError when %s is missing', (field) => {
      const base = {
        source: 'apkmirror',
        url: 'https://example.com/foo.apk',
        packageName: 'com.example.app',
      };
      const broken = { ...base };
      delete broken[field];

      expect(() => createCandidate(broken)).toThrow(TypeError);
    });

    test.each([
      ['source'],
      ['url'],
      ['packageName'],
    ])('throws TypeError when %s is empty string', (field) => {
      const input = {
        source: 'apkmirror',
        url: 'https://example.com/foo.apk',
        packageName: 'com.example.app',
        [field]: '',
      };

      expect(() => createCandidate(input)).toThrow(TypeError);
    });

    test('throws TypeError on unsupported format', () => {
      expect(() =>
        createCandidate({
          source: 'apkmirror',
          url: 'https://example.com/foo.exe',
          packageName: 'com.example.app',
          format: 'exe',
        }),
      ).toThrow(TypeError);
    });

    test("'unknown' is accepted as a format (default sentinel)", () => {
      const candidate = createCandidate({
        source: 'apkmirror',
        url: 'https://example.com/foo',
        packageName: 'com.example.app',
      });

      expect(candidate.format).toBe('unknown');
    });

    test.each(['apk', 'xapk', 'apkm', 'apks'])(
      'accepts SUPPORTED_FORMATS entry %p',
      (format) => {
        expect(SUPPORTED_FORMATS.has(format)).toBe(true);

        const candidate = createCandidate({
          source: 'apkmirror',
          url: 'https://example.com/foo',
          packageName: 'com.example.app',
          format,
        });

        expect(candidate.format).toBe(format);
      },
    );
  });
});