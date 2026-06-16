/**
 * KPI auto-calculation engine — records live values into kpi_values so the /kpis
 * page shows real numbers + RAG status instead of "--".
 *
 * Sources reused (no new metric logic invented here):
 *  - Quality / GRC: the leadership feed (buildLeadershipKpiFeed) already computes
 *    these from the platform's own data (audits, findings, risks, obligations,
 *    policies, vendor remediations). We map each feed result to the matching
 *    canonical scorecard KPI *by meaning* (codes diverge between the two schemes)
 *    and record the raw value; the KPI definition's own thresholds set the RAG.
 *  - Checklist-mode KPIs: value = % of checklist items done (kpiChecklistDatabase).
 *  - SDR / Sales: process-derived values are wired in Phases B & C; this engine
 *    already records whatever those produce via the same recordKPIValue path.
 *
 * Manual-mode KPIs are never given a fake value — they stay "--" until entered.
 */
import { logger } from "./logger";
import {
  pool,
  getKPIByCode,
  recordKPIValue,
} from "./kpiDatabase";
import { recordChecklistKPIValue } from "./kpiChecklistDatabase";
import { buildLeadershipKpiFeed } from "./leadershipKpiFeed";
import { computeProcessKPIs } from "./kpiProcessCalc";

/**
 * Canonical scorecard code → leadership-feed code, matched by what the metric
 * MEANS (not by code — the two schemes reuse the same numbers for different
 * metrics, e.g. feed GRC-KPI-009 = Risk Assessment Coverage but canonical
 * GRC-KPI-009 = High-Risk Items with Treatment Plan).
 */
const CANONICAL_TO_FEED: Record<string, string> = {
  // Quality (Sarah)
  "QM-KPI-002": "QM-KPI-002", // Audit Execution Rate
  "QM-KPI-008": "QM-KPI-008", // BU Coverage Rate
  "QM-KPI-003": "QM-KPI-003", // Gap Closure Rate
  "QM-KPI-009": "QM-KPI-010", // Repeat Findings Rate
  "QM-KPI-006": "QM-KPI-006", // Quality↔GRC Handoff SLA ← Handoff Cycle Time
  // GRC (Maram)
  "GRC-KPI-009": "GRC-KPI-010", // High-Risk Items with Treatment Plan
  "GRC-KPI-010": "GRC-KPI-009", // Risk Assessment Coverage (BUs)
  "GRC-KPI-005": "GRC-KPI-005", // Risk Treatment On-Time Closure ← CAPA closure
  "GRC-KPI-003": "GRC-KPI-003", // Audit Evidence Readiness ← Audit & Cert Readiness
  "GRC-KPI-008": "GRC-KPI-008", // Compliance Coverage Index
  "GRC-KPI-011": "GRC-KPI-016", // Policy Review Compliance
  "GRC-KPI-006": "GRC-KPI-013", // High-Risk Vendor Findings Closure
};

export interface KPIAutoCalcResult {
  recorded: number;
  skipped: number;
  details: Array<{ code: string; value?: number; reason?: string }>;
}

/**
 * Recompute and record live KPI values. Safe to call from a cron or the /kpis
 * "Recalculate" button. Never throws on a single-KPI failure — it logs and
 * continues so one bad source can't blank the whole page.
 */
export async function runKPIAutoCalc(
  includeCycleTimes = false,
): Promise<KPIAutoCalcResult> {
  const details: KPIAutoCalcResult["details"] = [];
  let recorded = 0;
  let skipped = 0;

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  // 1) Quality / GRC via the leadership feed.
  try {
    const feed = await buildLeadershipKpiFeed();
    const byCode = new Map(feed.kpis.map((k) => [k.code, k]));
    for (const [canonicalCode, feedCode] of Object.entries(CANONICAL_TO_FEED)) {
      const def = await getKPIByCode(canonicalCode);
      if (!def || !def.is_active || !def.id) {
        skipped++;
        details.push({ code: canonicalCode, reason: "definition missing/inactive" });
        continue;
      }
      const fr = byCode.get(feedCode);
      if (!fr || !fr.data_available || fr.value === null || fr.value === undefined) {
        skipped++;
        details.push({ code: canonicalCode, reason: "no source data" });
        continue;
      }
      try {
        await recordKPIValue({
          kpi_id: def.id,
          period_start: periodStart,
          period_end: periodEnd,
          actual_value: Number(fr.value),
          calculated_by: "system_auto",
        });
        recorded++;
        details.push({ code: canonicalCode, value: Number(fr.value) });
      } catch (e) {
        skipped++;
        details.push({ code: canonicalCode, reason: `record failed: ${(e as Error).message}` });
      }
    }
  } catch (e) {
    logger.error(`[KPIAutoCalc] leadership-feed step failed: ${(e as Error).message}`);
  }

  // 2) SDR + Sales process KPIs (from the Duplicate Radar's local synced data —
  //    no live Zoho calls). Codes without a safe local source stay "--".
  try {
    const proc = await computeProcessKPIs(includeCycleTimes);
    for (const [code, result] of Object.entries(proc)) {
      const def = await getKPIByCode(code);
      if (!def || !def.is_active || !def.id) {
        skipped++;
        details.push({ code, reason: "definition missing/inactive" });
        continue;
      }
      if (!result.dataAvailable) {
        skipped++;
        details.push({ code, reason: "no synced source data" });
        continue;
      }
      try {
        await recordKPIValue({
          kpi_id: def.id,
          period_start: periodStart,
          period_end: periodEnd,
          actual_value: result.value,
          calculated_by: "system_auto",
        });
        recorded++;
        details.push({ code, value: result.value });
      } catch (e) {
        skipped++;
        details.push({ code, reason: `record failed: ${(e as Error).message}` });
      }
    }
  } catch (e) {
    logger.error(`[KPIAutoCalc] process-KPI step failed: ${(e as Error).message}`);
  }

  // 3) Checklist-mode KPIs → % of items done.
  try {
    const res = await pool.query(
      `SELECT id, kpi_code FROM kpi_definitions WHERE is_active = true AND calc_mode = 'checklist'`,
    );
    for (const row of res.rows) {
      try {
        const pct = await recordChecklistKPIValue(row.id);
        if (pct === null) {
          skipped++;
          details.push({ code: row.kpi_code, reason: "no checklist items yet" });
        } else {
          recorded++;
          details.push({ code: row.kpi_code, value: pct });
        }
      } catch (e) {
        skipped++;
        details.push({ code: row.kpi_code, reason: `checklist failed: ${(e as Error).message}` });
      }
    }
  } catch (e) {
    logger.error(`[KPIAutoCalc] checklist step failed: ${(e as Error).message}`);
  }

  logger.info(
    `📊 [KPIAutoCalc] Recorded ${recorded} live KPI value(s), skipped ${skipped} (no data/manual).`,
  );
  return { recorded, skipped, details };
}
