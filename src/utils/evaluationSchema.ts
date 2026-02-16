export interface EvaluationCriteria {
  id: string;
  name: string;
  description: string;
  category: 'iso9001' | 'copc' | 'sixsigma' | 'custom';
  dimension: 'people' | 'process' | 'governance' | 'customer' | 'quality';
  weight: number;
  targetScore: number;
  evaluationType: 'boolean' | 'scale' | 'percentage' | 'count';
  thresholds: {
    excellent: number;
    good: number;
    acceptable: number;
    needsImprovement: number;
  };
  fieldMappings?: string[];
  isActive: boolean;
}

export interface EvaluationDimension {
  id: string;
  name: string;
  description: string;
  weight: number;
  criteria: EvaluationCriteria[];
}

export interface EvaluationFramework {
  id: string;
  name: string;
  version: string;
  description: string;
  standards: string[];
  dimensions: EvaluationDimension[];
  createdAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

export interface DealEvaluationResult {
  dealId: string;
  dealName: string;
  evaluationDate: Date;
  frameworkId: string;
  scores: {
    overall: number;
    byDimension: Record<string, number>;
    byCriteria: Record<string, {
      score: number;
      status: 'excellent' | 'good' | 'acceptable' | 'needs_improvement' | 'critical';
      notes?: string;
    }>;
  };
  findings: EvaluationFinding[];
  recommendations: string[];
  dealData: Record<string, any>;
}

export interface EvaluationFinding {
  criteriaId: string;
  criteriaName: string;
  dimension: string;
  severity: 'critical' | 'major' | 'minor' | 'observation';
  description: string;
  evidence?: string;
  recommendation?: string;
  capaRequired: boolean;
}

export const ISO_9001_CRITERIA: EvaluationCriteria[] = [
  {
    id: 'iso-customer-focus',
    name: 'Customer Focus',
    description: 'Evaluate customer requirements understanding and satisfaction measures',
    category: 'iso9001',
    dimension: 'customer',
    weight: 15,
    targetScore: 95,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 85, acceptable: 75, needsImprovement: 60 },
    fieldMappings: ['Contact_Name', 'Account_Name', 'Customer_Requirements'],
    isActive: true
  },
  {
    id: 'iso-leadership-commitment',
    name: 'Leadership Commitment',
    description: 'Management engagement and resource allocation for deals',
    category: 'iso9001',
    dimension: 'people',
    weight: 10,
    targetScore: 90,
    evaluationType: 'boolean',
    thresholds: { excellent: 100, good: 80, acceptable: 60, needsImprovement: 40 },
    fieldMappings: ['Owner', 'Manager_Approval', 'Stakeholder_Alignment'],
    isActive: true
  },
  {
    id: 'iso-process-approach',
    name: 'Process Approach',
    description: 'Deal follows defined sales process and stage gates',
    category: 'iso9001',
    dimension: 'process',
    weight: 15,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 85, acceptable: 70, needsImprovement: 50 },
    fieldMappings: ['Stage', 'Pipeline', 'Deal_Stage', 'Stage_History'],
    isActive: true
  },
  {
    id: 'iso-evidence-based-decisions',
    name: 'Evidence-Based Decision Making',
    description: 'Decisions supported by data and documentation',
    category: 'iso9001',
    dimension: 'governance',
    weight: 12,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 85, acceptable: 70, needsImprovement: 55 },
    fieldMappings: ['Notes', 'Attachments', 'Meeting_Notes', 'Documents'],
    isActive: true
  },
  {
    id: 'iso-continual-improvement',
    name: 'Continual Improvement',
    description: 'Evidence of lessons learned and process improvements',
    category: 'iso9001',
    dimension: 'quality',
    weight: 10,
    targetScore: 85,
    evaluationType: 'percentage',
    thresholds: { excellent: 90, good: 80, acceptable: 65, needsImprovement: 50 },
    fieldMappings: ['Lessons_Learned', 'Improvement_Notes'],
    isActive: true
  },
  {
    id: 'iso-risk-management',
    name: 'Risk-Based Thinking',
    description: 'Risks identified and mitigation plans in place',
    category: 'iso9001',
    dimension: 'governance',
    weight: 12,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 85, acceptable: 70, needsImprovement: 55 },
    fieldMappings: ['Risk_Level', 'Risk_Mitigation', 'Probability'],
    isActive: true
  },
  {
    id: 'iso-documentation-control',
    name: 'Documentation Control',
    description: 'All required documents attached and version controlled',
    category: 'iso9001',
    dimension: 'governance',
    weight: 10,
    targetScore: 95,
    evaluationType: 'percentage',
    thresholds: { excellent: 100, good: 90, acceptable: 80, needsImprovement: 60 },
    fieldMappings: ['Attachments', 'Proposal_Document', 'Contract'],
    isActive: true
  }
];

