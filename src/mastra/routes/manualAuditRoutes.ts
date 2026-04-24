/**
 * Manual Audit Intake API routes.
 *
 * Workflow:
 *   1. Quality Manager uploads an off-platform audit report (PDF/DOCX) via
 *      POST /api/manual-audit-intake (multipart form).
 *   2. GPT-4o extracts structured findings via POST /api/manual-audit-intake/:id/extract.
 *      Extraction writes confidence-scored rows to `manual_audit_findings`.
 *   3. QM reviews each finding (accept/edit/reject) via
 *      POST /api/manual-audit-intake/findings/:id/review.
 *   4. When QM presses "Finalize", accepted findings are PROMOTED into the
 *      platform's canonical `grc_audit_findings` table (linked to a new
 *      `audits` row with source_party='quality_manual').
 *      POST /api/manual-audit-intake/:id/finalize.
 *
 * Compliance references: WP-SOP-041 (Manual Intake Process), WP-FORM-056
 * (Intake Template), ISO 19011:2018 §6.4 (audit evidence), PDPL Art. 16
 * (human review of automated decisions — AI extracts, human ratifies).
 */

import {
  initAuditProgrammeTables,
  createIntake,
  listIntakes,
  getIntakeById,
  updateIntakeStatus,
  insertManualFindings,
  listManualFindings,
  reviewManualFinding,
  markFindingPromoted,
  type AuditSourceParty,
  type ManualIntakeStatus,
} from '../../utils/auditProgrammeDatabase';
import {
  getSessionUser,
  unauthorizedResponse,
  forbiddenResponse,
} from '../../utils/rbacMiddleware';
import { logEvent } from '../../utils/eventLogsDatabase';
import { createAudit, createFinding } from '../../utils/auditDatabase';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';

const INTAKE_UPLOAD_DIR = process.env.MANUAL_INTAKE_DIR
  || path.join(process.env.UPLOAD_DIR || '/data/documents', 'manual-intake');
const MAX_INTAKE_FILE_SIZE = 30 * 1024 * 1024; // 30 MB
const ALLOWED_INTAKE_EXT = new Set(['.pdf', '.docx', '.doc', '.txt', '.md']);

const INTAKE_ROLES = new Set(['admin', 'head_of_operations_quality', 'quality_manager']);

let ready = false;
async function ensure() {
  if (ready) return;
  await initAuditProgrammeTables();
  await fs.mkdir(INTAKE_UPLOAD_DIR, { recursive: true }).catch(() => { /* best effort */ });
  ready = true;
}

function canIntake(role: string | null | undefined): boolean {
  return !!role && INTAKE_ROLES.has(role);
}

