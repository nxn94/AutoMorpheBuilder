// .github/scripts/__tests__/unified-downloader-runcommand.test.js
'use strict';

// runCommand() is an internal helper that wraps child_process.execFile
// with a timeout, returns a Promise, and emits a timeout error message
// when the child exceeds the deadline.
//
// Two contracts are pinned here:
//
//   1. (Issue #2) Node's execFile enforces its own `timeout` option
//      independently of callback usage — verified for Node >=24 via
//      runtime test. The Promise must reject with the custom
//      `Command timed out after ${timeout}ms: ${cmd}` message instead
//      of the raw ETIMEDOUT/ERR_CHILD_PROCESS_STDIO_TIMEOUT surface.
//      Earlier code used a manual `setTimeout` that doubled up on
//      execFile's built-in timeout; the manual one is now gone.
//
//   2. (Issue #1) After resolve (early exit), the helper must not
//      leave any pending timers referencing its closure alive. The
//      bug being pinned: a manual `setTimeout` whose handle was
//      never captured/stored, so a child that returned in 50ms still
//      held the timer open for the full `timeout` duration
//      (default 120s). With the manual timer removed AND with any
//      surviving manual setTimeout cleaned up, there are zero
//      pending timers after resolve — proven by counting
//      setTimeout/clearTimeout calls across the run.
//
// `runCommand` is exported solely for this test; see the `// For
// testing` comment at the export in unified-downloader.js.

const { runCommand } = require('../unified-downloader');

describe('runCommand', () => {
  test('resolves with { stdout, stderr, code } on a successful child', async () => {
    const result = await runCommand('printf', ['hello-runcommand']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('hello-runcommand');
  });

  test('rejects with the timeout-specific message when the child exceeds options.timeout', async () => {
    // Real timeout, not a fake-timer exercise — Node execFile's
    // built-in timeout must actually kill the child. We use a tiny
    // 150ms deadline so the test stays fast.
    const deadline = 150;
    const start = Date.now();
    await expect(
      runCommand('sleep', ['5'], { timeout: deadline }),
    ).rejects.toThrow(/Command timed out after \d+ms: sleep/);
    // Sanity: the rejection lands well before the child would have
    // finished naturally (5s sleep) — proof the timeout was actually
    // enforced, not just the rejection message tagged on later.
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test('does not leak pending timers when the child exits early', async () => {
    // Spy on global setTimeout/clearTimeout to count timer registrations
    // across a successful runCommand call. With the manual timer
    // removed (issue #2) AND any legacy manual setTimeout cleared on
    // early exit (issue #1), the helper must register zero timers of
    // its own that outlive the Promise. execFile's internal timeout
    // scheduler is not part of Jest's observable setTimeout API.
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const reset = () => {
      setTimeoutSpy.mockClear();
      clearTimeoutSpy.mockClear();
    };
    try {
      reset();
      const startCalls = setTimeoutSpy.mock.calls.length;
      const startClears = clearTimeoutSpy.mock.calls.length;

      // Fast child that finishes long before its 5s deadline.
      await runCommand('echo', ['ok'], { timeout: 5_000 });

      const newTimerCalls = setTimeoutSpy.mock.calls.length - startCalls;
      const newClearCalls = clearTimeoutSpy.mock.calls.length - startClears;

      // The legacy bug: runCommand registered an untracked setTimeout
      // that was never cleared. With the fix, manual timers either
      // never fire (issue #2: use execFile's built-in) or are
      // clearTimeout'd on early exit (issue #1: every registration
      // balanced by a clearTimeout). Both end up at zero net.
      expect(newTimerCalls).toBe(0);
      expect(newClearCalls).toBe(0);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  test('rejects on non-zero exit code with stderr in the message', async () => {
    await expect(
      runCommand('sh', ['-c', 'echo oops 1>&2; exit 7']),
    ).rejects.toThrow(/Command failed with code 7/);
  });
});
