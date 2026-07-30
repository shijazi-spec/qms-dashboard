import { classifySegmentFromLayout } from "./duplicateRadarSegment";

export interface ResolveRowRaw { module: string; survivor_present: boolean; layout: string | null; dup_count: number; }
export interface CleaningProgressModule { outstanding: number; verified_merges: number; est_records_removed: number; empty_deleted: number; }
export interface DataCleaningProgress {
  segment: string; generated_at: string; last_sync_at: string | null;
  modules: { Deals: CleaningProgressModule; Accounts: CleaningProgressModule };
  unknown_segment: { verified_merges: number; est_records_removed: number };
  empty_deleted_all_segments: true;
  trend: { days: number; segment: string; series: any[]; first: any | null; latest: any | null };
}

export function shapeCleaningProgress(input: {
  segment: string; generatedAt: string; lastSyncAt: string | null;
  resolveRows: ResolveRowRaw[];
  emptyDeleted: Record<"Deals" | "Accounts", number>;
  outstanding: Record<"Deals" | "Accounts", number>;
  trend: DataCleaningProgress["trend"];
}): DataCleaningProgress {
  const mk = (m: "Deals" | "Accounts"): CleaningProgressModule => ({
    outstanding: input.outstanding[m] || 0,
    verified_merges: 0,
    est_records_removed: 0,
    empty_deleted: input.emptyDeleted[m] || 0,
  });
  const modules = { Deals: mk("Deals"), Accounts: mk("Accounts") };
  const unknown = { verified_merges: 0, est_records_removed: 0 };

  for (const row of input.resolveRows) {
    const mod = row.module === "Deals" || row.module === "Accounts" ? row.module : null;
    if (!mod) continue;
    if (!row.survivor_present) {
      unknown.verified_merges += 1;
      unknown.est_records_removed += row.dup_count || 0;
      continue;
    }
    const seg = classifySegmentFromLayout(row.layout);
    if (input.segment !== "all" && seg !== input.segment) continue;
    modules[mod].verified_merges += 1;
    modules[mod].est_records_removed += row.dup_count || 0;
  }

  return {
    segment: input.segment,
    generated_at: input.generatedAt,
    last_sync_at: input.lastSyncAt,
    modules,
    unknown_segment: unknown,
    empty_deleted_all_segments: true,
    trend: input.trend,
  };
}
