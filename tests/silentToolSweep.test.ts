/**
 * Unit tests for the silent-tool sweep added in Task #130 — the cron path
 * that auto-resolves open `tool_health` alerts whose underlying tool has
 * stopped emitting calls (deprecated, retired, or simply idle).
 *
 * Coverage matches Task #306:
 *   • `runSilentToolSweep` with stubbed deps:
 *       - Open alert for a tool with zero calls older than the cooldown
 *         is auto-resolved with the "tool went silent" note.
 *       - Open alert for a tool that is still active is NOT resolved.
 *       - Open alert younger than the cooldown is NOT resolved
 *         (verified via the `olderThanMinutes` filter passed to
 *         `getOpenAlertsByType` — the SQL applies the cutoff).
 *       - `alertsAutoResolved` and `recoveries` are populated correctly.
 *       - A throw from `resolveAlert` is caught and logged without
 *         aborting the sweep — remaining alerts still get processed.
 *   • `getOpenAlertsByType` and `getToolsWithCallsInWindow` exercised in
 *     isolation by stubbing `pg.Pool.prototype.query` so the helpers run
 *     without a live Postgres instance.
 *
 * Run:  npx tsx tests/silentToolSweep.test.ts
 * Wired: discovered automatically by tests/runIntegrationTests.ts (npm test).
 */

import pg from "pg";
import type {
  ToolHealthCheckResult,
  ToolHealthDeps,
} from "../src/mastra/workflows/toolHealthAlertsCron";
import type { AIAlert } from "../src/utils/aiAlertsDatabase";

// ─── Stub pg.Pool.prototype.query BEFORE importing the modules under test ──
// Both `aiTelemetry.ts` and `aiAlertsDatabase.ts` (via `sharedPool`)
// instantiate a `pg.Pool` at module-load time, so we patch the prototype
// before the dynamic imports below. Each test installs its own per-call
// behavior via `setQueryHandler`; the default handler returns an empty
// result so unrelated queries (e.g. `ensureAiMetricsTable`'s CREATE
// statements) are no-ops.

interface CapturedQuery {
  sql: string;
  params: ReadonlyArray<unknown>;
}

type QueryHandler = (
  q: CapturedQuery,
) => { rows: unknown[]; rowCount?: number } | undefined;

const captured: CapturedQuery[] = [];
let queryHandler: QueryHandler = () => undefined;

function setQueryHandler(handler: QueryHandler): void {
  queryHandler = handler;
}

function resetCapturedQueries(): void {
  captured.length = 0;
  queryHandler = () => undefined;
}

(pg.Pool.prototype as unknown as { query: unknown }).query =
  async function stubQuery(
    this: pg.Pool,
    sql: unknown,
    params?: ReadonlyArray<unknown>,
  ): Promise<unknown> {
    // Some callers pass a query-config object; we only need the textual SQL
    // path for these helpers, so coerce to string for capture and skip the
    // handler when it isn't.
    const sqlText =
      typeof sql === "string"
        ? sql
        : String((sql as { text?: string })?.text ?? "");
    const entry: CapturedQuery = { sql: sqlText, params: params ?? [] };
    captured.push(entry);
    const result = queryHandler(entry);
    if (result)
      return {
        command: "",
        oid: 0,
        fields: [],
        rowCount: result.rows.length,
        ...result,
      };
    return {
      command: "",
      oid: 0,
      fields: [],
      rowCount: 0,
      rows: [] as unknown[],
    };
  } as typeof pg.Pool.prototype.query;

// Force-load AFTER the prototype stub is in place.
const { runSilentToolSweep } =
  await import("../src/mastra/workflows/toolHealthAlertsCron");
const { getOpenAlertsByType } = await import("../src/utils/aiAlertsDatabase");
const { getToolsWithCallsInWindow } = await import("../src/utils/aiTelemetry");

const { TestSuite } = await import("./_helpers/runner");

// ──────────────────────────────────────────────────────────────────────────────
// Test helpers for runSilentToolSweep
// ──────────────────────────────────────────────────────────────────────────────

function makeAlert(
  p: Partial<AIAlert> & Pick<AIAlert, "id" | "related_record_id">,
): AIAlert {
  return {
    alert_type: "tool_health",
    severity: "high",
    title: `stub alert ${p.id}`,
    description: "stub",
    status: "open",
    ...p,
  };
}

