import pg from "pg";
import { logger } from "./logger";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface CallRecord {
  id?: number;
  call_id: string;
  source:
    | "five9"
    | "twilio"
    | "mobile"
    | "google_meet"
    | "google_drive"
    | "bulk_upload"
    | "manual"
    | "api";
  lead_id?: string;
  deal_id?: string;
  contact_name?: string;
  agent_email: string;
  agent_name?: string;
  direction: "inbound" | "outbound";
  duration_seconds?: number;
  recording_url?: string;
  call_date?: Date;
  status: "pending" | "processing" | "analyzed" | "failed";
  metadata?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface CallTranscript {
  id?: number;
  call_record_id: number;
  transcript_text: string;
  speaker_segments?: any;
  word_timestamps?: any;
  language?: string;
  confidence_score?: number;
  created_at?: Date;
}

export interface CallAnalysis {
  id?: number;
  call_record_id: number;
  sentiment_score: number;
  sentiment_label: "positive" | "neutral" | "negative";
  voice_of_customer?: string;
  objections_detected?: any;
  key_topics?: any;
  action_items?: any;
  next_steps?: any;
  call_summary?: string;
  talk_ratio?: number;
  keywords?: any;
  ai_insights?: string;
  created_at?: Date;
}

export interface CallQAScore {
  id?: number;
  call_record_id: number;
  scorecard_type: "sdr" | "sales";
  total_score: number;
  max_score: number;
  score_percentage: number;
  criteria_scores?: any;
  strengths?: any;
  improvements?: any;
  coaching_notes?: string;
  evaluator?: string;
  evaluated_at?: Date;
  created_at?: Date;
}

export interface CallCompliance {
  id?: number;
  call_record_id: number;
  lead_id?: string;
  deal_id?: string;
  notes_updated: boolean;
  call_logged: boolean;
  task_created: boolean;
  stage_updated: boolean;
  meeting_outcome_logged: boolean;
  overall_compliance: boolean;
  compliance_score: number;
  missing_actions?: any;
  compliance_details?: any;
  checked_at?: Date;
  created_at?: Date;
}

export interface MeetingMOM {
  id?: number;
  call_record_id?: number;
  calendar_event_id: string;
  meeting_title: string;
  meeting_date: Date;
  attendees?: any;
  summary: string;
  key_decisions?: any;
  action_items?: any;
  follow_ups?: any;
  next_meeting_date?: Date;
  notes?: string;
  created_at?: Date;
}

export interface CallGovernanceResult {
  id?: number;
  call_record_id: number;
  ruleset_version: string | null;
  verdict: "ok" | "needs_attention" | "critical";
  critical_count: number;
  warning_count: number;
  info_count: number;
  issues: any;
  suggested_updates: any;
  lead_match: any;
  load_error: string | null;
  evaluated_at?: Date;
  created_at?: Date;
}

export async function initCallIntelligenceTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_records (
      id SERIAL PRIMARY KEY,
      call_id VARCHAR(255) UNIQUE NOT NULL,
      source VARCHAR(50) NOT NULL,
      lead_id VARCHAR(255),
      deal_id VARCHAR(255),
      contact_name VARCHAR(255),
      agent_email VARCHAR(255) NOT NULL,
      agent_name VARCHAR(255),
      direction VARCHAR(20) NOT NULL DEFAULT 'outbound',
      duration_seconds INTEGER,
      recording_url TEXT,
      call_date TIMESTAMP,
      status VARCHAR(50) NOT NULL DEFAULT 'pending',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS call_transcripts (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER REFERENCES call_records(id) ON DELETE CASCADE,
      transcript_text TEXT NOT NULL,
      speaker_segments JSONB,
      word_timestamps JSONB,
      language VARCHAR(20) DEFAULT 'en',
      confidence_score DECIMAL(5,2),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS call_analysis (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER REFERENCES call_records(id) ON DELETE CASCADE,
      sentiment_score DECIMAL(5,2) NOT NULL,
      sentiment_label VARCHAR(20) NOT NULL,
      voice_of_customer TEXT,
      objections_detected JSONB,
      key_topics JSONB,
      action_items JSONB,
      next_steps JSONB,
      call_summary TEXT,
      talk_ratio DECIMAL(5,2),
      keywords JSONB,
      ai_insights TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS call_qa_scores (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER REFERENCES call_records(id) ON DELETE CASCADE,
      scorecard_type VARCHAR(20) NOT NULL,
      total_score DECIMAL(10,2) NOT NULL,
      max_score DECIMAL(10,2) NOT NULL,
      score_percentage DECIMAL(5,2) NOT NULL,
      criteria_scores JSONB,
      strengths JSONB,
      improvements JSONB,
      coaching_notes TEXT,
      evaluator VARCHAR(255),
      evaluated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS call_compliance (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER REFERENCES call_records(id) ON DELETE CASCADE,
      lead_id VARCHAR(255),
      deal_id VARCHAR(255),
      notes_updated BOOLEAN DEFAULT FALSE,
      call_logged BOOLEAN DEFAULT FALSE,
      task_created BOOLEAN DEFAULT FALSE,
      stage_updated BOOLEAN DEFAULT FALSE,
      meeting_outcome_logged BOOLEAN DEFAULT FALSE,
      overall_compliance BOOLEAN DEFAULT FALSE,
      compliance_score DECIMAL(5,2) DEFAULT 0,
      missing_actions JSONB,
      compliance_details JSONB,
      checked_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS meeting_mom (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER REFERENCES call_records(id) ON DELETE SET NULL,
      calendar_event_id VARCHAR(255) NOT NULL,
      meeting_title VARCHAR(500) NOT NULL,
      meeting_date TIMESTAMP NOT NULL,
      attendees JSONB,
      summary TEXT NOT NULL,
      key_decisions JSONB,
      action_items JSONB,
      follow_ups JSONB,
      next_meeting_date TIMESTAMP,
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ai_training_feedback (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER REFERENCES call_records(id) ON DELETE CASCADE,
      evaluation_id INTEGER,
      feedback_type VARCHAR(50) NOT NULL,
      details TEXT,
      submitted_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS call_governance_results (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER NOT NULL UNIQUE REFERENCES call_records(id) ON DELETE CASCADE,
      ruleset_version VARCHAR(64),
      verdict VARCHAR(32) NOT NULL,
      critical_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0,
      info_count INTEGER NOT NULL DEFAULT 0,
      issues JSONB,
      suggested_updates JSONB,
      lead_match JSONB,
      load_error TEXT,
      evaluated_at TIMESTAMP NOT NULL DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_call_governance_results_verdict ON call_governance_results(verdict);
    CREATE INDEX IF NOT EXISTS idx_call_governance_results_evaluated_at ON call_governance_results(evaluated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_records_source ON call_records(source);
    CREATE INDEX IF NOT EXISTS idx_call_records_agent ON call_records(agent_email);
    CREATE INDEX IF NOT EXISTS idx_call_records_status ON call_records(status);
    CREATE INDEX IF NOT EXISTS idx_call_records_lead ON call_records(lead_id);
    CREATE INDEX IF NOT EXISTS idx_call_records_deal ON call_records(deal_id);
    CREATE INDEX IF NOT EXISTS idx_call_records_date ON call_records(call_date);
    CREATE INDEX IF NOT EXISTS idx_call_records_original_filename
      ON call_records ((metadata->>'original_filename'))
      WHERE metadata->>'original_filename' IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_call_compliance_lead ON call_compliance(lead_id);
    CREATE INDEX IF NOT EXISTS idx_meeting_mom_event ON meeting_mom(calendar_event_id);
    CREATE INDEX IF NOT EXISTS idx_ai_feedback_type ON ai_training_feedback(feedback_type);

    CREATE TABLE IF NOT EXISTS sdr_call_evaluations (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER REFERENCES call_records(id) ON DELETE CASCADE,
      scorecard_id INTEGER,
      scorecard_name VARCHAR(255),
      overall_score DECIMAL(5,2),
      dimension_scores JSONB,
      attribute_evaluations JSONB,
      top_strengths JSONB,
      top_gaps JSONB,
      coaching_actions JSONB,
      critical_risks JSONB,
      coaching_message_ar TEXT,
      coaching_message_en TEXT,
      micro_training_topics JSONB,
      key_moments JSONB,
      evaluated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(),
      -- DMAIC Scorecard Consolidation Step 5 — preserve v1.5 scores
      -- when a row is backfilled against the COPC v2 scorecard so the
      -- original (pre-consolidation) audit number stays visible
      -- forever. Set by scripts/backfillScorecardV2.ts before the
      -- COPC re-score writes the new overall_score / dimension_scores.
      legacy_score_v1 DECIMAL(5,2),
      legacy_dimension_scores_v1 JSONB,
      legacy_scorecard_name_v1 VARCHAR(255),
      backfilled_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sdr_eval_call ON sdr_call_evaluations(call_record_id);
    -- Idempotent column adds for existing deployments where the
    -- CREATE TABLE ran before the v2 legacy columns existed.
    ALTER TABLE sdr_call_evaluations
      ADD COLUMN IF NOT EXISTS legacy_score_v1 DECIMAL(5,2),
      ADD COLUMN IF NOT EXISTS legacy_dimension_scores_v1 JSONB,
      ADD COLUMN IF NOT EXISTS legacy_scorecard_name_v1 VARCHAR(255),
      ADD COLUMN IF NOT EXISTS backfilled_at TIMESTAMP;

    CREATE TABLE IF NOT EXISTS sdr_evaluation_reviews (
      id SERIAL PRIMARY KEY,
      evaluation_id INTEGER NOT NULL REFERENCES sdr_call_evaluations(id) ON DELETE CASCADE,
      call_record_id INTEGER NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
      reviewer_email VARCHAR(255) NOT NULL,
      reviewer_name VARCHAR(255),
      review_status VARCHAR(20) NOT NULL CHECK (review_status IN ('approved','adjusted','disagreed')),
      adjusted_overall_score DECIMAL(5,2),
      adjusted_dimension_scores JSONB,
      adjusted_attribute_evaluations JSONB,
      review_notes TEXT,
      reviewed_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sdr_eval_reviews_eval ON sdr_evaluation_reviews(evaluation_id);
    CREATE INDEX IF NOT EXISTS idx_sdr_eval_reviews_call ON sdr_evaluation_reviews(call_record_id);
    CREATE INDEX IF NOT EXISTS idx_sdr_eval_reviews_reviewer ON sdr_evaluation_reviews(reviewer_email);
  `);

  // One-shot backfill: earlier versions of the bulk-audio upload
  // stored the phone number extracted from the filename directly in
  // call_records.lead_id. That value is not a Zoho Lead record-id, so
  // the CRM Link cell built /crm/.../tab/Leads/+966... → Invalid URL,
  // and the auto-link matcher then refused to overwrite the "already
  // set" lead_id. Move the phone into metadata.contact_phone (where
  // the renderer already looks for it) and clear lead_id so the
  // matcher can populate the real id next time it runs.
  //
  // Idempotent: the WHERE filter only matches rows still in the bad
  // state, so running this on every init is a no-op once clean.
  try {
    await pool.query(`
      UPDATE call_records
         SET metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('contact_phone', lead_id),
             lead_id = NULL
       WHERE lead_id ~ '^\\+?\\d[\\d\\s\\-()]{4,}$'
         AND (metadata->>'contact_phone') IS NULL
    `);
  } catch {
    // Best-effort: never block init on a backfill failure.
  }

  // Fire-and-forget: legacy rows are missing phone metadata, audio
  // duration, and CRM lead/deal links because they were ingested
  // before the auto-link + whisper-1 fixes. The boot sweep is
  // idempotent (each pass has a WHERE filter that skips already-
  // populated rows) and the auto-link pass is per-boot-capped so
  // a 200-row backlog can't blow through the Zoho daily quota in
  // one cold start.
  try {
    const { backfillUnpopulatedCallData } = await import(
      "./callIntelligenceBackfill"
    );
    void backfillUnpopulatedCallData().catch(() => {
      /* swallowed inside the sweep itself */
    });
  } catch {
    /* module load failure — never block init */
  }
}

/**
 * Look up an existing call_record by the original filename captured in
 * metadata at upload time. Used by the upload routes to reject duplicate
 * uploads of the same audio file (same source filename) so analytics,
 * SDR scores, and compliance trends are not skewed by re-ingesting the
 * same call multiple times.
 *
 * Returns the first matching row (by ascending id) or null. Comparison
 * is case-sensitive and exact — matches what the browser File API
 * reports as `file.name`.
 */
export async function findCallRecordByOriginalFilename(
  filename: string,
): Promise<{ id: number; call_id: string; agent_email: string; call_date: Date | null; status: string } | null> {
  if (!filename) return null;
  const result = await pool.query(
    `SELECT id, call_id, agent_email, call_date, status
       FROM call_records
      WHERE metadata->>'original_filename' = $1
      ORDER BY id ASC
      LIMIT 1`,
    [filename],
  );
  return result.rows[0] || null;
}

export async function createCallRecord(
  record: CallRecord,
): Promise<CallRecord> {
  const result = await pool.query(
    `INSERT INTO call_records 
     (call_id, source, lead_id, deal_id, contact_name, agent_email, agent_name, direction, duration_seconds, recording_url, call_date, status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (call_id) DO UPDATE SET
       status = EXCLUDED.status,
       updated_at = NOW()
     RETURNING *`,
    [
      record.call_id,
      record.source,
      record.lead_id || null,
      record.deal_id || null,
      record.contact_name || null,
      record.agent_email,
      record.agent_name || null,
      record.direction || "outbound",
      record.duration_seconds || null,
      record.recording_url || null,
      record.call_date || new Date(),
      record.status || "pending",
      JSON.stringify(record.metadata || {}),
    ],
  );
  return result.rows[0];
}

export async function updateCallRecord(
  id: number,
  updates: Partial<CallRecord>,
): Promise<CallRecord | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (updates.status !== undefined) {
    fields.push(`status = $${paramIndex}`);
    values.push(updates.status);
    paramIndex++;
  }

  if (updates.duration_seconds !== undefined) {
    fields.push(`duration_seconds = $${paramIndex}`);
    values.push(updates.duration_seconds);
    paramIndex++;
  }

  if (updates.metadata !== undefined) {
    fields.push(`metadata = $${paramIndex}`);
    values.push(JSON.stringify(updates.metadata));
    paramIndex++;
  }

  fields.push("updated_at = NOW()");

  if (fields.length === 1) return null;

  values.push(id);

  const result = await pool.query(
    `UPDATE call_records SET ${fields.join(", ")} WHERE id = $${paramIndex} RETURNING *`,
    values,
  );

  return result.rows[0] || null;
}

export async function updateCallRecordLeadId(
  id: number,
  leadId: string,
): Promise<CallRecord | null> {
  const result = await pool.query(
    `UPDATE call_records SET lead_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [leadId, id],
  );
  return result.rows[0] || null;
}

export async function updateCallRecordDealId(
  id: number,
  dealId: string,
): Promise<CallRecord | null> {
  const result = await pool.query(
    `UPDATE call_records SET deal_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [dealId, id],
  );
  return result.rows[0] || null;
}

// Persist which signal produced the CRM link — "phone" (digit match
// against Leads/Deals) or "activity" (same-day same-agent CRM activity).
// Diagnostic only; the eval panel surfaces this as a confidence badge.
// Idempotent column add so existing deploys don't need a migration step.
let _linkedViaColumnReady: Promise<void> | null = null;
async function ensureLinkedViaColumn(): Promise<void> {
  if (_linkedViaColumnReady) return _linkedViaColumnReady;
  _linkedViaColumnReady = pool
    .query(
      `ALTER TABLE call_records ADD COLUMN IF NOT EXISTS linked_via VARCHAR(20)`,
    )
    .then(() => undefined)
    .catch((err) => {
      logger.warn("[CallDB] linked_via column add failed (will retry):", err);
      _linkedViaColumnReady = null;
    });
  return _linkedViaColumnReady;
}

export async function updateCallRecordLinkedVia(
  id: number,
  linkedVia: "phone" | "activity",
): Promise<void> {
  await ensureLinkedViaColumn();
  await pool.query(
    `UPDATE call_records SET linked_via = $1, updated_at = NOW() WHERE id = $2`,
    [linkedVia, id],
  );
}

export async function getCallRecordById(
  id: number,
): Promise<CallRecord | null> {
  const result = await pool.query("SELECT * FROM call_records WHERE id = $1", [
    id,
  ]);
  return result.rows[0] || null;
}

/**
 * Hard-delete a call record and its dependent rows. Returns the number of
 * call_records rows actually removed (0 if the id did not exist).
 *
 * Children deleted in dependency order (best-effort: tables that may not exist
 * in every install are wrapped so a missing-relation error doesn't abort the
 * whole transaction).
 */
export async function deleteCallRecord(id: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const childTables = [
      "call_transcripts",
      "call_analysis",
      "call_qa_scores",
      "call_compliance",
    ];
    for (const tbl of childTables) {
      try {
        await client.query(`DELETE FROM ${tbl} WHERE call_record_id = $1`, [
          id,
        ]);
      } catch (err: any) {
        // Tolerate "relation does not exist" / "column does not exist" so a
        // partial schema doesn't block the parent delete.
        if (err && (err.code === "42P01" || err.code === "42703")) continue;
        throw err;
      }
    }
    const result = await client.query(
      "DELETE FROM call_records WHERE id = $1",
      [id],
    );
    await client.query("COMMIT");
    return result.rowCount || 0;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

export async function getCallRecordByCallId(
  callId: string,
): Promise<CallRecord | null> {
  const result = await pool.query(
    "SELECT * FROM call_records WHERE call_id = $1",
    [callId],
  );
  return result.rows[0] || null;
}

export async function getCallRecords(
  options: {
    limit?: number;
    offset?: number;
    source?: string;
    agent_email?: string;
    status?: string;
    lead_id?: string;
    startDate?: Date;
    endDate?: Date;
  } = {},
): Promise<{ records: CallRecord[]; total: number }> {
  const {
    limit = 50,
    offset = 0,
    source,
    agent_email,
    status,
    lead_id,
    startDate,
    endDate,
  } = options;

  let whereClause = "WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (source) {
    whereClause += ` AND source = $${paramIndex}`;
    params.push(source);
    paramIndex++;
  }

  if (agent_email) {
    whereClause += ` AND agent_email = $${paramIndex}`;
    params.push(agent_email);
    paramIndex++;
  }

  if (status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(status);
    paramIndex++;
  }

  if (lead_id) {
    whereClause += ` AND lead_id = $${paramIndex}`;
    params.push(lead_id);
    paramIndex++;
  }

  if (startDate) {
    whereClause += ` AND call_date >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereClause += ` AND call_date <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM call_records ${whereClause}`,
    params,
  );

  // Medium #6 v1.1 — surface the canonical (adjusted-or-AI) SDR score
  // on each row so the SDR Evaluation tab's score badge reflects what
  // the manager review settled on. COALESCE picks the manager's
  // adjusted_overall_score when a review exists, else the raw AI score.
  // LATERAL subquery picks the most recent review per evaluation.
  const result = await pool.query(
    `SELECT cr.*,
            COALESCE(latest_review.adjusted_overall_score, se.overall_score) AS sdr_overall_score,
            se.overall_score AS sdr_ai_overall_score,
            latest_review.adjusted_overall_score AS sdr_adjusted_overall_score,
            latest_review.review_status AS sdr_latest_review_status
       FROM call_records cr
       LEFT JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
       LEFT JOIN LATERAL (
         SELECT adjusted_overall_score, review_status
         FROM sdr_evaluation_reviews sr
         WHERE sr.evaluation_id = se.id
         ORDER BY sr.reviewed_at DESC
         LIMIT 1
       ) latest_review ON TRUE
       ${whereClause.replace(/\b(source|agent_email|status|lead_id|call_date)\b/g, "cr.$1")}
       ORDER BY cr.call_date DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, limit, offset],
  );

  return {
    records: result.rows,
    total: parseInt(countResult.rows[0].count),
  };
}

export async function saveTranscript(
  transcript: CallTranscript,
): Promise<CallTranscript> {
  const result = await pool.query(
    `INSERT INTO call_transcripts
     (call_record_id, transcript_text, speaker_segments, word_timestamps, language, confidence_score)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      transcript.call_record_id,
      transcript.transcript_text,
      JSON.stringify(transcript.speaker_segments || null),
      JSON.stringify(transcript.word_timestamps || null),
      transcript.language || "en",
      transcript.confidence_score || null,
    ],
  );
  await autoTriggerGovernanceAfterTranscript(transcript.call_record_id);
  return result.rows[0];
}

export async function getTranscriptByCallId(
  callRecordId: number,
): Promise<CallTranscript | null> {
  const result = await pool.query(
    "SELECT * FROM call_transcripts WHERE call_record_id = $1",
    [callRecordId],
  );
  return result.rows[0] || null;
}

export async function saveGovernanceResult(
  result: CallGovernanceResult,
): Promise<CallGovernanceResult> {
  const row = await pool.query(
    `INSERT INTO call_governance_results
       (call_record_id, ruleset_version, verdict, critical_count, warning_count, info_count,
        issues, suggested_updates, lead_match, load_error, evaluated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (call_record_id) DO UPDATE SET
       ruleset_version    = EXCLUDED.ruleset_version,
       verdict            = EXCLUDED.verdict,
       critical_count     = EXCLUDED.critical_count,
       warning_count      = EXCLUDED.warning_count,
       info_count         = EXCLUDED.info_count,
       issues             = EXCLUDED.issues,
       suggested_updates  = EXCLUDED.suggested_updates,
       lead_match         = EXCLUDED.lead_match,
       load_error         = EXCLUDED.load_error,
       evaluated_at       = NOW()
     RETURNING *`,
    [
      result.call_record_id,
      result.ruleset_version,
      result.verdict,
      result.critical_count,
      result.warning_count,
      result.info_count,
      JSON.stringify(result.issues ?? []),
      JSON.stringify(result.suggested_updates ?? []),
      JSON.stringify(result.lead_match ?? null),
      result.load_error,
    ],
  );
  return row.rows[0];
}

export async function getGovernanceResultByCallId(
  callRecordId: number,
): Promise<CallGovernanceResult | null> {
  const row = await pool.query(
    "SELECT * FROM call_governance_results WHERE call_record_id = $1",
    [callRecordId],
  );
  return row.rows[0] || null;
}

/**
 * Auto-trigger hook: after a transcript is saved, run the SDR governance + reconciliation
 * orchestrator and upsert the result. Error-isolated — a governance failure must never
 * break the transcription flow. Dynamic import breaks the circular static dep with
 * sdrCallValidation (which imports save/get from this module).
 *
 * Toggle off with SDR_GOVERNANCE_AUTOTRIGGER=off (e.g. for migration scripts).
 */
async function autoTriggerGovernanceAfterTranscript(callRecordId: number): Promise<void> {
  if (process.env.SDR_GOVERNANCE_AUTOTRIGGER === "off") return;
  try {
    const { evaluateAndPersistGovernance } = await import("./sdrCallValidation");
    await evaluateAndPersistGovernance(callRecordId);
  } catch (err) {
    logger.warn("[governance autotrigger] failed", {
      call_record_id: callRecordId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function saveCallAnalysis(
  analysis: CallAnalysis,
): Promise<CallAnalysis> {
  const result = await pool.query(
    `INSERT INTO call_analysis 
     (call_record_id, sentiment_score, sentiment_label, voice_of_customer, objections_detected, 
      key_topics, action_items, next_steps, call_summary, talk_ratio, keywords, ai_insights)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      analysis.call_record_id,
      analysis.sentiment_score,
      analysis.sentiment_label,
      analysis.voice_of_customer || null,
      JSON.stringify(analysis.objections_detected || null),
      JSON.stringify(analysis.key_topics || null),
      JSON.stringify(analysis.action_items || null),
      JSON.stringify(analysis.next_steps || null),
      analysis.call_summary || null,
      analysis.talk_ratio || null,
      JSON.stringify(analysis.keywords || null),
      analysis.ai_insights || null,
    ],
  );
  return result.rows[0];
}

export async function getAnalysisByCallId(
  callRecordId: number,
): Promise<CallAnalysis | null> {
  const result = await pool.query(
    "SELECT * FROM call_analysis WHERE call_record_id = $1",
    [callRecordId],
  );
  return result.rows[0] || null;
}

export async function saveQAScore(score: CallQAScore): Promise<CallQAScore> {
  const result = await pool.query(
    `INSERT INTO call_qa_scores 
     (call_record_id, scorecard_type, total_score, max_score, score_percentage, 
      criteria_scores, strengths, improvements, coaching_notes, evaluator)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      score.call_record_id,
      score.scorecard_type,
      score.total_score,
      score.max_score,
      score.score_percentage,
      JSON.stringify(score.criteria_scores || null),
      JSON.stringify(score.strengths || null),
      JSON.stringify(score.improvements || null),
      score.coaching_notes || null,
      score.evaluator || "AI",
    ],
  );
  return result.rows[0];
}

export async function getQAScoreByCallId(
  callRecordId: number,
): Promise<CallQAScore | null> {
  const result = await pool.query(
    "SELECT * FROM call_qa_scores WHERE call_record_id = $1",
    [callRecordId],
  );
  return result.rows[0] || null;
}

export async function saveCompliance(
  compliance: CallCompliance,
): Promise<CallCompliance> {
  const result = await pool.query(
    `INSERT INTO call_compliance 
     (call_record_id, lead_id, deal_id, notes_updated, call_logged, task_created, 
      stage_updated, meeting_outcome_logged, overall_compliance, compliance_score, 
      missing_actions, compliance_details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      compliance.call_record_id,
      compliance.lead_id || null,
      compliance.deal_id || null,
      compliance.notes_updated,
      compliance.call_logged,
      compliance.task_created,
      compliance.stage_updated,
      compliance.meeting_outcome_logged,
      compliance.overall_compliance,
      compliance.compliance_score,
      JSON.stringify(compliance.missing_actions || null),
      JSON.stringify(compliance.compliance_details || null),
    ],
  );
  return result.rows[0];
}

export async function getComplianceByCallId(
  callRecordId: number,
): Promise<CallCompliance | null> {
  const result = await pool.query(
    "SELECT * FROM call_compliance WHERE call_record_id = $1",
    [callRecordId],
  );
  return result.rows[0] || null;
}

export async function getComplianceRecords(
  options: {
    limit?: number;
    offset?: number;
    lead_id?: string;
    agent_email?: string;
  } = {},
): Promise<{ records: CallCompliance[]; total: number }> {
  const { limit = 50, offset = 0, lead_id, agent_email } = options;

  let query = `
    SELECT cc.*, cr.agent_email, cr.agent_name, cr.contact_name, cr.call_date
    FROM call_compliance cc
    JOIN call_records cr ON cc.call_record_id = cr.id
    WHERE 1=1
  `;
  const params: any[] = [];
  let paramIndex = 1;

  if (lead_id) {
    query += ` AND cc.lead_id = $${paramIndex++}`;
    params.push(lead_id);
  }

  if (agent_email) {
    query += ` AND cr.agent_email = $${paramIndex++}`;
    params.push(agent_email);
  }

  query += ` ORDER BY cc.created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  params.push(limit, offset);

  const result = await pool.query(query, params);

  let countQuery = `
    SELECT COUNT(*) as total 
    FROM call_compliance cc
    JOIN call_records cr ON cc.call_record_id = cr.id
    WHERE 1=1
  `;
  const countParams: any[] = [];
  let countParamIndex = 1;

  if (lead_id) {
    countQuery += ` AND cc.lead_id = $${countParamIndex++}`;
    countParams.push(lead_id);
  }

  if (agent_email) {
    countQuery += ` AND cr.agent_email = $${countParamIndex++}`;
    countParams.push(agent_email);
  }

  const countResult = await pool.query(countQuery, countParams);

  return {
    records: result.rows,
    total: parseInt(countResult.rows[0].total),
  };
}

export async function saveMeetingMOM(mom: MeetingMOM): Promise<MeetingMOM> {
  const result = await pool.query(
    `INSERT INTO meeting_mom 
     (call_record_id, calendar_event_id, meeting_title, meeting_date, attendees, 
      summary, key_decisions, action_items, follow_ups, next_meeting_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      mom.call_record_id || null,
      mom.calendar_event_id,
      mom.meeting_title,
      mom.meeting_date,
      JSON.stringify(mom.attendees || null),
      mom.summary,
      JSON.stringify(mom.key_decisions || null),
      JSON.stringify(mom.action_items || null),
      JSON.stringify(mom.follow_ups || null),
      mom.next_meeting_date || null,
      mom.notes || null,
    ],
  );
  return result.rows[0];
}

export async function getMOMByEventId(
  calendarEventId: string,
): Promise<MeetingMOM | null> {
  const result = await pool.query(
    "SELECT * FROM meeting_mom WHERE calendar_event_id = $1",
    [calendarEventId],
  );
  return result.rows[0] || null;
}

export async function getCallWithFullAnalysis(callRecordId: number): Promise<{
  record: CallRecord | null;
  transcript: CallTranscript | null;
  analysis: CallAnalysis | null;
  qaScore: CallQAScore | null;
  compliance: CallCompliance | null;
}> {
  const [record, transcript, analysis, qaScore, compliance] = await Promise.all(
    [
      getCallRecordById(callRecordId),
      getTranscriptByCallId(callRecordId),
      getAnalysisByCallId(callRecordId),
      getQAScoreByCallId(callRecordId),
      getComplianceByCallId(callRecordId),
    ],
  );

  return { record, transcript, analysis, qaScore, compliance };
}

export async function getCallAnalyticsSummary(
  options: {
    startDate?: Date;
    endDate?: Date;
    agent_email?: string;
  } = {},
): Promise<{
  totalCalls: number;
  analyzedCalls: number;
  avgSentimentScore: number;
  avgQAScore: number;
  avgComplianceScore: number;
  callsBySource: any[];
  callsByAgent: any[];
  complianceBreakdown: any;
  sentimentDistribution: Array<{ label: string; count: number }>;
  qaScoreTrend: Array<{ week_start: string; avg_score: number; sample_size: number }>;
}> {
  const { startDate, endDate, agent_email } = options;

  let whereClause = "WHERE 1=1";
  const params: any[] = [];
  let paramIndex = 1;

  if (startDate) {
    whereClause += ` AND cr.call_date >= $${paramIndex}`;
    params.push(startDate);
    paramIndex++;
  }

  if (endDate) {
    whereClause += ` AND cr.call_date <= $${paramIndex}`;
    params.push(endDate);
    paramIndex++;
  }

  if (agent_email) {
    whereClause += ` AND cr.agent_email = $${paramIndex}`;
    params.push(agent_email);
    paramIndex++;
  }

  // Headline avg_qa_score uses the same canonical-score rule as the
  // per-agent breakdown below: when a manager review carries an
  // adjusted_overall_score, that value wins over the raw AI score.
  // Prior to this fix the headline read from the legacy call_qa_scores
  // table while per-agent rows read from sdr_call_evaluations with
  // COALESCE — inconsistent UX where headline and rows disagreed.
  const summaryResult = await pool.query(
    `
    SELECT
      COUNT(DISTINCT cr.id) as total_calls,
      COUNT(DISTINCT CASE WHEN cr.status = 'analyzed' THEN cr.id END) as analyzed_calls,
      AVG(ca.sentiment_score) as avg_sentiment,
      AVG(COALESCE(latest_review.adjusted_overall_score, se.overall_score)) as avg_qa_score,
      AVG(cc.compliance_score) as avg_compliance
    FROM call_records cr
    LEFT JOIN call_analysis ca ON cr.id = ca.call_record_id
    LEFT JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
    LEFT JOIN LATERAL (
      SELECT adjusted_overall_score
      FROM sdr_evaluation_reviews sr
      WHERE sr.evaluation_id = se.id
        AND sr.adjusted_overall_score IS NOT NULL
      ORDER BY sr.reviewed_at DESC
      LIMIT 1
    ) latest_review ON TRUE
    LEFT JOIN call_compliance cc ON cr.id = cc.call_record_id
    ${whereClause}
  `,
    params,
  );

  const bySourceResult = await pool.query(
    `
    SELECT source, COUNT(*) as count
    FROM call_records cr
    ${whereClause}
    GROUP BY source
  `,
    params,
  );

  // Phase C — per-agent averages across every measurement surface
  // (sentiment, QA score from Phase B, compliance). LEFT JOINs so an
  // agent with calls but no analysis still appears (Avg columns fall
  // to NULL → "--" in the UI). Wrapped in try/catch so a bad schema
  // or missing table never 500s the whole analytics endpoint —
  // falls back to a count-only query that always works.
  //
  // Medium #6 v1.1 — Canonical-score rule: when a manager review row
  // exists with an adjusted_overall_score, that value wins over the
  // raw AI score. Use a lateral subquery to pick the most recent
  // review per evaluation; COALESCE makes the change transparent to
  // every downstream consumer (eval list, Analytics, Excel export).
  let byAgentResult: any;
  try {
    byAgentResult = await pool.query(
      `
      SELECT
        cr.agent_email,
        cr.agent_name,
        COUNT(*) AS count,
        AVG(ca.sentiment_score) AS avg_sentiment,
        AVG(COALESCE(latest_review.adjusted_overall_score, se.overall_score)) AS avg_qa_score,
        AVG(cc.compliance_score) AS avg_compliance
      FROM call_records cr
      LEFT JOIN call_analysis ca ON ca.call_record_id = cr.id
      LEFT JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
      LEFT JOIN LATERAL (
        SELECT adjusted_overall_score
        FROM sdr_evaluation_reviews sr
        WHERE sr.evaluation_id = se.id
          AND sr.adjusted_overall_score IS NOT NULL
        ORDER BY sr.reviewed_at DESC
        LIMIT 1
      ) latest_review ON TRUE
      LEFT JOIN call_compliance cc ON cc.call_record_id = cr.id
      ${whereClause}
      GROUP BY cr.agent_email, cr.agent_name
      ORDER BY count DESC
      LIMIT 10
    `,
      params,
    );
  } catch (perAgentErr) {
    logger.warn(
      "Per-agent metrics query failed, falling back to count-only:",
      perAgentErr,
    );
    byAgentResult = await pool.query(
      `
      SELECT agent_email, agent_name, COUNT(*) AS count
      FROM call_records cr
      ${whereClause}
      GROUP BY agent_email, agent_name
      ORDER BY count DESC
      LIMIT 10
    `,
      params,
    );
  }

  // Sentiment distribution + weekly QA trend power the Analytics charts.
  // Until now the charts rendered hardcoded mock data (60/30/10 sentiment,
  // 75/78/82/85 trend); managers couldn't tell whether the dashboard
  // reflected reality. Wrapped in try/catch so a missing table never
  // takes down the whole analytics response.
  let sentimentDistribution: Array<{ label: string; count: number }> = [];
  try {
    const r = await pool.query(
      `SELECT COALESCE(ca.sentiment_label, 'unknown') AS label, COUNT(*)::int AS count
         FROM call_records cr
         JOIN call_analysis ca ON ca.call_record_id = cr.id
         ${whereClause}
         GROUP BY ca.sentiment_label`,
      params,
    );
    sentimentDistribution = r.rows.map((row: any) => ({
      label: row.label,
      count: row.count,
    }));
  } catch (e) {
    logger.warn("Sentiment distribution query failed:", e);
  }

  let qaScoreTrend: Array<{ week_start: string; avg_score: number; sample_size: number }> = [];
  try {
    const r = await pool.query(
      `SELECT
         to_char(date_trunc('week', cr.call_date), 'YYYY-MM-DD') AS week_start,
         AVG(COALESCE(latest_review.adjusted_overall_score, se.overall_score)) AS avg_score,
         COUNT(*)::int AS sample_size
       FROM call_records cr
       JOIN sdr_call_evaluations se ON se.call_record_id = cr.id
       LEFT JOIN LATERAL (
         SELECT adjusted_overall_score FROM sdr_evaluation_reviews sr
          WHERE sr.evaluation_id = se.id AND sr.adjusted_overall_score IS NOT NULL
          ORDER BY sr.reviewed_at DESC LIMIT 1
       ) latest_review ON TRUE
       ${whereClause}
       AND cr.call_date IS NOT NULL
       GROUP BY date_trunc('week', cr.call_date)
       ORDER BY date_trunc('week', cr.call_date) DESC
       LIMIT 8`,
      params,
    );
    // Oldest → newest for the chart x-axis.
    qaScoreTrend = r.rows
      .map((row: any) => ({
        week_start: row.week_start,
        avg_score: row.avg_score != null ? Math.round(parseFloat(row.avg_score) * 10) / 10 : 0,
        sample_size: row.sample_size,
      }))
      .reverse();
  } catch (e) {
    logger.warn("Weekly QA trend query failed:", e);
  }

  const complianceResult = await pool.query(
    `
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN notes_updated THEN 1 ELSE 0 END) as notes_updated,
      SUM(CASE WHEN call_logged THEN 1 ELSE 0 END) as call_logged,
      SUM(CASE WHEN task_created THEN 1 ELSE 0 END) as task_created,
      SUM(CASE WHEN stage_updated THEN 1 ELSE 0 END) as stage_updated,
      SUM(CASE WHEN overall_compliance THEN 1 ELSE 0 END) as fully_compliant
    FROM call_compliance cc
    JOIN call_records cr ON cc.call_record_id = cr.id
    ${whereClause}
  `,
    params,
  );

  const summary = summaryResult.rows[0];

  return {
    totalCalls: parseInt(summary.total_calls) || 0,
    analyzedCalls: parseInt(summary.analyzed_calls) || 0,
    avgSentimentScore: parseFloat(summary.avg_sentiment) || 0,
    avgQAScore: parseFloat(summary.avg_qa_score) || 0,
    avgComplianceScore: parseFloat(summary.avg_compliance) || 0,
    callsBySource: bySourceResult.rows,
    callsByAgent: byAgentResult.rows,
    complianceBreakdown: complianceResult.rows[0] || {},
    sentimentDistribution,
    qaScoreTrend,
  };
}

export async function createOrUpdateQAScore(
  data: Omit<CallQAScore, "id" | "created_at">,
): Promise<CallQAScore> {
  logger.info(
    "📝 [CallDB] Creating/updating QA score for call",
    data.call_record_id,
  );

  const existingResult = await pool.query(
    `SELECT id FROM call_qa_scores WHERE call_record_id = $1 AND scorecard_type = $2`,
    [data.call_record_id, data.scorecard_type],
  );

  if (existingResult.rows.length > 0) {
    const result = await pool.query(
      `
      UPDATE call_qa_scores SET
        total_score = $1,
        max_score = $2,
        score_percentage = $3,
        criteria_scores = $4,
        coaching_notes = $5,
        evaluator = $6,
        evaluated_at = NOW()
      WHERE call_record_id = $7 AND scorecard_type = $8
      RETURNING *
    `,
      [
        data.total_score,
        data.max_score,
        data.score_percentage,
        JSON.stringify(data.criteria_scores || {}),
        data.coaching_notes,
        data.evaluator,
        data.call_record_id,
        data.scorecard_type,
      ],
    );
    logger.info("✅ [CallDB] QA score updated", { id: result.rows[0].id });
    return result.rows[0];
  }

  const result = await pool.query(
    `
    INSERT INTO call_qa_scores (
      call_record_id, scorecard_type, total_score, max_score, score_percentage,
      criteria_scores, coaching_notes, evaluator, evaluated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
    RETURNING *
  `,
    [
      data.call_record_id,
      data.scorecard_type,
      data.total_score,
      data.max_score,
      data.score_percentage,
      JSON.stringify(data.criteria_scores || {}),
      data.coaching_notes,
      data.evaluator,
    ],
  );

  logger.info("✅ [CallDB] QA score created", { id: result.rows[0].id });
  return result.rows[0];
}

export async function updateCallStatus(
  callId: number,
  status: CallRecord["status"],
): Promise<void> {
  logger.info("🔄 [CallDB] Updating call status", { callId, status });
  await pool.query(
    `UPDATE call_records SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, callId],
  );
  logger.info("✅ [CallDB] Call status updated");
}

export interface SDREvaluationAttribute {
  id: string;
  name: string;
  description: string;
  dimension: "people" | "process" | "governance";
  weight: number;
  severity: "minor" | "major" | "critical";
  evaluation_logic: string;
  evidence_fields?: string[];
  scoring_type: "numeric" | "pass_fail";
  target?: number;
}

export interface SDRScorecardConfig {
  id: number;
  name: string;
  version: string;
  team_name?: string;
  attributes: SDREvaluationAttribute[];
}

export async function getActiveSDRScorecard(
  teamName?: string,
): Promise<SDRScorecardConfig | null> {
  logger.info("📊 [CallDB] Fetching active SDR scorecard", { teamName });

  let query = `
    SELECT id, name, version, team_name, dimensions 
    FROM quality_scorecards 
    WHERE is_active = true
  `;
  const params: any[] = [];

  if (teamName) {
    query += ` AND (team_name = $1 OR team_name IS NULL)`;
    params.push(teamName);
  }

  query += ` ORDER BY team_name IS NOT NULL DESC, updated_at DESC LIMIT 1`;

  const result = await pool.query(query, params);

  if (result.rows.length === 0) {
    logger.info("⚠️ [CallDB] No active scorecard found");
    return null;
  }

  const row = result.rows[0];
  const dimensions = row.dimensions?.dimensions || row.dimensions;

  const attributes: SDREvaluationAttribute[] = [];

  if (dimensions) {
    for (const [dimKey, dimValue] of Object.entries(dimensions)) {
      const dimension = dimValue as any;
      if (dimension?.attributes && Array.isArray(dimension.attributes)) {
        for (const attr of dimension.attributes) {
          attributes.push({
            id: attr.id || `${dimKey}_${attributes.length}`,
            name: attr.name,
            description: attr.description || "",
            dimension: dimKey as "people" | "process" | "governance",
            weight: attr.weight || 0.1,
            severity:
              attr.severityIfFailed === "critical"
                ? "critical"
                : attr.severityIfFailed === "high"
                  ? "major"
                  : "minor",
            evaluation_logic:
              attr.passingCriteria || attr.evaluationLogic || "",
            evidence_fields: attr.zohoFields || [],
            scoring_type:
              attr.scoringType === "pass_fail" ? "pass_fail" : "numeric",
            target: attr.target || 100,
            // Fix tonight — preserve section_id + metric + data_dependency
            // so buildSDREvaluationPrompt's router check
            // (attributes.some(a => a.section_id != null)) fires and
            // dispatches to buildCopcSDREvaluationPrompt. Without this the
            // parser strips fields the COPC seed put on each attribute and
            // the legacy Arabic prompt runs against COPC scorecards — which
            // is why tonight's efficiency report had section_scores: [].
            ...(attr.section_id ? { section_id: attr.section_id } : {}),
            ...(attr.metric ? { metric: attr.metric } : {}),
            ...(attr.data_dependency ? { data_dependency: attr.data_dependency } : {}),
          } as any);
        }
      }
    }
  }

  logger.info(
    "✅ [CallDB] Loaded scorecard with",
    attributes.length,
    "attributes",
  );

  return {
    id: row.id,
    name: row.name,
    version: row.version || "v1.0",
    team_name: row.team_name,
    attributes,
  };
}

export interface SDREvaluationResult {
  attribute_id: string;
  attribute_name: string;
  dimension: string;
  score?: number;
  status: "PASS" | "FAIL" | "NA";
  severity: string;
  evidence_quotes: string[];
  evidence_timestamps?: string[];
  comment: string;
  improvement_tip: string;
}

export interface SDRCallEvaluation {
  call_record_id: number;
  scorecard_id: number;
  scorecard_name: string;
  overall_score: number;
  dimension_scores: {
    people: number;
    process: number;
    governance: number;
  };
  attribute_evaluations: SDREvaluationResult[];
  top_strengths: string[];
  top_gaps: string[];
  coaching_actions: string[];
  critical_risks: string[];
  coaching_message_ar: string;
  coaching_message_en?: string;
  micro_training_topics: string[];
  key_moments: {
    greeting?: { timestamp?: string; detected: boolean };
    consent?: { timestamp?: string; detected: boolean };
    discovery?: { timestamp?: string; detected: boolean };
    objection_handling?: { timestamp?: string; detected: boolean };
    closing?: { timestamp?: string; detected: boolean };
    next_steps?: { timestamp?: string; detected: boolean };
  };
  evaluated_at: Date;
}

export async function saveSDREvaluation(
  evaluation: SDRCallEvaluation,
): Promise<number> {
  logger.info("💾 [CallDB] Saving SDR evaluation", {
    callRecordId: evaluation.call_record_id,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_call_evaluations (
      id SERIAL PRIMARY KEY,
      call_record_id INTEGER REFERENCES call_records(id) ON DELETE CASCADE,
      scorecard_id INTEGER,
      scorecard_name VARCHAR(255),
      overall_score DECIMAL(5,2),
      dimension_scores JSONB,
      attribute_evaluations JSONB,
      top_strengths JSONB,
      top_gaps JSONB,
      coaching_actions JSONB,
      critical_risks JSONB,
      coaching_message_ar TEXT,
      coaching_message_en TEXT,
      micro_training_topics JSONB,
      key_moments JSONB,
      evaluated_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sdr_eval_call ON sdr_call_evaluations(call_record_id);
  `);

  const existingResult = await pool.query(
    `SELECT id FROM sdr_call_evaluations WHERE call_record_id = $1`,
    [evaluation.call_record_id],
  );

  if (existingResult.rows.length > 0) {
    const result = await pool.query(
      `
      UPDATE sdr_call_evaluations SET
        scorecard_id = $1,
        scorecard_name = $2,
        overall_score = $3,
        dimension_scores = $4,
        attribute_evaluations = $5,
        top_strengths = $6,
        top_gaps = $7,
        coaching_actions = $8,
        critical_risks = $9,
        coaching_message_ar = $10,
        coaching_message_en = $11,
        micro_training_topics = $12,
        key_moments = $13,
        evaluated_at = NOW()
      WHERE call_record_id = $14
      RETURNING id
    `,
      [
        evaluation.scorecard_id,
        evaluation.scorecard_name,
        evaluation.overall_score,
        JSON.stringify(evaluation.dimension_scores),
        JSON.stringify(evaluation.attribute_evaluations),
        JSON.stringify(evaluation.top_strengths),
        JSON.stringify(evaluation.top_gaps),
        JSON.stringify(evaluation.coaching_actions),
        JSON.stringify(evaluation.critical_risks),
        evaluation.coaching_message_ar,
        evaluation.coaching_message_en || null,
        JSON.stringify(evaluation.micro_training_topics),
        JSON.stringify(evaluation.key_moments),
        evaluation.call_record_id,
      ],
    );
    logger.info("✅ [CallDB] SDR evaluation updated", {
      id: result.rows[0].id,
    });
    return result.rows[0].id;
  }

  const result = await pool.query(
    `
    INSERT INTO sdr_call_evaluations (
      call_record_id, scorecard_id, scorecard_name, overall_score, dimension_scores,
      attribute_evaluations, top_strengths, top_gaps, coaching_actions, critical_risks,
      coaching_message_ar, coaching_message_en, micro_training_topics, key_moments
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING id
  `,
    [
      evaluation.call_record_id,
      evaluation.scorecard_id,
      evaluation.scorecard_name,
      evaluation.overall_score,
      JSON.stringify(evaluation.dimension_scores),
      JSON.stringify(evaluation.attribute_evaluations),
      JSON.stringify(evaluation.top_strengths),
      JSON.stringify(evaluation.top_gaps),
      JSON.stringify(evaluation.coaching_actions),
      JSON.stringify(evaluation.critical_risks),
      evaluation.coaching_message_ar,
      evaluation.coaching_message_en || null,
      JSON.stringify(evaluation.micro_training_topics),
      JSON.stringify(evaluation.key_moments),
    ],
  );

  logger.info("✅ [CallDB] SDR evaluation saved", { id: result.rows[0].id });
  return result.rows[0].id;
}

export async function getSDREvaluation(
  callRecordId: number,
): Promise<SDRCallEvaluation | null> {
  logger.info("📊 [CallDB] Fetching SDR evaluation", { callRecordId });

  const result = await pool.query(
    `SELECT * FROM sdr_call_evaluations WHERE call_record_id = $1`,
    [callRecordId],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    call_record_id: row.call_record_id,
    scorecard_id: row.scorecard_id,
    scorecard_name: row.scorecard_name,
    overall_score: parseFloat(row.overall_score),
    dimension_scores: row.dimension_scores,
    attribute_evaluations: row.attribute_evaluations,
    top_strengths: row.top_strengths,
    top_gaps: row.top_gaps,
    coaching_actions: row.coaching_actions,
    critical_risks: row.critical_risks,
    coaching_message_ar: row.coaching_message_ar,
    coaching_message_en: row.coaching_message_en,
    micro_training_topics: row.micro_training_topics,
    key_moments: row.key_moments,
    evaluated_at: row.evaluated_at,
    // DMAIC Step 5 — surface the backfilled-from-v1.5 audit trail so the
    // UI can show "Previously: X (v1.5)" alongside the new COPC score.
    // Nullable: only populated for evaluations that have been backfilled.
    legacy_score_v1:
      row.legacy_score_v1 != null ? parseFloat(row.legacy_score_v1) : null,
    legacy_dimension_scores_v1: row.legacy_dimension_scores_v1 ?? null,
    legacy_scorecard_name_v1: row.legacy_scorecard_name_v1 ?? null,
    backfilled_at: row.backfilled_at ?? null,
  } as any;
}

// =======================================================================
// Manager Review Workflow (Quick Win #6 → Medium Improvement #1)
//
// AI-generated SDR evaluations become real coaching tools only when a
// human manager approves or disagrees with the score. This table stores
// those review actions per evaluation so the canonical "true" score for
// each call becomes COALESCE(adjusted_overall_score, ai_overall_score)
// once a review exists. Multiple reviews per evaluation are allowed
// (most recent wins) — supports re-review after coaching cycles.
// =======================================================================

export type SDREvaluationReviewStatus =
  | "approved"
  | "adjusted"
  | "disagreed";

export interface SDREvaluationReview {
  id?: number;
  evaluation_id: number;
  call_record_id: number;
  reviewer_email: string;
  reviewer_name?: string | null;
  review_status: SDREvaluationReviewStatus;
  adjusted_overall_score?: number | null;
  adjusted_dimension_scores?: any;
  adjusted_attribute_evaluations?: any;
  review_notes?: string | null;
  reviewed_at?: Date;
  created_at?: Date;
}

async function ensureSDRReviewsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sdr_evaluation_reviews (
      id SERIAL PRIMARY KEY,
      evaluation_id INTEGER NOT NULL REFERENCES sdr_call_evaluations(id) ON DELETE CASCADE,
      call_record_id INTEGER NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
      reviewer_email VARCHAR(255) NOT NULL,
      reviewer_name VARCHAR(255),
      review_status VARCHAR(20) NOT NULL CHECK (review_status IN ('approved','adjusted','disagreed')),
      adjusted_overall_score DECIMAL(5,2),
      adjusted_dimension_scores JSONB,
      adjusted_attribute_evaluations JSONB,
      review_notes TEXT,
      reviewed_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sdr_eval_reviews_eval ON sdr_evaluation_reviews(evaluation_id);
    CREATE INDEX IF NOT EXISTS idx_sdr_eval_reviews_call ON sdr_evaluation_reviews(call_record_id);
    CREATE INDEX IF NOT EXISTS idx_sdr_eval_reviews_reviewer ON sdr_evaluation_reviews(reviewer_email);
  `);
}

export async function saveSDREvaluationReview(
  review: SDREvaluationReview,
): Promise<number> {
  await ensureSDRReviewsTable();
  logger.info("📝 [CallDB] Saving SDR evaluation review", {
    evaluationId: review.evaluation_id,
    callRecordId: review.call_record_id,
    reviewStatus: review.review_status,
    reviewer: review.reviewer_email,
  });

  const result = await pool.query(
    `
    INSERT INTO sdr_evaluation_reviews (
      evaluation_id,
      call_record_id,
      reviewer_email,
      reviewer_name,
      review_status,
      adjusted_overall_score,
      adjusted_dimension_scores,
      adjusted_attribute_evaluations,
      review_notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `,
    [
      review.evaluation_id,
      review.call_record_id,
      review.reviewer_email,
      review.reviewer_name || null,
      review.review_status,
      review.adjusted_overall_score ?? null,
      review.adjusted_dimension_scores
        ? JSON.stringify(review.adjusted_dimension_scores)
        : null,
      review.adjusted_attribute_evaluations
        ? JSON.stringify(review.adjusted_attribute_evaluations)
        : null,
      review.review_notes || null,
    ],
  );

  logger.info("✅ [CallDB] SDR review saved", { id: result.rows[0].id });
  return result.rows[0].id;
}

export async function getSDRReviewsForCall(
  callRecordId: number,
): Promise<SDREvaluationReview[]> {
  await ensureSDRReviewsTable();
  const result = await pool.query(
    `
    SELECT *
    FROM sdr_evaluation_reviews
    WHERE call_record_id = $1
    ORDER BY reviewed_at DESC, id DESC
  `,
    [callRecordId],
  );
  return result.rows.map((row: any) => ({
    id: row.id,
    evaluation_id: row.evaluation_id,
    call_record_id: row.call_record_id,
    reviewer_email: row.reviewer_email,
    reviewer_name: row.reviewer_name,
    review_status: row.review_status as SDREvaluationReviewStatus,
    adjusted_overall_score:
      row.adjusted_overall_score !== null
        ? parseFloat(row.adjusted_overall_score)
        : null,
    adjusted_dimension_scores: row.adjusted_dimension_scores,
    adjusted_attribute_evaluations: row.adjusted_attribute_evaluations,
    review_notes: row.review_notes,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
  }));
}

/**
 * COPC-aligned prompt — used when the active scorecard has the v2
 * structure (every attribute carries a `section_id`). Scores each
 * checkpoint on the 0/1/2 rubric (Not Met / Partially Met / Fully Met)
 * with `null` for checkpoints whose data dependency is outside the
 * transcript (Five9 timestamps, conversion ratios, etc.) — those are
 * explicitly excluded from the weighted overall so a transcript-only
 * evaluation doesn't get penalised for data the analyzer can't see.
 *
 * Result shape stays compatible with the legacy parser
 * (attribute_evaluations[].status PASS/FAIL/NA) so the same downstream
 * saveSDREvaluation path keeps working: score=2 → PASS, score 0|1 →
 * FAIL, score=null → NA.
 */
export function buildCopcSDREvaluationPrompt(
  transcript: string,
  scorecard: SDRScorecardConfig,
): string {
  // Group attributes by their section_id so the prompt mirrors the
  // scorecard's section structure exactly.
  const bySection: Record<string, SDREvaluationAttribute[]> = {};
  const sectionOrder: string[] = [];
  for (const a of scorecard.attributes) {
    const sid = (a as any).section_id || "ungrouped";
    if (!bySection[sid]) {
      bySection[sid] = [];
      sectionOrder.push(sid);
    }
    bySection[sid].push(a);
  }
  const sectionsBlock = sectionOrder
    .map((sid) => {
      const attrs = bySection[sid];
      const items = attrs
        .map((a, i) => {
          const target = (a as any).target || "-";
          const metric = (a as any).metric || a.evaluation_logic || "";
          const dep = (a as any).data_dependency || "";
          const deferTag = dep.includes("five9_real_ingest")
            ? " [DATA: deferred — score null]"
            : dep.includes("NEW")
              ? " [DATA: not yet available — score null if no evidence]"
              : "";
          return `  ${i + 1}. ${a.name} (${a.id})${deferTag}
     Metric: ${metric}
     Target: ${target}`;
        })
        .join("\n\n");
      return `### Section: ${sid}\n${items}`;
    })
    .join("\n\n");

  return `You are a Quality Assurance evaluator for SDR (Sales Development Representative) calls, applying the COPC-aligned WalaPlus SDR QA Scorecard v2.

Scoring rubric (per checkpoint):
  0 = Not Met       (clear evidence the SDR missed or violated the standard)
  1 = Partially Met (some evidence but inconsistent / incomplete)
  2 = Fully Met     (clear, consistent evidence the SDR met the standard)
  null = Cannot Score (no evidence in the transcript — do NOT penalise)

Rules:
  • Use \`null\` for checkpoints tagged [DATA: deferred] or [DATA: not yet available] — you cannot score Five9 login gaps, idle ratios, conversion funnels, etc. from a transcript alone.
  • Provide a one-sentence evidence quote from the transcript when scoring 0 or 1, so the operator sees WHY.
  • Treat Arabic / Saudi-dialect transcripts as first-class input. Polite phrasing and indirect requests count as evidence — do not over-penalise.
  • Be consistent: the same behavior gets the same score across calls.

## Transcript
${transcript}

## Scorecard
${sectionsBlock}

## Return JSON (exact shape — required for parsing)

{
  "attribute_evaluations": [
    {
      "attribute_id": "checkpoint_id_from_above",
      "attribute_name": "Checkpoint Name",
      "section_id": "section_id_from_above",
      "score": 0 | 1 | 2 | null,
      "status": "PASS" | "FAIL" | "NA",
      "severity": "minor" | "major" | "critical",
      "evidence_quotes": ["one sentence from transcript, in original language"],
      "comment": "one professional sentence summarising the evidence",
      "improvement_tip": "one actionable sentence the SDR can apply on the next call"
    }
  ],
  "overall_summary": {
    "overall_score": <integer 0..100>,
    "section_scores": {
      "<section_id>": { "avg_score_0_2": <number>, "scored_count": <int>, "deferred_count": <int>, "score_0_100": <number 0..100> }
    },
    "dimension_scores": {
      "people": <0..100>, "process": <0..100>, "governance": <0..100>
    },
    "top_strengths": ["string", "string", "string"],
    "top_gaps": ["string", "string", "string"],
    "coaching_actions": ["string", "string", "string"],
    "critical_risks": []
  },
  "coaching_recommendation": {
    "message_ar": "Arabic coaching message for the agent (professional, constructive)",
    "message_en": "Optional English version",
    "micro_training_topics": ["topic", "topic", "topic"]
  },
  "key_moments": {
    "greeting":            { "detected": true|false, "description": "" },
    "consent":             { "detected": true|false, "description": "" },
    "discovery":           { "detected": true|false, "description": "" },
    "objection_handling":  { "detected": true|false, "description": "" },
    "closing":             { "detected": true|false, "description": "" },
    "next_steps":          { "detected": true|false, "description": "" }
  },
  "compliance_notes": "any explicit compliance or PDPL observations",
  "ai_confidence": <0..100>
}

Status mapping rule: score=2 → "PASS"; score 0 or 1 → "FAIL"; score=null → "NA". Do not deviate.

Overall score formula: for each section, compute mean(scored checkpoints, 0..2) ÷ 2 × 100 = section's score_0_100. Then overall_score = weighted average across sections using the section weights from the scorecard. Sections whose checkpoints are ALL null get weight=0 (re-normalize across remaining sections) — never assume the agent's score on a section we can't observe.`;
}

export function buildSDREvaluationPrompt(
  transcript: string,
  scorecard: SDRScorecardConfig,
): string {
  // Route based on scorecard shape: v2 (COPC) scorecards tag every
  // attribute with a section_id (added by scripts/seedScorecardV2Copc.ts).
  // Legacy v1.5 scorecards have no section_id → fall through to the
  // existing Arabic pass/fail prompt.
  const hasSectionIds = scorecard.attributes.some(
    (a) => (a as any).section_id != null,
  );
  if (hasSectionIds) {
    return buildCopcSDREvaluationPrompt(transcript, scorecard);
  }
  const attributesList = scorecard.attributes
    .map(
      (attr, idx) =>
        `${idx + 1}. ${attr.name} (${attr.id})
   - الوصف: ${attr.description}
   - البُعد: ${attr.dimension === "people" ? "الأشخاص" : attr.dimension === "process" ? "العمليات" : "الحوكمة"}
   - الوزن: ${(attr.weight * 100).toFixed(0)}%
   - الخطورة: ${attr.severity === "critical" ? "حرجة" : attr.severity === "major" ? "عالية" : "متوسطة"}
   - معايير التقييم: ${attr.evaluation_logic}
   - نوع التقييم: ${attr.scoring_type === "pass_fail" ? "نجاح/إخفاق" : "رقمي (1-10)"}`,
    )
    .join("\n\n");

  return `أنت خبير جودة مكالمات SDR (Sales Development Representative) محترف.
مهمتك تقييم هذه المكالمة بشكل شامل وفقاً لنموذج التقييم المحدد.

## تعليمات التقييم:
1. اتبع معايير التقييم المحددة بدقة - لا تخترع قواعد جديدة
2. استخدم الأدلة من نص المكالمة فقط
3. إذا لم يكن هناك دليل أو لم تصل المكالمة لهذه المرحلة، ضع الحالة NA
4. لا تعاقب الموظف على أشياء لم يسمح العميل بحدوثها
5. كن متسقاً: السلوك المماثل يحصل على تقييم مماثل
6. افهم اللهجة السعودية والتعبيرات غير المباشرة والعبارات المهذبة

## نص المكالمة:
${transcript}

## نموذج التقييم (${scorecard.name} - ${scorecard.version}):
${attributesList}

## المطلوب - قدم الإجابة بصيغة JSON التالية:
{
  "transcript_analysis": {
    "speaker_segments": [
      {"speaker": "Agent|Customer", "text": "النص", "approximate_position": "بداية|وسط|نهاية"}
    ],
    "key_moments": {
      "greeting": {"detected": true/false, "description": "وصف مختصر"},
      "consent": {"detected": true/false, "description": ""},
      "discovery": {"detected": true/false, "description": ""},
      "objection_handling": {"detected": true/false, "description": ""},
      "closing": {"detected": true/false, "description": ""},
      "next_steps": {"detected": true/false, "description": ""}
    },
    "call_duration_assessment": "قصيرة|متوسطة|طويلة",
    "call_outcome": "وصف نتيجة المكالمة"
  },
  "attribute_evaluations": [
    {
      "attribute_id": "معرف السمة",
      "attribute_name": "اسم السمة",
      "dimension": "people|process|governance",
      "score": <1-10 للتقييم الرقمي أو null>,
      "status": "PASS|FAIL|NA",
      "severity": "minor|major|critical",
      "evidence_quotes": ["اقتباس 1 من النص", "اقتباس 2"],
      "comment": "تعليق مهني وموضوعي",
      "improvement_tip": "نصيحة واحدة محددة للتحسين"
    }
  ],
  "overall_summary": {
    "overall_score": <0-100>,
    "dimension_scores": {
      "people": <0-100>,
      "process": <0-100>,
      "governance": <0-100>
    },
    "top_strengths": ["قوة 1", "قوة 2", "قوة 3"],
    "top_gaps": ["فجوة 1", "فجوة 2", "فجوة 3"],
    "coaching_actions": ["إجراء تدريبي 1", "إجراء 2", "إجراء 3", "إجراء 4", "إجراء 5"],
    "critical_risks": ["مخاطر حرجة إن وجدت"]
  },
  "coaching_recommendation": {
    "message_ar": "رسالة تدريبية للموظف باللغة العربية - مهنية وبناءة",
    "message_en": "Optional English coaching message",
    "micro_training_topics": ["موضوع تدريبي 1", "موضوع 2", "موضوع 3"]
  },
  "compliance_notes": "ملاحظات حول الامتثال والسياسات",
  "ai_confidence": <0-100 مستوى ثقة التحليل>
}`;
}

export async function submitAIFeedback(params: {
  callRecordId: number;
  evaluationId: number;
  feedbackType: "accurate" | "partially_accurate" | "inaccurate";
  details: string;
  submittedBy: string;
}): Promise<number> {
  const result = await pool.query(
    `INSERT INTO ai_training_feedback (call_record_id, evaluation_id, feedback_type, details, submitted_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      params.callRecordId,
      params.evaluationId,
      params.feedbackType,
      params.details,
      params.submittedBy,
    ],
  );
  return result.rows[0].id;
}

export async function getAITrainingStats(): Promise<{
  reviewed: number;
  accuracy: number;
  corrections: number;
  approved: number;
  adjusted: number;
  disagreed: number;
  top_corrected_attributes: Array<{
    attribute_id: string;
    attribute_name: string;
    adjustment_count: number;
  }>;
  legacy_feedback?: {
    accurate: number;
    partial: number;
    inaccurate: number;
  };
}> {
  // Medium #3 — the authoritative correction signal is sdr_evaluation_reviews
  // (Approve / Adjust / Disagree from #6 + #6 v1.1). "Accuracy" = the rate at
  // which managers Approve the AI score outright; "Corrections" = Adjusted +
  // Disagreed. The old `ai_training_feedback` thumbs-rating signal is kept
  // alongside as legacy_feedback so the panel can show both lenses without
  // breaking the existing submit path. The schema for these tables was
  // already in place from prior sessions; this is purely a rollup query.
  await ensureSDRReviewsTable();
  const reviewsResult = await pool.query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN review_status = 'approved'  THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN review_status = 'adjusted'  THEN 1 ELSE 0 END) AS adjusted,
      SUM(CASE WHEN review_status = 'disagreed' THEN 1 ELSE 0 END) AS disagreed
    FROM sdr_evaluation_reviews
  `);
  const r = reviewsResult.rows[0] || {};
  const reviewed = parseInt(r.total) || 0;
  const approved = parseInt(r.approved) || 0;
  const adjusted = parseInt(r.adjusted) || 0;
  const disagreed = parseInt(r.disagreed) || 0;
  const corrections = adjusted + disagreed;
  const accuracy = reviewed > 0 ? Math.round((approved / reviewed) * 100) : 0;

  // Top corrected attributes — which attribute_ids do managers most often
  // override on Adjusted reviews? Surfaces real prompt-tuning targets.
  // Each adjusted_attribute_evaluations JSONB is the manager's final values;
  // we count an attribute as "corrected" when its status or score differs
  // from the AI's. Limited to top 5 to keep the panel compact.
  let topCorrected: Array<{
    attribute_id: string;
    attribute_name: string;
    adjustment_count: number;
  }> = [];
  if (adjusted > 0) {
    try {
      const correctedResult = await pool.query(`
        WITH adjusted_pairs AS (
          SELECT
            sr.id AS review_id,
            adj_elem ->> 'attribute_id' AS attribute_id,
            adj_elem ->> 'attribute_name' AS attribute_name,
            adj_elem ->> 'status' AS adj_status,
            (adj_elem ->> 'score')::numeric AS adj_score,
            se.attribute_evaluations AS ai_attrs
          FROM sdr_evaluation_reviews sr
          JOIN sdr_call_evaluations se ON se.id = sr.evaluation_id
          CROSS JOIN LATERAL jsonb_array_elements(sr.adjusted_attribute_evaluations) AS adj_elem
          WHERE sr.review_status = 'adjusted'
            AND sr.adjusted_attribute_evaluations IS NOT NULL
        ),
        diffs AS (
          SELECT
            ap.attribute_id,
            ap.attribute_name,
            ap.review_id,
            -- Find the matching AI attribute by attribute_id within the
            -- evaluation's attribute_evaluations JSONB array.
            (
              SELECT ai_elem
              FROM jsonb_array_elements(ap.ai_attrs) AS ai_elem
              WHERE ai_elem ->> 'attribute_id' = ap.attribute_id
              LIMIT 1
            ) AS ai_elem,
            ap.adj_status,
            ap.adj_score
          FROM adjusted_pairs ap
        )
        SELECT attribute_id, attribute_name, COUNT(DISTINCT review_id) AS adjustment_count
        FROM diffs
        WHERE
          attribute_id IS NOT NULL
          AND ai_elem IS NOT NULL
          AND (
            (ai_elem ->> 'status') IS DISTINCT FROM adj_status
            OR (ai_elem ->> 'score')::numeric IS DISTINCT FROM adj_score
          )
        GROUP BY attribute_id, attribute_name
        ORDER BY adjustment_count DESC, attribute_id
        LIMIT 5
      `);
      topCorrected = correctedResult.rows.map((row: any) => ({
        attribute_id: row.attribute_id,
        attribute_name: row.attribute_name,
        adjustment_count: parseInt(row.adjustment_count) || 0,
      }));
    } catch (err: any) {
      logger.warn("[AITrainingStats] top-corrected query failed:", err?.message);
      topCorrected = [];
    }
  }

  // Legacy thumbs-rating signal kept alongside for backwards compat.
  let legacy: { accurate: number; partial: number; inaccurate: number } | undefined;
  try {
    const legacyResult = await pool.query(`
      SELECT
        SUM(CASE WHEN feedback_type = 'accurate' THEN 1 ELSE 0 END) AS accurate,
        SUM(CASE WHEN feedback_type = 'partially_accurate' THEN 1 ELSE 0 END) AS partial,
        SUM(CASE WHEN feedback_type = 'inaccurate' THEN 1 ELSE 0 END) AS inaccurate
      FROM ai_training_feedback
    `);
    const lr = legacyResult.rows[0] || {};
    legacy = {
      accurate: parseInt(lr.accurate) || 0,
      partial: parseInt(lr.partial) || 0,
      inaccurate: parseInt(lr.inaccurate) || 0,
    };
  } catch {
    legacy = undefined;
  }

  return {
    reviewed,
    accuracy,
    corrections,
    approved,
    adjusted,
    disagreed,
    top_corrected_attributes: topCorrected,
    legacy_feedback: legacy,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Call-record audio path + Five9 integration_config writes (Task #746)
//
// Moved out of `src/mastra/routes/callIntelligenceRoutes.ts` so all writes
// against `call_records` and the Five9 `integration_config` row live in this
// (grandfathered) module and the secret-leak coverage gate no longer has to
// track the route file separately.
// ──────────────────────────────────────────────────────────────────────────────
export async function updateCallRecordAudioPath(
  callRecordId: number,
  audioFilePath: string,
): Promise<void> {
  await pool.query(
    "UPDATE call_records SET audio_file_path = $1 WHERE id = $2",
    [audioFilePath, callRecordId],
  );
}

// Audio persistence across redeploys.
// Replit (and most container hosts) wipe the local filesystem on each
// redeploy — `uploads/calls/*.wav` files are gone, leaving call_records
// rows pointing at paths that no longer exist. Storing the audio bytes
// in Postgres (BYTEA) makes the recording survive container restarts so
// managers can still play / re-transcribe / re-evaluate after a deploy.
// Idempotent ALTER so existing deploys don't need a migration step.
let _audioBlobColumnReady: Promise<void> | null = null;
async function ensureAudioBlobColumns(): Promise<void> {
  if (_audioBlobColumnReady) return _audioBlobColumnReady;
  _audioBlobColumnReady = pool
    .query(`
      ALTER TABLE call_records ADD COLUMN IF NOT EXISTS audio_blob BYTEA;
      ALTER TABLE call_records ADD COLUMN IF NOT EXISTS audio_blob_mime VARCHAR(64);
      ALTER TABLE call_records ADD COLUMN IF NOT EXISTS audio_blob_size INTEGER;
    `)
    .then(() => undefined)
    .catch((err) => {
      logger.warn("[CallDB] audio_blob column add failed (will retry):", err);
      _audioBlobColumnReady = null;
    });
  return _audioBlobColumnReady;
}

export async function setCallRecordAudioBlob(
  callRecordId: number,
  buffer: Buffer,
  mime: string,
): Promise<void> {
  await ensureAudioBlobColumns();
  await pool.query(
    `UPDATE call_records
     SET audio_blob = $1, audio_blob_mime = $2, audio_blob_size = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [buffer, mime, buffer.length, callRecordId],
  );
}

export async function getCallRecordAudioBlob(
  callRecordId: number,
): Promise<{ buffer: Buffer; mime: string; size: number } | null> {
  await ensureAudioBlobColumns();
  const result = await pool.query(
    `SELECT audio_blob, audio_blob_mime, audio_blob_size
       FROM call_records WHERE id = $1`,
    [callRecordId],
  );
  const row = result.rows[0];
  if (!row || !row.audio_blob) return null;
  // pg returns BYTEA as a Buffer already; defensive coerce just in case.
  const buf = Buffer.isBuffer(row.audio_blob)
    ? row.audio_blob
    : Buffer.from(row.audio_blob);
  return {
    buffer: buf,
    mime: row.audio_blob_mime || "audio/wav",
    size: row.audio_blob_size || buf.length,
  };
}

export async function hasCallRecordAudioBlob(
  callRecordId: number,
): Promise<boolean> {
  await ensureAudioBlobColumns();
  const result = await pool.query(
    `SELECT 1 FROM call_records
      WHERE id = $1 AND audio_blob IS NOT NULL LIMIT 1`,
    [callRecordId],
  );
  return result.rows.length > 0;
}

let integrationConfigTableReady: Promise<void> | null = null;
async function ensureIntegrationConfigTable(): Promise<void> {
  if (integrationConfigTableReady) return integrationConfigTableReady;
  integrationConfigTableReady = pool
    .query(`
      CREATE TABLE IF NOT EXISTS integration_config (
        id SERIAL PRIMARY KEY,
        integration_type VARCHAR(50) UNIQUE NOT NULL,
        config JSONB NOT NULL,
        is_active BOOLEAN DEFAULT true,
        last_sync_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `)
    .then(() => undefined);
  return integrationConfigTableReady;
}

export async function upsertFive9IntegrationConfig(
  config: Record<string, unknown>,
): Promise<void> {
  await ensureIntegrationConfigTable();
  await pool.query(
    `INSERT INTO integration_config (integration_type, config, is_active)
     VALUES ('five9', $1, true)
     ON CONFLICT (integration_type)
     DO UPDATE SET config = $1, updated_at = NOW()`,
    [JSON.stringify(config)],
  );
}

export async function getActiveFive9IntegrationConfig(): Promise<Record<
  string,
  unknown
> | null> {
  await ensureIntegrationConfigTable();
  const result = await pool.query(
    "SELECT config FROM integration_config WHERE integration_type = 'five9' AND is_active = true",
  );
  return result.rows[0]?.config ?? null;
}

export async function markFive9IntegrationSynced(): Promise<void> {
  await pool.query(
    "UPDATE integration_config SET last_sync_at = NOW() WHERE integration_type = 'five9'",
  );
}

export { pool as callIntelligencePool };