export const COPC_CRITERIA: EvaluationCriteria[] = [
  {
    id: 'copc-first-contact-resolution',
    name: 'First Contact Resolution',
    description: 'Customer inquiry resolved on first contact',
    category: 'copc',
    dimension: 'customer',
    weight: 15,
    targetScore: 85,
    evaluationType: 'percentage',
    thresholds: { excellent: 90, good: 80, acceptable: 70, needsImprovement: 55 },
    fieldMappings: ['First_Contact_Resolution', 'Resolution_Type'],
    isActive: true
  },
  {
    id: 'copc-response-time',
    name: 'Response Time SLA',
    description: 'Response provided within SLA timeframe',
    category: 'copc',
    dimension: 'process',
    weight: 15,
    targetScore: 95,
    evaluationType: 'percentage',
    thresholds: { excellent: 98, good: 95, acceptable: 90, needsImprovement: 80 },
    fieldMappings: ['Response_Time', 'SLA_Status', 'First_Response_Date', 'Created_Time'],
    isActive: true
  },
  {
    id: 'copc-customer-satisfaction',
    name: 'Customer Satisfaction Score',
    description: 'Customer satisfaction rating meets target',
    category: 'copc',
    dimension: 'customer',
    weight: 18,
    targetScore: 90,
    evaluationType: 'scale',
    thresholds: { excellent: 95, good: 85, acceptable: 75, needsImprovement: 60 },
    fieldMappings: ['CSAT_Score', 'Customer_Feedback', 'NPS'],
    isActive: true
  },
  {
    id: 'copc-quality-monitoring',
    name: 'Quality Monitoring Compliance',
    description: 'Interactions follow quality standards',
    category: 'copc',
    dimension: 'quality',
    weight: 12,
    targetScore: 92,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 90, acceptable: 85, needsImprovement: 75 },
    fieldMappings: ['Quality_Score', 'Compliance_Status'],
    isActive: true
  },
  {
    id: 'copc-escalation-handling',
    name: 'Escalation Handling',
    description: 'Escalations handled within defined process and timeframes',
    category: 'copc',
    dimension: 'process',
    weight: 10,
    targetScore: 95,
    evaluationType: 'percentage',
    thresholds: { excellent: 98, good: 92, acceptable: 85, needsImprovement: 70 },
    fieldMappings: ['Escalation_Status', 'Escalation_Date', 'Escalation_Resolution'],
    isActive: true
  },
  {
    id: 'copc-agent-utilization',
    name: 'Agent Utilization',
    description: 'Optimal resource allocation and workload distribution',
    category: 'copc',
    dimension: 'people',
    weight: 8,
    targetScore: 85,
    evaluationType: 'percentage',
    thresholds: { excellent: 90, good: 82, acceptable: 75, needsImprovement: 65 },
    fieldMappings: ['Owner', 'Assigned_To', 'Workload'],
    isActive: true
  },
  {
    id: 'copc-handle-time',
    name: 'Average Handle Time',
    description: 'Handle time within target range',
    category: 'copc',
    dimension: 'process',
    weight: 8,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 88, acceptable: 80, needsImprovement: 70 },
    fieldMappings: ['Handle_Time', 'Duration', 'Time_Spent'],
    isActive: true
  }
];

