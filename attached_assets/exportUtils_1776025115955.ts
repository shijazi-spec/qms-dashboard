import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface FilterParams {
  dateFrom?: string;
  dateTo?: string;
  department?: string;
  assignedTo?: string;
  status?: string;
  severity?: string;
  limit?: number;
  offset?: number;
}

export function buildFilterClauses(filters: FilterParams, dateColumn: string = 'created_at'): { conditions: string[]; params: any[]; paramIdx: number } {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (filters.dateFrom) {
    conditions.push(`${dateColumn} >= $${paramIdx++}`);
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    conditions.push(`${dateColumn} <= $${paramIdx++}`);
    params.push(filters.dateTo);
  }
  if (filters.department) {
    conditions.push(`department = $${paramIdx++}`);
    params.push(filters.department);
  }
  if (filters.assignedTo) {
    conditions.push(`assigned_to = $${paramIdx++}`);
    params.push(filters.assignedTo);
  }
  if (filters.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }
  if (filters.severity) {
    conditions.push(`severity = $${paramIdx++}`);
    params.push(filters.severity);
  }

  return { conditions, params, paramIdx };
}

export function toCSV(rows: any[], columns?: string[]): string {
  if (rows.length === 0) return '';
  const cols = columns || Object.keys(rows[0]);
  const header = cols.join(',');
  const body = rows.map(row =>
    cols.map(col => {
      const val = row[col];
      if (val == null) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    }).join(',')
  ).join('\n');
  return header + '\n' + body;
}

export { pool as exportPool };
