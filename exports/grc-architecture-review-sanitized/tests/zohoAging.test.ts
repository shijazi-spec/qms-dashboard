/**
 * Unit tests for src/utils/zohoAging.ts (Task #825).
 *
 * Covers the four edge cases called out in the spec by exercising the pure
 * math (`computeAging`, `pickLatestStageHistoryEntry`,
 * `pickLatestStatusTimelineEntry`) plus the high-level `getDealStageAging` /
 * `getLeadStatusAging` helpers via dependency-injected fake fetchers — no
 * live Zoho is required.
 *
 *   1. Never-changed lead → falls back to Created_Time.
 *   2. Returned-status deal (moved away and back) → uses *latest* matching
 *      Stage_History entry, not the first.
 *   3. Terminal-state freeze → "Closed Won" / "Junk Lead" stop accumulating
 *      aging days.
 *   4. UTC timezone safety → mixed-offset timestamps yield the same UTC-day
 *      count regardless of source offset.
 *
 * Run:  npx tsx tests/zohoAging.test.ts
 */

import {
  computeAging,
  daysBetweenUtc,
  getDealStageAging,
  getLeadStatusAging,
  getStageAgingForDeals,
  getStatusAgingForLeads,
  pickLatestStageHistoryEntry,
  pickLatestStatusTimelineEntry,
  toUtcIso,
  _clearAgingCaches,
  type AgingFetchers,
} from "../src/utils/zohoAging";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
    if (extra !== undefined) console.error("    ", extra);
  }
}

function section(name: string) {
  console.log(`\n• ${name}`);
}

// ─── Pure math ───────────────────────────────────────────────────────────────

section("computeAging — never-changed (falls back to Created_Time)");
{
  const r = computeAging({
    currentValue: "New",
    enteredAtFromHistory: null,
    createdTime: "2026-04-01T00:00:00Z",
    now: "2026-04-15T00:00:00Z",
    terminalValues: ["Closed Won", "Junk Lead"],
  });
  check("source = created", r.source === "created", r);
  check("agingDays = 14", r.agingDays === 14, r);
  check("enteredAt = created ISO", r.enteredAt === "2026-04-01T00:00:00.000Z");
  check("not terminal", r.isTerminal === false);
}

section("computeAging — terminal state freezes aging at 0");
{
  const r = computeAging({
    currentValue: "Closed Won",
    enteredAtFromHistory: "2026-01-01T00:00:00Z",
    createdTime: "2025-12-01T00:00:00Z",
    now: "2026-05-01T00:00:00Z",
    terminalValues: ["Closed Won", "Closed Lost"],
  });
  check("isTerminal", r.isTerminal === true);
  check("agingDays frozen to 0", r.agingDays === 0, r);
  check("enteredAt preserved", r.enteredAt === "2026-01-01T00:00:00.000Z");
}

section("computeAging — UTC normalisation across mixed offsets");
{
  // 2026-04-01T00:00:00Z = 2026-04-01T05:00:00+05:00
  const r1 = computeAging({
    currentValue: "Working",
    enteredAtFromHistory: "2026-04-01T05:00:00+05:00",
    createdTime: null,
    now: "2026-04-08T00:00:00Z",
    terminalValues: [],
  });
  check("offset-aware → 7 days", r1.agingDays === 7, r1);

  const days = daysBetweenUtc(
    "2026-04-01T23:30:00-04:00", // = 2026-04-02T03:30:00Z
    "2026-04-05T03:30:00Z",
  );
  check("daysBetweenUtc handles -04:00 → UTC", days === 3, { days });
}

section("pickLatestStageHistoryEntry — returned-status (latest wins)");
{
  const history = [
    { Stage: "Qualification", Modified_Time: "2026-01-01T00:00:00Z" },
    { Stage: "Negotiation", Modified_Time: "2026-01-15T00:00:00Z" },
    { Stage: "Qualification", Modified_Time: "2026-02-01T00:00:00Z" }, // returned
    { Stage: "Closed Lost", Modified_Time: "2025-12-01T00:00:00Z" },
  ];
  const latest = pickLatestStageHistoryEntry(history, "Qualification");
  check("found", !!latest, latest);
  check(
    "picked the LATEST 'Qualification' entry",
    latest?.enteredAt === "2026-02-01T00:00:00.000Z",
    latest,
  );

  const noMatch = pickLatestStageHistoryEntry(history, "Proposal");
  check("returns null when no entry matches", noMatch === null);
}

section("pickLatestStatusTimelineEntry — filters by api_name + value");
{
  const timeline = [
    {
      audited_time: "2026-01-01T00:00:00Z",
      field: { api_name: "Lead_Status" },
      value: { current: "Contacted" },
    },
    {
      audited_time: "2026-02-01T00:00:00Z",
      field: { api_name: "Email" },
      value: { current: "user@example.invalid" }, // wrong field — must be ignored
    },
    {
      audited_time: "2026-03-01T00:00:00Z",
      field: { api_name: "Lead_Status" },
      value: { current: "Contacted" },
    },
  ];
  const r = pickLatestStatusTimelineEntry(timeline, "Lead_Status", "Contacted");
  check(
    "latest matching Lead_Status entry chosen",
    r?.enteredAt === "2026-03-01T00:00:00.000Z",
    r,
  );
}

