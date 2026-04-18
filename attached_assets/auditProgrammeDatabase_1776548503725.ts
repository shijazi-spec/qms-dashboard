/**
 * auditProgrammeDatabase.ts
 *
 * Persistence layer for the P0 Internal Audits re-architecture:
 *
 *   1. audit_programme           — annual audit plan (ISO 19011:2018 §5.2).
 *   2. audit_programme_signoff   — who signed off, which HITL ticket proves it.
 *   3. manual_audit_intake       — off-platform audit reports uploaded by the
 *                                  Quality Manager, extracted via GPT-4o.
 *   4. manual_audit_findings     — AI-extracted findings pending human review.
 *   5. external_audits           — external / surveillance / certification
 *                                  audits (CB name, scope, schedule).
 *   6. external_audit_certificates — certificate registry tied to the above.
 *   7. audit_runs                — parent anchor for platform-AI audit
 *                                  executions (future home of Triggers).
 *
 * All new tables are additive and do NOT touch the existing `audits` or
 * `grc_audit_findings` tables beyond adding nullable foreign-key columns.
 *
 * Compliance references (controls these tables exist to evidence):
 *   - ISO 19011:2018 §5.2 (audit programme), §5.5 (individual audit records).
 *   - ISO 9001:2015 §9.2 (internal audit), §7.5.3 (documented info control).
 *   - ISO/IEC 27001:2022 A.5.35 (independent review), A.5.36 (compliance).
 *   - IIA IPPF Standard 2010 (planning), 2060 (communication), 2500 (follow-up).
 *   - PDPL Art. 16 (human review of automated decisions — applies to the AI
 *     extraction path in manual_audit_findings).
 */

import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/* ------------------------------------------------------------------------- *
 * Types
 * ------------------------------------------------------------------------- */

export type AuditSourceParty =
  | 'platform_ai'           // created by the in-platform AI audit-run engine
  | 'quality_manual'        // manually logged by Quality team
  | 'external_regulator'    // SDAIA, SAMA, etc.
  | 'external_certification' // ISO certification body (BSI, TUV, DNV…)
  | 'external_surveillance' // annual / mid-cycle surveillance
  | 'external_customer'     // customer-driven vendor audit
  | 'external_other';

export type ProgrammeStatus =
  | 'draft'
  | 'pending_signoff'
  | 'approved'
  | 'in_execution'
  | 'closed'
  | 'cancelled';

export type ManualIntakeStatus =
  | 'uploaded'      // PDF/DOCX received, no AI run yet
  | 'extracting'    // GPT-4o extraction in progress
  | 'ready_review'  // extraction complete, awaiting QM review
  | 'partially_reviewed'
  | 'accepted'      // QM accepted all findings -> promoted to grc_audit_findings
  | 'rejected'
  | 'failed';       // extraction failed (file corrupt / model error)

export type ExternalAuditKind =
  | 'regulatory'     // government mandated (SDAIA, SAMA, ZATCA…)
  | 'certification'  // initial cert audit (ISO 27001, 9001, 42001 one-day)
  | 'surveillance'   // annual follow-up on existing certification
  | 'recertification'
  | 'customer'       // customer-driven audit of WalaPlus as supplier
  | 'other';

export interface AuditProgramme {
  id: number;
  programme_code: string;          // WP-PROG-YYYY-Nnn
  title: string;
  programme_year: number;
  scope_summary: string | null;
  objectives: string | null;
  risk_based_rationale: string | null;  // free text explaining why this plan
  planned_audits: any;             // JSONB — array of planned-audit rows
  status: ProgrammeStatus;
  prepared_by_email: string | null;
  prepared_by_name: string | null;
  submitted_at: Date | null;
  approved_at: Date | null;
  approved_by_email: string | null;
  approval_action_code: string | null; // -> ai_pending_actions.action_code
  created_at: Date;
  updated_at: Date;
}

export interface ManualIntake {
  id: number;
  intake_code: string;             // WP-MANI-YYYY-Nnn
  title: string;
  audit_source_party: AuditSourceParty;
  department: string | null;
  auditor_name: string | null;
  audit_date: Date | null;
  file_name: string;
  file_path: string | null;
  file_mime: string | null;
  file_sha256: string | null;
  uploaded_by_email: string;
  status: ManualIntakeStatus;
  extraction_model: string | null;  // e.g. 'openai/gpt-4o-2024-11-20'
  extraction_started_at: Date | null;
  extraction_completed_at: Date | null;
  extraction_error: string | null;
  findings_extracted: number;
  findings_accepted: number;
  findings_rejected: number;
  linked_audit_id: string | null;   // -> audits.id when promoted
  created_at: Date;
  updated_at: Date;
}

