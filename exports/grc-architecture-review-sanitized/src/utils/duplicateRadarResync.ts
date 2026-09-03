/**
 * Targeted CRM re-sync for the Preflight check. When an operator corrects a
 * mis-tagged "client" in Zoho (e.g. clears a stale Phase / changes a stage),
 * the local duplicate_records copy is still stale until the slow full scan
 * catches up — so the company keeps BLOCKING contactable leads. This re-fetches
 * ONLY the matching companies' deals straight from Zoho, overwrites the local
 * raw_data + stage + layout, and busts the CS-client directory cache so the
 * next preflight reflects the correction in seconds.
 *
 * Shared by:
 *   - scripts/resyncCorrectedDeals.ts   (bulk, editable TARGETS list)
 *   - POST /api/duplicates/preflight/recheck   (the per-row "↻ Re-check" button)
 *
 * Read-only against Zoho (GET by id) + a local UPDATE — never writes to Zoho,
 * never deletes.
 */
import { pool } from "./duplicateRadarDatabase";
import { fetchZohoRecordById } from "./zohoCRM";
import { invalidateCsDirectoryCache } from "./duplicateRadarPreflight";

export interface ResyncTarget {
  label?: string;
  domains?: string[];
  names?: string[];
}

export interface ResyncDetail {
  id: string;
  name: string;
  status: "updated" | "not_in_zoho";
  phaseBefore?: string | null;
  phaseAfter?: string | null;
  stageBefore?: string | null;
  stageAfter?: string | null;
}

export interface ResyncResult {
  updated: number;
  missing: number;
  scanned: number;
  details: ResyncDetail[];
}

/**
 * Re-fetch and refresh the local copy of every deal that matches the given
 * companies (by exact domain OR a name LIKE). Bounded so one call can never
 * hammer the Zoho API.
 */
export async function resyncCompanyDealsFromZoho(
  targets: ResyncTarget[],
  opts?: { maxDeals?: number },
): Promise<ResyncResult> {
  const maxDeals = Math.max(1, Math.min(opts?.maxDeals ?? 120, 300));
  const out: ResyncResult = { updated: 0, missing: 0, scanned: 0, details: [] };
  const seen = new Set<string>(); // de-dupe deal ids across overlapping targets

  for (const t of targets || []) {
    const conds: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const d of t.domains || []) {
      const dom = (d || "").toString().trim().toLowerCase();
      if (!dom) continue;
      conds.push(`LOWER(domain) = $${i}`);
      params.push(dom);
      i++;
    }
    for (const n of t.names || []) {
      const nm = (n || "").toString().trim();
      if (nm.length < 3) continue;
      conds.push(`account_name ILIKE $${i}`);
      params.push(`%${nm}%`);
      i++;
      conds.push(`company_name ILIKE $${i}`);
      params.push(`%${nm}%`);
      i++;
    }
    if (!conds.length) continue;

    const q = await pool.query(
      `SELECT zoho_record_id, account_name, company_name,
              raw_data->>'Phase' AS phase,
              COALESCE(NULLIF(stage,''), raw_data->>'Stage') AS stage
         FROM duplicate_records
        WHERE record_type='deal' AND (${conds.join(" OR ")})
        LIMIT $${i}`,
      [...params, maxDeals],
    );

    for (const r of q.rows) {
      if (out.scanned >= maxDeals) break;
      const id = r.zoho_record_id as string;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.scanned++;

      const fresh: any = await fetchZohoRecordById("Deals", id).catch(() => null);
      const name = (r.account_name || r.company_name || "").toString();
      if (!fresh) {
        out.missing++;
        out.details.push({ id, name, status: "not_in_zoho" });
        continue;
      }
      const newStage = fresh.Stage ?? null;
      const newLayout = fresh.Layout?.name ?? fresh.$layout?.name ?? null;
      await pool.query(
        `UPDATE duplicate_records
            SET raw_data = $1::jsonb,
                stage = $2,
                layout_name = COALESCE($3, layout_name)
          WHERE record_type='deal' AND zoho_record_id = $4`,
        [JSON.stringify(fresh), newStage, newLayout, id],
      );
      out.updated++;
      out.details.push({
        id,
        name,
        status: "updated",
        phaseBefore: r.phase ?? null,
        phaseAfter: fresh.Phase ?? null,
        stageBefore: r.stage ?? null,
        stageAfter: newStage,
      });
    }
  }

  // Only bust the directory if something actually changed locally.
  if (out.updated > 0) invalidateCsDirectoryCache();
  return out;
}
