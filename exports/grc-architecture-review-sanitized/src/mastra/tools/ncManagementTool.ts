import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  createNonconformance,
  getNonconformances,
  NonconformanceRecord
} from "../../utils/qmsDatabase";

export const createNcTool = createTool({
  id: "create-nonconformance",

  description:
    "Creates a new Nonconformance (NC) record. NC records track quality deviations, " +
    "process failures, and issues that don't meet established standards.",

  inputSchema: z.object({
    title: z.string().describe("Title of the nonconformance"),
    description: z.string().optional().describe("Detailed description of the nonconformance"),
    ncType: z.string().describe("Type of nonconformance (e.g., 'data_quality', 'process_deviation', 'sla_breach')"),
    category: z.string().optional().describe("Category of the nonconformance"),
    sourceType: z.string().optional().describe("Source of the NC (e.g., 'deal_evaluation', 'audit', 'inspection')"),
    sourceId: z.string().optional().describe("ID of the source record"),
    sourceReference: z.string().optional().describe("Reference name for the source"),
    severity: z.enum(["critical", "major", "minor", "observation"]).describe("Severity level"),
    detectedBy: z.string().optional().describe("Person or system that detected the NC"),
    criteriaViolations: z.array(z.object({
      criteriaId: z.string(),
      criteriaName: z.string(),
      dimension: z.string().optional(),
    })).optional().describe("List of criteria that were violated"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    ncNumber: z.string().optional(),
    ncId: z.number().optional(),
    message: z.string(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [createNcTool] Creating new Nonconformance record...", {
      title: context.title,
      severity: context.severity,
      ncType: context.ncType,
    });

    try {
      const nc = await createNonconformance({
        title: context.title,
        description: context.description,
        nc_type: context.ncType,
        category: context.category,
        source_type: context.sourceType,
        source_id: context.sourceId,
        source_reference: context.sourceReference,
        severity: context.severity,
        status: 'open',
        detected_by: context.detectedBy || 'System',
        criteria_violations: context.criteriaViolations,
      });

      logger?.info("✅ [createNcTool] NC created successfully", {
        ncNumber: nc.nc_number,
        ncId: nc.id,
      });

      return {
        success: true,
        ncNumber: nc.nc_number,
        ncId: nc.id,
        message: `Nonconformance ${nc.nc_number} created successfully`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [createNcTool] Failed to create NC", { error: errorMessage });

      return {
        success: false,
        message: "Failed to create Nonconformance",
        error: errorMessage,
      };
    }
  },
});

export const getNcListTool = createTool({
  id: "get-nonconformance-list",

  description:
    "Retrieves a list of Nonconformance records with optional filtering by status or severity.",

  inputSchema: z.object({
    status: z.enum(["open", "under_review", "disposition", "capa_required", "closed", "rejected"]).optional(),
    severity: z.enum(["critical", "major", "minor", "observation"]).optional(),
    limit: z.number().optional().describe("Maximum number of records to return (default: 50)"),
    offset: z.number().optional().describe("Number of records to skip (for pagination)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    total: z.number(),
    records: z.array(z.object({
      id: z.number(),
      ncNumber: z.string(),
      title: z.string(),
      ncType: z.string(),
      category: z.string().optional(),
      severity: z.string(),
      status: z.string(),
      detectedBy: z.string().optional(),
      detectedDate: z.string().optional(),
    })),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info("📋 [getNcListTool] Fetching NC records...", {
      status: context.status,
      severity: context.severity,
    });

    try {
      const { records, total } = await getNonconformances({
        limit: context.limit || 50,
        offset: context.offset || 0,
        status: context.status,
        severity: context.severity,
      });

      logger?.info("✅ [getNcListTool] NC records fetched", { total });

      return {
        success: true,
        total,
        records: records.map(r => ({
          id: r.id!,
          ncNumber: r.nc_number,
          title: r.title,
          ncType: r.nc_type,
          category: r.category,
          severity: r.severity,
          status: r.status,
          detectedBy: r.detected_by,
          detectedDate: r.detected_date?.toISOString(),
        })),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger?.error("❌ [getNcListTool] Failed to fetch NC records", { error: errorMessage });

      return {
        success: false,
        total: 0,
        records: [],
        error: errorMessage,
      };
    }
  },
});
