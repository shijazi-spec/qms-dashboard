/**
 * Tiny in-process test runner used by tests/*.test.ts files. No external
 * dependencies (no jest, no vitest); follows the same `npx tsx <file>` pattern
 * as the existing tests in this directory (e.g. aiApprovalRedaction.test.ts).
 */

export interface TestResult {
  name: string;
  ok: boolean;
  error?: Error;
}

export class TestSuite {
  readonly title: string;
  private results: TestResult[] = [];
  private current: { name: string; failures: string[] } | null = null;

  constructor(title: string) {
    this.title = title;
  }

  async test(name: string, fn: () => Promise<void> | void): Promise<void> {
    this.current = { name, failures: [] };
    try {
      await fn();
      if (this.current.failures.length > 0) {
        const err = new Error(this.current.failures.join("\n    "));
        this.results.push({ name, ok: false, error: err });
        console.error(`  ✗ ${name}\n    ${err.message}`);
      } else {
        this.results.push({ name, ok: true });
        console.log(`  ✓ ${name}`);
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.results.push({ name, ok: false, error: err });
      console.error(`  ✗ ${name}\n    ${err.message}`);
    } finally {
      this.current = null;
    }
  }

  /**
   * Soft assertion — records a failure on the current test but does not throw,
   * so that multiple expectations within one test can all be reported.
   */
  expect(condition: boolean, message: string): void {
    if (condition) return;
    if (this.current) this.current.failures.push(message);
    else throw new Error(`expect() called outside of a test: ${message}`);
  }

  expectEqual<T>(actual: T, expected: T, label: string): void {
    if (actual === expected) return;
    const msg = `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    if (this.current) this.current.failures.push(msg);
    else throw new Error(`expectEqual() called outside of a test: ${msg}`);
  }

  summarize(): { passed: number; failed: number; total: number } {
    const passed = this.results.filter((r) => r.ok).length;
    const failed = this.results.length - passed;
    return { passed, failed, total: this.results.length };
  }

  /**
   * Print the summary and exit the process with the appropriate code.
   *
   * Always exits explicitly (0 on success, 1 on failure) instead of relying on
   * the Node event loop to drain naturally. Some route handlers create
   * long-lived module-level resources during a test (e.g. pg `Pool` workers)
   * that would otherwise keep the process alive for minutes after every test
   * has reported PASS, blowing past CI's 2-minute budget. If a test cares
   * about graceful shutdown it can still tear those resources down before this
   * is called; otherwise this guarantees forward progress so `npm test`
   * finishes in bounded time.
   *
   * Note: SSE keep-alive `setInterval` timers are now `.unref()`'d at the
   * handler level (see duplicateRadarRoutes scan-stream) and cleared in their
   * `cancel()` callbacks, so they no longer contribute to this problem.
   */
  finishOrExit(): never {
    const { passed, failed, total } = this.summarize();
    console.log(`\n${this.title}: ${passed}/${total} passed`);
    if (failed > 0) {
      console.error(`${this.title}: ${failed} test(s) failed`);
    }
    // Flush stdout/stderr before exiting so output isn't truncated when
    // exit() races with buffered writes.
    const exitCode = failed > 0 ? 1 : 0;
    const flushAndExit = () => process.exit(exitCode);
    let pending = 0;
    const tryDone = () => {
      if (--pending <= 0) flushAndExit();
    };
    for (const stream of [process.stdout, process.stderr]) {
      // `write("")` returns true if drained; otherwise wait for `drain`.
      pending++;
      if (stream.write("")) {
        queueMicrotask(tryDone);
      } else {
        stream.once("drain", tryDone);
      }
    }
    // Defensive fallback: never let a stuck stream block exit for >250ms.
    setTimeout(flushAndExit, 250).unref();
    // Unreachable, satisfies `never` return type.
    return undefined as never;
  }
}
