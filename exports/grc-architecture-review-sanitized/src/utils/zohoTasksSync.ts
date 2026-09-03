/**
 * Zoho Tasks bulk sync.
 *
 * WHY THIS EXISTS
 * ---------------
 * SDR-KPI-11 (Follow-Up Compliance), SALES-KPI-07 (Follow-Up Effectiveness) and
 * SALES-KPI-08 (First-Contact SLA) all measure follow-up discipline, which
 * lives in Zoho's Tasks module. Nothing synced Tasks, so all three could only
 * ever render "--".
 *
 * The per-record reader (zohoActivitiesReader) cannot power a KPI: it costs one
 * Zoho request per parent record, which is exactly why the Sales cycle times
 * are excluded from the interactive recalculate. A KPI over thousands of deals
 * needs the data LOCAL. This module pulls Tasks in bulk once, then the
 * calculators are plain SQL.
 *
 * WINDOWING — If-Modified-Since, never `criteria`
 * -----------------------------------------------
 * Zoho honours `criteria` only on /search, which cannot sort and rejects
 * `greater_than` on Created_Time ("400 - Invalid query formed"). The list
 * endpoint plus the If-Modified-Since header is the mechanism that actually
 * works, and it is what zohoCRM.ts documents. Same lesson the Calls import
 * learned the hard way.
 *
 * LINKAGE
 * -------
 * Zoho links an activity through two lookups, and which one holds the parent
 * depends on the module:
 *   Who_Id  -> Lead or Contact
 *   What_Id -> Deal or Account
 * `$se_module` names the What_Id module. Both are stored raw so a calculator
 * can join on whichever it needs; neither is assumed to be present.
 */
import { createRedactedPool } from "./redactedPool";
import { normalizeSslMode } from "./normalizeDatabaseUrl";
import { fetchAllZohoRecords, getZohoConnectionStatus } from "./zohoCRM";
import { logger } from "./logger";

const pool = createRedactedPool({
  connectionString: normalizeSslMode(process.env.DATABASE_URL),
});

/** Zoho's only "this task is finished" status. Everything else is open. */
export const TASK_CLOSED_STATUSES = new Set(["Completed"]);

let tablesReady = false;

export async function ensureZohoTaskTables(): Promise<void> {
  if (tablesReady) return;
  // Canonical CREATE TABLE carries every column — no ALTER ADD COLUMN, so the
  // strict schema-parity gate has nothing to drift against.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS zoho_tasks (
      id SERIAL PRIMARY KEY,
      zoho_task_id VARCHAR(100) NOT NULL UNIQUE,
      subject TEXT,
      status VARCHAR(100),
      priority VARCHAR(50),
      due_date DATE,
      closed_time TIMESTAMP,
      owner_name VARCHAR(255),
      owner_email VARCHAR(255),
      who_id VARCHAR(100),
      who_name VARCHAR(500),
      what_id VARCHAR(100),
      what_name VARCHAR(500),
      se_module VARCHAR(50),
      description TEXT,
      created_time TIMESTAMP,
      modified_time TIMESTAMP,
      raw_data JSONB,
      synced_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // who_id/what_id are the join keys every calculator uses; due_date and status
  // drive the on-time tests.
  for (const sql of [
    `CREATE INDEX IF NOT EXISTS idx_zoho_tasks_who ON zoho_tasks(who_id) WHERE who_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_zoho_tasks_what ON zoho_tasks(what_id) WHERE what_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_zoho_tasks_status ON zoho_tasks(status)`,
    `CREATE INDEX IF NOT EXISTS idx_zoho_tasks_due ON zoho_tasks(due_date)`,
  ]) {
    await pool.query(sql);
  }
  tablesReady = true;
}

export interface ZohoTasksSyncResult {
  scanned: number;
  imported_new: number;
  updated_existing: number;
  <REDACTED_TOKEN>: number;
  errors: number;
  error_samples: string[];
  duration_ms: number;
  since: string;
  /** How the fetched tasks were linked — the check that says whether the
   *  follow-up KPIs will have anything to measure. */
  linkage: { who: number; what: number; both: number; none: number };
}

/** Zoho lookups arrive as {id,name} objects, or occasionally a bare string. */
function readLookup(v: any): { id: string | null; name: string | null } {
  if (!v) return { id: null, name: null };
  if (typeof v === "string") return { id: null, name: v.trim() || null };
  return {
    id: v.id ? String(v.id) : null,
    name: typeof v.name === "string" ? v.name.trim() || null : null,
  };
}

