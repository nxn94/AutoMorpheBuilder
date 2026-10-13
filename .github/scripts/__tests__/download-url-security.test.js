'use strict';
const { downloadWithUrl } = require('../unified-downloader');

test('passes a canonical HTTPS URL after curl options and restricts redirects', async () => {
  const spawnImpl = jest.fn(() => { throw new Error('transfer fixture stopped'); });
  await expect(downloadWithUrl('https://EXAMPLE.test:443/a/../app.apk', '/unused', 'com.test', '1.0', {
    spawnImpl, sleepImpl: async () => {},
  })).rejects.toThrow('transfer fixture stopped');
  const [command, args] = spawnImpl.mock.calls[0];
  expect(command).toBe('curl');
  expect(args.slice(-2)).toEqual(['--', 'https://example.test/app.apk']);
  expect(args.slice(args.indexOf('--proto'), args.indexOf('--proto') + 2)).toEqual(['--proto', '=https']);
  expect(args.slice(args.indexOf('--proto-redir'), args.indexOf('--proto-redir') + 2)).toEqual(['--proto-redir', '=https']);
});

test.each(['file:///etc/passwd', 'http://example.test/app.apk', '--upload-file=/etc/passwd', 'https://user:secret@example.test/app.apk'])('rejects unsafe download URL %s before spawning curl', async (url) => {
  const spawnImpl = jest.fn(() => { throw new Error('curl must not run'); });
  await expect(downloadWithUrl(url, '/unused', 'com.test', '1.0', { spawnImpl, sleepImpl: async () => {} }))
    .rejects.toThrow(/HTTPS|credentials|Invalid URL/);
  expect(spawnImpl).not.toHaveBeenCalled();
});
