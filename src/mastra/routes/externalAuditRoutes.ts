/**
 * External Audits API routes.
 *
 * Covers: regulatory audits, certification audits (ISO 27001/9001 initial),
 * surveillance visits, re-certification, and customer-driven audits.
 *
 * Home page: /external-audits. Summary card exposed on /grc.
 *
 * Endpoints:
 *   GET    /api/external-audits                      list (filters: status, kind, upcoming_only)
 *   GET    /api/external-audits/summary              dashboard numbers
 *   POST   /api/external-audits                      create
 *   GET    /api/external-audits/:id                  detail + checklist + certs
 *   PUT    /api/external-audits/:id                  update
 *   POST   /api/external-audits/:id/checklist        add checklist item
 *   PUT    /api/external-audits/checklist/:itemId    update checklist item
 *   POST   /api/external-audits/:id/certificates     register issued certificate
 *   GET    /api/external-audits/certificates         list certificates
 *
 * Compliance refs: WP-SOP-042 (External Audit Management), WP-FORM-057
 * (Readiness Checklist), ISO 17021 (CB conduct), ISO 19011 §5.5.
 */

import {
  initAuditProgrammeTables,
  createExternalAudit,
  listExternalAudits,
  getExternalAuditById,
  updateExternalAudit,
  addChecklistItem,
  listChecklist,
  updateChecklistItemFields,
  createCertificate,
  listCertificates,
  getExternalAuditsSummary,
  type ExternalAuditKind,
} from '../../utils/auditProgrammeDatabase';
import {
  getSessionUser,
  unauthorizedResponse,
  forbiddenResponse,
} from '../../utils/rbacMiddleware';
import { logEvent } from '../../utils/eventLogsDatabase';

const WRITE_ROLES = new Set([
  'admin',
  'head_of_operations_quality',
  'grc_manager',
  'quality_manager',
]);

let ready = false;
async function ensure() {
  if (ready) return;
  await initAuditProgrammeTables();
  ready = true;
}

function canWrite(role: string | null | undefined): boolean {
  return !!role && WRITE_ROLES.has(role);
}

