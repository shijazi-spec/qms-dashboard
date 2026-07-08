import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { sharedPool as pool } from "../../utils/sharedPool";
import { getCurrentAgentContext } from "../../utils/withApprovalGate";

// This tool queries pdpl_data_inventory, data_incidents, pdpl_ai_guardrails,
// and other sensitive compliance tables. Restrict to the same cohort that
// can reach those modules through the direct REST APIs.
const COMPLIANCE_TOOL_ROLES = new Set([
  "admin",
  "grc_manager",
  "head_of_operations_quality",
  "quality_manager",
]);

interface ComplianceGap {
  area: string;
  requirement: string;
  status: 'met' | 'partial' | 'not_met';
  recommendation: string;
}

async function checkPdplCompliance(): Promise<{ score: number; gaps: ComplianceGap[] }> {
  const gaps: ComplianceGap[] = [];

  const inventoryResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM pdpl_data_inventory`
  );
  const inventoryCount = inventoryResult.rows[0]?.count ?? 0;

  if (inventoryCount === 0) {
    gaps.push({
      area: 'Data Inventory',
      requirement: 'Maintain a comprehensive data processing inventory per PDPL Article 32',
      status: 'not_met',
      recommendation: 'Create and maintain a data processing inventory documenting all personal data activities',
    });
  }

  const incidentResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM data_incidents
     WHERE status NOT IN ($1, $2)`,
    ['resolved', 'closed']
  );
  const openIncidents = incidentResult.rows[0]?.count ?? 0;

  if (openIncidents > 0) {
    gaps.push({
      area: 'Incident Management',
      requirement: 'Resolve data incidents within regulatory timeframes',
      status: 'partial',
      recommendation: `Address ${openIncidents} open data incident(s) and ensure breach notification procedures are in place`,
    });
  }

  const guardrailResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM pdpl_ai_guardrails`
  );
  const guardrailCount = guardrailResult.rows[0]?.count ?? 0;

  if (guardrailCount === 0) {
    gaps.push({
      area: 'AI Guardrails',
      requirement: 'Implement AI data processing guardrails per PDPL requirements',
      status: 'not_met',
      recommendation: 'Define and implement AI guardrails for personal data processing in automated systems',
    });
  }

  let score = 100;
  const totalChecks = 3;
  const failedChecks = gaps.filter(g => g.status === 'not_met').length;
  const partialChecks = gaps.filter(g => g.status === 'partial').length;
  score = Math.max(0, Math.round(100 - (failedChecks / totalChecks) * 60 - (partialChecks / totalChecks) * 25));

  return { score, gaps };
}

async function checkIso9001Compliance(): Promise<{ score: number; gaps: ComplianceGap[] }> {
  const gaps: ComplianceGap[] = [];
  let deductions = 0;

  const openNcResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM nonconformance_records WHERE status = $1`,
    ['open']
  );
  const openNCs = openNcResult.rows[0]?.count ?? 0;

  if (openNCs > 10) {
    gaps.push({
      area: 'Nonconformance Management',
      requirement: 'ISO 9001:2015 Clause 10.2 - Timely resolution of nonconformances',
      status: 'not_met',
      recommendation: `${openNCs} open NCs exceed acceptable threshold. Prioritize closure of critical and major NCs`,
    });
    deductions += 25;
  } else if (openNCs > 5) {
    gaps.push({
      area: 'Nonconformance Management',
      requirement: 'ISO 9001:2015 Clause 10.2 - Timely resolution of nonconformances',
      status: 'partial',
      recommendation: `${openNCs} open NCs require attention. Review and assign resources for resolution`,
    });
    deductions += 10;
  }

  const overdueCapaResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM capa_records
     WHERE target_date < NOW() AND status != $1`,
    ['completed']
  );
  const overdueCAPAs = overdueCapaResult.rows[0]?.count ?? 0;

  if (overdueCAPAs > 0) {
    gaps.push({
      area: 'Corrective Actions',
      requirement: 'ISO 9001:2015 Clause 10.2 - Implement corrective actions within planned timeframes',
      status: overdueCAPAs > 5 ? 'not_met' : 'partial',
      recommendation: `${overdueCAPAs} overdue CAPA(s). Escalate and reassign resources to meet deadlines`,
    });
    deductions += overdueCAPAs > 5 ? 25 : 15;
  }

  const docResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM governance_documents`
  );
  const docCount = docResult.rows[0]?.count ?? 0;

  if (docCount === 0) {
    gaps.push({
      area: 'Document Control',
      requirement: 'ISO 9001:2015 Clause 7.5 - Documented information shall be maintained',
      status: 'not_met',
      recommendation: 'Establish document control system with QMS policies, procedures, and work instructions',
    });
    deductions += 25;
  }

  const auditResult = await pool.query(
    `SELECT overall_score FROM quality_audit_results
     ORDER BY audit_date DESC LIMIT 1`
  );
  const latestScore = auditResult.rows[0]?.overall_score;

  if (latestScore != null && latestScore < 70) {
    gaps.push({
      area: 'Internal Audit',
      requirement: 'ISO 9001:2015 Clause 9.2 - Maintain effective internal audit program',
      status: 'partial',
      recommendation: `Latest audit score is ${latestScore}%. Investigate root causes and implement improvements`,
    });
    deductions += 15;
  }

  return { score: Math.max(0, 100 - deductions), gaps };
}

