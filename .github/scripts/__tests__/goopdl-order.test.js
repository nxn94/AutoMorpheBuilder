'use strict';
jest.mock('../goopdl-downloader', () => ({ downloadWithGoopdl: jest.fn() }));
jest.mock('../../../src/download/cache', () => ({
  ...jest.requireActual('../../../src/download/cache'),
  getCachedUrl: jest.fn(() => { throw new Error('entered existing fallback chain'); }),
}));
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { download } = require('../unified-downloader');
const { downloadWithGoopdl } = require('../goopdl-downloader');
const { getCachedUrl } = require('../../../src/download/cache');
let dir;
beforeEach(() => { jest.clearAllMocks(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goopdl-order-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('goopdl is attempted before even the existing URL cache', async () => {
  const result = { success: true, source: 'goopdl', file: '/fixture.apkm' };
  downloadWithGoopdl.mockResolvedValue(result);
  await expect(download('com.test', '1.2', dir)).resolves.toEqual(result);
  expect(downloadWithGoopdl).toHaveBeenCalledWith('com.test', '1.2', dir, expect.any(Object));
  expect(getCachedUrl).not.toHaveBeenCalled();
});

test('goopdl failure resumes the original fallback chain', async () => {
  downloadWithGoopdl.mockRejectedValue(new Error('Google Play unavailable'));
  await expect(download('com.test', '1.2', dir)).rejects.toThrow('entered existing fallback chain');
  expect(getCachedUrl).toHaveBeenCalled();
});
