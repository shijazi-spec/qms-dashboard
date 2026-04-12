import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";
import { NonRetriableError } from "inngest";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";

import { registerCronTrigger } from "../triggers/cronTriggers";
import { qualitySpecialistAgent } from "./agents/qualitySpecialistAgent";
import { sdrQualityAgent } from "./agents/sdrQualityAgent";
import { salesQualityAgent } from "./agents/salesQualityAgent";
import { qualityAuditWorkflow } from "./workflows/qualityAuditWorkflow";
import { createDashboardRoutes } from "./routes/dashboardRoutes";
import { callIntelligenceRoutes } from "./routes/callIntelligenceRoutes";
import { roiRoutes } from "./routes/roiRoutes";
import { teamRoutes } from "./routes/teamRoutes";
import { pmpRoutes } from "./routes/pmpRoutes";
import { eventLogsRoutes } from "./routes/eventLogsRoutes";
import { onboardingRoutes } from "./routes/onboardingRoutes";
import { riskRoutes } from "./routes/riskRoutes";
import { policyRoutes } from "./routes/policyRoutes";
import { complianceRoutes } from "./routes/complianceRoutes";
import { auditRoutes } from "./routes/auditRoutes";
import { vendorRoutes } from "./routes/vendorRoutes";
import { migrationRoutes } from "./routes/migrationRoutes";
import { handoffRoutes } from "./routes/handoffRoutes";
import { kpiRoutes } from "./routes/kpiRoutes";
import { duplicateRadarRoutes } from "./routes/duplicateRadarRoutes";
import { rbacRoutes } from "./routes/rbacRoutes";
import { scorecardRoutes } from "./routes/scorecardRoutes";
import { pdplRoutes } from "./routes/pdplRoutes";
import { triggerRoutes } from "./routes/triggerRoutes";
import { userAccessRoutes } from "./routes/userAccessRoutes";
import { smokeTestRoutes } from "./routes/smokeTestRoutes";
import { authRoutes, getSessionFromCookie } from "./routes/authRoutes";
import { consultantRoutes } from "./routes/consultantRoutes";
import { qmsEnhancedRoutes } from "./routes/qmsEnhancedRoutes";
import { notificationRoutes } from "./routes/notificationRoutes";
import { knowledgeRoutes } from "./routes/knowledgeRoutes";
import { qmsConsultantAgent } from "./agents/qmsConsultantAgent";
import { sanitizeRequestBody } from "../utils/inputSanitizer";
import { checkRateLimit } from "../utils/rateLimiter";
import { randomBytes } from "crypto";

registerCronTrigger({
  cronExpression: process.env.SCHEDULE_CRON_EXPRESSION || "0 8 * * 1",
  workflow: qualityAuditWorkflow,
});

class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(
    options: {
      name?: string;
      level?: LogLevel;
    } = {},
  ) {
    super(options);

    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label: string, _number: number) => ({
          level: label,
        }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }

  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }

  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }

  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
}

