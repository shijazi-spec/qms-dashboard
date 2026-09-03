/**
 * Keep one stray promise from taking the whole platform offline.
 *
 * This is a single-instance deployment: when the Node process dies, every user
 * of every module gets `Internal Server Error` for the 30-60 seconds it takes
 * to come back, and the dashboards render
 * `Unexpected token 'I', "Internal S"... is not valid JSON` on panels that have
 * nothing to do with whatever failed.
 *
 * Node's default for an unhandled promise rejection is to EXIT. Before this
 * file there was no `unhandledRejection` handler, no `uncaughtException`
 * handler, and no `pool.on('error')` anywhere in the codebase — so any
 * rejected promise nobody awaited, or any Postgres error arriving on an idle
 * pooled connection, was fatal. Repeatedly downing the instance while testing
 * the Excel export (2026-08-25) is what surfaced this; see
 * `tests/vitest/exportCrashSafety.vitest.test.ts` for the two export-specific
 * windows that were closed at the same time.
 *
 * The two cases are deliberately treated differently:
 *
 *   unhandledRejection — LOG AND CONTINUE. A rejection means one request
 *     failed; it says nothing about the health of the rest of the process.
 *     Killing a healthy server over it trades a failed download for an outage.
 *
 *   uncaughtException  — LOG AND EXIT. The stack unwound through unknown code,
 *     so process state may genuinely be inconsistent and staying up risks
 *     serving wrong data, which is worse than being down. We exit on purpose
 *     (Replit restarts us) but now leave a named log line behind, which is
 *     what was missing every time this happened silently.
 */
import { logger } from "./logger";

let installed = false;

/** Idempotent — safe to call from more than one entry point. */
export function installProcessSafetyNet(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(
      "[processSafetyNet] UNHANDLED REJECTION — request failed, process kept alive",
      { message: err.message, stack: err.stack },
    );
  });

  process.on("uncaughtException", (err: Error) => {
    logger.error(
      "[processSafetyNet] UNCAUGHT EXCEPTION — exiting so the supervisor restarts us",
      { message: err?.message, stack: err?.stack },
    );
    // Give the log line a chance to flush before the process goes.
    setTimeout(() => process.exit(1), 100).unref();
  });
}

/**
 * Attach the `'error'` listener that node-postgres requires on every Pool.
 *
 * From the pg docs: a backend error or network drop on an IDLE pooled client
 * is emitted on the Pool, and "if you don't attach an error listener the
 * process will crash". These errors are routine — a Postgres restart, an idle
 * timeout on the provider side — and must never be fatal.
 *
 * Idempotent per pool.
 */
export function attachPoolErrorHandler(
  pool: { on?: (ev: string, cb: (err: Error) => void) => unknown } | null | undefined,
  label = "pool",
): void {
  // Tolerate anything that is not a full EventEmitter — several suites hand
  // `wrapPoolForRedaction` a stub pool with only `query`. A helper whose whole
  // job is preventing crashes must never be the thing that throws.
  if (!pool || typeof pool.on !== "function") return;
  const tagged = pool as unknown as Record<symbol, unknown>;
  const FLAG = Symbol.for("ExampleOrg.poolErrorHandlerAttached");
  if (tagged[FLAG]) return;
  tagged[FLAG] = true;
  pool.on("error", (err: Error) => {
    logger.error(`[processSafetyNet] idle client error on ${label} — ignored`, {
      message: err?.message,
    });
  });
}