async function checkIso27001Compliance(): Promise<{ score: number; gaps: ComplianceGap[] }> {
  const gaps: ComplianceGap[] = [];
  let deductions = 0;

  const riskResult = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE risk_level IN ($1, $2))::int AS high_severity
     FROM enterprise_risks
     WHERE status <> 'closed'`,
    ['critical', 'high']
  );
  const totalRisks = riskResult.rows[0]?.total ?? 0;
  const highSeverity = riskResult.rows[0]?.high_severity ?? 0;

  if (highSeverity > 5) {
    gaps.push({
      area: 'Risk Management',
      requirement: 'ISO 27001:2022 Clause 6.1 - Address information security risks',
      status: 'not_met',
      recommendation: `${highSeverity} high/critical unmitigated risks. Implement risk treatment plans immediately`,
    });
    deductions += 30;
  } else if (totalRisks > 10) {
    gaps.push({
      area: 'Risk Management',
      requirement: 'ISO 27001:2022 Clause 6.1 - Address information security risks',
      status: 'partial',
      recommendation: `${totalRisks} open risks. Review and prioritize risk treatment activities`,
    });
    deductions += 15;
  }

  const controlResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM obligations
     WHERE obligation_type = $1`,
    ['security_control']
  );
  const controlCount = controlResult.rows[0]?.count ?? 0;

  if (controlCount === 0) {
    gaps.push({
      area: 'Security Controls',
      requirement: 'ISO 27001:2022 Annex A - Implement applicable security controls',
      status: 'not_met',
      recommendation: 'Define and implement information security controls aligned with Annex A requirements',
    });
    deductions += 25;
  }

  return { score: Math.max(0, 100 - deductions), gaps };
}

