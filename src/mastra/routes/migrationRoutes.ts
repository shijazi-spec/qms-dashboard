import { logger as safeLogger } from "../../utils/logger";
export const migrationRoutes = [
  {
    path: "/api/migration/jobs",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getAllMigrationJobs, initMigrationTables } =
            await import("../../utils/migrationDatabase");
          await initMigrationTables();

          const url = new URL(c.req.url);
          const status = url.searchParams.get("status") || undefined;
          const target_module =
            url.searchParams.get("target_module") || undefined;

          logger?.info("📋 [MigrationAPI] GET /api/migration/jobs");
          const result = await getAllMigrationJobs({ status, target_module });
          return c.json(result);
        } catch (error) {
          safeLogger.error("❌ [MigrationAPI] Error fetching jobs:", error);
          return c.json({ error: "Failed to fetch migration jobs" }, 500);
        }
      };
    },
  },
  {
    path: "/api/migration/summary",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getMigrationSummary, initMigrationTables } =
            await import("../../utils/migrationDatabase");
          await initMigrationTables();

          logger?.info("📊 [MigrationAPI] GET /api/migration/summary");
          const summary = await getMigrationSummary();
          return c.json(summary);
        } catch (error) {
          safeLogger.error("❌ [MigrationAPI] Error fetching summary:", error);
          return c.json({ error: "Failed to fetch migration summary" }, 500);
        }
      };
    },
  },
  {
    path: "/api/migration/templates",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getTemplates, initMigrationTables } =
            await import("../../utils/migrationDatabase");
          await initMigrationTables();

          const url = new URL(c.req.url);
          const targetModule =
            url.searchParams.get("target_module") || undefined;

          logger?.info("📋 [MigrationAPI] GET /api/migration/templates");
          const templates = await getTemplates(targetModule);
          return c.json({ templates });
        } catch (error) {
          safeLogger.error(
            "❌ [MigrationAPI] Error fetching templates:",
            error,
          );
          return c.json({ error: "Failed to fetch templates" }, 500);
        }
      };
    },
  },
  {
    path: "/api/migration/dedup-rules",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getDeduplicationRules, initMigrationTables } =
            await import("../../utils/migrationDatabase");
          await initMigrationTables();

          const url = new URL(c.req.url);
          const targetModule =
            url.searchParams.get("target_module") || undefined;

          logger?.info("📋 [MigrationAPI] GET /api/migration/dedup-rules");
          const rules = await getDeduplicationRules(targetModule);
          return c.json({ rules });
        } catch (error) {
          safeLogger.error("❌ [MigrationAPI] Error fetching rules:", error);
          return c.json({ error: "Failed to fetch deduplication rules" }, 500);
        }
      };
    },
  },
  {
    path: "/api/migration/jobs",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const { createMigrationJob, initMigrationTables } =
            await import("../../utils/migrationDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initMigrationTables();

          const body = await c.req.json();
          logger?.info("📝 [MigrationAPI] POST /api/migration/jobs", {
            name: body.name,
            by: sessionUser.email,
          });

          if (!body.name || !body.source_type || !body.target_module) {
            return c.json({ error: "Missing required fields" }, 400);
          }

          const jobCode = "MIG-" + Date.now().toString(36).toUpperCase();
          const job = await createMigrationJob({
            ...body,
            job_code: jobCode,
            created_by: sessionUser.email,
          });

          await logEvent({
            entityType: "MIGRATION",
            entityId: job.id!.toString(),
            actionType: "CREATE",
            description: `Migration job created: ${job.name} (${job.target_module})`,
            newValue: JSON.stringify(job),
            userName: sessionUser.email,
            severity: "INFO",
            module: "migration",
          });

          return c.json({ success: true, job });
        } catch (error: any) {
          safeLogger.error("❌ [MigrationAPI] Error creating job:", error);
          return c.json({ error: "Failed to create migration job" }, 500);
        }
      };
    },
  },
  {
    path: "/api/migration/jobs/:id",
    method: "GET" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getMigrationJobById, initMigrationTables } =
            await import("../../utils/migrationDatabase");
          await initMigrationTables();

          const id = parseInt(c.req.param("id"));
          logger?.info("📋 [MigrationAPI] GET /api/migration/jobs/:id", { id });

          const job = await getMigrationJobById(id);
          if (!job) {
            return c.json({ error: "Migration job not found" }, 404);
          }

          return c.json({ job });
        } catch (error) {
          safeLogger.error("❌ [MigrationAPI] Error fetching job:", error);
          return c.json({ error: "Failed to fetch migration job" }, 500);
        }
      };
    },
  },
  {
    path: "/api/migration/jobs/:id",
    method: "PUT" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const { requireWriteRole, forbiddenResponse, unauthorizedResponse } =
            await import("../../utils/rbacMiddleware");
          const sessionUser = requireWriteRole(c);
          if (!sessionUser) return unauthorizedResponse(c);

          const logger = mastra?.getLogger();
          const {
            updateMigrationJob,
            getMigrationJobById,
            initMigrationTables,
          } = await import("../../utils/migrationDatabase");
          const { logEvent } = await import("../../utils/eventLogsDatabase");
          await initMigrationTables();

          const id = parseInt(c.req.param("id"));
          const body = await c.req.json();
          logger?.info("📝 [MigrationAPI] PUT /api/migration/jobs/:id", {
            id,
            by: sessionUser.email,
          });

          const existing = await getMigrationJobById(id);
          if (!existing) {
            return c.json({ error: "Migration job not found" }, 404);
          }

          const job = await updateMigrationJob(id, body);

          await logEvent({
            entityType: "MIGRATION",
            entityId: id.toString(),
            actionType: "UPDATE",
            description: `Migration job updated: ${job.name} (Status: ${job.status})`,
            oldValue: JSON.stringify(existing),
            newValue: JSON.stringify(job),
            userName: sessionUser.email,
            severity: job.status === "failed" ? "WARNING" : "INFO",
            module: "migration",
          });

          return c.json({ success: true, job });
        } catch (error) {
          safeLogger.error("❌ [MigrationAPI] Error updating job:", error);
          return c.json({ error: "Failed to update migration job" }, 500);
        }
      };
    },
  },
  {
    path: "/api/migration/validate-csv",
    method: "POST" as const,
    createHandler: async ({ mastra }: any) => {
      return async (c: any) => {
        try {
          const logger = mastra?.getLogger();
          const { getTemplates, initMigrationTables } =
            await import("../../utils/migrationDatabase");
          await initMigrationTables();

          const body = await c.req.json();
          logger?.info("📝 [MigrationAPI] POST /api/migration/validate-csv");

          const { headers, targetModule } = body;
          if (!headers || !targetModule) {
            return c.json({ error: "Missing headers or targetModule" }, 400);
          }

          const templates = await getTemplates(targetModule);
          if (templates.length === 0) {
            return c.json(
              { error: "No template found for target module" },
              404,
            );
          }

          const template = templates[0];
          const fieldMapping = JSON.parse(template.field_mapping as string);

          const suggestedMappings: Record<string, string> = {};
          const unmappedFields: string[] = [];

          for (const header of headers) {
            const normalizedHeader = header.trim();
            if (fieldMapping.mappings[normalizedHeader]) {
              suggestedMappings[normalizedHeader] =
                fieldMapping.mappings[normalizedHeader];
            } else {
              const lowerHeader = normalizedHeader.toLowerCase();
              let found = false;
              for (const [key, value] of Object.entries(
                fieldMapping.mappings,
              )) {
                if (key.toLowerCase() === lowerHeader) {
                  suggestedMappings[normalizedHeader] = value as string;
                  found = true;
                  break;
                }
              }
              if (!found) {
                unmappedFields.push(normalizedHeader);
              }
            }
          }

          const missingRequired = fieldMapping.required.filter(
            (req: string) => !Object.values(suggestedMappings).includes(req),
          );

          return c.json({
            success: true,
            template: template.name,
            suggestedMappings,
            unmappedFields,
            missingRequired,
            requiredFields: fieldMapping.required,
            optionalFields: fieldMapping.optional,
            isValid: missingRequired.length === 0,
          });
        } catch (error) {
          safeLogger.error("❌ [MigrationAPI] Error validating CSV:", error);
          return c.json({ error: "Failed to validate CSV" }, 500);
        }
      };
    },
  },
];
