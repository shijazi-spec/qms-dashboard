import { Pool } from 'pg';
import * as crypto from 'crypto';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface EventLog {
  id: number;
  timestamp: Date;
  user_id?: number;
  user_name?: string;
  user_email?: string;
  user_role?: string;
  action_type: 'CREATE' | 'UPDATE' | 'DELETE' | 'STATUS_CHANGE' | 'ASSIGN' | 'AI_ACTION' | 'LOGIN' | 'LOGOUT' | 'VIEW' | 'EXPORT' | 'CALCULATE';
  entity_type: 'PROJECT' | 'TRAINING' | 'ROI' | 'USER' | 'ROLE' | 'CALL' | 'KPI' | 'CAPA' | 'DOCUMENT' | 'SYSTEM' | 'SESSION';
  entity_id?: string;
  entity_name?: string;
  description?: string;
  old_value?: any;
  new_value?: any;
  ai_involved: boolean;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
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
  actionType: EventLog['action_type'];
  entityType: EventLog['entity_type'];
  entityId?: string;
  entityName?: string;
  description?: string;
  oldValue?: any;
  newValue?: any;
  aiInvolved?: boolean;
  severity?: EventLog['severity'];
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
    timestamp: new Date().toISOString()
  });
  return crypto.createHash('sha256').update(checksumData).digest('hex');
}

async function createMonthlyPartition(year: number, month: number): Promise<void> {
  const partitionName = `event_logs_y${year}m${String(month).padStart(2, '0')}`;
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 1);
  
  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];
  
  try {
    const checkResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = $1
      )
    `, [partitionName]);
    
    if (!checkResult.rows[0].exists) {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${partitionName} PARTITION OF event_logs
        FOR VALUES FROM ('${startStr}') TO ('${endStr}')
      `);
      console.log(`📋 [EventLogs] Created partition: ${partitionName}`);
    }
  } catch (error: any) {
    if (!error.message?.includes('already exists')) {
      console.error(`📋 [EventLogs] Error creating partition ${partitionName}:`, error);
    }
  }
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
  console.log('📋 [EventLogs] Migrating non-partitioned table to partitioned structure...');
  
  const backupExists = await pool.query(`
    SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_logs_backup')
  `);
  
  if (backupExists.rows[0].exists) {
    await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
  }
  
  await pool.query(`ALTER TABLE event_logs RENAME TO event_logs_backup`);
  console.log('📋 [EventLogs] Backed up existing table to event_logs_backup');
  
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
  console.log('📋 [EventLogs] Created new partitioned parent table');
}

async function copyBackupDataToPartitions(): Promise<void> {
  console.log('📋 [EventLogs] Checking for backup data to migrate...');
  
  const backupExists = await pool.query(`
    SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_logs_backup')
  `);
  
  if (!backupExists.rows[0].exists) {
    return;
  }
  
  const countResult = await pool.query(`SELECT COUNT(*) as count FROM event_logs_backup`);
  const backupCount = parseInt(countResult.rows[0].count, 10);
  
  if (backupCount === 0) {
    console.log('📋 [EventLogs] No backup data to migrate');
    await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
    return;
  }
  
  console.log(`📋 [EventLogs] Migrating ${backupCount} records from backup...`);
  
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
  console.log(`📋 [EventLogs] Successfully migrated ${newCount.rows[0].count} records`);
  
  await pool.query(`DROP TABLE IF EXISTS event_logs_backup CASCADE`);
  console.log('📋 [EventLogs] Dropped backup table after successful migration');
}

export async function initializeEventLogsTable(): Promise<void> {
  console.log('📋 [EventLogs] Initializing event_logs partitioned table...');
  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables 
        WHERE schemaname = 'public' 
        AND tablename = 'event_logs'
      )
    `);
    
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
      console.log('📋 [EventLogs] Created partitioned parent table');
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

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp ON event_logs(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_event_logs_user_id ON event_logs(user_id);
      CREATE INDEX IF NOT EXISTS idx_event_logs_action_type ON event_logs(action_type);
      CREATE INDEX IF NOT EXISTS idx_event_logs_entity_type ON event_logs(entity_type);
      CREATE INDEX IF NOT EXISTS idx_event_logs_module ON event_logs(module);
      CREATE INDEX IF NOT EXISTS idx_event_logs_severity ON event_logs(severity);
      CREATE INDEX IF NOT EXISTS idx_event_logs_correlation_id ON event_logs(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_event_logs_created_at ON event_logs(created_at DESC);
    `);
    
    console.log('📋 [EventLogs] Partitioned table and indexes created successfully');
  } catch (error) {
    console.error('📋 [EventLogs] Error initializing partitioned table:', error);
    throw error;
  }
}

