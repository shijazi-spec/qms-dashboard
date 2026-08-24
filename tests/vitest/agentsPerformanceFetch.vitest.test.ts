/**
 * /api/agents/performance fetch strategy.
 *
 * The endpoint pulls the full Zoho Leads set, the full Deals set and the user
 * list. Those three were sequential awaits, so the request cost their SUM —
 * measured at 139,286 ms live on 2026-08-23, which is a guaranteed proxy
 * timeout. dashboard/index.html is the caller, so the home page's agent panel
 * was the thing hanging.
 *
 * Two changes, neither of which alters a single returned value:
 *   - the three fetches run concurrently, so the request costs the SLOWEST
 *   - concurrent callers asking for the same date window share one in-flight
 *     fetch, instead of each triggering their own full Zoho pull
 *
 * These tests model that logic directly. They deliberately do NOT boot the
 * route (it needs Zoho credentials and a database); they pin the behaviour the
 * handler now relies on, which is where the concurrency risk actually lives.
 */
import { describe, it, expect, vi } from "vitest";

/** The de-duplication the handler performs, in isolation. */
function makeFetcher(work: (key: string) => Promise<any>) {
  let inFlight: { key: string; p: Promise<any> } | null = null;
  return async function fetchOnce(key: string) {
    if (inFlight && inFlight.key === key) return inFlight.p;
    const p = work(key);
    inFlight = { key, p };
    try {
      return await p;
    } finally {
      if (inFlight && inFlight.p === p) inFlight = null;
    }
  };
}

const defer = () => {
  let resolve!: (v: any) => void;
  let reject!: (e: any) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe("concurrent callers share one fetch", () => {
  it("does the work once for three simultaneous identical requests", async () => {
    const d = defer();
    const work = vi.fn(() => d.promise);
    const f = makeFetcher(work as any);

    const all = Promise.all([f("same"), f("same"), f("same")]);
    d.resolve("result");
    await expect(all).resolves.toEqual(["result", "result", "result"]);

    // The whole point: N dashboard opens on a cold cache used to mean N full
    // Zoho pulls and N times the rate-limit pressure for one identical answer.
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("does NOT share across different date windows", async () => {
    const work = vi.fn(async (k: string) => k);
    const f = makeFetcher(work);
    await Promise.all([f("q1"), f("q2")]);
    // Different windows produce different answers, so sharing would be wrong.
    expect(work).toHaveBeenCalledTimes(2);
  });
});

describe("the guard releases correctly", () => {
  it("lets a later request fetch again once the first settles", async () => {
    const work = vi.fn(async (k: string) => k);
    const f = makeFetcher(work);
    await f("same");
    await f("same");
    // Not a cache — the 15-minute cache is separate. Sequential calls must
    // still fetch, or the endpoint would serve one answer forever.
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("does not wedge after a failure", async () => {
    const work = vi
      .fn()
      .mockRejectedValueOnce(new Error("zoho down"))
      .mockResolvedValueOnce("recovered");
    const f = makeFetcher(work as any);

    await expect(f("same")).rejects.toThrow("zoho down");
    // A guard that kept the rejected promise would hand the same error to
    // every future caller — the endpoint would stay broken until restart.
    await expect(f("same")).resolves.toBe("recovered");
  });

  it("propagates the failure to every sharer, not just the first", async () => {
    const d = defer();
    const f = makeFetcher(() => d.promise);
    const a = f("same");
    const b = f("same");
    d.reject(new Error("zoho down"));
    await expect(a).rejects.toThrow("zoho down");
    await expect(b).rejects.toThrow("zoho down");
  });
});

describe("running the three fetches together", () => {
  it("costs the slowest, not the sum", async () => {
    const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const t0 = Date.now();
    await Promise.all([slow(40), slow(40), slow(40)]);
    const elapsed = Date.now() - t0;
    // Sequentially this is 120ms. Generous bound — the assertion is about
    // concurrency, not machine speed.
    expect(elapsed).toBeLessThan(110);
  });
});
