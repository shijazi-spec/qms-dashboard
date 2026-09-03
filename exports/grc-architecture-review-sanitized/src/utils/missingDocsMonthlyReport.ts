/**
 * Monthly missing-documents report.
 *
 * Sample User this on 2026-08-25 alongside the quarter filter: "an option
 * to push them too as reports to be send on a monthly basis regarding the
 * missing documents". The on-demand Excel shipped; the monthly send did not,
 * and was missed until 2026-09-02.
 *
 * Three rules this file exists to enforce, all learned on this platform:
 *
 *   RECIPIENTS ARE SERVER-SIDE ONLY. Never from a request body, never from a
 *   query string. The address list comes from env, falling back to the shared
 *   quality-report list. A report naming individual sales reps must not be
 *   addressable by whoever can reach the endpoint.
 *
 *   IT IS OFF UNTIL SOMEONE TURNS IT ON. MISSING_DOCS_REPORT_ENABLED must be
 *   "true". Shipping a job that emails the Head of Sales the moment it deploys
 *   is not a feature, it is an incident.
 *
 *   THE NUMBERS CARRY THEIR OWN COVERAGE. Percentages are of deals actually
 *   CHECKED by the background sweep; the email says how much of the pipeline
 *   that was. A compliance figure quoted without its denominator invites the
 *   reply "that can't be right", and it would be fair.
 *
 * The email is a SUMMARY plus a link. It deliberately does not attach the
 * workbook: the per-deal detail names individual owners, and mail forwards in
 * ways a dashboard link does not.
 */
import type { DealComplianceReportRow } from "./duplicateRadarDatabase";
import { ownerBreakdown, stageSummary, pct } from "./dealComplianceReportExport";
import { QUALITY_REPORT_RECIPIENTS } from "./EmailProviderMail";

/** Owners worse than this are named individually in the email body. */
const NAMED_OWNER_LIMIT = 8;

export function isMonthlyMissingDocsEnabled(): boolean {
  return String(process.env.MISSING_DOCS_REPORT_ENABLED || "").toLowerCase() === "true";
}

/**
 * Who receives it. SERVER-SIDE ONLY — see the note at the top of this file.
 * Invalid entries are dropped rather than sent to, and a fully invalid list
 * yields an empty array so the caller can refuse to send.
 */
export function monthlyMissingDocsRecipients(): string[] {
  const raw = process.env.MISSING_DOCS_REPORT_RECIPIENTS;
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : [...QUALITY_REPORT_RECIPIENTS];
  return list.filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
}

/** "2026-08" — the period the report covers, used as the send-once key. */
export function periodKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function periodLabel(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string,
  );

const money = (n: number) => Math.round(n || 0).toLocaleString("en-US");

export interface MonthlyMissingDocsEmail {
  subject: string;
  html: string;
  text: string;
}

