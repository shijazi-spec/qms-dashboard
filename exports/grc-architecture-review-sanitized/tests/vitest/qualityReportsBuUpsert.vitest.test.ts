/**
 * upsertBU must not erase what the caller didn't mention.
 *
 * It used to write `input.x ?? null` for every optional column and then
 * `SET x = EXCLUDED.x`, so a partial update silently wiped the rest. Setting
 * policy_department on Customer Success (B2B) that way erased its kpi_bu_name
 * and reset sort_order to 0 — which is why the Quality Reports hub started
 * listing CS ahead of SDR and Sales instead of in funnel order (2026-08-19).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { upsertBU } from "../../src/utils/qualityReportsDepartments";

const BASE = { bu_key: "<REDACTED_SECRET>", bu_name: "Customer Success (B2B)", channel: "B2B" as const, fn: "cs" };

/**
 * The upsert statement, not the seed's.
 *
 * upsertBU calls ensureQualityReportTables() first, which issues its own
 * `INSERT INTO quality_report_bus ... ON CONFLICT DO NOTHING` per seeded BU —
 * matching on the table name alone picks up that one and tests nothing.
 */
function upsertCall() {
  return query.mock.calls.find(
    (c) =>
      /INSERT INTO quality_report_bus/i.test(String(c[0])) &&
      /DO UPDATE SET/i.test(String(c[0])),
  );
}

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [{ id: 3, bu_key: "<REDACTED_SECRET>" }] });
});

describe("partial updates leave untouched columns alone", () => {
  it("does not mention sort_order when the caller omits it", async () => {
    await upsertBU({ ...BASE, policy_department: "Customer Success" });
    const sql = String(upsertCall()![0]);
    // The bug: sort_order=EXCLUDED.sort_order with a defaulted 0 reordered the
    // whole hub as a side effect of setting an unrelated field.
    expect(sql).not.toMatch(/sort_order/);
    expect(sql).toMatch(/policy_department=EXCLUDED\.policy_department/);
  });

  it("does not mention kpi_bu_name or head_email when omitted", async () => {
    await upsertBU({ ...BASE, kpi_owner_name: "CS Team" });
    const sql = String(upsertCall()![0]);
    expect(sql).not.toMatch(/kpi_bu_name/);
    expect(sql).not.toMatch(/head_email/);
    expect(sql).toMatch(/kpi_owner_name=EXCLUDED\.kpi_owner_name/);
  });

  it("always rewrites the identity columns", async () => {
    await upsertBU({ ...BASE });
    const sql = String(upsertCall()![0]);
    for (const col of ["bu_name", "channel", "segment", "fn"]) {
      expect(sql).toMatch(new RegExp(`${col}=EXCLUDED\\.${col}`));
    }
  });
});

describe("explicit values still apply", () => {
  it("clears a field when null is passed deliberately", async () => {
    await upsertBU({ ...BASE, policy_department: null });
    const sql = String(upsertCall()![0]);
    // undefined means "leave alone"; null means "clear". Collapsing the two is
    // what caused the data loss.
    expect(sql).toMatch(/policy_department=EXCLUDED\.policy_department/);
    expect((upsertCall()![1] as any[]).includes(null)).toBe(true);
  });

  it("writes sort_order when it is supplied", async () => {
    await upsertBU({ ...BASE, sort_order: 3 });
    const sql = String(upsertCall()![0]);
    expect(sql).toMatch(/sort_order=EXCLUDED\.sort_order/);
    expect((upsertCall()![1] as any[]).includes(3)).toBe(true);
  });

  it("keeps the parameter list aligned with the column list", async () => {
    await upsertBU({ ...BASE, head_email: "<REDACTED_EMAIL>", kpi_owner_name: "CS Team", is_active: true });
    const [sql, params] = upsertCall()!;
    const placeholders = String(sql).match(/\$\d+/g) || [];
    const highest = Math.max(...placeholders.map((p) => Number(p.slice(1))));
    // A dynamically built column list is only safe if the two stay in step.
    expect(highest).toBe((params as any[]).length);
  });
});
