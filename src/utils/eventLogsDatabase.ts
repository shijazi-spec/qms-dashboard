import { Pool } from "pg";
import * as crypto from "crypto";

import { logger } from "./logger";
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * Sensitive-field redaction primitives moved to `./sensitiveRedaction` in
 * Task #356 to break a circular dependency with the structured logger
 * (`./logger.ts` needs the redaction helpers, but every database module —
 * including this one — needs the logger).  All public symbols are
 * re-exported below so existing import sites keep working unchanged.
 */
export {
  REDACTED_SENTINEL,
  redactCredentialLikeTokens,
  type CredentialWarningKind,
  type CredentialWarning,
  detectCredentialLikeFields,
  isPasswordLikeToken,
  isHighEntropyToken,
  redactSecretLikeStrings,
  deepRedactSecretLikeStrings,
  isSensitiveField,
  redactSensitiveFields,
  redactSensitiveDeep,
} from "./sensitiveRedaction";
import {
  redactSensitiveFields,
  redactSensitiveDeep,
  isSensitiveField,
  REDACTED_SENTINEL,
  redactSecretLikeStrings,
  deepRedactSecretLikeStrings,
} from "./sensitiveRedaction";

export interface EventLog {
  id: number;
  timestamp: Date;
  user_id?: number;
  user_name?: string;
  user_email?: string;
  user_role?: string;
  // action_type / entity_type are stored as VARCHAR(50) in Postgres (see the
  // CREATE TABLE below) with NO check constraint. The narrow string-literal
  // unions that previously lived here documented the *intended* enum at the
  // time the table was introduced, but the codebase has since added many
  // new actions (e.g. "scan", "sdr_batch_poll", "sdr_batch_submitted",
  // "sdr_auto_evaluation") and entities (e.g. "audit_programme",
  // "duplicate_radar_cs_overlap", "sdr_batch_job", "call_record") that all
  // land in the same column without any runtime issue. Keeping the union
  // narrow forced ~140 TS2322 errors across callers that had no recourse
  // short of `as any`. Widened to `string` to match the DB's actual
  // contract; new callers should still pick a stable identifier rather
  // than a free-form string. The set of *historical* canonical values is
  // preserved below as a non-exhaustive reference for documentation /
  // grep purposes only — extend it rather than removing entries.
  //
  // Canonical actions:   CREATE | UPDATE | DELETE | STATUS_CHANGE | ASSIGN
  //                     | AI_ACTION | LOGIN | LOGOUT | VIEW | EXPORT
  //                     | CALCULATE | SCAN | ...
  // Canonical entities:  PROJECT | TRAINING | ROI | USER | ROLE | CALL
  //                     | KPI | CAPA | DOCUMENT | SYSTEM | SESSION | ...
  action_type: string;
  entity_type: string;
  entity_id?: string;
  entity_name?: string;
  description?: string;
  old_value?: any;
  new_value?: any;
  ai_involved: boolean;
  severity: "INFO" | "WARNING" | "CRITICAL" | "ERROR";
  correlation_id?: string;
  ip_address?: string;
  user_agent?: string;
  module?: string;
  checksum?: string;
  created_at: Date;
}

export interface EventLogInput {
  userId?: number;
  userName?: string;
  userEmail?: string;
  userRole?: string;
  actionType: EventLog["action_type"];
  entityType: EventLog["entity_type"];
  entityId?: string;
  entityName?: string;
  description?: string;
  oldValue?: any;
  newValue?: any;
  aiInvolved?: boolean;
  severity?: EventLog["severity"];
  correlationId?: string;
  ipAddress?: string;
  userAgent?: string;
  module?: string;
}

export interface EventLogFilters {
  page?: number;
  pageSize?: number;
  userId?: number;
  userName?: string;
  actionType?: string;
  entityType?: string;
  module?: string;
  severity?: string;
  aiInvolved?: boolean;
  fromDate?: string;
  toDate?: string;
  search?: string;
  correlationId?: string;
}

