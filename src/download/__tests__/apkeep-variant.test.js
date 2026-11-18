'use strict';

const {
  decodeApkeepCParam,
  listMatchingVariants,
  remainingMatchingVariants,
  variantKey,
  buildCodeOf,
  exactBuildOf,
  pickSmallestMatchingVariant,
  versionCodeOf,
  zipCentralDirNames,
  hasArchSplit,
  rankVariantsByArch,
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

  describe('versionCodeOf', () => {
    const url = (inner) => `https://download.pureapk.com/b/XAPK/abc?_fn=x&c=1|APP|${Buffer.from(inner).toString('base64')}`;

    test('reads the build number from a real listing URL', () => {
      expect(versionCodeOf(FAKE_URL_ARM64)).toBe(260727002);
    });

    test.each([
      ['missing', 'dev=x&vn=1.0'],
      ['empty', 'dev=x&vn=1.0&vc='],
      ['not a number', 'dev=x&vn=1.0&vc=12a'],
      ['negative', 'dev=x&vn=1.0&vc=-5'],
      ['zero', 'dev=x&vn=1.0&vc=0'],
      ['too big', 'dev=x&vn=1.0&vc=99999999999999999999'],
    ])('returns null when the build number is %s', (_, inner) => {
      expect(versionCodeOf(url(inner))).toBeNull();
    });

    test('returns null for a URL without a c param', () => {
      expect(versionCodeOf('https://download.pureapk.com/b/XAPK/abc')).toBeNull();
      expect(versionCodeOf(null)).toBeNull();
    });
  });
});

describe('download/apkeep-variant: every variant of a version', () => {
  test('listMatchingVariants returns all matching URLs, smallest first, other versions left out', () => {
    expect(listMatchingVariants(FAKE_BODY, '26.07.27')).toEqual([FAKE_URL_ARM64, FAKE_URL_UNIV]);
    // FAKE_URL_V7A's inner params carry no usable version name, so it never matches.
  });

  test('listMatchingVariants is empty for no match, no version, or a non-string body', () => {
    expect(listMatchingVariants(FAKE_BODY, '1.0.0')).toEqual([]);
    expect(listMatchingVariants(FAKE_BODY, '')).toEqual([]);
    expect(listMatchingVariants(null, '26.07.27')).toEqual([]);
  });

  test('pickSmallestMatchingVariant is the head of that list', () => {
    expect(pickSmallestMatchingVariant(FAKE_BODY, '26.07.27')).toBe(FAKE_URL_ARM64);
    expect(pickSmallestMatchingVariant(FAKE_BODY, '1.0.0')).toBeNull();
  });

  test('remainingMatchingVariants skips the URL(s) already tried and keeps the size order', () => {
    expect(remainingMatchingVariants(FAKE_BODY, '26.07.27', FAKE_URL_ARM64)).toEqual([FAKE_URL_UNIV]);
    expect(remainingMatchingVariants(FAKE_BODY, '26.07.27', [FAKE_URL_ARM64, FAKE_URL_UNIV])).toEqual([]);
    expect(remainingMatchingVariants(FAKE_BODY, '26.07.27', 'https://elsewhere.test/x')).toHaveLength(2);
    expect(remainingMatchingVariants(FAKE_BODY, '1.0.0', FAKE_URL_ARM64)).toEqual([]);
  });
});

describe('download/apkeep-variant: variants are identified by build, not URL', () => {
  const retoken = (u) => `${u}&tok=2`;

  test('variantKey is the build number and size; other strings identify themselves', () => {
    expect(variantKey(FAKE_URL_ARM64)).toBe('build:260727002:57302642');
    expect(variantKey(retoken(FAKE_URL_ARM64))).toBe(variantKey(FAKE_URL_ARM64));
    expect(variantKey(FAKE_URL_ARM64)).not.toBe(variantKey(FAKE_URL_UNIV));
    expect(variantKey('build:1:2')).toBe('build:1:2');
    expect(variantKey('https://elsewhere.test/x')).toBe('https://elsewhere.test/x');
    expect(variantKey(undefined)).toBeUndefined();
  });

  test('a variant already tried is skipped even when a later listing gives it a different URL', () => {
    const later = [retoken(FAKE_URL_ARM64), FAKE_URL_UNIV].join('\n');
    expect(remainingMatchingVariants(later, '26.07.27', FAKE_URL_ARM64)).toEqual([FAKE_URL_UNIV]);
    expect(remainingMatchingVariants(later, '26.07.27', variantKey(FAKE_URL_ARM64))).toEqual([FAKE_URL_UNIV]);
  });
});

