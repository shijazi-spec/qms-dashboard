const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, 'sop-call-evaluation.pdf');
const doc = new PDFDocument({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 } });
doc.pipe(fs.createWriteStream(out));

const INDIGO = '#4f46e5', INDIGO_DK = '#4338ca', NAVY = '#1e3a8a', GRAY = '#374151', LIGHT = '#6b7280', BORDER = '#d1d5db', HEAD_BG = '#eef2ff', ROW_ALT = '#f9fafb', TAG_BG = '#ecfdf5', TAG_FG = '#047857';

function h1(t){ doc.moveDown(0.2).font('Helvetica-Bold').fontSize(22).fillColor(INDIGO).text(t); }
function h2(t){ doc.moveDown(0.8).font('Helvetica-Bold').fontSize(14).fillColor(INDIGO_DK).text(t);
  const y = doc.y + 2; doc.moveTo(50, y).lineTo(545, y).lineWidth(1).strokeColor('#e0e7ff').stroke(); doc.moveDown(0.4); }
function h3(t){ doc.moveDown(0.5).font('Helvetica-Bold').fontSize(11.5).fillColor(NAVY).text(t); doc.moveDown(0.2); }
function p(t, opts={}){ doc.font('Helvetica').fontSize(10).fillColor(GRAY).text(t, opts); }
function bullet(items){ doc.font('Helvetica').fontSize(10).fillColor(GRAY).list(items, { bulletRadius: 1.6, textIndent: 10, bulletIndent: 4, lineGap: 2 }); doc.moveDown(0.2); }
function numbered(items){ doc.font('Helvetica').fontSize(10).fillColor(GRAY).list(items, { listType: 'numbered', textIndent: 10, bulletIndent: 4, lineGap: 2 }); doc.moveDown(0.2); }

function table(headers, rows, widths){
  const startX = 50; let y = doc.y + 4;
  const rowH = (cells, cw) => {
    let h = 0;
    cells.forEach((c, i) => {
      const hh = doc.font('Helvetica').fontSize(9.5).heightOfString(c, { width: cw[i] - 12 });
      if (hh > h) h = hh;
    });
    return h + 10;
  };
  // header
  const hh = rowH(headers, widths);
  doc.rect(startX, y, widths.reduce((a,b)=>a+b,0), hh).fill(HEAD_BG).stroke(BORDER);
  let x = startX;
  headers.forEach((c, i) => {
    doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(9.5).text(c, x + 6, y + 5, { width: widths[i] - 12 });
    x += widths[i];
  });
  y += hh;
  rows.forEach((r, idx) => {
    const rh = rowH(r, widths);
    if (y + rh > doc.page.height - 60) { doc.addPage(); y = 50; }
    if (idx % 2 === 1) doc.rect(startX, y, widths.reduce((a,b)=>a+b,0), rh).fill(ROW_ALT);
    let xx = startX;
    r.forEach((c, i) => {
      doc.rect(xx, y, widths[i], rh).lineWidth(0.5).strokeColor(BORDER).stroke();
      doc.fillColor(GRAY).font('Helvetica').fontSize(9.5).text(c, xx + 6, y + 5, { width: widths[i] - 12 });
      xx += widths[i];
    });
    y += rh;
  });
  doc.y = y + 8;
}

// === CONTENT ===
h1('SOP — Call Evaluation Tab');
doc.font('Helvetica').fontSize(9.5).fillColor(LIGHT)
  .text('Platform: WalaPlus Enterprise GRC & Quality   •   Page: qms-dashboard.replit.app/calls', { continued: false })
  .text('Owner: Quality Management   •   Audience: Quality Managers, Team Leads, SDRs, Admins')
  .text('Version: 1.0   •   Effective: 25 May 2026');
doc.moveDown(0.3);
doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();

h2('1. Purpose');
p('Evaluate SDR call performance using the AI-powered COPC v2 scorecard, capture coaching actions, and ensure CRM hygiene and PDPL compliance.');

h2('2. Access & Roles');
table(
  ['Role', 'Capability'],
  [
    ['Admin, Head of Ops & Quality', 'Full access + seed/edit scorecards, bulk delete, approve evaluations'],
    ['Quality Manager, Team Lead, AI Specialist, GRC Manager', 'View calls, run analysis & evaluation, create coaching plans'],
    ['SDR (agent)', 'View own evaluations and coaching plans only'],
  ],
  [200, 295]
);
p('Open the platform → sidebar Quality → Call Evaluation.');

h2('3. Daily Workflow');

h3('Step 1 — Confirm pipeline health');
numbered([
  'At the top of the page, check the Health Metrics strip: pipeline yield ≥ 95%, CRM linkage rate ≥ 90%, failed analyses = 0.',
  'If any value is red, open the Logs tab and escalate to Admin before evaluating.',
]);

