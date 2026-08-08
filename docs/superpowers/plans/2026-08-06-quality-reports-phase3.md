# Quality Reports — Phase 3 (Email to Head) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authorized user manually email a BU's Quality Report to that BU's head (or a test to themselves), preview-first, reusing the existing Resend helper.

**Architecture:** A pure email-HTML renderer + a `buildBUReportEmail` composer over Phase-1 `getBUReport`; a pure `resolveEmailRecipient` guard (so test-to-self can NEVER be pointed at a client-supplied address); a preview GET + a send POST route; and a preview-modal UI. No schema changes.

**Tech Stack:** TypeScript, Hono routes, Resend (`sendResendEmail`), vanilla-JS dashboard, Vitest (type-checked locally; run in CI).

## Global Constraints

- Builds on Phase 1+2 (shipped `f45f14c5`). Files: `src/utils/qualityReportsEmail.ts` (new), `src/utils/qualityReportsAggregator.ts` (getBUReport, existing), `src/mastra/routes/qualityReportsRoutes.ts`, `src/utils/rbacMiddleware.ts`, `dashboard/quality-reports.html`, `dashboard/js/quality-reports.js`.
- **Email HTML uses INLINE styles** — email clients strip `<style>`/classes. This is EMAIL content, NOT the CSP-bound dashboard page; the dashboard's "no inline style" rule does NOT apply to the email body string. (Dashboard markup — the modal/button — stays class-only, CSP-safe.)
- **Test-to-self recipient = the authenticated session user's own email (`user.email` from `requireRole`), resolved server-side.** NEVER read the recipient from the request body. "Send to head" uses the BU's `head_email`.
- Send route is WRITE_ROLES-gated (admin, grc_manager, head_of_operations_quality, quality_manager); preview is READ_ROLES.
- Reuse `sendResendEmail` from `src/utils/resendMail.ts` (`{ to, subject, html }` → `{ success, id?, error? }`); it already returns a user-safe error when Resend isn't configured — surface it.
- Every send is audit-logged via `logger.info("[QualityReports] email ...", {...})`.
- No scheduling, no bulk "email all" (out of scope).
- Dynamic values in the email are HTML-escaped.
- **vitest CANNOT run locally** (no `vite`). WRITE the vitest files (CI + `tsc -p tsconfig.tests.json`); verify pure logic via tsc-CJS-emit + node. Verify: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`; `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`; `node scripts/check-dashboard-html-js.mjs`; `node --check <file.js>`. Global `tsc` is a wrong stub.
- **Commit ONLY your task's files** with explicit `git add <paths>` — NEVER `git add -A` (a parallel agent has unrelated uncommitted/untracked work). Do NOT push (controller pushes after final review).
- UI task bumps `dashboard/quality-reports.html`: `js/quality-reports.js?v=3` → `?v=4`.

---

### Task 1: Email builder — `renderBUReportEmailHtml` (pure) + `buildBUReportEmail`

**Files:**
- Create: `src/utils/qualityReportsEmail.ts`
- Test: `tests/vitest/qualityReportsEmail.vitest.test.ts`

**Interfaces:**
- Consumes: `getBUReport` + `BUReport` type from `./qualityReportsAggregator` (Phase 1: `{ bu, sections:{sops,kpis,cleanup,compliance,actions}, notConfigured:string[] }`; `bu` has `bu_name`, `channel`, `segment`, `head_email`).
- Produces:
  - `function escHtml(s: unknown): string` (local email-safe escaper)
  - `function renderBUReportEmailHtml(report: any, dateISO: string): { subject: string; html: string }` (PURE — no DB)
  - `async function buildBUReportEmail(buKey: string, dateISO: string): Promise<{ subject: string; html: string; headEmail: string | null; buName: string } | null>`

- [ ] **Step 1: Write the failing test (pure renderer)**

```ts
import { describe, it, expect } from "vitest";
import { renderBUReportEmailHtml } from "../../src/utils/qualityReportsEmail";

const baseReport = {
  bu: { bu_name: "Sales (B2B)", channel: "B2B", segment: "walaplus", head_email: "head@walaplus.com" },
  sections: {
    sops: { policies: [{}, {}], total: 2 },
    kpis: { done: 3, total: 5, pct: 60 },
    cleanup: { deals: { modules: { Deals: { verified_merges: 4 }, Accounts: { verified_merges: 1 } } } },
    compliance: { stageAging: { summary: { total_violations: 7 } }, dealCompliance: { checked: 0, compliant: 0, compliant_rate: null } },
    actions: { openCapas: 2 },
  },
  notConfigured: [],
};

