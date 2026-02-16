import { join } from "path";
import { readFileSync, existsSync } from "fs";

import { 
  initScorecardTables,
  getMohammedScorecard,
  saveScorecard,
  getScorecardHistory,
  calculateKPI1_GovernanceDocLifecycle,
  calculateKPI2_ComplianceObligationTracking,
  calculateKPI3_AuditEvidencePackReadiness,
  calculateKPI4_QualityGRCHandoff,
  calculateKPI5_RiskRegisterHygiene,
  calculateKPI6_ExecutiveReportingReadiness
} from "../../utils/scorecardDatabase";

initScorecardTables().catch(console.error);

export const scorecardRoutes = [
  {
    path: "/scorecard",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "scorecard.html"),
            "/home/runner/workspace/dashboard/scorecard.html",
          ];
          for (const p of possiblePaths) {
            if (existsSync(p)) {
              return c.html(readFileSync(p, "utf-8"));
            }
          }
          return c.text("Scorecard Dashboard not found", 404);
        } catch (error) {
          console.error("Error serving scorecard dashboard:", error);
          return c.text("Error loading scorecard dashboard", 500);
        }
      };
    },
  },
  {
    path: "/api/scorecard/mohammed",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          console.log('📊 [Scorecard] Fetching Mohammed Al Muzaini scorecard...');
          const scorecard = await getMohammedScorecard();
          return c.json({ success: true, data: scorecard });
        } catch (error: any) {
          console.error('❌ [Scorecard] Error fetching scorecard:', error);
          return c.json({ success: false, error: error.message }, 500);
        }
      };
    },
  },
  {
    path: "/api/scorecard/kpi/:kpiNumber",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const kpiNumber = parseInt(c.req.param('kpiNumber'));
          console.log('📊 [Scorecard] Fetching individual KPI:', kpiNumber);
          
          let result;
          switch (kpiNumber) {
            case 1:
              result = await calculateKPI1_GovernanceDocLifecycle();
              break;
            case 2:
              result = await calculateKPI2_ComplianceObligationTracking();
              break;
            case 3:
              result = await calculateKPI3_AuditEvidencePackReadiness();
              break;
            case 4:
              result = await calculateKPI4_QualityGRCHandoff();
              break;
            case 5:
              result = await calculateKPI5_RiskRegisterHygiene();
              break;
            case 6:
              result = await calculateKPI6_ExecutiveReportingReadiness();
              break;
            default:
              return c.json({ success: false, error: 'Invalid KPI number (1-6)' }, 400);
          }
          
          return c.json({ success: true, kpi_number: kpiNumber, data: result });
        } catch (error: any) {
          console.error('❌ [Scorecard] Error fetching KPI:', error);
          return c.json({ success: false, error: error.message }, 500);
        }
      };
    },
  },
  {
    path: "/api/scorecard/snapshot",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          console.log('📝 [Scorecard] Saving scorecard snapshot...');
          const scorecard = await getMohammedScorecard();
          
          const now = new Date();
          const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
          const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          
          const saved = await saveScorecard({
            employee_name: scorecard.employee.name,
            employee_role: scorecard.employee.role,
            period_start: periodStart,
            period_end: periodEnd,
            overall_score: scorecard.overall_score,
            weighted_score: scorecard.weighted_score,
            kpi_details: scorecard.kpis
          });
          
          return c.json({ success: true, message: 'Scorecard snapshot saved', data: saved });
        } catch (error: any) {
          console.error('❌ [Scorecard] Error saving snapshot:', error);
          return c.json({ success: false, error: error.message }, 500);
        }
      };
    },
  },
  {
    path: "/api/scorecard/history",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const name = c.req.query('name') || 'Mohammed Al Muzaini';
          const limit = parseInt(c.req.query('limit') || '12');
          
          console.log('📊 [Scorecard] Fetching scorecard history for:', name);
          const history = await getScorecardHistory(name, limit);
          
          return c.json({ success: true, data: history });
        } catch (error: any) {
          console.error('❌ [Scorecard] Error fetching history:', error);
          return c.json({ success: false, error: error.message }, 500);
        }
      };
    },
  },
];
