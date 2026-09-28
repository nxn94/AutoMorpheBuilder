'use strict';

const {
  decodeApkeepCParam,
  pickSmallestMatchingVariant,
} = require('../apkeep-variant');

// Same fixture URLs used in
// .github/scripts/__tests__/fallback-chain.test.js — the protobuf
// body the real APKPure endpoint returns for sofascore@26.07.27
// has 3 XAPK URLs (universal, arm64-v8a, armeabi-v7a) at three
// different declared sizes, plus one noise URL at a different
// version that must be filtered out.
const FAKE_URL_UNIV = 'https://download.pureapk.com/b/XAPK/Y29tLnNvZmFzY29yZS5yZXN1bHRzXzI2MDcyNzAwMl9BQT?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9OTMwNDQwNjImdm49MjYuMDcuMjcmdmM9MjYwNzI3MDAy';
const FAKE_URL_ARM64 = 'https://download.pureapk.com/b/XAPK/Y29tLnNvZmFzY29yZS5yZXN1bHRzXzI2MDcyNzAwMl9BQT?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9NTczMDI2NDImdm49MjYuMDcuMjcmdmM9MjYwNzI3MDAy';
const FAKE_URL_V7A = 'https://download.pureapk.com/b/XAPK/Y29tLnNvZmFzY29yZS5yZXN1bHRzXzI2MDcyNzAwMl9BQT?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9ODkyMTg2NDcmdm49MjYwNzI3MDAy';
const FAKE_URL_OTHER = 'https://download.pureapk.com/b/XAPK/OTHER?_fn=other&as=other&c=1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9MTAwMCZ2bj05OS45OS45OSZ2Yz05OTk5OTk5OTk=';

const FAKE_BODY = [
  'noise before',
  FAKE_URL_UNIV,
  FAKE_URL_ARM64,
  FAKE_URL_V7A,
  FAKE_URL_OTHER,
  'noise after',
].join('\n');

describe('download/apkeep-variant', () => {
  describe('decodeApkeepCParam', () => {
    test('decodes the pipe-separated base64-encoded inner params', () => {
      // The `c` param from FAKE_URL_ARM64: c=1|SPORTS|<base64>
      // base64 decode = "dev=Sofascore&t=xxapk&s=57302642&vn=26.07.27&vc=260727002"
      const inner = decodeApkeepCParam('1|SPORTS|ZGV2PVNvZmFzY29yZSZ0PXh4YXBrJnM9NTczMDI2NDImdm49MjYuMDcuMjcmdmM9MjYwNzI3MDAy');
      expect(inner).toEqual({
        dev: 'Sofascore',
        t: 'xxapk',
        s: '57302642',
        vn: '26.07.27',
        vc: '260727002',
      });
    });

    test('returns null for an empty string', () => {
      expect(decodeApkeepCParam('')).toBeNull();
    });

    test('returns null for a string with fewer than 3 pipe segments', () => {
      expect(decodeApkeepCParam('1|SPORTS')).toBeNull();
    });

    test('returns null for non-string input', () => {
      expect(decodeApkeepCParam(null)).toBeNull();
      expect(decodeApkeepCParam(undefined)).toBeNull();
      expect(decodeApkeepCParam(42)).toBeNull();
    });
  });

  describe('pickSmallestMatchingVariant', () => {
    test('picks the smallest arm64-v8a variant from a multi-URL body', () => {
      // arm64-v8a is at 57_302_642 bytes, v7a at 89_218_647,
      // universal at 93_044_062 — arm64 wins by 30+ MB.
      const result = pickSmallestMatchingVariant(FAKE_BODY, '26.07.27');
      expect(result).toBe(FAKE_URL_ARM64);
    });

    test('filters out URLs that match the wrong version', () => {
      // FAKE_URL_OTHER has vn=99.99.99, so it must not be picked.
      const result = pickSmallestMatchingVariant(FAKE_BODY, '99.99.99');
      // Only FAKE_URL_OTHER matches 99.99.99 — pick its (single) URL.
      expect(result).toBe(FAKE_URL_OTHER);
    });

    test('returns null when no URL in the body matches the requested version', () => {
      const result = pickSmallestMatchingVariant(FAKE_BODY, '0.0.0');
      expect(result).toBeNull();
    });

    test('returns null for an empty body', () => {
      expect(pickSmallestMatchingVariant('', '1.0.0')).toBeNull();
    });

    test('returns null for non-string body', () => {
      expect(pickSmallestMatchingVariant(null, '1.0.0')).toBeNull();
      expect(pickSmallestMatchingVariant(undefined, '1.0.0')).toBeNull();
    });

    test('returns null when called with an empty version', () => {
      expect(pickSmallestMatchingVariant(FAKE_BODY, '')).toBeNull();
      expect(pickSmallestMatchingVariant(FAKE_BODY, null)).toBeNull();
    });

    test('tolerates trailing non-printable framing bytes (real protobuf shape)', () => {
      // Real protobuf responses include non-printable framing
      // bytes immediately after the URL. Pin that the regex /
      // stripper combination keeps the URL addressable.
      const bodyWithFraming = `${FAKE_URL_ARM64}\xd2\x01\xf8\x01\x0a`;
      const result = pickSmallestMatchingVariant(bodyWithFraming, '26.07.27');
      expect(result).toBe(FAKE_URL_ARM64);
    });

    test('matches the existing fallback-chain test fixture outcome', () => {
      // Regression pin: pickSmallestMatchingVariant with the same
      // body the live fallback-chain test uses must return the
      // same URL. If either side ever drifts, the variant that
      // getAKeep'd be downloaded would change without any test
      // failing on its own.
      const body = [
        'noise before',
        FAKE_URL_UNIV,
        FAKE_URL_ARM64,
        FAKE_URL_V7A,
        FAKE_URL_OTHER,
        'noise after',
      ].join('\n');
      expect(pickSmallestMatchingVariant(body, '26.07.27')).toBe(FAKE_URL_ARM64);
    });
  });
});
