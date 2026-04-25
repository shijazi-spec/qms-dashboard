import { createRedactedPool } from "./redactedPool";

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function initOnboardingTables(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_onboarding_status (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL UNIQUE,
        user_email VARCHAR(255),
        user_name VARCHAR(255),
        user_role VARCHAR(50) DEFAULT 'bu_user',
        video_watched BOOLEAN DEFAULT FALSE,
        video_watched_at TIMESTAMPTZ,
        tour_completed BOOLEAN DEFAULT FALSE,
        tour_completed_at TIMESTAMPTZ,
        tour_step_reached INTEGER DEFAULT 0,
        demo_version VARCHAR(50) DEFAULT '1.0',
        last_login_at TIMESTAMPTZ DEFAULT NOW(),
        first_login_at TIMESTAMPTZ DEFAULT NOW(),
        onboarding_skipped BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS demo_links (
        id SERIAL PRIMARY KEY,
        link_code VARCHAR(100) NOT NULL UNIQUE,
        created_by VARCHAR(255),
        created_by_email VARCHAR(255),
        description TEXT,
        expires_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT TRUE,
        view_count INTEGER DEFAULT 0,
        last_viewed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS onboarding_tour_steps (
        id SERIAL PRIMARY KEY,
        step_number INTEGER NOT NULL,
        step_name VARCHAR(100) NOT NULL,
        target_role VARCHAR(50) DEFAULT 'all',
        title VARCHAR(255) NOT NULL,
        description TEXT,
        target_element VARCHAR(255),
        highlight_selector VARCHAR(255),
        position VARCHAR(50) DEFAULT 'bottom',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tooltip_definitions (
        id SERIAL PRIMARY KEY,
        field_id VARCHAR(100) NOT NULL UNIQUE,
        module VARCHAR(50) NOT NULL,
        field_label VARCHAR(255) NOT NULL,
        tooltip_text TEXT NOT NULL,
        calculation_hint TEXT,
        data_source_hint TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_onboarding_user_id ON user_onboarding_status(user_id);
      CREATE INDEX IF NOT EXISTS idx_onboarding_user_role ON user_onboarding_status(user_role);
      CREATE INDEX IF NOT EXISTS idx_demo_links_code ON demo_links(link_code);
      CREATE INDEX IF NOT EXISTS idx_tour_steps_role ON onboarding_tour_steps(target_role);
      CREATE INDEX IF NOT EXISTS idx_tooltips_module ON tooltip_definitions(module);
    `);

    // Seed default tour steps if none exist
    const stepCheck = await client.query('SELECT COUNT(*) FROM onboarding_tour_steps');
    if (parseInt(stepCheck.rows[0].count) === 0) {
      await seedDefaultTourSteps(client);
    }

    // Seed default tooltips if none exist
    const tooltipCheck = await client.query('SELECT COUNT(*) FROM tooltip_definitions');
    if (parseInt(tooltipCheck.rows[0].count) === 0) {
      await seedDefaultTooltips(client);
    }

    console.log("✅ Onboarding tables initialized successfully");
  } finally {
    client.release();
  }
}

async function seedDefaultTourSteps(client: any): Promise<void> {
  const defaultSteps = [
    { step_number: 1, step_name: 'dashboard_overview', target_role: 'all', title: 'Dashboard Overview', description: 'This is your main dashboard showing key quality metrics, KPIs, and system health. Use the navigation bar to access different modules.', target_element: '#main-dashboard', position: 'center' },
    { step_number: 2, step_name: 'projects_governance', target_role: 'all', title: 'Projects & Governance', description: 'Track quality projects, manage PMP portfolios, and monitor governance compliance. Each project includes risks, milestones, and stakeholders.', target_element: 'a[href="/projects"]', position: 'bottom' },
    { step_number: 3, step_name: 'roi_calculator', target_role: 'all', title: 'ROI / NPV Calculator', description: 'Submit quality improvement initiatives here. Enter costs, expected savings, and let the system calculate ROI, NPV, and payback period with AI recommendations.', target_element: 'a[href="/roi"]', position: 'bottom' },
    { step_number: 4, step_name: 'event_logs', target_role: 'all', title: 'Event Logs & Audit Trail', description: 'All system actions are logged here for compliance and transparency. Filter by date, action type, or module to trace any activity.', target_element: 'a[href="/logs"]', position: 'bottom' },
    { step_number: 5, step_name: 'ai_assistance', target_role: 'all', title: 'AI Assistance', description: 'Our Agentic AI validates your inputs, provides recommendations, and helps ensure data quality. Look for the purple AI badges throughout the system.', target_element: '.ai-badge', position: 'left' },
    { step_number: 6, step_name: 'submission_flow', target_role: 'bu_user', title: 'Submission & Review Flow', description: 'After submitting an initiative, Quality and Finance teams review it. You can track status in your dashboard. Approved initiatives proceed to implementation.', target_element: '#submission-status', position: 'center' }
  ];

  for (const step of defaultSteps) {
    await client.query(
      `INSERT INTO onboarding_tour_steps (step_number, step_name, target_role, title, description, target_element, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [step.step_number, step.step_name, step.target_role, step.title, step.description, step.target_element, step.position]
    );
  }
  console.log("✅ Default tour steps seeded");
}

async function seedDefaultTooltips(client: any): Promise<void> {
  const defaultTooltips = [
    { field_id: 'expected_savings_monthly', module: 'roi', field_label: 'Expected Monthly Savings (SAR)', tooltip_text: 'Enter the estimated monthly cost savings this initiative will generate once fully implemented.', calculation_hint: 'Calculate by: (Current monthly cost - Expected monthly cost after implementation)', data_source_hint: 'Finance or Operations department can provide current cost data.' },
    { field_id: 'implementation_cost', module: 'roi', field_label: 'Implementation Cost (SAR)', tooltip_text: 'Total one-time cost to implement this initiative, including technology, training, and change management.', calculation_hint: 'Sum of: Technology costs + Training costs + Consulting fees + Contingency', data_source_hint: 'IT, HR Training, and Procurement departments.' },
    { field_id: 'project_duration_months', module: 'roi', field_label: 'Project Duration (Months)', tooltip_text: 'How long the project will run before full benefits are realized.', calculation_hint: 'Include planning, implementation, and stabilization phases.', data_source_hint: 'Project Management or department leads.' },
    { field_id: 'discount_rate', module: 'roi', field_label: 'Discount Rate (%)', tooltip_text: 'The rate used to discount future cash flows to present value. Default is 10% per company policy.', calculation_hint: 'Typically matches company cost of capital or required rate of return.', data_source_hint: 'Finance department sets the standard rate.' },
    { field_id: 'error_rate_percent', module: 'roi', field_label: 'Current Error Rate (%)', tooltip_text: 'Percentage of transactions or processes that currently result in errors requiring rework.', calculation_hint: 'Calculate: (Number of errors / Total transactions) × 100', data_source_hint: 'Quality or Operations team tracking data.' },
    { field_id: 'headcount_affected', module: 'roi', field_label: 'Headcount Affected', tooltip_text: 'Number of employees whose work will be impacted or made more efficient by this initiative.', calculation_hint: 'Count all FTEs directly affected by process changes.', data_source_hint: 'HR or department managers.' },
    { field_id: 'risk_score', module: 'pmp', field_label: 'Risk Score', tooltip_text: 'Calculated as Probability × Impact. Higher scores indicate risks requiring more attention.', calculation_hint: 'Score = Probability (1-5) × Impact (1-5). Max score is 25.', data_source_hint: 'Project team risk assessment workshop.' }
  ];

  for (const tooltip of defaultTooltips) {
    await client.query(
      `INSERT INTO tooltip_definitions (field_id, module, field_label, tooltip_text, calculation_hint, data_source_hint)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tooltip.field_id, tooltip.module, tooltip.field_label, tooltip.tooltip_text, tooltip.calculation_hint, tooltip.data_source_hint]
    );
  }
  console.log("✅ Default tooltips seeded");
}

// User onboarding status functions
export async function getUserOnboardingStatus(userId: string): Promise<any> {
  const result = await pool.query(
    'SELECT * FROM user_onboarding_status WHERE user_id = $1',
    [userId]
  );
  return result.rows[0] || null;
}

export async function createOrUpdateOnboardingStatus(data: {
  user_id: string;
  user_email?: string;
  user_name?: string;
  user_role?: string;
  video_watched?: boolean;
  tour_completed?: boolean;
  tour_step_reached?: number;
  onboarding_skipped?: boolean;
}): Promise<any> {
  const existing = await getUserOnboardingStatus(data.user_id);
  
  if (existing) {
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.video_watched !== undefined) {
      updates.push(`video_watched = $${idx}, video_watched_at = ${data.video_watched ? 'NOW()' : 'NULL'}`);
      values.push(data.video_watched);
      idx++;
    }
    if (data.tour_completed !== undefined) {
      updates.push(`tour_completed = $${idx}, tour_completed_at = ${data.tour_completed ? 'NOW()' : 'NULL'}`);
      values.push(data.tour_completed);
      idx++;
    }
    if (data.tour_step_reached !== undefined) {
      updates.push(`tour_step_reached = $${idx}`);
      values.push(data.tour_step_reached);
      idx++;
    }
    if (data.onboarding_skipped !== undefined) {
      updates.push(`onboarding_skipped = $${idx}`);
      values.push(data.onboarding_skipped);
      idx++;
    }
    
    updates.push('updated_at = NOW()');
    updates.push('last_login_at = NOW()');
    values.push(data.user_id);

    const result = await pool.query(
      `UPDATE user_onboarding_status SET ${updates.join(', ')} WHERE user_id = $${idx} RETURNING *`,
      values
    );
    return result.rows[0];
  } else {
    const result = await pool.query(
      `INSERT INTO user_onboarding_status 
       (user_id, user_email, user_name, user_role, video_watched, tour_completed, tour_step_reached, onboarding_skipped)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.user_id,
        data.user_email || null,
        data.user_name || null,
        data.user_role || 'bu_user',
        data.video_watched || false,
        data.tour_completed || false,
        data.tour_step_reached || 0,
        data.onboarding_skipped || false
      ]
    );
    return result.rows[0];
  }
}

export async function getAllOnboardingStatuses(filters?: {
  role?: string;
  completed?: boolean;
}): Promise<any[]> {
  let query = 'SELECT * FROM user_onboarding_status WHERE 1=1';
  const params: any[] = [];
  let idx = 1;

  if (filters?.role) {
    query += ` AND user_role = $${idx}`;
    params.push(filters.role);
    idx++;
  }
  if (filters?.completed !== undefined) {
    query += ` AND tour_completed = $${idx}`;
    params.push(filters.completed);
    idx++;
  }

  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  return result.rows;
}

export async function getOnboardingStats(): Promise<any> {
  const result = await pool.query(`
    SELECT 
      COUNT(*) as total_users,
      COUNT(*) FILTER (WHERE video_watched = true) as video_watched_count,
      COUNT(*) FILTER (WHERE tour_completed = true) as tour_completed_count,
      COUNT(*) FILTER (WHERE onboarding_skipped = true) as skipped_count,
      ROUND(AVG(tour_step_reached)::numeric, 1) as avg_step_reached
    FROM user_onboarding_status
  `);
  return result.rows[0];
}

// Demo links functions
export async function createDemoLink(data: {
  created_by?: string;
  created_by_email?: string;
  description?: string;
  expires_at?: Date;
}): Promise<any> {
  const linkCode = `demo-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const result = await pool.query(
    `INSERT INTO demo_links (link_code, created_by, created_by_email, description, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [linkCode, data.created_by, data.created_by_email, data.description, data.expires_at]
  );
  return result.rows[0];
}

export async function getDemoLink(linkCode: string): Promise<any> {
  const result = await pool.query(
    'SELECT * FROM demo_links WHERE link_code = $1',
    [linkCode]
  );
  return result.rows[0] || null;
}

export async function validateDemoLink(linkCode: string): Promise<{ valid: boolean; reason?: string }> {
  const link = await getDemoLink(linkCode);
  if (!link) return { valid: false, reason: 'Link not found' };
  if (!link.is_active) return { valid: false, reason: 'Link is inactive' };
  if (link.expires_at && new Date(link.expires_at) < new Date()) {
    return { valid: false, reason: 'Link has expired' };
  }
  
  // Increment view count
  await pool.query(
    'UPDATE demo_links SET view_count = view_count + 1, last_viewed_at = NOW() WHERE link_code = $1',
    [linkCode]
  );
  
  return { valid: true };
}

export async function listDemoLinks(): Promise<any[]> {
  const result = await pool.query('SELECT * FROM demo_links ORDER BY created_at DESC');
  return result.rows;
}

export async function deactivateDemoLink(linkCode: string): Promise<void> {
  await pool.query('UPDATE demo_links SET is_active = false WHERE link_code = $1', [linkCode]);
}

// Tour steps functions
export async function getTourSteps(role?: string): Promise<any[]> {
  let query = 'SELECT * FROM onboarding_tour_steps WHERE is_active = true';
  const params: any[] = [];

  if (role) {
    query += ` AND (target_role = $1 OR target_role = 'all')`;
    params.push(role);
  }

  query += ' ORDER BY step_number ASC';
  const result = await pool.query(query, params);
  return result.rows;
}

// Tooltip functions
export async function getTooltips(module?: string): Promise<any[]> {
  let query = 'SELECT * FROM tooltip_definitions WHERE is_active = true';
  const params: any[] = [];

  if (module) {
    query += ' AND module = $1';
    params.push(module);
  }

  query += ' ORDER BY field_id ASC';
  const result = await pool.query(query, params);
  return result.rows;
}

export async function getTooltip(fieldId: string): Promise<any> {
  const result = await pool.query(
    'SELECT * FROM tooltip_definitions WHERE field_id = $1 AND is_active = true',
    [fieldId]
  );
  return result.rows[0] || null;
}
