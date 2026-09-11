import { sharedPool as pool } from "../../utils/sharedPool";
import { PLAN_VERSION, SOURCE_DOC } from "../../utils/seeds/certificationMilestonePlan";
import { logger as safeLogger } from "../../utils/logger";
import { redactSensitiveDeep } from "../../utils/sensitiveRedaction";
import {
  orderChain,
  milestoneState,
  frameworkReadiness,
  type RoadmapRow,
} from "../../utils/certificationRoadmap";
import {
  resolveEvidence,
  milestoneProgress,
  type EvidenceReading,
  type CertificationActionRef,
} from "../../utils/certificationEvidence";

export interface MilestoneRow {
  milestone_key: string;
  milestone_type: "plan" | "framework_target" | "dependency";
  certification: string;
  milestone_name: string;
  planned_date: string | null;
  delivered_date: string | null;
  status: string;
  owner: string;
  notes: string;
  regulation_code: string | null;
  depends_on_key: string | null;
  unlocks_codes: string[];
  gates_keys: string[];
}

/** One row from `certification_actions`, as returned by the route's SELECT
 * (dates already TO_CHAR'd to plain strings — see the module-level date
 * comment on the milestones query below). */
export interface CertificationActionRow {
  action_key: string;
  milestone_key: string;
  sort_order: number;
  action_text: string;
  owner: string;
  verification_mode: "auto" | "manual";
  evidence_source: string | null;
  done_at: string | null;
  done_by: string | null;
  evidence_policy_id: number | null;
  note: string | null;
  plan_version: string | null;
  source_doc: string | null;
}

export interface ActionWithReading extends CertificationActionRow {
  reading: EvidenceReading | null;
}

/** What one evidence-source query resolves to before `resolveEvidence()`
 * turns it into a verdict. Produced by the (impure) query layer below;
 * consumed by the pure `resolveEvidence()` from certificationEvidence.ts. */
export interface EvidenceCounts {
  have: number;
  total: number;
  sourceEmpty: boolean;
  sourceReadable: boolean;
}

/** Pure bucketing so the shape is stable even when a section is empty. */
export function groupMilestonesByType(rows: MilestoneRow[]) {
  const out = {
    plan: [] as MilestoneRow[],
    framework_target: [] as MilestoneRow[],
    dependency: [] as MilestoneRow[],
  };
  for (const r of rows) {
    if (r.milestone_type in out) out[r.milestone_type].push(r);
  }
  return out;
}

/**
 * Pure composition layer: turns `certification_actions` rows plus a map of
 * already-queried evidence counts (keyed by `evidence_source`) into
 * per-action readings and per-milestone progress. Deliberately takes
 * `countsBySource` as a plain object rather than a pool so this whole
 * function is unit-testable without a database — the DB-hitting part lives
 * only in `loadEvidenceCounts()` below.
 *
 * A manual action (or an auto action whose evidence_source has no entry in
 * `countsBySource`, e.g. a query that failed) gets `reading: null` — the
 * page and `milestoneProgress()` both already treat "no reading" as "not
 * done", never as "satisfied".
 */
export function buildActionsPayload(
  actions: CertificationActionRow[],
  countsBySource: Record<string, EvidenceCounts>,
): {
  actions: ActionWithReading[];
  progressByMilestone: Record<string, { done: number; total: number; complete: boolean }>;
} {
  const readings: Record<string, EvidenceReading> = {};
  for (const a of actions) {
    if (a.verification_mode === "auto" && a.evidence_source) {
      const counts = countsBySource[a.evidence_source];
      if (counts) {
        readings[a.action_key] = resolveEvidence(a.evidence_source, counts);
      } else {
        // No counts were produced for this source at all (e.g. it isn't
        // wired into loadEvidenceCounts() yet) — report it honestly as
        // unreadable rather than silently treating it as done or not-done.
        readings[a.action_key] = resolveEvidence(a.evidence_source, {
          have: 0,
          total: 0,
          sourceEmpty: false,
          sourceReadable: false,
        });
      }
    }
  }

  const withReadings: ActionWithReading[] = actions.map((a) => ({
    ...a,
    reading: readings[a.action_key] ?? null,
  }));

  const byMilestone = new Map<string, CertificationActionRef[]>();
  for (const a of actions) {
    const list = byMilestone.get(a.milestone_key) ?? [];
    list.push({ action_key: a.action_key, verification_mode: a.verification_mode, done_at: a.done_at });
    byMilestone.set(a.milestone_key, list);
  }

  const progressByMilestone: Record<string, { done: number; total: number; complete: boolean }> = {};
  for (const [mk, list] of byMilestone) {
    progressByMilestone[mk] = milestoneProgress(list, readings);
  }

  return { actions: withReadings, progressByMilestone };
}