export const SIX_SIGMA_CRITERIA: EvaluationCriteria[] = [
  {
    id: 'ss-define-phase',
    name: 'Define Phase Compliance',
    description: 'Problem/opportunity clearly defined with measurable goals',
    category: 'sixsigma',
    dimension: 'process',
    weight: 10,
    targetScore: 95,
    evaluationType: 'percentage',
    thresholds: { excellent: 98, good: 90, acceptable: 80, needsImprovement: 65 },
    fieldMappings: ['Description', 'Deal_Name', 'Objective', 'Goals'],
    isActive: true
  },
  {
    id: 'ss-measure-phase',
    name: 'Measure Phase Compliance',
    description: 'Metrics and KPIs defined and tracked',
    category: 'sixsigma',
    dimension: 'quality',
    weight: 12,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 85, acceptable: 75, needsImprovement: 60 },
    fieldMappings: ['Amount', 'Expected_Revenue', 'Probability', 'Forecast'],
    isActive: true
  },
  {
    id: 'ss-analyze-phase',
    name: 'Analyze Phase Compliance',
    description: 'Root cause analysis and data-driven insights documented',
    category: 'sixsigma',
    dimension: 'quality',
    weight: 12,
    targetScore: 85,
    evaluationType: 'percentage',
    thresholds: { excellent: 90, good: 80, acceptable: 70, needsImprovement: 55 },
    fieldMappings: ['Analysis_Notes', 'Competitor_Analysis', 'Win_Loss_Reason'],
    isActive: true
  },
  {
    id: 'ss-improve-phase',
    name: 'Improve Phase Compliance',
    description: 'Improvement actions documented and implemented',
    category: 'sixsigma',
    dimension: 'process',
    weight: 10,
    targetScore: 85,
    evaluationType: 'percentage',
    thresholds: { excellent: 90, good: 80, acceptable: 70, needsImprovement: 55 },
    fieldMappings: ['Next_Step', 'Action_Items', 'Improvement_Plan'],
    isActive: true
  },
  {
    id: 'ss-control-phase',
    name: 'Control Phase Compliance',
    description: 'Monitoring and control measures in place',
    category: 'sixsigma',
    dimension: 'governance',
    weight: 10,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 85, acceptable: 75, needsImprovement: 60 },
    fieldMappings: ['Stage', 'Closing_Date', 'Follow_Up_Date', 'Next_Activity_Date'],
    isActive: true
  },
  {
    id: 'ss-defect-rate',
    name: 'Defect Rate (DPMO)',
    description: 'Defects per million opportunities tracking',
    category: 'sixsigma',
    dimension: 'quality',
    weight: 15,
    targetScore: 99,
    evaluationType: 'percentage',
    thresholds: { excellent: 99.9, good: 99, acceptable: 95, needsImprovement: 90 },
    fieldMappings: ['Quality_Score', 'Error_Count', 'Defects'],
    isActive: true
  },
  {
    id: 'ss-process-capability',
    name: 'Process Capability',
    description: 'Process meets specification limits consistently',
    category: 'sixsigma',
    dimension: 'process',
    weight: 10,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 88, acceptable: 80, needsImprovement: 70 },
    fieldMappings: ['Stage_Progression', 'Cycle_Time', 'Pipeline_Velocity'],
    isActive: true
  },
  {
    id: 'ss-variation-reduction',
    name: 'Variation Reduction',
    description: 'Consistent process execution with minimal variation',
    category: 'sixsigma',
    dimension: 'quality',
    weight: 8,
    targetScore: 88,
    evaluationType: 'percentage',
    thresholds: { excellent: 92, good: 85, acceptable: 78, needsImprovement: 68 },
    fieldMappings: ['Standard_Deviation', 'Consistency_Score'],
    isActive: true
  }
];