describe('download/apkeep-variant: a rejected build is skipped by build number alone', () => {
  test('buildCodeOf reads variant URLs, exact-build URLs and keys', () => {
    expect(buildCodeOf(FAKE_URL_ARM64)).toBe('260727002');
    expect(buildCodeOf('https://d.apkpure.com/b/XAPK/com.app?versionCode=77')).toBe('77');
    expect(buildCodeOf('build:77')).toBe('77');
    expect(buildCodeOf('build:77:1234')).toBe('77');
    expect(buildCodeOf('https://elsewhere.test/x')).toBeNull();
    expect(buildCodeOf(undefined)).toBeNull();
  });

  test('exactBuildOf only counts a build named alone', () => {
    expect(exactBuildOf('https://d.apkpure.com/b/APK/com.app?versionCode=77')).toBe('77');
    expect(exactBuildOf('build:77')).toBe('77');
    expect(exactBuildOf('build:77:1234')).toBeNull();
    expect(exactBuildOf(FAKE_URL_ARM64)).toBeNull();
  });

  test('a variant key skips only that build and size', () => {
    expect(remainingMatchingVariants(FAKE_BODY, '26.07.27', 'build:260727002:57302642')).toEqual([FAKE_URL_UNIV]);
  });

  test('a build named alone skips every variant with that build number', () => {
    expect(remainingMatchingVariants(FAKE_BODY, '26.07.27', 'build:260727002')).toEqual([]);
    expect(remainingMatchingVariants(FAKE_BODY, '26.07.27', 'https://d.apkpure.com/b/XAPK/x?versionCode=260727002')).toEqual([]);
    expect(remainingMatchingVariants(FAKE_BODY, '26.07.27', 'build:1')).toEqual([FAKE_URL_ARM64, FAKE_URL_UNIV]);
  });
});