/**
 * Pure guard for the toggle endpoint: only a `manual` action can ever be
 * hand-ticked. `auto` actions are computed live from evidence at read time
 * and must never be asserted by a human (design spec §3 / §4.4).
 */
export function canToggleAction(verificationMode: "auto" | "manual"): boolean {
  return verificationMode === "manual";
}

/**
 * Impure query layer: one query per GROUP of related evidence sources (not
 * one query per action — there are 16 auto actions but far fewer underlying
 * tables), each wrapped in its own try/catch so a single failing table
 * yields `sourceReadable: false` for just the sources in that group instead
 * of throwing the whole request. See design spec §3.1 for the source list
 * and §3.2 for the "confirmed links only" coverage rule.
 */
async function loadEvidenceCounts(db: typeof pool): Promise<Record<string, EvidenceCounts>> {
  const counts: Record<string, EvidenceCounts> = {};
  const unavailable = (): EvidenceCounts => ({
    have: 0,
    total: 0,
    sourceEmpty: false,
    sourceReadable: false,
  });

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const quarterStartMonth = Math.floor(today.getUTCMonth() / 3) * 3 + 1;
  const quarterStart = `${today.getUTCFullYear()}-${String(quarterStartMonth).padStart(2, "0")}-01`;

  // 1.1 policies.retrievable_ratio, 2.1 policies.compliance_approved_ratio —
  // "retrievable" means a row in policy_files exists, never
  // `file_name IS NOT NULL` (metadata can outlive the bytes, see
  // policyDatabase.ts:472 / policiesWithFiles()).
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM policy_files pf WHERE pf.policy_id = p.id
             ))::int AS retrievable,
             COUNT(*) FILTER (WHERE p.compliance_approved IS TRUE)::int AS approved
        FROM policies p
    `);
    const row = r.rows[0] ?? { total: 0, retrievable: 0, approved: 0 };
    const total = Number(row.total) || 0;
    counts["policies.retrievable_ratio"] = {
      have: Number(row.retrievable) || 0,
      total,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
    counts["policies.compliance_approved_ratio"] = {
      have: Number(row.approved) || 0,
      total,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error("❌ [CertificationActionsAPI] policies evidence query failed:", error);
    counts["policies.retrievable_ratio"] = unavailable();
    counts["policies.compliance_approved_ratio"] = unavailable();
  }

  // 1.2 qms_uploaded_documents.placeholder_count — satisfied only when every
  // row has resolved past 'placeholder' (i.e. gaps closed = 0 placeholders).
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE COALESCE(extraction_status, '') <> 'placeholder')::int AS resolved
        FROM qms_uploaded_documents
    `);
    const row = r.rows[0] ?? { total: 0, resolved: 0 };
    const total = Number(row.total) || 0;
    counts["qms_uploaded_documents.placeholder_count"] = {
      have: Number(row.resolved) || 0,
      total,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error(
      "❌ [CertificationActionsAPI] qms_uploaded_documents evidence query failed:",
      error,
    );
    counts["qms_uploaded_documents.placeholder_count"] = unavailable();
  }

  // 2.3 doc_tracker_documents.code_ok — a stale collector means the register
  // isn't trustworthy right now, so report "cannot read", never 0.
  try {
    const health = await db.query(`SELECT health_state FROM doc_tracker_collectors`);
    const anyStale = health.rows.some((row: any) => row.health_state === "stale");
    if (anyStale) {
      counts["doc_tracker_documents.code_ok"] = unavailable();
    } else {
      const r = await db.query(`
        SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE code_ok IS TRUE)::int AS ok
          FROM doc_tracker_documents WHERE deleted = FALSE
      `);
      const row = r.rows[0] ?? { total: 0, ok: 0 };
      const total = Number(row.total) || 0;
      counts["doc_tracker_documents.code_ok"] = {
        have: Number(row.ok) || 0,
        total,
        sourceEmpty: total === 0,
        sourceReadable: true,
      };
    }
  } catch (error) {
    safeLogger.error("❌ [CertificationActionsAPI] doc_tracker evidence query failed:", error);
    counts["doc_tracker_documents.code_ok"] = unavailable();
  }

  // 2.5 external_audits.surveillance_bv_planned, 7.1
  // external_audits.surveillance_complete. Note: this schema splits a
  // planned date into planned_start/planned_end (no single planned_date
  // column), and "complete" is status = 'closed' (not 'completed').
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE kind = 'surveillance' AND certification_body ILIKE '%bureau veritas%'
                 AND planned_start IS NOT NULL
             )::int AS bv_planned,
             COUNT(*) FILTER (
               WHERE kind = 'surveillance' AND certification_body ILIKE '%bureau veritas%'
                 AND status = 'closed'
             )::int AS bv_complete
        FROM external_audits
    `);
    const row = r.rows[0] ?? { total: 0, bv_planned: 0, bv_complete: 0 };
    const total = Number(row.total) || 0;
    counts["external_audits.surveillance_bv_planned"] = {
      have: Number(row.bv_planned) || 0,
      total: 1,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
    counts["external_audits.surveillance_complete"] = {
      have: Number(row.bv_complete) || 0,
      total: 1,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error("❌ [CertificationActionsAPI] external_audits evidence query failed:", error);
    counts["external_audits.surveillance_bv_planned"] = unavailable();
    counts["external_audits.surveillance_complete"] = unavailable();
  }

  // 3.3 training_records.count — empty today; reads honestly as awaiting_data.
  try {
    const r = await db.query(`SELECT COUNT(*)::int AS total FROM training_records`);
    const total = Number(r.rows[0]?.total) || 0;
    counts["training_records.count"] = {
      have: total,
      total: 1,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error("❌ [CertificationActionsAPI] training_records evidence query failed:", error);
    counts["training_records.count"] = unavailable();
  }

  // 3.4 evidence_records.count, 6.1 evidence_records.pentest. There is no
  // dedicated "type" column on evidence_records (entity_type is
  // nc|capa|compliance|risk_treatment|audit|policy, not a document
  // category) — pentest evidence is identified by a free-text match on
  // description among entity_type='audit' rows. Documented deviation: this
  // is a best-effort convention, not a first-class column.
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE entity_type = 'audit'
                 AND (LOWER(description) LIKE '%pentest%' OR LOWER(description) LIKE '%penetration%')
             )::int AS pentest
        FROM evidence_records
    `);
    const row = r.rows[0] ?? { total: 0, pentest: 0 };
    const total = Number(row.total) || 0;
    counts["evidence_records.count"] = {
      have: total,
      total: 1,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
    counts["evidence_records.pentest"] = {
      have: Number(row.pentest) || 0,
      total: 1,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error("❌ [CertificationActionsAPI] evidence_records evidence query failed:", error);
    counts["evidence_records.count"] = unavailable();
    counts["evidence_records.pentest"] = unavailable();
  }

  // 4.1 audit_runs.count — empty today.
  try {
    const r = await db.query(`SELECT COUNT(*)::int AS total FROM audit_runs`);
    const total = Number(r.rows[0]?.total) || 0;
    counts["audit_runs.count"] = {
      have: total,
      total: 1,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error("❌ [CertificationActionsAPI] audit_runs evidence query failed:", error);
    counts["audit_runs.count"] = unavailable();
  }

  // 4.2 nonconformance_capa.count — "findings raised AND corrective actions
  // opened" needs both tables non-empty, not just one.
  try {
    const r = await db.query(`
      SELECT (SELECT COUNT(*) FROM nonconformance_records)::int AS nc_total,
             (SELECT COUNT(*) FROM capa_records)::int AS capa_total
    `);
    const row = r.rows[0] ?? { nc_total: 0, capa_total: 0 };
    const ncTotal = Number(row.nc_total) || 0;
    const capaTotal = Number(row.capa_total) || 0;
    counts["nonconformance_capa.count"] = {
      have: ncTotal > 0 && capaTotal > 0 ? 1 : 0,
      total: 1,
      sourceEmpty: ncTotal === 0 && capaTotal === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error(
      "❌ [CertificationActionsAPI] nonconformance/capa evidence query failed:",
      error,
    );
    counts["nonconformance_capa.count"] = unavailable();
  }

  // 5.1 management_reviews.count — "held and minuted", so require non-empty
  // minutes, not just a scheduled review row.
  try {
    const r = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE minutes IS NOT NULL AND minutes <> '')::int AS minuted
        FROM management_reviews
    `);
    const row = r.rows[0] ?? { total: 0, minuted: 0 };
    const total = Number(row.total) || 0;
    counts["management_reviews.count"] = {
      have: Number(row.minuted) || 0,
      total: 1,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error(
      "❌ [CertificationActionsAPI] management_reviews evidence query failed:",
      error,
    );
    counts["management_reviews.count"] = unavailable();
  }

  // 5.2 enterprise_risks.last_review_date, 5.3
  // enterprise_risks.treatment_strategy_ratio — scoped to open risks. The
  // quarter-start date is computed once in this impure layer (never inside
  // the pure resolver) and only ever used inside a WHERE filter, never
  // SELECTed back as a bare DATE value.
  //
  // 5.2 per spec §3.1: "refreshed" is `last_review_date` within the quarter
  // OR a `risk_assessment_history` row proving a re-assessment happened —
  // a risk can be re-assessed (history row written by updateRisk() in
  // riskDatabase.ts) without last_review_date itself ever being touched.
  // Same $1 quarterStart reused for the EXISTS check, never a second
  // quarter-computation method.
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE last_review_date >= $1::date
                   OR EXISTS (
                        SELECT 1 FROM risk_assessment_history rah
                         WHERE rah.risk_id = enterprise_risks.id
                           AND rah.assessment_date >= $1::date
                      )
              )::int AS reviewed_recent,
              COUNT(*) FILTER (WHERE treatment_strategy IS NOT NULL)::int AS treated
         FROM enterprise_risks WHERE status = 'open'`,
      [quarterStart],
    );
    const row = r.rows[0] ?? { total: 0, reviewed_recent: 0, treated: 0 };
    const total = Number(row.total) || 0;
    counts["enterprise_risks.last_review_date"] = {
      have: Number(row.reviewed_recent) || 0,
      total,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
    counts["enterprise_risks.treatment_strategy_ratio"] = {
      have: Number(row.treated) || 0,
      total,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error("❌ [CertificationActionsAPI] enterprise_risks evidence query failed:", error);
    counts["enterprise_risks.last_review_date"] = unavailable();
    counts["enterprise_risks.treatment_strategy_ratio"] = unavailable();
  }

  // 6.2 obligation_documents.iso27001_9_2_9_3 — CONFIRMED links only:
  // excludes awaiting_review = TRUE (unreviewed AI guesses) and requires
  // extraction_status = 'extracted' on the linked document. Deviation from
  // spec §3.1's literal wording: this schema has no separate "9.2"/"9.3"
  // obligation codes — ISO 27001 clause 9 (monitoring/internal audit +
  // management review) seeds as a single row, obligation_code
  // 'ISO27001-9' (see seeds/iso27001Obligations.ts). Filtered on that code
  // instead of a clause-substring match that would silently match nothing.
  try {
    const r = await db.query(`
      SELECT COUNT(DISTINCT o.id)::int AS total,
             COUNT(DISTINCT o.id) FILTER (WHERE doc.id IS NOT NULL)::int AS with_evidence
        FROM obligations o
        JOIN regulations reg ON reg.id = o.regulation_id
   LEFT JOIN obligation_documents od ON od.obligation_id = o.id AND od.awaiting_review IS NOT TRUE
   LEFT JOIN qms_uploaded_documents doc ON doc.id = od.document_id AND doc.extraction_status = 'extracted'
       WHERE reg.regulation_code = 'ISO-27001' AND o.obligation_code = 'ISO27001-9'
         AND o.status = 'applicable'
    `);
    const row = r.rows[0] ?? { total: 0, with_evidence: 0 };
    const total = Number(row.total) || 0;
    counts["obligation_documents.iso27001_9_2_9_3"] = {
      have: Number(row.with_evidence) || 0,
      total,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error(
      "❌ [CertificationActionsAPI] obligation_documents evidence query failed:",
      error,
    );
    counts["obligation_documents.iso27001_9_2_9_3"] = unavailable();
  }

  // 7.2 external_audit_certificates.unexpired.
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (
                WHERE status = 'active' AND (expiry_date IS NULL OR expiry_date >= $1::date)
              )::int AS unexpired
         FROM external_audit_certificates WHERE standard ILIKE '%27001%'`,
      [todayStr],
    );
    const row = r.rows[0] ?? { total: 0, unexpired: 0 };
    const total = Number(row.total) || 0;
    counts["external_audit_certificates.unexpired"] = {
      have: Number(row.unexpired) || 0,
      total: 1,
      sourceEmpty: total === 0,
      sourceReadable: true,
    };
  } catch (error) {
    safeLogger.error(
      "❌ [CertificationActionsAPI] external_audit_certificates evidence query failed:",
      error,
    );
    counts["external_audit_certificates.unexpired"] = unavailable();
  }

  return counts;
}

const CERTIFICATION_ACTIONS_SELECT = `
  SELECT action_key, milestone_key, sort_order, action_text, owner, verification_mode,
         evidence_source, TO_CHAR(done_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS done_at,
         done_by, evidence_policy_id, note, plan_version, source_doc
    FROM certification_actions
`;

// ───────────────────────── Milestone authoring helpers ─────────────────────
//
// The GRC manager owns the certification plan; before this the rows came only
// from a code seeder and the single write a person could reach was marking an
// action done. The page therefore reported gaps (NCA-DCC / NCA-ECC with no
// delivering milestone, SOC 2 with no target date) that nobody could close
// without a deployment.

/** Governance write roles. `executive` may toggle actions but not author the plan. */
const MILESTONE_WRITE_ROLES = [
  "admin",
  "head_of_operations_quality",
  "grc_manager",
  "quality_manager",
];

async function milestoneWriteGate(c: any) {
  const { requireRole, getSessionUser, unauthorizedResponse, forbiddenResponse } =
    await import("../../utils/rbacMiddleware");
  const user = await requireRole(c, MILESTONE_WRITE_ROLES as any);
  if (!user) {
    if (!getSessionUser(c)) return { error: unauthorizedResponse(c), user: null };
    return {
      error: forbiddenResponse(c, "Permission denied for certification milestones"),
      user: null,
    };
  }
  return { error: null, user };
}

const MILESTONE_TYPES = new Set(["plan", "dependency", "support"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface MilestoneFields {
  certification: string | null;
  milestone_name: string | null;
  planned_date: string | null;
  owner: string | null;
  notes: string | null;
  milestone_type: string | null;
  regulation_code: string | null;
  clear_planned_date: boolean;
  clear_owner: boolean;
  clear_notes: boolean;
}

/**
 * Normalise and validate the editable fields.
 *
 * Absent means "leave unchanged"; an empty string means "clear this". Those are
 * different intentions and collapsing them would let a form that posts only the
 * target date silently blank the owner, so they travel as separate flags.
 *
 * delivered_date and status are absent by design: delivered_date is derived
 * from the milestone's actions and "never written directly by any endpoint"
 * (see the action toggle), and status is moved only by the retire endpoint.
 */
function parseMilestoneInput(
  body: any,
  opts: { requireName: boolean },
): { value: MilestoneFields } | { error: string } {
  const str = (v: any, max: number): string | null => {
    if (v === undefined || v === null) return null;
    const t = String(v).trim();
    return t ? t.slice(0, max) : null;
  };
  const cleared = (v: any) =>
    v !== undefined && v !== null && String(v).trim() === "";

  const milestone_name = str(body?.milestone_name, 255);
  if (opts.requireName && !milestone_name)
    return { error: "milestone_name is required" };

  const certification = str(body?.certification, 100);
  if (opts.requireName && !certification)
    return { error: "certification is required" };

  const planned_date = str(body?.planned_date, 10);
  if (planned_date && !ISO_DATE.test(planned_date))
    return { error: "planned_date must be YYYY-MM-DD" };

  const milestone_type = str(body?.milestone_type, 20);
  if (milestone_type && !MILESTONE_TYPES.has(milestone_type))
    return {
      error: `milestone_type must be one of ${[...MILESTONE_TYPES].join(", ")}`,
    };

  return {
    value: {
      certification,
      milestone_name,
      planned_date,
      owner: str(body?.owner, 255),
      notes: str(body?.notes, 4000),
      // A created milestone defaults to 'plan' — the section that scores
      // GRC-KPI-002 — because that is what someone adding a certification
      // milestone means. An edit sends null here and keeps what is stored.
      milestone_type: milestone_type ?? (opts.requireName ? "plan" : null),
      regulation_code: str(body?.regulation_code, 50),
      clear_planned_date: cleared(body?.planned_date),
      clear_owner: cleared(body?.owner),
      clear_notes: cleared(body?.notes),
    },
  };
}

/** regulation_code → regulations.id. Returns null when unset or unknown. */
async function resolveRegulationId(code: string | null): Promise<number | null> {
  if (!code) return null;
  const r = await pool.query(
    `SELECT id FROM regulations WHERE regulation_code = $1`,
    [code],
  );
  return r.rows.length ? Number(r.rows[0].id) : null;
}

/**
 * Generate the milestone_key.
 *
 * MANDATORY, not cosmetic: the roadmap query filters
 * `WHERE cm.milestone_key IS NOT NULL`, so a row created without one inserts
 * happily and is then invisible on the page. The USR- prefix keeps authored
 * rows distinguishable from seeded ones for good, and `attempt` walks a suffix
 * when the unique index rejects a collision.
 */
function milestoneKeyFor(name: string | null, attempt: number): string {
  const slug = String(name || "milestone")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "MILESTONE";
  return attempt === 0 ? `USR-${slug}` : `USR-${slug}-${attempt + 1}`;
}

async function auditMilestone(
  c: any,
  user: any,
  actionType: "CREATE" | "UPDATE",
  key: string,
  description: string,
): Promise<void> {
  try {
    const { logEvent } = await import("../../utils/eventLogsDatabase");
    await logEvent({
      actionType: actionType as any,
      entityType: "SYSTEM" as any,
      entityName: "certification_milestones",
      entityId: key as any,
      description,
      module: "compliance" as any,
      severity: "INFO" as any,
      userEmail: user?.email,
    });
  } catch {
    /* never block the write on the audit log */
  }
}

export const certificationMilestoneRoutes = [
  {
    path: "/api/certification-milestones",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireRole, unauthorizedResponse, forbiddenResponse, getSessionUser } =
          await import("../../utils/rbacMiddleware");
        const user = await requireRole(c, [
          "admin", "head_of_operations_quality", "grc_manager",
          "quality_manager", "executive",
        ]);
        if (!user) {
          if (!getSessionUser(c)) return unauthorizedResponse(c);
          return forbiddenResponse(c);
        }

        const r = await pool.query(
          // pg returns DATE as a JS Date at local midnight; JSON-serialising it with
          // toISOString() shifts the day in any non-UTC server timezone. Format in SQL
          // instead so plain 'YYYY-MM-DD' strings (or null) come back, as in
          // calcCertMilestoneDelivery() in src/utils/northStarSources.ts.
          `SELECT cm.milestone_key, cm.milestone_type, cm.certification,
                  cm.milestone_name, TO_CHAR(cm.planned_date, 'YYYY-MM-DD')   AS planned_date,
                  TO_CHAR(cm.delivered_date, 'YYYY-MM-DD') AS delivered_date,
                  cm.status, cm.owner, cm.notes, reg.regulation_code,
                  cm.depends_on_key,
                  COALESCE(cm.unlocks_codes, '{}') AS unlocks_codes,
                  COALESCE(cm.gates_keys, '{}') AS gates_keys
             FROM certification_milestones cm
             LEFT JOIN regulations reg ON reg.id = cm.regulation_id
            WHERE cm.milestone_key IS NOT NULL
              -- Retired milestones are hidden from the plan but still
              -- retrievable, so the UI can offer "restore" rather than the row
              -- simply vanishing with no way back.
              AND ($1::boolean OR COALESCE(cm.status, '') <> 'retired')
            ORDER BY cm.planned_date NULLS LAST, cm.milestone_key`,
          [String(c.req.query("include_retired") || "") === "1"],
        );

        const all = r.rows as unknown as RoadmapRow[];
        const today = new Date().toISOString().slice(0, 10);
        const chain = orderChain(all.filter((x) => x.milestone_type === "plan")).map(
          (m) => ({ ...m, state: milestoneState(m, all, today) }),
        );
        const readiness = frameworkReadiness(all);

        // Actions + resolved evidence. A failure anywhere inside
        // loadEvidenceCounts() is already isolated per evidence-source group,
        // so this whole block only throws (and 500s the request, caught
        // below) on something unrelated like the certification_actions query
        // itself failing — not on any single evidence source being down.
        const actionsResult = await pool.query(`${CERTIFICATION_ACTIONS_SELECT}
            ORDER BY milestone_key, sort_order`);
        const countsBySource = await loadEvidenceCounts(pool);
        const { actions, progressByMilestone } = buildActionsPayload(
          actionsResult.rows as CertificationActionRow[],
          countsBySource,
        );

        return c.json({
          ...groupMilestonesByType(r.rows as MilestoneRow[]),
          chain,
          readiness,
          actions,
          action_progress: progressByMilestone,
          plan_version: PLAN_VERSION,
          source_doc: SOURCE_DOC,
        });
      } catch (error) {
        safeLogger.error(
          "❌ [CertificationMilestonesAPI] Error fetching milestones:",
          error,
        );
        return c.json({ error: "Failed to fetch certification milestones" }, 500);
      }
    },
  },
  {
    path: "/api/certification-actions/:action_key/toggle",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const { requireRole, unauthorizedResponse, forbiddenResponse, getSessionUser } =
          await import("../../utils/rbacMiddleware");
        const user = await requireRole(c, [
          "admin", "head_of_operations_quality", "grc_manager",
          "quality_manager", "executive",
        ]);
        if (!user) {
          if (!getSessionUser(c)) return unauthorizedResponse(c);
          return forbiddenResponse(c);
        }

        const actionKey = c.req.param("action_key");
        if (!actionKey) {
          return c.json({ error: "action_key is required" }, 400);
        }

        const client = await pool.connect();
        let committed = false;
        try {
          await client.query("BEGIN");

          const existing = await client.query(
            `SELECT action_key, milestone_key, verification_mode, done_at
               FROM certification_actions WHERE action_key = $1 FOR UPDATE`,
            [actionKey],
          );
          if (existing.rows.length === 0) {
            await client.query("ROLLBACK");
            return c.json({ error: "Unknown action_key" }, 404);
          }

          const current = existing.rows[0];
          // Core invariant: auto actions are computed from evidence at read
          // time and are NEVER asserted by a human. Refuse before writing
          // anything.
          if (!canToggleAction(current.verification_mode)) {
            await client.query("ROLLBACK");
            return c.json(
              {
                error:
                  "This action is verified automatically from evidence and cannot be toggled by hand",
              },
              409,
            );
          }

          const willBeDone = current.done_at === null;
          const safeDoneBy = willBeDone
            ? redactSensitiveDeep(user.email, "done_by")
            : null;
          const updated = await client.query(
            `UPDATE certification_actions
                SET done_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
                    done_by = CASE WHEN $2 THEN $3 ELSE NULL END,
                    updated_at = NOW()
              WHERE action_key = $1
          RETURNING action_key, milestone_key, sort_order, action_text, owner,
                    verification_mode, evidence_source,
                    TO_CHAR(done_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS done_at,
                    done_by, evidence_policy_id, note, plan_version, source_doc`,
            [actionKey, willBeDone, safeDoneBy],
          );

          // Derived completion (design spec §4.3): recompute the owning
          // milestone from ALL of its actions — never written directly by
          // any endpoint. Only this milestone's actions are needed since
          // milestoneProgress() is computed per milestone_key.
          const milestoneActions = await client.query(
            `${CERTIFICATION_ACTIONS_SELECT} WHERE milestone_key = $1`,
            [current.milestone_key],
          );
          const countsBySource = await loadEvidenceCounts(client as unknown as typeof pool);
          const { progressByMilestone } = buildActionsPayload(
            milestoneActions.rows as CertificationActionRow[],
            countsBySource,
          );
          const progress = progressByMilestone[current.milestone_key] ?? {
            done: 0,
            total: 0,
            complete: false,
          };

          if (progress.complete) {
            await client.query(
              `UPDATE certification_milestones SET delivered_date = CURRENT_DATE
                WHERE milestone_key = $1 AND delivered_date IS NULL`,
              [current.milestone_key],
            );
          } else {
            await client.query(
              `UPDATE certification_milestones SET delivered_date = NULL
                WHERE milestone_key = $1 AND delivered_date IS NOT NULL`,
              [current.milestone_key],
            );
          }

          await client.query("COMMIT");
          committed = true;

          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await logEvent({
            userId: user.userId,
            userEmail: user.email,
            userRole: user.role,
            actionType: "UPDATE",
            entityType: "certification_action",
            entityId: actionKey,
            entityName: current.milestone_key,
            description: `${willBeDone ? "Marked" : "Unmarked"} certification action ${actionKey} as ${willBeDone ? "done" : "not done"}`,
            module: "certification",
            severity: "INFO",
          }).catch(() => {
            /* non-fatal, per eventLogsDatabase.ts design */
          });

          return c.json(updated.rows[0]);
        } catch (txError) {
          if (!committed) {
            await client.query("ROLLBACK").catch(() => {});
          }
          throw txError;
        } finally {
          client.release();
        }
      } catch (error) {
        safeLogger.error(
          "❌ [CertificationActionsAPI] Error toggling certification action:",
          error,
        );
        return c.json({ error: "Failed to toggle certification action" }, 500);
      }
    },
  },
  // ── Milestone authoring ────────────────────────────────────────────────
  // Three invariants, each learned from the surrounding code:
  //   1. milestone_key is mandatory or the row is invisible (roadmap filter).
  //   2. delivered_date is derived from actions — not editable here.
  //   3. Retiring must leave GRC-KPI-002's scope, or a retired milestone keeps
  //      counting as due forever.
  // The seeder cannot undo any of this: it inserts ON CONFLICT DO NOTHING and
  // backfills only NULL columns.
  {
    path: "/api/certification-milestones",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const g = await milestoneWriteGate(c);
        if (g.error) return g.error;

        const body = await c.req.json().catch(() => ({}));
        const parsed = parseMilestoneInput(body, { requireName: true });
        if ("error" in parsed) return c.json({ error: parsed.error }, 400);
        const f = parsed.value;

        const regulationId = await resolveRegulationId(f.regulation_code);
        if (f.regulation_code && regulationId === null)
          return c.json(
            { error: `Unknown regulation_code: ${f.regulation_code}` },
            400,
          );

        // Retry against the unique index rather than pre-checking: a
        // SELECT-then-INSERT races another author, and the index is the only
        // real authority on whether a key is free.
        let created: any = null;
        for (let attempt = 0; attempt < 6 && !created; attempt++) {
          const key = milestoneKeyFor(f.milestone_name, attempt);
          try {
            const r = await pool.query(
              `INSERT INTO certification_milestones
                 (milestone_key, milestone_type, certification, regulation_id,
                  milestone_name, planned_date, status, owner, notes,
                  plan_version, source_doc)
               VALUES ($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9,$10)
               RETURNING milestone_key`,
              [
                key,
                f.milestone_type,
                f.certification,
                regulationId,
                f.milestone_name,
                f.planned_date,
                f.owner,
                f.notes,
                PLAN_VERSION,
                SOURCE_DOC,
              ],
            );
            created = r.rows[0];
          } catch (err: any) {
            if (err?.code === "23505") continue;
            throw err;
          }
        }
        if (!created)
          return c.json(
            { error: "Could not allocate a unique milestone key — rename it" },
            409,
          );

        await auditMilestone(
          c, g.user, "CREATE", created.milestone_key,
          `Milestone created: ${f.milestone_name} (${f.certification})`,
        );
        return c.json({ success: true, milestone_key: created.milestone_key });
      } catch (error) {
        safeLogger.error("❌ [CertificationMilestones] create failed:", error);
        return c.json({ error: "Failed to create milestone" }, 500);
      }
    },
  },

  {
    path: "/api/certification-milestones/:milestone_key",
    method: "PUT" as const,
    createHandler: async () => async (c: any) => {
      try {
        const g = await milestoneWriteGate(c);
        if (g.error) return g.error;

        const key = String(c.req.param("milestone_key") || "").trim();
        if (!key) return c.json({ error: "milestone_key is required" }, 400);

        const body = await c.req.json().catch(() => ({}));
        const parsed = parseMilestoneInput(body, { requireName: false });
        if ("error" in parsed) return c.json({ error: parsed.error }, 400);
        const f = parsed.value;

        const regulationId = await resolveRegulationId(f.regulation_code);
        if (f.regulation_code && regulationId === null)
          return c.json(
            { error: `Unknown regulation_code: ${f.regulation_code}` },
            400,
          );

        // COALESCE keeps an omitted field as it was; the *_clear flags are the
        // only way to blank one. Omission and clearing are different
        // intentions and must not collapse into each other.
        const r = await pool.query(
          `UPDATE certification_milestones
              SET certification  = COALESCE($2, certification),
                  milestone_name = COALESCE($3, milestone_name),
                  planned_date   = CASE WHEN $9  THEN NULL
                                        ELSE COALESCE($4::date, planned_date) END,
                  owner          = CASE WHEN $10 THEN NULL
                                        ELSE COALESCE($5, owner) END,
                  notes          = CASE WHEN $11 THEN NULL
                                        ELSE COALESCE($6, notes) END,
                  milestone_type = COALESCE($7, milestone_type),
                  regulation_id  = COALESCE($8, regulation_id),
                  updated_at     = NOW()
            WHERE milestone_key = $1
        RETURNING milestone_key`,
          [
            key,
            f.certification,
            f.milestone_name,
            f.planned_date,
            f.owner,
            f.notes,
            f.milestone_type,
            regulationId,
            f.clear_planned_date,
            f.clear_owner,
            f.clear_notes,
          ],
        );
        if (r.rowCount === 0)
          return c.json({ error: "Unknown milestone_key" }, 404);

        await auditMilestone(c, g.user, "UPDATE", key, `Milestone edited: ${key}`);
        return c.json({ success: true, milestone_key: key });
      } catch (error) {
        safeLogger.error("❌ [CertificationMilestones] update failed:", error);
        return c.json({ error: "Failed to update milestone" }, 500);
      }
    },
  },

  {
    path: "/api/certification-milestones/:milestone_key/retire",
    method: "POST" as const,
    createHandler: async () => async (c: any) => {
      try {
        const g = await milestoneWriteGate(c);
        if (g.error) return g.error;

        const key = String(c.req.param("milestone_key") || "").trim();
        if (!key) return c.json({ error: "milestone_key is required" }, 400);
        const body = await c.req.json().catch(() => ({}));
        const retire = body?.retired !== false;

        // Hide, never delete. A milestone that was once in the plan is part of
        // its history; an auditor asking "what changed and when" is better
        // served by a retired row than by a missing one.
        const r = await pool.query(
          `UPDATE certification_milestones
              SET status = $2, updated_at = NOW()
            WHERE milestone_key = $1
        RETURNING milestone_key, status`,
          [key, retire ? "retired" : "planned"],
        );
        if (r.rowCount === 0)
          return c.json({ error: "Unknown milestone_key" }, 404);

        await auditMilestone(
          c, g.user, "UPDATE", key,
          `Milestone ${retire ? "retired" : "restored"}: ${key}`,
        );
        return c.json({ success: true, ...r.rows[0] });
      } catch (error) {
        safeLogger.error("❌ [CertificationMilestones] retire failed:", error);
        return c.json({ error: "Failed to retire milestone" }, 500);
      }
    },
  },
];