export const WALAPLUS_COMMERCIAL_CRITERIA: EvaluationCriteria[] = [
  {
    id: 'wp-data-completeness',
    name: 'CRM Data Completeness',
    description: 'All mandatory fields populated correctly',
    category: 'custom',
    dimension: 'governance',
    weight: 15,
    targetScore: 98,
    evaluationType: 'percentage',
    thresholds: { excellent: 100, good: 95, acceptable: 85, needsImprovement: 70 },
    fieldMappings: ['Contact_Name', 'Account_Name', 'Amount', 'Stage', 'Owner', 'Closing_Date'],
    isActive: true
  },
  {
    id: 'wp-pipeline-accuracy',
    name: 'Pipeline Accuracy',
    description: 'Deal stage and probability accurately reflect reality',
    category: 'custom',
    dimension: 'process',
    weight: 12,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 88, acceptable: 80, needsImprovement: 65 },
    fieldMappings: ['Stage', 'Probability', 'Expected_Revenue', 'Forecast_Category'],
    isActive: true
  },
  {
    id: 'wp-activity-compliance',
    name: 'Activity Compliance',
    description: 'Regular activities and follow-ups recorded',
    category: 'custom',
    dimension: 'people',
    weight: 12,
    targetScore: 95,
    evaluationType: 'percentage',
    thresholds: { excellent: 98, good: 92, acceptable: 85, needsImprovement: 70 },
    fieldMappings: ['Last_Activity_Time', 'Next_Activity_Date', 'Activities_Count'],
    isActive: true
  },
  {
    id: 'wp-sla-compliance',
    name: 'SLA Compliance',
    description: 'Deal progresses within defined SLA timeframes',
    category: 'custom',
    dimension: 'process',
    weight: 15,
    targetScore: 95,
    evaluationType: 'percentage',
    thresholds: { excellent: 98, good: 93, acceptable: 88, needsImprovement: 75 },
    fieldMappings: ['Created_Time', 'Modified_Time', 'Stage_Duration', 'SLA_Status'],
    isActive: true
  },
  {
    id: 'wp-documentation-attached',
    name: 'Documentation Attached',
    description: 'Proposal, contracts, and supporting documents attached',
    category: 'custom',
    dimension: 'governance',
    weight: 10,
    targetScore: 100,
    evaluationType: 'boolean',
    thresholds: { excellent: 100, good: 80, acceptable: 60, needsImprovement: 40 },
    fieldMappings: ['Attachments', 'Documents', 'Proposal', 'Contract'],
    isActive: true
  },
  {
    id: 'wp-stakeholder-identified',
    name: 'Stakeholders Identified',
    description: 'Key decision makers and influencers identified',
    category: 'custom',
    dimension: 'people',
    weight: 10,
    targetScore: 95,
    evaluationType: 'percentage',
    thresholds: { excellent: 100, good: 90, acceptable: 80, needsImprovement: 60 },
    fieldMappings: ['Contact_Name', 'Decision_Maker', 'Stakeholders'],
    isActive: true
  },
  {
    id: 'wp-revenue-validation',
    name: 'Revenue Validation',
    description: 'Amount and expected revenue properly calculated',
    category: 'custom',
    dimension: 'governance',
    weight: 10,
    targetScore: 100,
    evaluationType: 'percentage',
    thresholds: { excellent: 100, good: 95, acceptable: 85, needsImprovement: 70 },
    fieldMappings: ['Amount', 'Expected_Revenue', 'Probability', 'Currency'],
    isActive: true
  },
  {
    id: 'wp-notes-quality',
    name: 'Notes Quality',
    description: 'Comprehensive and actionable notes maintained',
    category: 'custom',
    dimension: 'people',
    weight: 8,
    targetScore: 90,
    evaluationType: 'percentage',
    thresholds: { excellent: 95, good: 85, acceptable: 75, needsImprovement: 60 },
    fieldMappings: ['Notes', 'Description', 'Comments'],
    isActive: true
  }
];