export const externalAuditRoutes = [
  /* ---------------- GET /api/external-audits ---------------------------- */
  {
    path: '/api/external-audits',
    method: 'GET' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        const url = new URL(c.req.url);
        const rows = await listExternalAudits({
          status:        url.searchParams.get('status') || undefined,
          kind:          (url.searchParams.get('kind') as ExternalAuditKind) || undefined,
          upcoming_only: url.searchParams.get('upcoming_only') === 'true',
        });
        return c.json({ success: true, rows });
      } catch (err: any) {
        console.error('[ExternalAudits] list error', err);
        return c.json({ error: 'Failed to list', details: err.message }, 500);
      }
    },
  },

  /* ---------------- GET /api/external-audits/summary -------------------- */
  {
    path: '/api/external-audits/summary',
    method: 'GET' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        const summary = await getExternalAuditsSummary();
        return c.json({ success: true, ...summary });
      } catch (err: any) {
        console.error('[ExternalAudits] summary error', err);
        return c.json({ error: 'Failed to build summary', details: err.message }, 500);
      }
    },
  },

  /* ---------------- GET /api/external-audits/certificates --------------- */
  {
    path: '/api/external-audits/certificates',
    method: 'GET' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        const url = new URL(c.req.url);
        const expDays = url.searchParams.get('expiring_within_days');
        const rows = await listCertificates({
          status: url.searchParams.get('status') || undefined,
          expiring_within_days: expDays ? parseInt(expDays, 10) : undefined,
        });
        return c.json({ success: true, rows });
      } catch (err: any) {
        console.error('[ExternalAudits] certs list error', err);
        return c.json({ error: 'Failed to list certificates', details: err.message }, 500);
      }
    },
  },

  /* ---------------- POST /api/external-audits --------------------------- */
  {
    path: '/api/external-audits',
    method: 'POST' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canWrite(user.role)) return forbiddenResponse(c);
        const body = await c.req.json().catch(() => ({}));
        if (!body?.title || !body?.kind) {
          return c.json({ error: 'title and kind are required' }, 400);
        }
        const audit = await createExternalAudit({
          kind:               body.kind,
          title:              body.title,
          standard:           body.standard ?? null,
          certification_body: body.certification_body ?? null,
          auditor_name:       body.auditor_name ?? null,
          scope_summary:      body.scope_summary ?? null,
          planned_start:      body.planned_start ? new Date(body.planned_start) : null,
          planned_end:        body.planned_end ? new Date(body.planned_end) : null,
          actual_start:       null,
          actual_end:         null,
          status:             body.status || 'scheduled',
          created_by_email:   user.email,
        } as any);

        await logEvent({
          userId: user.userId, userEmail: user.email, userRole: user.role,
          actionType: 'CREATE', entityType: 'external_audit',
          entityId: String(audit.id), entityName: audit.audit_code,
          description: `Registered external audit ${audit.audit_code} (${audit.title})`,
          module: 'grc', severity: 'INFO',
        }).catch(() => { /* non-fatal */ });

        return c.json({ success: true, audit }, 201);
      } catch (err: any) {
        console.error('[ExternalAudits] create error', err);
        return c.json({ error: 'Failed to create', details: err.message }, 500);
      }
    },
  },

  /* ---------------- GET /api/external-audits/:id ------------------------ */
  {
    path: '/api/external-audits/:id',
    method: 'GET' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        const id = parseInt(c.req.param('id'), 10);
        if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
        const audit = await getExternalAuditById(id);
        if (!audit) return c.json({ error: 'Not found' }, 404);
        const [checklist, certs] = await Promise.all([
          listChecklist(id),
          listCertificates({}).then(rows => rows.filter(r => r.external_audit_id === id)),
        ]);
        return c.json({ success: true, audit, checklist, certificates: certs });
      } catch (err: any) {
        console.error('[ExternalAudits] detail error', err);
        return c.json({ error: 'Failed to fetch', details: err.message }, 500);
      }
    },
  },

  /* ---------------- PUT /api/external-audits/:id ------------------------ */
  {
    path: '/api/external-audits/:id',
    method: 'PUT' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canWrite(user.role)) return forbiddenResponse(c);
        const id = parseInt(c.req.param('id'), 10);
        if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
        const body = await c.req.json().catch(() => ({}));
        const patch: any = { ...body };
        for (const k of ['planned_start', 'planned_end', 'actual_start', 'actual_end']) {
          if (patch[k]) patch[k] = new Date(patch[k]);
        }
        const updated = await updateExternalAudit(id, patch);
        if (!updated) return c.json({ error: 'Not found' }, 404);
        return c.json({ success: true, audit: updated });
      } catch (err: any) {
        console.error('[ExternalAudits] update error', err);
        return c.json({ error: 'Failed to update', details: err.message }, 500);
      }
    },
  },

  /* ---------------- POST /api/external-audits/:id/checklist ------------- */
  {
    path: '/api/external-audits/:id/checklist',
    method: 'POST' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canWrite(user.role)) return forbiddenResponse(c);
        const id = parseInt(c.req.param('id'), 10);
        const body = await c.req.json().catch(() => ({}));
        if (!body?.category || !body?.requirement) {
          return c.json({ error: 'category and requirement are required' }, 400);
        }
        await addChecklistItem({
          external_audit_id: id,
          category:    body.category,
          requirement: body.requirement,
          owner_email: body.owner_email ?? user.email,
          order_index: typeof body.order_index === 'number' ? body.order_index : 0,
        });
        const items = await listChecklist(id);
        return c.json({ success: true, checklist: items }, 201);
      } catch (err: any) {
        console.error('[ExternalAudits] checklist add error', err);
        return c.json({ error: 'Failed to add item', details: err.message }, 500);
      }
    },
  },

  /* ---------------- PUT /api/external-audits/checklist/:itemId ---------- */
  {
    path: '/api/external-audits/checklist/:itemId',
    method: 'PUT' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canWrite(user.role)) return forbiddenResponse(c);
        const itemId = parseInt(c.req.param('itemId'), 10);
        const body = await c.req.json().catch(() => ({}));
        await updateChecklistItemFields(itemId, {
          status:        body.status,
          owner_email:   body.owner_email,
          evidence_link: body.evidence_link,
          notes:         body.notes,
        });
        return c.json({ success: true });
      } catch (err: any) {
        console.error('[ExternalAudits] checklist update error', err);
        return c.json({ error: 'Failed to update item', details: err.message }, 500);
      }
    },
  },

  /* ---------------- POST /api/external-audits/:id/certificates ---------- */
  {
    path: '/api/external-audits/:id/certificates',
    method: 'POST' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canWrite(user.role)) return forbiddenResponse(c);
        const id = parseInt(c.req.param('id'), 10);
        const body = await c.req.json().catch(() => ({}));
        if (!body?.certificate_number || !body?.standard || !body?.certification_body) {
          return c.json({
            error: 'certificate_number, standard, and certification_body are required',
          }, 400);
        }
        const cert = await createCertificate({
          external_audit_id: id,
          certificate_number: body.certificate_number,
          standard:           body.standard,
          certification_body: body.certification_body,
          issue_date:         body.issue_date  ? new Date(body.issue_date)  : null,
          expiry_date:        body.expiry_date ? new Date(body.expiry_date) : null,
          scope_statement:    body.scope_statement ?? null,
          file_path:          null,
          status:             body.status || 'active',
          uploaded_by_email:  user.email,
        } as any);

        await logEvent({
          userId: user.userId, userEmail: user.email, userRole: user.role,
          actionType: 'CREATE', entityType: 'external_audit_certificate',
          entityId: String(cert.id), entityName: cert.certificate_number,
          description: `Registered certificate ${cert.certificate_number} (${cert.standard})`,
          module: 'grc', severity: 'INFO',
        }).catch(() => { /* non-fatal */ });

        return c.json({ success: true, certificate: cert }, 201);
      } catch (err: any) {
        console.error('[ExternalAudits] cert create error', err);
        return c.json({ error: 'Failed to create certificate', details: err.message }, 500);
      }
    },
  },
];