async function saveIntakeFile(file: File): Promise<{
  filePath: string;
  fileName: string;
  fileSize: number;
  fileSha256: string;
  fileMime: string;
}> {
  const originalName = file.name || 'intake';
  const ext = path.extname(originalName).toLowerCase();
  if (!ALLOWED_INTAKE_EXT.has(ext)) {
    throw new Error(`File type not allowed: ${ext}. Allowed: ${[...ALLOWED_INTAKE_EXT].join(', ')}`);
  }
  if (file.size > MAX_INTAKE_FILE_SIZE) {
    throw new Error(`File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB (max 30 MB)`);
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const safe = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storedName = `${Date.now()}_${sha256.slice(0, 12)}_${safe}`;
  const filePath = path.join(INTAKE_UPLOAD_DIR, storedName);
  await fs.writeFile(filePath, buffer);
  return {
    filePath,
    fileName: originalName,
    fileSize: file.size,
    fileSha256: sha256,
    fileMime: file.type || 'application/octet-stream',
  };
}

/* ------------------------------------------------------------------------- *
 * Extraction — GPT-4o
 * ------------------------------------------------------------------------- */

const EXTRACTION_SCHEMA_DESCRIPTION = `Return STRICT JSON of shape:
{
  "findings": [
    {
      "finding_ref":        string | null,   // auditor's code if present ("F-01", "NC-12", etc.)
      "title":              string,          // short (<120 chars)
      "description":        string,          // 2-6 sentence description
      "severity":           "critical" | "major" | "minor" | "observation" | "unknown",
      "category":           string | null,   // "Access Control" | "Data Privacy" | ...
      "responsible_party":  string | null,
      "due_date":           "YYYY-MM-DD" | null,
      "source_page":        number | null,   // page of PDF this was extracted from
      "source_excerpt":     string | null,   // 1-2 sentence verbatim quote
      "confidence_score":   number           // 0.00 to 1.00
    }
  ]
}
Rules:
- DO NOT invent findings. Only extract what is explicitly stated.
- If the document is not an audit report or contains no findings, return {"findings": []}.
- Map severity loosely: "major nonconformity"->major, "minor"->minor, "observation"/"OFI"->observation.
- When uncertain, set severity="unknown" and confidence_score<=0.5.
- source_excerpt must be a VERBATIM quote from the document.`;

const EXTRACTION_SYSTEM_PROMPT =
  `You are an ISO 19011 internal audit assistant. Your job is to extract audit findings from an off-platform audit report supplied by the Quality Manager. ` +
  `You MUST NOT fabricate. You MUST quote a source excerpt for every finding so the human reviewer can verify. ` +
  `You MUST assign a confidence_score between 0 and 1 reflecting how clearly the finding is stated. ` +
  EXTRACTION_SCHEMA_DESCRIPTION;

/**
 * Extract findings from text content using GPT-4o.
 * Returns parsed findings array or throws if the model output is unusable.
 */
async function extractFindingsFromText(text: string): Promise<any[]> {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { generateText } = await import('ai');
  const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  // Truncate if absurdly long (GPT-4o handles ~128k tokens but the intake
  // workflow rarely needs more than first ~100k chars = ~25k tokens).
  const safeText = text.length > 100_000 ? text.slice(0, 100_000) : text;

  const { text: raw } = await generateText({
    model: openai.responses('gpt-4o'),
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: `Extract audit findings from the following report.\n\nReport:\n"""\n${safeText}\n"""\n\nReturn ONLY valid JSON as specified.`,
  });

  // Strip ```json fences if present
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // Attempt to extract the first balanced { ... } block
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('GPT-4o response did not contain valid JSON');
    parsed = JSON.parse(match[0]);
  }
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  return findings.map((f: any) => ({
    finding_ref:       typeof f.finding_ref === 'string' ? f.finding_ref : null,
    title:             String(f.title || 'Untitled finding').slice(0, 500),
    description:       String(f.description || ''),
    severity:          ['critical','major','minor','observation'].includes(f.severity) ? f.severity : 'unknown',
    category:          f.category ?? null,
    responsible_party: f.responsible_party ?? null,
    due_date:          f.due_date && /^\d{4}-\d{2}-\d{2}$/.test(f.due_date) ? new Date(f.due_date) : null,
    source_page:       Number.isFinite(f.source_page) ? f.source_page : null,
    source_excerpt:    typeof f.source_excerpt === 'string' ? f.source_excerpt.slice(0, 2000) : null,
    confidence_score:  Math.max(0, Math.min(1, Number(f.confidence_score) || 0)),
  }));
}

/**
 * Read stored intake file as plain text. For .pdf and .docx we'd normally
 * pipe through pdf-parse/mammoth, but those deps aren't installed yet. For
 * P0 we support .txt/.md natively and ask the client to paste extracted
 * text in the request body for .pdf/.docx — see /extract endpoint.
 */
