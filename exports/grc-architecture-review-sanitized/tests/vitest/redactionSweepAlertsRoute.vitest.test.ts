/**
 * Vitest coverage for GET /api/admin/redaction-sweep/alerts (Task #656).
 *
 * Asserts the endpoint:
 *   1. Joins each notification with the matching event_logs row by parsing
 *      the sweep_timestamp out of the message body and looking up
 *      `new_value->>'sweep_timestamp'` so the dashboard can render
 *      per-table count badges (including ai_call_metrics, which the alert
 *      message itself does not carry).
 *   2. Falls back to parsing the four counts that the dispatcher does
 *      embed in the message when the event_logs join misses (e.g. an
 *      older alert whose audit row aged out of the partitioned table).
 *   3. Tags each row with `triggers_source` so the UI can show whether
 *      counts came from the join or from the message text.
 *
 * Uses the same `pg` mock pattern as tests/vitest/tablefApiRoutes — both
 * `notifications` and `event_logs` queries hit the in-test `mockQuery`
 * stub so we can pre-load deterministic rows without a live DB.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { adminApiRoutes } from "../../src/mastra/routes/adminApiRoutes";
import { buildHandler, makeContext } from "../_helpers/fakeContext";

const { mockQuery, mockEnd, mockConnect } = vi.hoisted(() => {
  const q = vi.fn();
  const e = vi.fn().mockResolvedValue(undefined);
  // `redactedPool` wraps `pool.connect.bind(pool)` at module-load time
  // (via the rbacMiddleware → rbacDatabase → redactedPool import chain),
  // so the Pool stub must expose a callable `connect`. The route under
  // test never actually calls connect() — it only uses pool.query — so a
  // no-op stub is sufficient.
  const c = vi.fn().mockResolvedValue({ query: q, release: vi.fn() });
  return { mockQuery: q, mockEnd: e, mockConnect: c };
});

vi.mock("pg", () => {
  const PoolMock = vi.fn(function (this: any) {
    return { query: mockQuery, end: mockEnd, connect: mockConnect };
  });
  return { Pool: PoolMock, default: { Pool: PoolMock } };
});

// The route dynamically imports notificationHub.initNotificationTables
// purely to ensure the schema exists. Stub it so the test does not need
// a real DB to bootstrap the table.
vi.mock("../../src/utils/notificationHub", () => ({
  initNotificationTables: vi.fn().mockResolvedValue(undefined),
}));

const ADMIN_KEY = "vitest-admin-key-task-656";
const AUTH_HEADERS = { "X-Admin-Key": ADMIN_KEY };

beforeEach(() => {
  process.env.ADMIN_API_KEY = ADMIN_KEY;
  vi.clearAllMocks();
  mockEnd.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.ADMIN_API_KEY;
});

describe("GET /api/admin/redaction-sweep/alerts — Task #656 enrichment", () => {
  test("joins event_logs and returns per-table counts incl. ai_call_metrics + event_log_id", async () => {
    const sweepTs = "2026-04-25T10:15:00.000Z";
    const message =
      `Boot-time redaction sweep at ${sweepTs} rewrote one or more historical rows. ` +
      `A non-zero count on nc_change_history or capa_change_history usually means a database ` +
      `restore from a pre-fix backup reintroduced leaked credentials — investigate the source ` +
      `backup immediately. Per-table counts: event_logs=4, nc_change_history=2, ` +
      `capa_change_history=1, ai_pending_actions=0.`;

    const notifRow = {
      id: 42,
      title: "Post-restore redaction sweep rewrote historical rows",
      message,
      module: "security/redaction-sweep",
      priority: "critical",
      channel: "email",
      status: "unread",
      recipient: "<REDACTED_EMAIL>",
      related_entity_type: "SYSTEM",
      related_entity_id: "boot_redaction_sweep",
      action_url: "/audit-logs",
      sent_at: null,
      read_at: null,
      created_at: sweepTs,
    };

    mockQuery
      // 1) COUNT(*)
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      // 2) page of notifications
      .mockResolvedValueOnce({ rows: [notifRow] })
      // 3) event_logs join
      .mockResolvedValueOnce({
        rows: [
          {
            id: "9001",
            new_value: {
              sweep_timestamp: sweepTs,
              event_logs_updated: 4,
              nc_change_history_updated: 2,
              capa_change_history_updated: 1,
              ai_pending_actions: { rows_updated: 0 },
              ai_call_metrics: { rows_updated: 7 },
            },
          },
        ],
      });

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/redaction-sweep/alerts",
      "GET",
    );
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS }),
    );

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(Array.isArray(res.body.notifications)).toBe(true);
    const enriched = res.body.notifications[0];
    expect(enriched.id).toBe(42);
    expect(enriched.recipient).toBe("<REDACTED_EMAIL>");
    expect(enriched.channel).toBe("email");
    expect(enriched.event_log_id).toBe("9001");
    expect(enriched.sweep_timestamp).toBe(sweepTs);
    expect(enriched.triggers_source).toBe("event_logs");
    // ai_call_metrics MUST come from the join — it is not in the message.
    expect(enriched.triggers).toEqual({
      event_logs: { count: 4, skipped: null },
      nc_change_history: { count: 2, skipped: null },
      capa_change_history: { count: 1, skipped: null },
      ai_pending_actions: { count: 0, skipped: null },
      ai_call_metrics: { count: 7, skipped: null },
    });

    // Verify the join query was issued with the parsed sweep_timestamp.
    const joinCall = mockQuery.mock.calls[2];
    expect(joinCall[0]).toMatch(
      /new_value->>'sweep_timestamp' = ANY\(\$3::text\[\]\)/,
    );
    expect(joinCall[1]).toEqual([
      "security/redaction-sweep",
      "boot_redaction_sweep",
      [sweepTs],
    ]);
  });

  test("falls back to parsing counts from message when event_logs join misses", async () => {
    const sweepTs = "2026-04-20T08:00:00.000Z";
    const message =
      `Boot-time redaction sweep at ${sweepTs} rewrote one or more historical rows. ` +
      `Per-table counts: event_logs=11, nc_change_history=0, capa_change_history=3, ai_pending_actions=2.`;

    const notifRow = {
      id: 7,
      title: "Post-restore redaction sweep rewrote historical rows",
      message,
      module: "security/redaction-sweep",
      priority: "critical",
      channel: "in_app",
      status: "read",
      recipient: null,
      related_entity_type: "SYSTEM",
      related_entity_id: "boot_redaction_sweep",
      action_url: "/audit-logs",
      sent_at: sweepTs,
      read_at: sweepTs,
      created_at: sweepTs,
    };

    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [notifRow] })
      // No matching event_logs row.
      .mockResolvedValueOnce({ rows: [] });

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/redaction-sweep/alerts",
      "GET",
    );
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS }),
    );

    expect(res.status).toBe(200);
    const enriched = res.body.notifications[0];
    expect(enriched.event_log_id).toBeNull();
    expect(enriched.triggers_source).toBe("message");
    expect(enriched.triggers).toEqual({
      event_logs: { count: 11, skipped: null },
      nc_change_history: { count: 0, skipped: null },
      capa_change_history: { count: 3, skipped: null },
      ai_pending_actions: { count: 2, skipped: null },
      // ai_call_metrics is not in the message — the UI surfaces "?" so
      // operators know to open the linked event_logs row to find it.
      ai_call_metrics: { count: null, skipped: null },
    });
  });

  test("propagates skipped variant ({ skipped: ... }) so the UI can mark it dashed", async () => {
    const sweepTs = "2026-04-22T11:00:00.000Z";
    const message =
      `Boot-time redaction sweep at ${sweepTs} rewrote one or more historical rows. ` +
      `Per-table counts: event_logs=1, nc_change_history=0, capa_change_history=0, ai_pending_actions=0.`;

    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 99,
            title: "Post-restore redaction sweep rewrote historical rows",
            message,
            module: "security/redaction-sweep",
            priority: "critical",
            channel: "ChatProvider",
            status: "unread",
            recipient: "#ops-alerts",
            related_entity_type: "SYSTEM",
            related_entity_id: "boot_redaction_sweep",
            action_url: "/audit-logs",
            sent_at: null,
            read_at: null,
            created_at: sweepTs,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "9999",
            new_value: {
              sweep_timestamp: sweepTs,
              event_logs_updated: 1,
              nc_change_history_updated: 0,
              capa_change_history_updated: 0,
              ai_pending_actions: { skipped: "table_missing" },
              ai_call_metrics: { skipped: "table_missing" },
            },
          },
        ],
      });

    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/redaction-sweep/alerts",
      "GET",
    );
    const res = await handler(
      makeContext({ method: "GET", headers: AUTH_HEADERS }),
    );

    expect(res.status).toBe(200);
    const enriched = res.body.notifications[0];
    expect(enriched.triggers.ai_pending_actions).toEqual({
      count: null,
      skipped: "table_missing",
    });
    expect(enriched.triggers.ai_call_metrics).toEqual({
      count: null,
      skipped: "table_missing",
    });
  });

  test("403s when the caller is not an admin", async () => {
    const handler = await buildHandler(
      adminApiRoutes,
      "/api/admin/redaction-sweep/alerts",
      "GET",
    );
    const res = await handler(makeContext({ method: "GET" }));
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