function makeEmptyResult(): ToolHealthCheckResult {
  return {
    toolsEvaluated: 0,
    alertsCreated: 0,
    alertsSkippedDuplicate: 0,
    alertsAutoResolved: 0,
    expiredOverridesReaped: 0,
    overrideExpirySoonWarningSent: 0,
    notificationsSent: 0,
    notificationsSkipped: 0,
    notificationsThrottled: 0,
    breaches: [],
    recoveries: [],
  };
}

interface OpenLookupCall {
  alertType: string;
  options?: { olderThanMinutes?: number };
}

interface ActiveToolsCall {
  windowMinutes: number;
}

interface ResolveCall {
  id: number;
  note?: string;
}

interface SilentSweepStubs {
  /**
   * Alerts the stubbed `getOpenAlertsByType` should return. The stub
   * faithfully applies the `olderThanMinutes` filter so a test that wants
   * to assert "young alerts are excluded" can mark some alerts with a
   * recent `created_at` and confirm they're filtered out.
   */
  alerts: AIAlert[];
  activeToolNames?: Iterable<string>;
  /**
   * If set, the corresponding stub throws instead of returning. Used to
   * prove that errors are caught and logged without aborting the sweep.
   */
  resolveThrows?: Set<number>;
  getOpenAlertsThrows?: boolean;
  getToolsActiveThrows?: boolean;
}

