import { createRedactedPool } from './redactedPool';

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface EvidenceRecord {
  id?: number;
  entity_type: 'nc' | 'capa' | 'compliance' | 'risk_treatment' | 'audit' | 'policy';
  entity_id: number;
  filename: string;
  original_filename: string;
  file_type: string;
  file_size: number;
  uploaded_by: string;
  description?: string;
  upload_date?: Date;
  metadata?: any;
}

export async function initEvidenceTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS evidence_records (
      id SERIAL PRIMARY KEY,
      entity_type VARCHAR(30) NOT NULL,
      entity_id INTEGER NOT NULL,
      filename VARCHAR(500) NOT NULL,
      original_filename VARCHAR(500) NOT NULL,
      file_type VARCHAR(100) NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      uploaded_by VARCHAR(255) NOT NULL,
      description TEXT,
      upload_date TIMESTAMP DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'::jsonb
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_evidence_entity ON evidence_records(entity_type, entity_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_evidence_uploader ON evidence_records(uploaded_by)`);
}

export async function addEvidence(evidence: Omit<EvidenceRecord, 'id' | 'upload_date'>): Promise<EvidenceRecord> {
  const result = await pool.query(
    `INSERT INTO evidence_records (entity_type, entity_id, filename, original_filename, file_type, file_size, uploaded_by, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [evidence.entity_type, evidence.entity_id, evidence.filename, evidence.original_filename,
     evidence.file_type, evidence.file_size, evidence.uploaded_by, evidence.description || null,
     evidence.metadata ? JSON.stringify(evidence.metadata) : '{}']
  );
  return result.rows[0];
}

export async function getEvidenceForEntity(entityType: string, entityId: number): Promise<EvidenceRecord[]> {
  const result = await pool.query(
    `SELECT * FROM evidence_records WHERE entity_type = $1 AND entity_id = $2 ORDER BY upload_date DESC`,
    [entityType, entityId]
  );
  return result.rows;
}

export async function deleteEvidence(id: number): Promise<boolean> {
  const result = await pool.query(`DELETE FROM evidence_records WHERE id = $1 RETURNING id`, [id]);
  return result.rows.length > 0;
}

export async function getEvidencePack(scope: {
  entityType?: string; entityIds?: number[]; dateFrom?: string; dateTo?: string;
}): Promise<EvidenceRecord[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (scope.entityType) {
    conditions.push(`entity_type = $${paramIdx++}`);
    params.push(scope.entityType);
  }
  if (scope.entityIds && scope.entityIds.length > 0) {
    const placeholders = scope.entityIds.map(() => `$${paramIdx++}`).join(',');
    conditions.push(`entity_id IN (${placeholders})`);
    params.push(...scope.entityIds);
  }
  if (scope.dateFrom) {
    conditions.push(`upload_date >= $${paramIdx++}`);
    params.push(scope.dateFrom);
  }
  if (scope.dateTo) {
    conditions.push(`upload_date <= $${paramIdx++}`);
    params.push(scope.dateTo);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT * FROM evidence_records ${where} ORDER BY entity_type, entity_id, upload_date DESC`,
    params
  );
  return result.rows;
}

export async function getEvidenceSummary(): Promise<any> {
  const result = await pool.query(`
    SELECT entity_type, COUNT(*) as count, SUM(file_size) as total_size
    FROM evidence_records
    GROUP BY entity_type
    ORDER BY entity_type
  `);
  return result.rows;
}