// A zip tail: only the central directory and end record, placed so that
// they end at totalSize (the earlier file bytes are not needed).
function zipTail(names, { totalSize = 5_000_000, comment = '', mutate } = {}) {
  const headers = names.map((n) => {
    const h = Buffer.alloc(46 + Buffer.byteLength(n));
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(Buffer.byteLength(n), 28);
    h.write(n, 46);
    return h;
  });
  const cd = Buffer.concat(headers);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(totalSize - eocd.length - cd.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  eocd.write(comment, 22);
  if (mutate) mutate(eocd);
  const buf = Buffer.concat([cd, eocd]);
  return { buf, totalSize };
}

describe('zipCentralDirNames', () => {
  test('returns the entry names', () => {
    const { buf, totalSize } = zipTail(['base.apk', 'config.arm64_v8a.apk', 'icon.png']);
    expect(zipCentralDirNames(buf, totalSize)).toEqual(['base.apk', 'config.arm64_v8a.apk', 'icon.png']);
  });

  test('finds the end record after a comment', () => {
    const { buf, totalSize } = zipTail(['a.apk'], { comment: 'hello' });
    expect(zipCentralDirNames(buf, totalSize)).toEqual(['a.apk']);
  });

  test('null when the central directory starts before the tail', () => {
    const { buf, totalSize } = zipTail(['a.apk', 'b.apk']);
    expect(zipCentralDirNames(buf.subarray(30), totalSize)).toBeNull();
  });

  test('null for ZIP64 markers', () => {
    expect(zipCentralDirNames(...Object.values(zipTail(['a.apk'], { mutate: (e) => e.writeUInt16LE(0xffff, 10) })))).toBeNull();
    expect(zipCentralDirNames(...Object.values(zipTail(['a.apk'], { mutate: (e) => e.writeUInt32LE(0xffffffff, 12) })))).toBeNull();
    expect(zipCentralDirNames(...Object.values(zipTail(['a.apk'], { mutate: (e) => e.writeUInt32LE(0xffffffff, 16) })))).toBeNull();
    const { buf, totalSize } = zipTail(['a.apk']);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    const at = buf.length - 22;
    expect(zipCentralDirNames(Buffer.concat([buf.subarray(0, at), locator, buf.subarray(at)]), totalSize + 20)).toBeNull();
  });

  test('null for garbage, short or wrong input, never throws', () => {
    expect(zipCentralDirNames(Buffer.alloc(0), 0)).toBeNull();
    expect(zipCentralDirNames(Buffer.from('not a zip at all, just text'), 1000)).toBeNull();
    expect(zipCentralDirNames(Buffer.alloc(100, 0xff), 100)).toBeNull();
    expect(zipCentralDirNames('x', 1)).toBeNull();
    expect(zipCentralDirNames(Buffer.alloc(30), NaN)).toBeNull();
  });

  test('null when an entry is cut short or the count disagrees', () => {
    const { buf, totalSize } = zipTail(['a.apk'], { mutate: (e) => e.writeUInt16LE(2, 10) });
    expect(zipCentralDirNames(buf, totalSize)).toBeNull();
    const bad = zipTail(['a.apk']);
    bad.buf.writeUInt16LE(60000, 28); // name longer than the directory
    expect(zipCentralDirNames(bad.buf, bad.totalSize)).toBeNull();
  });
});

describe('hasArchSplit', () => {
  test('matches - and _ either way, with or without split_, any case', () => {
    expect(hasArchSplit(['config.arm64_v8a.apk'], 'arm64-v8a')).toBe(true);
    expect(hasArchSplit(['split_config.arm64_v8a.apk'], 'arm64-v8a')).toBe(true);
    expect(hasArchSplit(['Config.ARM64-V8A.apk'], 'arm64_v8a')).toBe(true);
    expect(hasArchSplit(['config.armeabi_v7a.apk'], 'armeabi-v7a')).toBe(true);
  });

  test('does not match other ABIs, nested paths or unknown names', () => {
    expect(hasArchSplit(['config.armeabi_v7a.apk'], 'arm64-v8a')).toBe(false);
    expect(hasArchSplit(['foo/config.arm64_v8a.apk'], 'arm64-v8a')).toBe(false);
    expect(hasArchSplit(['config.arm64_v8a.apk.bak'], 'arm64-v8a')).toBe(false);
    expect(hasArchSplit(null, 'arm64-v8a')).toBe(false);
    expect(hasArchSplit(['config.arm64_v8a.apk'], '')).toBe(false);
  });
});

describe('rankVariantsByArch', () => {
  const urls = ['small', 'mid', 'big', 'huge'];

  test('wanted-arch variants first, both groups in original order', () => {
    const names = new Map([
      ['small', ['config.armeabi_v7a.apk']],
      ['mid', ['config.arm64_v8a.apk']],
      ['big', ['split_config.arm64_v8a.apk']],
      ['huge', ['base.apk']],
    ]);
    expect(rankVariantsByArch(urls, names, 'arm64-v8a')).toEqual(['mid', 'big', 'small', 'huge']);
  });

  test('unknown or missing names keep the order and nothing is dropped', () => {
    expect(rankVariantsByArch(urls, new Map([['small', null]]), 'arm64-v8a')).toEqual(urls);
    expect(rankVariantsByArch(urls, {}, 'arm64-v8a')).toEqual(urls);
    expect(rankVariantsByArch(urls, { huge: ['config.arm64_v8a.apk'] }, 'arm64-v8a')).toEqual(['huge', 'small', 'mid', 'big']);
  });

  test('returns a new array', () => {
    const out = rankVariantsByArch(urls, new Map(), 'arm64-v8a');
    expect(out).toEqual(urls);
    expect(out).not.toBe(urls);
  });
});
