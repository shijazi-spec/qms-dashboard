import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  createTrainingRecord,
  getTrainingRecords,
  assignTraining,
  getTrainingAssignments,
  updateTrainingAssignment,
  TrainingRecord,
  TrainingAssignment
} from "../../utils/qmsDatabase";

export const createTrainingTool = createTool({
  id: "create-training",

  description:
    "Creates a new training course/program in the system. Training records define " +
    "quality-related training that employees need to complete.",

  inputSchema: z.object({
    trainingId: z.string().describe("Unique identifier for the training"),
    title: z.string().describe("Title of the training"),
    description: z.string().optional().describe("Description of the training"),
    trainingType: z.enum([
      "quality_standards", "iso_9001", "copc", "six_sigma", 
      "process", "tool", "compliance", "onboarding", "refresher", "custom"
    ]).describe("Type of training"),
    category: z.string().optional().describe("Training category"),
    durationHours: z.number().optional().describe("Duration in hours"),
    provider: z.string().optional().describe("Training provider"),
    assessmentRequired: z.boolean().optional().describe("Whether assessment is required"),
    passingScore: z.number().optional().describe("Minimum passing score (0-100)"),
    validityMonths: z.number().optional().describe("How long the training is valid (in months)"),
    isMandatory: z.boolean().optional().describe("Whether this training is mandatory"),
    targetRoles: z.array(z.string()).optional().describe("Roles that need this training"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    trainingId: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📚 [createTrainingTool] Creating new training record...", {
      trainingId: context.trainingId,
      title: context.title,
      trainingType: context.trainingType,
    });

    try {
      const training = await createTrainingRecord({
        training_id: context.trainingId,
        title: context.title,
        description: context.description,
        training_type: context.trainingType,
        category: context.category,
        duration_hours: context.durationHours,
        provider: context.provider,
        assessment_required: context.assessmentRequired,
        passing_score: context.passingScore,
        validity_months: context.validityMonths,
        is_mandatory: context.isMandatory,
        target_roles: context.targetRoles,
        is_active: true,
      });

      logger?.info("✅ [createTrainingTool] Training created successfully", {
        trainingId: training.training_id,
      });

      return {
        success: true,
        trainingId: training.training_id,
        message: `Training "${context.title}" created successfully`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [createTrainingTool] Failed to create training", { error: errorMessage });

      return {
        success: false,
        message: "Failed to create training",
        error: errorMessage,
      };
    }
  },
});

export const getTrainingListTool = createTool({
  id: "get-training-list",

  description:
    "Retrieves a list of training courses/programs with optional filtering.",

  inputSchema: z.object({
    trainingType: z.enum([
      "quality_standards", "iso_9001", "copc", "six_sigma", 
      "process", "tool", "compliance", "onboarding", "refresher", "custom"
    ]).optional(),
    isActive: z.boolean().optional(),
    limit: z.number().optional().describe("Maximum number of records to return (default: 50)"),
    offset: z.number().optional().describe("Number of records to skip (for pagination)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    total: z.number(),
    records: z.array(z.object({
      id: z.number(),
      trainingId: z.string(),
      title: z.string(),
      trainingType: z.string(),
      category: z.string().optional(),
      durationHours: z.number().optional(),
      isMandatory: z.boolean(),
      isActive: z.boolean(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📚 [getTrainingListTool] Fetching training records...");

    try {
      const { records, total } = await getTrainingRecords({
        limit: context.limit || 50,
        offset: context.offset || 0,
        trainingType: context.trainingType,
        isActive: context.isActive,
      });

      logger?.info("✅ [getTrainingListTool] Training records fetched", { total });

      return {
        success: true,
        total,
        records: records.map(r => ({
          id: r.id!,
          trainingId: r.training_id,
          title: r.title,
          trainingType: r.training_type,
          category: r.category,
          durationHours: r.duration_hours,
          isMandatory: r.is_mandatory || false,
          isActive: r.is_active || true,
        })),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [getTrainingListTool] Failed to fetch training records", { error: errorMessage });

      return {
        success: false,
        total: 0,
        records: [],
        error: errorMessage,
      };
    }
  },
});

export const assignTrainingTool = createTool({
  id: "assign-training",

  description:
    "Assigns a training course to an employee. Creates a training assignment record.",

  inputSchema: z.object({
    trainingId: z.string().describe("ID of the training to assign"),
    employeeId: z.string().describe("Employee ID"),
    employeeName: z.string().describe("Employee name"),
    employeeEmail: z.string().optional().describe("Employee email"),
    employeeRole: z.string().optional().describe("Employee role"),
    dueDate: z.string().optional().describe("Due date for completion (ISO format)"),
    assignedBy: z.string().optional().describe("Person assigning the training"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    assignmentId: z.number().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📝 [assignTrainingTool] Assigning training...", {
      trainingId: context.trainingId,
      employeeId: context.employeeId,
    });

    try {
      const assignment = await assignTraining({
        training_id: context.trainingId,
        employee_id: context.employeeId,
        employee_name: context.employeeName,
        employee_email: context.employeeEmail,
        employee_role: context.employeeRole,
        due_date: context.dueDate ? new Date(context.dueDate) : undefined,
        status: 'assigned',
        assigned_by: context.assignedBy || 'System',
      });

      logger?.info("✅ [assignTrainingTool] Training assigned successfully", {
        assignmentId: assignment.id,
      });

      return {
        success: true,
        assignmentId: assignment.id,
        message: `Training assigned to ${context.employeeName} successfully`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [assignTrainingTool] Failed to assign training", { error: errorMessage });

      return {
        success: false,
        message: "Failed to assign training",
        error: errorMessage,
      };
    }
  },
});

export const getTrainingAssignmentsTool = createTool({
  id: "get-training-assignments",

  description:
    "Retrieves training assignments with optional filtering by employee, training, or status.",

  inputSchema: z.object({
    employeeId: z.string().optional().describe("Filter by employee ID"),
    trainingId: z.string().optional().describe("Filter by training ID"),
    status: z.enum(["assigned", "in_progress", "completed", "overdue", "expired", "exempted"]).optional(),
    limit: z.number().optional().describe("Maximum number of records to return (default: 50)"),
    offset: z.number().optional().describe("Number of records to skip (for pagination)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    total: z.number(),
    assignments: z.array(z.object({
      id: z.number(),
      trainingId: z.string(),
      trainingTitle: z.string().optional(),
      employeeId: z.string(),
      employeeName: z.string(),
      status: z.string(),
      dueDate: z.string().optional(),
      completionDate: z.string().optional(),
      assessmentScore: z.number().optional(),
      assessmentPassed: z.boolean().optional(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [getTrainingAssignmentsTool] Fetching training assignments...", {
      employeeId: context.employeeId,
      status: context.status,
    });

    try {
      const { assignments, total } = await getTrainingAssignments({
        limit: context.limit || 50,
        offset: context.offset || 0,
        employeeId: context.employeeId,
        trainingId: context.trainingId,
        status: context.status,
      });

      logger?.info("✅ [getTrainingAssignmentsTool] Assignments fetched", { total });

      return {
        success: true,
        total,
        assignments: assignments.map(a => ({
          id: a.id!,
          trainingId: a.training_id,
          trainingTitle: (a as any).training_title,
          employeeId: a.employee_id,
          employeeName: a.employee_name,
          status: a.status,
          dueDate: a.due_date?.toISOString(),
          completionDate: a.completion_date?.toISOString(),
          assessmentScore: a.assessment_score,
          assessmentPassed: a.assessment_passed,
        })),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [getTrainingAssignmentsTool] Failed to fetch assignments", { error: errorMessage });

      return {
        success: false,
        total: 0,
        assignments: [],
        error: errorMessage,
      };
    }
  },
});

export const completeTrainingTool = createTool({
  id: "complete-training",

  description:
    "Marks a training assignment as completed with optional assessment score.",

  inputSchema: z.object({
    assignmentId: z.number().describe("ID of the training assignment"),
    assessmentScore: z.number().optional().describe("Assessment score (0-100)"),
    notes: z.string().optional().describe("Completion notes"),
    verifiedBy: z.string().optional().describe("Person verifying the completion"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
    passed: z.boolean().optional(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("✅ [completeTrainingTool] Completing training assignment...", {
      assignmentId: context.assignmentId,
      assessmentScore: context.assessmentScore,
    });

    try {
      const updates: Partial<TrainingAssignment> = {
        status: 'completed',
        completion_date: new Date(),
        notes: context.notes,
        verified_by: context.verifiedBy,
      };

      if (context.assessmentScore !== undefined) {
        updates.assessment_score = context.assessmentScore;
        updates.assessment_passed = context.assessmentScore >= 70;
      }

      const updated = await updateTrainingAssignment(context.assignmentId, updates);

      if (!updated) {
        return {
          success: false,
          message: "Training assignment not found",
        };
      }

      logger?.info("✅ [completeTrainingTool] Training completed", {
        assignmentId: context.assignmentId,
        passed: updates.assessment_passed,
      });

      return {
        success: true,
        message: "Training completed successfully",
        passed: updates.assessment_passed,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [completeTrainingTool] Failed to complete training", { error: errorMessage });

      return {
        success: false,
        message: "Failed to complete training",
        error: errorMessage,
      };
    }
  },
});