section("toUtcIso — robust to invalid inputs");
{
  check("null → null", toUtcIso(null) === null);
  check("garbage → null", toUtcIso("not a date") === null);
  check(
    "Z → ISO",
    toUtcIso("2026-04-01T00:00:00Z") === "2026-04-01T00:00:00.000Z",
  );
}

// ─── End-to-end with stub Zoho fetchers ──────────────────────────────────────

function makeStub(overrides: Partial<AgingFetchers>): AgingFetchers {
  return {
    fetchDealStageHistoryById: async () => ({
      history: [],
      currentStage: "",
      createdTime: null,
      dealName: "",
      owner: "",
    }),
    fetchLeadStatusTimelineById: async () => ({
      timeline: [],
      currentStatus: "",
      createdTime: null,
      leadName: "",
      owner: "",
    }),
    listDealsPage: async () => [],
    listLeadsPage: async () => [],
    ...overrides,
  };
}

section("getLeadStatusAging — never-changed lead falls back to Created_Time");
await (async () => {
  _clearAgingCaches();
  const deps = makeStub({
    fetchLeadStatusTimelineById: async () => ({
      timeline: [], // never modified
      currentStatus: "New",
      createdTime: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      leadName: "",
      owner: "",
    }),
  });
  const r = await getLeadStatusAging("LEAD1", deps);
  check("source = created", r.source === "created", r);
  check("agingDays ≈ 10", r.agingDays === 10, r);
  check("status echoed", r.status === "New" && r.value === "New");
})();

section("getDealStageAging — returned-status uses latest entry");
await (async () => {
  _clearAgingCaches();
  const now = "2026-05-01T00:00:00Z";
  const deps = makeStub({
    fetchDealStageHistoryById: async () => ({
      currentStage: "Qualification",
      createdTime: "2025-11-01T00:00:00Z",
      history: [
        { Stage: "Qualification", Modified_Time: "2026-01-01T00:00:00Z" },
        { Stage: "Negotiation", Modified_Time: "2026-02-01T00:00:00Z" },
        { Stage: "Qualification", Modified_Time: "2026-04-01T00:00:00Z" }, // returned
      ],
      dealName: "",
      owner: "",
    }),
  });
  // We can't pass `now` through the public API, so verify against the latest
  // entry's UTC ISO directly and let `agingDays` be ≥ days since 2026-04-01.
  const r = await getDealStageAging("DEAL1", deps);
  check(
    "enteredAt picks 2026-04-01 (returned)",
    r.enteredAt === "2026-04-01T00:00:00.000Z",
    r,
  );
  check("source = history", r.source === "history");
  void now; // silence unused
})();

section("getDealStageAging — terminal stage freezes");
await (async () => {
  _clearAgingCaches();
  const deps = makeStub({
    fetchDealStageHistoryById: async () => ({
      currentStage: "Closed Won",
      createdTime: "2024-01-01T00:00:00Z",
      history: [
        { Stage: "Closed Won", Modified_Time: "2025-06-01T00:00:00Z" },
      ],
      dealName: "",
      owner: "",
    }),
  });
  const r = await getDealStageAging("DEAL2", deps);
  check("isTerminal", r.isTerminal === true);
  check("agingDays = 0 (frozen)", r.agingDays === 0, r);
  check(
    "enteredAt preserved",
    r.enteredAt === "2025-06-01T00:00:00.000Z",
    r,
  );
})();

section("getStatusAgingForLeads — batched fan-out + cache");
await (async () => {
  _clearAgingCaches();
  let calls = 0;
  const deps = makeStub({
    fetchLeadStatusTimelineById: async (_id: string) => {
      calls++;
      return {
        currentStatus: "Working",
        createdTime: "2026-04-01T00:00:00Z",
        timeline: [
          {
            audited_time: "2026-04-10T00:00:00Z",
            field: { api_name: "Lead_Status" },
            value: { current: "Working" },
          },
        ],
        leadName: "",
        owner: "",
      };
    },
  });
  const ids = ["L1", "L2", "L3"];
  const r1 = await getStatusAgingForLeads(ids, deps);
  check("returned one per id", r1.length === 3 && r1[0].leadId === "L1");
  const callsAfterFirst = calls;
  const r2 = await getStatusAgingForLeads(ids, deps);
  check(
    "second call hit cache (no extra fetches)",
    calls === callsAfterFirst,
    { calls, callsAfterFirst },
  );
  check("results identical", r2[0].enteredAt === r1[0].enteredAt);
})();

section("getStageAgingForDeals — failure on one id is isolated");
await (async () => {
  _clearAgingCaches();
  const deps = makeStub({
    fetchDealStageHistoryById: async (id: string) => {
      if (id === "BAD") throw new Error("boom");
      return {
        currentStage: "Qualification",
        createdTime: "2026-04-01T00:00:00Z",
        history: [],
        dealName: "",
        owner: "",
      };
    },
  });
  const r = await getStageAgingForDeals(["GOOD", "BAD"], deps);
  check("returned both rows", r.length === 2);
  const bad = r.find((x) => x.dealId === "BAD")!;
  check("bad row degraded gracefully", bad.source === "unknown" && bad.agingDays === 0);
})();

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