export const DEFAULT_EVALUATION_FRAMEWORK: EvaluationFramework = {
  id: 'walaplus-qms-v1',
  name: 'WalaPlus Quality Management Framework',
  version: '1.0.0',
  description: 'Comprehensive deal evaluation framework based on ISO 9001, COPC, and Six Sigma standards',
  standards: ['ISO 9001:2015', 'COPC CX Standard', 'Six Sigma DMAIC'],
  dimensions: [
    {
      id: 'customer',
      name: 'Customer Focus',
      description: 'Customer satisfaction and requirement fulfillment',
      weight: 25,
      criteria: [...ISO_9001_CRITERIA.filter(c => c.dimension === 'customer'), ...COPC_CRITERIA.filter(c => c.dimension === 'customer')]
    },
    {
      id: 'process',
      name: 'Process Excellence',
      description: 'Process adherence and operational efficiency',
      weight: 25,
      criteria: [...ISO_9001_CRITERIA.filter(c => c.dimension === 'process'), ...COPC_CRITERIA.filter(c => c.dimension === 'process'), ...SIX_SIGMA_CRITERIA.filter(c => c.dimension === 'process')]
    },
    {
      id: 'people',
      name: 'People & Performance',
      description: 'Team performance and compliance',
      weight: 20,
      criteria: [...ISO_9001_CRITERIA.filter(c => c.dimension === 'people'), ...COPC_CRITERIA.filter(c => c.dimension === 'people'), ...WALAPLUS_COMMERCIAL_CRITERIA.filter(c => c.dimension === 'people')]
    },
    {
      id: 'governance',
      name: 'Governance & Compliance',
      description: 'Documentation and regulatory compliance',
      weight: 15,
      criteria: [...ISO_9001_CRITERIA.filter(c => c.dimension === 'governance'), ...SIX_SIGMA_CRITERIA.filter(c => c.dimension === 'governance'), ...WALAPLUS_COMMERCIAL_CRITERIA.filter(c => c.dimension === 'governance')]
    },
    {
      id: 'quality',
      name: 'Quality & Improvement',
      description: 'Continuous improvement and defect prevention',
      weight: 15,
      criteria: [...ISO_9001_CRITERIA.filter(c => c.dimension === 'quality'), ...COPC_CRITERIA.filter(c => c.dimension === 'quality'), ...SIX_SIGMA_CRITERIA.filter(c => c.dimension === 'quality')]
    }
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
  isActive: true
};

export function evaluateDeal(dealData: Record<string, any>, framework: EvaluationFramework): DealEvaluationResult {
  const findings: EvaluationFinding[] = [];
  const recommendations: string[] = [];
  const criteriaScores: Record<string, { score: number; status: string; notes?: string }> = {};
  const dimensionScores: Record<string, number> = {};

  for (const dimension of framework.dimensions) {
    let dimensionTotal = 0;
    let dimensionMaxPossible = 0;

    for (const criteria of dimension.criteria) {
      if (!criteria.isActive) continue;

      const { score, status, finding } = evaluateCriteria(criteria, dealData);
      criteriaScores[criteria.id] = { score, status };
      
      dimensionTotal += score * criteria.weight;
      dimensionMaxPossible += 100 * criteria.weight;

      if (finding) {
        findings.push(finding);
        if (finding.recommendation) {
          recommendations.push(finding.recommendation);
        }
      }
    }

    dimensionScores[dimension.id] = dimensionMaxPossible > 0 
      ? Math.round((dimensionTotal / dimensionMaxPossible) * 100) 
      : 0;
  }

  let overallScore = 0;
  for (const dimension of framework.dimensions) {
    overallScore += (dimensionScores[dimension.id] || 0) * (dimension.weight / 100);
  }

  return {
    dealId: dealData.id || dealData.Id || 'unknown',
    dealName: dealData.Deal_Name || dealData.name || 'Unnamed Deal',
    evaluationDate: new Date(),
    frameworkId: framework.id,
    scores: {
      overall: Math.round(overallScore),
      byDimension: dimensionScores,
      byCriteria: criteriaScores as any
    },
    findings,
    recommendations: [...new Set(recommendations)],
    dealData
  };
}

function evaluateCriteria(
  criteria: EvaluationCriteria, 
  dealData: Record<string, any>
): { score: number; status: string; finding?: EvaluationFinding } {
  const fieldValues = (criteria.fieldMappings || [])
    .map(field => dealData[field])
    .filter(v => v !== undefined && v !== null && v !== '');

  const populatedRatio = criteria.fieldMappings 
    ? fieldValues.length / criteria.fieldMappings.length 
    : 0;

  let score = 0;
  
  switch (criteria.evaluationType) {
    case 'boolean':
      score = fieldValues.length > 0 ? 100 : 0;
      break;
    case 'percentage':
      score = Math.round(populatedRatio * 100);
      break;
    case 'scale':
      const numericValues = fieldValues.filter(v => typeof v === 'number' || !isNaN(Number(v)));
      if (numericValues.length > 0) {
        const avg = numericValues.reduce((a, b) => Number(a) + Number(b), 0) / numericValues.length;
        score = Math.min(100, Math.round(avg));
      } else {
        score = populatedRatio * 50;
      }
      break;
    case 'count':
      score = Math.min(100, fieldValues.length * 20);
      break;
    default:
      score = Math.round(populatedRatio * 100);
  }

  let status = 'excellent';
  if (score < criteria.thresholds.needsImprovement) {
    status = 'critical';
  } else if (score < criteria.thresholds.acceptable) {
    status = 'needs_improvement';
  } else if (score < criteria.thresholds.good) {
    status = 'acceptable';
  } else if (score < criteria.thresholds.excellent) {
    status = 'good';
  }

  let finding: EvaluationFinding | undefined;
  if (status === 'critical' || status === 'needs_improvement') {
    const severity = status === 'critical' ? 'critical' : 'major';
    finding = {
      criteriaId: criteria.id,
      criteriaName: criteria.name,
      dimension: criteria.dimension,
      severity,
      description: `${criteria.name}: Score ${score}% is below target of ${criteria.targetScore}%`,
      evidence: `Missing or incomplete fields: ${criteria.fieldMappings?.filter(f => !dealData[f]).join(', ') || 'N/A'}`,
      recommendation: generateRecommendation(criteria, score),
      capaRequired: severity === 'critical'
    };
  }

  return { score, status, finding };
}

function generateRecommendation(criteria: EvaluationCriteria, score: number): string {
  const gap = criteria.targetScore - score;
  
  const recommendationTemplates: Record<string, string> = {
    'iso-customer-focus': `Improve customer requirement documentation. Gap: ${gap}%. Action: Review and complete customer requirements fields.`,
    'iso-process-approach': `Ensure deal follows defined stage gates. Gap: ${gap}%. Action: Update stage and pipeline information.`,
    'iso-documentation-control': `Attach all required documents. Gap: ${gap}%. Action: Upload proposal, contract, and supporting materials.`,
    'copc-response-time': `Improve response time SLA compliance. Gap: ${gap}%. Action: Review and optimize response processes.`,
    'copc-customer-satisfaction': `Address customer satisfaction concerns. Gap: ${gap}%. Action: Follow up with customer and document feedback.`,
    'ss-define-phase': `Clearly define deal objectives. Gap: ${gap}%. Action: Update deal description with measurable goals.`,
    'ss-measure-phase': `Establish metrics tracking. Gap: ${gap}%. Action: Define and populate KPI fields.`,
    'wp-data-completeness': `Complete all mandatory CRM fields. Gap: ${gap}%. Action: Fill in missing required fields.`,
    'wp-activity-compliance': `Maintain regular activity updates. Gap: ${gap}%. Action: Log activities and schedule follow-ups.`,
    'wp-sla-compliance': `Address SLA breaches. Gap: ${gap}%. Action: Escalate and expedite deal progression.`
  };

  return recommendationTemplates[criteria.id] || 
    `Improve ${criteria.name}. Current score: ${score}%, Target: ${criteria.targetScore}%. Gap: ${gap}%.`;
}

export function getDefaultFramework(): EvaluationFramework {
  return DEFAULT_EVALUATION_FRAMEWORK;
}

export function getAllCriteria(): EvaluationCriteria[] {
  return [
    ...ISO_9001_CRITERIA,
    ...COPC_CRITERIA,
    ...SIX_SIGMA_CRITERIA,
    ...WALAPLUS_COMMERCIAL_CRITERIA
  ];
}

export function getCriteriaByCategory(category: string): EvaluationCriteria[] {
  return getAllCriteria().filter(c => c.category === category);
}

export function getCriteriaByDimension(dimension: string): EvaluationCriteria[] {
  return getAllCriteria().filter(c => c.dimension === dimension);
}