export interface ManualAuditFinding {
  id: number;
  intake_id: number;
  finding_ref: string | null;       // auditor's code if any
  title: string;
  description: string;
  severity: 'critical' | 'major' | 'minor' | 'observation' | 'unknown';
  category: string | null;
  responsible_party: string | null;
  due_date: Date | null;
  source_page: number | null;       // PDF page where this finding was found
  source_excerpt: string | null;    // verbatim paragraph from the PDF
  confidence_score: number;         // 0.00..1.00 from the extractor
  status: 'pending' | 'accepted' | 'rejected' | 'edited';
  reviewed_by_email: string | null;
  reviewed_at: Date | null;
  reject_reason: string | null;
  promoted_finding_id: number | null; // -> grc_audit_findings.id
  created_at: Date;
  updated_at: Date;
}

export interface ExternalAudit {
  id: number;
  audit_code: string;               // WP-EXT-YYYY-Nnn
  kind: ExternalAuditKind;
  title: string;
  standard: string | null;          // e.g. 'ISO/IEC 27001:2022'
  certification_body: string | null;
  auditor_name: string | null;
  scope_summary: string | null;
  planned_start: Date | null;
  planned_end: Date | null;
  actual_start: Date | null;
  actual_end: Date | null;
  status: 'scheduled' | 'preparation' | 'in_progress' | 'awaiting_report' | 'closed' | 'cancelled';
  readiness_percent: number;        // 0-100 computed from checklist
  findings_count: number;
  critical_findings: number;
  linked_audit_id: string | null;   // mirror into audits table for reporting
  created_by_email: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ExternalAuditCertificate {
  id: number;
  external_audit_id: number | null; // null if uploaded without a source audit
  certificate_number: string;
  standard: string;
  certification_body: string;
  issue_date: Date | null;
  expiry_date: Date | null;
  scope_statement: string | null;
  file_path: string | null;
  status: 'active' | 'superseded' | 'withdrawn' | 'expired';
  uploaded_by_email: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AuditRun {
  id: number;
  run_code: string;                 // WP-RUN-YYYYMMDD-XXX
  run_type: 'platform_ai' | 'quality_manual' | 'external';
  title: string;
  module_in_scope: string | null;
  linked_audit_id: string | null;
  linked_programme_id: number | null;
  started_at: Date;
  finished_at: Date | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  summary: any;                     // JSONB
  created_by_email: string | null;
}

/* ------------------------------------------------------------------------- *
 * Schema init — idempotent. Call at boot.
 * ------------------------------------------------------------------------- */

let initPromise: Promise<void> | null = null;

export async function initAuditProgrammeTables(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    console.log('[AuditProgrammeDB] Initializing tables…');

    // 1. audit_programme
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_programme (
        id                      SERIAL PRIMARY KEY,
        programme_code          VARCHAR(40)  UNIQUE NOT NULL,
        title                   VARCHAR(500) NOT NULL,
        programme_year          INTEGER      NOT NULL,
        scope_summary           TEXT,
        objectives              TEXT,
        risk_based_rationale    TEXT,
        planned_audits          JSONB NOT NULL DEFAULT '[]'::jsonb,
        status                  VARCHAR(30)  NOT NULL DEFAULT 'draft',
        prepared_by_email       VARCHAR(255),
        prepared_by_name        VARCHAR(255),
        submitted_at            TIMESTAMPTZ,
        approved_at             TIMESTAMPTZ,
        approved_by_email       VARCHAR(255),
        approval_action_code    VARCHAR(40),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_programme_year   ON audit_programme(programme_year);
      CREATE INDEX IF NOT EXISTS idx_audit_programme_status ON audit_programme(status);
    `);

    // 2. audit_programme_signoff — append-only log of sign-off events
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_programme_signoff (
        id                      SERIAL PRIMARY KEY,
        programme_id            INTEGER REFERENCES audit_programme(id) ON DELETE CASCADE,
        action                  VARCHAR(40) NOT NULL, -- 'submitted' | 'approved' | 'rejected' | 'revised'
        action_code             VARCHAR(40),          -- ai_pending_actions.action_code
        actor_email             VARCHAR(255),
        actor_role              VARCHAR(50),
        notes                   TEXT,
        snapshot                JSONB,                -- programme JSON at this moment
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_programme_signoff_prog ON audit_programme_signoff(programme_id);
    `);

    // 3. manual_audit_intake
    await pool.query(`
      CREATE TABLE IF NOT EXISTS manual_audit_intake (
        id                      SERIAL PRIMARY KEY,
        intake_code             VARCHAR(40)  UNIQUE NOT NULL,
        title                   VARCHAR(500) NOT NULL,
        audit_source_party      VARCHAR(40)  NOT NULL,
        department              VARCHAR(100),
        auditor_name            VARCHAR(255),
        audit_date              DATE,
        file_name               VARCHAR(500) NOT NULL,
        file_path               TEXT,
        file_mime               VARCHAR(100),
        file_sha256             VARCHAR(64),
        uploaded_by_email       VARCHAR(255) NOT NULL,
        status                  VARCHAR(30)  NOT NULL DEFAULT 'uploaded',
        extraction_model        VARCHAR(100),
        extraction_started_at   TIMESTAMPTZ,
        extraction_completed_at TIMESTAMPTZ,
        extraction_error        TEXT,
        findings_extracted      INTEGER NOT NULL DEFAULT 0,
        findings_accepted       INTEGER NOT NULL DEFAULT 0,
        findings_rejected       INTEGER NOT NULL DEFAULT 0,
        linked_audit_id         VARCHAR,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_manual_intake_status ON manual_audit_intake(status);
      CREATE INDEX IF NOT EXISTS idx_manual_intake_date   ON manual_audit_intake(audit_date DESC);
    `);

    // 4. manual_audit_findings
    await pool.query(`
      CREATE TABLE IF NOT EXISTS manual_audit_findings (
        id                      SERIAL PRIMARY KEY,
        intake_id               INTEGER REFERENCES manual_audit_intake(id) ON DELETE CASCADE,
        finding_ref             VARCHAR(50),
        title                   VARCHAR(500) NOT NULL,
        description             TEXT         NOT NULL,
        severity                VARCHAR(20)  NOT NULL DEFAULT 'unknown',
        category                VARCHAR(100),
        responsible_party       VARCHAR(255),
        due_date                DATE,
        source_page             INTEGER,
        source_excerpt          TEXT,
        confidence_score        NUMERIC(3,2) NOT NULL DEFAULT 0.00,
        status                  VARCHAR(20)  NOT NULL DEFAULT 'pending',
        reviewed_by_email       VARCHAR(255),
        reviewed_at             TIMESTAMPTZ,
        reject_reason           TEXT,
        promoted_finding_id     INTEGER,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_manual_findings_intake   ON manual_audit_findings(intake_id);
      CREATE INDEX IF NOT EXISTS idx_manual_findings_status   ON manual_audit_findings(status);
      CREATE INDEX IF NOT EXISTS idx_manual_findings_severity ON manual_audit_findings(severity);
    `);

    // 5. external_audits
    await pool.query(`
      CREATE TABLE IF NOT EXISTS external_audits (
        id                      SERIAL PRIMARY KEY,
        audit_code              VARCHAR(40)  UNIQUE NOT NULL,
        kind                    VARCHAR(30)  NOT NULL,
        title                   VARCHAR(500) NOT NULL,
        standard                VARCHAR(255),
        certification_body      VARCHAR(255),
        auditor_name            VARCHAR(255),
        scope_summary           TEXT,
        planned_start           DATE,
        planned_end             DATE,
        actual_start            DATE,
        actual_end              DATE,
        status                  VARCHAR(30)  NOT NULL DEFAULT 'scheduled',
        readiness_percent       INTEGER      NOT NULL DEFAULT 0,
        findings_count          INTEGER      NOT NULL DEFAULT 0,
        critical_findings       INTEGER      NOT NULL DEFAULT 0,
        linked_audit_id         VARCHAR,
        created_by_email        VARCHAR(255),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_external_audits_status ON external_audits(status);
      CREATE INDEX IF NOT EXISTS idx_external_audits_date   ON external_audits(planned_start);
    `);

    // 6. external_audit_checklist — simple readiness checklist
    await pool.query(`
      CREATE TABLE IF NOT EXISTS external_audit_checklist (
        id                      SERIAL PRIMARY KEY,
        external_audit_id       INTEGER REFERENCES external_audits(id) ON DELETE CASCADE,
        category                VARCHAR(100) NOT NULL,
        requirement             TEXT NOT NULL,
        status                  VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending' | 'in_progress' | 'ready' | 'not_applicable'
        owner_email             VARCHAR(255),
        evidence_link           TEXT,
        notes                   TEXT,
        order_index             INTEGER DEFAULT 0,
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ext_checklist_audit ON external_audit_checklist(external_audit_id);
    `);

    // 7. external_audit_certificates
    await pool.query(`
      CREATE TABLE IF NOT EXISTS external_audit_certificates (
        id                      SERIAL PRIMARY KEY,
        external_audit_id       INTEGER REFERENCES external_audits(id) ON DELETE SET NULL,
        certificate_number      VARCHAR(100) NOT NULL,
        standard                VARCHAR(255) NOT NULL,
        certification_body      VARCHAR(255) NOT NULL,
        issue_date              DATE,
        expiry_date             DATE,
        scope_statement         TEXT,
        file_path               TEXT,
        status                  VARCHAR(30) NOT NULL DEFAULT 'active',
        uploaded_by_email       VARCHAR(255),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_ext_certs_expiry ON external_audit_certificates(expiry_date);
      CREATE INDEX IF NOT EXISTS idx_ext_certs_status ON external_audit_certificates(status);
    `);

    // 8. audit_runs — anchor for platform-AI + manual + external audits
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_runs (
        id                      SERIAL PRIMARY KEY,
        run_code                VARCHAR(40)  UNIQUE NOT NULL,
        run_type                VARCHAR(30)  NOT NULL,
        title                   VARCHAR(500) NOT NULL,
        module_in_scope         VARCHAR(100),
        linked_audit_id         VARCHAR,
        linked_programme_id     INTEGER REFERENCES audit_programme(id) ON DELETE SET NULL,
        started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at             TIMESTAMPTZ,
        status                  VARCHAR(20) NOT NULL DEFAULT 'running',
        summary                 JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by_email        VARCHAR(255)
      );
      CREATE INDEX IF NOT EXISTS idx_audit_runs_type    ON audit_runs(run_type);
      CREATE INDEX IF NOT EXISTS idx_audit_runs_started ON audit_runs(started_at DESC);
    `);

    // 9. nullable FK columns on existing tables (safe ADD IF NOT EXISTS).
    const add = async (table: string, column: string, type: string) => {
      try { await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${type}`); } catch { /* ignore */ }
    };
    await add('audits', 'source_party',  "VARCHAR(40) DEFAULT 'quality_manual'");
    await add('audits', 'audit_run_id',  'INTEGER');
    await add('audits', 'programme_id',  'INTEGER');
    await add('audits', 'intake_id',     'INTEGER');
    // trigger table: dismiss reason, re-eval, auto-escalate, run link
    await add('audit_triggers', 'dismiss_reason',        'TEXT');
    await add('audit_triggers', 'dismissed_at',          'TIMESTAMPTZ');
    await add('audit_triggers', 'dismissed_by_email',    'VARCHAR(255)');
    await add('audit_triggers', 'next_reevaluate_at',    'TIMESTAMPTZ');
    await add('audit_triggers', 'reevaluated_at',        'TIMESTAMPTZ');
    await add('audit_triggers', 'auto_escalated_at',     'TIMESTAMPTZ');
    await add('audit_triggers', 'escalation_finding_id', 'INTEGER');
    await add('audit_triggers', 'audit_run_id',          'INTEGER');
    await add('audit_triggers', 'hitl_action_code',      'VARCHAR(40)');

    console.log('[AuditProgrammeDB] Tables ready');
  })();
  return initPromise;
}