function makeSilentSweepDeps(s: SilentSweepStubs): {
  deps: ToolHealthDeps;
  openLookups: OpenLookupCall[];
  activeLookups: ActiveToolsCall[];
  resolves: ResolveCall[];
} {
  const openLookups: OpenLookupCall[] = [];
  const activeLookups: ActiveToolsCall[] = [];
  const resolves: ResolveCall[] = [];
  const activeTools = new Set<string>(s.activeToolNames ?? []);
  const resolveThrows = s.resolveThrows ?? new Set<number>();

  const deps: ToolHealthDeps = {
    // The breach/dedupe surface area is irrelevant for the silent sweep,
    // but `ToolHealthDeps` requires it. Stub everything to a no-op so any
    // accidental call would produce a clear test failure.
    getToolWindowAggregates: async () => {
      throw new Error(
        "getToolWindowAggregates should not be called by silent sweep",
      );
    },
    openAlertExistsByKey: async () => {
      throw new Error(
        "openAlertExistsByKey should not be called by silent sweep",
      );
    },
    createAIAlert: async () => {
      throw new Error("createAIAlert should not be called by silent sweep");
    },
    getOpenAlertsByKey: async () => {
      throw new Error(
        "getOpenAlertsByKey should not be called by silent sweep",
      );
    },
    getOpenAlertsByType: async (alertType, options) => {
      openLookups.push({ alertType, options });
      if (s.getOpenAlertsThrows)
        throw new Error("stub getOpenAlertsByType failure");
      // Faithfully apply the cooldown filter so "alert too young to
      // resolve" cases test the cron's contract, not the stub's
      // bookkeeping.
      const olderThanMinutes = options?.olderThanMinutes;
      if (olderThanMinutes == null) return s.alerts;
      const cutoff = Date.now() - olderThanMinutes * 60_000;
      return s.alerts.filter((a) =>
        a.created_at == null ? true : a.created_at.getTime() <= cutoff,
      );
    },
    getToolsWithCallsInWindow: async (windowMinutes) => {
      activeLookups.push({ windowMinutes });
      if (s.getToolsActiveThrows)
        throw new Error("stub getToolsWithCallsInWindow failure");
      return activeTools;
    },
    resolveAlert: async (id, note) => {
      resolves.push({ id, note });
      if (resolveThrows.has(id))
        throw new Error(`stub resolveAlert(${id}) failure`);
      return {
        id,
        alert_type: "tool_health",
        severity: "high",
        title: "resolved",
        description: "resolved",
        status: "resolved",
        resolution_note: note ?? null,
      } as AIAlert;
    },
    notifyToolHealthBreach: async () => {
      throw new Error(
        "notifyToolHealthBreach should not be called by silent sweep",
      );
    },
  };
  return { deps, openLookups, activeLookups, resolves };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

const suite = new TestSuite(
  "runSilentToolSweep + getOpenAlertsByType + getToolsWithCallsInWindow",
);
console.log("\n=== silentToolSweep tests ===\n");

// ─── runSilentToolSweep ──────────────────────────────────────────────────────

await suite.test(
  "(s1) silent-tool alert older than cooldown is auto-resolved with 'tool went silent' note",
  async () => {
    const old = new Date(Date.now() - 10 * 60 * 60_000); // 10h ago — older than any reasonable cooldown
    const alert = makeAlert({
      id: 42,
      related_record_id: "deprecated_tool:error_rate",
      created_at: old,
    });
    const { deps, openLookups, activeLookups, resolves } = makeSilentSweepDeps({
      alerts: [alert],
      activeToolNames: ["other_tool"], // deprecated_tool is silent
    });
    const out = makeEmptyResult();

    await runSilentToolSweep(deps, 240, out);

    suite.expectEqual(resolves.length, 1, "resolveAlert called exactly once");
    suite.expectEqual(resolves[0]?.id, 42, "resolved alert id matches");
    suite.expect(
      typeof resolves[0]?.note === "string" &&
        resolves[0].note.toLowerCase().includes("tool went silent"),
      `note mentions 'tool went silent' (got: ${JSON.stringify(resolves[0]?.note)})`,
    );
    suite.expect(
      typeof resolves[0]?.note === "string" && resolves[0].note.includes("240"),
      "note carries the cooldown window length so the audit trail is self-describing",
    );

    suite.expectEqual(out.alertsAutoResolved, 1, "alertsAutoResolved counter");
    suite.expectEqual(out.recoveries.length, 1, "recoveries array populated");
    suite.expectEqual(
      out.recoveries[0]?.alert_id,
      42,
      "recovery carries alert id",
    );
    suite.expectEqual(
      out.recoveries[0]?.tool_name,
      "deprecated_tool",
      "recovery carries tool name parsed from related_record_id",
    );
    suite.expectEqual(
      out.recoveries[0]?.reason,
      "error_rate",
      "recovery carries reason parsed from related_record_id",
    );

    // The cron must pass the cooldown both into the alert lookup AND the
    // active-tools lookup so the two windows agree.
    suite.expectEqual(openLookups.length, 1, "getOpenAlertsByType called once");
    suite.expectEqual(
      openLookups[0]?.alertType,
      "tool_health",
      "lookup scoped to tool_health",
    );
    suite.expectEqual(
      openLookups[0]?.options?.olderThanMinutes,
      240,
      "olderThanMinutes forwarded — DB-side flap-prevention cutoff",
    );
    suite.expectEqual(
      activeLookups.length,
      1,
      "getToolsWithCallsInWindow called once",
    );
    suite.expectEqual(
      activeLookups[0]?.windowMinutes,
      240,
      "active-tools window matches cooldown",
    );
  },
);

await suite.test(
  "(s2) alert for a tool that is STILL ACTIVE is NOT resolved",
  async () => {
    const old = new Date(Date.now() - 10 * 60 * 60_000);
    const alert = makeAlert({
      id: 99,
      related_record_id: "live_tool:p95_latency",
      created_at: old,
    });
    const { deps, resolves } = makeSilentSweepDeps({
      alerts: [alert],
      activeToolNames: ["live_tool", "another_tool"],
    });
    const out = makeEmptyResult();

    await runSilentToolSweep(deps, 240, out);

    suite.expectEqual(resolves.length, 0, "resolveAlert NOT called");
    suite.expectEqual(
      out.alertsAutoResolved,
      0,
      "alertsAutoResolved counter unchanged",
    );
    suite.expectEqual(out.recoveries.length, 0, "recoveries array empty");
  },
);

await suite.test(
  "(s3) alert younger than cooldown is filtered out by olderThanMinutes",
  async () => {
    // Two alerts: one ancient, one only 10 minutes old. Cooldown is 240m
    // so the young one must be excluded by the SQL-level cutoff that the
    // sweep forwards via `olderThanMinutes`.
    const ancient = makeAlert({
      id: 1,
      related_record_id: "ancient_tool:error_rate",
      created_at: new Date(Date.now() - 10 * 60 * 60_000),
    });
    const fresh = makeAlert({
      id: 2,
      related_record_id: "fresh_tool:error_rate",
      created_at: new Date(Date.now() - 10 * 60_000), // 10m old < 240m cooldown
    });
    const { deps, openLookups, resolves } = makeSilentSweepDeps({
      alerts: [ancient, fresh],
      activeToolNames: [], // both silent — only age separates them
    });
    const out = makeEmptyResult();

    await runSilentToolSweep(deps, 240, out);

    // The cron MUST pass `olderThanMinutes` so the DB filters fresh
    // alerts out before they reach the resolution loop.
    suite.expectEqual(
      openLookups[0]?.options?.olderThanMinutes,
      240,
      "olderThanMinutes filter forwarded — flap prevention",
    );
    // Only the ancient alert should be resolved.
    suite.expectEqual(resolves.length, 1, "exactly one resolveAlert call");
    suite.expectEqual(
      resolves[0]?.id,
      1,
      "only the ancient alert was resolved",
    );
    suite.expectEqual(out.alertsAutoResolved, 1, "alertsAutoResolved=1");
    suite.expectEqual(
      out.recoveries[0]?.tool_name,
      "ancient_tool",
      "recovery is for the ancient tool",
    );
  },
);

await suite.test(
  "(s4) counters and recoveries reflect every successful resolution across multiple alerts",
  async () => {
    const old = new Date(Date.now() - 10 * 60 * 60_000);
    const alerts = [
      makeAlert({
        id: 11,
        related_record_id: "tool_a:error_rate",
        created_at: old,
      }),
      makeAlert({
        id: 12,
        related_record_id: "tool_b:p95_latency",
        created_at: old,
      }),
      makeAlert({
        id: 13,
        related_record_id: "tool_c:error_rate",
        created_at: old,
      }),
    ];
    const { deps, resolves } = makeSilentSweepDeps({
      alerts,
      activeToolNames: [], // all three silent
    });
    const out = makeEmptyResult();

    await runSilentToolSweep(deps, 240, out);

    suite.expectEqual(resolves.length, 3, "three resolveAlert calls");
    suite.expectEqual(out.alertsAutoResolved, 3, "alertsAutoResolved=3");
    suite.expectEqual(out.recoveries.length, 3, "three recoveries recorded");

    const toolNames = out.recoveries.map((r) => r.tool_name).sort();
    suite.expectEqual(
      toolNames.join(","),
      "tool_a,tool_b,tool_c",
      "recoveries cover every silent tool",
    );
    const reasons = out.recoveries.map((r) => r.reason).sort();
    suite.expectEqual(
      reasons.join(","),
      "error_rate,error_rate,p95_latency",
      "reasons parsed correctly from related_record_id",
    );
  },
);

await suite.test(
  "(s5) a throw from resolveAlert is caught and the sweep keeps going",
  async () => {
    const old = new Date(Date.now() - 10 * 60 * 60_000);
    const alerts = [
      makeAlert({
        id: 21,
        related_record_id: "first_tool:error_rate",
        created_at: old,
      }),
      makeAlert({
        id: 22,
        related_record_id: "boom_tool:error_rate",
        created_at: old,
      }),
      makeAlert({
        id: 23,
        related_record_id: "third_tool:error_rate",
        created_at: old,
      }),
    ];
    const { deps, resolves } = makeSilentSweepDeps({
      alerts,
      activeToolNames: [],
      resolveThrows: new Set([22]), // middle alert throws
    });
    const out = makeEmptyResult();

    // Silence the expected error log so test output stays readable.
    const originalConsoleError = console.error;
    const errorLogs: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorLogs.push(args);
    };
    try {
      await runSilentToolSweep(deps, 240, out);
    } finally {
      console.error = originalConsoleError;
    }

    // All three resolve attempts must have been issued (the throw on #22
    // must NOT short-circuit the loop).
    suite.expectEqual(
      resolves.length,
      3,
      "all three resolveAlert calls were attempted",
    );
    suite.expectEqual(
      resolves
        .map((r) => r.id)
        .sort((a, b) => a - b)
        .join(","),
      "21,22,23",
      "every alert id was attempted",
    );

    // Counters reflect the two successful resolutions only.
    suite.expectEqual(
      out.alertsAutoResolved,
      2,
      "alertsAutoResolved counts only successes",
    );
    suite.expectEqual(
      out.recoveries.length,
      2,
      "recoveries skip the failed resolve",
    );
    const recoveryIds = out.recoveries
      .map((r) => r.alert_id)
      .sort((a, b) => a - b);
    suite.expectEqual(
      recoveryIds.join(","),
      "21,23",
      "successful recoveries are 21 + 23",
    );

    // The error must have been logged so on-call can see what failed.
    suite.expect(
      errorLogs.some((entry) =>
        entry.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("failed to resolve alert 22"),
        ),
      ),
      "error from resolveAlert(22) was logged",
    );
  },
);

