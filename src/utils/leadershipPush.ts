/**
 * Manual push of QMS KPI values to the Leadership Platform's inbound webhook.
 *
 * This is the OPPOSITE direction to the existing pull feed (/api/kpis/leadership-feed,
 * which the Leadership Platform fetches). Both can coexist; this one lets a user
 * click "Push now" and send the current values on demand.
 *
 * SECURITY: the destination URL and shared secret are NEVER hardcoded — they come
 * from Replit Secrets (PLATFORM_WEBHOOK_URL, WEBHOOK_SECRET). Without them the push
 * refuses to run. The KPI-id map defaults to the documented Leadership UUIDs but is
 * overridable via LEADERSHIP_KPI_MAP (JSON) if their ids differ.
 */
import { logger } from "./logger";

/**
 * QMS KPI code → Leadership Platform strategyItem UUID (PRODUCTION database).
 *
 * IMPORTANT dev/prod split: the leadership Replit WORKSPACE Shell and the DEPLOYED
 * app use DIFFERENT databases. A prisma query in the workspace Shell returns the
 * DEV ids (e7de0477…), but the deployed webhook the push hits runs on PROD, whose
 * ids are the ones below — proven empirically: pushing with these returned "3 ok",
 * while the dev ids 404'd. So verify UUIDs against PROD (the deployed board), never
 * the workspace Shell.
 *
 * Only KPIs that exist as native leadership `strategyItem` records can be pushed —
 * the inbound webhook does `strategyItem.findUnique({ where: { id } })` and 404s
 * otherwise. QM-KPI-015 (BU Framework Readiness) and QM-KPI-008 (BU Pilot
 * Validation) are intentionally OMITTED: they are not native prod records — they
 * surface on the board via the QMS pull feed. Add them here (with PROD ids) once
 * leadership creates native records. Override via the LEADERSHIP_KPI_MAP env JSON.
 */
const DEFAULT_MAP: Record<string, string> = {
  "QM-KPI-002": "c1ee6e62-ca61-4dc3-942d-4f83f208278e", // Audit Execution Rate
  "GRC-KPI-008": "73b2b61f-52e2-4bb4-88dc-15bfb3c406f1", // Compliance Coverage Index
  "GRC-KPI-002": "2f11d78d-1363-4546-bd9e-30eac23c3a5e", // Certification Milestones On-Track
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
        "Set PLATFORM_WEBHOOK_URL and WEBHOOK_SECRET in Replit Secrets first, then republish.",
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
          data: {
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