/* ------------------------------------------------------------------------- *
 * Code generators (all idempotent, collision-safe via UNIQUE constraint)
 * ------------------------------------------------------------------------- */

function yyyy(): string { return String(new Date().getUTCFullYear()); }
function ymd(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`;
}

async function nextSequence(prefix: string, year: string): Promise<string> {
  // Use MAX+1 per prefix+year. A real production system would use a Postgres
  // sequence per prefix; this is simpler and avoids the migration burden.
  const pattern = `${prefix}-${year}-%`;
  const res = await pool.query<{ max: string | null }>(
    `SELECT MAX(CAST(SUBSTRING(code FROM '[0-9]+$') AS INTEGER))::text AS max
       FROM (
         SELECT programme_code   AS code FROM audit_programme   WHERE programme_code   LIKE $1
         UNION ALL
         SELECT intake_code      AS code FROM manual_audit_intake WHERE intake_code    LIKE $1
         UNION ALL
         SELECT audit_code       AS code FROM external_audits   WHERE audit_code       LIKE $1
       ) codes`,
    [pattern]
  );
  const next = (parseInt(res.rows[0]?.max || '0', 10) + 1) || 1;
  return `${prefix}-${year}-${String(next).padStart(3, '0')}`;
}

async function nextRunCode(): Promise<string> {
  const prefix = `WP-RUN-${ymd()}`;
  const res = await pool.query<{ max: string | null }>(
    `SELECT MAX(CAST(SUBSTRING(run_code FROM '[0-9]+$') AS INTEGER))::text AS max
       FROM audit_runs WHERE run_code LIKE $1`,
    [`${prefix}-%`]
  );
  const next = (parseInt(res.rows[0]?.max || '0', 10) + 1) || 1;
  return `${prefix}-${String(next).padStart(3, '0')}`;
}

/* ------------------------------------------------------------------------- *
 * AUDIT PROGRAMME — CRUD + sign-off
 * ------------------------------------------------------------------------- */

export async function createProgramme(input: {
  title: string;
  programme_year: number;
  scope_summary?: string;
  objectives?: string;
  risk_based_rationale?: string;
  planned_audits?: any[];
  prepared_by_email?: string;
  prepared_by_name?: string;
}): Promise<AuditProgramme> {
  await initAuditProgrammeTables();
  const code = await nextSequence('WP-PROG', String(input.programme_year));
  const res = await pool.query<AuditProgramme>(
    `INSERT INTO audit_programme
       (programme_code, title, programme_year, scope_summary, objectives,
        risk_based_rationale, planned_audits, status,
        prepared_by_email, prepared_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8,$9)
     RETURNING *`,
    [
      code, input.title, input.programme_year,
      input.scope_summary ?? null,
      input.objectives ?? null,
      input.risk_based_rationale ?? null,
      JSON.stringify(input.planned_audits ?? []),
      input.prepared_by_email ?? null,
      input.prepared_by_name ?? null,
    ]
  );
  return res.rows[0];
}

export async function listProgrammes(filters?: {
  year?: number;
  status?: ProgrammeStatus;
}): Promise<AuditProgramme[]> {
  await initAuditProgrammeTables();
  const where: string[] = [];
  const params: any[] = [];
  if (filters?.year)   { params.push(filters.year);   where.push(`programme_year = $${params.length}`); }
  if (filters?.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
  const sql = `SELECT * FROM audit_programme ${where.length ? 'WHERE '+where.join(' AND ') : ''}
               ORDER BY programme_year DESC, created_at DESC`;
  const res = await pool.query<AuditProgramme>(sql, params);
  return res.rows;
}

export async function getProgrammeById(id: number): Promise<AuditProgramme | null> {
  await initAuditProgrammeTables();
  const res = await pool.query<AuditProgramme>(`SELECT * FROM audit_programme WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

export async function updateProgramme(
  id: number,
  patch: Partial<Pick<AuditProgramme,
    'title' | 'scope_summary' | 'objectives' | 'risk_based_rationale' | 'planned_audits' |
    'status' | 'approval_action_code' | 'approved_at' | 'approved_by_email'>>
): Promise<AuditProgramme | null> {
  await initAuditProgrammeTables();
  const fields: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i++}`);
    params.push(k === 'planned_audits' ? JSON.stringify(v) : v);
  }
  if (fields.length === 0) return getProgrammeById(id);
  fields.push(`updated_at = NOW()`);
  params.push(id);
  const res = await pool.query<AuditProgramme>(
    `UPDATE audit_programme SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  return res.rows[0] || null;
}

