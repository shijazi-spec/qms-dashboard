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
  // QM-KPI-009 Repeat Findings → manual (feed calc was a capture table, not findings).
  // QM-KPI-006 Handoff SLA → calcHandoffSlaCompliance (% within SLA), NOT the days-based feed calc.
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

  // 4) Roll-up composite scores — computed LAST, from the component KPIs' freshly
  //    recorded values (achievement % vs target). EMPTY until components have data.
  try {
    const comp = await recordRollupComposites();
    for (const c of comp) {
      if (c.value === undefined) {
        skipped++;
        details.push({ code: c.code, reason: c.reason });
      } else {
        recorded++;
        details.push({ code: c.code, value: c.value });
      }
    }
  } catch (e) {
    logger.error(`[KPIAutoCalc] composite step failed: ${(e as Error).message}`);
  }

  logger.info(
    `📊 [KPIAutoCalc] Recorded ${recorded} live KPI value(s), skipped ${skipped} (no data/manual).`,
  );
  return { recorded, skipped, details };
}

/** Achievement % of a KPI vs its target (direction-aware), clamped 0–100. */
function achievementPct(
  value: number,
  target: number,
  direction: string,
): number | null {
  const v = Number(value), t = Number(target);
  if (!Number.isFinite(v) || !Number.isFinite(t) || t <= 0) return null;
  const a = direction === "lower_is_better" ? (v <= 0 ? 100 : (t / v) * 100) : (v / t) * 100;
  return Math.max(0, Math.min(100, a));
}

const COMPOSITE_CODES = ["GRQ-KPI-01", "GRQ-KPI-04", "SPEC-KPI-01", "LEG-KPI-01"];

/**
 * Compute and record the 4 roll-up composites from their component KPIs'
 * achievement %. Per-owner average excludes the composites themselves. Weighted
 * composites (GRQ Health, Executive GRQ) renormalize over owners that actually
 * have data, so they reflect what's measured rather than being dragged to 0 by
 * empty registers. Each is EMPTY until at least one component has a value.
 */
async function recordRollupComposites(): Promise<
  Array<{ code: string; value?: number; reason?: string }>
> {
  const rows = await pool.query(
    `SELECT d.kpi_code, d.owner_type, d.target_value, d.threshold_direction, d.is_active,
            v.actual_value
       FROM kpi_definitions d
       LEFT JOIN LATERAL (
         SELECT actual_value FROM kpi_values vv WHERE vv.kpi_id = d.id
         ORDER BY period_end DESC, id DESC LIMIT 1
       ) v ON true
      WHERE d.is_active = true`,
  );

  // achievements grouped by owner_type (composites excluded)
  const byOwner: Record<string, number[]> = {};
  const byCode: Record<string, number | null> = {};
  for (const r of rows.rows) {
    const ach =
      r.actual_value === null || r.actual_value === undefined
        ? null
        : achievementPct(r.actual_value, r.target_value, r.threshold_direction);
    byCode[r.kpi_code] = ach;
    if (ach === null || COMPOSITE_CODES.includes(r.kpi_code)) continue;
    (byOwner[r.owner_type] ??= []).push(ach);
  }
  const avg = (xs?: number[]): number | null =>
    xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const q = avg(byOwner["quality_manager"]);
  const g = avg(byOwner["grc_manager"]);
  const s = avg(byOwner["grq_specialist"]);
  const l = avg(byOwner["legal_specialist"]);

  /** Weighted avg over the parts that have data (weights renormalized). */
  const weighted = (parts: Array<[number | null, number]>): number | null => {
    let num = 0, den = 0;
    for (const [val, w] of parts) if (val !== null) { num += val * w; den += w; }
    return den === 0 ? null : num / den;
  };

  const targets: Record<string, number | null> = {
    "GRQ-KPI-01": weighted([[q, 35], [g, 35], [s, 15], [l, 15]]),
    "GRQ-KPI-04": weighted([[q, 50], [g, 50]]),
    "SPEC-KPI-01": s,
    "LEG-KPI-01": l,
  };

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const out: Array<{ code: string; value?: number; reason?: string }> = [];
  for (const code of COMPOSITE_CODES) {
    const def = await getKPIByCode(code);
    if (!def || !def.is_active || !def.id) {
      out.push({ code, reason: "definition missing/inactive" });
      continue;
    }
    const val = targets[code];
    if (val === null || val === undefined) {
      out.push({ code, reason: "no component data yet" });
      continue;
    }
    const rounded = Math.round(val * 10) / 10;
    await recordKPIValue({
      kpi_id: def.id,
      period_start: periodStart,
      period_end: periodEnd,
      actual_value: rounded,
      calculated_by: "system_auto",
    });
    out.push({ code, value: rounded });
  }
  return out;
}
