import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getCurrentAgentContext } from "../../utils/withApprovalGate";
import { CHECKLIST_MODULE_ROLE_ALLOWLIST } from "../../utils/checklistDatabase";

export const runChecklistTool = createTool({
  id: "run-checklist",
  description:
    "Executes a compliance checklist against live platform data. Each checklist item is automatically verified " +
    "by querying the relevant QMS module. Returns a scored report with pass/fail results and gap details. " +
    "Use 'list' action to see available checklists, 'run' to execute one, or 'history' to see past runs.",
  inputSchema: z.object({
    action: z.enum(["list", "run", "history"]).describe("Action to perform: list available checklists, run a specific checklist, or view run history"),
    checklistId: z.number().optional().describe("Checklist ID (required for 'run' and 'history' actions)"),
    standard: z.string().optional().describe("Filter checklists by standard (e.g., 'ISO 9001', 'PDPL', 'ISO 27001')"),
  }),
  execute: async ({ context }) => {
    const { action, checklistId, standard } = context;

    const {
      getChecklists, getChecklistById, runChecklist, getChecklistRuns, initChecklistTables,
    } = await import("../../utils/checklistDatabase");

    await initChecklistTables();

    if (action === "list") {
      const checklists = await getChecklists({ standard, is_active: true });
      if (checklists.length === 0) {
        return {
          success: true,
          message: "No checklists found. Use the manageChecklist tool to create one.",
          checklists: [],
        };
      }
      return {
        success: true,
        count: checklists.length,
        checklists: checklists.map(c => ({
          id: c.id, name: c.name, standard: c.standard, version: c.version,
          category: c.category, description: c.description,
        })),
      };
    }

    if (action === "run") {
      if (!checklistId) return { success: false, error: "checklistId is required for run action" };
      // Thread the caller's role into the engine so it enforces per-module RBAC
      // and blocks data_query items for non-admin callers.
      const agentCtx = getCurrentAgentContext();
      const callerRole = agentCtx?.user?.role as string | undefined;
      const run = await runChecklist(checklistId, "ai_consultant", callerRole);
      return {
        success: true,
        checklistId,
        overallScore: run.overall_score,
        totalItems: run.total_items,
        passed: run.passed_items,
        failed: run.failed_items,
        notApplicable: run.na_items,
        itemResults: run.item_results,
        runId: run.id,
      };
    }

    if (action === "history") {
      if (!checklistId) return { success: false, error: "checklistId is required for history action" };
      const runs = await getChecklistRuns(checklistId, 5);
      return {
        success: true,
        checklistId,
        runCount: runs.length,
        runs: runs.map(r => ({
          id: r.id, runDate: r.run_date, score: r.overall_score,
          passed: r.passed_items, failed: r.failed_items, total: r.total_items,
        })),
      };
    }

    return { success: false, error: "Unknown action" };
  },
});

export const manageChecklistTool = createTool({
  id: "manage-checklist",
  description:
    "Creates, updates, or views compliance checklists. Use this to build structured audit/compliance " +
    "checklists that can be automatically executed against the platform. Supports ISO 9001, ISO 27001, " +
    "PDPL, NCA, and custom standards. Items can be automated (data_query, count_check, existence_check, " +
    "threshold_check) or manual.",
  inputSchema: z.object({
    action: z.enum(["create", "view", "delete"]).describe("Action: create a new checklist, view details, or delete"),
    checklistId: z.number().optional().describe("Checklist ID (for view/delete)"),
    name: z.string().optional().describe("Checklist name (for create)"),
    standard: z.string().optional().describe("Standard reference, e.g. 'ISO 9001', 'PDPL', 'ISO 27001', 'NCA ECC'"),
    description: z.string().optional().describe("Checklist description"),
    category: z.string().optional().describe("Category, e.g. 'Document Control', 'Nonconformity Management'"),
    items: z.array(z.object({
      item_number: z.number(),
      clause_reference: z.string().optional(),
      question: z.string(),
      expected_result: z.string().optional(),
      check_type: z.enum(["data_query", "count_check", "existence_check", "threshold_check", "manual"]).default("manual"),
      module_to_query: z.string().optional(),
      query_config: z.any().optional(),
      is_critical: z.boolean().optional(),
    })).optional().describe("Checklist items (for create)"),
  }),
  execute: async ({ context }) => {
    const { action, checklistId, name, standard, description, category, items } = context;

    const {
      createChecklist, addChecklistItems, getChecklistById, deleteChecklist, initChecklistTables,
    } = await import("../../utils/checklistDatabase");

    await initChecklistTables();

    if (action === "create") {
      if (!name || !standard) return { success: false, error: "name and standard are required" };
      if (!items || items.length === 0) return { success: false, error: "At least one item is required" };

      // Enforce module-level RBAC at creation time: reject items that reference
      // modules the caller cannot read, or that use data_query (arbitrary SQL)
      // without admin privileges.
      const agentCtxCreate = getCurrentAgentContext();
      const callerRoleCreate = agentCtxCreate?.user?.role as string | undefined;
      const isAdmin = callerRoleCreate === "admin";
      const RESTRICTED_MODULES = ["pdpl", "event_logs"];
      for (const item of items) {
        if (item.module_to_query && RESTRICTED_MODULES.includes(item.module_to_query)) {
          return {
            success: false,
            error: `Module '${item.module_to_query}' is restricted and cannot be used in checklist items`,
          };
        }
        if (item.check_type === "data_query" && !isAdmin) {
          return {
            success: false,
            error: "data_query check type requires administrator role",
          };
        }
        if (item.module_to_query && callerRoleCreate !== undefined) {
          const allowedRoles = CHECKLIST_MODULE_ROLE_ALLOWLIST[item.module_to_query];
          if (allowedRoles && !allowedRoles.includes(callerRoleCreate)) {
            return {
              success: false,
              error: `Role '${callerRoleCreate}' is not permitted to create checklist items for the '${item.module_to_query}' module`,
            };
          }
        }
      }

      const checklist = await createChecklist({ name, standard, description, category, created_by: "ai_consultant" });
      const savedItems = await addChecklistItems(checklist.id!, items.map(i => ({
        item_number: i.item_number,
        clause_reference: i.clause_reference,
        question: i.question,
        expected_result: i.expected_result,
        check_type: i.check_type || "manual",
        module_to_query: i.module_to_query,
        query_config: i.query_config,
        is_critical: i.is_critical || false,
        weight: 1.0,
      })));

      return {
        success: true,
        message: `Checklist "${name}" created with ${savedItems.length} items`,
        checklistId: checklist.id,
        itemCount: savedItems.length,
      };
    }

    if (action === "view") {
      if (!checklistId) return { success: false, error: "checklistId is required" };
      const data = await getChecklistById(checklistId);
      if (!data) return { success: false, error: "Checklist not found" };
      return {
        success: true,
        checklist: {
          id: data.checklist.id, name: data.checklist.name, standard: data.checklist.standard,
          version: data.checklist.version, description: data.checklist.description,
        },
        items: data.items.map(i => ({
          number: i.item_number, clause: i.clause_reference, question: i.question,
          expected: i.expected_result, checkType: i.check_type, module: i.module_to_query, critical: i.is_critical,
        })),
      };
    }

    if (action === "delete") {
      if (!checklistId) return { success: false, error: "checklistId is required" };
      const deleted = await deleteChecklist(checklistId);
      return { success: deleted, message: deleted ? "Checklist deleted" : "Checklist not found" };
    }

    return { success: false, error: "Unknown action" };
  },
});
