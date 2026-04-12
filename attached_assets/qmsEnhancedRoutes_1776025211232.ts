import { toCSV } from "../../utils/exportUtils";

const evidenceRoutes = [
  {
    path: "/api/evidence/:entityType/:entityId",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const entityType = c.req.param("entityType");
          const entityId = parseInt(c.req.param("entityId"));
          if (isNaN(entityId)) return c.json({ error: "Invalid entity ID" }, 400);
          const { getEvidenceForEntity } = await import("../../utils/evidenceDatabase");
          const evidence = await getEvidenceForEntity(entityType, entityId);
          return c.json({ evidence });
        } catch (error) {
          return c.json({ error: "Failed to fetch evidence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/evidence",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          if (!body.entityType || !body.entityId || !body.filename || !body.uploadedBy) {
            return c.json({ error: "entityType, entityId, filename, and uploadedBy are required" }, 400);
          }
          const { addEvidence } = await import("../../utils/evidenceDatabase");
          const record = await addEvidence({
            entity_type: body.entityType,
            entity_id: body.entityId,
            filename: body.filename,
            original_filename: body.originalFilename || body.filename,
            file_type: body.fileType || 'unknown',
            file_size: body.fileSize || 0,
            uploaded_by: body.uploadedBy,
            description: body.description,
            metadata: body.metadata,
          });
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({ actionType: 'CREATE', entityType: 'DOCUMENT', entityId: String(record.id), description: `Evidence uploaded: ${body.filename} for ${body.entityType} #${body.entityId}`, module: 'evidence', severity: 'INFO' });
          } catch {}
          return c.json({ success: true, evidence: record });
        } catch (error) {
          return c.json({ error: "Failed to add evidence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/evidence/:id",
    method: "DELETE" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { deleteEvidence } = await import("../../utils/evidenceDatabase");
          const deleted = await deleteEvidence(id);
          if (!deleted) return c.json({ error: "Evidence not found" }, 404);
          return c.json({ success: true });
        } catch (error) {
          return c.json({ error: "Failed to delete evidence" }, 500);
        }
      };
    },
  },
  {
    path: "/api/evidence-pack",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const entityType = c.req.query("entityType");
          const dateFrom = c.req.query("dateFrom");
          const dateTo = c.req.query("dateTo");
          const entityIdsParam = c.req.query("entityIds");
          const entityIds = entityIdsParam ? entityIdsParam.split(',').map(Number).filter((n: number) => !isNaN(n)) : undefined;
          const { getEvidencePack } = await import("../../utils/evidenceDatabase");
          const evidence = await getEvidencePack({ entityType, entityIds, dateFrom, dateTo });
          return c.json({ evidence, total: evidence.length });
        } catch (error) {
          return c.json({ error: "Failed to compile evidence pack" }, 500);
        }
      };
    },
  },
  {
    path: "/api/evidence-summary",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getEvidenceSummary } = await import("../../utils/evidenceDatabase");
          const summary = await getEvidenceSummary();
          return c.json({ summary });
        } catch (error) {
          return c.json({ error: "Failed to get evidence summary" }, 500);
        }
      };
    },
  },
];