function generateChecksum(data: Partial<EventLogInput>): string {
  const checksumData = JSON.stringify({
    userId: data.userId,
    actionType: data.actionType,
    entityType: data.entityType,
    entityId: data.entityId,
    description: data.description,
    oldValue: data.oldValue,
    newValue: data.newValue,
    timestamp: new Date().toISOString(),
  });
  return crypto.createHash("sha256").update(checksumData).digest("hex");
}

/**
 * Month bounds for a partition, in UTC.
 *
 * These MUST be built with Date.UTC. The original code used
 * `new Date(year, month - 1, 1)` — LOCAL midnight — and then read it back with
 * `.toISOString()`, which is UTC. On any server running east of UTC (Asia/Riyadh
 * is UTC+3) that shifts every boundary a day earlier: August became
 * FROM '2026-07-31', which OVERLAPS a July partition already created as
 * [2026-07-01, 2026-08-01). Postgres rejects an overlapping partition, the
 * error was swallowed below, and the month simply had nowhere to write.
 *
 * That is consistent with what the register shows: event_logs stops dead at
 * 2026-07-31 and has taken nothing since, across every module.
 */
export function monthPartitionBounds(
  year: number,
  month: number,
): { name: string; start: string; end: string } {
  return {
    name: `event_logs_y${year}m${String(month).padStart(2, "0")}`,
    start: new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10),
    end: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
  };
}