export async function logEvent(input: EventLogInput): Promise<EventLog> {
  console.log('📋 [EventLogs] Logging event:', input.actionType, input.entityType, input.entityId || 'N/A');
  
  try {
    const checksum = generateChecksum(input);
    console.log('📋 [EventLogs] Generated checksum:', checksum.substring(0, 16) + '...');

    const result = await pool.query(
      `INSERT INTO event_logs (
        user_id, user_name, user_email, user_role,
        action_type, entity_type, entity_id, entity_name,
        description, old_value, new_value, ai_involved,
        severity, correlation_id, ip_address, user_agent,
        module, checksum
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        input.userId || null,
        input.userName || null,
        input.userEmail || null,
        input.userRole || null,
        input.actionType,
        input.entityType,
        input.entityId || null,
        input.entityName || null,
        input.description || null,
        input.oldValue ? JSON.stringify(input.oldValue) : null,
        input.newValue ? JSON.stringify(input.newValue) : null,
        input.aiInvolved || false,
        input.severity || 'INFO',
        input.correlationId || null,
        input.ipAddress || null,
        input.userAgent || null,
        input.module || null,
        checksum
      ]
    );

    const eventLog = result.rows[0] as EventLog;
    console.log('📋 [EventLogs] Event logged successfully with ID:', eventLog.id);
    return eventLog;
  } catch (error) {
    console.error('📋 [EventLogs] Error logging event:', error);
    throw error;
  }
}

export async function getEventLogs(filters: EventLogFilters): Promise<{
  logs: EventLog[];
  total: number;
  page: number;
  pageSize: number;
}> {
  console.log('📋 [EventLogs] Fetching event logs with filters:', JSON.stringify(filters));
  
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM event_logs ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const logsResult = await pool.query(
      `SELECT * FROM event_logs ${whereClause} 
       ORDER BY timestamp DESC 
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, pageSize, offset]
    );

    console.log('📋 [EventLogs] Retrieved', logsResult.rows.length, 'logs out of', total, 'total');

    return {
      logs: logsResult.rows as EventLog[],
      total,
      page,
      pageSize
    };
  } catch (error) {
    console.error('📋 [EventLogs] Error fetching event logs:', error);
    throw error;
  }
}

export async function getEventLogById(id: number): Promise<EventLog | null> {
  console.log('📋 [EventLogs] Fetching event log by ID:', id);
  
  try {
    const result = await pool.query(
      'SELECT * FROM event_logs WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      console.log('📋 [EventLogs] No event log found with ID:', id);
      return null;
    }

    console.log('📋 [EventLogs] Found event log:', result.rows[0].action_type, result.rows[0].entity_type);
    return result.rows[0] as EventLog;
  } catch (error) {
    console.error('📋 [EventLogs] Error fetching event log by ID:', error);
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
  console.log('📋 [EventLogs] Calculating event log statistics...');
  
  try {
    const totalResult = await pool.query('SELECT COUNT(*) as total FROM event_logs');
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
    const activityByDay = activityResult.rows.map(row => ({
      date: row.date.toISOString().split('T')[0],
      count: parseInt(row.count, 10)
    }));

    console.log('📋 [EventLogs] Stats calculated - Total:', totalLogs, 'Last 24h:', last24Hours, 'Critical:', criticalEvents, 'AI:', aiActions);

    return {
      totalLogs,
      byModule,
      byActionType,
      bySeverity,
      last24Hours,
      criticalEvents,
      aiActions,
      activityByDay
    };
  } catch (error) {
    console.error('📋 [EventLogs] Error calculating stats:', error);
    throw error;
  }
}

export async function exportEventLogs(filters: EventLogFilters): Promise<EventLog[]> {
  console.log('📋 [EventLogs] Exporting event logs with filters:', JSON.stringify(filters));
  
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const result = await pool.query(
      `SELECT * FROM event_logs ${whereClause} ORDER BY timestamp DESC`,
      params
    );

    console.log('📋 [EventLogs] Exported', result.rows.length, 'event logs');
    return result.rows as EventLog[];
  } catch (error) {
    console.error('📋 [EventLogs] Error exporting event logs:', error);
    throw error;
  }
}

console.log('📋 [EventLogs] Module loaded, initializing table...');
initializeEventLogsTable().catch(err => {
  console.error('📋 [EventLogs] Failed to initialize table on module load:', err);
});
