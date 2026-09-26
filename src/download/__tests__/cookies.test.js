'use strict';

const { collectCookies } = require('../cookies');

function makeResponse(setCookieHeaders) {
  // Minimal Response shape: only `headers.getSetCookie` is read by
  // collectCookies, so that's the only method we stub.
  return {
    headers: {
      getSetCookie: () => setCookieHeaders,
    },
  };
}

describe('download/cookies', () => {
  test('returns a copy of the existing jar when no Set-Cookie headers are present', () => {
    const response = makeResponse([]);
    const existing = { auth: 'secret' };
    const jar = collectCookies(response, existing);
    expect(jar).toEqual({ auth: 'secret' });
    // Same content, distinct object — mutation safety.
    expect(jar).not.toBe(existing);
  });

  test('works with a missing getSetCookie method (older fetch impls)', () => {
    const response = { headers: {} };
    const jar = collectCookies(response, { a: '1' });
    expect(jar).toEqual({ a: '1' });
  });

  test('merges a single Set-Cookie header into an empty jar', () => {
    const response = makeResponse(['session=abc123; Path=/; HttpOnly']);
    const jar = collectCookies(response, {});
    expect(jar).toEqual({ session: 'abc123' });
  });

  test('merges new cookies onto an existing jar without losing entries', () => {
    const response = makeResponse(['session=abc123; Path=/; HttpOnly']);
    const jar = collectCookies(response, { auth: 'token' });
    expect(jar).toEqual({ auth: 'token', session: 'abc123' });
  });

  test('newer Set-Cookie overwrites an existing same-named key', () => {
    const response = makeResponse(['session=newvalue']);
    const jar = collectCookies(response, { session: 'oldvalue', other: 'kept' });
    expect(jar).toEqual({ session: 'newvalue', other: 'kept' });
  });

  test('handles multiple cookies in one Set-Cookie array', () => {
    const response = makeResponse([
      'a=1; Path=/',
      'b=2; Domain=example.com',
      'c=3; Secure; SameSite=Lax',
    ]);
    const jar = collectCookies(response, {});
    expect(jar).toEqual({ a: '1', b: '2', c: '3' });
  });

  test('skips malformed Set-Cookie entries (no `=` at all)', () => {
    const response = makeResponse(['no-equals-sign', 'good=ok']);
    const jar = collectCookies(response, {});
    expect(jar).toEqual({ good: 'ok' });
  });

  test('skips Set-Cookie entries where `=` is at index 0', () => {
    // '=value' is malformed; we require at least one char before `=`.
    const response = makeResponse(['=value', 'good=ok']);
    const jar = collectCookies(response, {});
    expect(jar).toEqual({ good: 'ok' });
  });

  test('preserves values that contain `=` (only the first `=` splits)', () => {
    // The cookie value `abc=def==` only splits on the first `=`.
    const response = makeResponse(['token=abc=def==']);
    const jar = collectCookies(response, {});
    expect(jar).toEqual({ token: 'abc=def==' });
  });

  test('does not mutate the input jar', () => {
    const existing = { a: '1' };
    collectCookies(makeResponse(['b=2']), existing);
    expect(existing).toEqual({ a: '1' });
  });
});