async function createMonthlyPartition(
  year: number,
  month: number,
): Promise<void> {
  const { name: partitionName, start: startStr, end: endStr } =
    monthPartitionBounds(year, month);

  try {
    const checkResult = await pool.query(
      `
      SELECT EXISTS (
        SELECT FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = $1
      )
    `,
      [partitionName],
    );

    // Defensive: bail out if the catalog query returned no rows (stubbed pool).
    if (checkResult.rows.length === 0) return;
    if (!checkResult.rows[0].exists) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF event_logs
        FOR VALUES FROM ('${startStr}') TO ('${endStr}')
      `);
      logger.info(`📋 [EventLogs] Created partition: ${partitionName}`);
    }
  } catch (error: any) {
    if (!error.message?.includes("already exists")) {
      // Loud on purpose. Swallowing this quietly is how eighteen days of audit
      // history went missing without anyone seeing an error.
      logger.error(
        `📋 [EventLogs] Error creating partition ${partitionName} [${startStr} → ${endStr}]:`,
        { code: error?.code, detail: error?.detail, message: error?.message },
      );
    }
  }
}

/**
 * True when Postgres could not route a row to any partition.
 *
 * The insert names no timestamp, so the row takes `DEFAULT NOW()` — if the
 * current month has no partition, the INSERT fails outright and the event is
 * lost. Matching on the message as well as the SQLSTATE because 23514 is the
 * generic check-violation code, shared with ordinary CHECK constraints.
 */
function isMissingPartitionError(error: any): boolean {
  const msg = String(error?.message || "");
  if (/no partition of relation/i.test(msg)) return true;
  return error?.code === "23514" && /partition/i.test(msg);
}

async function isTablePartitioned(): Promise<boolean> {
  try {
    const result = await pool.query(`
      SELECT pt.relkind = 'p' as is_partitioned
      FROM pg_class pt
      JOIN pg_namespace pn ON pt.relnamespace = pn.oid
      WHERE pt.relname = 'event_logs' 
      AND pn.nspname = 'public'
    `);
    return result.rows.length > 0 && result.rows[0].is_partitioned === true;
  } catch {
    return false;
  }
}

async function migrateToPartitionedTable(): Promise<void> {
  logger.info(
    "📋 [EventLogs] Migrating non-partitioned table to partitioned structure...",
  );

  const backupExists = await pool.query(`
    SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_logs_backup')
  `);

  // Defensive: if the pool returned no rows (e.g. a test stub that hasn't
  // been wired for this catalog query), abort the migration rather than
  // crashing on `rows[0].exists`. The init was best-effort anyway.
  if (backupExists.rows.length === 0) {
    logger.warn(
      "📋 [EventLogs] Skipping migration: pg_tables check returned no rows (likely a stubbed pool).",
    );
    return;
  }

  if (backupExists.rows[0].exists) {
    await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
  }

  await pool.query(`ALTER TABLE event_logs RENAME TO event_logs_backup`);
  logger.info("📋 [EventLogs] Backed up existing table to event_logs_backup");

  await pool.query(`DROP SEQUENCE IF EXISTS event_logs_id_seq CASCADE`);

  await pool.query(`
    CREATE TABLE event_logs (
      id SERIAL,
      timestamp TIMESTAMPTZ DEFAULT NOW(),
      user_id INTEGER,
      user_name VARCHAR(255),
      user_email VARCHAR(255),
      user_role VARCHAR(50),
      action_type VARCHAR(50) NOT NULL,
      entity_type VARCHAR(50) NOT NULL,
      entity_id VARCHAR(100),
      entity_name VARCHAR(255),
      description TEXT,
      old_value JSONB,
      new_value JSONB,
      ai_involved BOOLEAN DEFAULT FALSE,
      severity VARCHAR(20) DEFAULT 'INFO',
      correlation_id VARCHAR(100),
      ip_address VARCHAR(45),
      user_agent TEXT,
      module VARCHAR(50),
      checksum VARCHAR(64),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (id, timestamp)
    ) PARTITION BY RANGE (timestamp)
  `);
  logger.info("📋 [EventLogs] Created new partitioned parent table");
}

async function copyBackupDataToPartitions(): Promise<void> {
  logger.info("📋 [EventLogs] Checking for backup data to migrate...");

  const backupExists = await pool.query(`
    SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_logs_backup')
  `);

  // Defensive: bail out if catalog query returned no rows (stubbed pool).
  if (backupExists.rows.length === 0 || !backupExists.rows[0].exists) {
    return;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) as count FROM event_logs_backup`,
  );
  const backupCount = parseInt(countResult.rows[0].count, 10);

  if (backupCount === 0) {
    logger.info("📋 [EventLogs] No backup data to migrate");
    await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
    return;
  }

  logger.info(`📋 [EventLogs] Migrating ${backupCount} records from backup...`);

  const distinctMonths = await pool.query(`
    SELECT DISTINCT 
      EXTRACT(YEAR FROM COALESCE(timestamp, created_at, NOW()))::integer as year,
      EXTRACT(MONTH FROM COALESCE(timestamp, created_at, NOW()))::integer as month
    FROM event_logs_backup
    ORDER BY year, month
  `);

  for (const row of distinctMonths.rows) {
    await createMonthlyPartition(row.year, row.month);
  }

  await pool.query(`
    INSERT INTO event_logs (
      timestamp, user_id, user_name, user_email, user_role,
      action_type, entity_type, entity_id, entity_name,
      description, old_value, new_value, ai_involved,
      severity, correlation_id, ip_address, user_agent,
      module, checksum, created_at
    )
    SELECT 
      COALESCE(timestamp, created_at, NOW()),
      user_id, user_name, user_email, user_role,
      action_type, entity_type, entity_id, entity_name,
      description, old_value, new_value, COALESCE(ai_involved, false),
      COALESCE(severity, 'INFO'), correlation_id, ip_address, user_agent,
      module, checksum, COALESCE(created_at, NOW())
    FROM event_logs_backup
  `);

  const newCount = await pool.query(`SELECT COUNT(*) as count FROM event_logs`);
  logger.info(
    `📋 [EventLogs] Successfully migrated ${newCount.rows[0].count} records`,
  );

  await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
  logger.info("📋 [EventLogs] Dropped backup table after successful migration");
}

