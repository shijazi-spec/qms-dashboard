export const roiRoutes = [
  {
    path: "/api/roi",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("💰 [ROI API] Fetching initiatives");

          const { listROIInitiatives, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");
          const department = c.req.query("department");
          const owner = c.req.query("owner");
          const status = c.req.query("status");
          const recommendation = c.req.query("recommendation");
          const sortBy = c.req.query("sortBy") as 'roi' | 'npv' | 'payback' | 'created';
          const sortOrder = c.req.query("sortOrder") as 'asc' | 'desc';

          const result = await listROIInitiatives({
            department, owner, status, recommendation,
            sortBy, sortOrder, limit, offset
          });

          logger?.info("✅ [ROI API] Initiatives fetched", { count: result.initiatives.length });
          return c.json(result);
        } catch (error) {
          console.error("Error fetching ROI initiatives:", error);
          return c.json({ 
            error: "Failed to fetch initiatives" 
          }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/analytics",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          logger?.info("📊 [ROI API] Fetching analytics");

          const { getROIAnalytics, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const analytics = await getROIAnalytics();
          logger?.info("✅ [ROI API] Analytics fetched");
          return c.json(analytics);
        } catch (error) {
          console.error("Error fetching ROI analytics:", error);
          return c.json({ error: "Failed to fetch analytics" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/calculate",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const data = await c.req.json();

          const { validateROIFinancials } = await import('../../utils/inputSanitizer');
          const financialError = validateROIFinancials(data);
          if (financialError) {
            return c.json({ error: financialError }, 400);
          }

          logger?.info("🧮 [ROI API] Calculating ROI");

          const { calculateROI, generateAIRecommendation } = await import("../../utils/roiDatabase");
          
          const calc = calculateROI(data);
          const { recommendation, insights } = generateAIRecommendation(calc);

          logger?.info("✅ [ROI API] Calculation complete", { roi: calc.roi_percentage });
          return c.json({
            ...calc,
            ai_recommendation: recommendation,
            ai_insights: insights
          });
        } catch (error) {
          console.error("Error calculating ROI:", error);
          return c.json({ error: "Failed to calculate ROI" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const data = await c.req.json();
          logger?.info("💰 [ROI API] Creating initiative", { name: data.project_name });

          const { 
            createROIInitiative, initROITables,
            createManpowerBreakdown, createPlatformCost, createErrorCosts,
            createRevenueImpact, createImplementationBreakdown, createRiskInputs
          } = await import("../../utils/roiDatabase");
          await initROITables();

          if (!data.project_name || !data.owner || !data.department) {
            return c.json({ error: 'Missing required fields' }, 400);
          }

          const { validateROIFinancials } = await import('../../utils/inputSanitizer');
          const topLevelError = validateROIFinancials(data);
          if (topLevelError) {
            return c.json({ error: topLevelError }, 400);
          }
          for (const sub of ['manpower', 'errorCosts', 'revenueImpact', 'implementation', 'riskInputs']) {
            if (data[sub] && typeof data[sub] === 'object') {
              const subError = validateROIFinancials(data[sub]);
              if (subError) {
                return c.json({ error: `${sub}: ${subError}` }, 400);
              }
            }
          }
          if (data.platformCosts && Array.isArray(data.platformCosts)) {
            for (const cost of data.platformCosts) {
              const costError = validateROIFinancials(cost);
              if (costError) {
                return c.json({ error: `platformCosts: ${costError}` }, 400);
              }
            }
          }

          const initiative = await createROIInitiative(data);
          logger?.info("✅ [ROI API] Initiative created", { id: initiative.id });

          const breakdownResults: any = {};

          if (data.manpower && initiative.id) {
            logger?.info("📊 [ROI API] Creating manpower breakdown");
            breakdownResults.manpower = await createManpowerBreakdown({
              ...data.manpower,
              initiative_id: initiative.id
            });
          }

          if (data.platformCosts && Array.isArray(data.platformCosts) && initiative.id) {
            logger?.info("📊 [ROI API] Creating platform costs", { count: data.platformCosts.length });
            breakdownResults.platformCosts = [];
            for (const cost of data.platformCosts) {
              const created = await createPlatformCost({
                ...cost,
                initiative_id: initiative.id
              });
              breakdownResults.platformCosts.push(created);
            }
          }

          if (data.errorCosts && initiative.id) {
            logger?.info("📊 [ROI API] Creating error costs");
            breakdownResults.errorCosts = await createErrorCosts({
              ...data.errorCosts,
              initiative_id: initiative.id
            });
          }

          if (data.revenueImpact && initiative.id) {
            logger?.info("📊 [ROI API] Creating revenue impact");
            breakdownResults.revenueImpact = await createRevenueImpact({
              ...data.revenueImpact,
              initiative_id: initiative.id
            });
          }

          if (data.implementation && initiative.id) {
            logger?.info("📊 [ROI API] Creating implementation breakdown");
            breakdownResults.implementation = await createImplementationBreakdown({
              ...data.implementation,
              initiative_id: initiative.id
            });
          }

          if (data.riskInputs && initiative.id) {
            logger?.info("📊 [ROI API] Creating risk inputs");
            breakdownResults.riskInputs = await createRiskInputs({
              ...data.riskInputs,
              initiative_id: initiative.id
            });
          }

          return c.json({ 
            success: true, 
            initiative,
            breakdowns: Object.keys(breakdownResults).length > 0 ? breakdownResults : undefined
          });
        } catch (error) {
          console.error("Error creating ROI initiative:", error);
          return c.json({ 
            error: "Failed to create initiative" 
          }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/full",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          logger?.info("📊 [ROI API] Fetching full initiative details", { id });

          const { getFullInitiativeDetails, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const fullDetails = await getFullInitiativeDetails(id);
          if (!fullDetails) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          logger?.info("✅ [ROI API] Full initiative details fetched", { id });
          return c.json(fullDetails);
        } catch (error) {
          console.error("Error fetching full initiative details:", error);
          return c.json({ error: "Failed to fetch initiative details" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/manpower",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const data = await c.req.json();
          logger?.info("📊 [ROI API] Creating/updating manpower breakdown", { initiativeId: id });

          const { 
            createManpowerBreakdown, updateManpowerBreakdown, getManpowerBreakdown, 
            initROITables, getROIInitiativeById 
          } = await import("../../utils/roiDatabase");
          await initROITables();

          const initiative = await getROIInitiativeById(id);
          if (!initiative) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          const existing = await getManpowerBreakdown(id);
          let breakdown;

          if (existing) {
            logger?.info("📝 [ROI API] Updating existing manpower breakdown", { id });
            breakdown = await updateManpowerBreakdown(id, data);
          } else {
            logger?.info("➕ [ROI API] Creating new manpower breakdown", { id });
            breakdown = await createManpowerBreakdown({ ...data, initiative_id: id });
          }

          logger?.info("✅ [ROI API] Manpower breakdown saved", { 
            initiativeId: id, 
            fullyLoadedSalary: breakdown?.fully_loaded_salary 
          });
          return c.json({ success: true, breakdown });
        } catch (error) {
          console.error("Error saving manpower breakdown:", error);
          return c.json({ error: "Failed to save manpower breakdown" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/platform-costs",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const data = await c.req.json();
          logger?.info("📊 [ROI API] Adding platform cost(s)", { initiativeId: id });

          const { createPlatformCost, initROITables, getROIInitiativeById } = await import("../../utils/roiDatabase");
          await initROITables();

          const initiative = await getROIInitiativeById(id);
          if (!initiative) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          const costs = Array.isArray(data) ? data : [data];
          const createdCosts = [];

          for (const cost of costs) {
            const created = await createPlatformCost({ ...cost, initiative_id: id });
            createdCosts.push(created);
          }

          logger?.info("✅ [ROI API] Platform cost(s) added", { initiativeId: id, count: createdCosts.length });
          return c.json({ success: true, platformCosts: createdCosts });
        } catch (error) {
          console.error("Error adding platform cost:", error);
          return c.json({ error: "Failed to add platform cost" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/platform-costs",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          logger?.info("📊 [ROI API] Listing platform costs", { initiativeId: id });

          const { listPlatformCosts, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const platformCosts = await listPlatformCosts(id);

          logger?.info("✅ [ROI API] Platform costs fetched", { initiativeId: id, count: platformCosts.length });
          return c.json({ platformCosts });
        } catch (error) {
          console.error("Error listing platform costs:", error);
          return c.json({ error: "Failed to list platform costs" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/platform-costs/:costId",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const costId = parseInt(c.req.param("costId"));
          logger?.info("🗑️ [ROI API] Deleting platform cost", { costId });

          const { deletePlatformCost, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const success = await deletePlatformCost(costId);
          if (!success) {
            return c.json({ error: "Platform cost not found" }, 404);
          }

          logger?.info("✅ [ROI API] Platform cost deleted", { costId });
          return c.json({ success: true, message: "Platform cost deleted" });
        } catch (error) {
          console.error("Error deleting platform cost:", error);
          return c.json({ error: "Failed to delete platform cost" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/error-costs",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const data = await c.req.json();
          logger?.info("📊 [ROI API] Creating/updating error costs", { initiativeId: id });

          const { 
            createErrorCosts, updateErrorCosts, getErrorCosts, 
            initROITables, getROIInitiativeById 
          } = await import("../../utils/roiDatabase");
          await initROITables();

          const initiative = await getROIInitiativeById(id);
          if (!initiative) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          const existing = await getErrorCosts(id);
          let errorCosts;

          if (existing) {
            logger?.info("📝 [ROI API] Updating existing error costs", { id });
            errorCosts = await updateErrorCosts(id, data);
          } else {
            logger?.info("➕ [ROI API] Creating new error costs", { id });
            errorCosts = await createErrorCosts({ ...data, initiative_id: id });
          }

          logger?.info("✅ [ROI API] Error costs saved", { 
            initiativeId: id, 
            calculatedSavings: errorCosts?.calculated_error_savings 
          });
          return c.json({ success: true, errorCosts });
        } catch (error) {
          console.error("Error saving error costs:", error);
          return c.json({ error: "Failed to save error costs" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/revenue-impact",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const data = await c.req.json();
          logger?.info("📊 [ROI API] Creating/updating revenue impact", { initiativeId: id });

          const { 
            createRevenueImpact, updateRevenueImpact, getRevenueImpact, 
            initROITables, getROIInitiativeById 
          } = await import("../../utils/roiDatabase");
          await initROITables();

          const initiative = await getROIInitiativeById(id);
          if (!initiative) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          const existing = await getRevenueImpact(id);
          let revenueImpact;

          if (existing) {
            logger?.info("📝 [ROI API] Updating existing revenue impact", { id });
            revenueImpact = await updateRevenueImpact(id, data);
          } else {
            logger?.info("➕ [ROI API] Creating new revenue impact", { id });
            revenueImpact = await createRevenueImpact({ ...data, initiative_id: id });
          }

          logger?.info("✅ [ROI API] Revenue impact saved", { 
            initiativeId: id, 
            calculatedImpact: revenueImpact?.calculated_revenue_impact 
          });
          return c.json({ success: true, revenueImpact });
        } catch (error) {
          console.error("Error saving revenue impact:", error);
          return c.json({ error: "Failed to save revenue impact" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/implementation",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const data = await c.req.json();
          logger?.info("📊 [ROI API] Creating/updating implementation breakdown", { initiativeId: id });

          const { 
            createImplementationBreakdown, updateImplementationBreakdown, getImplementationBreakdown, 
            initROITables, getROIInitiativeById 
          } = await import("../../utils/roiDatabase");
          await initROITables();

          const initiative = await getROIInitiativeById(id);
          if (!initiative) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          const existing = await getImplementationBreakdown(id);
          let implementation;

          if (existing) {
            logger?.info("📝 [ROI API] Updating existing implementation breakdown", { id });
            implementation = await updateImplementationBreakdown(id, data);
          } else {
            logger?.info("➕ [ROI API] Creating new implementation breakdown", { id });
            implementation = await createImplementationBreakdown({ ...data, initiative_id: id });
          }

          logger?.info("✅ [ROI API] Implementation breakdown saved", { 
            initiativeId: id, 
            totalCost: implementation?.calculated_total_implementation 
          });
          return c.json({ success: true, implementation });
        } catch (error) {
          console.error("Error saving implementation breakdown:", error);
          return c.json({ error: "Failed to save implementation breakdown" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/risk-inputs",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const data = await c.req.json();
          logger?.info("📊 [ROI API] Creating/updating risk inputs", { initiativeId: id });

          const { 
            createRiskInputs, updateRiskInputs, getRiskInputs, 
            initROITables, getROIInitiativeById 
          } = await import("../../utils/roiDatabase");
          await initROITables();

          const initiative = await getROIInitiativeById(id);
          if (!initiative) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          const existing = await getRiskInputs(id);
          let riskInputs;

          if (existing) {
            logger?.info("📝 [ROI API] Updating existing risk inputs", { id });
            riskInputs = await updateRiskInputs(id, data, initiative.npv || undefined);
          } else {
            logger?.info("➕ [ROI API] Creating new risk inputs", { id });
            riskInputs = await createRiskInputs({ ...data, initiative_id: id });
          }

          logger?.info("✅ [ROI API] Risk inputs saved", { 
            initiativeId: id, 
            confidenceLevel: riskInputs?.confidence_level 
          });
          return c.json({ success: true, riskInputs });
        } catch (error) {
          console.error("Error saving risk inputs:", error);
          return c.json({ error: "Failed to save risk inputs" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/validation-logs",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          logger?.info("📊 [ROI API] Fetching AI validation logs", { initiativeId: id });

          const { listAIValidationLogs, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const validationLogs = await listAIValidationLogs(id);

          logger?.info("✅ [ROI API] AI validation logs fetched", { initiativeId: id, count: validationLogs.length });
          return c.json({ validationLogs });
        } catch (error) {
          console.error("Error fetching validation logs:", error);
          return c.json({ error: "Failed to fetch validation logs" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/initiatives/:id/validate",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          logger?.info("🔍 [ROI API] Running AI validation on initiative", { initiativeId: id });

          const { 
            getFullInitiativeDetails, createAIValidationLog, initROITables 
          } = await import("../../utils/roiDatabase");
          await initROITables();

          const fullDetails = await getFullInitiativeDetails(id);
          if (!fullDetails) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          const validationResults: any[] = [];

          if (fullDetails.manpowerBreakdown) {
            const salary = fullDetails.manpowerBreakdown.avg_monthly_salary;
            if (salary < 3000) {
              const log = await createAIValidationLog({
                initiative_id: id,
                validation_type: 'range_check',
                field_name: 'avg_monthly_salary',
                original_value: String(salary),
                suggested_value: '3000',
                reason: 'Salary below minimum threshold of 3000 SAR - this may indicate data entry error or need for verification',
                confidence_score: 85,
                accepted: false
              });
              validationResults.push({ type: 'warning', field: 'avg_monthly_salary', message: 'Salary below 3000 SAR', log });
              logger?.info("⚠️ [ROI API] Validation warning: Low salary", { salary });
            }
            if (salary > 100000) {
              const log = await createAIValidationLog({
                initiative_id: id,
                validation_type: 'range_check',
                field_name: 'avg_monthly_salary',
                original_value: String(salary),
                suggested_value: '100000',
                reason: 'Salary exceeds typical maximum of 100000 SAR - verify this is accurate',
                confidence_score: 80,
                accepted: false
              });
              validationResults.push({ type: 'warning', field: 'avg_monthly_salary', message: 'Salary exceeds 100000 SAR', log });
              logger?.info("⚠️ [ROI API] Validation warning: High salary", { salary });
            }
          }

          if (fullDetails.errorCosts) {
            const errorRate = fullDetails.errorCosts.current_error_rate;
            if (errorRate > 50) {
              const log = await createAIValidationLog({
                initiative_id: id,
                validation_type: 'range_check',
                field_name: 'current_error_rate',
                original_value: String(errorRate),
                suggested_value: '50',
                reason: 'Error rate exceeds 50% - this is unusually high and should be verified',
                confidence_score: 90,
                accepted: false
              });
              validationResults.push({ type: 'warning', field: 'current_error_rate', message: 'Error rate exceeds 50%', log });
              logger?.info("⚠️ [ROI API] Validation warning: High error rate", { errorRate });
            }
          }

          const implCost = fullDetails.implementationBreakdown?.calculated_total_implementation || fullDetails.implementation_cost || 0;
          const expectedSavings = (fullDetails.expected_savings_monthly || 0) * (fullDetails.project_duration_months || 12);
          
          if (implCost > 0 && expectedSavings > 0) {
            const ratio = implCost / expectedSavings;
            if (ratio > 2) {
              const log = await createAIValidationLog({
                initiative_id: id,
                validation_type: 'ratio_check',
                field_name: 'implementation_to_savings_ratio',
                original_value: String(ratio.toFixed(2)),
                suggested_value: '< 2.0',
                reason: `Implementation cost (${implCost.toLocaleString()}) is more than 2x the expected savings (${expectedSavings.toLocaleString()}) - ROI may be unfavorable`,
                confidence_score: 75,
                accepted: false
              });
              validationResults.push({ 
                type: 'warning', 
                field: 'implementation_to_savings_ratio', 
                message: 'Implementation cost exceeds 2x expected savings',
                ratio: ratio.toFixed(2),
                log 
              });
              logger?.info("⚠️ [ROI API] Validation warning: High implementation to savings ratio", { ratio });
            }
          }

          if (implCost > 0 && fullDetails.npv !== undefined && fullDetails.npv < 0) {
            const log = await createAIValidationLog({
              initiative_id: id,
              validation_type: 'npv_check',
              field_name: 'npv',
              original_value: String(fullDetails.npv),
              suggested_value: '> 0',
              reason: 'Negative NPV indicates the initiative may not be financially viable',
              confidence_score: 95,
              accepted: false
            });
            validationResults.push({ type: 'critical', field: 'npv', message: 'Negative NPV', log });
            logger?.info("🚨 [ROI API] Validation critical: Negative NPV", { npv: fullDetails.npv });
          }

          logger?.info("✅ [ROI API] AI validation complete", { 
            initiativeId: id, 
            issuesFound: validationResults.length 
          });

          return c.json({ 
            success: true, 
            initiativeId: id,
            validationResults,
            summary: {
              totalIssues: validationResults.length,
              warnings: validationResults.filter(r => r.type === 'warning').length,
              critical: validationResults.filter(r => r.type === 'critical').length
            }
          });
        } catch (error) {
          console.error("Error running validation:", error);
          return c.json({ error: "Failed to run validation" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { getSessionUser, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = getSessionUser(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          logger?.info("🔍 [ROI API] Fetching initiative", { id });

          const { getROIInitiativeById, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const initiative = await getROIInitiativeById(id);
          if (!initiative) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          logger?.info("✅ [ROI API] Initiative fetched", { id });
          return c.json(initiative);
        } catch (error) {
          console.error("Error fetching ROI initiative:", error);
          return c.json({ error: "Failed to fetch initiative" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          const data = await c.req.json();

          const { validateROIFinancials } = await import('../../utils/inputSanitizer');
          const financialError = validateROIFinancials(data);
          if (financialError) {
            return c.json({ error: financialError }, 400);
          }

          logger?.info("📝 [ROI API] Updating initiative", { id });

          const { updateROIInitiative, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const initiative = await updateROIInitiative(id, data);
          if (!initiative) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          logger?.info("✅ [ROI API] Initiative updated", { id });
          return c.json({ success: true, initiative });
        } catch (error) {
          console.error("Error updating ROI initiative:", error);
          return c.json({ error: "Failed to update initiative" }, 500);
        }
      };
    }
  },
  {
    path: "/api/roi/:id",
    method: "DELETE" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const id = parseInt(c.req.param("id"));
          logger?.info("🗑️ [ROI API] Deleting initiative", { id });

          const { deleteROIInitiative, initROITables } = await import("../../utils/roiDatabase");
          await initROITables();

          const success = await deleteROIInitiative(id);
          if (!success) {
            return c.json({ error: "Initiative not found" }, 404);
          }

          logger?.info("✅ [ROI API] Initiative deleted", { id });
          return c.json({ success: true, message: "Initiative deleted" });
        } catch (error) {
          console.error("Error deleting ROI initiative:", error);
          return c.json({ error: "Failed to delete initiative" }, 500);
        }
      };
    }
  },
  {
    path: "/roi",
    method: "GET" as const,
    createHandler: async () => {
      const { readFileSync, existsSync } = await import("fs");
      const { join } = await import("path");
      
      return async (c: any) => {
        try {
          const possiblePaths = [
            join(process.cwd(), "dashboard", "roi.html"),
            join(process.cwd(), "..", "dashboard", "roi.html"),
            "/home/runner/workspace/dashboard/roi.html",
          ];
          
          for (const roiPath of possiblePaths) {
            if (existsSync(roiPath)) {
              const html = readFileSync(roiPath, "utf-8");
              return c.html(html);
            }
          }
          
          console.error("ROI dashboard not found in any path:", possiblePaths);
          return c.text("ROI dashboard not found", 404);
        } catch (error) {
          console.error("Error serving ROI dashboard:", error);
          return c.text("Error loading ROI dashboard", 500);
        }
      };
    }
  }
];
