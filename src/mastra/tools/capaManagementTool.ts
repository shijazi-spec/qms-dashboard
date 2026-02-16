import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  createCapaRecord,
  updateCapaRecord,
  getCapaRecords,
  getCapaById,
  addCapaActionItem,
  getCapaActionItems,
  CapaRecord,
  CapaActionItem
} from "../../utils/qmsDatabase";

export const createCapaTool = createTool({
  id: "create-capa",

  description:
    "Creates a new Corrective and Preventive Action (CAPA) record. CAPA is used to track root cause analysis, " +
    "corrective actions, preventive actions, and verification for quality issues.",

  inputSchema: z.object({
    title: z.string().describe("Title of the CAPA"),
    description: z.string().optional().describe("Detailed description of the issue"),
    capaType: z.enum(["corrective", "preventive", "improvement"]).describe("Type of CAPA"),
    sourceType: z.string().optional().describe("Source of the issue (e.g., 'deal_evaluation', 'audit', 'customer_complaint')"),
    sourceId: z.string().optional().describe("ID of the source record"),
    sourceReference: z.string().optional().describe("Reference name for the source"),
    severity: z.enum(["critical", "major", "minor", "observation"]).describe("Severity level"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Priority level (default: medium)"),
    assignedTo: z.string().optional().describe("Person assigned to the CAPA"),
    targetDate: z.string().optional().describe("Target completion date (ISO format)"),
    createdBy: z.string().optional().describe("Person creating the CAPA"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    capaNumber: z.string().optional(),
    capaId: z.number().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [createCapaTool] Creating new CAPA record...", {
      title: context.title,
      severity: context.severity,
      capaType: context.capaType,
    });

    try {
      const capa = await createCapaRecord({
        title: context.title,
        description: context.description,
        capa_type: context.capaType,
        source_type: context.sourceType,
        source_id: context.sourceId,
        source_reference: context.sourceReference,
        severity: context.severity,
        status: 'open',
        priority: context.priority || 'medium',
        assigned_to: context.assignedTo,
        target_date: context.targetDate ? new Date(context.targetDate) : undefined,
        created_by: context.createdBy || 'System',
      });

      logger?.info("✅ [createCapaTool] CAPA created successfully", {
        capaNumber: capa.capa_number,
        capaId: capa.id,
      });

      return {
        success: true,
        capaNumber: capa.capa_number,
        capaId: capa.id,
        message: `CAPA ${capa.capa_number} created successfully`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [createCapaTool] Failed to create CAPA", { error: errorMessage });

      return {
        success: false,
        message: "Failed to create CAPA",
        error: errorMessage,
      };
    }
  },
});

export const updateCapaTool = createTool({
  id: "update-capa",

  description:
    "Updates an existing CAPA record with new information, status changes, or investigation findings.",

  inputSchema: z.object({
    capaId: z.number().describe("ID of the CAPA to update"),
    status: z.enum(["open", "investigation", "action_plan", "implementation", "verification", "closed", "cancelled"]).optional(),
    priority: z.enum(["critical", "high", "medium", "low"]).optional(),
    assignedTo: z.string().optional(),
    rootCause: z.string().optional().describe("Root cause analysis findings"),
    rootCauseMethod: z.string().optional().describe("Method used for root cause analysis (e.g., '5 Why', 'Fishbone')"),
    immediateAction: z.string().optional().describe("Immediate containment actions taken"),
    correctiveAction: z.string().optional().describe("Corrective actions to address the issue"),
    preventiveAction: z.string().optional().describe("Preventive actions to avoid recurrence"),
    verificationMethod: z.string().optional().describe("Method to verify effectiveness"),
    effectivenessCriteria: z.string().optional().describe("Criteria for measuring effectiveness"),
    targetDate: z.string().optional(),
    completionDate: z.string().optional(),
    verificationDate: z.string().optional(),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    capa: z.any().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📝 [updateCapaTool] Updating CAPA record...", {
      capaId: context.capaId,
      status: context.status,
    });

    try {
      const updates: Partial<CapaRecord> = {};
      
      if (context.status) updates.status = context.status;
      if (context.priority) updates.priority = context.priority;
      if (context.assignedTo) updates.assigned_to = context.assignedTo;
      if (context.rootCause) updates.root_cause = context.rootCause;
      if (context.rootCauseMethod) updates.root_cause_method = context.rootCauseMethod;
      if (context.immediateAction) updates.immediate_action = context.immediateAction;
      if (context.correctiveAction) updates.corrective_action = context.correctiveAction;
      if (context.preventiveAction) updates.preventive_action = context.preventiveAction;
      if (context.verificationMethod) updates.verification_method = context.verificationMethod;
      if (context.effectivenessCriteria) updates.effectiveness_criteria = context.effectivenessCriteria;
      if (context.targetDate) updates.target_date = new Date(context.targetDate);
      if (context.completionDate) updates.completion_date = new Date(context.completionDate);
      if (context.verificationDate) updates.verification_date = new Date(context.verificationDate);

      const updatedCapa = await updateCapaRecord(context.capaId, updates);

      if (!updatedCapa) {
        return {
          success: false,
          message: "CAPA not found or no updates provided",
        };
      }

      logger?.info("✅ [updateCapaTool] CAPA updated successfully", {
        capaId: context.capaId,
        newStatus: updatedCapa.status,
      });

      return {
        success: true,
        message: `CAPA ${updatedCapa.capa_number} updated successfully`,
        capa: updatedCapa,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [updateCapaTool] Failed to update CAPA", { error: errorMessage });

      return {
        success: false,
        message: "Failed to update CAPA",
        error: errorMessage,
      };
    }
  },
});

export const getCapaListTool = createTool({
  id: "get-capa-list",

  description:
    "Retrieves a list of CAPA records with optional filtering by status, severity, or assigned person.",

  inputSchema: z.object({
    status: z.enum(["open", "investigation", "action_plan", "implementation", "verification", "closed", "cancelled"]).optional(),
    severity: z.enum(["critical", "major", "minor", "observation"]).optional(),
    assignedTo: z.string().optional(),
    limit: z.number().optional().describe("Maximum number of records to return (default: 50)"),
    offset: z.number().optional().describe("Number of records to skip (for pagination)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    total: z.number(),
    records: z.array(z.object({
      id: z.number(),
      capaNumber: z.string(),
      title: z.string(),
      capaType: z.string(),
      severity: z.string(),
      status: z.string(),
      priority: z.string(),
      assignedTo: z.string().optional(),
      targetDate: z.string().optional(),
      createdAt: z.string(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [getCapaListTool] Fetching CAPA records...", {
      status: context.status,
      severity: context.severity,
    });

    try {
      const { records, total } = await getCapaRecords({
        limit: context.limit || 50,
        offset: context.offset || 0,
        status: context.status,
        severity: context.severity,
        assignedTo: context.assignedTo,
      });

      logger?.info("✅ [getCapaListTool] CAPA records fetched", { total });

      return {
        success: true,
        total,
        records: records.map(r => ({
          id: r.id!,
          capaNumber: r.capa_number,
          title: r.title,
          capaType: r.capa_type,
          severity: r.severity,
          status: r.status,
          priority: r.priority,
          assignedTo: r.assigned_to,
          targetDate: r.target_date?.toISOString(),
          createdAt: r.created_at?.toISOString() || new Date().toISOString(),
        })),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [getCapaListTool] Failed to fetch CAPA records", { error: errorMessage });

      return {
        success: false,
        total: 0,
        records: [],
        error: errorMessage,
      };
    }
  },
});

export const addCapaActionTool = createTool({
  id: "add-capa-action",

  description:
    "Adds an action item to a CAPA record. Action items track specific tasks needed for investigation, " +
    "corrective action, preventive action, or verification.",

  inputSchema: z.object({
    capaId: z.number().describe("ID of the CAPA to add action to"),
    description: z.string().describe("Description of the action item"),
    actionType: z.enum(["immediate", "corrective", "preventive", "verification"]).describe("Type of action"),
    assignedTo: z.string().optional().describe("Person assigned to the action"),
    dueDate: z.string().optional().describe("Due date for the action (ISO format)"),
    notes: z.string().optional().describe("Additional notes"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    actionId: z.number().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("➕ [addCapaActionTool] Adding action item to CAPA...", {
      capaId: context.capaId,
      actionType: context.actionType,
    });

    try {
      const existingActions = await getCapaActionItems(context.capaId);
      const actionNumber = existingActions.length + 1;

      const action = await addCapaActionItem({
        capa_id: context.capaId,
        action_number: actionNumber,
        description: context.description,
        action_type: context.actionType,
        assigned_to: context.assignedTo,
        due_date: context.dueDate ? new Date(context.dueDate) : undefined,
        status: 'pending',
        notes: context.notes,
      });

      logger?.info("✅ [addCapaActionTool] Action item added", {
        actionId: action.id,
        actionNumber,
      });

      return {
        success: true,
        actionId: action.id,
        message: `Action item ${actionNumber} added to CAPA successfully`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [addCapaActionTool] Failed to add action item", { error: errorMessage });

      return {
        success: false,
        message: "Failed to add action item",
        error: errorMessage,
      };
    }
  },
});

export const getCapaDetailsTool = createTool({
  id: "get-capa-details",

  description:
    "Retrieves detailed information about a specific CAPA including all action items.",

  inputSchema: z.object({
    capaId: z.number().describe("ID of the CAPA to retrieve"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    capa: z.any().optional(),
    actionItems: z.array(z.any()).optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("🔍 [getCapaDetailsTool] Fetching CAPA details...", {
      capaId: context.capaId,
    });

    try {
      const capa = await getCapaById(context.capaId);
      
      if (!capa) {
        return {
          success: false,
          error: "CAPA not found",
        };
      }

      const actionItems = await getCapaActionItems(context.capaId);

      logger?.info("✅ [getCapaDetailsTool] CAPA details fetched", {
        capaNumber: capa.capa_number,
        actionItems: actionItems.length,
      });

      return {
        success: true,
        capa,
        actionItems,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [getCapaDetailsTool] Failed to fetch CAPA details", { error: errorMessage });

      return {
        success: false,
        error: errorMessage,
      };
    }
  },
});