async function checkNcaCompliance(): Promise<{ score: number; gaps: ComplianceGap[] }> {
  const gaps: ComplianceGap[] = [];
  let deductions = 0;

  const obligationResult = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = $1)::int AS non_compliant
     FROM obligations
     WHERE framework = $2`,
    ['non_compliant', 'nca']
  );
  const totalObligations = obligationResult.rows[0]?.total ?? 0;
  const nonCompliant = obligationResult.rows[0]?.non_compliant ?? 0;

  if (totalObligations === 0) {
    gaps.push({
      area: 'NCA Obligations',
      requirement: 'NCA ECC Framework - Register and track compliance obligations',
      status: 'not_met',
      recommendation: 'Map NCA Essential Cybersecurity Controls to compliance obligations',
    });
    deductions += 35;
  } else if (nonCompliant > 0) {
    gaps.push({
      area: 'NCA Compliance',
      requirement: 'NCA ECC Framework - Maintain compliance with registered controls',
      status: 'partial',
      recommendation: `${nonCompliant} of ${totalObligations} NCA obligations are non-compliant. Address gaps immediately`,
    });
    deductions += Math.min(30, nonCompliant * 5);
  }

  const securityRiskResult = await pool.query(
    `SELECT COUNT(*)::int AS count FROM enterprise_risks
     WHERE risk_category ILIKE $1 AND risk_level IN ($2, $3) AND status <> 'closed'`,
    ['%security%', 'critical', 'high']
  );
  const securityRisks = securityRiskResult.rows[0]?.count ?? 0;

  if (securityRisks > 0) {
    gaps.push({
      area: 'Cybersecurity Risks',
      requirement: 'NCA ECC - Manage critical cybersecurity risks',
      status: securityRisks > 3 ? 'not_met' : 'partial',
      recommendation: `${securityRisks} high/critical cybersecurity risk(s) open. Implement mitigation plans per NCA guidelines`,
    });
    deductions += securityRisks > 3 ? 25 : 10;
  }

  return { score: Math.max(0, 100 - deductions), gaps };
}

export const checkRegulationComplianceTool = createTool({
  id: "check-regulation-compliance",

  description:
    "Checks compliance status against specific regulations including Saudi PDPL, ISO 9001, " +
    "ISO 27001, and NCA cybersecurity controls. Returns a compliance score (0-100) and " +
    "identified gaps with actionable recommendations.",

  inputSchema: z.object({
    regulation: z.enum(['pdpl', 'iso_9001', 'iso_27001', 'nca', 'all'])
      .describe("The regulation or standard to check compliance against"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    regulation: z.string(),
    complianceScore: z.number(),
    gaps: z.array(z.object({
      area: z.string(),
      requirement: z.string(),
      status: z.enum(['met', 'partial', 'not_met']),
      recommendation: z.string(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();

    // Enforce RBAC: this tool queries pdpl_data_inventory, data_incidents,
    // and pdpl_ai_guardrails — tables restricted to a narrow governance cohort
    // through the direct REST APIs. Deny any caller whose role falls outside
    // that cohort, including roles that can otherwise access the consultant.
    const agentCtx = getCurrentAgentContext();
    const callerRole = agentCtx?.user?.role ?? null;
    if (!callerRole || !COMPLIANCE_TOOL_ROLES.has(callerRole)) {
      logger?.warn("🚫 [checkRegulationComplianceTool] Role not permitted", { callerRole });
      return {
        success: false,
        regulation: context.regulation,
        complianceScore: 0,
        gaps: [],
        error: `Access denied: your role (${callerRole ?? "unknown"}) is not permitted to run regulation compliance checks.`,
      };
    }

    logger?.info("📋 [checkRegulationComplianceTool] Checking compliance...", {
      regulation: context.regulation,
    });

    try {
      let complianceScore = 0;
      let gaps: ComplianceGap[] = [];

      if (context.regulation === 'pdpl') {
        const result = await checkPdplCompliance();
        complianceScore = result.score;
        gaps = result.gaps;

      } else if (context.regulation === 'iso_9001') {
        const result = await checkIso9001Compliance();
        complianceScore = result.score;
        gaps = result.gaps;

      } else if (context.regulation === 'iso_27001') {
        const result = await checkIso27001Compliance();
        complianceScore = result.score;
        gaps = result.gaps;

      } else if (context.regulation === 'nca') {
        const result = await checkNcaCompliance();
        complianceScore = result.score;
        gaps = result.gaps;

      } else if (context.regulation === 'all') {
        const [pdpl, iso9001, iso27001, nca] = await Promise.all([
          checkPdplCompliance(),
          checkIso9001Compliance(),
          checkIso27001Compliance(),
          checkNcaCompliance(),
        ]);

        complianceScore = Math.round(
          (pdpl.score + iso9001.score + iso27001.score + nca.score) / 4
        );

        gaps = [
          ...pdpl.gaps.map(g => ({ ...g, area: `[PDPL] ${g.area}` })),
          ...iso9001.gaps.map(g => ({ ...g, area: `[ISO 9001] ${g.area}` })),
          ...iso27001.gaps.map(g => ({ ...g, area: `[ISO 27001] ${g.area}` })),
          ...nca.gaps.map(g => ({ ...g, area: `[NCA] ${g.area}` })),
        ];
      }

      logger?.info("✅ [checkRegulationComplianceTool] Compliance check completed", {
        regulation: context.regulation,
        complianceScore,
        gapsCount: gaps.length,
      });

      return {
        success: true,
        regulation: context.regulation,
        complianceScore,
        gaps,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [checkRegulationComplianceTool] Compliance check failed", { error: errorMessage });

      return {
        success: false,
        regulation: context.regulation,
        complianceScore: 0,
        gaps: [],
        error: errorMessage,
      };
    }
  },
});