export const mastra = new Mastra({
  storage: sharedPostgresStorage,
  workflows: { qualityAuditWorkflow },
  agents: { qualitySpecialistAgent, qmsConsultantAgent },
  mcpServers: {
    allTools: new MCPServer({
      name: "allTools",
      version: "1.0.0",
      tools: {},
    }),
  },
  bundler: {
    // A few dependencies are not properly picked up by
    // the bundler if they are not added directly to the
    // entrypoint.
    externals: [
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
    ],
    // sourcemaps are good for debugging.
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    cors: false,
    middleware: [
      async (c, next) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.debug("[Request]", { method: c.req.method, url: c.req.url });

        const urlPath = new URL(c.req.url).pathname;
        const method = c.req.method;

        const allowedOrigins = (process.env.REPLIT_DOMAINS || '').split(',').map((d: string) => `https://${d.trim()}`).filter(Boolean);

        if (method === 'OPTIONS') {
          const origin = c.req.header('Origin') || '';
          const allowedOrigin = allowedOrigins.includes(origin) ? origin : (allowedOrigins[0] || '');
          c.header('Access-Control-Allow-Origin', allowedOrigin);
          c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
          c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Admin-Key');
          c.header('Access-Control-Allow-Credentials', 'true');
          c.header('Access-Control-Max-Age', '3600');
          return c.text('', 204);
        }

        const origin = c.req.header('Origin') || '';
        const resolvedOrigin = (origin && allowedOrigins.includes(origin)) ? origin : (allowedOrigins[0] || '');
        if (resolvedOrigin) {
          c.header('Access-Control-Allow-Origin', resolvedOrigin);
          c.header('Access-Control-Allow-Credentials', 'true');
        }

        const cspNonce = randomBytes(16).toString('base64');

        c.header('X-Content-Type-Options', 'nosniff');
        c.header('X-Frame-Options', 'DENY');
        c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
        c.header('X-XSS-Protection', '1; mode=block');
        c.header('Content-Security-Policy', `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self' https://replit.com https://accounts.google.com https://oauth2.googleapis.com; frame-ancestors 'none'; form-action 'self'`);
        c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

        (c as any)._cspNonce = cspNonce;

        const publicPaths = ['/login', '/api/auth/', '/api/login', '/api/callback', '/api/logout', '/guide', '/accept-invite', '/css/', '/js/', '/api/invitations/validate/', '/api/invitations/accept', '/api/admin/auth', '/api/health', '/api/smoke'];
        const isPublic = publicPaths.some(p => urlPath === p || urlPath.startsWith(p));

        if (urlPath === '/api/inngest' || urlPath.startsWith('/api/inngest')) {
          const adminKey = c.req.header('X-Admin-Key');
          const expectedKey = process.env.ADMIN_API_KEY;
          const hasAdminKey = expectedKey && adminKey === expectedKey;
          if (!hasAdminKey) {
            return c.json({ error: 'Access denied' }, 403);
          }
        }
        const isApi = urlPath.startsWith('/api/');
        const mastraInternalPrefixes = ['/api/workflows/', '/api/memory/'];
        const isMastraInternal = mastraInternalPrefixes.some(p => urlPath.startsWith(p)) ||
          (urlPath.startsWith('/api/agents/') && !urlPath.startsWith('/api/agents/performance'));

        let isAuthenticated = false;

        if (!isPublic && !isApi) {
          const session = getSessionFromCookie(c.req.header('Cookie'));
          const adminKeyCookieVal = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
          const expectedKey = process.env.ADMIN_API_KEY;
          const hasAdminCookie = expectedKey && adminKeyCookieVal === expectedKey;
          if (!session && !hasAdminCookie) {
            return c.redirect('/login');
          }
          isAuthenticated = true;
        }

        if (isApi && !isPublic && !isMastraInternal) {
          const session = getSessionFromCookie(c.req.header('Cookie'));
          const adminKeyHeader = c.req.header('X-Admin-Key');
          const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
          const adminKey = adminKeyHeader || adminKeyCookie;
          const expectedAdminKey = process.env.ADMIN_API_KEY;
          const hasAdminKey = expectedAdminKey && adminKey === expectedAdminKey;

          isAuthenticated = !!(session || hasAdminKey);

          const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
          const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
          const rateCheck = checkRateLimit(ip, isWrite, urlPath, isAuthenticated);
          if (!rateCheck.allowed) {
            c.header('Retry-After', String(rateCheck.retryAfter || 60));
            return c.json({ error: 'Too many requests' }, 429);
          }

          if (!session && !hasAdminKey) {
            return c.json({ error: 'Authentication required' }, 401);
          }

          if (urlPath.startsWith('/api/admin/') || urlPath === '/api/admin') {
            if (!hasAdminKey) {
              return c.json({ error: 'X-Admin-Key header required for admin endpoints' }, 403);
            }
          }

          if (!hasAdminKey && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            const { enforceRoutePermission } = await import('../utils/rbacMiddleware');
            const result = await enforceRoutePermission(c, urlPath, method);
            if (!result.allowed) {
              return c.json({ error: result.error || 'Insufficient permissions' }, 403);
            }
          }
        } else if (isApi) {
          const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
          const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
          const rateCheck = checkRateLimit(ip, isWrite, urlPath, isPublic ? false : true);
          if (!rateCheck.allowed) {
            c.header('Retry-After', String(rateCheck.retryAfter || 60));
            return c.json({ error: 'Too many requests' }, 429);
          }
        }

        if (isApi && ['POST', 'PUT', 'PATCH'].includes(method)) {
          try {
            const contentType = c.req.header('Content-Type') || '';
            if (contentType.includes('application/json')) {
              const rawBody = await c.req.json();
              const sanitized = sanitizeRequestBody(rawBody, urlPath);
              const sanitizedJson = JSON.stringify(sanitized);
              const newRequest = new Request(c.req.url, {
                method: c.req.method,
                headers: c.req.raw.headers,
                body: sanitizedJson,
              });
              (c.req as any).raw = newRequest;
              (c.req as any).bodyCache = {};
              (c.req as any).cachedBody = undefined;
            }
          } catch (e) {
          }
        }

        try {
          await next();
        } catch (error) {
          logger?.error("[Response]", {
            method: c.req.method,
            url: c.req.url,
          });
          if (error instanceof MastraError) {
            if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
              throw new NonRetriableError(error.message, { cause: error });
            }
          } else if (error instanceof z.ZodError) {
            throw new NonRetriableError(error.message, { cause: error });
          }

          throw error;
        }

        if (isApi && !isPublic && !isMastraInternal && c.res.status === 404) {
          return c.json({ error: 'Insufficient permissions' }, 403);
        }

        const contentType = c.res.headers.get('Content-Type') || '';
        if (contentType.includes('text/html') && c.res.body) {
          try {
            const originalBody = await c.res.text();
            const nonceInjected = originalBody.replace(/<script(?!\s+nonce=)/gi, `<script nonce="${cspNonce}"`);
            c.res = new Response(nonceInjected, {
              status: c.res.status,
              headers: c.res.headers,
            });
          } catch (_e) {
          }
        }
      },
    ],
    apiRoutes: [
      // ======================================================================
      // Inngest Integration Endpoint
      // ======================================================================
      // Integrates Mastra workflows with Inngest for event-driven execution via inngest functions.
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
      },
      
      // ======================================================================
      // Dashboard API Endpoints
      // ======================================================================
      {
        path: "/api/dashboard",
        method: "GET",
        createHandler: async () => {
          const { getDashboardData } = await import("../utils/database");
          return async (c: any) => {
            try {
              const data = await getDashboardData();
              return c.json(data);
            } catch (error) {
              console.error("Error fetching dashboard data:", error);
              return c.json({ error: "Failed to fetch dashboard data" }, 500);
            }
          };
        },
      },
      {
        path: "/api/audit/latest",
        method: "GET",
        createHandler: async () => {
          const { getLatestAuditResult } = await import("../utils/database");
          return async (c: any) => {
            try {
              const result = await getLatestAuditResult();
              if (!result) {
                return c.json({ message: "No audit results found" }, 404);
              }
              return c.json(result);
            } catch (error) {
              console.error("Error fetching latest audit:", error);
              return c.json({ error: "Failed to fetch latest audit" }, 500);
            }
          };
        },
      },
      {
        path: "/api/audit/history",
        method: "GET",
        createHandler: async () => {
          const { getAuditHistory } = await import("../utils/database");
          return async (c: any) => {
            try {
              const limit = parseInt(c.req.query("limit") || "20");
              const history = await getAuditHistory(limit);
              return c.json(history);
            } catch (error) {
              console.error("Error fetching audit history:", error);
              return c.json({ error: "Failed to fetch audit history" }, 500);
            }
          };
        },
      },
      {
        path: "/api/scorecards",
        method: "GET",
        createHandler: async () => {
          const { getActiveScorecardsAll } = await import("../utils/database");
          return async (c: any) => {
            try {
              console.log('📊 [API] Fetching all active scorecards...');
              const scorecards = await getActiveScorecardsAll();
              console.log(`✅ [API] Found ${scorecards.length} active scorecards`);
              return c.json({
                success: true,
                scorecards,
                count: scorecards.length
              });
            } catch (error) {
              console.error("Error fetching scorecards:", error);
              return c.json({ error: "Failed to fetch scorecards" }, 500);
            }
          };
        },
      },
      {
        path: "/api/integrations/status",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const hasOAuthConfig = !!(
                process.env.ZOHO_CLIENT_ID &&
                process.env.ZOHO_CLIENT_SECRET &&
                process.env.ZOHO_REFRESH_TOKEN
              );
              const hasStaticToken = !!process.env.ZOHO_ACCESS_TOKEN;
              const hasGoogleCalendar = !!(
                process.env.GOOGLE_CLIENT_ID ||
                process.env.GOOGLE_CLIENT_EMAIL
              );
              
              return c.json({
                zoho: {
                  connected: hasOAuthConfig || hasStaticToken,
                  message: (hasOAuthConfig || hasStaticToken) ? 'Connected' : 'Not configured'
                },
                googleCalendar: {
                  connected: hasGoogleCalendar,
                  message: hasGoogleCalendar ? 'Connected' : 'Not configured'
                },
                email: {
                  connected: true,
                  message: 'Replit Mail configured'
                }
              });
            } catch (error) {
              console.error("Error checking integration status:", error);
              return c.json({ error: "Failed to check integration status" }, 500);
            }
          };
        },
      },
      {
        path: "/api/crm/data",
        method: "GET",
        createHandler: async ({ mastra }) => {
          const { fetchZohoRecords, getZohoConnectionStatus } = await import("../utils/zohoCRM");
          return async (c: any) => {
            const logger = mastra?.getLogger();
            try {
              const module = c.req.query("module") || "Leads";
              const page = parseInt(c.req.query("page") || "1");
              const perPage = parseInt(c.req.query("per_page") || "50");
              
              logger?.info("📊 [API] Fetching CRM data", { module, page, perPage });
              
              const status = getZohoConnectionStatus();
              if (!status.configured) {
                return c.json({ 
                  success: false,
                  error: "Zoho CRM not configured",
                  message: status.message
                }, 400);
              }
              
              const records = await fetchZohoRecords(module, { page, perPage });
              
              logger?.info("✅ [API] CRM data fetched", { module, count: records.length });
              
              return c.json({
                success: true,
                module,
                page,
                perPage,
                count: records.length,
                records: records.map(r => ({
                  id: r.id,
                  owner: r.owner,
                  createdTime: r.createdTime,
                  modifiedTime: r.modifiedTime,
                  ...r.data
                }))
              });
            } catch (error) {
              logger?.error("❌ [API] CRM data fetch error", { error });
              console.error("Error fetching CRM data:", error);
              return c.json({ 
                success: false,
                error: "Failed to fetch CRM data"
              }, 500);
            }
          };
        },
      },
      {
        path: "/api/governance",
        method: "GET",
        createHandler: async () => {
          const { getActiveGovernanceDocument } = await import("../utils/database");
          return async (c: any) => {
            try {
              const doc = await getActiveGovernanceDocument();
              if (!doc) {
                return c.json({ message: "No governance document found" }, 404);
              }
              return c.json(doc);
            } catch (error) {
              console.error("Error fetching governance document:", error);
              return c.json({ error: "Failed to fetch governance document" }, 500);
            }
          };
        },
      },
      {
        path: "/api/scorecard",
        method: "GET",
        createHandler: async () => {
          const { getActiveScorecard } = await import("../utils/database");
          return async (c: any) => {
            try {
              const crmModule = c.req.query('crm_module') || null;
              const teamName = c.req.query('team_name') || null;
              const scorecard = await getActiveScorecard(crmModule, teamName);
              if (!scorecard) {
                return c.json({ message: "No scorecard found" }, 404);
              }
              return c.json(scorecard);
            } catch (error) {
              console.error("Error fetching scorecard:", error);
              return c.json({ error: "Failed to fetch scorecard" }, 500);
            }
          };
        },
      },
      {
        path: "/api/audit/trigger",
        method: "POST",
        createHandler: async ({ mastra }) => {
          const lastTriggerTime: { value: number } = { value: 0 };
          const MIN_INTERVAL_MS = 60000;
          
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();

              const session = getSessionFromCookie(c.req.header('Cookie'));
              const adminKeyHeader = c.req.header('X-Admin-Key');
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const adminKey = adminKeyHeader || adminKeyCookie;
              const expectedAdminKey = process.env.ADMIN_API_KEY;
              const hasAdminKey = expectedAdminKey && adminKey === expectedAdminKey;
              
              if (!session && !hasAdminKey) {
                return c.json({ error: 'Authentication required' }, 401);
              }
              
              const now = Date.now();
              if (now - lastTriggerTime.value < MIN_INTERVAL_MS) {
                const waitSeconds = Math.ceil((MIN_INTERVAL_MS - (now - lastTriggerTime.value)) / 1000);
                logger?.warn("⚠️ [API] Rate limit: Audit trigger rejected", { waitSeconds });
                return c.json({ 
                  success: false, 
                  error: `Please wait ${waitSeconds} seconds before triggering another audit.` 
                }, 429);
              }
              
              const userEmail = session?.email || 'admin-key';
              logger?.info("🚀 [API] Manual audit trigger requested", { by: userEmail });
              lastTriggerTime.value = now;
              
              try {
                await inngest.send({
                  name: "replit/cron.trigger",
                  data: {
                    workflowId: "quality-audit-workflow",
                    manualTrigger: true,
                    triggeredBy: userEmail,
                    triggeredAt: new Date().toISOString()
                  }
                });
                logger?.info("✅ [API] Audit trigger event sent via Inngest");
                return c.json({ 
                  success: true, 
                  message: "Quality audit triggered successfully. Results will be available shortly." 
                });
              } catch (inngestError) {
                logger?.warn("⚠️ [API] Inngest dispatch failed, falling back to direct execution", {
                  error: inngestError instanceof Error ? inngestError.message : String(inngestError)
                });
              }

              (async () => {
                try {
                  const { runDirectAudit } = await import("../utils/directAuditRunner");
                  await runDirectAudit(logger);
                  logger?.info("✅ [API] Direct audit completed");
                } catch (err) {
                  console.error("Direct audit execution error:", err);
                }
              })();
              logger?.info("✅ [API] Audit triggered via direct execution (fallback)");

              return c.json({ 
                success: true, 
                message: "Quality audit triggered successfully. Results will be available shortly." 
              });
            } catch (error) {
              console.error("Error triggering audit:", error);
              return c.json({ 
                success: false, 
                error: "Failed to trigger audit" 
              }, 500);
            }
          };
        },
      },
      // ======================================================================
      // Agent Performance API - Real Lead Owner Data from CRM
      // ======================================================================
      {
        path: "/api/agents/performance",
        method: "GET",
        createHandler: async () => {
          const { getLeadsWithSeparateFilters, getDealsWithSeparateFilters, getUsers, getDataMode } = await import("../data");
          return async (c: any) => {
            try {
              // Parse separate date filters from query params
              const createdStart = c.req.query("createdStart");
              const createdEnd = c.req.query("createdEnd");
              const modifiedStart = c.req.query("modifiedStart");
              const modifiedEnd = c.req.query("modifiedEnd");
              
              // Build separate date filters object
              const dateFilters = {
                created: { start: createdStart || null, end: createdEnd || null },
                modified: { start: modifiedStart || null, end: modifiedEnd || null }
              };
              
              // Validate date formats (YYYY-MM-DD) if provided
              const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
              const datesToValidate = [createdStart, createdEnd, modifiedStart, modifiedEnd].filter(Boolean);
              
              for (const dateStr of datesToValidate) {
                if (dateStr && !dateRegex.test(dateStr)) {
                  return c.json({
                    success: false,
                    error: `Invalid date format: ${dateStr}. Use YYYY-MM-DD (e.g., 2024-11-01)`,
                  }, 400);
                }
              }
              
              // Validate created range
              if (createdStart && createdEnd && new Date(createdStart) > new Date(createdEnd)) {
                return c.json({
                  success: false,
                  error: "Created start date must be before or equal to created end date.",
                }, 400);
              }
              
              // Validate modified range
              if (modifiedStart && modifiedEnd && new Date(modifiedStart) > new Date(modifiedEnd)) {
                return c.json({
                  success: false,
                  error: "Modified start date must be before or equal to modified end date.",
                }, 400);
              }
              
              console.log('📊 [API] Fetching agent performance from CRM Lead Owners...');
              if (createdStart || modifiedStart) {
                console.log(`📅 [API] Date filters applied:`, dateFilters);
              }
              
              const mode = getDataMode();
              const { leads, coverage: leadsCoverage } = await getLeadsWithSeparateFilters(dateFilters);
              const { deals, coverage: dealsCoverage } = await getDealsWithSeparateFilters(dateFilters);
              const users = await getUsers();
              
              const userMap: Record<string, { name: string; team: string; role: string }> = {};
              for (const user of users) {
                userMap[user.id] = { name: user.name, team: user.team, role: user.role };
              }
              
              const ownerStats: Record<string, {
                id: string;
                name: string;
                team: string;
                role: string;
                recordsAudited: number;
                issues: { critical: number; high: number; medium: number; low: number };
                passCount: number;
              }> = {};
              
              for (const lead of leads) {
                const ownerId = lead.Owner || 'Unassigned';
                const userInfo = userMap[ownerId] || { name: ownerId, team: 'SDR', role: 'SDR Representative' };
                
                if (!ownerStats[ownerId]) {
                  ownerStats[ownerId] = {
                    id: ownerId,
                    name: userInfo.name,
                    team: userInfo.team,
                    role: userInfo.role,
                    recordsAudited: 0,
                    issues: { critical: 0, high: 0, medium: 0, low: 0 },
                    passCount: 0
                  };
                }
                ownerStats[ownerId].recordsAudited++;
                
                const hasIssue = !lead.Email || !lead.Lead_Source || !lead.Lead_Status;
                if (hasIssue) {
                  if (!lead.Email) ownerStats[ownerId].issues.high++;
                  if (!lead.Lead_Source) ownerStats[ownerId].issues.medium++;
                  if (!lead.Lead_Status) ownerStats[ownerId].issues.low++;
                } else {
                  ownerStats[ownerId].passCount++;
                }
              }
              
              for (const deal of deals) {
                const ownerId = deal.Owner || 'Unassigned';
                const userInfo = userMap[ownerId] || { name: ownerId, team: 'Sales', role: 'Account Executive' };
                
                if (!ownerStats[ownerId]) {
                  ownerStats[ownerId] = {
                    id: ownerId,
                    name: userInfo.name,
                    team: userInfo.team,
                    role: userInfo.role,
                    recordsAudited: 0,
                    issues: { critical: 0, high: 0, medium: 0, low: 0 },
                    passCount: 0
                  };
                }
                ownerStats[ownerId].recordsAudited++;
                
                const hasIssue = !deal.Deal_Name || !deal.Stage || !deal.Amount;
                if (hasIssue) {
                  if (!deal.Deal_Name) ownerStats[ownerId].issues.critical++;
                  if (!deal.Stage) ownerStats[ownerId].issues.critical++;
                  if (!deal.Amount) ownerStats[ownerId].issues.high++;
                } else {
                  ownerStats[ownerId].passCount++;
                }
              }
              
              const agents = Object.values(ownerStats)
                .filter(a => a.id && a.id !== 'Unassigned' && a.recordsAudited > 0)
                .map(agent => {
                  const weightedIssues = (agent.issues.critical * 4) + (agent.issues.high * 3) + (agent.issues.medium * 2) + agent.issues.low;
                  const maxWeight = agent.recordsAudited * 4;
                  const score = maxWeight > 0 ? Math.max(0, Math.round((1 - weightedIssues / maxWeight) * 100)) : 100;
                  
                  return {
                    id: agent.id,
                    name: agent.name,
                    team: agent.team,
                    role: agent.role,
                    score,
                    recordsAudited: agent.recordsAudited,
                    issues: agent.issues
                  };
                })
                .sort((a, b) => b.score - a.score);
              
              console.log(`✅ [API] Found ${agents.length} agents from CRM Lead Owners`);
              console.log(`📊 [API] Coverage - Leads: ${leadsCoverage.recordsAudited}/${leadsCoverage.totalRecordsInCRM}, Deals: ${dealsCoverage.recordsAudited}/${dealsCoverage.totalRecordsInCRM}`);
              
              return c.json({
                success: true,
                agents,
                totalLeads: leads.length,
                totalDeals: deals.length,
                coverage: {
                  leads: leadsCoverage,
                  deals: dealsCoverage,
                  combined: {
                    totalRecordsInCRM: leadsCoverage.totalRecordsInCRM + dealsCoverage.totalRecordsInCRM,
                    recordsAudited: leadsCoverage.recordsAudited + dealsCoverage.recordsAudited,
                    recordsExcluded: leadsCoverage.recordsExcluded + dealsCoverage.recordsExcluded,
                    separateFiltersApplied: dateFilters
                  }
                }
              });
            } catch (error: any) {
              console.error('❌ [API] Error fetching agent performance:', error);
              return c.json({ 
                success: false, 
                error: 'Failed to fetch agent performance',
                agents: [] 
              }, 500);
            }
          };
        },
      },
      // ======================================================================
      // Auth Routes
      // ======================================================================
      ...authRoutes,
      {
        path: "/login",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "login.html"),
                join(process.cwd(), "..", "dashboard", "login.html"),
                "/home/runner/workspace/dashboard/login.html",
              ];
              for (const loginPath of possiblePaths) {
                if (existsSync(loginPath)) {
                  const html = readFileSync(loginPath, "utf-8");
                  return c.html(html);
                }
              }
              return c.text("Login page not found", 404);
            } catch (error) {
              console.error("Error serving login page:", error);
              return c.text("Error loading login page", 500);
            }
          };
        },
      },
      // ======================================================================
      // Root Route - Serves Dashboard as Main Landing Page
      // ======================================================================
      {
        path: "/",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "index.html"),
                join(process.cwd(), "..", "dashboard", "index.html"),
                join(process.cwd(), "..", "..", "dashboard", "index.html"),
                "/home/runner/workspace/dashboard/index.html",
              ];
              
              for (const dashboardPath of possiblePaths) {
                if (existsSync(dashboardPath)) {
                  const html = readFileSync(dashboardPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text(`Dashboard not found. Searched paths: ${possiblePaths.join(", ")}`, 404);
            } catch (error) {
              console.error("Error serving dashboard:", error);
              return c.text("Error loading dashboard", 500);
            }
          };
        },
      },
      {
        path: "/dashboard",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "index.html"),
                join(process.cwd(), "..", "dashboard", "index.html"),
                join(process.cwd(), "..", "..", "dashboard", "index.html"),
                "/home/runner/workspace/dashboard/index.html",
              ];
              
              for (const dashboardPath of possiblePaths) {
                if (existsSync(dashboardPath)) {
                  const html = readFileSync(dashboardPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text(`Dashboard not found. Searched paths: ${possiblePaths.join(", ")}`, 404);
            } catch (error) {
              console.error("Error serving dashboard:", error);
              return c.text("Error loading dashboard", 500);
            }
          };
        },
      },
      {
        path: "/admin",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const adminKey = process.env.ADMIN_API_KEY;
              const providedKey = c.req.header('X-Admin-Key');
              const session = getSessionFromCookie(c.req.header('Cookie'));
              if (!adminKey || !providedKey || providedKey !== adminKey || !session || session.role !== 'admin') {
                return c.html(`
                  <!DOCTYPE html>
                  <html><head><title>Admin Setup Required</title>
                  <script src="https://cdn.tailwindcss.com"></script></head>
                  <body class="bg-gray-50 min-h-screen flex items-center justify-center">
                    <div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center">
                      <div class="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg class="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                        </svg>
                      </div>
                      <h1 class="text-xl font-bold text-gray-900 mb-2">Admin Setup Required</h1>
                      <p class="text-gray-600 mb-4">To access the admin panel, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret in your environment.</p>
                      <a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a>
                    </div>
                  </body></html>
                `);
              }
              
              const possiblePaths = [
                join(process.cwd(), "dashboard", "admin.html"),
                join(process.cwd(), "..", "dashboard", "admin.html"),
                join(process.cwd(), "..", "..", "dashboard", "admin.html"),
                "/home/runner/workspace/dashboard/admin.html",
              ];
              
              for (const adminPath of possiblePaths) {
                if (existsSync(adminPath)) {
                  const html = readFileSync(adminPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Admin panel not found", 404);
            } catch (error) {
              console.error("Error serving admin panel:", error);
              return c.text("Error loading admin panel", 500);
            }
          };
        },
      },
      {
        path: "/users",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const adminKey = process.env.ADMIN_API_KEY;
              const session = getSessionFromCookie(c.req.header('Cookie'));
              if (!adminKey && !session) {
                return c.html(`
                  <!DOCTYPE html>
                  <html><head><title>Admin Setup Required</title>
                  <script src="https://cdn.tailwindcss.com"></script></head>
                  <body class="bg-gray-50 min-h-screen flex items-center justify-center">
                    <div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center">
                      <h1 class="text-xl font-bold text-gray-900 mb-2">Admin Setup Required</h1>
                      <p class="text-gray-600 mb-4">To access the Users & Access panel, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret.</p>
                      <a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a>
                    </div>
                  </body></html>
                `);
              }
              
              const possiblePaths = [
                join(process.cwd(), "dashboard", "users.html"),
                join(process.cwd(), "..", "dashboard", "users.html"),
                join(process.cwd(), "..", "..", "dashboard", "users.html"),
                "/home/runner/workspace/dashboard/users.html",
              ];
              
              for (const usersPath of possiblePaths) {
                if (existsSync(usersPath)) {
                  const html = readFileSync(usersPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Users panel not found", 404);
            } catch (error) {
              console.error("Error serving users panel:", error);
              return c.text("Error loading users panel", 500);
            }
          };
        },
      },
      {
        path: "/accept-invite",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "accept-invite.html"),
                join(process.cwd(), "..", "dashboard", "accept-invite.html"),
                join(process.cwd(), "..", "..", "dashboard", "accept-invite.html"),
                "/home/runner/workspace/dashboard/accept-invite.html",
              ];
              
              for (const invitePath of possiblePaths) {
                if (existsSync(invitePath)) {
                  const html = readFileSync(invitePath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Accept invite page not found", 404);
            } catch (error) {
              console.error("Error serving accept invite page:", error);
              return c.text("Error loading accept invite page", 500);
            }
          };
        },
      },
      {
        path: "/api/admin/auth",
        method: "POST",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const body = await c.req.json();
              const key = body?.key;
              const expectedKey = process.env.ADMIN_API_KEY;
              if (!expectedKey || !key || key !== expectedKey) {
                return c.json({ error: 'Authentication required' }, 401);
              }
              const isSecure = c.req.url.startsWith('https');
              c.header('Set-Cookie', `admin_key=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${isSecure ? '; Secure' : ''}`);
              return c.json({ success: true });
            } catch (error) {
              return c.json({ error: 'Authentication failed' }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/auth/logout",
        method: "POST",
        createHandler: async () => {
          return async (c: any) => {
            c.header('Set-Cookie', 'admin_key=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
            return c.json({ success: true });
          };
        },
      },
      {
        path: "/api/admin/documents",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const expectedKey = process.env.ADMIN_API_KEY;
              
              const hasValidAdminKey = expectedKey && adminKey === expectedKey;
              const hasSession = !!getSessionFromCookie(c.req.header('Cookie'));
              if (!hasValidAdminKey && !hasSession) {
                return c.json({ error: "Authentication required" }, 401);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📄 [Admin] Fetching all governance documents");
              const { getAllGovernanceDocuments } = await import("../utils/database");
              const documents = await getAllGovernanceDocuments();
              logger?.info("✅ [Admin] Found documents", { count: documents.length });
              return c.json(documents);
            } catch (error) {
              console.error("Error fetching documents:", error);
              return c.json({ error: "Failed to fetch documents" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/documents",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { requireAdminOrKey: rak } = await import("../utils/rbacMiddleware");
              const adminUser = rak(c);
              if (!adminUser) {
                return c.json({ error: "Admin access required" }, 403);
              }
              
              const logger = mastra?.getLogger();
              const data = await c.req.json();
              logger?.info("📄 [Admin] Uploading governance document", { name: data.name, version: data.version });
              
              const { saveGovernanceDocument, logAdminActivity } = await import("../utils/database");
              const doc = await saveGovernanceDocument({
                name: data.name,
                document_type: data.document_type || 'sales',
                version: data.version,
                file_path: data.file_path || null,
                content_text: data.content_text,
                rules_json: data.rules_json,
                is_active: data.is_active !== false
              });
              
              await logAdminActivity({
                action_type: 'document_upload',
                action_description: `Uploaded governance document: ${data.name} (${data.version})`,
                target_type: 'governance_document',
                target_id: String(doc.id),
                target_name: data.name,
                metadata: { version: data.version, document_type: data.document_type || 'sales', is_active: data.is_active !== false }
              });
              
              logger?.info("✅ [Admin] Document saved", { id: doc.id });
              return c.json(doc);
            } catch (error) {
              console.error("Error saving document:", error);
              return c.json({ error: "Failed to save document" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/documents/:id/activate",
        method: "PUT",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const id = parseInt(c.req.param("id"));
              logger?.info("🔄 [Admin] Activating document", { id });
              
              const { activateGovernanceDocument, logAdminActivity } = await import("../utils/database");
              await activateGovernanceDocument(id);
              
              await logAdminActivity({
                action_type: 'document_activate',
                action_description: `Activated governance document ID: ${id}`,
                target_type: 'governance_document',
                target_id: String(id),
                metadata: { activated: true }
              });
              
              logger?.info("✅ [Admin] Document activated", { id });
              return c.json({ success: true });
            } catch (error) {
              console.error("Error activating document:", error);
              return c.json({ error: "Failed to activate document" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecard/weights",
        method: "PUT",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const weights = await c.req.json();
              logger?.info("⚖️ [Admin] Updating scorecard weights", weights);
              
              const { updateScorecardWeights, logAdminActivity } = await import("../utils/database");
              const scorecard = await updateScorecardWeights(weights);
              
              if (!scorecard) {
                return c.json({ error: "No active scorecard found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'scorecard_weights_update',
                action_description: `Updated scorecard weights: People=${weights.people}%, Process=${weights.process}%, Governance=${weights.governance}%`,
                target_type: 'scorecard',
                target_id: String(scorecard.id),
                target_name: scorecard.name,
                metadata: weights
              });
              
              logger?.info("✅ [Admin] Weights updated");
              return c.json(scorecard);
            } catch (error) {
              console.error("Error updating weights:", error);
              return c.json({ error: "Failed to update weights" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecard/attributes",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const attr = await c.req.json();
              logger?.info("📊 [Admin] Adding scorecard attribute", { name: attr.name, dimension: attr.dimension });
              
              const { addScorecardAttribute, logAdminActivity } = await import("../utils/database");
              const scorecard = await addScorecardAttribute(attr);
              
              if (!scorecard) {
                return c.json({ error: "No active scorecard found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'scorecard_attribute_add',
                action_description: `Added scorecard attribute: ${attr.name} in ${attr.dimension} dimension`,
                target_type: 'scorecard',
                target_id: String(scorecard.id),
                target_name: attr.name,
                metadata: { dimension: attr.dimension, weight: attr.weight, target: attr.target }
              });
              
              logger?.info("✅ [Admin] Attribute added");
              return c.json(scorecard);
            } catch (error) {
              console.error("Error adding attribute:", error);
              return c.json({ error: "Failed to add attribute" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecard/link-doc",
        method: "PUT",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const { governance_doc_id, crm_module, team_name } = await c.req.json();
              logger?.info("🔗 [Admin] Linking governance document to scorecard", { governance_doc_id, crm_module, team_name });
              
              const { linkScorecardToGovernanceDoc, logAdminActivity } = await import("../utils/database");
              const result = await linkScorecardToGovernanceDoc(governance_doc_id, crm_module, team_name);
              
              if (!result) {
                return c.json({ error: "Failed to link document - no matching scorecard found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'scorecard_link_doc',
                action_description: `Linked governance document ${governance_doc_id} to scorecard for ${team_name} team (${crm_module})`,
                target_type: 'scorecard',
                target_id: String(result.id),
                metadata: { governance_doc_id, crm_module, team_name }
              });
              
              logger?.info("✅ [Admin] Document linked to scorecard");
              return c.json({ success: true, scorecard: result });
            } catch (error) {
              console.error("Error linking document to scorecard:", error);
              return c.json({ error: "Failed to link document" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const crmModule = c.req.query('crm_module') || null;
              const teamName = c.req.query('team_name') || null;
              
              const { getScorecardsByModuleAndTeam } = await import("../utils/database");
              const scorecards = await getScorecardsByModuleAndTeam(crmModule, teamName);
              return c.json(scorecards);
            } catch (error) {
              console.error("Error fetching scorecards:", error);
              return c.json({ error: "Failed to fetch scorecards" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const data = await c.req.json();
              logger?.info("📝 [Admin] Creating new scorecard", data);
              
              const { createScorecard, logAdminActivity } = await import("../utils/database");
              const scorecard = await createScorecard(data);
              
              await logAdminActivity({
                action_type: 'scorecard_create',
                action_description: `Created scorecard: ${data.name}`,
                target_type: 'scorecard',
                target_id: String(scorecard.id),
                metadata: data
              });
              
              return c.json(scorecard);
            } catch (error) {
              console.error("Error creating scorecard:", error);
              return c.json({ error: "Failed to create scorecard" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards/:id",
        method: "PUT",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const id = parseInt(c.req.param("id"));
              const updates = await c.req.json();
              
              const { updateScorecard, logAdminActivity } = await import("../utils/database");
              const scorecard = await updateScorecard(id, updates);
              
              if (!scorecard) {
                return c.json({ error: "Scorecard not found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'scorecard_update',
                action_description: `Updated scorecard: ${scorecard.name}`,
                target_type: 'scorecard',
                target_id: String(id),
                metadata: updates
              });
              
              return c.json(scorecard);
            } catch (error) {
              console.error("Error updating scorecard:", error);
              return c.json({ error: "Failed to update scorecard" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards/:id",
        method: "DELETE",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const id = parseInt(c.req.param("id"));
              
              const { deleteScorecard, logAdminActivity } = await import("../utils/database");
              const deleted = await deleteScorecard(id);
              
              if (!deleted) {
                return c.json({ error: "Scorecard not found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'scorecard_delete',
                action_description: `Deleted scorecard ID: ${id}`,
                target_type: 'scorecard',
                target_id: String(id)
              });
              
              return c.json({ success: true });
            } catch (error) {
              console.error("Error deleting scorecard:", error);
              return c.json({ error: "Failed to delete scorecard" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards/:id/activate",
        method: "PUT",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const id = parseInt(c.req.param("id"));
              const { crm_module, team_name } = await c.req.json();
              
              const { setActiveScorecardForTeam, logAdminActivity } = await import("../utils/database");
              const scorecard = await setActiveScorecardForTeam(id, crm_module, team_name);
              
              if (!scorecard) {
                return c.json({ error: "Scorecard not found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'scorecard_activate',
                action_description: `Activated scorecard: ${scorecard.name} for ${team_name} (${crm_module})`,
                target_type: 'scorecard',
                target_id: String(id),
                metadata: { crm_module, team_name }
              });
              
              return c.json(scorecard);
            } catch (error) {
              console.error("Error activating scorecard:", error);
              return c.json({ error: "Failed to activate scorecard" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards/:id/clone",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const id = parseInt(c.req.param("id"));
              const { name, version } = await c.req.json();
              
              const { cloneScorecard, logAdminActivity } = await import("../utils/database");
              const scorecard = await cloneScorecard(id, name, version);
              
              if (!scorecard) {
                return c.json({ error: "Original scorecard not found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'scorecard_clone',
                action_description: `Cloned scorecard ID ${id} to: ${name}`,
                target_type: 'scorecard',
                target_id: String(scorecard.id),
                metadata: { original_id: id, new_name: name, version }
              });
              
              return c.json(scorecard);
            } catch (error) {
              console.error("Error cloning scorecard:", error);
              return c.json({ error: "Failed to clone scorecard" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards/:id/attributes",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const scorecardId = parseInt(c.req.param("id"));
              
              const { getScorecardAttributes } = await import("../utils/database");
              const attributes = await getScorecardAttributes(scorecardId);
              return c.json(attributes);
            } catch (error) {
              console.error("Error fetching attributes:", error);
              return c.json({ error: "Failed to fetch attributes" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards/:id/attributes",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const scorecardId = parseInt(c.req.param("id"));
              const data = await c.req.json();
              
              const { createScorecardAttribute, logAdminActivity } = await import("../utils/database");
              const attribute = await createScorecardAttribute({
                scorecard_id: scorecardId,
                ...data
              });
              
              await logAdminActivity({
                action_type: 'attribute_create',
                action_description: `Added attribute: ${data.attribute_name}`,
                target_type: 'scorecard_attribute',
                target_id: String(attribute.id),
                metadata: data
              });
              
              return c.json(attribute);
            } catch (error) {
              console.error("Error creating attribute:", error);
              return c.json({ error: "Failed to create attribute" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/attributes/:id",
        method: "PUT",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const id = parseInt(c.req.param("id"));
              const updates = await c.req.json();
              
              const { updateScorecardAttribute, logAdminActivity } = await import("../utils/database");
              const attribute = await updateScorecardAttribute(id, updates);
              
              if (!attribute) {
                return c.json({ error: "Attribute not found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'attribute_update',
                action_description: `Updated attribute: ${attribute.attribute_name}`,
                target_type: 'scorecard_attribute',
                target_id: String(id),
                metadata: updates
              });
              
              return c.json(attribute);
            } catch (error) {
              console.error("Error updating attribute:", error);
              return c.json({ error: "Failed to update attribute" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/attributes/:id",
        method: "DELETE",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const id = parseInt(c.req.param("id"));
              
              const { deleteScorecardAttribute, logAdminActivity } = await import("../utils/database");
              const deleted = await deleteScorecardAttribute(id);
              
              if (!deleted) {
                return c.json({ error: "Attribute not found" }, 404);
              }
              
              await logAdminActivity({
                action_type: 'attribute_delete',
                action_description: `Deleted attribute ID: ${id}`,
                target_type: 'scorecard_attribute',
                target_id: String(id)
              });
              
              return c.json({ success: true });
            } catch (error) {
              console.error("Error deleting attribute:", error);
              return c.json({ error: "Failed to delete attribute" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/scorecards/:id/attributes/reorder",
        method: "PUT",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const scorecardId = parseInt(c.req.param("id"));
              const { attribute_ids } = await c.req.json();
              
              const { reorderScorecardAttributes, logAdminActivity } = await import("../utils/database");
              await reorderScorecardAttributes(scorecardId, attribute_ids);
              
              await logAdminActivity({
                action_type: 'attributes_reorder',
                action_description: `Reordered attributes for scorecard ID: ${scorecardId}`,
                target_type: 'scorecard',
                target_id: String(scorecardId),
                metadata: { attribute_ids }
              });
              
              return c.json({ success: true });
            } catch (error) {
              console.error("Error reordering attributes:", error);
              return c.json({ error: "Failed to reorder attributes" }, 500);
            }
          };
        },
      },
      {
        path: "/api/admin/seed-defaults",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("🔄 [Admin] Seeding default governance data");
              
              const { saveGovernanceDocument, saveScorecard, logAdminActivity } = await import("../utils/database");
              const { walaPlusSalesGovernanceRules, qualityScorecardConfig } = await import("../utils/governanceRules");
              
              await saveGovernanceDocument({
                name: walaPlusSalesGovernanceRules.document.name,
                document_type: 'sales',
                version: walaPlusSalesGovernanceRules.document.version,
                file_path: 'attached_assets/WalaPlus_Sales_1.1_01.12.2025_EN_1764681400933.pdf',
                content_text: JSON.stringify(walaPlusSalesGovernanceRules, null, 2),
                rules_json: walaPlusSalesGovernanceRules,
                is_active: true
              });
              
              await saveScorecard({
                name: qualityScorecardConfig.name,
                description: qualityScorecardConfig.description,
                dimensions: qualityScorecardConfig,
                is_active: true
              });
              
              await logAdminActivity({
                action_type: 'seed_defaults',
                action_description: 'Reset governance data to default values',
                target_type: 'system',
                metadata: { 
                  document: walaPlusSalesGovernanceRules.document.name, 
                  scorecard: qualityScorecardConfig.name 
                }
              });
              
              logger?.info("✅ [Admin] Default data seeded successfully");
              return c.json({ success: true, message: "Default data restored" });
            } catch (error) {
              console.error("Error seeding defaults:", error);
              return c.json({ error: "Failed to seed defaults" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // Admin Activities API Endpoints
      // ======================================================================
      {
        path: "/api/admin/activities",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📋 [Admin] Fetching admin activities");
              
              const { getAdminActivities } = await import("../utils/database");
              
              const limit = parseInt(c.req.query("limit") || "50");
              const offset = parseInt(c.req.query("offset") || "0");
              const action_type = c.req.query("action_type");
              const startDate = c.req.query("startDate") ? new Date(c.req.query("startDate")) : undefined;
              const endDate = c.req.query("endDate") ? new Date(c.req.query("endDate")) : undefined;
              
              const result = await getAdminActivities({ limit, offset, action_type, startDate, endDate });
              
              logger?.info("✅ [Admin] Activities fetched", { count: result.activities.length, total: result.total });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching admin activities:", error);
              return c.json({ error: "Failed to fetch admin activities" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // Workflow Runs API Endpoints
      // ======================================================================
      {
        path: "/api/workflow/runs",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("🔄 [Admin] Fetching workflow runs");
              
              const { getWorkflowRuns } = await import("../utils/database");
              
              const limit = parseInt(c.req.query("limit") || "50");
              const offset = parseInt(c.req.query("offset") || "0");
              const workflow_id = c.req.query("workflow_id");
              const status = c.req.query("status");
              const startDate = c.req.query("startDate") ? new Date(c.req.query("startDate")) : undefined;
              const endDate = c.req.query("endDate") ? new Date(c.req.query("endDate")) : undefined;
              
              const result = await getWorkflowRuns({ limit, offset, workflow_id, status, startDate, endDate });
              
              logger?.info("✅ [Admin] Workflow runs fetched", { count: result.runs.length, total: result.total });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching workflow runs:", error);
              return c.json({ error: "Failed to fetch workflow runs" }, 500);
            }
          };
        },
      },
      {
        path: "/api/workflow/runs/:id",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const id = parseInt(c.req.param("id"));
              logger?.info("🔍 [Admin] Fetching workflow run", { id });
              
              const { getWorkflowRunById } = await import("../utils/database");
              const run = await getWorkflowRunById(id);
              
              if (!run) {
                return c.json({ error: "Workflow run not found" }, 404);
              }
              
              logger?.info("✅ [Admin] Workflow run fetched", { id, status: run.status });
              return c.json(run);
            } catch (error) {
              console.error("Error fetching workflow run:", error);
              return c.json({ error: "Failed to fetch workflow run" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // System Events API Endpoints
      // ======================================================================
      {
        path: "/api/system/events",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📊 [Admin] Fetching system events");
              
              const { getSystemEvents } = await import("../utils/database");
              
              const limit = parseInt(c.req.query("limit") || "100");
              const offset = parseInt(c.req.query("offset") || "0");
              const event_type = c.req.query("event_type");
              const event_category = c.req.query("event_category");
              const severity = c.req.query("severity");
              const startDate = c.req.query("startDate") ? new Date(c.req.query("startDate")) : undefined;
              const endDate = c.req.query("endDate") ? new Date(c.req.query("endDate")) : undefined;
              
              const result = await getSystemEvents({ limit, offset, event_type, event_category, severity, startDate, endDate });
              
              logger?.info("✅ [Admin] System events fetched", { count: result.events.length, total: result.total });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching system events:", error);
              return c.json({ error: "Failed to fetch system events" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // Activity Feed API Endpoint (Combined View)
      // ======================================================================
      {
        path: "/api/activity/feed",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📰 [Admin] Fetching activity feed");
              
              const { getActivityFeed } = await import("../utils/database");
              
              const limit = parseInt(c.req.query("limit") || "50");
              const result = await getActivityFeed(limit);
              
              logger?.info("✅ [Admin] Activity feed fetched", { count: result.activities.length });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching activity feed:", error);
              return c.json({ error: "Failed to fetch activity feed" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // Activity Stats API Endpoint (Dashboard Summary)
      // ======================================================================
      {
        path: "/api/activity/stats",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📈 [Admin] Fetching activity stats");
              
              const { getActivityStats } = await import("../utils/database");
              const stats = await getActivityStats();
              
              logger?.info("✅ [Admin] Activity stats fetched");
              return c.json(stats);
            } catch (error) {
              console.error("Error fetching activity stats:", error);
              return c.json({ error: "Failed to fetch activity stats" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // QMS Dashboard API Endpoint
      // ======================================================================
      {
        path: "/api/qms/dashboard",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📊 [QMS] Fetching QMS dashboard data");
              
              const { getQmsDashboardData } = await import("../utils/qmsDatabase");
              const data = await getQmsDashboardData();
              
              logger?.info("✅ [QMS] Dashboard data fetched");
              return c.json(data);
            } catch (error) {
              console.error("Error fetching QMS dashboard:", error);
              return c.json({ error: "Failed to fetch QMS dashboard" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // QMS Deal Evaluations API Endpoints
      // ======================================================================
      {
        path: "/api/qms/evaluations",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📊 [QMS] Fetching deal evaluations");
              
              const { getDealEvaluations } = await import("../utils/qmsDatabase");
              
              const limit = parseInt(c.req.query("limit") || "50");
              const offset = parseInt(c.req.query("offset") || "0");
              const dealId = c.req.query("dealId");
              const minScore = c.req.query("minScore") ? parseFloat(c.req.query("minScore")) : undefined;
              const maxScore = c.req.query("maxScore") ? parseFloat(c.req.query("maxScore")) : undefined;
              
              const result = await getDealEvaluations({ limit, offset, dealId, minScore, maxScore });
              
              logger?.info("✅ [QMS] Evaluations fetched", { count: result.evaluations.length });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching evaluations:", error);
              return c.json({ error: "Failed to fetch evaluations" }, 500);
            }
          };
        },
      },
      {
        path: "/api/qms/evaluations/stats",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📊 [QMS] Fetching evaluation statistics");
              
              const { getEvaluationStatistics } = await import("../utils/qmsDatabase");
              const stats = await getEvaluationStatistics();
              
              logger?.info("✅ [QMS] Stats fetched");
              return c.json(stats);
            } catch (error) {
              console.error("Error fetching evaluation stats:", error);
              return c.json({ error: "Failed to fetch evaluation stats" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // QMS CAPA API Endpoints
      // ======================================================================
      {
        path: "/api/qms/capa",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📋 [QMS] Fetching CAPA records");
              
              const { getCapaRecords } = await import("../utils/qmsDatabase");
              
              const limit = parseInt(c.req.query("limit") || "50");
              const offset = parseInt(c.req.query("offset") || "0");
              const status = c.req.query("status");
              const severity = c.req.query("severity");
              const assignedTo = c.req.query("assignedTo");
              
              const result = await getCapaRecords({ limit, offset, status, severity, assignedTo });
              
              logger?.info("✅ [QMS] CAPA records fetched", { count: result.records.length });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching CAPA records:", error);
              return c.json({ error: "Failed to fetch CAPA records" }, 500);
            }
          };
        },
      },
      {
        path: "/api/qms/capa/:id",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const id = parseInt(c.req.param("id"));
              logger?.info("🔍 [QMS] Fetching CAPA details", { id });
              
              const { getCapaById, getCapaActionItems } = await import("../utils/qmsDatabase");
              const capa = await getCapaById(id);
              
              if (!capa) {
                return c.json({ error: "CAPA not found" }, 404);
              }
              
              const actionItems = await getCapaActionItems(id);
              
              logger?.info("✅ [QMS] CAPA details fetched");
              return c.json({ capa, actionItems });
            } catch (error) {
              console.error("Error fetching CAPA details:", error);
              return c.json({ error: "Failed to fetch CAPA details" }, 500);
            }
          };
        },
      },
      {
        path: "/api/qms/capa",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const data = await c.req.json();
              logger?.info("📝 [QMS] Creating CAPA", { title: data.title });
              
              const { createCapaRecord } = await import("../utils/qmsDatabase");
              const capa = await createCapaRecord({
                title: data.title,
                description: data.description,
                capa_type: data.capaType,
                source_type: data.sourceType,
                source_id: data.sourceId,
                source_reference: data.sourceReference,
                severity: data.severity,
                status: 'open',
                priority: data.priority || 'medium',
                assigned_to: data.assignedTo,
                target_date: data.targetDate ? new Date(data.targetDate) : undefined,
                created_by: data.createdBy || 'Admin',
              });
              
              logger?.info("✅ [QMS] CAPA created", { capaNumber: capa.capa_number });

              try {
                const { logEvent } = await import("../utils/eventLogsDatabase");
                await logEvent({
                  actionType: 'CREATE',
                  entityType: 'CAPA',
                  entityId: String(capa.id),
                  entityName: capa.capa_number,
                  description: `CAPA created: ${capa.title}`,
                  newValue: JSON.stringify(capa),
                  module: 'qms',
                  severity: 'INFO',
                });
              } catch {}

              return c.json(capa);
            } catch (error) {
              console.error("Error creating CAPA:", error);
              return c.json({ error: "Failed to create CAPA" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // QMS Nonconformance API Endpoints
      // ======================================================================
      {
        path: "/api/qms/nc",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📋 [QMS] Fetching NC records");
              
              const { getNonconformances } = await import("../utils/qmsDatabase");
              
              const limit = parseInt(c.req.query("limit") || "50");
              const offset = parseInt(c.req.query("offset") || "0");
              const status = c.req.query("status");
              const severity = c.req.query("severity");
              
              const result = await getNonconformances({ limit, offset, status, severity });
              
              logger?.info("✅ [QMS] NC records fetched", { count: result.records.length });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching NC records:", error);
              return c.json({ error: "Failed to fetch NC records" }, 500);
            }
          };
        },
      },
      {
        path: "/api/qms/nc",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              const data = await c.req.json();
              logger?.info("📝 [QMS] Creating Nonconformance", { title: data.title });
              
              const { createNonconformance } = await import("../utils/qmsDatabase");
              const nc = await createNonconformance({
                title: data.title,
                description: data.description,
                nc_type: data.ncType,
                category: data.category,
                source_type: data.sourceType,
                source_id: data.sourceId,
                source_reference: data.sourceReference,
                severity: data.severity,
                status: 'open',
                detected_by: data.detectedBy || 'Admin',
                criteria_violations: data.criteriaViolations,
              });
              
              logger?.info("✅ [QMS] NC created", { ncNumber: nc.nc_number });

              try {
                const { logEvent } = await import("../utils/eventLogsDatabase");
                await logEvent({
                  actionType: 'CREATE',
                  entityType: 'CAPA',
                  entityId: String(nc.id),
                  entityName: nc.nc_number,
                  description: `Nonconformance created: ${nc.title}`,
                  newValue: JSON.stringify(nc),
                  module: 'qms',
                  severity: 'INFO',
                });
              } catch {}

              return c.json(nc);
            } catch (error) {
              console.error("Error creating NC:", error);
              return c.json({ error: "Failed to create NC" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // QMS Training API Endpoints
      // ======================================================================
      {
        path: "/api/qms/training",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📚 [QMS] Fetching training records");
              
              const { getTrainingRecords } = await import("../utils/qmsDatabase");
              
              const limit = parseInt(c.req.query("limit") || "50");
              const offset = parseInt(c.req.query("offset") || "0");
              const trainingType = c.req.query("trainingType");
              const isActive = c.req.query("isActive") === "true" ? true : c.req.query("isActive") === "false" ? false : undefined;
              
              const result = await getTrainingRecords({ limit, offset, trainingType, isActive });
              
              logger?.info("✅ [QMS] Training records fetched", { count: result.records.length });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching training records:", error);
              return c.json({ error: "Failed to fetch training records" }, 500);
            }
          };
        },
      },
      {
        path: "/api/qms/training/assignments",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📋 [QMS] Fetching training assignments");
              
              const { getTrainingAssignments } = await import("../utils/qmsDatabase");
              
              const limit = parseInt(c.req.query("limit") || "50");
              const offset = parseInt(c.req.query("offset") || "0");
              const employeeId = c.req.query("employeeId");
              const trainingId = c.req.query("trainingId");
              const status = c.req.query("status");
              
              const result = await getTrainingAssignments({ limit, offset, employeeId, trainingId, status });
              
              logger?.info("✅ [QMS] Assignments fetched", { count: result.assignments.length });
              return c.json(result);
            } catch (error) {
              console.error("Error fetching assignments:", error);
              return c.json({ error: "Failed to fetch training assignments" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // QMS Evaluation Framework API Endpoint
      // ======================================================================
      {
        path: "/api/qms/framework",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const adminKey = c.req.header("X-Admin-Key");
              const adminKeyCookie = (c.req.header('Cookie') || '').split(';').map((s: string) => s.trim()).find((s: string) => s.startsWith('admin_key='))?.split('=')[1] || '';
              const expectedKey = process.env.ADMIN_API_KEY;
              const hasValidAdminKey = expectedKey && (adminKey === expectedKey || adminKeyCookie === expectedKey);
              const session = getSessionFromCookie(c.req.header('Cookie'));
              const isAdminRole = session?.role === 'admin';
              if (!hasValidAdminKey && !isAdminRole) {
                return c.json({ error: 'Insufficient permissions' }, 403);
              }
              
              const logger = mastra?.getLogger();
              logger?.info("📋 [QMS] Fetching evaluation framework");
              
              const { getActiveFramework } = await import("../utils/qmsDatabase");
              const { getDefaultFramework } = await import("../utils/evaluationSchema");
              
              let framework = await getActiveFramework();
              if (!framework) {
                framework = getDefaultFramework();
              }
              
              logger?.info("✅ [QMS] Framework fetched");
              return c.json(framework);
            } catch (error) {
              console.error("Error fetching framework:", error);
              return c.json({ error: "Failed to fetch evaluation framework" }, 500);
            }
          };
        },
      },
      
      // ======================================================================
      // QMS Dashboard Page (requires ADMIN_API_KEY)
      // ======================================================================
      {
        path: "/qms",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const adminKey = process.env.ADMIN_API_KEY;
              const session = getSessionFromCookie(c.req.header('Cookie'));
              if (!adminKey && !session) {
                return c.html(`
                  <!DOCTYPE html>
                  <html><head><title>QMS Setup Required</title>
                  <script src="https://cdn.tailwindcss.com"></script></head>
                  <body class="bg-gray-50 min-h-screen flex items-center justify-center">
                    <div class="bg-white p-8 rounded-xl shadow-lg max-w-md text-center">
                      <div class="w-16 h-16 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <svg class="w-8 h-8 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
                        </svg>
                      </div>
                      <h1 class="text-xl font-bold text-gray-900 mb-2">QMS Setup Required</h1>
                      <p class="text-gray-600 mb-4">To access the QMS dashboard, please set the <code class="bg-gray-100 px-2 py-1 rounded">ADMIN_API_KEY</code> secret in your environment.</p>
                      <a href="/" class="text-blue-600 hover:underline">Return to Dashboard</a>
                    </div>
                  </body></html>
                `);
              }
              
              const possiblePaths = [
                join(process.cwd(), "dashboard", "qms.html"),
                join(process.cwd(), "..", "dashboard", "qms.html"),
                "/home/runner/workspace/dashboard/qms.html",
              ];
              
              for (const qmsPath of possiblePaths) {
                if (existsSync(qmsPath)) {
                  const html = readFileSync(qmsPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("QMS Dashboard not found", 404);
            } catch (error) {
              console.error("Error serving QMS dashboard:", error);
              return c.text("Error loading QMS dashboard", 500);
            }
          };
        },
      },
      // ======================================================================
      // Mock Data & Testing Sandbox API Endpoints
      // ======================================================================
      {
        path: "/api/sandbox/mode",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            const logger = mastra?.getLogger();
            logger?.info("🧪 [Sandbox] Getting data mode");
            const { getDataMode } = await import("../data");
            const mode = getDataMode();
            return c.json({ status: 'active' });
          };
        },
      },
      {
        path: "/api/sandbox/stats",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              logger?.info("🧪 [Sandbox] Getting mock data stats");
              const { getMockDataStats } = await import("../data");
              const stats = getMockDataStats();
              return c.json(stats);
            } catch (error) {
              console.error("Error getting mock data stats:", error);
              return c.json({ error: "Failed to get mock data stats" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/leads",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              logger?.info("🧪 [Sandbox] Fetching leads");
              const { getLeads } = await import("../data");
              const leads = await getLeads();
              return c.json({ leads, count: leads.length });
            } catch (error) {
              console.error("Error fetching leads:", error);
              return c.json({ error: "Failed to fetch leads" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/deals",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              logger?.info("🧪 [Sandbox] Fetching deals");
              const { getDeals } = await import("../data");
              const deals = await getDeals();
              return c.json({ deals, count: deals.length });
            } catch (error) {
              console.error("Error fetching deals:", error);
              return c.json({ error: "Failed to fetch deals" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/activities",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              logger?.info("🧪 [Sandbox] Fetching activities");
              const { getActivities } = await import("../data");
              const activities = await getActivities();
              return c.json({ activities, count: activities.length });
            } catch (error) {
              console.error("Error fetching activities:", error);
              return c.json({ error: "Failed to fetch activities" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/users",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              logger?.info("🧪 [Sandbox] Fetching users");
              const { getUsers } = await import("../data");
              const users = await getUsers();
              return c.json({ users, count: users.length });
            } catch (error) {
              console.error("Error fetching users:", error);
              return c.json({ error: "Failed to fetch users" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/calendar",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              logger?.info("🧪 [Sandbox] Fetching calendar events");
              const { getCalendarEvents } = await import("../data");
              const events = await getCalendarEvents();
              return c.json({ events, count: events.length });
            } catch (error) {
              console.error("Error fetching calendar events:", error);
              return c.json({ error: "Failed to fetch calendar events" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/calls",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              logger?.info("🧪 [Sandbox] Fetching Five9 calls");
              const { getFive9Calls } = await import("../data");
              const calls = await getFive9Calls();
              return c.json({ calls, count: calls.length });
            } catch (error) {
              console.error("Error fetching calls:", error);
              return c.json({ error: "Failed to fetch calls" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/leads",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              const body = await c.req.json();
              logger?.info("🧪 [Sandbox] Adding lead", body);
              const { addLead } = await import("../data");
              const lead = await addLead(body);
              return c.json({ success: true, lead });
            } catch (error) {
              console.error("Error adding lead:", error);
              return c.json({ error: "Failed to add lead" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/deals",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              const body = await c.req.json();
              logger?.info("🧪 [Sandbox] Adding deal", body);
              const { addDeal } = await import("../data");
              const deal = await addDeal(body);
              return c.json({ success: true, deal });
            } catch (error) {
              console.error("Error adding deal:", error);
              return c.json({ error: "Failed to add deal" }, 500);
            }
          };
        },
      },
      {
        path: "/api/sandbox/audit",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const logger = mastra?.getLogger();
              logger?.info("🧪 [Sandbox] Running audit on mock data");
              
              const { getLeads, getDeals, getActivities, getCalendarEvents, getFive9Calls, getDataMode } = await import("../data");
              
              const mode = getDataMode();
              const leads = await getLeads();
              const deals = await getDeals();
              const activities = await getActivities();
              const calendarEvents = await getCalendarEvents();
              const calls = await getFive9Calls();
              
              const leadIssues: any[] = [];
              leads.forEach(lead => {
                if (!lead.Email) leadIssues.push({ id: lead.id, issue: 'Missing email', field: 'Email', severity: 'high' });
                else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.Email)) leadIssues.push({ id: lead.id, issue: 'Invalid email format', field: 'Email', severity: 'medium' });
                if (!lead.Lead_Source) leadIssues.push({ id: lead.id, issue: 'Missing lead source', field: 'Lead_Source', severity: 'medium' });
                if (!lead.Lead_Status) leadIssues.push({ id: lead.id, issue: 'Missing lead status', field: 'Lead_Status', severity: 'high' });
                if (!lead.Owner) leadIssues.push({ id: lead.id, issue: 'Missing owner', field: 'Owner', severity: 'high' });
                if (lead.Phone && !/^[+]?[\d\s\-()]+$/.test(lead.Phone)) leadIssues.push({ id: lead.id, issue: 'Invalid phone format', field: 'Phone', severity: 'low' });
              });
              
              const dealIssues: any[] = [];
              deals.forEach(deal => {
                if (!deal.Deal_Name) dealIssues.push({ id: deal.id, issue: 'Missing deal name', field: 'Deal_Name', severity: 'critical' });
                if (!deal.Stage) dealIssues.push({ id: deal.id, issue: 'Missing stage', field: 'Stage', severity: 'critical' });
                if (!deal.Amount) dealIssues.push({ id: deal.id, issue: 'Missing amount', field: 'Amount', severity: 'high' });
                if (!deal.Closing_Date) dealIssues.push({ id: deal.id, issue: 'Missing closing date', field: 'Closing_Date', severity: 'high' });
                if (!deal.Owner) dealIssues.push({ id: deal.id, issue: 'Missing owner', field: 'Owner', severity: 'high' });
              });
              
              const activityIssues: any[] = [];
              activities.forEach(activity => {
                if (!activity.Subject) activityIssues.push({ id: activity.id, issue: 'Missing subject', field: 'Subject', severity: 'high' });
                if (!activity.Due_Date) activityIssues.push({ id: activity.id, issue: 'Missing due date', field: 'Due_Date', severity: 'medium' });
                if (!activity.Owner) activityIssues.push({ id: activity.id, issue: 'Missing owner', field: 'Owner', severity: 'high' });
              });
              
              const calendarIssues: any[] = [];
              calendarEvents.forEach(event => {
                if (!event.related_crm_record && event.attendees.some(a => !a.includes('@walaplus.com'))) {
                  calendarIssues.push({ id: event.id, issue: 'External meeting not logged in CRM', field: 'related_crm_record', severity: 'medium' });
                }
              });
              
              const callIssues: any[] = [];
              calls.forEach(call => {
                if (!call.related_crm_record && call.duration_seconds > 60) {
                  callIssues.push({ id: call.id, issue: 'Call not linked to CRM record', field: 'related_crm_record', severity: 'medium' });
                }
                if (!call.agent_id) callIssues.push({ id: call.id, issue: 'Missing agent information', field: 'agent_id', severity: 'high' });
              });
              
              const totalIssues = leadIssues.length + dealIssues.length + activityIssues.length + calendarIssues.length + callIssues.length;
              const totalRecords = leads.length + deals.length + activities.length + calendarEvents.length + calls.length;
              
              const criticalCount = [...leadIssues, ...dealIssues, ...activityIssues, ...calendarIssues, ...callIssues].filter(i => i.severity === 'critical').length;
              const highCount = [...leadIssues, ...dealIssues, ...activityIssues, ...calendarIssues, ...callIssues].filter(i => i.severity === 'high').length;
              const mediumCount = [...leadIssues, ...dealIssues, ...activityIssues, ...calendarIssues, ...callIssues].filter(i => i.severity === 'medium').length;
              const lowCount = [...leadIssues, ...dealIssues, ...activityIssues, ...calendarIssues, ...callIssues].filter(i => i.severity === 'low').length;
              
              const peopleScore = Math.max(0, 100 - (highCount * 3) - (mediumCount * 1.5));
              const processScore = Math.max(0, 100 - (criticalCount * 5) - (highCount * 2));
              const governanceScore = Math.max(0, 100 - (totalIssues * 1.2));
              const overallScore = Math.round((peopleScore * 0.25) + (processScore * 0.35) + (governanceScore * 0.40));
              
              const result = {
                mode,
                timestamp: new Date().toISOString(),
                summary: {
                  totalRecords,
                  totalIssues,
                  criticalCount,
                  highCount,
                  mediumCount,
                  lowCount,
                },
                scores: {
                  overall: overallScore,
                  people: Math.round(peopleScore),
                  process: Math.round(processScore),
                  governance: Math.round(governanceScore),
                },
                moduleBreakdown: {
                  leads: { records: leads.length, issues: leadIssues.length, details: leadIssues.slice(0, 10) },
                  deals: { records: deals.length, issues: dealIssues.length, details: dealIssues.slice(0, 10) },
                  activities: { records: activities.length, issues: activityIssues.length, details: activityIssues.slice(0, 10) },
                  calendar: { records: calendarEvents.length, issues: calendarIssues.length, details: calendarIssues.slice(0, 10) },
                  calls: { records: calls.length, issues: callIssues.length, details: callIssues.slice(0, 10) },
                },
                recommendations: [
                  criticalCount > 0 ? `Fix ${criticalCount} critical issues immediately (missing deal names/stages)` : null,
                  highCount > 0 ? `Address ${highCount} high-priority issues (missing owners, emails, amounts)` : null,
                  leadIssues.length > 5 ? `SDR Team: Improve lead data quality - ${leadIssues.length} issues found` : null,
                  dealIssues.length > 5 ? `Sales Team: Improve deal data quality - ${dealIssues.length} issues found` : null,
                  calendarIssues.length > 0 ? `Log all external meetings in CRM for better tracking` : null,
                ].filter(Boolean),
              };
              
              logger?.info("✅ [Sandbox] Audit completed", { totalIssues, overallScore });
              return c.json(result);
            } catch (error) {
              console.error("Error running sandbox audit:", error);
              return c.json({ error: "Failed to run audit" }, 500);
            }
          };
        },
      },
      // Testing Sandbox Page
      {
        path: "/sandbox",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "sandbox.html"),
                join(process.cwd(), "..", "dashboard", "sandbox.html"),
                "/home/runner/workspace/dashboard/sandbox.html",
              ];
              
              for (const sandboxPath of possiblePaths) {
                if (existsSync(sandboxPath)) {
                  const html = readFileSync(sandboxPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Testing Sandbox not found", 404);
            } catch (error) {
              console.error("Error serving sandbox:", error);
              return c.text("Error loading Testing Sandbox", 500);
            }
          };
        },
      },
      // CRM Data Viewer Page
      {
        path: "/crm",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "crm.html"),
                join(process.cwd(), "..", "dashboard", "crm.html"),
                "/home/runner/workspace/dashboard/crm.html",
              ];
              
              for (const crmPath of possiblePaths) {
                if (existsSync(crmPath)) {
                  const html = readFileSync(crmPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("CRM Data Viewer not found", 404);
            } catch (error) {
              console.error("Error serving CRM page:", error);
              return c.text("Error loading CRM Data Viewer", 500);
            }
          };
        },
      },
      // ======================================================================
      // Audit Readiness Routes
      // ======================================================================
      {
        path: "/audits",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "audits.html"),
                join(process.cwd(), "..", "dashboard", "audits.html"),
                "/home/runner/workspace/dashboard/audits.html",
              ];
              
              for (const auditsPath of possiblePaths) {
                if (existsSync(auditsPath)) {
                  const html = readFileSync(auditsPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Audit Readiness page not found", 404);
            } catch (error) {
              console.error("Error serving Audits page:", error);
              return c.text("Error loading Audit Readiness", 500);
            }
          };
        },
      },
      // ======================================================================
      // Compliance Tracker Routes
      // ======================================================================
      {
        path: "/compliance",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "compliance.html"),
                join(process.cwd(), "..", "dashboard", "compliance.html"),
                "/home/runner/workspace/dashboard/compliance.html",
              ];
              
              for (const compliancePath of possiblePaths) {
                if (existsSync(compliancePath)) {
                  const html = readFileSync(compliancePath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Compliance Tracker page not found", 404);
            } catch (error) {
              console.error("Error serving Compliance page:", error);
              return c.text("Error loading Compliance Tracker", 500);
            }
          };
        },
      },
      // ======================================================================
      // Policy Governance Routes
      // ======================================================================
      {
        path: "/policies",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "policies.html"),
                join(process.cwd(), "..", "dashboard", "policies.html"),
                "/home/runner/workspace/dashboard/policies.html",
              ];
              
              for (const policiesPath of possiblePaths) {
                if (existsSync(policiesPath)) {
                  const html = readFileSync(policiesPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Policy Governance page not found", 404);
            } catch (error) {
              console.error("Error serving Policies page:", error);
              return c.text("Error loading Policy Governance", 500);
            }
          };
        },
      },
      // ======================================================================
      // Enterprise Risk Management Routes
      // ======================================================================
      {
        path: "/risks",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "risks.html"),
                join(process.cwd(), "..", "dashboard", "risks.html"),
                "/home/runner/workspace/dashboard/risks.html",
              ];
              
              for (const risksPath of possiblePaths) {
                if (existsSync(risksPath)) {
                  const html = readFileSync(risksPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Enterprise Risk Management page not found", 404);
            } catch (error) {
              console.error("Error serving Risks page:", error);
              return c.text("Error loading Enterprise Risk Management", 500);
            }
          };
        },
      },
      // ======================================================================
      // Control Tower (Executive GRC Dashboard) Routes
      // ======================================================================
      {
        path: "/grc",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "grc.html"),
                join(process.cwd(), "..", "dashboard", "grc.html"),
                "/home/runner/workspace/dashboard/grc.html",
              ];
              
              for (const grcPath of possiblePaths) {
                if (existsSync(grcPath)) {
                  const html = readFileSync(grcPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("GRC Control Tower page not found", 404);
            } catch (error) {
              console.error("Error serving GRC page:", error);
              return c.text("Error loading GRC Control Tower", 500);
            }
          };
        },
      },
      // ======================================================================
      // PDPL Compliance Dashboard Routes
      // ======================================================================
      {
        path: "/pdpl",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "pdpl.html"),
                join(process.cwd(), "..", "dashboard", "pdpl.html"),
                "/home/runner/workspace/dashboard/pdpl.html",
              ];
              
              for (const pdplPath of possiblePaths) {
                if (existsSync(pdplPath)) {
                  const html = readFileSync(pdplPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("PDPL Compliance page not found", 404);
            } catch (error) {
              console.error("Error serving PDPL page:", error);
              return c.text("Error loading PDPL Compliance Dashboard", 500);
            }
          };
        },
      },
      // ======================================================================
      // Team Feedback Routes
      // ======================================================================
      {
        path: "/feedback",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "feedback.html"),
                join(process.cwd(), "..", "dashboard", "feedback.html"),
                "/home/runner/workspace/dashboard/feedback.html",
              ];
              
              for (const feedbackPath of possiblePaths) {
                if (existsSync(feedbackPath)) {
                  const html = readFileSync(feedbackPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Team Feedback page not found", 404);
            } catch (error) {
              console.error("Error serving Team Feedback page:", error);
              return c.text("Error loading Team Feedback", 500);
            }
          };
        },
      },
      {
        path: "/api/feedback",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { submitFeedback } = await import("../utils/database");
              const body = await c.req.json();
              
              if (!body.submitter_name || !body.dashboard || !body.rating) {
                return c.json({ error: "Name, dashboard, and rating are required" }, 400);
              }
              
              const feedback = await submitFeedback({
                submitter_name: body.submitter_name,
                submitter_role: body.submitter_role,
                dashboard: body.dashboard,
                rating: body.rating,
                ease_of_use: body.ease_of_use,
                comments: body.comments,
                suggestions: body.suggestions
              });
              
              mastra?.getLogger()?.info("📝 [Feedback] New feedback submitted:", feedback);
              return c.json({ success: true, feedback });
            } catch (error) {
              console.error("Error submitting feedback:", error);
              return c.json({ error: "Failed to submit feedback" }, 500);
            }
          };
        },
      },
      {
        path: "/api/feedback",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { getAllFeedback } = await import("../utils/database");
              const dashboard = c.req.query("dashboard");
              const startDate = c.req.query("startDate");
              const endDate = c.req.query("endDate");
              
              const feedback = await getAllFeedback({ dashboard, startDate, endDate });
              return c.json({ feedback });
            } catch (error) {
              console.error("Error fetching feedback:", error);
              return c.json({ error: "Failed to fetch feedback", feedback: [] }, 500);
            }
          };
        },
      },
      {
        path: "/api/feedback/stats",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { getFeedbackStats } = await import("../utils/database");
              const stats = await getFeedbackStats();
              return c.json(stats);
            } catch (error) {
              console.error("Error fetching feedback stats:", error);
              return c.json({ error: "Failed to fetch feedback stats" }, 500);
            }
          };
        },
      },
      // ======================================================================
      // User Guide Routes
      // ======================================================================
      {
        path: "/guide",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "guide.html"),
                join(process.cwd(), "..", "dashboard", "guide.html"),
                "/home/runner/workspace/dashboard/guide.html",
              ];
              
              for (const guidePath of possiblePaths) {
                if (existsSync(guidePath)) {
                  const html = readFileSync(guidePath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("User Guide page not found", 404);
            } catch (error) {
              console.error("Error serving User Guide page:", error);
              return c.text("Error loading User Guide", 500);
            }
          };
        },
      },
      // ======================================================================
      // Data Migration Engine Routes
      // ======================================================================
      {
        path: "/migration",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "migration.html"),
                join(process.cwd(), "..", "dashboard", "migration.html"),
                "/home/runner/workspace/dashboard/migration.html",
              ];
              
              for (const migrationPath of possiblePaths) {
                if (existsSync(migrationPath)) {
                  const html = readFileSync(migrationPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Data Migration Engine page not found", 404);
            } catch (error) {
              console.error("Error serving Migration page:", error);
              return c.text("Error loading Data Migration Engine", 500);
            }
          };
        },
      },
      // ======================================================================
      // Vendor Risk Management Routes
      // ======================================================================
      {
        path: "/vendors",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "vendors.html"),
                join(process.cwd(), "..", "dashboard", "vendors.html"),
                "/home/runner/workspace/dashboard/vendors.html",
              ];
              
              for (const vendorsPath of possiblePaths) {
                if (existsSync(vendorsPath)) {
                  const html = readFileSync(vendorsPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Vendor Risk Management page not found", 404);
            } catch (error) {
              console.error("Error serving Vendors page:", error);
              return c.text("Error loading Vendor Risk Management", 500);
            }
          };
        },
      },
      // ======================================================================
      // Table F Governance Engine Routes
      // ======================================================================
      {
        path: "/tablef",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "tablef.html"),
                join(process.cwd(), "..", "dashboard", "tablef.html"),
                "/home/runner/workspace/dashboard/tablef.html",
              ];
              
              for (const tablefPath of possiblePaths) {
                if (existsSync(tablefPath)) {
                  const html = readFileSync(tablefPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Table F page not found", 404);
            } catch (error) {
              console.error("Error serving Table F:", error);
              return c.text("Error loading Table F", 500);
            }
          };
        },
      },
      {
        path: "/api/tablef/departments",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { Pool } = await import("pg");
              const pool = new Pool({ connectionString: process.env.DATABASE_URL });
              const result = await pool.query('SELECT * FROM tablef_departments WHERE active = true ORDER BY name');
              await pool.end();
              return c.json({ departments: result.rows });
            } catch (error) {
              console.error("Error fetching departments:", error);
              return c.json({ error: "Failed to fetch departments", departments: [] }, 500);
            }
          };
        },
      },
      {
        path: "/api/tablef/kpis",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { Pool } = await import("pg");
              const pool = new Pool({ connectionString: process.env.DATABASE_URL });
              const deptId = c.req.query('department_id');
              let query = 'SELECT * FROM tablef_kpis WHERE enabled = true';
              const params: string[] = [];
              if (deptId) {
                query += ' AND department_id = $1';
                params.push(deptId);
              }
              query += ' ORDER BY department_id, name';
              const result = await pool.query(query, params);
              await pool.end();
              return c.json({ kpis: result.rows });
            } catch (error) {
              console.error("Error fetching KPIs:", error);
              return c.json({ error: "Failed to fetch KPIs", kpis: [] }, 500);
            }
          };
        },
      },
      {
        path: "/api/tablef/kpis",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { Pool } = await import("pg");
              const pool = new Pool({ connectionString: process.env.DATABASE_URL });
              const data = await c.req.json();
              
              if (data.kpi_id) {
                const result = await pool.query(
                  `UPDATE tablef_kpis SET 
                    department_id = $1, name = $2, description = $3, category = $4, 
                    unit = $5, target_annual = $6, target_monthly = $7, weight = $8, 
                    owner_email = $9, data_source = $10, calculation_definition = $11, 
                    updated_at = CURRENT_TIMESTAMP
                  WHERE kpi_id = $12 RETURNING *`,
                  [data.department_id, data.name, data.description, data.category, 
                   data.unit, data.target_annual, data.target_monthly, data.weight,
                   data.owner_email, data.data_source, data.calculation_definition, data.kpi_id]
                );
                await pool.end();
                return c.json({ success: true, kpi: result.rows[0] });
              } else {
                const kpiId = `KPI-${Date.now()}`;
                const result = await pool.query(
                  `INSERT INTO tablef_kpis 
                    (kpi_id, department_id, name, description, category, unit, target_annual, 
                     target_monthly, weight, owner_email, data_source, calculation_definition)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
                  [kpiId, data.department_id, data.name, data.description, data.category, 
                   data.unit, data.target_annual, data.target_monthly, data.weight,
                   data.owner_email, data.data_source, data.calculation_definition]
                );
                await pool.end();
                return c.json({ success: true, kpi: result.rows[0] });
              }
            } catch (error) {
              console.error("Error saving KPI:", error);
              return c.json({ error: "Failed to save KPI" }, 500);
            }
          };
        },
      },
      {
        path: "/api/tablef/performance",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { Pool } = await import("pg");
              const pool = new Pool({ connectionString: process.env.DATABASE_URL });
              const result = await pool.query('SELECT * FROM tablef_performance ORDER BY period_month DESC');
              await pool.end();
              return c.json({ performance: result.rows });
            } catch (error) {
              console.error("Error fetching performance:", error);
              return c.json({ error: "Failed to fetch performance", performance: [] }, 500);
            }
          };
        },
      },
      {
        path: "/api/tablef/performance",
        method: "POST",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { Pool } = await import("pg");
              const pool = new Pool({ connectionString: process.env.DATABASE_URL });
              const data = await c.req.json();
              
              const variance = data.achieved - data.target;
              const variancePercent = data.target !== 0 ? ((data.achieved - data.target) / data.target) * 100 : 0;
              
              let status = 'NOT_MET';
              if (data.achieved >= data.target) status = 'MET';
              else if (data.achieved >= data.target * 0.9) status = 'IMPROVING';
              
              const existingResult = await pool.query(
                'SELECT * FROM tablef_performance WHERE kpi_id = $1 AND period_month = $2',
                [data.kpi_id, data.period_month]
              );
              
              const prevResult = await pool.query(
                `SELECT achieved FROM tablef_performance 
                 WHERE kpi_id = $1 AND period_month < $2 
                 ORDER BY period_month DESC LIMIT 1`,
                [data.kpi_id, data.period_month]
              );
              
              let trend = 'FLAT';
              if (prevResult.rows.length > 0) {
                const prevAchieved = parseFloat(prevResult.rows[0].achieved);
                if (data.achieved > prevAchieved) trend = 'UP';
                else if (data.achieved < prevAchieved) trend = 'DOWN';
              }
              
              if (existingResult.rows.length > 0) {
                await pool.query(
                  `UPDATE tablef_performance SET 
                    target = $1, achieved = $2, variance = $3, variance_percent = $4,
                    status = $5, trend = $6, comment = $7, evidence_link = $8,
                    updated_at = CURRENT_TIMESTAMP
                  WHERE kpi_id = $9 AND period_month = $10`,
                  [data.target, data.achieved, variance, variancePercent, status, trend,
                   data.comment, data.evidence_link, data.kpi_id, data.period_month]
                );
              } else {
                await pool.query(
                  `INSERT INTO tablef_performance 
                    (kpi_id, department_id, period_month, target, achieved, variance, 
                     variance_percent, status, trend, comment, evidence_link)
                  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                  [data.kpi_id, data.department_id, data.period_month, data.target, 
                   data.achieved, variance, variancePercent, status, trend,
                   data.comment, data.evidence_link]
                );
              }
              
              await pool.end();
              return c.json({ success: true, status, trend, variance, variancePercent });
            } catch (error) {
              console.error("Error saving performance:", error);
              return c.json({ error: "Failed to save performance" }, 500);
            }
          };
        },
      },
      {
        path: "/api/tablef/users",
        method: "GET",
        createHandler: async ({ mastra }) => {
          return async (c: any) => {
            try {
              const { Pool } = await import("pg");
              const pool = new Pool({ connectionString: process.env.DATABASE_URL });
              const result = await pool.query('SELECT * FROM tablef_users ORDER BY name');
              await pool.end();
              return c.json({ users: result.rows });
            } catch (error) {
              console.error("Error fetching users:", error);
              return c.json({ error: "Failed to fetch users", users: [] }, 500);
            }
          };
        },
      },
      // ======================================================================
      // Documentation Route
      // ======================================================================
      {
        path: "/docs/SCOPE_OF_WORK.html",
        method: "GET",
        createHandler: async (_mastra) => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "docs", "SCOPE_OF_WORK.html"),
                join(process.cwd(), "..", "docs", "SCOPE_OF_WORK.html"),
                "/home/runner/workspace/docs/SCOPE_OF_WORK.html",
              ];
              
              for (const docPath of possiblePaths) {
                if (existsSync(docPath)) {
                  const html = readFileSync(docPath, "utf-8");
                  return c.html(html);
                }
              }
              
              return c.text("Documentation not found", 404);
            } catch (error) {
              console.error("Error serving documentation:", error);
              return c.text("Error loading documentation", 500);
            }
          };
        },
      },
      // ======================================================================
      // Call Intelligence Routes
      // ======================================================================
      // Static Asset Routes for Navigation CSS and JS
      // ======================================================================
      {
        path: "/css/navigation.css",
        method: "GET",
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "css", "navigation.css"),
                join(process.cwd(), "..", "dashboard", "css", "navigation.css"),
                "/home/runner/workspace/dashboard/css/navigation.css",
              ];
              
              for (const cssPath of possiblePaths) {
                if (existsSync(cssPath)) {
                  const css = readFileSync(cssPath, "utf-8");
                  return c.text(css, 200, { "Content-Type": "text/css" });
                }
              }
              
              return c.text("/* navigation.css not found */", 404, { "Content-Type": "text/css" });
            } catch (error) {
              console.error("Error serving navigation.css:", error);
              return c.text("/* Error loading navigation.css */", 500, { "Content-Type": "text/css" });
            }
          };
        },
      },
      {
        path: "/js/navigation.js",
        method: "GET" as const,
        createHandler: async () => {
          return async (c: any) => {
            try {
              const possiblePaths = [
                join(process.cwd(), "dashboard", "js", "navigation.js"),
                join(process.cwd(), "..", "dashboard", "js", "navigation.js"),
                "/home/runner/workspace/dashboard/js/navigation.js",
              ];
              
              for (const jsPath of possiblePaths) {
                if (existsSync(jsPath)) {
                  const js = readFileSync(jsPath, "utf-8");
                  return c.text(js, 200, { "Content-Type": "application/javascript" });
                }
              }
              
              return c.text("// navigation.js not found", 404, { "Content-Type": "application/javascript" });
            } catch (error) {
              console.error("Error serving navigation.js:", error);
              return c.text("// Error loading navigation.js", 500, { "Content-Type": "application/javascript" });
            }
          };
        },
      },
      // ======================================================================
      // Additional Module Routes (imported from route files)
      // ======================================================================
      ...callIntelligenceRoutes,
      ...roiRoutes,
      ...teamRoutes,
      ...pmpRoutes,
      ...eventLogsRoutes,
      ...onboardingRoutes,
      ...riskRoutes,
      ...policyRoutes,
      ...complianceRoutes,
      ...auditRoutes,
      ...vendorRoutes,
      ...migrationRoutes,
      ...handoffRoutes,
      ...kpiRoutes,
      ...duplicateRadarRoutes,
      ...rbacRoutes,
      ...scorecardRoutes,
      ...pdplRoutes,
      ...triggerRoutes,
      ...userAccessRoutes,
      ...smokeTestRoutes,
      ...consultantRoutes,
      ...qmsEnhancedRoutes,
      ...notificationRoutes,
      ...knowledgeRoutes,
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({
          name: "Mastra",
          level: "info",
        })
      : new PinoLogger({
          name: "Mastra",
          level: "info",
        }),
});

/*  Sanity check 1: Throw an error if there are more than 1 workflows.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error(
    "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

/*  Sanity check 2: Throw an error if there are more than 1 agents.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getAgents()).length > 1) {
  throw new Error(
    "More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}