export async function recordProgrammeSignoff(input: {
  programme_id: number;
  action: 'submitted' | 'approved' | 'rejected' | 'revised';
  action_code?: string | null;
  actor_email?: string | null;
  actor_role?: string | null;
  notes?: string | null;
  snapshot?: any;
}): Promise<void> {
  await initAuditProgrammeTables();
  await pool.query(
    `INSERT INTO audit_programme_signoff
       (programme_id, action, action_code, actor_email, actor_role, notes, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.programme_id, input.action, input.action_code ?? null,
      input.actor_email ?? null, input.actor_role ?? null,
      input.notes ?? null, JSON.stringify(input.snapshot ?? {}),
    ]
  );
}

export async function getProgrammeHistory(programmeId: number): Promise<any[]> {
  await initAuditProgrammeTables();
  const res = await pool.query(
    `SELECT id, action, action_code, actor_email, actor_role, notes, created_at
       FROM audit_programme_signoff
      WHERE programme_id = $1
      ORDER BY created_at ASC`,
    [programmeId]
  );
  return res.rows;
}

/* ------------------------------------------------------------------------- *
 * MANUAL AUDIT INTAKE
 * ------------------------------------------------------------------------- */

export async function createIntake(input: {
  title: string;
  audit_source_party: AuditSourceParty;
  department?: string;
  auditor_name?: string;
  audit_date?: Date | null;
  file_name: string;
  file_path?: string | null;
  file_mime?: string | null;
  file_sha256?: string | null;
  uploaded_by_email: string;
}): Promise<ManualIntake> {
  await initAuditProgrammeTables();
  const code = await nextSequence('WP-MANI', yyyy());
  const res = await pool.query<ManualIntake>(
    `INSERT INTO manual_audit_intake
       (intake_code, title, audit_source_party, department, auditor_name, audit_date,
        file_name, file_path, file_mime, file_sha256, uploaded_by_email, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'uploaded')
     RETURNING *`,
    [
      code, input.title, input.audit_source_party,
      input.department ?? null, input.auditor_name ?? null, input.audit_date ?? null,
      input.file_name, input.file_path ?? null, input.file_mime ?? null,
      input.file_sha256 ?? null, input.uploaded_by_email,
    ]
  );
  return res.rows[0];
}

export async function listIntakes(filters?: {
  status?: ManualIntakeStatus;
  uploader?: string;
  limit?: number;
}): Promise<ManualIntake[]> {
  await initAuditProgrammeTables();
  const where: string[] = [];
  const params: any[] = [];
  if (filters?.status)   { params.push(filters.status);   where.push(`status = $${params.length}`); }
  if (filters?.uploader) { params.push(filters.uploader); where.push(`uploaded_by_email = $${params.length}`); }
  const limit = Math.min(filters?.limit ?? 100, 500);
  params.push(limit);
  const sql = `SELECT * FROM manual_audit_intake
               ${where.length ? 'WHERE '+where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT $${params.length}`;
  const res = await pool.query<ManualIntake>(sql, params);
  return res.rows;
}

export async function getIntakeById(id: number): Promise<ManualIntake | null> {
  await initAuditProgrammeTables();
  const res = await pool.query<ManualIntake>(`SELECT * FROM manual_audit_intake WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

export async function updateIntakeStatus(
  id: number,
  status: ManualIntakeStatus,
  extra?: Partial<ManualIntake>
): Promise<ManualIntake | null> {
  await initAuditProgrammeTables();
  const fields = ['status = $1', 'updated_at = NOW()'];
  const params: any[] = [status];
  let i = 2;
  const allowed: (keyof ManualIntake)[] = [
    'extraction_model', 'extraction_started_at', 'extraction_completed_at',
    'extraction_error', 'findings_extracted', 'findings_accepted',
    'findings_rejected', 'linked_audit_id',
  ];
  for (const k of allowed) {
    const v = (extra as any)?.[k];
    if (v !== undefined) { fields.push(`${k} = $${i++}`); params.push(v); }
  }
  params.push(id);
  const res = await pool.query<ManualIntake>(
    `UPDATE manual_audit_intake SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  return res.rows[0] || null;
}

export async function insertManualFindings(
  intakeId: number,
  findings: Array<Omit<ManualAuditFinding,
    'id' | 'intake_id' | 'status' | 'reviewed_by_email' | 'reviewed_at' |
    'reject_reason' | 'promoted_finding_id' | 'created_at' | 'updated_at'>>
): Promise<ManualAuditFinding[]> {
  await initAuditProgrammeTables();
  if (findings.length === 0) return [];
  const rows: ManualAuditFinding[] = [];
  for (const f of findings) {
    const r = await pool.query<ManualAuditFinding>(
      `INSERT INTO manual_audit_findings
         (intake_id, finding_ref, title, description, severity, category,
          responsible_party, due_date, source_page, source_excerpt, confidence_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        intakeId, f.finding_ref ?? null, f.title, f.description,
        f.severity ?? 'unknown', f.category ?? null,
        f.responsible_party ?? null, f.due_date ?? null,
        f.source_page ?? null, f.source_excerpt ?? null,
        f.confidence_score ?? 0,
      ]
    );
    rows.push(r.rows[0]);
  }
  await pool.query(
    `UPDATE manual_audit_intake SET findings_extracted = $1, updated_at = NOW() WHERE id = $2`,
    [rows.length, intakeId]
  );
  return rows;
}

export async function listManualFindings(intakeId: number): Promise<ManualAuditFinding[]> {
  await initAuditProgrammeTables();
  const res = await pool.query<ManualAuditFinding>(
    `SELECT * FROM manual_audit_findings WHERE intake_id = $1 ORDER BY id ASC`,
    [intakeId]
  );
  return res.rows;
}

export async function reviewManualFinding(
  findingId: number,
  input: {
    action: 'accept' | 'reject' | 'edit';
    reviewer_email: string;
    patch?: Partial<Pick<ManualAuditFinding,
      'title' | 'description' | 'severity' | 'category' | 'responsible_party' | 'due_date'>>;
    reject_reason?: string;
  }
): Promise<ManualAuditFinding | null> {
  await initAuditProgrammeTables();
  const fields: string[] = ['reviewed_by_email = $1', 'reviewed_at = NOW()', 'updated_at = NOW()'];
  const params: any[] = [input.reviewer_email];
  let i = 2;
  if (input.action === 'accept') {
    fields.push(`status = $${i++}`); params.push('accepted');
  } else if (input.action === 'reject') {
    fields.push(`status = $${i++}`); params.push('rejected');
    fields.push(`reject_reason = $${i++}`); params.push(input.reject_reason ?? null);
  } else if (input.action === 'edit') {
    fields.push(`status = $${i++}`); params.push('edited');
    for (const [k, v] of Object.entries(input.patch ?? {})) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`); params.push(v);
    }
  }
  params.push(findingId);
  const res = await pool.query<ManualAuditFinding>(
    `UPDATE manual_audit_findings SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  return res.rows[0] || null;
}

export async function markFindingPromoted(findingId: number, promotedFindingId: number): Promise<void> {
  await pool.query(
    `UPDATE manual_audit_findings SET promoted_finding_id = $1, updated_at = NOW() WHERE id = $2`,
    [promotedFindingId, findingId]
  );
}

/* ------------------------------------------------------------------------- *
 * EXTERNAL AUDITS
 * ------------------------------------------------------------------------- */

export async function createExternalAudit(input: Omit<ExternalAudit,
  'id' | 'audit_code' | 'readiness_percent' | 'findings_count' |
  'critical_findings' | 'linked_audit_id' | 'created_at' | 'updated_at'>
): Promise<ExternalAudit> {
  await initAuditProgrammeTables();
  const year = input.planned_start
    ? String(new Date(input.planned_start).getUTCFullYear())
    : yyyy();
  const code = await nextSequence('WP-EXT', year);
  const res = await pool.query<ExternalAudit>(
    `INSERT INTO external_audits
       (audit_code, kind, title, standard, certification_body, auditor_name,
        scope_summary, planned_start, planned_end, status, created_by_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      code, input.kind, input.title, input.standard ?? null,
      input.certification_body ?? null, input.auditor_name ?? null,
      input.scope_summary ?? null,
      input.planned_start ?? null, input.planned_end ?? null,
      input.status ?? 'scheduled', input.created_by_email ?? null,
    ]
  );
  return res.rows[0];
}

export async function listExternalAudits(filters?: {
  status?: string;
  kind?: ExternalAuditKind;
  upcoming_only?: boolean;
}): Promise<ExternalAudit[]> {
  await initAuditProgrammeTables();
  const where: string[] = [];
  const params: any[] = [];
  if (filters?.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
  if (filters?.kind)   { params.push(filters.kind);   where.push(`kind   = $${params.length}`); }
  if (filters?.upcoming_only) {
    where.push(`(planned_start IS NULL OR planned_start >= NOW()::date)`);
    where.push(`status IN ('scheduled','preparation','in_progress')`);
  }
  const sql = `SELECT * FROM external_audits
               ${where.length ? 'WHERE '+where.join(' AND ') : ''}
               ORDER BY planned_start ASC NULLS LAST, created_at DESC`;
  const res = await pool.query<ExternalAudit>(sql, params);
  return res.rows;
}

export async function getExternalAuditById(id: number): Promise<ExternalAudit | null> {
  await initAuditProgrammeTables();
  const res = await pool.query<ExternalAudit>(`SELECT * FROM external_audits WHERE id = $1`, [id]);
  return res.rows[0] || null;
}

export async function updateExternalAudit(
  id: number,
  patch: Partial<Omit<ExternalAudit,'id' | 'audit_code' | 'created_at' | 'updated_at'>>
): Promise<ExternalAudit | null> {
  await initAuditProgrammeTables();
  const fields: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i++}`);
    params.push(v);
  }
  if (fields.length === 0) return getExternalAuditById(id);
  fields.push(`updated_at = NOW()`);
  params.push(id);
  const res = await pool.query<ExternalAudit>(
    `UPDATE external_audits SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  return res.rows[0] || null;
}

export async function addChecklistItem(input: {
  external_audit_id: number;
  category: string;
  requirement: string;
  owner_email?: string;
  order_index?: number;
}): Promise<void> {
  await initAuditProgrammeTables();
  await pool.query(
    `INSERT INTO external_audit_checklist
       (external_audit_id, category, requirement, owner_email, order_index)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      input.external_audit_id, input.category, input.requirement,
      input.owner_email ?? null, input.order_index ?? 0,
    ]
  );
}

export async function listChecklist(externalAuditId: number): Promise<any[]> {
  await initAuditProgrammeTables();
  const res = await pool.query(
    `SELECT * FROM external_audit_checklist
      WHERE external_audit_id = $1
      ORDER BY order_index ASC, id ASC`,
    [externalAuditId]
  );
  return res.rows;
}

export async function updateChecklistItemFields(
  id: number,
  patch: { status?: string; owner_email?: string; evidence_link?: string; notes?: string }
): Promise<void> {
  await initAuditProgrammeTables();
  const fields: string[] = [];
  const params: any[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i++}`);
    params.push(v);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = NOW()`);
  params.push(id);
  await pool.query(
    `UPDATE external_audit_checklist SET ${fields.join(', ')} WHERE id = $${i}`,
    params
  );
  await recomputeExternalReadiness(id);
}