await suite.test(
  "(s6) a throw from getOpenAlertsByType aborts the sweep without raising",
  async () => {
    const { deps, resolves } = makeSilentSweepDeps({
      alerts: [],
      getOpenAlertsThrows: true,
    });
    const out = makeEmptyResult();

    const originalConsoleError = console.error;
    const errorLogs: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errorLogs.push(args);
    };
    try {
      // Must not throw — the cron's surrounding pass would otherwise be
      // aborted by a transient DB blip on the alerts table.
      await runSilentToolSweep(deps, 240, out);
    } finally {
      console.error = originalConsoleError;
    }

    suite.expectEqual(
      resolves.length,
      0,
      "no resolution attempts on data-load failure",
    );
    suite.expectEqual(out.alertsAutoResolved, 0, "counter untouched");
    suite.expectEqual(out.recoveries.length, 0, "recoveries empty");
    suite.expect(
      errorLogs.some((entry) =>
        entry.some(
          (arg) =>
            typeof arg === "string" &&
            arg.includes("Silent-tool sweep") &&
            arg.includes("failed to load data"),
        ),
      ),
      "data-load failure was logged",
    );
  },
);

await suite.test(
  "(s7) malformed related_record_id rows are skipped without aborting the sweep",
  async () => {
    const old = new Date(Date.now() - 10 * 60 * 60_000);
    const alerts: AIAlert[] = [
      makeAlert({
        id: 31,
        related_record_id: "good_tool:error_rate",
        created_at: old,
      }),
      // Missing colon → cannot parse tool_name; sweep must skip silently.
      makeAlert({
        id: 32,
        related_record_id: "no_colon_here",
        created_at: old,
      }),
      // Missing related_record_id entirely → also skipped.
      makeAlert({ id: 33, related_record_id: undefined, created_at: old }),
    ];
    const { deps, resolves } = makeSilentSweepDeps({
      alerts,
      activeToolNames: [],
    });
    const out = makeEmptyResult();

    await runSilentToolSweep(deps, 240, out);

    suite.expectEqual(
      resolves.length,
      1,
      "only the well-formed alert was resolved",
    );
    suite.expectEqual(resolves[0]?.id, 31, "well-formed alert id matches");
    suite.expectEqual(
      out.alertsAutoResolved,
      1,
      "counter reflects only the parsed alert",
    );
  },
);

