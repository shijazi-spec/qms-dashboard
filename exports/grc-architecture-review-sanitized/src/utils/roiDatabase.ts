import { createRedactedPool } from './redactedPool';

const pool = createRedactedPool({
  connectionString: process.env.DATABASE_URL,
});

export interface ROIInitiative {
  id?: number;
  initiative_id: string;
  project_name: string;
  owner: string;
  department: string;
  description?: string;
  problem_statement?: string;
  baseline_cost: number;
  expected_savings_monthly: number;
  implementation_cost: number;
  project_duration_months: number;
  discount_rate: number;
  expected_revenue_increase?: number;
  avoided_cost?: number;
  roi_percentage?: number;
  payback_period_months?: number;
  npv?: number;
  profitability_index?: number;
  ai_recommendation?: 'approve' | 'evaluate' | 'reject';
  ai_insights?: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'in_progress' | 'completed';
  priority?: 'critical' | 'high' | 'medium' | 'low';
  start_date?: Date;
  end_date?: Date;
  actual_savings?: number;
  actual_cost?: number;
  metadata?: any;
  created_by?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface ManpowerBreakdown {
  id?: number;
  initiative_id: number;
  avg_monthly_salary: number;
  gosi_percentage: number;
  insurance_cost_monthly: number;
  laptop_equipment_cost_monthly: number;
  software_seat_cost_monthly: number;
  hours_wasted_per_week: number;
  employees_impacted: number;
  fully_loaded_salary?: number;
  cost_per_hour?: number;
  monthly_time_loss_cost?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface PlatformCost {
  id?: number;
  initiative_id: number;
  tool_name: string;
  cost_per_month: number;
  seats_impacted: number;
  to_be_removed: boolean;
  vendor_support_cost: number;
  created_at?: Date;
}

export interface ErrorCosts {
  id?: number;
  initiative_id: number;
  current_error_rate: number;
  monthly_transactions: number;
  cost_per_error: number;
  rework_hours_per_error: number;
  sla_penalties_monthly: number;
  expected_reduction_percentage: number;
  calculated_error_savings?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface RevenueImpact {
  id?: number;
  initiative_id: number;
  leads_saved: number;
  conversion_rate: number;
  revenue_per_lead: number;
  churn_reduction_percentage: number;
  upsell_opportunities: number;
  calculated_revenue_impact?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface ImplementationBreakdown {
  id?: number;
  initiative_id: number;
  vendor_costs: number;
  setup_fees: number;
  api_license_fees: number;
  developer_hours: number;
  developer_hourly_rate: number;
  qa_hours: number;
  qa_hourly_rate: number;
  product_hours: number;
  product_hourly_rate: number;
  architect_hours: number;
  architect_hourly_rate: number;
  training_cost: number;
  change_management_cost: number;
  monthly_recurring_cost: number;
  calculated_total_implementation?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface RiskInputs {
  id?: number;
  initiative_id: number;
  confidence_level: 'high' | 'medium' | 'low';
  probability_of_success: number;
  dependencies?: string;
  risk_adjustment_factor: number;
  risk_adjusted_npv?: number;
  created_at?: Date;
  updated_at?: Date;
}

export interface AIValidationLog {
  id?: number;
  initiative_id: number;
  validation_type: string;
  field_name: string;
  original_value?: string;
  suggested_value?: string;
  reason?: string;
  confidence_score: number;
  accepted: boolean;
  created_at?: Date;
}

export interface BreakdownData {
  manpower?: ManpowerBreakdown;
  platformCosts?: PlatformCost[];
  errorCosts?: ErrorCosts;
  revenueImpact?: RevenueImpact;
  implementation?: ImplementationBreakdown;
  riskInputs?: RiskInputs;
}

export interface FullInitiativeDetails extends ROIInitiative {
  manpowerBreakdown?: ManpowerBreakdown;
  platformCosts?: PlatformCost[];
  errorCosts?: ErrorCosts;
  revenueImpact?: RevenueImpact;
  implementationBreakdown?: ImplementationBreakdown;
  riskInputs?: RiskInputs;
  aiValidationLogs?: AIValidationLog[];
}

export interface ROICalculationResult {
  roi_percentage: number;
  payback_period_months: number;
  npv: number;
  profitability_index: number;
  total_gains: number;
  total_cost: number;
  monthly_cash_flow: number;
  fully_loaded_salary?: number;
  platform_savings?: number;
  error_savings?: number;
  revenue_impact?: number;
  total_implementation_cost?: number;
  risk_adjusted_npv?: number;
}

export async function initROITables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS roi_initiatives (
      id SERIAL PRIMARY KEY,
      initiative_id VARCHAR(50) UNIQUE NOT NULL,
      project_name VARCHAR(255) NOT NULL,
      owner VARCHAR(255) NOT NULL,
      department VARCHAR(100) NOT NULL,
      description TEXT,
      baseline_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
      expected_savings_monthly DECIMAL(15,2) NOT NULL DEFAULT 0,
      implementation_cost DECIMAL(15,2) NOT NULL DEFAULT 0,
      project_duration_months INTEGER NOT NULL DEFAULT 12,
      discount_rate DECIMAL(5,4) NOT NULL DEFAULT 0.10,
      expected_revenue_increase DECIMAL(15,2) DEFAULT 0,
      avoided_cost DECIMAL(15,2) DEFAULT 0,
      roi_percentage DECIMAL(10,2),
      payback_period_months DECIMAL(10,2),
      npv DECIMAL(15,2),
      profitability_index DECIMAL(10,4),
      ai_recommendation VARCHAR(20),
      ai_insights TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'draft',
      priority VARCHAR(20) DEFAULT 'medium',
      start_date DATE,
      end_date DATE,
      actual_savings DECIMAL(15,2),
      actual_cost DECIMAL(15,2),
      metadata JSONB DEFAULT '{}',
      created_by VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_roi_initiatives_department ON roi_initiatives(department);
    CREATE INDEX IF NOT EXISTS idx_roi_initiatives_status ON roi_initiatives(status);
    CREATE INDEX IF NOT EXISTS idx_roi_initiatives_owner ON roi_initiatives(owner);
    CREATE INDEX IF NOT EXISTS idx_roi_initiatives_recommendation ON roi_initiatives(ai_recommendation);
  `);

  await pool.query(`
    DO $$ 
    BEGIN 
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'roi_initiatives' AND column_name = 'problem_statement'
      ) THEN 
        ALTER TABLE roi_initiatives ADD COLUMN problem_statement TEXT;
      END IF;
    END $$;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roi_manpower_breakdown (
      id SERIAL PRIMARY KEY,
      initiative_id INTEGER REFERENCES roi_initiatives(id) ON DELETE CASCADE,
      avg_monthly_salary DECIMAL(15,2) DEFAULT 0,
      gosi_percentage DECIMAL(5,2) DEFAULT 12,
      insurance_cost_monthly DECIMAL(15,2) DEFAULT 0,
      laptop_equipment_cost_monthly DECIMAL(15,2) DEFAULT 0,
      software_seat_cost_monthly DECIMAL(15,2) DEFAULT 0,
      hours_wasted_per_week DECIMAL(10,2) DEFAULT 0,
      employees_impacted INTEGER DEFAULT 0,
      fully_loaded_salary DECIMAL(15,2),
      cost_per_hour DECIMAL(15,2),
      monthly_time_loss_cost DECIMAL(15,2),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_roi_manpower_initiative ON roi_manpower_breakdown(initiative_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roi_platform_costs (
      id SERIAL PRIMARY KEY,
      initiative_id INTEGER REFERENCES roi_initiatives(id) ON DELETE CASCADE,
      tool_name VARCHAR(255),
      cost_per_month DECIMAL(15,2) DEFAULT 0,
      seats_impacted INTEGER DEFAULT 0,
      to_be_removed BOOLEAN DEFAULT false,
      vendor_support_cost DECIMAL(15,2) DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_roi_platform_initiative ON roi_platform_costs(initiative_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roi_error_costs (
      id SERIAL PRIMARY KEY,
      initiative_id INTEGER REFERENCES roi_initiatives(id) ON DELETE CASCADE,
      current_error_rate DECIMAL(5,2) DEFAULT 0,
      monthly_transactions INTEGER DEFAULT 0,
      cost_per_error DECIMAL(15,2) DEFAULT 0,
      rework_hours_per_error DECIMAL(10,2) DEFAULT 0,
      sla_penalties_monthly DECIMAL(15,2) DEFAULT 0,
      expected_reduction_percentage DECIMAL(5,2) DEFAULT 0,
      calculated_error_savings DECIMAL(15,2),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_roi_error_initiative ON roi_error_costs(initiative_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roi_revenue_impact (
      id SERIAL PRIMARY KEY,
      initiative_id INTEGER REFERENCES roi_initiatives(id) ON DELETE CASCADE,
      leads_saved INTEGER DEFAULT 0,
      conversion_rate DECIMAL(5,2) DEFAULT 0,
      revenue_per_lead DECIMAL(15,2) DEFAULT 0,
      churn_reduction_percentage DECIMAL(5,2) DEFAULT 0,
      upsell_opportunities INTEGER DEFAULT 0,
      calculated_revenue_impact DECIMAL(15,2),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_roi_revenue_initiative ON roi_revenue_impact(initiative_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roi_implementation_breakdown (
      id SERIAL PRIMARY KEY,
      initiative_id INTEGER REFERENCES roi_initiatives(id) ON DELETE CASCADE,
      vendor_costs DECIMAL(15,2) DEFAULT 0,
      setup_fees DECIMAL(15,2) DEFAULT 0,
      api_license_fees DECIMAL(15,2) DEFAULT 0,
      developer_hours INTEGER DEFAULT 0,
      developer_hourly_rate DECIMAL(15,2) DEFAULT 150,
      qa_hours INTEGER DEFAULT 0,
      qa_hourly_rate DECIMAL(15,2) DEFAULT 100,
      product_hours INTEGER DEFAULT 0,
      product_hourly_rate DECIMAL(15,2) DEFAULT 120,
      architect_hours INTEGER DEFAULT 0,
      architect_hourly_rate DECIMAL(15,2) DEFAULT 200,
      training_cost DECIMAL(15,2) DEFAULT 0,
      change_management_cost DECIMAL(15,2) DEFAULT 0,
      monthly_recurring_cost DECIMAL(15,2) DEFAULT 0,
      calculated_total_implementation DECIMAL(15,2),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_roi_implementation_initiative ON roi_implementation_breakdown(initiative_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roi_risk_inputs (
      id SERIAL PRIMARY KEY,
      initiative_id INTEGER REFERENCES roi_initiatives(id) ON DELETE CASCADE,
      confidence_level VARCHAR(20) DEFAULT 'medium',
      probability_of_success DECIMAL(5,2) DEFAULT 70,
      dependencies TEXT,
      risk_adjustment_factor DECIMAL(5,2) DEFAULT 1.0,
      risk_adjusted_npv DECIMAL(15,2),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_roi_risk_initiative ON roi_risk_inputs(initiative_id);
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS roi_ai_validation_logs (
      id SERIAL PRIMARY KEY,
      initiative_id INTEGER REFERENCES roi_initiatives(id) ON DELETE CASCADE,
      validation_type VARCHAR(100),
      field_name VARCHAR(100),
      original_value TEXT,
      suggested_value TEXT,
      reason TEXT,
      confidence_score DECIMAL(5,2),
      accepted BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_roi_ai_validation_initiative ON roi_ai_validation_logs(initiative_id);
  `);
}

function calculateFullyLoadedSalary(manpower: Partial<ManpowerBreakdown>): number {
  const baseSalary = manpower.avg_monthly_salary || 0;
  const gosiCost = baseSalary * ((manpower.gosi_percentage || 12) / 100);
  const insurance = manpower.insurance_cost_monthly || 0;
  const laptop = manpower.laptop_equipment_cost_monthly || 0;
  const software = manpower.software_seat_cost_monthly || 0;
  return baseSalary + gosiCost + insurance + laptop + software;
}

function calculateCostPerHour(fullyLoadedSalary: number): number {
  const workingHoursPerMonth = 176;
  return fullyLoadedSalary / workingHoursPerMonth;
}

function calculateMonthlyTimeLossCost(manpower: Partial<ManpowerBreakdown>, costPerHour: number): number {
  const hoursWastedPerWeek = manpower.hours_wasted_per_week || 0;
  const employees = manpower.employees_impacted || 0;
  const weeksPerMonth = 4.33;
  return hoursWastedPerWeek * employees * weeksPerMonth * costPerHour;
}

function calculatePlatformSavings(platformCosts: PlatformCost[]): number {
  return platformCosts
    .filter(p => p.to_be_removed)
    .reduce((sum, p) => sum + (p.cost_per_month || 0) + (p.vendor_support_cost || 0), 0);
}

function calculateErrorSavings(errorCosts: Partial<ErrorCosts>, costPerHour: number = 100): number {
  const currentErrors = (errorCosts.monthly_transactions || 0) * ((errorCosts.current_error_rate || 0) / 100);
  const directCost = currentErrors * (errorCosts.cost_per_error || 0);
  const reworkCost = currentErrors * (errorCosts.rework_hours_per_error || 0) * costPerHour;
  const slaPenalties = errorCosts.sla_penalties_monthly || 0;
  const totalErrorCost = directCost + reworkCost + slaPenalties;
  const reductionPercent = (errorCosts.expected_reduction_percentage || 0) / 100;
  return totalErrorCost * reductionPercent;
}

function calculateRevenueImpactValue(revenue: Partial<RevenueImpact>): number {
  const leadRevenue = (revenue.leads_saved || 0) * ((revenue.conversion_rate || 0) / 100) * (revenue.revenue_per_lead || 0);
  const upsellRevenue = (revenue.upsell_opportunities || 0) * (revenue.revenue_per_lead || 0) * 0.3;
  return leadRevenue + upsellRevenue;
}

function calculateTotalImplementationCost(impl: Partial<ImplementationBreakdown>): number {
  const vendorTotal = (impl.vendor_costs || 0) + (impl.setup_fees || 0) + (impl.api_license_fees || 0);
  const devCost = (impl.developer_hours || 0) * (impl.developer_hourly_rate || 150);
  const qaCost = (impl.qa_hours || 0) * (impl.qa_hourly_rate || 100);
  const productCost = (impl.product_hours || 0) * (impl.product_hourly_rate || 120);
  const architectCost = (impl.architect_hours || 0) * (impl.architect_hourly_rate || 200);
  const otherCosts = (impl.training_cost || 0) + (impl.change_management_cost || 0);
  return vendorTotal + devCost + qaCost + productCost + architectCost + otherCosts;
}

function calculateRiskAdjustedNPV(npv: number, riskInputs: Partial<RiskInputs>): number {
  const probabilityFactor = (riskInputs.probability_of_success || 70) / 100;
  const adjustmentFactor = riskInputs.risk_adjustment_factor || 1.0;
  return npv * probabilityFactor * adjustmentFactor;
}

export function calculateROI(
  initiative: Partial<ROIInitiative>,
  breakdowns?: BreakdownData
): ROICalculationResult {
  let fullyLoadedSalary: number | undefined;
  let platformSavings: number | undefined;
  let errorSavings: number | undefined;
  let revenueImpact: number | undefined;
  let totalImplementationCost: number | undefined;
  let costPerHour = 100;

  if (breakdowns?.manpower) {
    fullyLoadedSalary = calculateFullyLoadedSalary(breakdowns.manpower);
    costPerHour = calculateCostPerHour(fullyLoadedSalary);
  }

  if (breakdowns?.platformCosts && breakdowns.platformCosts.length > 0) {
    platformSavings = calculatePlatformSavings(breakdowns.platformCosts);
  }

  if (breakdowns?.errorCosts) {
    errorSavings = calculateErrorSavings(breakdowns.errorCosts, costPerHour);
  }

  if (breakdowns?.revenueImpact) {
    revenueImpact = calculateRevenueImpactValue(breakdowns.revenueImpact);
  }

  if (breakdowns?.implementation) {
    totalImplementationCost = calculateTotalImplementationCost(breakdowns.implementation);
  }

  const {
    expected_savings_monthly = 0,
    implementation_cost = 0,
    project_duration_months = 12,
    discount_rate = 0.10,
    expected_revenue_increase = 0,
    avoided_cost = 0
  } = initiative;

  const effectiveImplementationCost = totalImplementationCost ?? implementation_cost;

  let monthlyGains = expected_savings_monthly + (expected_revenue_increase / 12) + (avoided_cost / 12);
  
  if (breakdowns?.manpower) {
    const monthlyTimeLoss = calculateMonthlyTimeLossCost(breakdowns.manpower, costPerHour);
    monthlyGains += monthlyTimeLoss;
  }
  if (platformSavings) {
    monthlyGains += platformSavings;
  }
  if (errorSavings) {
    monthlyGains += errorSavings;
  }
  if (revenueImpact) {
    monthlyGains += revenueImpact / 12;
  }

  const totalGains = monthlyGains * project_duration_months;
  const totalCost = effectiveImplementationCost;

  const roiPercentage = totalCost > 0 
    ? ((totalGains - totalCost) / totalCost) * 100 
    : 0;

  const paybackPeriodMonths = monthlyGains > 0 
    ? effectiveImplementationCost / monthlyGains 
    : 999;

  let npv = -effectiveImplementationCost;
  const monthlyDiscountRate = discount_rate / 12;
  for (let t = 1; t <= project_duration_months; t++) {
    npv += monthlyGains / Math.pow(1 + monthlyDiscountRate, t);
  }

  const profitabilityIndex = effectiveImplementationCost > 0 
    ? (npv + effectiveImplementationCost) / effectiveImplementationCost 
    : 0;

  let riskAdjustedNPV: number | undefined;
  if (breakdowns?.riskInputs) {
    riskAdjustedNPV = calculateRiskAdjustedNPV(npv, breakdowns.riskInputs);
  }

  return {
    roi_percentage: Math.round(roiPercentage * 100) / 100,
    payback_period_months: Math.round(paybackPeriodMonths * 100) / 100,
    npv: Math.round(npv * 100) / 100,
    profitability_index: Math.round(profitabilityIndex * 10000) / 10000,
    total_gains: Math.round(totalGains * 100) / 100,
    total_cost: Math.round(totalCost * 100) / 100,
    monthly_cash_flow: Math.round(monthlyGains * 100) / 100,
    fully_loaded_salary: fullyLoadedSalary ? Math.round(fullyLoadedSalary * 100) / 100 : undefined,
    platform_savings: platformSavings ? Math.round(platformSavings * 100) / 100 : undefined,
    error_savings: errorSavings ? Math.round(errorSavings * 100) / 100 : undefined,
    revenue_impact: revenueImpact ? Math.round(revenueImpact * 100) / 100 : undefined,
    total_implementation_cost: totalImplementationCost ? Math.round(totalImplementationCost * 100) / 100 : undefined,
    risk_adjusted_npv: riskAdjustedNPV ? Math.round(riskAdjustedNPV * 100) / 100 : undefined
  };
}

export function generateAIRecommendation(calc: ROICalculationResult): { recommendation: 'approve' | 'evaluate' | 'reject'; insights: string } {
  const insights: string[] = [];
  let recommendation: 'approve' | 'evaluate' | 'reject' = 'evaluate';

  if (calc.roi_percentage >= 100) {
    insights.push('Excellent ROI - initiative doubles the investment.');
    recommendation = 'approve';
  } else if (calc.roi_percentage >= 50) {
    insights.push('Strong ROI exceeds 50% threshold.');
    recommendation = 'approve';
  } else if (calc.roi_percentage >= 20) {
    insights.push('Moderate ROI between 20-50% - worth evaluation.');
    recommendation = 'evaluate';
  } else if (calc.roi_percentage > 0) {
    insights.push('Low ROI below 20% - evaluate strategic value.');
    recommendation = 'evaluate';
  } else {
    insights.push('Negative ROI - costs exceed expected gains.');
    recommendation = 'reject';
  }

  if (calc.payback_period_months <= 6) {
    insights.push('Quick payback under 6 months - strong candidate.');
  } else if (calc.payback_period_months <= 12) {
    insights.push('Payback within 12 months - acceptable timeframe.');
  } else if (calc.payback_period_months <= 24) {
    insights.push('Extended payback period of 1-2 years - consider strategic value.');
  } else {
    insights.push('Long payback exceeds 2 years - high risk.');
    if (recommendation === 'approve') recommendation = 'evaluate';
  }

  if (calc.npv > 0) {
    insights.push(`Positive NPV of SAR ${calc.npv.toLocaleString()} - financially attractive.`);
  } else {
    insights.push('Negative NPV - not recommended from purely financial perspective.');
    recommendation = 'reject';
  }

  if (calc.profitability_index > 1.5) {
    insights.push('High profitability index indicates efficient capital use.');
  } else if (calc.profitability_index > 1) {
    insights.push('Profitability index above 1 - creates value.');
  } else {
    insights.push('Profitability index below 1 - destroys value.');
  }

  if (calc.risk_adjusted_npv !== undefined) {
    if (calc.risk_adjusted_npv > 0) {
      insights.push(`Risk-adjusted NPV of SAR ${calc.risk_adjusted_npv.toLocaleString()} remains positive.`);
    } else {
      insights.push('Risk-adjusted NPV is negative - higher risk profile.');
      if (recommendation === 'approve') recommendation = 'evaluate';
    }
  }

  return { recommendation, insights: insights.join(' ') };
}

export async function createROIInitiative(initiative: Partial<ROIInitiative>): Promise<ROIInitiative> {
  const initiativeId = `ROI-${Date.now().toString(36).toUpperCase()}`;
  
  const calc = calculateROI(initiative);
  const { recommendation, insights } = generateAIRecommendation(calc);

  const result = await pool.query(
    `INSERT INTO roi_initiatives 
     (initiative_id, project_name, owner, department, description, problem_statement, baseline_cost, 
      expected_savings_monthly, implementation_cost, project_duration_months, discount_rate,
      expected_revenue_increase, avoided_cost, roi_percentage, payback_period_months, 
      npv, profitability_index, ai_recommendation, ai_insights, status, priority, 
      start_date, end_date, created_by, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
     RETURNING *`,
    [
      initiativeId, initiative.project_name, initiative.owner, initiative.department,
      initiative.description, initiative.problem_statement, initiative.baseline_cost || 0, 
      initiative.expected_savings_monthly || 0, initiative.implementation_cost || 0, 
      initiative.project_duration_months || 12, initiative.discount_rate || 0.10, 
      initiative.expected_revenue_increase || 0, initiative.avoided_cost || 0, 
      calc.roi_percentage, calc.payback_period_months, calc.npv, calc.profitability_index, 
      recommendation, insights, initiative.status || 'draft', initiative.priority || 'medium',
      initiative.start_date, initiative.end_date, initiative.created_by,
      JSON.stringify(initiative.metadata || {})
    ]
  );
  return result.rows[0];
}

export async function updateROIInitiative(id: number, updates: Partial<ROIInitiative>): Promise<ROIInitiative | null> {
  const current = await getROIInitiativeById(id);
  if (!current) return null;

  const merged = { ...current, ...updates };
  const calc = calculateROI(merged);
  const { recommendation, insights } = generateAIRecommendation(calc);

  const result = await pool.query(
    `UPDATE roi_initiatives SET
     project_name = $1, owner = $2, department = $3, description = $4, problem_statement = $5,
     baseline_cost = $6, expected_savings_monthly = $7, implementation_cost = $8,
     project_duration_months = $9, discount_rate = $10, expected_revenue_increase = $11,
     avoided_cost = $12, roi_percentage = $13, payback_period_months = $14,
     npv = $15, profitability_index = $16, ai_recommendation = $17, ai_insights = $18,
     status = $19, priority = $20, start_date = $21, end_date = $22,
     actual_savings = $23, actual_cost = $24, metadata = $25, updated_at = NOW()
     WHERE id = $26 RETURNING *`,
    [
      merged.project_name, merged.owner, merged.department, merged.description, merged.problem_statement,
      merged.baseline_cost, merged.expected_savings_monthly, merged.implementation_cost,
      merged.project_duration_months, merged.discount_rate, merged.expected_revenue_increase,
      merged.avoided_cost, calc.roi_percentage, calc.payback_period_months,
      calc.npv, calc.profitability_index, recommendation, insights,
      merged.status, merged.priority, merged.start_date, merged.end_date,
      merged.actual_savings, merged.actual_cost, JSON.stringify(merged.metadata || {}), id
    ]
  );
  return result.rows[0] || null;
}

export async function getROIInitiativeById(id: number): Promise<ROIInitiative | null> {
  const result = await pool.query('SELECT * FROM roi_initiatives WHERE id = $1', [id]);
  return result.rows[0] || null;
}

export async function getROIInitiativeByInitiativeId(initiativeId: string): Promise<ROIInitiative | null> {
  const result = await pool.query('SELECT * FROM roi_initiatives WHERE initiative_id = $1', [initiativeId]);
  return result.rows[0] || null;
}

export async function listROIInitiatives(options: {
  department?: string;
  owner?: string;
  status?: string;
  recommendation?: string;
  sortBy?: 'roi' | 'npv' | 'payback' | 'created';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
} = {}): Promise<{ initiatives: ROIInitiative[]; total: number }> {
  let whereClause = 'WHERE 1=1';
  const params: any[] = [];
  let paramIndex = 1;

  if (options.department) {
    whereClause += ` AND department = $${paramIndex}`;
    params.push(options.department);
    paramIndex++;
  }

  if (options.owner) {
    whereClause += ` AND owner = $${paramIndex}`;
    params.push(options.owner);
    paramIndex++;
  }

  if (options.status) {
    whereClause += ` AND status = $${paramIndex}`;
    params.push(options.status);
    paramIndex++;
  }

  if (options.recommendation) {
    whereClause += ` AND ai_recommendation = $${paramIndex}`;
    params.push(options.recommendation);
    paramIndex++;
  }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM roi_initiatives ${whereClause}`,
    params
  );

  let orderBy = 'created_at DESC';
  switch (options.sortBy) {
    case 'roi': orderBy = `roi_percentage ${options.sortOrder === 'asc' ? 'ASC' : 'DESC'}`; break;
    case 'npv': orderBy = `npv ${options.sortOrder === 'asc' ? 'ASC' : 'DESC'}`; break;
    case 'payback': orderBy = `payback_period_months ${options.sortOrder === 'asc' ? 'ASC' : 'DESC'}`; break;
    case 'created': orderBy = `created_at ${options.sortOrder === 'asc' ? 'ASC' : 'DESC'}`; break;
  }

  const result = await pool.query(
    `SELECT * FROM roi_initiatives ${whereClause} 
     ORDER BY ${orderBy}
     LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    [...params, options.limit || 50, options.offset || 0]
  );

  return {
    initiatives: result.rows,
    total: parseInt(countResult.rows[0].count)
  };
}

export async function getROIAnalytics(): Promise<{
  totalInitiatives: number;
  byRecommendation: { approve: number; evaluate: number; reject: number };
  byDepartment: Array<{ department: string; count: number; avg_roi: number; total_npv: number }>;
  avgROI: number;
  totalNPV: number;
  avgPayback: number;
  topInitiatives: ROIInitiative[];
}> {
  const [totalResult, recResult, deptResult, avgResult, topResult] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM roi_initiatives'),
    pool.query(`
      SELECT ai_recommendation, COUNT(*) as count 
      FROM roi_initiatives 
      WHERE ai_recommendation IS NOT NULL 
      GROUP BY ai_recommendation
    `),
    pool.query(`
      SELECT department, COUNT(*) as count, 
             AVG(roi_percentage) as avg_roi, 
             SUM(npv) as total_npv
      FROM roi_initiatives 
      GROUP BY department 
      ORDER BY total_npv DESC
    `),
    pool.query(`
      SELECT AVG(roi_percentage) as avg_roi, 
             SUM(npv) as total_npv, 
             AVG(payback_period_months) as avg_payback
      FROM roi_initiatives
    `),
    pool.query(`
      SELECT * FROM roi_initiatives 
      WHERE ai_recommendation = 'approve' 
      ORDER BY npv DESC 
      LIMIT 5
    `)
  ]);

  const byRecommendation = { approve: 0, evaluate: 0, reject: 0 };
  for (const row of recResult.rows) {
    if (row.ai_recommendation in byRecommendation) {
      byRecommendation[row.ai_recommendation as keyof typeof byRecommendation] = parseInt(row.count);
    }
  }

  return {
    totalInitiatives: parseInt(totalResult.rows[0].count),
    byRecommendation,
    byDepartment: deptResult.rows.map(r => ({
      department: r.department,
      count: parseInt(r.count),
      avg_roi: parseFloat(r.avg_roi) || 0,
      total_npv: parseFloat(r.total_npv) || 0
    })),
    avgROI: parseFloat(avgResult.rows[0].avg_roi) || 0,
    totalNPV: parseFloat(avgResult.rows[0].total_npv) || 0,
    avgPayback: parseFloat(avgResult.rows[0].avg_payback) || 0,
    topInitiatives: topResult.rows
  };
}

export async function deleteROIInitiative(id: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM roi_initiatives WHERE id = $1', [id]);
  return (result.rowCount || 0) > 0;
}

export async function createManpowerBreakdown(<REDACTED_SCHEME> Partial<ManpowerBreakdown>): Promise<ManpowerBreakdown> {
  const fullyLoaded = calculateFullyLoadedSalary(data);
  const costPerHour = calculateCostPerHour(fullyLoaded);
  const monthlyLoss = calculateMonthlyTimeLossCost(data, costPerHour);

  const result = await pool.query(
    `INSERT INTO roi_manpower_breakdown 
     (initiative_id, avg_monthly_salary, gosi_percentage, insurance_cost_monthly, 
      laptop_equipment_cost_monthly, software_seat_cost_monthly, hours_wasted_per_week,
      employees_impacted, fully_loaded_salary, cost_per_hour, monthly_time_loss_cost)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      data.initiative_id, data.avg_monthly_salary || 0, data.gosi_percentage || 12,
      data.insurance_cost_monthly || 0, data.laptop_equipment_cost_monthly || 0,
      data.software_seat_cost_monthly || 0, data.hours_wasted_per_week || 0,
      data.employees_impacted || 0, fullyLoaded, costPerHour, monthlyLoss
    ]
  );
  return result.rows[0];
}

export async function getManpowerBreakdown(initiativeId: number): Promise<ManpowerBreakdown | null> {
  const result = await pool.query(
    'SELECT * FROM roi_manpower_breakdown WHERE initiative_id = $1',
    [initiativeId]
  );
  return result.rows[0] || null;
}

export async function updateManpowerBreakdown(initiativeId: number, <REDACTED_SCHEME> Partial<ManpowerBreakdown>): Promise<ManpowerBreakdown | null> {
  const current = await getManpowerBreakdown(initiativeId);
  if (!current) return null;

  const merged = { ...current, ...data };
  const fullyLoaded = calculateFullyLoadedSalary(merged);
  const costPerHour = calculateCostPerHour(fullyLoaded);
  const monthlyLoss = calculateMonthlyTimeLossCost(merged, costPerHour);

  const result = await pool.query(
    `UPDATE roi_manpower_breakdown SET
     avg_monthly_salary = $1, gosi_percentage = $2, insurance_cost_monthly = $3,
     laptop_equipment_cost_monthly = $4, software_seat_cost_monthly = $5,
     hours_wasted_per_week = $6, employees_impacted = $7, fully_loaded_salary = $8,
     cost_per_hour = $9, monthly_time_loss_cost = $10, updated_at = NOW()
     WHERE initiative_id = $11 RETURNING *`,
    [
      merged.avg_monthly_salary, merged.gosi_percentage, merged.insurance_cost_monthly,
      merged.laptop_equipment_cost_monthly, merged.software_seat_cost_monthly,
      merged.hours_wasted_per_week, merged.employees_impacted, fullyLoaded,
      costPerHour, monthlyLoss, initiativeId
    ]
  );
  return result.rows[0] || null;
}

export async function createPlatformCost(<REDACTED_SCHEME> Partial<PlatformCost>): Promise<PlatformCost> {
  const result = await pool.query(
    `INSERT INTO roi_platform_costs 
     (initiative_id, tool_name, cost_per_month, seats_impacted, to_be_removed, vendor_support_cost)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      data.initiative_id, data.tool_name, data.cost_per_month || 0,
      data.seats_impacted || 0, data.to_be_removed || false, data.vendor_support_cost || 0
    ]
  );
  return result.rows[0];
}

export async function listPlatformCosts(initiativeId: number): Promise<PlatformCost[]> {
  const result = await pool.query(
    'SELECT * FROM roi_platform_costs WHERE initiative_id = $1 ORDER BY created_at',
    [initiativeId]
  );
  return result.rows;
}

export async function deletePlatformCost(id: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM roi_platform_costs WHERE id = $1', [id]);
  return (result.rowCount || 0) > 0;
}

export async function createErrorCosts(<REDACTED_SCHEME> Partial<ErrorCosts>): Promise<ErrorCosts> {
  const savings = calculateErrorSavings(data);

  const result = await pool.query(
    `INSERT INTO roi_error_costs 
     (initiative_id, current_error_rate, monthly_transactions, cost_per_error,
      rework_hours_per_error, sla_penalties_monthly, expected_reduction_percentage, calculated_error_savings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.initiative_id, data.current_error_rate || 0, data.monthly_transactions || 0,
      data.cost_per_error || 0, data.rework_hours_per_error || 0, data.sla_penalties_monthly || 0,
      data.expected_reduction_percentage || 0, savings
    ]
  );
  return result.rows[0];
}

export async function getErrorCosts(initiativeId: number): Promise<ErrorCosts | null> {
  const result = await pool.query(
    'SELECT * FROM roi_error_costs WHERE initiative_id = $1',
    [initiativeId]
  );
  return result.rows[0] || null;
}

export async function updateErrorCosts(initiativeId: number, <REDACTED_SCHEME> Partial<ErrorCosts>): Promise<ErrorCosts | null> {
  const current = await getErrorCosts(initiativeId);
  if (!current) return null;

  const merged = { ...current, ...data };
  const savings = calculateErrorSavings(merged);

  const result = await pool.query(
    `UPDATE roi_error_costs SET
     current_error_rate = $1, monthly_transactions = $2, cost_per_error = $3,
     rework_hours_per_error = $4, sla_penalties_monthly = $5, expected_reduction_percentage = $6,
     calculated_error_savings = $7, updated_at = NOW()
     WHERE initiative_id = $8 RETURNING *`,
    [
      merged.current_error_rate, merged.monthly_transactions, merged.cost_per_error,
      merged.rework_hours_per_error, merged.sla_penalties_monthly, merged.expected_reduction_percentage,
      savings, initiativeId
    ]
  );
  return result.rows[0] || null;
}

export async function createRevenueImpact(<REDACTED_SCHEME> Partial<RevenueImpact>): Promise<RevenueImpact> {
  const impact = calculateRevenueImpactValue(data);

  const result = await pool.query(
    `INSERT INTO roi_revenue_impact 
     (initiative_id, leads_saved, conversion_rate, revenue_per_lead,
      churn_reduction_percentage, upsell_opportunities, calculated_revenue_impact)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      data.initiative_id, data.leads_saved || 0, data.conversion_rate || 0,
      data.revenue_per_lead || 0, data.churn_reduction_percentage || 0,
      data.upsell_opportunities || 0, impact
    ]
  );
  return result.rows[0];
}

export async function getRevenueImpact(initiativeId: number): Promise<RevenueImpact | null> {
  const result = await pool.query(
    'SELECT * FROM roi_revenue_impact WHERE initiative_id = $1',
    [initiativeId]
  );
  return result.rows[0] || null;
}

export async function updateRevenueImpact(initiativeId: number, <REDACTED_SCHEME> Partial<RevenueImpact>): Promise<RevenueImpact | null> {
  const current = await getRevenueImpact(initiativeId);
  if (!current) return null;

  const merged = { ...current, ...data };
  const impact = calculateRevenueImpactValue(merged);

  const result = await pool.query(
    `UPDATE roi_revenue_impact SET
     leads_saved = $1, conversion_rate = $2, revenue_per_lead = $3,
     churn_reduction_percentage = $4, upsell_opportunities = $5,
     calculated_revenue_impact = $6, updated_at = NOW()
     WHERE initiative_id = $7 RETURNING *`,
    [
      merged.leads_saved, merged.conversion_rate, merged.revenue_per_lead,
      merged.churn_reduction_percentage, merged.upsell_opportunities,
      impact, initiativeId
    ]
  );
  return result.rows[0] || null;
}

export async function createImplementationBreakdown(<REDACTED_SCHEME> Partial<ImplementationBreakdown>): Promise<ImplementationBreakdown> {
  const total = calculateTotalImplementationCost(data);

  const result = await pool.query(
    `INSERT INTO roi_implementation_breakdown 
     (initiative_id, vendor_costs, setup_fees, api_license_fees, developer_hours,
      developer_hourly_rate, qa_hours, qa_hourly_rate, product_hours, product_hourly_rate,
      architect_hours, architect_hourly_rate, training_cost, change_management_cost,
      monthly_recurring_cost, calculated_total_implementation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     RETURNING *`,
    [
      data.initiative_id, data.vendor_costs || 0, data.setup_fees || 0,
      data.api_license_fees || 0, data.developer_hours || 0, data.developer_hourly_rate || 150,
      data.qa_hours || 0, data.qa_hourly_rate || 100, data.product_hours || 0,
      data.product_hourly_rate || 120, data.architect_hours || 0, data.architect_hourly_rate || 200,
      data.training_cost || 0, data.change_management_cost || 0, data.monthly_recurring_cost || 0, total
    ]
  );
  return result.rows[0];
}

export async function getImplementationBreakdown(initiativeId: number): Promise<ImplementationBreakdown | null> {
  const result = await pool.query(
    'SELECT * FROM roi_implementation_breakdown WHERE initiative_id = $1',
    [initiativeId]
  );
  return result.rows[0] || null;
}

export async function updateImplementationBreakdown(initiativeId: number, <REDACTED_SCHEME> Partial<ImplementationBreakdown>): Promise<ImplementationBreakdown | null> {
  const current = await getImplementationBreakdown(initiativeId);
  if (!current) return null;

  const merged = { ...current, ...data };
  const total = calculateTotalImplementationCost(merged);

  const result = await pool.query(
    `UPDATE roi_implementation_breakdown SET
     vendor_costs = $1, setup_fees = $2, api_license_fees = $3, developer_hours = $4,
     developer_hourly_rate = $5, qa_hours = $6, qa_hourly_rate = $7, product_hours = $8,
     product_hourly_rate = $9, architect_hours = $10, architect_hourly_rate = $11,
     training_cost = $12, change_management_cost = $13, monthly_recurring_cost = $14,
     calculated_total_implementation = $15, updated_at = NOW()
     WHERE initiative_id = $16 RETURNING *`,
    [
      merged.vendor_costs, merged.setup_fees, merged.api_license_fees, merged.developer_hours,
      merged.developer_hourly_rate, merged.qa_hours, merged.qa_hourly_rate, merged.product_hours,
      merged.product_hourly_rate, merged.architect_hours, merged.architect_hourly_rate,
      merged.training_cost, merged.change_management_cost, merged.monthly_recurring_cost,
      total, initiativeId
    ]
  );
  return result.rows[0] || null;
}

export async function createRiskInputs(<REDACTED_SCHEME> Partial<RiskInputs>): Promise<RiskInputs> {
  const result = await pool.query(
    `INSERT INTO roi_risk_inputs 
     (initiative_id, confidence_level, probability_of_success, dependencies, risk_adjustment_factor)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [
      data.initiative_id, data.confidence_level || 'medium',
      data.probability_of_success || 70, data.dependencies,
      data.risk_adjustment_factor || 1.0
    ]
  );
  return result.rows[0];
}

export async function getRiskInputs(initiativeId: number): Promise<RiskInputs | null> {
  const result = await pool.query(
    'SELECT * FROM roi_risk_inputs WHERE initiative_id = $1',
    [initiativeId]
  );
  return result.rows[0] || null;
}

export async function updateRiskInputs(initiativeId: number, <REDACTED_SCHEME> Partial<RiskInputs>, npv?: number): Promise<RiskInputs | null> {
  const current = await getRiskInputs(initiativeId);
  if (!current) return null;

  const merged = { ...current, ...data };
  let riskAdjustedNPV: number | null = null;
  if (npv !== undefined) {
    riskAdjustedNPV = calculateRiskAdjustedNPV(npv, merged);
  }

  const result = await pool.query(
    `UPDATE roi_risk_inputs SET
     confidence_level = $1, probability_of_success = $2, dependencies = $3,
     risk_adjustment_factor = $4, risk_adjusted_npv = $5, updated_at = NOW()
     WHERE initiative_id = $6 RETURNING *`,
    [
      merged.confidence_level, merged.probability_of_success, merged.dependencies,
      merged.risk_adjustment_factor, riskAdjustedNPV, initiativeId
    ]
  );
  return result.rows[0] || null;
}

export async function createAIValidationLog(<REDACTED_SCHEME> Partial<AIValidationLog>): Promise<AIValidationLog> {
  const result = await pool.query(
    `INSERT INTO roi_ai_validation_logs 
     (initiative_id, validation_type, field_name, original_value, suggested_value,
      reason, confidence_score, accepted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      data.initiative_id, data.validation_type, data.field_name,
      data.original_value, data.suggested_value, data.reason,
      data.confidence_score || 0, data.accepted || false
    ]
  );
  return result.rows[0];
}

export async function listAIValidationLogs(initiativeId: number): Promise<AIValidationLog[]> {
  const result = await pool.query(
    'SELECT * FROM roi_ai_validation_logs WHERE initiative_id = $1 ORDER BY created_at DESC',
    [initiativeId]
  );
  return result.rows;
}

export async function getFullInitiativeDetails(initiativeId: number): Promise<FullInitiativeDetails | null> {
  const initiative = await getROIInitiativeById(initiativeId);
  if (!initiative) return null;

  const [manpower, platformCosts, errorCosts, revenueImpact, implementation, riskInputs, aiLogs] = await Promise.all([
    getManpowerBreakdown(initiativeId),
    listPlatformCosts(initiativeId),
    getErrorCosts(initiativeId),
    getRevenueImpact(initiativeId),
    getImplementationBreakdown(initiativeId),
    getRiskInputs(initiativeId),
    listAIValidationLogs(initiativeId)
  ]);

  return {
    ...initiative,
    manpowerBreakdown: manpower || undefined,
    platformCosts: platformCosts.length > 0 ? platformCosts : undefined,
    errorCosts: errorCosts || undefined,
    revenueImpact: revenueImpact || undefined,
    implementationBreakdown: implementation || undefined,
    riskInputs: riskInputs || undefined,
    aiValidationLogs: aiLogs.length > 0 ? aiLogs : undefined
  };
}
