/**
 * An export that fails must fail the DOWNLOAD, not the server.
 *
 * Measured on the deployed app 2026-08-25: /api/health returned 200 for 28
 * seconds straight, one Excel export request went out, and every route on the
 * instance returned 500 for the next 12 seconds. Reproduced on the
 * long-standing /api/duplicates/export-xlsx too, so this was never specific to
 * one endpoint — every staged export could take the whole platform down.
 *
 * Two unguarded windows caused it, and both are the same Node rule: an
 * unhandled stream 'error' event, or a rejected promise nobody awaits, kills
 * the process.
 *
 *   1. streamXlsx starts the workbook writer BEFORE the ReadableStream that
 *      owns the 'error' listener exists. Everything up to the first await —
 *      addWorksheet, the column spec, the header row — is synchronous, so a
 *      throw there destroys a PassThrough with no listener attached.
 *
 *   2. stageAndServeStreamingExport stores the in-flight staging promise in a
 *      map as well as awaiting it. If it rejects after the awaiting request
 *      has gone, the stored copy is an unhandled rejection.
 */
import { describe, it, expect } from "vitest";
import { streamXlsx, stageStreamingExportFromHono } from "../../src/utils/excelExport";

const sheet = (rows: Record<string, any>[]) => [
  { name: "S", columns: [{ header: "A", key: "<REDACTED_SECRET>", width: 10 }], rows },
];

const ctx = (url: string) => ({
  req: { url, method: "GET", header: () => undefined },
});

/** Fail the test if the process would have died during `fn`. */
async function assertNoFatalEvents(fn: () => Promise<unknown>) {
  const fatal: string[] = [];
  const onRejection = (e: any) => fatal.push(`unhandledRejection: ${e?.message ?? e}`);
  const onException = (e: any) => fatal.push(`uncaughtException: ${e?.message ?? e}`);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  try {
    await fn().catch(() => {
      /* a failed download is fine; a dead process is not */
    });
    // Let any stray rejection surface before we judge.
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  }
  expect(fatal).toEqual([]);
}

describe("a healthy export still works", () => {
  it("produces a valid workbook", async () => {
    const res = await streamXlsx(sheet([{ a: 1 }, { a: 2 }]), "t.xlsx", { title: "t" });
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // XLSX is a ZIP — "PK".
    expect([buf[0], buf[1]]).toEqual([0x50, 0x4b]);
  });

  it("still works through the staging wrapper", async () => {
    const res = await stageStreamingExportFromHono(
      ctx("<REDACTED_URL>") as any,
      async () => streamXlsx(sheet([{ a: 1 }]), "t.xlsx"),
    );
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).length).toBeGreaterThan(0);
  });
});

describe("a failing export does not kill the process", () => {
  it("survives a row source that throws mid-stream", async () => {
    async function* exploding() {
      yield { a: 1 };
      throw new Error("row source failed");
    }
    await assertNoFatalEvents(async () => {
      const res = await streamXlsx(
        [{ name: "S", columns: [{ header: "A", key: "<REDACTED_SECRET>" }], rows: exploding() }],
        "t.xlsx",
      );
      await res.arrayBuffer();
    });
  });

  it("survives a build() that throws before any stream exists", async () => {
    await assertNoFatalEvents(async () => {
      await stageStreamingExportFromHono(
        ctx("<REDACTED_URL>") as any,
        async () => {
          throw new Error("build failed");
        },
      );
    });
  });

  it("survives a response body that errors while being staged", async () => {
    await assertNoFatalEvents(async () => {
      const res = await stageStreamingExportFromHono(
        ctx("<REDACTED_URL>") as any,
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.error(new Error("stream died"));
              },
            }),
          ),
      );
      await res.arrayBuffer().catch(() => undefined);
    });
  });

  it("survives a caller that walks away from a failing export", async () => {
    // The exact shape that took the instance down: the staging promise is
    // stored in a map, rejects, and the request that would have awaited it is
    // already gone.
    await assertNoFatalEvents(async () => {
      const p = stageStreamingExportFromHono(
        ctx("<REDACTED_URL>") as any,
        async () => {
          throw new Error("build failed");
        },
      );
      p.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 10));
    });
  });
});

describe("staging is an optimisation, not a requirement", () => {
  it("still returns a usable workbook when the export cache dir is unwritable", async () => {
    // The HostingPlatform-shaped failure: the staging directory cannot be written, so
    // every staged export failed. Point the cache at a path that cannot exist
    // and assert the caller still gets a workbook rather than an error.
    const prev = process.env.STREAMING_EXPORT_CACHE_DIR;
    process.env.STREAMING_EXPORT_CACHE_DIR = "\0invalid\0path";
    try {
      const res = await stageStreamingExportFromHono(
        ctx("<REDACTED_URL>") as any,
        async () => streamXlsx(sheet([{ a: 1 }]), "t.xlsx"),
      );
      expect(res.status).toBe(200);
      const buf = Buffer.from(await res.arrayBuffer());
      expect([buf[0], buf[1]]).toEqual([0x50, 0x4b]);
    } finally {
      if (prev === undefined) delete process.env.STREAMING_EXPORT_CACHE_DIR;
      else process.env.STREAMING_EXPORT_CACHE_DIR = prev;
    }
  });
});
