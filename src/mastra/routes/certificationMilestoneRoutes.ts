import { sharedPool as pool } from "../../utils/sharedPool";
import { PLAN_VERSION, SOURCE_DOC } from "../../utils/seeds/certificationMilestonePlan";
import { logger as safeLogger } from "../../utils/logger";
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
  try {
    const r = await db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE last_review_date >= $1::date)::int AS reviewed_recent,
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
            ORDER BY cm.planned_date NULLS LAST, cm.milestone_key`,
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
            [actionKey, willBeDone, willBeDone ? user.email : null],
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
];