export function buildMonthlyMissingDocsEmail(
  rows: DealComplianceReportRow[],
  opts: { periodLabel: string; inScope: number; dashboardUrl?: string },
): MonthlyMissingDocsEmail {
  const missing = rows.filter((r) => !r.compliant);
  const overallPct = pct(missing.length, rows.length);
  const atRisk = missing.reduce((n, r) => n + (r.amount || 0), 0);
  const stages = stageSummary(rows);
  const owners = ownerBreakdown(rows).filter((o) => o.missing > 0);
  const named = owners.slice(0, NAMED_OWNER_LIMIT);
  const rest = owners.length - named.length;

  const subject =
    rows.length === 0
      ? `Deal documents — ${opts.periodLabel}: no deals checked yet`
      : `Deal documents — ${opts.periodLabel}: ${missing.length} deals missing documents (${overallPct}%)`;

  const coverage =
    opts.inScope > rows.length
      ? `${rows.length} of ${opts.inScope} in-scope deals had been checked when this was produced.`
      : `All ${rows.length} in-scope deals had been checked when this was produced.`;

  if (rows.length === 0) {
    // Say nothing rather than report 0% — see the note at the top of the file.
    const t =
      `No deals had been checked for ${opts.periodLabel}, so there is no compliance figure to report. ` +
      `The automatic attachment check may not have run.`;
    return { subject, html: `<p>${esc(t)}</p>`, text: t };
  }

  const stageRows = stages
    .map(
      (s) =>
        `<tr><td>${esc(s.stage)}</td><td align="right">${s.checked}</td>` +
        `<td align="right">${s.missing}</td>` +
        `<td align="right">${s.missing_pct == null ? "—" : s.missing_pct + "%"}</td>` +
        `<td align="right">${money(s.missing_value)}</td></tr>`,
    )
    .join("");

  const ownerRows = named
    .map(
      (o) =>
        `<tr><td>${esc(o.owner)}</td><td align="right">${o.missing}</td>` +
        `<td align="right">${o.checked}</td>` +
        `<td align="right">${o.missing_pct == null ? "—" : o.missing_pct + "%"}</td>` +
        `<td align="right">${money(o.missing_value)}</td></tr>`,
    )
    .join("");

  const link = opts.dashboardUrl
    ? `<p><a href="${esc(opts.dashboardUrl)}">Open Deal Compliance</a> for the per-deal detail, ` +
      `or use “Report for Head of Sales” there to download the full workbook.</p>`
    : "";

  const html =
    `<div style="font:14px/1.5 -IdentityProvider-system,Segoe UI,Roboto,Arial,sans-serif;color:#111">` +
    `<h2 style="margin:0 0 4px">Deal document compliance — ${esc(opts.periodLabel)}</h2>` +
    `<p style="color:#666;font-size:12px;margin:0 0 14px">${esc(coverage)}</p>` +
    `<p><strong>${missing.length}</strong> of <strong>${rows.length}</strong> checked deals are missing ` +
    `required documents (<strong>${overallPct}%</strong>), covering <strong>SAR ${money(atRisk)}</strong>.</p>` +
    `<h3 style="font-size:14px;margin:18px 0 6px">By stage</h3>` +
    `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#e4e4e4;font-size:12px">` +
    `<tr style="background:#f6f6f6"><th align="left">Stage</th><th>Checked</th><th>Missing</th><th>%</th><th>SAR</th></tr>` +
    stageRows +
    `</table>` +
    `<h3 style="font-size:14px;margin:18px 0 6px">By owner</h3>` +
    `<table cellpadding="6" cellspacing="0" border="1" style="border-collapse:collapse;border-color:#e4e4e4;font-size:12px">` +
    `<tr style="background:#f6f6f6"><th align="left">Owner</th><th>Missing</th><th>Checked</th><th>%</th><th>SAR</th></tr>` +
    ownerRows +
    `</table>` +
    (rest > 0
      ? `<p style="color:#666;font-size:12px">…and ${rest} more owner(s) with at least one incomplete deal.</p>`
      : "") +
    link +
    `<p style="color:#666;font-size:11px;margin-top:18px">` +
    `Percentages are of deals that have been checked, not of all deals. Owners are ranked by the ` +
    `number of incomplete deals, not by rate, and a rate is not shown for owners with very few ` +
    `checked deals. This checks the files attached in CRMProvider; nothing has been changed in the CRM.` +
    `</p></div>`;

  const text = [
    `Deal document compliance — ${opts.periodLabel}`,
    coverage,
    "",
    `${missing.length} of ${rows.length} checked deals are missing required documents (${overallPct}%), covering SAR ${money(atRisk)}.`,
    "",
    "By stage:",
    ...stages.map(
      (s) =>
        `  ${s.stage}: ${s.missing}/${s.checked} missing` +
        (s.missing_pct == null ? "" : ` (${s.missing_pct}%)`) +
        ` — SAR ${money(s.missing_value)}`,
    ),
    "",
    "By owner:",
    ...named.map(
      (o) =>
        `  ${o.owner}: ${o.missing} missing of ${o.checked} checked` +
        (o.missing_pct == null ? "" : ` (${o.missing_pct}%)`) +
        ` — SAR ${money(o.missing_value)}`,
    ),
    ...(rest > 0 ? [`  …and ${rest} more owner(s).`] : []),
    "",
    "Percentages are of deals that have been checked, not of all deals.",
    "Nothing has been changed in the CRM.",
  ].join("\n");

  return { subject, html, text };
}
