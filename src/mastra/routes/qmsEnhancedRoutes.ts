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
          const { getEvidenceForEntity, initEvidenceTables } = await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
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
          const { addEvidence, initEvidenceTables } = await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
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
          const { deleteEvidence, initEvidenceTables } = await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
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
          const { getEvidencePack, initEvidenceTables } = await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
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
          const { getEvidenceSummary, initEvidenceTables } = await import("../../utils/evidenceDatabase");
          await initEvidenceTables();
          const summary = await getEvidenceSummary();
          return c.json({ summary });
        } catch (error) {
          return c.json({ error: "Failed to get evidence summary" }, 500);
        }
      };
    },
  },
  {
    path: "/api/qms/capa/:id",
    method: "PATCH" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const id = parseInt(c.req.param("id"));
          if (isNaN(id)) return c.json({ error: "Invalid ID" }, 400);
          const body = await c.req.json();
          const { updateCapaRecord } = await import("../../utils/qmsDatabase");
          const updates: any = {};
          if (body.status) updates.status = body.status;
          if (body.assigned_to) updates.assigned_to = body.assigned_to;
          if (body.severity) updates.severity = body.severity;
          if (body.priority) updates.priority = body.priority;
          const result = await updateCapaRecord(id, updates);
          if (!result) return c.json({ error: "CAPA not found" }, 404);
          try {
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({ actionType: 'UPDATE', entityType: 'CAPA', entityId: String(id), description: `CAPA updated: ${JSON.stringify(updates)}`, module: 'qms', severity: 'INFO', newValue: JSON.stringify(updates) });
          } catch {}
          return c.json({ success: true, capa: result });
        } catch (error) {
          return c.json({ error: "Failed to update CAPA" }, 500);
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
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const { initComplianceTables } = await import("../../utils/complianceDatabase");
          await initComplianceTables();
          const result = await pool.query(`SELECT id, obligation_code, title, regulation_id, status, requirement_type, responsible_department, compliance_frequency FROM obligations ORDER BY id ASC LIMIT 10000`);
          const csv = toCSV(result.rows);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="compliance_obligations.csv"');
          return c.body(csv);
        } catch (error) {
          console.error('Compliance export error:', error);
          return c.json({ error: "Export failed" }, 500);
        } finally { await pool.end(); }
      };
    },
  },
  {
    path: "/api/pdpl/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const { initPdplTables } = await import("../../utils/pdplDatabase");
          await initPdplTables();
          const result = await pool.query(`SELECT id, field_name, data_category, module, table_name, purpose, legal_basis, storage_location, retention_days, is_encrypted, is_masked, pii_type FROM data_inventory ORDER BY created_at DESC LIMIT 10000`);
          const csv = toCSV(result.rows);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="pdpl_inventory.csv"');
          return c.body(csv);
        } catch (error) {
          console.error('PDPL export error:', error);
          return c.json({ error: "Export failed" }, 500);
        } finally { await pool.end(); }
      };
    },
  },
  {
    path: "/api/kpis/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const result = await pool.query(`SELECT kd.kpi_name, kd.target_value, kv.actual_value, kv.period_start, kv.period_end, kv.calculated_by FROM kpi_definitions kd LEFT JOIN kpi_values kv ON kd.id = kv.kpi_id ORDER BY kd.kpi_name, kv.period_end DESC LIMIT 10000`);
          const csv = toCSV(result.rows);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="kpi_values.csv"');
          return c.body(csv);
        } catch (error) {
          return c.json({ error: "Export failed" }, 500);
        } finally { await pool.end(); }
      };
    },
  },
  {
    path: "/api/kpis/export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const defs = await pool.query(`
            SELECT id, kpi_name, kpi_code, category, target_value, unit, owner_name AS owner, frequency, formula,
                   threshold_green, threshold_amber, threshold_red, threshold_direction
            FROM kpi_definitions WHERE is_active = true ORDER BY category, kpi_name
          `);
          const values = await pool.query(`
            SELECT kpi_id, actual_value, target_value, period_start, period_end, calculated_by, created_at
            FROM kpi_values ORDER BY period_end DESC, kpi_id LIMIT 50000
          `);

          // Group definitions by category, one sheet per category
          const byCategory: Record<string, any[]> = {};
          for (const d of defs.rows) {
            const cat = d.category || 'Uncategorised';
            (byCategory[cat] = byCategory[cat] || []).push(d);
          }

          // Pivot values per kpi for the per-category sheets
          const valuesByKpi: Record<number, any[]> = {};
          for (const v of values.rows) (valuesByKpi[v.kpi_id] = valuesByKpi[v.kpi_id] || []).push(v);

          const { buildWorkbook, xlsxResponseHeaders } = await import('../../utils/excelExport');
          const fmt = (d: any) => d ? new Date(d).toISOString().substring(0, 10) : '';

          const sheets: any[] = [
            {
              name: 'Summary',
              columns: [
                { header: 'Metric', key: 'metric', width: 32 },
                { header: 'Value', key: 'value', width: 18 },
              ],
              rows: [
                { metric: 'Total KPI definitions', value: defs.rows.length },
                { metric: 'Total recorded values', value: values.rows.length },
                { metric: 'Categories', value: Object.keys(byCategory).length },
                { metric: 'Generated', value: new Date().toISOString() },
              ],
            },
          ];

          for (const [cat, list] of Object.entries(byCategory)) {
            sheets.push({
              name: cat,
              columns: [
                { header: 'Code', key: 'kpi_code', width: 12 },
                { header: 'KPI Name', key: 'kpi_name', width: 36 },
                { header: 'Target', key: 'target_value', width: 12 },
                { header: 'Unit', key: 'unit', width: 8 },
                { header: 'Green ≥', key: 'threshold_green', width: 10 },
                { header: 'Amber ≥', key: 'threshold_amber', width: 10 },
                { header: 'Red <', key: 'threshold_red', width: 10 },
                { header: 'Direction', key: 'threshold_direction', width: 18 },
                { header: 'Frequency', key: 'frequency', width: 12 },
                { header: 'Owner', key: 'owner', width: 22 },
                { header: 'Latest Actual', key: 'latest_actual', width: 14 },
                { header: 'Latest Period End', key: 'latest_period', width: 16 },
                { header: 'Formula', key: 'formula', width: 40 },
              ],
              rows: list.map((d: any) => {
                const vs = (valuesByKpi[d.id] || []).sort((a, b) => new Date(b.period_end).getTime() - new Date(a.period_end).getTime());
                const latest = vs[0];
                return {
                  ...d,
                  latest_actual: latest?.actual_value ?? '',
                  latest_period: fmt(latest?.period_end),
                };
              }),
            });
          }

          sheets.push({
            name: 'All Values',
            columns: [
              { header: 'KPI ID', key: 'kpi_id', width: 8 },
              { header: 'KPI Name', key: 'kpi_name', width: 36 },
              { header: 'Actual', key: 'actual_value', width: 12 },
              { header: 'Target', key: 'target_value', width: 12 },
              { header: 'Period Start', key: 'period_start_str', width: 14 },
              { header: 'Period End', key: 'period_end_str', width: 14 },
              { header: 'Calculated By', key: 'calculated_by', width: 22 },
            ],
            rows: values.rows.map((v: any) => {
              const def = defs.rows.find((d: any) => d.id === v.kpi_id);
              return {
                ...v,
                kpi_name: def?.kpi_name || '',
                period_start_str: fmt(v.period_start),
                period_end_str: fmt(v.period_end),
              };
            }),
          });

          const buf = await buildWorkbook(sheets, { title: 'KPI Scorecard Export' });
          return c.body(buf, 200, xlsxResponseHeaders(`kpi_scorecard_${Date.now()}.xlsx`));
        } catch (error) {
          console.error('Error exporting KPIs XLSX:', error);
          return c.json({ error: "Export failed" }, 500);
        } finally { await pool.end(); }
      };
    },
  },
  {
    path: "/api/vendors/export",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const { initVendorTables } = await import("../../utils/vendorDatabase");
          await initVendorTables();
          const result = await pool.query(`SELECT v.name, v.category, v.overall_risk_level, va.assessment_type, va.status, va.overall_score, va.assessment_date FROM vendors v LEFT JOIN vendor_assessments va ON v.id = va.vendor_id ORDER BY v.name LIMIT 10000`);
          const csv = toCSV(result.rows);
          c.header('Content-Type', 'text/csv');
          c.header('Content-Disposition', 'attachment; filename="vendor_assessments.csv"');
          return c.body(csv);
        } catch (error) {
          return c.json({ error: "Export failed" }, 500);
        } finally { await pool.end(); }
      };
    },
  },
  {
    path: "/api/qms/nc/export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          if (!requireAdminOrKey(c)) return unauthorizedResponse(c);
          const { getNonconformances } = await import("../../utils/qmsDatabase");
          const { records } = await getNonconformances({ limit: 50000, offset: 0 });
          const { buildWorkbook, xlsxResponseHeaders } = await import('../../utils/excelExport');
          const fmt = (d: any) => d ? new Date(d).toISOString().substring(0, 10) : '';

          const bySeverity = (sev: string) => records.filter((r: any) => r.severity === sev).length;
          const byStatus = (st: string) => records.filter((r: any) => r.status === st).length;

          const buf = await buildWorkbook([
            {
              name: 'Summary',
              columns: [{ header: 'Metric', key: 'metric', width: 32 }, { header: 'Value', key: 'value', width: 18 }],
              rows: [
                { metric: 'Total nonconformances', value: records.length },
                { metric: 'Open', value: byStatus('open') },
                { metric: 'Acknowledged', value: byStatus('acknowledged') },
                { metric: 'Closed', value: byStatus('closed') },
                { metric: 'Critical', value: bySeverity('critical') },
                { metric: 'Major', value: bySeverity('major') },
                { metric: 'Minor', value: bySeverity('minor') },
                { metric: 'Generated', value: new Date().toISOString() },
              ],
            },
            {
              name: 'Nonconformances',
              columns: [
                { header: 'NC #', key: 'nc_number', width: 14 },
                { header: 'Title', key: 'title', width: 40 },
                { header: 'Type', key: 'nc_type', width: 16 },
                { header: 'Category', key: 'category', width: 16 },
                { header: 'Severity', key: 'severity', width: 12 },
                { header: 'Status', key: 'status', width: 14 },
                { header: 'Disposition', key: 'disposition', width: 16 },
                { header: 'Source', key: 'source_type', width: 16 },
                { header: 'Source Ref', key: 'source_reference', width: 22 },
                { header: 'Detected By', key: 'detected_by', width: 22 },
                { header: 'Detected', key: 'detected_date_str', width: 14 },
                { header: 'Reviewed By', key: 'reviewed_by', width: 22 },
                { header: 'Closed By', key: 'closed_by', width: 22 },
                { header: 'Closed', key: 'closed_date_str', width: 14 },
                { header: 'Description', key: 'description', width: 50 },
                { header: 'Disposition Notes', key: 'disposition_notes', width: 40 },
              ],
              rows: records.map((r: any) => ({
                ...r,
                detected_date_str: fmt(r.detected_date),
                closed_date_str: fmt(r.closed_date),
              })),
            },
          ], { title: 'Nonconformance Records Export' });

          return c.body(buf, 200, xlsxResponseHeaders(`nonconformances_${Date.now()}.xlsx`));
        } catch (error) {
          console.error('Error exporting NC XLSX:', error);
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    // NOTE: not "/api/qms/capa/export-xlsx" — that pattern is shadowed by the
    // GET "/api/qms/capa/:id" handler defined in src/mastra/index.ts which would
    // try to parseInt('export-xlsx') and 500. The hyphenated path avoids the param match.
    path: "/api/qms/capa-export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
          if (!requireAdminOrKey(c)) return unauthorizedResponse(c);
          const { getCapaRecords } = await import("../../utils/qmsDatabase");
          const { records } = await getCapaRecords({ limit: 50000, offset: 0 });
          const { buildWorkbook, xlsxResponseHeaders } = await import('../../utils/excelExport');
          const fmt = (d: any) => d ? new Date(d).toISOString().substring(0, 10) : '';

          const byStatus = (st: string) => records.filter((r: any) => r.status === st).length;
          const overdue = records.filter((r: any) => r.target_date && r.status !== 'closed' && new Date(r.target_date) < new Date()).length;

          const buf = await buildWorkbook([
            {
              name: 'Summary',
              columns: [{ header: 'Metric', key: 'metric', width: 32 }, { header: 'Value', key: 'value', width: 18 }],
              rows: [
                { metric: 'Total CAPAs', value: records.length },
                { metric: 'Open', value: byStatus('open') },
                { metric: 'Investigation', value: byStatus('investigation') },
                { metric: 'Action Plan', value: byStatus('action_plan') },
                { metric: 'Implementation', value: byStatus('implementation') },
                { metric: 'Verification', value: byStatus('verification') },
                { metric: 'Closed', value: byStatus('closed') },
                { metric: 'Overdue (open + past target date)', value: overdue },
                { metric: 'Generated', value: new Date().toISOString() },
              ],
            },
            {
              name: 'CAPAs',
              columns: [
                { header: 'CAPA #', key: 'capa_number', width: 14 },
                { header: 'Title', key: 'title', width: 40 },
                { header: 'Type', key: 'capa_type', width: 14 },
                { header: 'Severity', key: 'severity', width: 12 },
                { header: 'Priority', key: 'priority', width: 10 },
                { header: 'Status', key: 'status', width: 16 },
                { header: 'Assigned To', key: 'assigned_to', width: 22 },
                { header: 'Target Date', key: 'target_date_str', width: 14 },
                { header: 'Completion Date', key: 'completion_date_str', width: 16 },
                { header: 'Verification Date', key: 'verification_date_str', width: 16 },
                { header: 'Effectiveness', key: 'effectiveness_result', width: 16 },
                { header: 'Closure Approved By', key: 'closure_approved_by', width: 22 },
                { header: 'Source', key: 'source_type', width: 16 },
                { header: 'Source Ref', key: 'source_reference', width: 22 },
                { header: 'Root Cause', key: 'root_cause', width: 40 },
                { header: 'Corrective Action', key: 'corrective_action', width: 40 },
                { header: 'Preventive Action', key: 'preventive_action', width: 40 },
              ],
              rows: records.map((r: any) => ({
                ...r,
                target_date_str: fmt(r.target_date),
                completion_date_str: fmt(r.completion_date),
                verification_date_str: fmt(r.verification_date),
              })),
            },
          ], { title: 'CAPA Records Export' });

          return c.body(buf, 200, xlsxResponseHeaders(`capa_records_${Date.now()}.xlsx`));
        } catch (error) {
          console.error('Error exporting CAPA XLSX:', error);
          return c.json({ error: "Export failed" }, 500);
        }
      };
    },
  },
  {
    path: "/api/vendors/export-xlsx",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        const { requireAdminOrKey, unauthorizedResponse } = await import('../../utils/rbacMiddleware');
        if (!requireAdminOrKey(c)) return unauthorizedResponse(c);
        const pg = await import("pg");
        const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
        try {
          const { initVendorTables } = await import("../../utils/vendorDatabase");
          await initVendorTables();

          const vendors = await pool.query(`
            SELECT id, vendor_code, name, category, criticality, status,
                   contract_start, contract_end, contract_value,
                   primary_contact_name, primary_contact_email, primary_contact_phone,
                   country, data_access_level, last_assessment_date
            FROM vendors ORDER BY name LIMIT 10000
          `);
          const assessments = await pool.query(`
            SELECT va.vendor_id, v.name AS vendor_name, va.assessment_type, va.assessment_date,
                   va.assessed_by, va.status, va.security_score, va.financial_score,
                   va.operational_score, va.compliance_score, va.overall_score, va.risk_level,
                   va.recommendations
            FROM vendor_assessments va LEFT JOIN vendors v ON v.id = va.vendor_id
            ORDER BY va.assessment_date DESC LIMIT 50000
          `);

          const { buildWorkbook, xlsxResponseHeaders } = await import('../../utils/excelExport');
          const fmt = (d: any) => d ? new Date(d).toISOString().substring(0, 10) : '';

          const byCrit = (c: string) => vendors.rows.filter((v: any) => v.criticality === c).length;
          const byRisk = (l: string) => assessments.rows.filter((a: any) => a.risk_level === l).length;

          const buf = await buildWorkbook([
            {
              name: 'Summary',
              columns: [{ header: 'Metric', key: 'metric', width: 32 }, { header: 'Value', key: 'value', width: 18 }],
              rows: [
                { metric: 'Total vendors', value: vendors.rows.length },
                { metric: 'Critical criticality', value: byCrit('critical') },
                { metric: 'High criticality', value: byCrit('high') },
                { metric: 'Total assessments', value: assessments.rows.length },
                { metric: 'High-risk assessments', value: byRisk('high') + byRisk('critical') },
                { metric: 'Generated', value: new Date().toISOString() },
              ],
            },
            {
              name: 'Vendors',
              columns: [
                { header: 'Code', key: 'vendor_code', width: 12 },
                { header: 'Name', key: 'name', width: 36 },
                { header: 'Category', key: 'category', width: 18 },
                { header: 'Criticality', key: 'criticality', width: 12 },
                { header: 'Status', key: 'status', width: 18 },
                { header: 'Country', key: 'country', width: 14 },
                { header: 'Data Access', key: 'data_access_level', width: 14 },
                { header: 'Contract Start', key: 'contract_start_str', width: 14 },
                { header: 'Contract End', key: 'contract_end_str', width: 14 },
                { header: 'Contract Value', key: 'contract_value', width: 14 },
                { header: 'Primary Contact', key: 'primary_contact_name', width: 24 },
                { header: 'Email', key: 'primary_contact_email', width: 28 },
                { header: 'Phone', key: 'primary_contact_phone', width: 18 },
                { header: 'Last Assessment', key: 'last_assessment_str', width: 16 },
              ],
              rows: vendors.rows.map((v: any) => ({
                ...v,
                contract_start_str: fmt(v.contract_start),
                contract_end_str: fmt(v.contract_end),
                last_assessment_str: fmt(v.last_assessment_date),
              })),
            },
            {
              name: 'Assessments',
              columns: [
                { header: 'Vendor', key: 'vendor_name', width: 30 },
                { header: 'Type', key: 'assessment_type', width: 14 },
                { header: 'Date', key: 'assessment_date_str', width: 14 },
                { header: 'Status', key: 'status', width: 12 },
                { header: 'Risk Level', key: 'risk_level', width: 12 },
                { header: 'Overall', key: 'overall_score', width: 10 },
                { header: 'Security', key: 'security_score', width: 10 },
                { header: 'Financial', key: 'financial_score', width: 10 },
                { header: 'Operational', key: 'operational_score', width: 12 },
                { header: 'Compliance', key: 'compliance_score', width: 12 },
                { header: 'Assessed By', key: 'assessed_by', width: 22 },
                { header: 'Recommendations', key: 'recommendations', width: 40 },
              ],
              rows: assessments.rows.map((a: any) => ({
                ...a,
                assessment_date_str: fmt(a.assessment_date),
              })),
            },
          ], { title: 'Vendor Risk Export' });

          return c.body(buf, 200, xlsxResponseHeaders(`vendors_${Date.now()}.xlsx`));
        } catch (error) {
          console.error('Error exporting vendors XLSX:', error);
          return c.json({ error: "Export failed" }, 500);
        } finally { await pool.end(); }
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
          try {
            const placeholders = ids.map((_: any, i: number) => `$${i + 2}`).join(',');
            const result = await pool.query(
              `UPDATE nonconformance_records SET status = $1, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id, status`,
              [status, ...ids]
            );
            try {
              const { logEvent } = await import("../../utils/eventLogsDatabase");
              await logEvent({ actionType: 'UPDATE', entityType: 'CAPA', description: `Bulk NC status update to ${status}: ${ids.length} records`, module: 'qms', severity: 'INFO' });
            } catch {}
            return c.json({ success: true, updated: result.rows.length });
          } finally { await pool.end(); }
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
          try {
            const placeholders = ids.map((_: any, i: number) => `$${i + 2}`).join(',');
            const result = await pool.query(
              `UPDATE capa_records SET status = $1, updated_at = NOW() WHERE id IN (${placeholders}) RETURNING id, status`,
              [status, ...ids]
            );
            try {
              const { logEvent } = await import("../../utils/eventLogsDatabase");
              await logEvent({ actionType: 'UPDATE', entityType: 'CAPA', description: `Bulk CAPA status update to ${status}: ${ids.length} records`, module: 'qms', severity: 'INFO' });
            } catch {}
            return c.json({ success: true, updated: result.rows.length });
          } finally { await pool.end(); }
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
          const { getNCChangeHistory, initChangeHistoryTables } = await import("../../utils/changeHistoryDatabase");
          await initChangeHistoryTables();
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
          const { getCAPAChangeHistory, initChangeHistoryTables } = await import("../../utils/changeHistoryDatabase");
          await initChangeHistoryTables();
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
            const { logNCChange, initChangeHistoryTables } = await import("../../utils/changeHistoryDatabase");
            await initChangeHistoryTables();
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
          const { recordCAPAEffectiveness, createCapaRecord, getCapaById } = await import("../../utils/qmsDatabase");
          const capa = await recordCAPAEffectiveness(id, body.result, body.evidence, body.reviewedBy);
          if (!capa) return c.json({ error: "CAPA not found" }, 404);
          let reCapaId: number | null = null;
          try {
            const { logCAPAChange, initChangeHistoryTables } = await import("../../utils/changeHistoryDatabase");
            await initChangeHistoryTables();
            await logCAPAChange(id, 'effectiveness_result', null, body.result, body.reviewedBy, body.evidence);
            const { logEvent } = await import("../../utils/eventLogsDatabase");
            await logEvent({ actionType: 'UPDATE', entityType: 'CAPA', entityId: String(id), description: `CAPA effectiveness recorded: ${body.result}`, module: 'qms', severity: 'INFO' });
          } catch {}
          if (body.result === 'not_effective') {
            try {
              const original = await getCapaById(id);
              if (original) {
                const reCapa = await createCapaRecord({
                  title: `Re-CAPA: ${original.title}`,
                  description: `Auto-generated re-CAPA because CAPA ${original.capa_number} was found not effective. Evidence: ${body.evidence}`,
                  capa_type: original.capa_type || 'corrective',
                  source_type: 'capa',
                  source_id: String(original.id),
                  source_reference: original.capa_number,
                  severity: original.severity || 'major',
                  status: 'open',
                  priority: 'high',
                  assigned_to: original.assigned_to,
                  target_date: new Date(Date.now() + 30 * 86400000),
                  created_by: body.reviewedBy || 'System',
                });
                reCapaId = reCapa.id;
                try {
                  const { logEvent } = await import("../../utils/eventLogsDatabase");
                  await logEvent({ actionType: 'CREATE', entityType: 'CAPA', entityId: String(reCapa.id), entityName: reCapa.capa_number, description: `Auto re-CAPA created from ineffective CAPA ${original.capa_number}`, module: 'qms', severity: 'WARNING' });
                } catch {}
              }
            } catch {}
          }
          return c.json({ success: true, capa, reCapaId });
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
            const { logCAPAChange, initChangeHistoryTables } = await import("../../utils/changeHistoryDatabase");
            await initChangeHistoryTables();
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
