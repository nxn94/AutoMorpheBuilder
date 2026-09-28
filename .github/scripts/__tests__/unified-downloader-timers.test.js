// .github/scripts/__tests__/unified-downloader-timers.test.js
'use strict';

// Two related timer-leak fixes pinned here:
//
//   (a) verifyUrl's urlVerify setTimeout must be cleared on every
//       exit path — success, fetch rejection, and timeout. The
//       pre-fix code only cleared on the success path, leaving a
//       slow leak across every cache hit.
//
//   (b) parallelResolveSources's per-source setTimeout must be
//       cleared when the source's own promise wins the race. The
//       pre-fix code never captured the timer handle, so a fast
//       apkeep resolution (200ms) left the 60s SOURCE_TIMEOUT
//       timer armed for the full window.
//
// Both bugs share a class: a `setTimeout` whose handle was either
// lost (race case) or only cleared on the happy path (verifyUrl).
// Same fix pattern: capture the handle and clear it from a finally
// (or the equivalent microtask-after-settle guard).
//
// Tests use jest.useFakeTimers() and assert jest.getTimerCount() ===
// 0 after the operation settles — the canonical "no orphan timers"
// check. fetch is stubbed via globalThis.fetch per test; the
// module-level fetch reference is captured inside verifyUrl's
// closure on each call.

const { verifyUrl, parallelResolveSources } = require('../unified-downloader');