async function recomputeExternalReadiness(checklistItemId: number): Promise<void> {
  const auditRow = await pool.query<{ external_audit_id: number }>(
    `SELECT external_audit_id FROM external_audit_checklist WHERE id = $1`,
    [checklistItemId]
  );
  const auditId = auditRow.rows[0]?.external_audit_id;
  if (!auditId) return;
  const agg = await pool.query<{ total: string; ready: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status IN ('ready','not_applicable'))::text AS ready
     FROM external_audit_checklist WHERE external_audit_id = $1`,
    [auditId]
  );
  const total = parseInt(agg.rows[0]?.total || '0', 10);
  const ready = parseInt(agg.rows[0]?.ready || '0', 10);
  const pct = total === 0 ? 0 : Math.round((ready / total) * 100);
  await pool.query(
    `UPDATE external_audits SET readiness_percent = $1, updated_at = NOW() WHERE id = $2`,
    [pct, auditId]
  );
}

/* ------------------------------------------------------------------------- *
 * CERTIFICATES
 * ------------------------------------------------------------------------- */

export async function createCertificate(input: Omit<ExternalAuditCertificate,
  'id' | 'created_at' | 'updated_at'>
): Promise<ExternalAuditCertificate> {
  await initAuditProgrammeTables();
  const res = await pool.query<ExternalAuditCertificate>(
    `INSERT INTO external_audit_certificates
       (external_audit_id, certificate_number, standard, certification_body,
        issue_date, expiry_date, scope_statement, file_path, status, uploaded_by_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      input.external_audit_id ?? null, input.certificate_number,
      input.standard, input.certification_body,
      input.issue_date ?? null, input.expiry_date ?? null,
      input.scope_statement ?? null, input.file_path ?? null,
      input.status ?? 'active', input.uploaded_by_email ?? null,
    ]
  );
  return res.rows[0];
}

