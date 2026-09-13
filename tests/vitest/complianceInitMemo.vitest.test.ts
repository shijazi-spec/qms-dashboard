/**
 * initComplianceTables() must do its work ONCE per process.
 *
 * ~30 compliance routes await it on every request, and behind it sit ~56 DDL
 * statements, ten framework seed routines, a clause-sort backfill and a
 * retired-framework sweep. Re-running all of that per request is what made
 * /api/compliance/coverage/all take 20-30s and the Document Mapping page hang
 * on it. The work is idempotent, so the cost was invisible in behaviour — only
 * in latency, which is exactly the kind of regression that creeps back.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({
      query: (...a: any[]) => query(...a),
      release: () => {},
    }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The extended framework seeds are dynamically imported inside the init. They
// are not what is under test, and each one carries a large static catalogue.
vi.mock("../../src/utils/seeds/pdplFillObligations", () => ({
  seedPdplFillObligations: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/seeds/samaCsfFullObligations", () => ({
  seedSamaCsfFullObligations: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/seeds/iso27001Obligations", () => ({
  seedISO27001Obligations: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/seeds/iso9001Obligations", () => ({
  seedISO9001Obligations: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/seeds/ncaEccObligations", () => ({
  seedNcaEccObligations: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/seeds/ncaDccObligations", () => ({
  seedNcaDccObligations: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/seeds/pciDssObligations", () => ({
  seedPciDssObligations: vi.fn(async () => {}),
}));
vi.mock("../../src/utils/seeds/soc2Obligations", () => ({
  seedSoc2Obligations: vi.fn(async () => {}),
}));

import {
  initComplianceTables,
  resetComplianceTablesInit,
} from "../../src/utils/complianceDatabase";

/**
 * The init path reads two result shapes: `rows[0].count` from its
 * "is this framework already seeded?" probes, and `rows[0].id` / `rows.length`
 * from the regulation lookups. Answering 0 for the counts and no rows for
 * everything else keeps each seed on its early-return path — the queries under
 * test are the ones the init itself issues, not the catalogue inserts.
 */
function dbAnswer(sql: any) {
  const text = typeof sql === "string" ? sql : (sql?.text ?? "");
  if (/count\s*\(/i.test(text)) {
    return { rows: [{ count: "0" }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

beforeEach(() => {
  query.mockReset();
  query.mockImplementation(async (sql: any) => dbAnswer(sql));
  resetComplianceTablesInit();
});

describe("initComplianceTables", () => {
  it("does its work once, no matter how many callers ask", async () => {
    await initComplianceTables();
    const afterFirst = query.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await initComplianceTables();
    await initComplianceTables();

    expect(query.mock.calls.length).toBe(afterFirst);
  });

  it("concurrent callers share ONE run", async () => {
    await Promise.all([
      initComplianceTables(),
      initComplianceTables(),
      initComplianceTables(),
    ]);
    const afterConcurrent = query.mock.calls.length;

    // A single run's worth of queries — not three.
    resetComplianceTablesInit();
    query.mockClear();
    await initComplianceTables();
    expect(afterConcurrent).toBe(query.mock.calls.length);
  });

  it("a failed run is retried by the next caller, not cached forever", async () => {
    query.mockRejectedValueOnce(new Error("connection terminated"));

    await expect(initComplianceTables()).rejects.toThrow(
      "connection terminated",
    );

    query.mockImplementation(async (sql: any) => dbAnswer(sql));
    await expect(initComplianceTables()).resolves.toBeUndefined();
    expect(query.mock.calls.length).toBeGreaterThan(1);
  });
});
