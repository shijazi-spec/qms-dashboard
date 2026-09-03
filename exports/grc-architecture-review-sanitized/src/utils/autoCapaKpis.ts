/**
 * KPI rollup over auto-created CAPAs from the Duplicate Radar (CS-overlap +
 * CS-lifecycle). Lets Quality leadership see at a glance whether the
 * automated corrective actions are actually being worked + closed, not
 * just opened.
 *
 * Source types tracked:
 *   - 'cs_overlap_block'         (Option B  — high-ARR BLOCK clusters)
 *   - 'cs_lifecycle_violation'   (Phase 5  — critical lifecycle violations)
 *
 * Metrics:
 *   - open_count            currently-open auto-CAPAs (status not closed/cancelled)
 *   - closed_last_30d       count of CAPAs closed in the trailing 30 days
 *   - avg_days_to_close     mean completion_date - created_at over closed-30d
 *   - median_days_to_close  median over the same set
 *   - sla_hit_rate          % of closed-30d where completion_date <= target_date
 *   - aging_buckets         for currently-open CAPAs: 0-3 / 4-7 / 8-14 / 15+ days old
 *   - by_source_type        same metrics split per source_type
 *   - trend_30d             daily series of opened auto-CAPAs over the last 30 days
 *
 * Pure DB layer — single utility module, no caching. Volume is bounded (few
 * dozen rows in production), so even ad-hoc dashboard hits are sub-100ms.
 */

import { pool } from "./duplicateRadarDatabase";

export const AUTO_CAPA_SOURCE_TYPES = [
  "cs_overlap_block",
  "cs_lifecycle_violation",
] as const;
export type AutoCapaSourceType = (typeof AUTO_CAPA_SOURCE_TYPES)[number];

export interface AutoCapaAgingBuckets {
  d0_3: number;
  d4_7: number;
  d8_14: number;
  d15_plus: number;
}

export interface AutoCapaSourceKpis {
  open_count: number;
  closed_last_30d: number;
  avg_days_to_close: number | null;
  median_days_to_close: number | null;
  sla_hit_rate: number | null; // 0-1
  aging_buckets: AutoCapaAgingBuckets;
}

export interface AutoCapaKpisResponse {
  generated_at: string;
  window_days: 30;
  totals: AutoCapaSourceKpis;
  by_source_type: Record<AutoCapaSourceType, AutoCapaSourceKpis>;
  trend_30d: Array<{ date: string; opened: number }>;
}

interface CapaRow {
  id: number;
  source_type: string;
  status: string;
  created_at: Date | string;
  target_date: Date | string | null;
  completion_date: Date | string | null;
}

function toDate(v: Date | string | null | undefined): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function emptyKpis(): AutoCapaSourceKpis {
  return {
    open_count: 0,
    closed_last_30d: 0,
    avg_days_to_close: null,
    median_days_to_close: null,
    sla_hit_rate: null,
    aging_buckets: { d0_3: 0, d4_7: 0, d8_14: 0, d15_plus: 0 },
  };
}

/**
 * Pure rollup — takes a list of CAPA rows (already filtered to the source
 * types and time window in scope) and produces the metrics. Extracted so
 * tests can validate the math against fixtures without a database.
 */
export function rollupAutoCapaKpis(
  rows: CapaRow[],
  now: Date = new Date(),
): AutoCapaSourceKpis {
  const out = emptyKpis();
  const closedDurations: number[] = [];
  let slaHits = 0;
  let slaEligible = 0;

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400 * 1000);

  for (const r of rows) {
    const created = toDate(r.created_at);
    const completed = toDate(r.completion_date);
    const target = toDate(r.target_date);
    const isOpen = !["closed", "cancelled"].includes(r.status);

    if (isOpen) {
      out.open_count++;
      if (created) {
        const age = daysBetween(created, now);
        if (age <= 3) out.aging_buckets.d0_3++;
        else if (age <= 7) out.aging_buckets.d4_7++;
        else if (age <= 14) out.aging_buckets.d8_14++;
        else out.aging_buckets.d15_plus++;
      }
    } else if (
      r.status === "closed" &&
      completed &&
      completed.getTime() >= thirtyDaysAgo.getTime()
    ) {
      out.closed_last_30d++;
      if (created) {
        const dur = daysBetween(created, completed);
        closedDurations.push(dur);
        if (target) {
          slaEligible++;
          if (completed.getTime() <= target.getTime()) slaHits++;
        }
      }
    }
  }

  if (closedDurations.length > 0) {
    out.avg_days_to_close =
      closedDurations.reduce((s, x) => s + x, 0) / closedDurations.length;
    out.median_days_to_close = median(closedDurations);
  }
  if (slaEligible > 0) {
    out.sla_hit_rate = slaHits / slaEligible;
  }

  return out;
}

/**
 * Pull every auto-CAPA row + compute totals, per-source-type, and the
 * 30-day opened trend in three small queries.
 */
export async function getAutoCapaKpis(opts: {
  windowDays?: 30;
  now?: Date;
} = {}): Promise<AutoCapaKpisResponse> {
  const now = opts.now ?? new Date();

  // Single fetch — we partition in JS rather than running 4 separate
  // grouped aggregates. Row count is bounded.
  const rowsR = await pool.query<CapaRow>(
    `SELECT id, source_type, status, created_at, target_date, completion_date
       FROM capa_records
      WHERE source_type = ANY($1::text[])`,
    [Array.from(AUTO_CAPA_SOURCE_TYPES)],
  );
  const rows = rowsR.rows;

  const totals = rollupAutoCapaKpis(rows, now);
  const by_source_type: Record<AutoCapaSourceType, AutoCapaSourceKpis> = {
    cs_overlap_block: rollupAutoCapaKpis(
      rows.filter((r) => r.source_type === "cs_overlap_block"),
      now,
    ),
    cs_lifecycle_violation: rollupAutoCapaKpis(
      rows.filter((r) => r.source_type === "cs_lifecycle_violation"),
      now,
    ),
  };

  // Trend — opened per day over last 30 days, including zero-days.
  const trendR = await pool.query<{ d: string; opened: number }>(
    `WITH days AS (
        SELECT generate_series(
                 (NOW() AT TIME ZONE 'UTC')::date - INTERVAL '29 days',
                 (NOW() AT TIME ZONE 'UTC')::date,
                 INTERVAL '1 day'
               )::date AS d
      )
      SELECT to_char(d, 'YYYY-MM-DD') AS d,
             COALESCE(c.opened, 0)::int AS opened
        FROM days
   LEFT JOIN (
        SELECT date_trunc('day', created_at AT TIME ZONE 'UTC')::date AS day,
               COUNT(*)::int AS opened
          FROM capa_records
         WHERE source_type = ANY($1::text[])
           AND created_at >= NOW() - INTERVAL '30 days'
         GROUP BY 1
      ) c ON c.day = days.d
      ORDER BY days.d ASC`,
    [Array.from(AUTO_CAPA_SOURCE_TYPES)],
  );
  const trend_30d = trendR.rows.map((r) => ({
    date: r.d,
    opened: r.opened,
  }));

  return {
    generated_at: now.toISOString(),
    window_days: 30,
    totals,
    by_source_type,
    trend_30d,
  };
}
