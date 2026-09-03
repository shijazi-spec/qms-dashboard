/**
 * Manual push of QMS KPI values to the Leadership Platform's inbound webhook.
 *
 * This is the OPPOSITE direction to the existing pull feed (/api/kpis/leadership-feed,
 * which the Leadership Platform fetches). Both can coexist; this one lets a user
 * click "Push now" and send the current values on demand.
 *
 * SECURITY: the destination URL and shared secret are NEVER hardcoded — they come
 * from HostingPlatform Secrets (PLATFORM_WEBHOOK_URL, WEBHOOK_SECRET). Without them the push
 * refuses to run. The KPI-id map defaults to the documented Leadership UUIDs but is
 * overridable via LEADERSHIP_KPI_MAP (JSON) if their ids differ.
 */
import { logger } from "./logger";

/**
 * QMS KPI code → Leadership Platform strategyItem UUID (PRODUCTION database).
 *
 * IMPORTANT dev/prod split: the leadership HostingPlatform WORKSPACE Shell and the DEPLOYED
 * app use DIFFERENT databases. A prisma query in the workspace Shell returns the
 * DEV ids (e7de0477…), but the deployed webhook the push hits runs on PROD, whose
 * ids are the ones below — proven empirically: pushing with these returned "3 ok",
 * while the dev ids 404'd. So verify UUIDs against PROD (the deployed board), never
 * the workspace Shell.
 *
 * The inbound webhook does `strategyItem.findUnique({ where: { id } })` and 404s
 * on an unknown id. All 5 GRQ KPIs exist as native records in PROD (they show on
 * the deployed board). The 3 native ids below are proven ("3 ok"); the 2 BU ids
 * are the remaining spec-doc ids — the spec doc described PROD, so its 3 proven
 * ids give high confidence in its 2 BU ids too. VERIFY on the board after the
 * first push (right value on the right row); if either 404s, get its real id from
 * PROD. Override via the LEADERSHIP_KPI_MAP env JSON.
 */
const DEFAULT_MAP: Record<string, string> = {
  "QM-KPI-002": "<REDACTED_PHONE>-4000-8000-<REDACTED_PHONE>", // Audit Execution Rate
  "GRC-KPI-008": "<REDACTED_PHONE>-4000-8000-<REDACTED_PHONE>", // Compliance Coverage Index
  "QM-KPI-015": "<REDACTED_PHONE>-4000-8000-<REDACTED_PHONE>", // BU Framework Readiness Rate
  "QM-KPI-008": "<REDACTED_PHONE>-4000-8000-<REDACTED_PHONE>", // BU Pilot Validation Completion Rate
  // GRC-KPI-002 now emits a COUNT of on-time milestones (see
  // onTimeCountFromSummary), which matches leadership's unit. Re-enable by
  // uncommenting once the full strategyItem UUID is confirmed against the
  // leadership platform — the historical "995%" came from pushing an
  // unverified mapping.
  // "GRC-KPI-002": "2f11d78d-____-____-____-____________",
};

function getMap(): Record<string, string> {
  const raw = process.env.LEADERSHIP_KPI_MAP;
  if (raw) {
    try {
      return { ...DEFAULT_MAP, ...JSON.parse(raw) };
    } catch {
      logger.error("[LeadershipPush] LEADERSHIP_KPI_MAP is not valid JSON — using defaults");
    }
  }
  return DEFAULT_MAP;
}

export interface PushOutcome {
  code: string;
  value?: number;
  ok: boolean;
  note?: string;
}
export interface PushResult {
  configured: boolean;
  error?: string;
  pushed: PushOutcome[];
  ok_count: number;
}

export async function pushToLeadership(): Promise<PushResult> {
  const url = process.env.PLATFORM_WEBHOOK_URL;
  const secret = process.env.WEBHOOK_SECRET;
  if (!url || !secret) {
    return {
      configured: false,
      error:
        "Set PLATFORM_WEBHOOK_URL and WEBHOOK_SECRET in HostingPlatform Secrets first, then republish.",
      pushed: [],
      ok_count: 0,
    };
  }

  const { buildLeadershipKpiFeed } = await import("./leadershipKpiFeed");
  const feed = await buildLeadershipKpiFeed();
  const byCode = new Map((feed.kpis || []).map((k: any) => [k.code, k]));
  const map = getMap();
  const now = new Date();
  const fiscalYear = now.getUTCFullYear();
  const periodNumber = Math.floor(now.getUTCMonth() / 3) + 1;

  const pushed: PushOutcome[] = [];
  for (const [code, kpiId] of Object.entries(map)) {
    const fr: any = byCode.get(code);
    // Staleness guard: never push a null/empty value over a real one on the board.
    if (!fr || !fr.data_available || fr.value === null || fr.value === undefined) {
      pushed.push({ code, ok: false, note: "no value / no source data — skipped" });
      continue;
    }
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-webhook-secret": secret },
        body: JSON.stringify({
          event: "kpi.update",
          <REDACTED_SCHEME> {
            kpiId,
            value: Number(fr.value),
            periodType: "QUARTERLY",
            fiscalYear,
            periodNumber,
            source: "QMS",
          },
        }),
      });
      const out: any = await res.json().catch(() => ({}));
      if (!res.ok) {
        pushed.push({ code, value: Number(fr.value), ok: false, note: `HTTP ${res.status}` });
      } else {
        pushed.push({
          code,
          value: Number(fr.value),
          ok: true,
          note: out?.skipped ? "accepted but period locked" : undefined,
        });
      }
    } catch (e) {
      pushed.push({ code, value: Number(fr.value), ok: false, note: (e as Error).message.slice(0, 60) });
    }
  }
  const ok_count = pushed.filter((p) => p.ok).length;
  logger.info(`[LeadershipPush] pushed ${ok_count}/${pushed.length} KPI(s) to leadership`);
  return { configured: true, pushed, ok_count };
}