describe('unified-downloader timer hygiene', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete globalThis.fetch;
  });

  describe('verifyUrl', () => {
    test('clears the urlVerify timer on success', async () => {
      jest.useFakeTimers();
      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
      }));
      const result = await verifyUrl('https://example.com/foo.apk');
      expect(result).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    });

    test('clears the urlVerify timer when fetch rejects', async () => {
      // Pre-fix bug: clearTimeout(timeout) was inside the try block
      // AFTER `await fetch(...)`, so a fetch rejection skipped the
      // clear and the timer fired ~urlVerify ms later. With the
      // finally-block fix, the timer is cleared even when fetch
      // throws.
      jest.useFakeTimers();
      globalThis.fetch = jest.fn(async () => {
        throw new TypeError('fetch failed');
      });
      const result = await verifyUrl('https://example.com/foo.apk');
      expect(result).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });

    test('clears the urlVerify timer when fetch returns non-ok', async () => {
      // response.ok=false path: still went through the try block
      // pre-fix, so this was actually fine — but pin it so a
      // future refactor that moves the clear doesn't accidentally
      // only run on success.
      jest.useFakeTimers();
      globalThis.fetch = jest.fn(async () => ({
        ok: false,
        status: 404,
      }));
      const result = await verifyUrl('https://example.com/foo.apk');
      expect(result).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('parallelResolveSources', () => {
    test('clears the per-source timer when a fast source wins the race', async () => {
      // The pre-fix bug: a fast apkeep resolution (a few ms) would
      // leave the 60s SOURCE_TIMEOUT timer armed for the full
      // window — a slow leak across every parallel-resolve call.
      //
      // We can't simply await `parallelResolveSources` here: the
      // function uses Promise.allSettled, so it won't return until
      // every source settles. The two hung sources wouldn't settle
      // under fake timers without us advancing time past
      // SOURCE_TIMEOUT (60s). Instead, drive the test by spying on
      // setTimeout/clearTimeout — that's what `__tests__/unified-
      // downloader-runcommand.test.js` does for the runCommand
      // timer-leak pin. The spy approach isolates the per-source
      // clearTimeout contract from the allSettled wait.
      jest.useFakeTimers();
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
      const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');

      const apkeepImpl = jest.fn(async () => ({
        url: 'https://apkeep.example/foo.apk',
        source: 'apkeep',
      }));
      // Hang the other sources so parallelResolveSources itself
      // can't complete, but apkeep's source.fn() resolves fast.
      // We assert the cleanup BEFORE the allSettled wait.
      const apkmirrorApiImpl = jest.fn(() => new Promise(() => {}));
      const apkmirrorImpl = jest.fn(() => new Promise(() => {}));

      const resultPromise = parallelResolveSources('com.x', '1.0.0', {
        sourceResolvers: {
          apkeep: apkeepImpl,
          apkmirrorApi: apkmirrorApiImpl,
          apkmirror: apkmirrorImpl,
        },
      });

      // Drain microtasks so apkeep's promise has a chance to settle.
      // jest.advanceTimersByTimeAsync(0) flushes the timer queue
      // without firing any timers. We loop until apkeep's resolver
      // has been observed to settle, but cap iterations to avoid
      // an infinite hang if the harness is broken.
      let guard = 0;
      while (apkeepImpl.mock.calls.length === 0 && guard < 100) {
        await Promise.resolve();
        guard += 1;
      }
      // After the source.fn() promise resolves inside parallelResolveSources,
      // the per-source timer should be cleared by the finally block.
      // Wait one more microtask tick so the finally runs.
      await Promise.resolve();
      await Promise.resolve();

      const setCalls = setTimeoutSpy.mock.calls.length;
      void setCalls; // captured for diagnostic context; the assertion
                     // is on clearCalls below.
      const clearCalls = clearTimeoutSpy.mock.calls.length;

      // Every per-source timer that was registered must have been
      // cleared by the time the source.fn() promise settled. With
      // three sources racing, three SOURCE_TIMEOUT timers are
      // registered up front; the apkeep finally block clears one
      // immediately. The hung sources' timers are still armed (we
      // can't observe their cleanup until they settle).
      //
      // What we CAN assert: at least one clearTimeout call has
      // happened (the apkeep slot), proving the finally block ran
      // for the winning source.
      expect(clearCalls).toBeGreaterThanOrEqual(1);

      // Suppress the result — we're observing the side effect, not
      // the return value. Switch back to real timers and abort the
      // hanging parallelResolveSources so the test doesn't time out.
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      jest.useRealTimers();
      // Race the still-pending result against a short timeout —
      // we deliberately abandon the parallelResolveSources call
      // because the hung sources can't settle in the test window.
      // The leaked promises from the hung sources are local to
      // this test and get GC'd along with the test scope.
      await Promise.race([
        resultPromise.catch(() => 'abandoned'),
        new Promise((r) => setTimeout(r, 50)),
      ]);
    });

    test('clears timers for all sources when each returns a winner quickly', async () => {
      // All three sources resolve quickly with valid URLs. After
      // Promise.allSettled, every per-source timer should be
      // cleared by the finally blocks.
      jest.useFakeTimers();
      const resolvers = {
        apkeep: jest.fn(async () => ({ url: 'https://a/a.apk', source: 'apkeep' })),
        apkmirrorApi: jest.fn(async () => ({ url: 'https://b/b.apk', source: 'apkmirror-api' })),
        apkmirror: jest.fn(async () => ({ url: 'https://c/c.apk', source: 'apkmirror' })),
      };

      const result = await parallelResolveSources('com.x', '1.0.0', {
        sourceResolvers: resolvers,
      });

      expect(result.url).toBe('https://a/a.apk');
      // All three promises settled, so each source's finally-block
      // clearTimeout must have run. With fake timers active,
      // getTimerCount() reflects only the per-source SOURCE_TIMEOUT
      // handles — not the resolver microtasks.
      expect(jest.getTimerCount()).toBe(0);
    });

    test('clears timers when every source rejects', async () => {
      // All three reject with no usable URL. The fall-through
      // throws "All sources failed to resolve URL", but the
      // per-source timers must still be cleared by their finally
      // blocks.
      jest.useFakeTimers();
      const resolvers = {
        apkeep: jest.fn(async () => { throw new Error('apkeep 500'); }),
        apkmirrorApi: jest.fn(async () => { throw new Error('api 403'); }),
        apkmirror: jest.fn(async () => { throw new Error('playwright hung'); }),
      };

      await expect(
        parallelResolveSources('com.x', '1.0.0', { sourceResolvers: resolvers }),
      ).rejects.toThrow(/All sources failed to resolve URL/);
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