async function readIntakeFileAsText(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    return await fs.readFile(filePath, 'utf-8');
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Route definitions
 * ------------------------------------------------------------------------- */

export const manualAuditRoutes = [
  /* ---------------- GET /api/manual-audit-intake ------------------------ */
  {
    path: '/api/manual-audit-intake',
    method: 'GET' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canIntake(user.role)) return forbiddenResponse(c);
        const url = new URL(c.req.url);
        const status = url.searchParams.get('status') as ManualIntakeStatus | null;
        const rows = await listIntakes({ status: status || undefined, limit: 200 });
        return c.json({ success: true, rows });
      } catch (err: any) {
        console.error('[ManualIntake] list error', err);
        return c.json({ error: 'Failed to list intakes', details: err.message }, 500);
      }
    },
  },

  /* ---------------- POST /api/manual-audit-intake ----------------------- *
   * Multipart form:
   *   file              (required, .pdf/.docx/.txt/.md)
   *   title             (required)
   *   audit_source_party (required enum — see auditProgrammeDatabase)
   *   department        (optional)
   *   auditor_name      (optional)
   *   audit_date        (optional YYYY-MM-DD)
   * ---------------------------------------------------------------- */
  {
    path: '/api/manual-audit-intake',
    method: 'POST' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canIntake(user.role)) return forbiddenResponse(c);

        const body = await c.req.parseBody();
        const file = body['file'];
        if (!file || !(file instanceof File)) {
          return c.json({ error: 'file is required (multipart)' }, 400);
        }
        const title = String(body['title'] || '').trim();
        if (!title) return c.json({ error: 'title is required' }, 400);
        const source = String(body['audit_source_party'] || '') as AuditSourceParty;
        if (!source) return c.json({ error: 'audit_source_party is required' }, 400);

        const saved = await saveIntakeFile(file);
        const intake = await createIntake({
          title,
          audit_source_party: source,
          department:    body['department'] ? String(body['department']) : undefined,
          auditor_name:  body['auditor_name'] ? String(body['auditor_name']) : undefined,
          audit_date:    body['audit_date'] ? new Date(String(body['audit_date'])) : null,
          file_name:     saved.fileName,
          file_path:     saved.filePath,
          file_mime:     saved.fileMime,
          file_sha256:   saved.fileSha256,
          uploaded_by_email: user.email || 'unknown',
        });

        await logEvent({
          userId: user.userId, userEmail: user.email, userRole: user.role,
          actionType: 'CREATE', entityType: 'manual_audit_intake',
          entityId: String(intake.id), entityName: intake.intake_code,
          description: `Uploaded manual audit intake ${intake.intake_code} (${intake.file_name}, ${saved.fileSize} bytes)`,
          module: 'audits', severity: 'INFO',
        }).catch(() => { /* non-fatal */ });

        return c.json({ success: true, intake }, 201);
      } catch (err: any) {
        console.error('[ManualIntake] upload error', err);
        return c.json({ error: 'Failed to create intake', details: err.message }, 500);
      }
    },
  },

  /* ---------------- GET /api/manual-audit-intake/:id -------------------- */
  {
    path: '/api/manual-audit-intake/:id',
    method: 'GET' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canIntake(user.role)) return forbiddenResponse(c);
        const id = parseInt(c.req.param('id'), 10);
        if (!Number.isFinite(id)) return c.json({ error: 'Invalid id' }, 400);
        const intake = await getIntakeById(id);
        if (!intake) return c.json({ error: 'Not found' }, 404);
        const findings = await listManualFindings(id);
        return c.json({ success: true, intake, findings });
      } catch (err: any) {
        console.error('[ManualIntake] detail error', err);
        return c.json({ error: 'Failed to fetch intake', details: err.message }, 500);
      }
    },
  },

  /* ---------------- GET /api/manual-audit-intake/:id/file --------------- */
  {
    path: '/api/manual-audit-intake/:id/file',
    method: 'GET' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canIntake(user.role)) return forbiddenResponse(c);
        const id = parseInt(c.req.param('id'), 10);
        const intake = await getIntakeById(id);
        if (!intake || !intake.file_path) return c.json({ error: 'File not found' }, 404);
        const buffer = await fs.readFile(intake.file_path);
        // Range-aware response so the streaming-download helper can resume
        // an interrupted intake-file download.
        const { bufferResponseWithRange } = await import('../../utils/excelExport');
        const reqHeaders = {
          range: c.req.header('Range'),
          'if-range': c.req.header('If-Range'),
        };
        return bufferResponseWithRange(
          buffer,
          intake.file_mime || 'application/octet-stream',
          intake.file_name,
          reqHeaders,
          { extraHeaders: { 'Content-Disposition': `inline; filename="${intake.file_name}"` } },
        );
      } catch (err: any) {
        console.error('[ManualIntake] file download error', err);
        return c.json({ error: 'Failed to load file', details: err.message }, 500);
      }
    },
  },

  /* ---------------- POST /api/manual-audit-intake/:id/extract ----------- *
   * Kicks off GPT-4o extraction.
   * Body: { text?: string }
   *   - If provided, uses supplied text directly (useful for PDF/DOCX that
   *     the client already extracted).
   *   - Otherwise, attempts to read the stored file as text. Fails for
   *     binary formats until pdf-parse/mammoth are added.
   * --------------------------------------------------------------------- */
  {
    path: '/api/manual-audit-intake/:id/extract',
    method: 'POST' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canIntake(user.role)) return forbiddenResponse(c);
        const id = parseInt(c.req.param('id'), 10);
        const intake = await getIntakeById(id);
        if (!intake) return c.json({ error: 'Not found' }, 404);

        if (intake.status === 'extracting') {
          return c.json({ error: 'Extraction already in progress' }, 409);
        }

        const body = await c.req.json().catch(() => ({}));
        let text: string | null = typeof body?.text === 'string' && body.text.length > 0 ? body.text : null;
        if (!text && intake.file_path) {
          text = await readIntakeFileAsText(intake.file_path);
        }
        if (!text) {
          return c.json({
            error: 'No text to extract. Provide `text` in the body or upload a .txt/.md file. ' +
                   'PDF/DOCX native extraction will be enabled when pdf-parse/mammoth are installed.',
          }, 400);
        }

        await updateIntakeStatus(id, 'extracting', {
          extraction_model: 'openai/gpt-4o',
          extraction_started_at: new Date(),
          extraction_error: null,
        });

        try {
          const findings = await extractFindingsFromText(text);
          await insertManualFindings(id, findings);
          await updateIntakeStatus(id, 'ready_review', {
            extraction_completed_at: new Date(),
            findings_extracted: findings.length,
          });

          await logEvent({
            userId: user.userId, userEmail: user.email, userRole: user.role,
            actionType: 'AI_ACTION', entityType: 'manual_audit_intake',
            entityId: String(id), entityName: intake.intake_code,
            description: `GPT-4o extracted ${findings.length} findings from ${intake.intake_code}`,
            module: 'audits', severity: 'INFO',
            aiInvolved: true, correlationId: intake.intake_code,
          }).catch(() => { /* non-fatal */ });

          return c.json({ success: true, findings_extracted: findings.length });
        } catch (extractErr: any) {
          await updateIntakeStatus(id, 'failed', {
            extraction_completed_at: new Date(),
            extraction_error: extractErr?.message || String(extractErr),
          });
          return c.json({
            error: 'Extraction failed',
            details: extractErr?.message,
          }, 500);
        }
      } catch (err: any) {
        console.error('[ManualIntake] extract error', err);
        return c.json({ error: 'Failed to extract', details: err.message }, 500);
      }
    },
  },

  /* ---------------- POST /api/manual-audit-intake/findings/:id/review --- *
   * Body: {
   *   action: 'accept' | 'reject' | 'edit',
   *   patch?: { title?, description?, severity?, category?, responsible_party?, due_date? },
   *   reject_reason?: string
   * }
   * ----------------------------------------------------------------- */
  {
    path: '/api/manual-audit-intake/findings/:id/review',
    method: 'POST' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canIntake(user.role)) return forbiddenResponse(c);

        const findingId = parseInt(c.req.param('id'), 10);
        const body = await c.req.json().catch(() => ({}));
        const action = String(body?.action || '');
        if (!['accept', 'reject', 'edit'].includes(action)) {
          return c.json({ error: 'action must be accept | reject | edit' }, 400);
        }
        if (action === 'reject' && !body?.reject_reason) {
          return c.json({ error: 'reject_reason is required when rejecting' }, 400);
        }
        const updated = await reviewManualFinding(findingId, {
          action: action as 'accept' | 'reject' | 'edit',
          reviewer_email: user.email || 'unknown',
          patch: body?.patch,
          reject_reason: body?.reject_reason,
        });
        if (!updated) return c.json({ error: 'Finding not found' }, 404);

        await logEvent({
          userId: user.userId, userEmail: user.email, userRole: user.role,
          actionType: 'UPDATE', entityType: 'manual_audit_finding',
          entityId: String(findingId),
          description: `Manual intake finding ${action}${body?.reject_reason ? `: ${body.reject_reason}` : ''}`,
          module: 'audits', severity: action === 'reject' ? 'WARNING' : 'INFO',
        }).catch(() => { /* non-fatal */ });

        return c.json({ success: true, finding: updated });
      } catch (err: any) {
        console.error('[ManualIntake] review error', err);
        return c.json({ error: 'Failed to review finding', details: err.message }, 500);
      }
    },
  },

  /* ---------------- POST /api/manual-audit-intake/:id/finalize ---------- *
   * Promotes all accepted findings to grc_audit_findings under a newly-
   * created `audits` row with source_party='quality_manual'.
   * ------------------------------------------------------------------- */
  {
    path: '/api/manual-audit-intake/:id/finalize',
    method: 'POST' as const,
    createHandler: async () => async (c: any) => {
      try {
        await ensure();
        const user = getSessionUser(c);
        if (!user) return unauthorizedResponse(c);
        if (!canIntake(user.role)) return forbiddenResponse(c);
        const id = parseInt(c.req.param('id'), 10);
        const intake = await getIntakeById(id);
        if (!intake) return c.json({ error: 'Not found' }, 404);
        if (intake.status === 'accepted') {
          return c.json({ error: 'Intake already finalized' }, 409);
        }
        const findings = await listManualFindings(id);
        const accepted = findings.filter(f => f.status === 'accepted' || f.status === 'edited');
        if (accepted.length === 0) {
          return c.json({
            error: 'No accepted findings to promote. Accept at least one finding first.',
          }, 400);
        }

        // Create the shadow audit row in canonical audits table.
        const auditCode = `AUD-MAN-${intake.intake_code.replace(/^WP-MANI-/, '')}`;
        const audit = await createAudit({
          audit_code: auditCode,
          title: `Manual Audit: ${intake.title}`,
          description: `Imported via Manual Audit Intake ${intake.intake_code}. ` +
                       `Source party: ${intake.audit_source_party}. ` +
                       `Uploaded by ${intake.uploaded_by_email}.`,
          audit_type: 'internal',
          scope: intake.department || null,
          audit_standard: null,
          lead_auditor: intake.auditor_name || intake.uploaded_by_email,
          audit_team: null,
          auditee_department: intake.department || null,
          auditee_contact: null,
          planned_start_date: intake.audit_date || null,
          planned_end_date: intake.audit_date || null,
          status: 'completed',
          linked_regulation_ids: null,
          linked_control_ids: null,
          created_by: user.email,
        } as any);

        // Promote each accepted finding.
        let promoted = 0;
        for (const f of accepted) {
          const findingCode = `${auditCode}-F${String(promoted + 1).padStart(3, '0')}`;
          const severityMap: Record<string, string> = {
            critical: 'critical', major: 'high',
            minor: 'medium', observation: 'low', unknown: 'low',
          };
          try {
            const created = await createFinding({
              audit_id: audit.id,
              finding_code: findingCode,
              title: f.title,
              description: f.description,
              category: f.category || 'Internal Audit',
              severity: severityMap[f.severity] || 'medium',
              control_reference: null,
              evidence_description: f.source_excerpt || null,
              root_cause: null,
              affected_process: intake.department || null,
              responsible_party: f.responsible_party || null,
              due_date: f.due_date || null,
              status: 'open',
              corrective_action: null,
              corrective_action_owner: null,
              linked_capa_id: null,
              linked_risk_id: null,
            } as any);
            await markFindingPromoted(f.id, created.id);
            promoted++;
          } catch (err: any) {
            console.error('[ManualIntake] failed to promote finding', f.id, err);
          }
        }

        await updateIntakeStatus(id, 'accepted', {
          findings_accepted: promoted,
          findings_rejected: findings.filter(f => f.status === 'rejected').length,
          linked_audit_id: audit.id,
        });

        await logEvent({
          userId: user.userId, userEmail: user.email, userRole: user.role,
          actionType: 'UPDATE', entityType: 'manual_audit_intake',
          entityId: String(id), entityName: intake.intake_code,
          description: `Finalized intake ${intake.intake_code} → audit ${auditCode} with ${promoted} promoted findings`,
          module: 'audits', severity: 'INFO',
        }).catch(() => { /* non-fatal */ });

        return c.json({ success: true, audit_id: audit.id, audit_code: auditCode, promoted });
      } catch (err: any) {
        console.error('[ManualIntake] finalize error', err);
        return c.json({ error: 'Failed to finalize', details: err.message }, 500);
      }
    },
  },
];