export async function initializeEventLogsTable(): Promise<void> {
  logger.info("📋 [EventLogs] Initializing event_logs partitioned table...");
  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = 'event_logs'
      )
    `);

    // Defensive: if the pool returned no rows (e.g. a test stub that hasn't
    // been wired for this catalog query), abort init rather than crashing on
    // `rows[0].exists`. The init was best-effort — tests stub all reads they
    // need and don't rely on the real catalog at all.
    if (tableCheck.rows.length === 0) {
      logger.warn(
        "📋 [EventLogs] Skipping init: pg_tables check returned no rows (likely a stubbed pool).",
      );
      return;
    }

    if (tableCheck.rows[0].exists) {
      const isPartitioned = await isTablePartitioned();
      if (!isPartitioned) {
        await migrateToPartitionedTable();
      }
    } else {
      await pool.query(`
        CREATE TABLE event_logs (
          id SERIAL,
          timestamp TIMESTAMPTZ DEFAULT NOW(),
          user_id INTEGER,
          user_name VARCHAR(255),
          user_email VARCHAR(255),
          user_role VARCHAR(50),
          action_type VARCHAR(50) NOT NULL,
          entity_type VARCHAR(50) NOT NULL,
          entity_id VARCHAR(100),
          entity_name VARCHAR(255),
          description TEXT,
          old_value JSONB,
          new_value JSONB,
          ai_involved BOOLEAN DEFAULT FALSE,
          severity VARCHAR(20) DEFAULT 'INFO',
          correlation_id VARCHAR(100),
          ip_address VARCHAR(45),
          user_agent TEXT,
          module VARCHAR(50),
          checksum VARCHAR(64),
          created_at TIMESTAMPTZ DEFAULT NOW(),
          PRIMARY KEY (id, timestamp)
        ) PARTITION BY RANGE (timestamp)
      `);
      logger.info("📋 [EventLogs] Created partitioned parent table");
    }

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    await createMonthlyPartition(currentYear, currentMonth);

    const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
    const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
    await createMonthlyPartition(nextYear, nextMonth);

    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
    await createMonthlyPartition(prevYear, prevMonth);

    await copyBackupDataToPartitions();

    // ---------------------------------------------------------------------
    // Index plan for event_logs
    // ---------------------------------------------------------------------
    // Each index below is annotated with the query it primarily serves.
    // Indexes are created on the partitioned parent — Postgres 11+
    // automatically propagates CREATE INDEX on a partitioned parent to every
    // existing and future child partition, so we don't enumerate partitions
    // here. Keep this list in sync with the consumer queries when adding a
    // new index.
    //
    //   idx_event_logs_timestamp          → admin event-log feed (ORDER BY
    //                                       timestamp DESC paging in
    //                                       eventLogsRoutes.ts).
    //   idx_event_logs_user_id            → "events I caused" filter on the
    //                                       admin event-log page.
    //   idx_event_logs_action_type        → action_type facet filter.
    //   idx_event_logs_entity_type        → entity_type facet filter.
    //   idx_event_logs_module             → module facet filter.
    //   idx_event_logs_severity           → severity facet filter.
    //   idx_event_logs_correlation_id     → "show me everything in this
    //                                       request" lookup (single
    //                                       correlation_id, all rows).
    //   idx_event_logs_created_at         → audit export ordering.
    //   idx_event_logs_view_audit         → Task #514 partial composite for
    //                                       the AI-approval review-status
    //                                       NOT EXISTS sub-query in
    //                                       aiApprovalDatabase.listPendingActions
    //                                       (`reviewFilter` = 'unreviewed_by_me'
    //                                       and 'no_reviewers'). The
    //                                       predicate (action_type='AI_ACTION'
    //                                       AND description ILIKE 'Viewed%')
    //                                       restricts the index to view-audit
    //                                       rows only — typically a tiny
    //                                       fraction of event_logs — keeping
    //                                       the index small and the planner's
    //                                       NOT EXISTS short-circuit on
    //                                       (correlation_id, user_id) cheap
    //                                       even when event_logs grows into
    //                                       the millions.
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp ON event_logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_event_logs_user_id ON event_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_event_logs_action_type ON event_logs(action_type);
      CREATE INDEX IF NOT EXISTS idx_event_logs_entity_type ON event_logs(entity_type);
      CREATE INDEX IF NOT EXISTS idx_event_logs_module ON event_logs(module);
      CREATE INDEX IF NOT EXISTS idx_event_logs_severity ON event_logs(severity);
      CREATE INDEX IF NOT EXISTS idx_event_logs_correlation_id ON event_logs(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_event_logs_created_at ON event_logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_logs_view_audit
        ON event_logs(correlation_id, user_id)
        WHERE action_type = 'AI_ACTION'
          AND description ILIKE 'Viewed%';
    `);

    logger.info(
      "📋 [EventLogs] Partitioned table and indexes created successfully",
    );
  } catch (error) {
    logger.error("📋 [EventLogs] Error initializing partitioned table:", error);
    throw error;
  }
}

