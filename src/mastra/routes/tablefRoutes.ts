import { Hono } from 'hono';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// FIX: tablef_* tables were referenced by every endpoint in this router but
// never created — every request returned 500. This idempotent initializer
// creates the schema on first request (lazy, memoized) and seeds default
// departments. Safe to call repeatedly thanks to IF NOT EXISTS.
let initPromise: Promise<void> | null = null;
export async function initTableFTables(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    console.log('📊 [TableF] Initializing TableF schema...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tablef_departments (
        department_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tablef_kpis (
        kpi_id VARCHAR(50) PRIMARY KEY,
        department_id VARCHAR(50) REFERENCES tablef_departments(department_id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100),
        unit VARCHAR(50),
        target_annual NUMERIC(12,2),
        target_monthly NUMERIC(12,2),
        weight NUMERIC(5,2) DEFAULT 1.0,
        owner_email VARCHAR(255),
        data_source VARCHAR(255),
        calculation_definition TEXT,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tablef_performance (
        id SERIAL PRIMARY KEY,
        kpi_id VARCHAR(50) REFERENCES tablef_kpis(kpi_id) ON DELETE CASCADE,
        department_id VARCHAR(50),
        period_month VARCHAR(10) NOT NULL,
        target NUMERIC(12,2),
        achieved NUMERIC(12,2),
        variance NUMERIC(12,2),
        variance_percent NUMERIC(8,2),
        status VARCHAR(20),
        trend VARCHAR(10),
        comment TEXT,
        evidence_link TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (kpi_id, period_month)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tablef_snapshots (
        id SERIAL PRIMARY KEY,
        department_id VARCHAR(50),
        period VARCHAR(20) NOT NULL,
        total_kpis INTEGER,
        kpis_met INTEGER,
        kpis_improving INTEGER,
        kpis_not_met INTEGER,
        percent_met NUMERIC(5,2),
        percent_met_or_improving NUMERIC(5,2),
        copc_status VARCHAR(20),
        ai_risk_level VARCHAR(20),
        calculated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE (department_id, period)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tablef_users (
        user_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        role VARCHAR(100),
        departments TEXT[] DEFAULT '{}',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tablef_ai_insights (
        id SERIAL PRIMARY KEY,
        department_id VARCHAR(50),
        kpi_id VARCHAR(50),
        insight_type VARCHAR(50),
        title VARCHAR(255),
        body TEXT,
        severity VARCHAR(20),
        status VARCHAR(20) DEFAULT 'ACTIVE',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    // Seed canonical departments once.
    const c = await pool.query('SELECT COUNT(*)::int AS n FROM tablef_departments');
    if (c.rows[0].n === 0) {
      const seed = [
        ['SDR', 'Sales Development', 'Lead qualification and outreach'],
        ['WP_SALES', 'WalaPlus Sales', 'WP product line sales team'],
        ['WO_SALES', 'WalaOnline Sales', 'WO product line sales team'],
        ['MP', 'Marketplace', 'Marketplace partner ops'],
        ['CS', 'Customer Success', 'Account management and renewals'],
        ['MGMT', 'Management', 'Executive and management'],
        ['MRK', 'Marketing', 'Marketing and demand generation'],
        ['BD', 'Business Development', 'Strategic partnerships'],
      ];
      for (const [id, name, desc] of seed) {
        await pool.query(
          'INSERT INTO tablef_departments (department_id, name, description, active) VALUES ($1,$2,$3,true) ON CONFLICT (department_id) DO NOTHING',
          [id, name, desc]
        );
      }
      console.log(`🌱 [TableF] Seeded ${seed.length} default departments`);
    }
    console.log('✅ [TableF] Schema ready');
  })().catch((err) => {
    initPromise = null; // allow retry on next request
    throw err;
  });
  return initPromise;
}

export function createTableFRoutes() {
  const app = new Hono();

  // Ensure tables exist before any handler runs.
  app.use('*', async (c, next) => {
    try {
      await initTableFTables();
    } catch (err) {
      console.error('[TableF] Schema init failed:', err);
      return c.json({ error: 'TableF schema initialization failed' }, 500);
    }
    return next();
  });

  app.get('/departments', async (c) => {
    try {
      const result = await pool.query(
        'SELECT * FROM tablef_departments WHERE active = true ORDER BY name'
      );
      return c.json({ departments: result.rows });
    } catch (error) {
      console.error('Error fetching departments:', error);
      return c.json({ error: 'Failed to fetch departments', departments: [] }, 500);
    }
  });

  app.get('/kpis', async (c) => {
    try {
      const deptId = c.req.query('department_id');
      let query = 'SELECT * FROM tablef_kpis WHERE enabled = true';
      const params: string[] = [];
      
      if (deptId) {
        query += ' AND department_id = $1';
        params.push(deptId);
      }
      
      query += ' ORDER BY department_id, name';
      
      const result = await pool.query(query, params);
      return c.json({ kpis: result.rows });
    } catch (error) {
      console.error('Error fetching KPIs:', error);
      return c.json({ error: 'Failed to fetch KPIs', kpis: [] }, 500);
    }
  });

  app.post('/kpis', async (c) => {
    try {
      const data = await c.req.json();
      
      if (data.kpi_id) {
        const result = await pool.query(
          `UPDATE tablef_kpis SET 
            department_id = $1, name = $2, description = $3, category = $4, 
            unit = $5, target_annual = $6, target_monthly = $7, weight = $8, 
            owner_email = $9, data_source = $10, calculation_definition = $11, 
            updated_at = CURRENT_TIMESTAMP
          WHERE kpi_id = $12 RETURNING *`,
          [data.department_id, data.name, data.description, data.category, 
           data.unit, data.target_annual, data.target_monthly, data.weight,
           data.owner_email, data.data_source, data.calculation_definition, data.kpi_id]
        );
        return c.json({ success: true, kpi: result.rows[0] });
      } else {
        const kpiId = `KPI-${Date.now()}`;
        const result = await pool.query(
          `INSERT INTO tablef_kpis 
            (kpi_id, department_id, name, description, category, unit, target_annual, 
             target_monthly, weight, owner_email, data_source, calculation_definition)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
          [kpiId, data.department_id, data.name, data.description, data.category, 
           data.unit, data.target_annual, data.target_monthly, data.weight,
           data.owner_email, data.data_source, data.calculation_definition]
        );
        return c.json({ success: true, kpi: result.rows[0] });
      }
    } catch (error) {
      console.error('Error saving KPI:', error);
      return c.json({ error: 'Failed to save KPI' }, 500);
    }
  });

  app.delete('/kpis/:kpiId', async (c) => {
    try {
      const kpiId = c.req.param('kpiId');
      await pool.query(
        'UPDATE tablef_kpis SET enabled = false, updated_at = CURRENT_TIMESTAMP WHERE kpi_id = $1',
        [kpiId]
      );
      return c.json({ success: true });
    } catch (error) {
      console.error('Error archiving KPI:', error);
      return c.json({ error: 'Failed to archive KPI' }, 500);
    }
  });

  app.get('/performance', async (c) => {
    try {
      const kpiId = c.req.query('kpi_id');
      const deptId = c.req.query('department_id');
      const period = c.req.query('period');
      
      let query = 'SELECT * FROM tablef_performance WHERE 1=1';
      const params: string[] = [];
      let paramIndex = 1;
      
      if (kpiId) {
        query += ` AND kpi_id = $${paramIndex++}`;
        params.push(kpiId);
      }
      if (deptId) {
        query += ` AND department_id = $${paramIndex++}`;
        params.push(deptId);
      }
      if (period) {
        query += ` AND period_month LIKE $${paramIndex++}`;
        params.push(`${period}%`);
      }
      
      query += ' ORDER BY period_month DESC';
      
      const result = await pool.query(query, params);
      return c.json({ performance: result.rows });
    } catch (error) {
      console.error('Error fetching performance:', error);
      return c.json({ error: 'Failed to fetch performance', performance: [] }, 500);
    }
  });

  app.post('/performance', async (c) => {
    try {
      const data = await c.req.json();
      
      const variance = data.achieved - data.target;
      const variancePercent = data.target !== 0 ? ((data.achieved - data.target) / data.target) * 100 : 0;
      
      let status = 'NOT_MET';
      if (data.achieved >= data.target) {
        status = 'MET';
      } else if (data.achieved >= data.target * 0.9) {
        status = 'IMPROVING';
      }
      
      const existingResult = await pool.query(
        'SELECT * FROM tablef_performance WHERE kpi_id = $1 AND period_month = $2',
        [data.kpi_id, data.period_month]
      );
      
      const prevResult = await pool.query(
        `SELECT achieved FROM tablef_performance 
         WHERE kpi_id = $1 AND period_month < $2 
         ORDER BY period_month DESC LIMIT 1`,
        [data.kpi_id, data.period_month]
      );
      
      let trend = 'FLAT';
      if (prevResult.rows.length > 0) {
        const prevAchieved = parseFloat(prevResult.rows[0].achieved);
        if (data.achieved > prevAchieved) trend = 'UP';
        else if (data.achieved < prevAchieved) trend = 'DOWN';
      }
      
      if (existingResult.rows.length > 0) {
        await pool.query(
          `UPDATE tablef_performance SET 
            target = $1, achieved = $2, variance = $3, variance_percent = $4,
            status = $5, trend = $6, comment = $7, evidence_link = $8,
            updated_at = CURRENT_TIMESTAMP
          WHERE kpi_id = $9 AND period_month = $10`,
          [data.target, data.achieved, variance, variancePercent, status, trend,
           data.comment, data.evidence_link, data.kpi_id, data.period_month]
        );
      } else {
        await pool.query(
          `INSERT INTO tablef_performance 
            (kpi_id, department_id, period_month, target, achieved, variance, 
             variance_percent, status, trend, comment, evidence_link)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [data.kpi_id, data.department_id, data.period_month, data.target, 
           data.achieved, variance, variancePercent, status, trend,
           data.comment, data.evidence_link]
        );
      }
      
      return c.json({ success: true, status, trend, variance, variancePercent });
    } catch (error) {
      console.error('Error saving performance:', error);
      return c.json({ error: 'Failed to save performance' }, 500);
    }
  });

  app.get('/snapshots', async (c) => {
    try {
      const deptId = c.req.query('department_id');
      const period = c.req.query('period');
      
      let query = 'SELECT * FROM tablef_snapshots WHERE 1=1';
      const params: string[] = [];
      let paramIndex = 1;
      
      if (deptId) {
        query += ` AND department_id = $${paramIndex++}`;
        params.push(deptId);
      }
      if (period) {
        query += ` AND period = $${paramIndex++}`;
        params.push(period);
      }
      
      query += ' ORDER BY calculated_at DESC';
      
      const result = await pool.query(query, params);
      return c.json({ snapshots: result.rows });
    } catch (error) {
      console.error('Error fetching snapshots:', error);
      return c.json({ error: 'Failed to fetch snapshots', snapshots: [] }, 500);
    }
  });

  app.post('/snapshots/calculate', async (c) => {
    try {
      const period = c.req.query('period') || '2024-YTD';
      
      const deptsResult = await pool.query('SELECT * FROM tablef_departments WHERE active = true');
      const departments = deptsResult.rows;
      
      for (const dept of departments) {
        const kpisResult = await pool.query(
          'SELECT * FROM tablef_kpis WHERE department_id = $1 AND enabled = true',
          [dept.department_id]
        );
        const kpis = kpisResult.rows;
        const totalKpis = kpis.length;
        
        let met = 0, improving = 0, notMet = 0;
        
        for (const kpi of kpis) {
          const perfResult = await pool.query(
            `SELECT * FROM tablef_performance 
             WHERE kpi_id = $1 
             ORDER BY period_month DESC LIMIT 1`,
            [kpi.kpi_id]
          );
          
          if (perfResult.rows.length > 0) {
            const perf = perfResult.rows[0];
            if (perf.status === 'MET') met++;
            else if (perf.status === 'IMPROVING' || perf.trend === 'UP') improving++;
            else notMet++;
          } else {
            notMet++;
          }
        }
        
        const percentMet = totalKpis > 0 ? (met / totalKpis * 100) : 0;
        const percentMetOrImproving = totalKpis > 0 ? ((met + improving) / totalKpis * 100) : 0;
        
        let copcStatus = 'NON_COMPLIANT';
        if (percentMet >= 50 && percentMetOrImproving >= 75) copcStatus = 'COMPLIANT';
        else if (percentMetOrImproving >= 75) copcStatus = 'AT_RISK';
        
        let aiRiskLevel = 'Low';
        if (copcStatus === 'NON_COMPLIANT') aiRiskLevel = 'High';
        else if (copcStatus === 'AT_RISK') aiRiskLevel = 'Medium';
        
        await pool.query(
          `INSERT INTO tablef_snapshots 
            (department_id, period, total_kpis, kpis_met, kpis_improving, kpis_not_met,
             percent_met, percent_met_or_improving, copc_status, ai_risk_level)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
          ON CONFLICT (department_id, period) 
          DO UPDATE SET 
            total_kpis = $3, kpis_met = $4, kpis_improving = $5, kpis_not_met = $6,
            percent_met = $7, percent_met_or_improving = $8, copc_status = $9, 
            ai_risk_level = $10, calculated_at = CURRENT_TIMESTAMP`,
          [dept.department_id, period, totalKpis, met, improving, notMet,
           percentMet, percentMetOrImproving, copcStatus, aiRiskLevel]
        );
      }
      
      return c.json({ success: true, message: 'Snapshots calculated successfully' });
    } catch (error) {
      console.error('Error calculating snapshots:', error);
      return c.json({ error: 'Failed to calculate snapshots' }, 500);
    }
  });

  app.get('/users', async (c) => {
    try {
      const result = await pool.query('SELECT * FROM tablef_users ORDER BY name');
      return c.json({ users: result.rows });
    } catch (error) {
      console.error('Error fetching users:', error);
      return c.json({ error: 'Failed to fetch users', users: [] }, 500);
    }
  });

  app.post('/users', async (c) => {
    try {
      const data = await c.req.json();
      
      if (data.user_id) {
        await pool.query(
          `UPDATE tablef_users SET 
            name = $1, email = $2, role = $3, departments = $4, 
            active = $5, updated_at = CURRENT_TIMESTAMP
          WHERE user_id = $6`,
          [data.name, data.email, data.role, data.departments, data.active, data.user_id]
        );
      } else {
        const userId = `USR-${Date.now()}`;
        await pool.query(
          `INSERT INTO tablef_users (user_id, name, email, role, departments)
          VALUES ($1, $2, $3, $4, $5)`,
          [userId, data.name, data.email, data.role, data.departments || []]
        );
      }
      
      return c.json({ success: true });
    } catch (error) {
      console.error('Error saving user:', error);
      return c.json({ error: 'Failed to save user' }, 500);
    }
  });

  app.get('/insights', async (c) => {
    try {
      const result = await pool.query(
        'SELECT * FROM tablef_ai_insights WHERE status = $1 ORDER BY created_at DESC LIMIT 50',
        ['ACTIVE']
      );
      return c.json({ insights: result.rows });
    } catch (error) {
      console.error('Error fetching insights:', error);
      return c.json({ error: 'Failed to fetch insights', insights: [] }, 500);
    }
  });

  return app;
}