export async function listCertificates(filters?: {
  status?: string;
  expiring_within_days?: number;
}): Promise<ExternalAuditCertificate[]> {
  await initAuditProgrammeTables();
  const where: string[] = [];
  const params: any[] = [];
  if (filters?.status) { params.push(filters.status); where.push(`status = $${params.length}`); }
  if (filters?.expiring_within_days != null) {
    params.push(filters.expiring_within_days);
    where.push(`expiry_date IS NOT NULL AND expiry_date <= NOW()::date + ($${params.length} || ' days')::interval`);
  }
  const sql = `SELECT * FROM external_audit_certificates
               ${where.length ? 'WHERE '+where.join(' AND ') : ''}
               ORDER BY expiry_date ASC NULLS LAST`;
  const res = await pool.query<ExternalAuditCertificate>(sql, params);
  return res.rows;
}

/* ------------------------------------------------------------------------- *
 * AUDIT RUNS
 * ------------------------------------------------------------------------- */

export async function startAuditRun(input: Omit<AuditRun,
  'id' | 'run_code' | 'started_at' | 'finished_at' | 'status' | 'summary'>
): Promise<AuditRun> {
  await initAuditProgrammeTables();
  const code = await nextRunCode();
  const res = await pool.query<AuditRun>(
    `INSERT INTO audit_runs
       (run_code, run_type, title, module_in_scope, linked_audit_id,
        linked_programme_id, status, created_by_email)
     VALUES ($1,$2,$3,$4,$5,$6,'running',$7)
     RETURNING *`,
    [
      code, input.run_type, input.title, input.module_in_scope ?? null,
      input.linked_audit_id ?? null, input.linked_programme_id ?? null,
      input.created_by_email ?? null,
    ]
  );
  return res.rows[0];
}