export async function logEvent(input: EventLogInput): Promise<EventLog> {
  logger.info(
    "📋 [EventLogs] Logging event:",
    input.actionType,
    input.entityType,
    input.entityId || "N/A",
  );

  try {
    // Free-form TEXT columns (description, entity_name) are populated by
    // callers that often interpolate runtime data into a human-readable
    // summary.  redactSensitiveFields() is key-based and cannot see inside a
    // string — run the regex scrubber here so a leaked credential in a
    // summary string never reaches the database.  The same scrubber is
    // applied recursively to string leaves inside oldValue/newValue JSON
    // after the key-based redaction has masked the obvious cases.
    const safeEntityName =
      input.entityName != null
        ? (redactSecretLikeStrings(input.entityName) as string)
        : null;
    const safeDescription =
      input.description != null
        ? (redactSecretLikeStrings(input.description) as string)
        : null;
    const safeOldValue = input.oldValue
      ? deepRedactSecretLikeStrings(redactSensitiveFields(input.oldValue))
      : null;
    const safeNewValue = input.newValue
      ? deepRedactSecretLikeStrings(redactSensitiveFields(input.newValue))
      : null;

    const checksum = generateChecksum({
      ...input,
      entityName: safeEntityName ?? undefined,
      description: safeDescription ?? undefined,
      oldValue: safeOldValue,
      newValue: safeNewValue,
    });
    logger.info(
      "📋 [EventLogs] Generated checksum:",
      checksum.substring(0, 16) + "...",
    );

    const insertSql = `INSERT INTO event_logs (
        user_id, user_name, user_email, user_role,
        action_type, entity_type, entity_id, entity_name,
        description, old_value, new_value, ai_involved,
        severity, correlation_id, ip_address, user_agent,
        module, checksum
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`;
    const insertParams = [
        input.userId || null,
        input.userName || null,
        input.userEmail || null,
        input.userRole || null,
        input.actionType,
        input.entityType,
        input.entityId || null,
        safeEntityName,
        safeDescription,
        safeOldValue ? JSON.stringify(safeOldValue) : null,
        safeNewValue ? JSON.stringify(safeNewValue) : null,
        input.aiInvolved || false,
        input.severity || "INFO",
        input.correlationId || null,
        input.ipAddress || null,
        input.userAgent || null,
        input.module || null,
        checksum,
      ];

    let result;
    try {
      result = await pool.query(insertSql, insertParams);
    } catch (error: any) {
      if (!isMissingPartitionError(error)) throw error;
      // Self-heal: the row's month has no partition, so create this month's
      // (and next month's, so the rollover doesn't cost another lost event)
      // and retry ONCE. Without this, a single missing partition silently
      // swallows every audit event until someone redeploys — which is exactly
      // what happened from 2026-08-01 onward.
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = now.getUTCMonth() + 1;
      logger.error(
        "📋 [EventLogs] No partition for the current month — creating it and retrying",
        { year: y, month: m, error: error?.message },
      );
      await createMonthlyPartition(y, m);
      await createMonthlyPartition(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
      result = await pool.query(insertSql, insertParams);
    }

    const eventLog = result.rows[0] as EventLog;
    logger.info(
      "📋 [EventLogs] Event logged successfully with ID:",
      eventLog.id,
    );
    return eventLog;
  } catch (error) {
    logger.error("📋 [EventLogs] Error logging event:", error);
    throw error;
  }
}

export async function getEventLogs(filters: EventLogFilters): Promise<{
  logs: EventLog[];
  total: number;
  page: number;
  pageSize: number;
}> {
  logger.info(
    "📋 [EventLogs] Fetching event logs with filters:",
    JSON.stringify(filters),
  );

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 50;
  const offset = (page - 1) * pageSize;

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(filters.userId);
  }

  if (filters.userName) {
    conditions.push(`user_name ILIKE $${paramIndex++}`);
    params.push(`%${filters.userName}%`);
  }

  if (filters.actionType) {
    conditions.push(`action_type = $${paramIndex++}`);
    params.push(filters.actionType);
  }

  if (filters.entityType) {
    conditions.push(`entity_type = $${paramIndex++}`);
    params.push(filters.entityType);
  }

  if (filters.module) {
    conditions.push(`module = $${paramIndex++}`);
    params.push(filters.module);
  }

  if (filters.severity) {
    conditions.push(`severity = $${paramIndex++}`);
    params.push(filters.severity);
  }

  if (filters.aiInvolved !== undefined) {
    conditions.push(`ai_involved = $${paramIndex++}`);
    params.push(filters.aiInvolved);
  }

  if (filters.fromDate) {
    conditions.push(`timestamp >= $${paramIndex++}`);
    params.push(filters.fromDate);
  }

  if (filters.toDate) {
    conditions.push(`timestamp <= $${paramIndex++}`);
    params.push(filters.toDate);
  }

  if (filters.correlationId) {
    conditions.push(`correlation_id = $${paramIndex++}`);
    params.push(filters.correlationId);
  }

  if (filters.search) {
    conditions.push(`(
      description ILIKE $${paramIndex} OR 
      entity_name ILIKE $${paramIndex} OR 
      user_name ILIKE $${paramIndex}
    )`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM event_logs ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const logsResult = await pool.query(
      `SELECT * FROM event_logs ${whereClause} 
       ORDER BY timestamp DESC 
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, pageSize, offset],
    );

    logger.info(
      "📋 [EventLogs] Retrieved",
      logsResult.rows.length,
      "logs out of",
      total,
      "total",
    );

    return {
      logs: logsResult.rows as EventLog[],
      total,
      page,
      pageSize,
    };
  } catch (error) {
    logger.error("📋 [EventLogs] Error fetching event logs:", error);
    throw error;
  }
}

export async function getEventLogById(id: number): Promise<EventLog | null> {
  logger.info("📋 [EventLogs] Fetching event log by ID:", id);

  try {
    const result = await pool.query("SELECT * FROM event_logs WHERE id = $1", [
      id,
    ]);

    if (result.rows.length === 0) {
      logger.info("📋 [EventLogs] No event log found with ID:", id);
      return null;
    }

    logger.info(
      "📋 [EventLogs] Found event log:",
      result.rows[0].action_type,
      result.rows[0].entity_type,
    );
    return result.rows[0] as EventLog;
  } catch (error) {
    logger.error("📋 [EventLogs] Error fetching event log by ID:", error);
    throw error;
  }
}

export async function getEventLogStats(): Promise<{
  totalLogs: number;
  byModule: Record<string, number>;
  byActionType: Record<string, number>;
  bySeverity: Record<string, number>;
  last24Hours: number;
  criticalEvents: number;
  aiActions: number;
  activityByDay: { date: string; count: number }[];
}> {
  logger.info("📋 [EventLogs] Calculating event log statistics...");

  try {
    const totalResult = await pool.query(
      "SELECT COUNT(*) as total FROM event_logs",
    );
    const totalLogs = parseInt(totalResult.rows[0].total, 10);

    const moduleResult = await pool.query(`
      SELECT COALESCE(module, 'UNKNOWN') as module, COUNT(*) as count 
      FROM event_logs 
      GROUP BY module
    `);
    const byModule: Record<string, number> = {};
    for (const row of moduleResult.rows) {
      byModule[row.module] = parseInt(row.count, 10);
    }

    const actionResult = await pool.query(`
      SELECT action_type, COUNT(*) as count 
      FROM event_logs 
      GROUP BY action_type
    `);
    const byActionType: Record<string, number> = {};
    for (const row of actionResult.rows) {
      byActionType[row.action_type] = parseInt(row.count, 10);
    }

    const severityResult = await pool.query(`
      SELECT severity, COUNT(*) as count 
      FROM event_logs 
      GROUP BY severity
    `);
    const bySeverity: Record<string, number> = {};
    for (const row of severityResult.rows) {
      bySeverity[row.severity] = parseInt(row.count, 10);
    }

    const last24Result = await pool.query(`
      SELECT COUNT(*) as count 
      FROM event_logs 
      WHERE timestamp >= NOW() - INTERVAL '24 hours'
    `);
    const last24Hours = parseInt(last24Result.rows[0].count, 10);

    const criticalResult = await pool.query(`
      SELECT COUNT(*) as count 
      FROM event_logs 
      WHERE severity = 'CRITICAL'
    `);
    const criticalEvents = parseInt(criticalResult.rows[0].count, 10);

    const aiResult = await pool.query(`
      SELECT COUNT(*) as count 
      FROM event_logs 
      WHERE ai_involved = true
    `);
    const aiActions = parseInt(aiResult.rows[0].count, 10);

    const activityResult = await pool.query(`
      SELECT DATE(timestamp) as date, COUNT(*) as count 
      FROM event_logs 
      WHERE timestamp >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `);
    const activityByDay = activityResult.rows.map((row) => ({
      date: row.date.toISOString().split("T")[0],
      count: parseInt(row.count, 10),
    }));

    logger.info(
      "📋 [EventLogs] Stats calculated - Total:",
      totalLogs,
      "Last 24h:",
      last24Hours,
      "Critical:",
      criticalEvents,
      "AI:",
      aiActions,
    );

    return {
      totalLogs,
      byModule,
      byActionType,
      bySeverity,
      last24Hours,
      criticalEvents,
      aiActions,
      activityByDay,
    };
  } catch (error) {
    logger.error("📋 [EventLogs] Error calculating stats:", error);
    throw error;
  }
}

export async function exportEventLogs(
  filters: EventLogFilters,
): Promise<EventLog[]> {
  logger.info(
    "📋 [EventLogs] Exporting event logs with filters:",
    JSON.stringify(filters),
  );

  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${paramIndex++}`);
    params.push(filters.userId);
  }

  if (filters.userName) {
    conditions.push(`user_name ILIKE $${paramIndex++}`);
    params.push(`%${filters.userName}%`);
  }

  if (filters.actionType) {
    conditions.push(`action_type = $${paramIndex++}`);
    params.push(filters.actionType);
  }

  if (filters.entityType) {
    conditions.push(`entity_type = $${paramIndex++}`);
    params.push(filters.entityType);
  }

  if (filters.module) {
    conditions.push(`module = $${paramIndex++}`);
    params.push(filters.module);
  }

  if (filters.severity) {
    conditions.push(`severity = $${paramIndex++}`);
    params.push(filters.severity);
  }

  if (filters.aiInvolved !== undefined) {
    conditions.push(`ai_involved = $${paramIndex++}`);
    params.push(filters.aiInvolved);
  }

  if (filters.fromDate) {
    conditions.push(`timestamp >= $${paramIndex++}`);
    params.push(filters.fromDate);
  }

  if (filters.toDate) {
    conditions.push(`timestamp <= $${paramIndex++}`);
    params.push(filters.toDate);
  }

  if (filters.correlationId) {
    conditions.push(`correlation_id = $${paramIndex++}`);
    params.push(filters.correlationId);
  }

  if (filters.search) {
    conditions.push(`(
      description ILIKE $${paramIndex} OR 
      entity_name ILIKE $${paramIndex} OR 
      user_name ILIKE $${paramIndex}
    )`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const result = await pool.query(
      `SELECT * FROM event_logs ${whereClause} ORDER BY timestamp DESC`,
      params,
    );

    logger.info("📋 [EventLogs] Exported", result.rows.length, "event logs");
    return result.rows as EventLog[];
  } catch (error) {
    logger.error("📋 [EventLogs] Error exporting event logs:", error);
    throw error;
  }
}

/* -------------------------------------------------------------------------
 * getActionViewers / getActionViewersBatch
 * -------------------------------------------------------------------------
 * Returns distinct reviewers who opened a pending-AI-action detail page,
 * sourced from the view-audit events written by Task #70.
 *
 * Each row is a distinct (user_id, user_email, user_name, user_role) tuple
 * with the last-viewed timestamp and a total view count for that user.
 * The caller receives a safe summary — no payload values are included.
 * -------------------------------------------------------------------------*/

export interface ActionViewer {
  user_id: number | null;
  user_email: string | null;
  user_name: string | null;
  user_role: string | null;
  last_viewed_at: Date;
  view_count: number;
}

/**
 * Returns the distinct prior-viewer list for a single action code.
 * Never throws — returns [] on DB error so callers stay non-fatal.
 */
export async function getActionViewers(
  actionCode: string,
): Promise<ActionViewer[]> {
  try {
    const result = await pool.query<ActionViewer & { view_count: string }>(
      `SELECT user_id, user_email, user_name, user_role,
              MAX(timestamp) AS last_viewed_at,
              COUNT(*)::text AS view_count
       FROM event_logs
       WHERE correlation_id = $1
         AND action_type = 'AI_ACTION'
         AND description ILIKE 'Viewed%'
       GROUP BY user_id, user_email, user_name, user_role
       ORDER BY MAX(timestamp) DESC`,
      [actionCode],
    );
    return result.rows.map((r) => ({
      user_id: r.user_id,
      user_email: r.user_email,
      user_name: r.user_name,
      user_role: r.user_role,
      last_viewed_at: r.last_viewed_at,
      view_count: parseInt(String(r.view_count), 10),
    }));
  } catch (error) {
    logger.error("[EventLogs] getActionViewers error:", error);
    return [];
  }
}

/**
 * Batch variant — fetches prior-viewer summaries for multiple action codes
 * in a single DB round-trip.  Returns a map keyed by action_code.
 * Never throws — returns {} on DB error so callers stay non-fatal.
 */
export async function getActionViewersBatch(
  actionCodes: string[],
): Promise<Record<string, ActionViewer[]>> {
  if (actionCodes.length === 0) return {};
  try {
    const result = await pool.query<
      ActionViewer & { correlation_id: string; view_count: string }
    >(
      `SELECT correlation_id, user_id, user_email, user_name, user_role,
              MAX(timestamp) AS last_viewed_at,
              COUNT(*)::text AS view_count
       FROM event_logs
       WHERE correlation_id = ANY($1)
         AND action_type = 'AI_ACTION'
         AND description ILIKE 'Viewed%'
       GROUP BY correlation_id, user_id, user_email, user_name, user_role
       ORDER BY correlation_id, MAX(timestamp) DESC`,
      [actionCodes],
    );
    const map: Record<string, ActionViewer[]> = {};
    for (const row of result.rows) {
      const code = row.correlation_id;
      if (!map[code]) map[code] = [];
      map[code].push({
        user_id: row.user_id,
        user_email: row.user_email,
        user_name: row.user_name,
        user_role: row.user_role,
        last_viewed_at: row.last_viewed_at,
        view_count: parseInt(String(row.view_count), 10),
      });
    }
    return map;
  } catch (error) {
    logger.error("[EventLogs] getActionViewersBatch error:", error);
    return {};
  }
}

logger.info("📋 [EventLogs] Module loaded, initializing table...");
initializeEventLogsTable().catch((err) => {
  logger.error(
    "📋 [EventLogs] Failed to initialize table on module load:",
    err,
  );
});