function readDate(v: any): string | null {
  if (!v || typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function runZohoTasksSync(
  options: { sinceIso?: string; maxRecords?: number } = {},
): Promise<ZohoTasksSyncResult> {
  const t0 = Date.now();
  const maxRecords = options.maxRecords ?? 5000;
  const sinceIso =
    options.sinceIso ??
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const result: ZohoTasksSyncResult = {
    scanned: 0,
    imported_new: 0,
    updated_existing: 0,
    <REDACTED_TOKEN>: 0,
    errors: 0,
    error_samples: [],
    duration_ms: 0,
    since: sinceIso,
    linkage: { who: 0, what: 0, both: 0, none: 0 },
  };

  // Gate on CONFIGURED, not CONNECTED — `connected` only means a token is
  // already warm in this process, so gating on it made the first run after
  // every restart fail spuriously. Same fix the Calls import needed.
  const conn = getZohoConnectionStatus();
  if (!conn.configured) {
    result.errors = 1;
    result.error_samples.push(
      "Zoho is not configured — set the Zoho OAuth credentials (or ZOHO_ACCESS_TOKEN) before syncing tasks.",
    );
    result.duration_ms = Date.now() - t0;
    return result;
  }
  if (conn.rateLimited) {
    result.errors = 1;
    result.error_samples.push(conn.message);
    result.duration_ms = Date.now() - t0;
    return result;
  }

  await ensureZohoTaskTables();

  let tasks: any[] = [];
  try {
    tasks = await fetchAllZohoRecords("Tasks", {
      fields: [
        "Subject", "Status", "Priority", "Due_Date", "Owner", "Description",
        "Who_Id", "What_Id", "Created_Time", "Modified_Time", "Closed_Time",
      ],
      ifModifiedSince: sinceIso,
      maxRecords,
      sortBy: "Modified_Time",
      sortOrder: "desc",
    });
  } catch (err: any) {
    result.errors++;
    result.error_samples.push(`Zoho fetch failed: ${err?.message || String(err)}`);
    result.duration_ms = Date.now() - t0;
    return result;
  }

  for (const rec of tasks) {
    if (result.scanned >= maxRecords) break;
    const d: any = (rec as any).data || {};
    const zohoId = String((rec as any).id || d.id || "").trim();
    if (!zohoId) continue;
    result.scanned++;

    const who = readLookup(d.Who_Id);
    const what = readLookup(d.What_Id);
    const owner = readLookup(d.Owner);

    // Linkage census. A task attached to neither a Who nor a What cannot be
    // attributed to a lead or a deal, so no follow-up KPI can use it — counted
    // rather than silently dropped, because a high `none` is the signal that
    // these KPIs will not measure anything useful.
    if (who.id && what.id) result.linkage.both++;
    else if (who.id) result.linkage.who++;
    else if (what.id) result.linkage.what++;
    else {
      result.linkage.none++;
      result.<REDACTED_TOKEN>++;
    }

    try {
      const r = await pool.query(
        `INSERT INTO zoho_tasks (
           zoho_task_id, subject, status, priority, due_date, closed_time,
           owner_name, owner_email, who_id, who_name, what_id, what_name,
           se_module, description, created_time, modified_time, raw_data, synced_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
         ON CONFLICT (zoho_task_id) DO UPDATE SET
           subject = EXCLUDED.subject, status = EXCLUDED.status,
           priority = EXCLUDED.priority, due_date = EXCLUDED.due_date,
           closed_time = EXCLUDED.closed_time, owner_name = EXCLUDED.owner_name,
           owner_email = EXCLUDED.owner_email, who_id = EXCLUDED.who_id,
           who_name = EXCLUDED.who_name, what_id = EXCLUDED.what_id,
           what_name = EXCLUDED.what_name, se_module = EXCLUDED.se_module,
           description = EXCLUDED.description, created_time = EXCLUDED.created_time,
           modified_time = EXCLUDED.modified_time, raw_data = EXCLUDED.raw_data,
           synced_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [
          zohoId,
          typeof d.Subject === "string" ? d.Subject : null,
          typeof d.Status === "string" ? d.Status : null,
          typeof d.Priority === "string" ? d.Priority : null,
          readDate(d.Due_Date),
          readDate(d.Closed_Time),
          owner.name,
          typeof d.Owner?.email === "string" ? d.Owner.email.toLowerCase() : null,
          who.id, who.name, what.id, what.name,
          typeof d.$se_module === "string" ? d.$se_module : null,
          typeof d.Description === "string" ? d.Description : null,
          readDate(d.Created_Time),
          readDate(d.Modified_Time),
          JSON.stringify(d),
        ],
      );
      // xmax = 0 marks a fresh INSERT; anything else was an UPDATE.
      if (r.rows[0]?.inserted) result.imported_new++;
      else result.updated_existing++;
    } catch (e: any) {
      result.errors++;
      if (result.error_samples.length < 5) {
        result.error_samples.push(`task ${zohoId}: ${e?.message || String(e)}`);
      }
    }
  }

  result.duration_ms = Date.now() - t0;
  logger.info("[ZohoTasksSync] complete", {
    scanned: result.scanned,
    new: result.imported_new,
    updated: result.updated_existing,
    linkage: result.linkage,
    errors: result.errors,
    ms: result.duration_ms,
  });
  return result;
}

/** Quick census for deciding whether the follow-up KPIs have data to measure. */
export async function getZohoTaskStats(): Promise<{
  total: number;
  linked_to_leads_or_contacts: number;
  linked_to_deals_or_accounts: number;
  open: number;
  closed: number;
  with_due_date: number;
  last_synced_at: string | null;
}> {
  await ensureZohoTaskTables();
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE who_id IS NOT NULL)::int AS who_linked,
            COUNT(*) FILTER (WHERE what_id IS NOT NULL)::int AS what_linked,
            COUNT(*) FILTER (WHERE status IS NULL OR status <> 'Completed')::int AS open,
            COUNT(*) FILTER (WHERE status = 'Completed')::int AS closed,
            COUNT(*) FILTER (WHERE due_date IS NOT NULL)::int AS with_due,
            to_char(MAX(synced_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_synced_at
       FROM zoho_tasks`,
  );
  const x = r.rows[0] || {};
  return {
    total: Number(x.total) || 0,
    linked_to_leads_or_contacts: Number(x.who_linked) || 0,
    linked_to_deals_or_accounts: Number(x.what_linked) || 0,
    open: Number(x.open) || 0,
    closed: Number(x.closed) || 0,
    with_due_date: Number(x.with_due) || 0,
    last_synced_at: x.last_synced_at ?? null,
  };
}