export async function closeAuditRun(
  id: number,
  status: 'completed' | 'failed' | 'cancelled',
  summary?: any
): Promise<void> {
  await pool.query(
    `UPDATE audit_runs SET status = $1, summary = $2, finished_at = NOW() WHERE id = $3`,
    [status, JSON.stringify(summary ?? {}), id]
  );
}

export async function listAuditRuns(limit = 50): Promise<AuditRun[]> {
  await initAuditProgrammeTables();
  const res = await pool.query<AuditRun>(
    `SELECT * FROM audit_runs ORDER BY started_at DESC LIMIT $1`,
    [Math.min(limit, 200)]
  );
  return res.rows;
}

/* ------------------------------------------------------------------------- *
 * DASHBOARD SUMMARIES
 * ------------------------------------------------------------------------- */

export async function getExternalAuditsSummary(): Promise<{
  upcoming: number;
  in_progress: number;
  next_audit: ExternalAudit | null;
  certs_active: number;
  certs_expiring_90d: number;
}> {
  await initAuditProgrammeTables();
  const [next, upcoming, inProgress, active, expiring] = await Promise.all([
    pool.query<ExternalAudit>(
      `SELECT * FROM external_audits
        WHERE status IN ('scheduled','preparation','in_progress')
          AND (planned_start IS NULL OR planned_start >= NOW()::date)
        ORDER BY planned_start ASC NULLS LAST
        LIMIT 1`
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_audits
        WHERE status IN ('scheduled','preparation')`
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_audits WHERE status = 'in_progress'`
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_audit_certificates WHERE status = 'active'`
    ),
    pool.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_audit_certificates
        WHERE status = 'active' AND expiry_date IS NOT NULL
          AND expiry_date <= NOW()::date + INTERVAL '90 days'`
    ),
  ]);

  return {
    upcoming:            parseInt(upcoming.rows[0]?.n || '0', 10),
    in_progress:         parseInt(inProgress.rows[0]?.n || '0', 10),
    next_audit:          next.rows[0] || null,
    certs_active:        parseInt(active.rows[0]?.n || '0', 10),
    certs_expiring_90d:  parseInt(expiring.rows[0]?.n || '0', 10),
  };
}

export { pool as auditProgrammePool };