describe("renderBUReportEmailHtml", () => {
  it("builds a dated subject with the BU name", () => {
    const out = renderBUReportEmailHtml(baseReport, "2026-08-06");
    expect(out.subject).toBe("Quality Report — Sales (B2B) — 2026-08-06");
    expect(out.html).toContain("Sales (B2B)");
    expect(out.html).toContain("60%");
  });
  it("shows 'no deals checked yet' when deal-docs checked=0, never 0%", () => {
    const out = renderBUReportEmailHtml(baseReport, "2026-08-06");
    expect(out.html).toContain("no deals checked yet");
  });
  it("renders 'Not configured yet' for sections in notConfigured", () => {
    const r = { ...baseReport, sections: { ...baseReport.sections, sops: null }, notConfigured: ["sops"] };
    const out = renderBUReportEmailHtml(r, "2026-08-06");
    expect(out.html).toContain("Not configured yet");
  });
  it("escapes dynamic text", () => {
    const r = { ...baseReport, bu: { ...baseReport.bu, bu_name: "A<b>&C" } };
    const out = renderBUReportEmailHtml(r, "2026-08-06");
    expect(out.html).toContain("A&lt;b&gt;&amp;C");
    expect(out.html).not.toContain("A<b>&C");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
Expected: module/function not found.

- [ ] **Step 3: Implement**

```ts
import { logger } from "./logger";

export function escHtml(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const CELL = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:14px;color:#111;"';
const LABEL = 'style="padding:6px 10px;border-bottom:1px solid #eee;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.03em;"';

function row(label: string, valueHtml: string): string {
  return `<tr><td ${LABEL}>${escHtml(label)}</td><td ${CELL}>${valueHtml}</td></tr>`;
}

/** PURE — renders the email HTML + subject from a BUReport-shaped object. Email
 *  clients strip <style>/classes, so inline styles are REQUIRED here (this is
 *  email content, not the CSP-bound dashboard). */
export function renderBUReportEmailHtml(report: any, dateISO: string): { subject: string; html: string } {
  const bu = report?.bu || {};
  const s = report?.sections || {};
  const nc: string[] = report?.notConfigured || [];
  const cfg = (name: string) => nc.indexOf(name) === -1;
  const NOT_CFG = '<span style="color:#999;">Not configured yet</span>';

  const sops = cfg("sops") && s.sops ? `${escHtml((s.sops.policies || []).length || s.sops.total || 0)} controlled documents` : NOT_CFG;
  const kpis = cfg("kpis") && s.kpis ? `${escHtml(s.kpis.pct ?? 0)}% (${escHtml(s.kpis.done ?? 0)}/${escHtml(s.kpis.total ?? 0)})` : NOT_CFG;

  let cleanup = NOT_CFG;
  if (cfg("cleanup") && s.cleanup) {
    const parts: string[] = [];
    if (s.cleanup.deals && s.cleanup.deals.modules) {
      const d = s.cleanup.deals.modules;
      parts.push(`Deals merged: ${escHtml(d.Deals && d.Deals.verified_merges || 0)} · Accounts: ${escHtml(d.Accounts && d.Accounts.verified_merges || 0)}`);
    }
    if (s.cleanup.leads) parts.push(`Outstanding leads: ${escHtml(s.cleanup.leads.outstanding_leads || 0)}`);
    cleanup = parts.join("<br>") || "&mdash;";
  }

  let compliance = NOT_CFG;
  if (cfg("compliance") && s.compliance) {
    const parts: string[] = [];
    if (s.compliance.cs && s.compliance.cs.summary) parts.push(`CS Lifecycle violations: ${escHtml(s.compliance.cs.summary.total_violations || 0)}`);
    if (s.compliance.stageAging && s.compliance.stageAging.summary) parts.push(`Deal stage-aging violations: ${escHtml(s.compliance.stageAging.summary.total_violations || 0)}`);
    if (s.compliance.dealCompliance) {
      const dc = s.compliance.dealCompliance;
      parts.push(dc.checked > 0
        ? `Deal docs: ${escHtml(dc.compliant || 0)}/${escHtml(dc.checked)} compliant (${dc.compliant_rate == null ? "&mdash;" : escHtml(dc.compliant_rate) + "%"})`
        : `Deal docs: no deals checked yet`);
    }
    compliance = parts.join("<br>") || "&mdash;";
  }

  const actions = cfg("actions") && s.actions ? `${escHtml(s.actions.openCapas || 0)} open CAPAs` : NOT_CFG;

  const subject = `Quality Report — ${bu.bu_name || "BU"} — ${dateISO}`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#111;">` +
      `<h2 style="font-size:18px;margin:0 0 4px;">Quality Report — ${escHtml(bu.bu_name)}</h2>` +
      `<div style="font-size:12px;color:#666;margin-bottom:14px;">${escHtml(bu.channel)} · segment ${escHtml(bu.segment)} · ${escHtml(dateISO)}</div>` +
      `<table style="border-collapse:collapse;width:100%;border:1px solid #eee;">` +
        row("SOPs", sops) + row("KPIs", kpis) + row("Data cleanup", cleanup) +
        row("Compliance", compliance) + row("Open actions", actions) +
      `</table>` +
      `<div style="font-size:11px;color:#999;margin-top:14px;">Generated by WalaPlus QMS — Quality Reports.</div>` +
    `</div>`;
  return { subject, html };
}

/** Compose the email for a BU from live data. Returns null when the BU doesn't exist. */
export async function buildBUReportEmail(
  buKey: string, dateISO: string,
): Promise<{ subject: string; html: string; headEmail: string | null; buName: string } | null> {
  const { getBUReport } = await import("./qualityReportsAggregator");
  const report = await getBUReport(buKey);
  if (!report) return null;
  const { subject, html } = renderBUReportEmailHtml(report, dateISO);
  return { subject, html, headEmail: report.bu.head_email ?? null, buName: report.bu.bu_name };
}
```

- [ ] **Step 4: Verify + run the pure test via CJS-emit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run:
```bash
node node_modules/typescript/bin/tsc src/utils/qualityReportsEmail.ts --outDir _qe --module commonjs --moduleResolution node --target es2022 --skipLibCheck --esModuleInterop --rootDir src/utils >/dev/null 2>&1; echo '{"type":"commonjs"}' > _qe/package.json; node -e 'const m=require("./_qe/qualityReportsEmail.js"); const r={bu:{bu_name:"Sales (B2B)",channel:"B2B",segment:"walaplus",head_email:"h@x.com"},sections:{sops:{policies:[{},{}],total:2},kpis:{pct:60,done:3,total:5},cleanup:null,compliance:{dealCompliance:{checked:0,compliant:0,compliant_rate:null}},actions:{openCapas:2}},notConfigured:["cleanup"]}; const o=m.renderBUReportEmailHtml(r,"2026-08-06"); console.log(o.subject==="Quality Report — Sales (B2B) — 2026-08-06" && o.html.includes("no deals checked yet") && o.html.includes("Not configured yet") ? "PASS":"FAIL")'; rm -rf _qe
```
Expected: `PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/utils/qualityReportsEmail.ts tests/vitest/qualityReportsEmail.vitest.test.ts
git commit -m "feat(quality-reports): BU report email builder (pure renderer + composer)"
```

---

### Task 2: `resolveEmailRecipient` guard + preview/send routes + RBAC

**Files:**
- Modify: `src/utils/qualityReportsEmail.ts` (add the pure guard)
- Modify: `src/mastra/routes/qualityReportsRoutes.ts` (two routes)
- Modify: `src/utils/rbacMiddleware.ts` (two allowlist entries)
- Test: `tests/vitest/qualityReportsEmailRecipient.vitest.test.ts`

**Interfaces:**
- Consumes: `buildBUReportEmail` (Task 1); `sendResendEmail` (`src/utils/resendMail.ts`); `requireRole` + the route's `READ_ROLES`/`WRITE_ROLES` (existing in the routes file).
- Produces: `function resolveEmailRecipient(mode: string, headEmail: string | null, sessionEmail: string | null): { to: string } | { error: string; status: 400 }`.

- [ ] **Step 1: Write the failing test (pure recipient guard)**

```ts
import { describe, it, expect } from "vitest";
import { resolveEmailRecipient } from "../../src/utils/qualityReportsEmail";

describe("resolveEmailRecipient", () => {
  it("self mode uses the session email (never a body-supplied address)", () => {
    expect(resolveEmailRecipient("self", "head@x.com", "me@walaplus.com")).toEqual({ to: "me@walaplus.com" });
  });
  it("self mode 400s when session email is missing", () => {
    expect(resolveEmailRecipient("self", "head@x.com", null)).toEqual({ error: "Could not resolve your email.", status: 400 });
  });
  it("head mode uses the BU head email", () => {
    expect(resolveEmailRecipient("head", "head@x.com", "me@walaplus.com")).toEqual({ to: "head@x.com" });
  });
  it("head mode 400s when no head email is mapped", () => {
    expect(resolveEmailRecipient("head", null, "me@walaplus.com")).toEqual({ error: "This BU has no head email mapped.", status: 400 });
  });
  it("rejects unknown modes", () => {
    expect(resolveEmailRecipient("x", "head@x.com", "me@walaplus.com")).toEqual({ error: "Invalid mode.", status: 400 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → function not found.

- [ ] **Step 3: Implement the guard** (append to `src/utils/qualityReportsEmail.ts`)

```ts
/** Decide the recipient for a send. `mode:'self'` ALWAYS uses the caller's
 *  session email — never a client-supplied address (no open-relay). */
export function resolveEmailRecipient(
  mode: string, headEmail: string | null, sessionEmail: string | null,
): { to: string } | { error: string; status: 400 } {
  if (mode === "self") {
    return sessionEmail ? { to: sessionEmail } : { error: "Could not resolve your email.", status: 400 };
  }
  if (mode === "head") {
    return headEmail ? { to: headEmail } : { error: "This BU has no head email mapped.", status: 400 };
  }
  return { error: "Invalid mode.", status: 400 };
}
```

- [ ] **Step 4: Add the two routes** to `qualityReportsRoutes.ts` (after the `/summary` route; mirror the file's existing gate/error patterns; import `buildBUReportEmail`+`resolveEmailRecipient` from `../../utils/qualityReportsEmail` and `sendResendEmail` from `../../utils/resendMail`)

```ts
  {
    path: "/api/quality-reports/bus/:buKey/email-preview",
    method: "GET" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, READ_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const { buildBUReportEmail } = await import("../../utils/qualityReportsEmail");
          const dateISO = new Date().toISOString().slice(0, 10);
          const built = await buildBUReportEmail(c.req.param("buKey"), dateISO);
          if (!built) return c.json({ error: "Not found" }, 404);
          return c.json({ success: true, subject: built.subject, html: built.html, headEmail: built.headEmail, buName: built.buName });
        } catch (error: any) {
          logger.error("[QualityReports] email preview:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
  {
    path: "/api/quality-reports/bus/:buKey/email",
    method: "POST" as const,
    createHandler: async () => {
      return async (c: any) => {
        try {
          const user = await requireRole(c, WRITE_ROLES);
          if (!user) return c.json({ error: "Insufficient permissions" }, 403);
          const body = await c.req.json().catch(() => ({}));
          const mode = String(body?.mode || "");
          const { buildBUReportEmail, resolveEmailRecipient } = await import("../../utils/qualityReportsEmail");
          const { sendResendEmail } = await import("../../utils/resendMail");
          const dateISO = new Date().toISOString().slice(0, 10);
          const built = await buildBUReportEmail(c.req.param("buKey"), dateISO);
          if (!built) return c.json({ error: "Not found" }, 404);
          // Recipient is decided server-side ONLY — never from the request body.
          const recip = resolveEmailRecipient(mode, built.headEmail, user.email || null);
          if ("error" in recip) return c.json({ error: recip.error }, recip.status);
          const res = await sendResendEmail({ to: recip.to, subject: built.subject, html: built.html });
          logger.info("[QualityReports] email send", { actor: user.email, buKey: c.req.param("buKey"), to: recip.to, mode, ok: res.success, resendId: res.id, error: res.error });
          if (!res.success) return c.json({ success: false, error: res.error || "Email failed to send." }, 502);
          return c.json({ success: true, id: res.id, to: recip.to });
        } catch (error: any) {
          logger.error("[QualityReports] email send:", error);
          return c.json({ error: "An internal error occurred" }, 500);
        }
      };
    },
  },
```

- [ ] **Step 5: Add RBAC entries** (in `rbacMiddleware.ts`, next to the other `/quality-reports` rules)

```ts
  {
    pattern: /^\/api\/quality-reports\/bus\/[^/]+\/email-preview$/,
    methods: ["GET"],
    roles: ["admin","ai_specialist","auditor","bu_owner","custom","department_viewer","executive","grc_manager","head_of_operations_quality","quality_manager","quality_specialist","team_lead","viewer"],
  },
  {
    pattern: /^\/api\/quality-reports\/bus\/[^/]+\/email$/,
    methods: ["POST"],
    roles: ["admin","grc_manager","head_of_operations_quality","quality_manager"],
  },
```

- [ ] **Step 6: Verify + run the pure guard test via CJS-emit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` → exit 0.
Run: `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` → exit 0.
Run:
```bash
node node_modules/typescript/bin/tsc src/utils/qualityReportsEmail.ts --outDir _qe --module commonjs --moduleResolution node --target es2022 --skipLibCheck --esModuleInterop --rootDir src/utils >/dev/null 2>&1; echo '{"type":"commonjs"}' > _qe/package.json; node -e 'const m=require("./_qe/qualityReportsEmail.js"); const a=m.resolveEmailRecipient("self","h@x.com","me@w.com"); const b=m.resolveEmailRecipient("head",null,"me@w.com"); console.log(a.to==="me@w.com" && b.error && b.status===400 ? "PASS":"FAIL")'; rm -rf _qe
```
Expected: `PASS`.

- [ ] **Step 7: Commit**

```bash
git add src/utils/qualityReportsEmail.ts src/mastra/routes/qualityReportsRoutes.ts src/utils/rbacMiddleware.ts tests/vitest/qualityReportsEmailRecipient.vitest.test.ts
git commit -m "feat(quality-reports): email preview + send routes (server-side recipient guard) + RBAC"
```

---

### Task 3: UI — "Email to head" button + preview modal

**Files:**
- Modify: `dashboard/js/quality-reports.js`
- Modify: `dashboard/quality-reports.html` (`?v=3`→`?v=4`)

**Interfaces:**
- Consumes: `GET /api/quality-reports/bus/:buKey/email-preview`, `POST /api/quality-reports/bus/:buKey/email` (`{mode:"head"|"self"}`). The BU page already has `d.bu.head_email` from `GET /bus/:buKey` (rendered in `qrRenderBU`).

- [ ] **Step 1: Add the "Email to head" button to the BU page.** In `qrRenderBU` (near the "← All units" back button / BU header), add:
```js
  var hasHead = bu.head_email && String(bu.head_email).trim();
  parts.push('<button type="button" class="rr-btn rr-btn-ghost mb-3" ' + (hasHead ? '' : 'disabled title="Map a head email in settings first" ') + 'data-on-click="qrEmailBU" data-args="' + escAttr(JSON.stringify([bu.bu_key])) + '">✉ Email to head</button>');
```
(Place alongside the existing back button; keep the class-only, CSP-safe markup.)

- [ ] **Step 2: Implement `qrEmailBU` (open preview) + send handlers.** Add to `quality-reports.js`:
```js
window.qrEmailBU = async function(buKey) {
  var host = document.getElementById('qrEmailModal');
  if (!host) { host = document.createElement('div'); host.id = 'qrEmailModal'; document.body.appendChild(host); }
  host.innerHTML = '<div class="rr-modal-backdrop"><div class="rr-modal"><div class="text-sm text-gray-500">Loading preview…</div></div></div>';
  try {
    var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey) + '/email-preview', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var d = await res.json();
    // Render the email HTML inside a sandboxed iframe (isolates its inline styles).
    var iframe = '<iframe sandbox="" style="width:100%;height:340px;border:1px solid #ddd;background:#fff" srcdoc="' + escAttr(d.html) + '"></iframe>';
    host.innerHTML =
      '<div class="rr-modal-backdrop"><div class="rr-modal">' +
        '<div class="font-semibold mb-1">' + escapeHtml(d.subject || 'Quality Report') + '</div>' +
        '<div class="text-xs text-gray-500 mb-2">To: ' + escapeHtml(d.headEmail || '(no head email mapped)') + '</div>' +
        iframe +
        '<div class="flex gap-2 mt-3">' +
          (d.headEmail ? '<button type="button" class="rr-btn rr-btn-primary" data-on-click="qrEmailSend" data-args="' + escAttr(JSON.stringify([buKey, 'head'])) + '">Send to ' + escapeHtml(d.headEmail) + '</button>' : '') +
          '<button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrEmailSend" data-args="' + escAttr(JSON.stringify([buKey, 'self'])) + '">Send test to me</button>' +
          '<button type="button" class="rr-btn rr-btn-ghost" data-on-click="qrEmailClose">Cancel</button>' +
        '</div>' +
      '</div></div>';
  } catch (e) {
    host.innerHTML = '<div class="rr-modal-backdrop"><div class="rr-modal"><div class="text-sm text-red-600">Preview failed: ' + escapeHtml(String(e.message || e)) + '</div><button type="button" class="rr-btn rr-btn-ghost mt-2" data-on-click="qrEmailClose">Close</button></div></div>';
  }
};
window.qrEmailClose = function() { var h = document.getElementById('qrEmailModal'); if (h) h.innerHTML = ''; };
window.qrEmailSend = async function(buKey, mode) {
  try {
    var res = await fetch('/api/quality-reports/bus/' + encodeURIComponent(buKey) + '/email', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: mode })
    });
    var d = await res.json().catch(function(){ return {}; });
    if (res.ok && d.success) { if (window.rrToast) rrToast('Sent to ' + (d.to || (mode === 'self' ? 'you' : 'head'))); qrEmailClose(); }
    else { if (window.rrToast) rrToast(d.error || 'Send failed', 'error'); else alert(d.error || 'Send failed'); }
  } catch (e) { if (window.rrToast) rrToast('Send failed', 'error'); }
};
```
(If `rrToast` isn't defined on this page, the code already falls back to `alert` on error and no-ops on success — confirm and keep a graceful fallback. If `.rr-modal`/`.rr-modal-backdrop` classes aren't already styled on this page, add minimal class-based styles to the page `<style>` block — NO inline styles on dashboard markup; the iframe `srcdoc` may contain inline styles since it's an isolated email document.)

- [ ] **Step 3: Bump cache-buster** — `dashboard/quality-reports.html`: `quality-reports.js?v=3` → `?v=4`.

- [ ] **Step 4: Verify**

Run: `node --check dashboard/js/quality-reports.js` → no error (add `&& echo JS-OK`).
Run: `node scripts/check-dashboard-html-js.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add dashboard/js/quality-reports.js dashboard/quality-reports.html
git commit -m "feat(quality-reports): email-to-head preview modal + send/test buttons"
```

---

### Task 4: Ship

- [ ] **Step 1:** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` (exit 0), `node node_modules/typescript/bin/tsc -p tsconfig.tests.json` (exit 0), `node scripts/check-dashboard-html-js.mjs` (PASS), `node --check dashboard/js/quality-reports.js`.
- [ ] **Step 2:** `git pull --rebase --autostash origin QMS` then `git push origin QMS`.
- [ ] **Step 3:** Tell the user: Pull → Republish; open a BU with a mapped head email → "✉ Email to head" → preview → "Send test to me" (arrives in your inbox) → "Send to head". Requires `RESEND_API_KEY` (already set); set `RESEND_FROM_EMAIL` for a verified WalaPlus sender.

## Self-Review notes

- **Spec coverage:** §2 safety (manual, preview, server-rebuild, self=session email, guards, audit) → Task 1 (builder) + Task 2 (`resolveEmailRecipient` server-side + audit log + guards) + Task 3 (preview-first UI). §3 builder → Task 1. §4 endpoints + RBAC → Task 2. §5 UI → Task 3 + `?v=4`. §6 non-goals (no schedule/bulk) honored — no such code. §7 testing → Task 1/2 pure tests (renderer + recipient guard). §8 deploy → Task 4.
- **Placeholder scan:** none. The "confirm rrToast/modal classes exist" notes name the exact symbol to check with a specified fallback, not vague TODOs.
- **Type consistency:** `renderBUReportEmailHtml`/`buildBUReportEmail`/`resolveEmailRecipient` (Tasks 1-2) consumed by the Task-2 routes; the `{subject,html,headEmail,buName}` preview shape (Task 2) matches Task 3's `d.subject/d.html/d.headEmail`. Send body `{mode}` (Task 3) matches the route's `body.mode` (Task 2). `user.email` from `requireRole` confirmed available (rbacMiddleware.ts:137 uses it).
- **Email-vs-dashboard CSP:** the email HTML (Task 1) uses inline styles by design (email requirement); dashboard markup (Task 3) stays class-only; the iframe `srcdoc` isolates the email's inline styles. This distinction is stated in Global Constraints and both tasks.
