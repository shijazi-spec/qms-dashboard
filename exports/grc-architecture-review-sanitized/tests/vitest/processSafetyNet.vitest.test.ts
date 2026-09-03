/**
 * One stray promise must not take the platform offline.
 *
 * Before this existed the codebase had no `unhandledRejection` handler, no
 * `uncaughtException` handler, and no `pool.on('error')` — so Node's default
 * applied: a rejected promise nobody awaited, or a Postgres error arriving on
 * an idle pooled connection, exited the process. On a single-instance
 * deployment that is a full outage — every module, every user, 30-60 seconds,
 * with dashboards showing `Unexpected token 'I', "Internal S"...` on panels
 * unrelated to whatever failed.
 *
 * The asymmetry is the point and is asserted below: a rejection means ONE
 * request failed and the server stays up; an uncaught exception unwound
 * through unknown code, so we exit deliberately and let the supervisor restart
 * us — but leave a named log line, which is exactly what was missing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { installProcessSafetyNet, attachPoolErrorHandler } from "../../src/utils/processSafetyNet";
import { logger } from "../../src/utils/logger";

describe("installProcessSafetyNet", () => {
  beforeEach(() => {
    installProcessSafetyNet();
  });

  it("is idempotent — repeat calls do not stack listeners", () => {
    const before = process.listenerCount("unhandledRejection");
    installProcessSafetyNet();
    installProcessSafetyNet();
    expect(process.listenerCount("unhandledRejection")).toBe(before);
  });

  it("registers handlers for both fatal-by-default events", () => {
    expect(process.listenerCount("unhandledRejection")).toBeGreaterThan(0);
    expect(process.listenerCount("uncaughtException")).toBeGreaterThan(0);
  });

  it("logs an unhandled rejection instead of letting it end the process", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined as any);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as any);
    try {
      // Drive the registered handler directly — actually rejecting a promise
      // here would be caught by the test runner's own hooks.
      process.emit("unhandledRejection", new Error("a request blew up"), Promise.resolve());
      const msg = String(spy.mock.calls.at(-1)?.[0] ?? "");
      expect(msg).toContain("UNHANDLED REJECTION");
      expect(msg).toContain("process kept alive");
      // The whole point: we did NOT tear the server down.
      expect(exit).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      exit.mockRestore();
    }
  });

  it("survives a rejection whose reason is not an Error", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined as any);
    try {
      expect(() =>
        process.emit("unhandledRejection", "just a string", Promise.resolve()),
      ).not.toThrow();
      expect(String(spy.mock.calls.at(-1)?.[0] ?? "")).toContain("UNHANDLED REJECTION");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("attachPoolErrorHandler", () => {
  let handlers: Array<(err: Error) => void>;
  let pool: { on: (ev: string, cb: (err: Error) => void) => unknown };

  beforeEach(() => {
    handlers = [];
    pool = {
      on: (ev: string, cb: (err: Error) => void) => {
        if (ev === "error") handlers.push(cb);
        return pool;
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("attaches an error listener — without one, pg crashes the process", () => {
    attachPoolErrorHandler(pool, "test-pool");
    expect(handlers).toHaveLength(1);
  });

  it("is idempotent per pool", () => {
    attachPoolErrorHandler(pool, "test-pool");
    attachPoolErrorHandler(pool, "test-pool");
    attachPoolErrorHandler(pool, "test-pool");
    expect(handlers).toHaveLength(1);
  });

  it("swallows an idle-client error and names the pool in the log", () => {
    const spy = vi.spyOn(logger, "error").mockImplementation(() => undefined as any);
    attachPoolErrorHandler(pool, "duplicate-radar");
    // A Postgres restart or a provider-side idle timeout. Routine — the
    // handler must absorb it, not rethrow.
    expect(() => handlers[0](new Error("terminating connection due to administrator command"))).not.toThrow();
    expect(String(spy.mock.calls.at(-1)?.[0] ?? "")).toContain("duplicate-radar");
  });

  it("tracks separate pools independently", () => {
    const other: typeof pool = { on: () => other };
    attachPoolErrorHandler(pool, "a");
    attachPoolErrorHandler(other, "b");
    expect(handlers).toHaveLength(1); // `other` records into its own no-op
  });

  it("ignores a stub pool with no .on — several suites pass one", () => {
    // A helper whose entire job is preventing crashes must never be the thing
    // that throws. This exact case broke auditsExportRouteOrder and
    // redactionSweepAlertsRoute, which mock the pool with only `query`.
    expect(() => attachPoolErrorHandler({ query: () => undefined } as any)).not.toThrow();
    expect(() => attachPoolErrorHandler(null)).not.toThrow();
    expect(() => attachPoolErrorHandler(undefined)).not.toThrow();
  });
});

describe("every redacted pool gets the listener by construction", () => {
  it("createRedactedPool attaches one", async () => {
    const { createRedactedPool } = await import("../../src/utils/redactedPool");
    const p = createRedactedPool({ connectionString: "postgres://u:p@<REDACTED_IP>:1/db" });
    // pg's Pool is an EventEmitter — assert a listener is present rather than
    // reaching into the module's internals.
    expect((p as any).listenerCount("error")).toBeGreaterThan(0);
    await p.end().catch(() => undefined);
  });
});