// ─── getOpenAlertsByType (DB helper, isolated via pg.Pool stub) ──────────────

await suite.test(
  "(o1) getOpenAlertsByType('tool_health') returns rows from the open/acknowledged WHERE clause",
  async () => {
    resetCapturedQueries();
    const stubRow = {
      id: 7,
      alert_type: "tool_health",
      severity: "high",
      title: "open alert",
      description: "open",
      status: "open",
      related_record_id: "some_tool:error_rate",
    };
    setQueryHandler((q) => {
      if (/FROM ai_alerts/i.test(q.sql) && /alert_type = \$1/.test(q.sql)) {
        return { rows: [stubRow] };
      }
      return undefined;
    });

    const rows = await getOpenAlertsByType("tool_health");
    suite.expectEqual(rows.length, 1, "one row returned");
    suite.expectEqual(rows[0]?.id, 7, "row id forwarded");
    // Verify the SQL signature: alert_type binding + open/acknowledged
    // status guard + ASC ordering by created_at.
    const select = captured.find((q) => /FROM ai_alerts/i.test(q.sql));
    suite.expect(select != null, "a SELECT query was issued");
    suite.expect(
      select?.sql.includes("status IN ('open', 'acknowledged')") ?? false,
      "filters by open/acknowledged status",
    );
    suite.expect(
      select?.sql.includes("ORDER BY created_at ASC") ?? false,
      "orders oldest-first so flap-prevention windows are predictable",
    );
    suite.expectEqual(
      select?.params[0],
      "tool_health",
      "alert_type param bound",
    );
    // No olderThanMinutes → only one positional param.
    suite.expectEqual(
      select?.params.length,
      1,
      "only the alert_type param is bound",
    );
    // The MAKE_INTERVAL clause must NOT appear unless olderThanMinutes is set.
    suite.expect(
      !(select?.sql.includes("MAKE_INTERVAL") ?? false),
      "no cooldown clause when olderThanMinutes is omitted",
    );
  },
);

