import { join } from "path";
import { readFileSync, existsSync } from "fs";
import {
  initAIAlertsTable,
  getAIAlerts,
  getUnreadAlertCount,
  acknowledgeAlert,
  resolveAlert,
  dismissAlert,
  type AlertStatus,
  type AlertSeverity,
  type AlertType,
} from "../../utils/aiAlertsDatabase";

initAIAlertsTable().catch(console.error);

const CHAT_TIMEOUT = parseInt(process.env.CONSULTANT_CHAT_TIMEOUT || "120000");
const SCAN_TIMEOUT = parseInt(process.env.CONSULTANT_SCAN_TIMEOUT || "300000");

function requireAuthOrKey(c: any): boolean {
  const adminKey = c.req.header("x-admin-key");
  if (adminKey === process.env.ADMIN_API_KEY) return true;
  const session = c.get?.("session") || c.get?.("user");
  if (session) return true;
  return false;
}

export const consultantRoutes = [
  {
    path: "/consultant",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const possiblePaths = [
          join(process.cwd(), "dashboard", "consultant.html"),
          "/home/runner/workspace/dashboard/consultant.html",
        ];
        for (const p of possiblePaths) {
          if (existsSync(p)) {
            return c.html(readFileSync(p, "utf-8"));
          }
        }
        return c.text("Consultant page not found", 404);
      };
    },
  },

  {
    path: "/api/consultant/chat",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const mastra = c.get("mastra");
          const body = await c.req.json();
          const { message, threadId } = body;

          if (!message || typeof message !== "string") {
            return c.json({ error: "Message is required" }, 400);
          }

          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          const resolvedThreadId = threadId || `consultant-${Date.now()}`;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT);

          try {
            const response = await agent.generateLegacy(message, {
              threadId: resolvedThreadId,
              resourceId: "consultant-session",
              abortSignal: controller.signal,
            });

            clearTimeout(timeout);

            return c.json({
              success: true,
              threadId: resolvedThreadId,
              response: response.text,
            });
          } catch (err: any) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
              return c.json({ error: "Request timed out", details: `Exceeded ${CHAT_TIMEOUT / 1000}s limit` }, 504);
            }
            throw err;
          }
        } catch (error) {
          console.error("[Consultant] Chat error:", error);
          return c.json({
            error: "Failed to process message",
            details: error instanceof Error ? error.message : String(error),
          }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/chat/stream",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const mastra = c.get("mastra");
          const body = await c.req.json();
          const { message, threadId } = body;

          if (!message || typeof message !== "string") {
            return c.json({ error: "Message is required" }, 400);
          }

          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          const resolvedThreadId = threadId || `consultant-${Date.now()}`;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), CHAT_TIMEOUT);

          let stream: any;
          try {
            stream = await agent.streamLegacy(message, {
              threadId: resolvedThreadId,
              resourceId: "consultant-session",
              abortSignal: controller.signal,
            });
          } catch (initErr: any) {
            clearTimeout(timeout);
            if (initErr.name === 'AbortError') {
              return c.json({ error: "Request timed out", details: `Exceeded ${CHAT_TIMEOUT / 1000}s limit` }, 504);
            }
            throw initErr;
          }

          const encoder = new TextEncoder();
          const readable = new ReadableStream({
            async start(ctrl) {
              try {
                for await (const chunk of stream.textStream) {
                  ctrl.enqueue(
                    encoder.encode(`data: ${JSON.stringify({ text: chunk, threadId: resolvedThreadId })}\n\n`)
                  );
                }
                ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, threadId: resolvedThreadId })}\n\n`));
                ctrl.close();
              } catch (err: any) {
                if (err.name === 'AbortError') {
                  ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Request timed out" })}\n\n`));
                } else {
                  ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Stream error" })}\n\n`));
                }
                ctrl.close();
              } finally {
                clearTimeout(timeout);
              }
            },
          });

          return new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          });
        } catch (error) {
          console.error("[Consultant] Stream error:", error);
          return c.json({ error: "Failed to start stream" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/alerts",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const status = c.req.query("status") as AlertStatus | undefined;
          const severity = c.req.query("severity") as AlertSeverity | undefined;
          const alertType = c.req.query("type") as AlertType | undefined;
          const limit = parseInt(c.req.query("limit") || "50");
          const offset = parseInt(c.req.query("offset") || "0");

          const result = await getAIAlerts({
            status: status || undefined,
            severity: severity || undefined,
            alert_type: alertType || undefined,
            limit: isNaN(limit) ? 50 : limit,
            offset: isNaN(offset) ? 0 : offset,
          });

          return c.json(result);
        } catch (error) {
          console.error("[Consultant] Alerts fetch error:", error);
          return c.json({ error: "Failed to fetch alerts" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/alerts/count",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const count = await getUnreadAlertCount();
          return c.json({ count });
        } catch (error) {
          return c.json({ count: 0 });
        }
      };
    },
  },

  {
    path: "/api/consultant/alerts/:id/acknowledge",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid alert ID" }, 400);

          const body = await c.req.json().catch(() => ({}));
          const acknowledgedBy = body.acknowledgedBy || "user";

          const alert = await acknowledgeAlert(id, acknowledgedBy);
          if (!alert) return c.json({ error: "Alert not found" }, 404);

          return c.json({ success: true, alert });
        } catch (error) {
          return c.json({ error: "Failed to acknowledge alert" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/alerts/:id/resolve",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid alert ID" }, 400);

          const alert = await resolveAlert(id);
          if (!alert) return c.json({ error: "Alert not found" }, 404);

          return c.json({ success: true, alert });
        } catch (error) {
          return c.json({ error: "Failed to resolve alert" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/alerts/:id/dismiss",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid alert ID" }, 400);

          const alert = await dismissAlert(id);
          if (!alert) return c.json({ error: "Alert not found" }, 404);

          return c.json({ success: true, alert });
        } catch (error) {
          return c.json({ error: "Failed to dismiss alert" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/scan",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          const scanPrompt = `Perform a comprehensive platform health scan. Use all available monitoring tools to:
1. Check regulation compliance across PDPL, ISO 9001, ISO 27001, and NCA
2. Analyze nonconformance patterns for the last 90 days
3. Monitor the risk register for high risks and overdue treatments
4. Check KPI performance for missed targets
5. Review governance documents for expired reviews
6. Suggest improvements based on overall trends

Report all findings with severity levels and recommended actions. Do NOT auto-create alerts — present findings for user review and ask before creating any alerts, NCs, or CAPAs.`;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT);

          try {
            const response = await agent.generateLegacy(scanPrompt, {
              threadId: `scan-${Date.now()}`,
              resourceId: "system-scanner",
              abortSignal: controller.signal,
            });

            clearTimeout(timeout);

            return c.json({
              success: true,
              summary: response.text,
            });
          } catch (err: any) {
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
              return c.json({ error: "Scan timed out", details: `Exceeded ${SCAN_TIMEOUT / 1000}s limit` }, 504);
            }
            throw err;
          }
        } catch (error) {
          console.error("[Consultant] Scan error:", error);
          return c.json({ error: "Failed to run platform scan" }, 500);
        }
      };
    },
  },

  {
    path: "/api/consultant/scan-stream",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const mastra = c.get("mastra");
          const agent = mastra?.getAgent("qmsConsultantAgent");
          if (!agent) {
            return c.json({ error: "QMS Consultant agent not available" }, 503);
          }

          const scanPrompt = `Perform a comprehensive platform health scan. Use all available monitoring tools to:
1. Check regulation compliance across PDPL, ISO 9001, ISO 27001, and NCA
2. Analyze nonconformance patterns for the last 90 days
3. Monitor the risk register for high risks and overdue treatments
4. Check KPI performance for missed targets
5. Review governance documents for expired reviews
6. Suggest improvements based on overall trends

Report all findings with severity levels and recommended actions. Do NOT auto-create alerts — present findings for user review.`;

          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), SCAN_TIMEOUT);

          let stream: any;
          try {
            stream = await agent.streamLegacy(scanPrompt, {
              threadId: `scan-${Date.now()}`,
              resourceId: "system-scanner",
              abortSignal: controller.signal,
            });
          } catch (initErr: any) {
            clearTimeout(timeout);
            if (initErr.name === 'AbortError') {
              return c.json({ error: "Scan timed out", details: `Exceeded ${SCAN_TIMEOUT / 1000}s limit` }, 504);
            }
            throw initErr;
          }

          const encoder = new TextEncoder();
          let stepIndex = 0;
          const steps = [
            "Checking regulation compliance...",
            "Analyzing nonconformances...",
            "Monitoring risk register...",
            "Evaluating KPI performance...",
            "Reviewing documents...",
            "Generating recommendations...",
          ];

          const readable = new ReadableStream({
            async start(ctrl) {
              try {
                ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ progress: 0, step: "Starting scan..." })}\n\n`));

                let charCount = 0;
                for await (const chunk of stream.textStream) {
                  charCount += chunk.length;
                  const newStep = Math.min(Math.floor(charCount / 200), steps.length - 1);
                  if (newStep > stepIndex) {
                    stepIndex = newStep;
                    const pct = Math.min(Math.round(((stepIndex + 1) / steps.length) * 90), 90);
                    ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ progress: pct, step: steps[stepIndex] })}\n\n`));
                  }
                  ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ text: chunk })}\n\n`));
                }

                ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ progress: 100, step: "Scan complete", done: true })}\n\n`));
                ctrl.close();
              } catch (err: any) {
                if (err.name === 'AbortError') {
                  ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Scan timed out" })}\n\n`));
                } else {
                  ctrl.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "Scan error" })}\n\n`));
                }
                ctrl.close();
              } finally {
                clearTimeout(timeout);
              }
            },
          });

          return new Response(readable, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            },
          });
        } catch (error) {
          console.error("[Consultant] Scan stream error:", error);
          return c.json({ error: "Failed to start scan stream" }, 500);
        }
      };
    },
  },

  {
    path: "/api/knowledge/upload-file",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        if (!requireAuthOrKey(c)) return c.json({ error: "Unauthorized" }, 401);
        try {
          const formData = await c.req.formData();
          const file = formData.get("file");
          if (!file || !(file instanceof File)) {
            return c.json({ error: "No file provided" }, 400);
          }

          const allowedTypes = [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "text/plain",
          ];
          if (!allowedTypes.includes(file.type)) {
            return c.json({ error: "Only PDF, DOCX, and TXT files are supported" }, 400);
          }

          const maxSize = 10 * 1024 * 1024;
          if (file.size > maxSize) {
            return c.json({ error: "File exceeds 10MB limit" }, 400);
          }

          const content = await file.text();
          const title = formData.get("title") as string || file.name;
          const category = formData.get("category") as string || "uploaded";

          const { sharedPool } = await import("../../utils/sharedPool");
          await sharedPool.query(
            `INSERT INTO knowledge_documents (title, content, category, file_name, file_type, file_size, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [title, content, category, file.name, file.type, file.size]
          );

          return c.json({ success: true, message: `File "${file.name}" uploaded successfully` });
        } catch (error) {
          console.error("[Consultant] File upload error:", error);
          return c.json({ error: "Failed to upload file" }, 500);
        }
      };
    },
  },
];