h3('Step 2 — Ingest calls');
p('Calls arrive automatically from Zoho CRM and Google Drive. For ad-hoc evaluation:');
numbered([
  'Click Bulk Upload → select MP3/WAV files (≤ 25 MB each).',
  'Or click Ingest from Zoho to pull the latest call logs.',
  'New rows appear with Status = Pending.',
]);

h3('Step 3 — Filter the queue');
bullet([
  'Source: Five9 / Twilio / Mobile / Upload',
  'Agent Email',
  'Status: Pending → Processing → Analyzed → Failed',
  'Lead ID (to evaluate calls for a specific deal)',
]);

h3('Step 4 — Analyze a call');
numbered([
  'Select the row(s).',
  'Click Analyze (single) or Bulk Rescore Selected (multiple).',
  'Status moves Processing → Analyzed (~1–3 min per call).',
]);

h3('Step 5 — Evaluate against the scorecard');
numbered([
  'Click the call row to open the split workspace.',
  'Right pane: review the AI transcript (speaker-segmented), call summary, sentiment, and AI insights.',
  'Left pane: COPC v2 runs automatically. Confirm Overall Score (0–100), People 25% (communication, tone, active listening), Process 35% (objection handling, discovery, script adherence), Governance 40% (CRM hygiene, mandatory disclosures, PDPL/data accuracy).',
  'Read Top Strengths, Top Gaps, Critical Risks, and CRM linkage sections.',
]);

h3('Step 6 — Manager approval');
numbered([
  'Adjust any attribute pass/fail if the AI is wrong (justification required — saved to sdr_evaluation_reviews).',
  'Click Approve Evaluation. The score becomes the official record.',
]);

h3('Step 7 — Coaching plan');
p('A plan opens automatically when an agent fails the same attribute 3+ times in 14 days. To open it manually:');
numbered([
  'Click Create Coaching Plan on any evaluated call.',
  'Fill in: manager observation note, SDR commitment, micro-training topic(s), follow-up date (default +7 days).',
  'Save. Status = pending_delivery. The SDR is notified by email.',
  'On the follow-up date, return and mark the plan delivered / closed.',
]);

h3('Step 8 — Export & reporting');
bullet([
  'CSV/Excel: click Export (top-right) for the filtered list.',
  'Infographic: click Generate Infographic for a shareable PNG/PDF (weekly QA packs).',
]);

h2('4. Scorecard Administration  (Admin / Head of Ops only)');
numbered([
  'Expand the Scorecard Management panel (collapsed by default).',
  'Click Create Scorecard or Toggle Active Scorecard to switch which rubric is applied to new evaluations.',
  'To restore defaults, run Seed COPC v2 (admin route — confirms before overwriting).',
  'Weight changes apply to future evaluations only. Past scores are immutable unless Bulk Rescore is run.',
]);

h2('5. Service Levels');
table(
  ['Activity', 'Target'],
  [
    ['Ingest → Analyzed', '≤ 15 min'],
    ['Manager approval after AI analysis', '≤ 1 working day'],
    ['Coaching plan delivery after creation', '≤ 7 days'],
    ['Critical Risk findings (PDPL leak, mis-selling)', 'Same day — escalate to Quality Manager'],
  ],
  [330, 165]
);

h2('6. Troubleshooting');
table(
  ['Symptom', 'Action'],
  [
    ['Status stuck on Processing > 10 min', 'Click Analyze again; if it fails twice, check Logs.'],
    ['Status = Failed', 'Open call → read reason. "transcription_failed": re-upload audio. "openai_quota": notify Admin.'],
    ['Score looks wrong vs transcript', 'Open evaluation → override the attribute → write justification → re-approve.'],
    ['CRM linkage shows "Unmatched"', "Verify the call's Lead/Deal ID in Zoho exists and is not merged."],
    ['No new calls appearing', 'Check Zoho sync status on Duplicate Radar page (shared auth).'],
  ],
  [220, 275]
);

h2('7. Compliance Notes');
bullet([
  'All transcripts are PII-redacted before storage (PDPL/GDPR).',
  'Evaluation overrides are audit-logged with reviewer email + timestamp.',
  "Coaching plans count toward the agent's quarterly performance file.",
]);

doc.moveDown(1);
doc.moveTo(50, doc.y).lineTo(545, doc.y).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
doc.moveDown(0.3);
doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#9ca3af')
  .text('WalaPlus Enterprise GRC & Quality — Internal SOP — Generated 25 May 2026', { align: 'center' });

doc.end();
console.log('PDF written:', out);