await suite.test(
  "(o2) getOpenAlertsByType passes olderThanMinutes through to the SQL cutoff",
  async () => {
    resetCapturedQueries();
    setQueryHandler((q) => {
      if (/FROM ai_alerts/i.test(q.sql)) return { rows: [] };
      return undefined;
    });

    await getOpenAlertsByType("tool_health", { olderThanMinutes: 240 });
    const select = captured.find((q) => /FROM ai_alerts/i.test(q.sql));
    suite.expect(select != null, "SELECT issued");
    suite.expect(
      select?.sql.includes("MAKE_INTERVAL(mins => $2)") ?? false,
      "uses MAKE_INTERVAL with the second positional param",
    );
    suite.expect(
      select?.sql.includes("created_at <= NOW()") ?? false,
      "applies the created_at cutoff",
    );
    suite.expectEqual(
      select?.params[0],
      "tool_health",
      "alert_type param bound",
    );
    suite.expectEqual(select?.params[1], 240, "olderThanMinutes param bound");
    suite.expectEqual(select?.params.length, 2, "exactly two params bound");
  },
);

// ─── getToolsWithCallsInWindow (DB helper, isolated via pg.Pool stub) ───────

await suite.test(
  "(t1) getToolsWithCallsInWindow returns a Set of distinct tool names",
  async () => {
    resetCapturedQueries();
    setQueryHandler((q) => {
      if (
        /FROM ai_call_metrics/i.test(q.sql) &&
        /DISTINCT tool_name/.test(q.sql)
      ) {
        return {
          rows: [
            { tool_name: "tool_a" },
            { tool_name: "tool_b" },
            { tool_name: "tool_c" },
          ],
        };
      }
      return undefined;
    });

    const active = await getToolsWithCallsInWindow(60);
    suite.expect(active instanceof Set, "result is a Set");
    suite.expectEqual(active.size, 3, "three distinct tool names returned");
    suite.expect(active.has("tool_a"), "set contains tool_a");
    suite.expect(active.has("tool_b"), "set contains tool_b");
    suite.expect(active.has("tool_c"), "set contains tool_c");

    const select = captured.find(
      (q) =>
        /FROM ai_call_metrics/i.test(q.sql) && /DISTINCT tool_name/.test(q.sql),
    );
    suite.expect(
      select != null,
      "SELECT DISTINCT issued against ai_call_metrics",
    );
    suite.expect(
      select?.sql.includes("MAKE_INTERVAL(mins => $1)") ?? false,
      "windowMinutes bound through MAKE_INTERVAL",
    );
    suite.expect(
      select?.sql.includes("tool_name IS NOT NULL") ?? false,
      "filters out NULL tool_name rows",
    );
    suite.expectEqual(select?.params[0], 60, "windowMinutes param bound");
    suite.expectEqual(select?.params.length, 1, "exactly one positional param");
  },
);

await suite.test(
  "(t2) getToolsWithCallsInWindow returns an empty Set when no rows match",
  async () => {
    resetCapturedQueries();
    setQueryHandler((q) => {
      if (
        /FROM ai_call_metrics/i.test(q.sql) &&
        /DISTINCT tool_name/.test(q.sql)
      ) {
        return { rows: [] };
      }
      return undefined;
    });

    const active = await getToolsWithCallsInWindow(15);
    suite.expect(active instanceof Set, "still returns a Set");
    suite.expectEqual(
      active.size,
      0,
      "empty when no tool was active in the window",
    );
  },
);

await suite.test(
  "(t3) getToolsWithCallsInWindow propagates query failures (fail-closed for the sweep)",
  async () => {
    resetCapturedQueries();
    setQueryHandler((q) => {
      if (
        /FROM ai_call_metrics/i.test(q.sql) &&
        /DISTINCT tool_name/.test(q.sql)
      ) {
        throw new Error("connection refused");
      }
      return undefined;
    });

    let threw: Error | null = null;
    try {
      await getToolsWithCallsInWindow(60);
    } catch (err) {
      threw = err as Error;
    }
    suite.expect(
      threw != null && threw.message.includes("connection refused"),
      "DB failure surfaces as an exception so the silent sweep can abort " +
        "instead of treating 'no tools active' as truth and resolving every alert",
    );
  },
);

suite.finishOrExit();