export const qmsEnhancedRoutes = [
  ...evidenceRoutes,
  {
    path: "/api/qms/nc/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getNonconformances } = await import("../../utils/qmsDatabase");
          const { records } = await getNonconformances({ limit: 10000, offset: 0 });
          const csv = toCSV(records.map((r: any) => ({
            nc_number: r.nc_number, title: r.title, nc_type: r.nc_type,
            severity: r.severity, status: r.status, detected_by: r.detected_by,
            detected_date: r.detected_date, category: r.category,
            closure_approved_by: r.closure_approved_by || '',
          })));
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="nonconformances.csv"');
          return c.body(csv);
        } catch (error) {
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { getCapaRecords } = await import("../../utils/qmsDatabase");
          const { records } = await getCapaRecords({ limit: 10000, offset: 0 });
          const csv = toCSV(records.map((r: any) => ({
            capa_number: r.capa_number, title: r.title, capa_type: r.capa_type,
            severity: r.severity, status: r.status, assigned_to: r.assigned_to,
            target_date: r.target_date, effectiveness_result: r.effectiveness_result || '',
            closure_approved_by: r.closure_approved_by || '',
          })));
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="capa_records.csv"');
          return c.body(csv);
        } catch (error) {
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/compliance/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const pg = await import("pg");
          const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
          const result = await pool.query(`SELECT id, title, regulation_id, status, priority, due_date, requirement_type FROM obligations ORDER BY due_date ASC LIMIT 10000`);
          await pool.end();
          const csv = toCSV(result.rows);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="compliance_obligations.csv"');
          return c.body(csv);
        } catch (error) {
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/pdpl/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const pg = await import("pg");
          const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
          const result = await pool.query(`SELECT * FROM pdpl_data_inventory ORDER BY created_at DESC LIMIT 10000`);
          await pool.end();
          const csv = toCSV(result.rows);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="pdpl_inventory.csv"');
          return c.body(csv);
        } catch (error) {
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/kpis/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const pg = await import("pg");
          const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
          const result = await pool.query(`SELECT kd.name, kd.target, kv.value, kv.period_start, kv.period_end, kv.calculated_by FROM kpi_definitions kd LEFT JOIN kpi_values kv ON kd.id = kv.kpi_id ORDER BY kd.name, kv.period_end DESC LIMIT 10000`);
          await pool.end();
          const csv = toCSV(result.rows);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="kpi_values.csv"');
          return c.body(csv);
        } catch (error) {
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/vendors/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const pg = await import("pg");
          const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
          const result = await pool.query(`SELECT v.name, v.category, v.risk_level, va.assessment_type, va.status, va.overall_score, va.assessment_date FROM vendors v LEFT JOIN vendor_assessments va ON v.id = va.vendor_id ORDER BY v.name LIMIT 10000`);
          await pool.end();
          const csv = toCSV(result.rows);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="vendor_assessments.csv"');
          return c.body(csv);
        } catch (error) {
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/nc/bulk-update",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const { ids, status } = body;
          if (!Array.isArray(ids) || !status) {
            return c.json({ error: "ids (array) and status are required" }, 400);
          }
          const pg = await import("pg");
          const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
          const placeholders = ids.map((_: any, i: number) => `$${i + 2}`).join(',');
          const result = await pool.query(
            `UPDATE nonconformance_records SET status = $1, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id, status`,
            [status, ...ids]
          );
          await pool.end();
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({ actionType: 'UPDATE', entityType: 'CAPA', description: `Bulk NC status update to ${status}: ${ids.length} records`, module: 'qms', severity: 'INFO' });
          } catch {}
          return c.json({ success: true, updated: result.rows.length });
        } catch (error) {
          return c.json({ error: "Bulk update failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/bulk-update",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const body = await c.req.json();
          const { ids, status } = body;
          if (!Array.isArray(ids) || !status) {
            return c.json({ error: "ids (array) and status are required" }, 400);
          }
          const pg = await import("pg");
          const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
          const placeholders = ids.map((_: any, i: number) => `$${i + 2}`).join(',');
          const result = await pool.query(
            `UPDATE capa_records SET status = $1, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id, status`,
            [status, ...ids]
          );
          await pool.end();
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({ actionType: 'UPDATE', entityType: 'CAPA', description: `Bulk CAPA status update to ${status}: ${ids.length} records`, module: 'qms', severity: 'INFO' });
          } catch {}
          return c.json({ success: true, updated: result.rows.length });
        } catch (error) {
          return c.json({ error: "Bulk update failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/nc/:id/history",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { getNCChangeHistory } = await import("../../utils/changeHistoryDatabase");
          const history = await getNCChangeHistory(id);
          return c.json({ history });
        } catch (error) {
          return c.json({ error: "Failed to fetch history" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id/history",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const { getCAPAChangeHistory } = await import("../../utils/changeHistoryDatabase");
          const history = await getCAPAChangeHistory(id);
          return c.json({ history });
        } catch (error) {
          return c.json({ error: "Failed to fetch history" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/nc/:id/approve-closure",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json().catch(() => ({}));
          const { approveNCClosure } = await import("../../utils/qmsDatabase");
          const result = await approveNCClosure(id, body.approvedBy || 'Quality Manager');
          if (!result) return c.json({ error: "NC not found or already closed" }, 404);
          try {
            const { logNCChange } = await import("../../utils/changeHistoryDatabase");
            await logNCChange(id, 'status', result.status, 'closed', body.approvedBy || 'Quality Manager', 'Closure approved');
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({ actionType: 'STATUS_CHANGE', entityType: 'CAPA', entityId: String(id), description: `NC closure approved by ${body.approvedBy || 'Quality Manager'}`, module: 'qms', severity: 'INFO' });
          } catch {}
          return c.json({ success: true, nc: result });
        } catch (error) {
          return c.json({ error: "Approval failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id/effectiveness",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json();
          if (!body.result || !body.evidence || !body.reviewedBy) {
            return c.json({ error: "result, evidence, and reviewedBy are required" }, 400);
          }
          const { recordCAPAEffectiveness } = await import("../../utils/qmsDatabase");
          const capa = await recordCAPAEffectiveness(id, body.result, body.evidence, body.reviewedBy);
          if (!capa) return c.json({ error: "CAPA not found" }, 404);
          try {
            const { logCAPAChange } = await import("../../utils/changeHistoryDatabase");
            await logCAPAChange(id, 'effectiveness_result', null, body.result, body.reviewedBy, body.evidence);
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({ actionType: 'UPDATE', entityType: 'CAPA', entityId: String(id), description: `CAPA effectiveness recorded: ${body.result}`, module: 'qms', severity: 'INFO' });
          } catch {}
          return c.json({ success: true, capa });
        } catch (error) {
          return c.json({ error: "Failed to record effectiveness" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id/approve-closure",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json().catch(() => ({}));
          const { approveCAPAClosure } = await import("../../utils/qmsDatabase");
          const result = await approveCAPAClosure(id, body.approvedBy || 'Quality Manager');
          if (!result) return c.json({ error: "CAPA not found, already closed, or effectiveness not yet recorded" }, 404);
          try {
            const { logCAPAChange } = await import("../../utils/changeHistoryDatabase");
            await logCAPAChange(id, 'status', 'verification', 'closed', body.approvedBy || 'Quality Manager', 'Closure approved');
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({ actionType: 'STATUS_CHANGE', entityType: 'CAPA', entityId: String(id), description: `CAPA closure approved by ${body.approvedBy || 'Quality Manager'}`, module: 'qms', severity: 'INFO' });
          } catch {}
          return c.json({ success: true, capa: result });
        } catch (error) {
          return c.json({ error: "Approval failed" }, 500);
        }
      };
    },
  },
];
