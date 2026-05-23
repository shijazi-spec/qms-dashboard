/**
 * Per-owner Remediation Packet (R2) — XLSX builder.
 *
 * Hands a CRM record owner a self-contained 4-sheet workbook that explains:
 *   - WHAT they own (Cover: metrics + RAG + due-by + escalation path)
 *   - WHAT to do for each cluster (Action Items: 5 playbook columns + id info)
 *   - The full record dump (Raw Records: every duplicate row, no playbook noise)
 *   - The standing answers (FAQ: 7 entries; tone is "I'm new to this packet")
 *
 * Packet "due-by" reuses the R1 playbook tier thresholds (high=7 / med=14 /
 * low=30 days) — we pick the EARLIEST of the owner's clusters so an owner
 * with a single critical cluster doesn't think they have 30 days.
 *
 * Locale: pass `lang: 'en' | 'ar'`. Sheet names, Cover field labels, RAG
 * descriptors, Yes/No, the playbook column headers, and all 7 FAQ entries
 * have Arabic strings. Arabic sheets get `rightToLeft: true` so Excel
 * mirrors column order and selection arrows.
 */

import {
  PLAYBOOK_XLSX_COLUMNS,
  emptyPlaybookState,
  startCluster,
  rowPlaybook,
  dueDate,
  getConfidenceTier,
} from "./duplicateRadarPlaybook";
import type {
  OwnerAccountability,
  PacketSettings,
} from "./duplicateRadarDatabase";

export type PacketLang = "en" | "ar";

export interface PacketBuildInputs {
  owner: OwnerAccountability;
  settings: PacketSettings;
  // Rows for Action Items + Raw Records sheets. Pre-sorted by cluster_id,
  // is_primary DESC so startCluster()/rowPlaybook() can be threaded through.
  records: Array<Record<string, unknown>>;
  // Distinct cluster_confidence_score values for the owner's clusters, used
  // to compute the packet's earliest-tier due date.
  clusterConfidences: number[];
  now?: Date;
  /** Output locale. Defaults to "en". */
  lang?: PacketLang;
}

/**
 * The packet-level "due by" is the EARLIEST of the owner's clusters.
 * If the owner has at least one high-confidence cluster they get 7d;
 * otherwise medium → 14d, otherwise 30d. Avoids the surprise of an owner
 * thinking they have 30d when one of their clusters is revenue-critical.
 */
export function packetDueDate(
  clusterConfidences: number[],
  now?: Date,
): string {
  if (clusterConfidences.length === 0) {
    return dueDate({ cluster_confidence: null, now });
  }
  const tiers = clusterConfidences.map(getConfidenceTier);
  if (tiers.includes("high")) {
    return dueDate({ cluster_confidence: 95, now });
  }
  if (tiers.includes("medium")) {
    return dueDate({ cluster_confidence: 75, now });
  }
  return dueDate({ cluster_confidence: 30, now });
}

// ---------------------------------------------------------------------------
// Bilingual strings (English + Arabic). Add a new key in BOTH maps; the
// builder reads from `S[lang]` so a missing AR string would produce
// undefined and the test suite would catch it. FAQ tone matches the EN
// original: written for someone who has never opened a packet before.
// ---------------------------------------------------------------------------

interface PacketStrings {
  sheetCover: string;
  sheetActionItems: string;
  sheetRawRecords: string;
  sheetFaq: string;

  colField: string;
  colValue: string;
  colN: string;
  colQuestion: string;
  colAnswer: string;
  colClusterId: string;
  colZohoId: string;
  colRecordName: string;
  colType: string;
  colIsPrimary: string;
  colDomain: string;
  colEmail: string;
  colCompany: string;
  colPhone: string;
  colOwner: string;
  colStatusStage: string;
  colValueAmt: string;
  colSource: string;
  colConfidence: string;
  colCreated: string;
  colName: string;

  fieldOwner: string;
  fieldOwnerEmail: string;
  fieldTotalRecords: string;
  fieldDuplicateRecords: string;
  fieldDuplicateRate: string;
  fieldRagStatus: string;
  fieldHighConfidence: string;
  fieldClustersInvolved: string;
  fieldEstimatedWaste: string;
  fieldPacketDueBy: string;
  fieldEscalationName: string;
  fieldEscalationEmail: string;
  fieldDisputePath: string;
  fieldGenerated: string;

  yes: string;
  no: string;
  emDash: string;

  ragRed: string;
  ragAmber: string;
  ragGreen: string;

  faq: Array<{ q: string; a: string }>;
}

const STRINGS_EN: PacketStrings = {
  sheetCover: "Cover",
  sheetActionItems: "Action Items",
  sheetRawRecords: "Raw Records",
  sheetFaq: "FAQ",

  colField: "Field",
  colValue: "Value",
  colN: "#",
  colQuestion: "Question",
  colAnswer: "Answer",
  colClusterId: "Cluster ID",
  colZohoId: "Zoho ID",
  colRecordName: "Record name",
  colType: "Type",
  colIsPrimary: "Is primary",
  colDomain: "Domain",
  colEmail: "Email",
  colCompany: "Company",
  colPhone: "Phone",
  colOwner: "Owner",
  colStatusStage: "Status / Stage",
  colValueAmt: "Value",
  colSource: "Source",
  colConfidence: "Confidence",
  colCreated: "Created",
  colName: "Name",

  fieldOwner: "Owner",
  fieldOwnerEmail: "Owner email",
  fieldTotalRecords: "Total records",
  fieldDuplicateRecords: "Duplicate records",
  fieldDuplicateRate: "Duplicate rate",
  fieldRagStatus: "RAG status",
  fieldHighConfidence: "High-confidence duplicates",
  fieldClustersInvolved: "Clusters involved",
  fieldEstimatedWaste: "Estimated waste value (deals)",
  fieldPacketDueBy: "Packet due by",
  fieldEscalationName: "Escalation contact",
  fieldEscalationEmail: "Escalation email",
  fieldDisputePath: "Dispute path",
  fieldGenerated: "Generated",

  yes: "Yes",
  no: "No",
  emDash: "—",

  ragRed: "Red — duplicate rate >5%",
  ragAmber: "Amber — duplicate rate 2-5%",
  ragGreen: "Green — duplicate rate ≤2%",

  faq: [
    {
      q: "What counts as a duplicate?",
      a: "Two or more records (Lead, Deal, Contact or Account) that the radar matched on email domain, phone number, or normalized company name with a confidence score ≥60%. Records below 60% are flagged 'low confidence' and require manual triage.",
    },
    {
      q: "Why am I getting this packet?",
      a: "You are the Owner of record on at least one duplicate cluster. Cleaning these keeps reporting accurate, prevents commission disputes, and stops the same lead being worked twice.",
    },
    {
      q: "What does 'Merge into <name>' mean in the Recommended Action column?",
      a: "<name> is the primary record the radar (or an operator) selected as the survivor. Open it in Zoho, copy any unique field values from the duplicate into the primary, then run Zoho's merge so the duplicate is deleted and references re-link.",
    },
    {
      q: "What is the Survivorship Rule column telling me?",
      a: "It explains how confident the radar is about the primary selection. 'High-confidence (≥90%)' clusters are safe to merge after a quick field-check; 'low-confidence (<60%)' clusters should not be auto-merged — escalate them.",
    },
    {
      q: "What is the Due Date column based on?",
      a: "It's the recommended SLA derived from cluster severity: high-confidence = 7 days, medium = 14 days, low = 30 days. The packet-level 'Packet due by' on the Cover sheet uses your earliest cluster.",
    },
    {
      q: "How do I dispute a row?",
      a: "Follow the 'Dispute path' on the Cover sheet of this workbook. Include the Cluster ID and Zoho ID(s) from the Action Items sheet so the data-quality team can locate the cluster instantly.",
    },
    {
      q: "What happens after I act on these in Zoho?",
      a: "The next radar sync (typically nightly) re-scans your records. Resolved clusters drop off the dashboard within 24 hours. If a cluster reappears, it usually means the duplicate was re-created from a new source — escalate via the contact above.",
    },
  ],
};

const STRINGS_AR: PacketStrings = {
  sheetCover: "الغلاف",
  sheetActionItems: "خطوات المعالجة",
  sheetRawRecords: "السجلات الأصلية",
  sheetFaq: "الأسئلة الشائعة",

  colField: "الحقل",
  colValue: "القيمة",
  colN: "م",
  colQuestion: "السؤال",
  colAnswer: "الإجابة",
  colClusterId: "معرّف المجموعة",
  colZohoId: "معرّف زوهو",
  colRecordName: "اسم السجل",
  colType: "النوع",
  colIsPrimary: "السجل الأساسي",
  colDomain: "النطاق",
  colEmail: "البريد",
  colCompany: "الشركة",
  colPhone: "الهاتف",
  colOwner: "المالك",
  colStatusStage: "الحالة / المرحلة",
  colValueAmt: "القيمة",
  colSource: "المصدر",
  colConfidence: "نسبة الثقة",
  colCreated: "تاريخ الإنشاء",
  colName: "الاسم",

  fieldOwner: "المالك",
  fieldOwnerEmail: "بريد المالك",
  fieldTotalRecords: "إجمالي السجلات",
  fieldDuplicateRecords: "السجلات المكررة",
  fieldDuplicateRate: "نسبة التكرار",
  fieldRagStatus: "الحالة (RAG)",
  fieldHighConfidence: "تكرارات عالية الثقة",
  fieldClustersInvolved: "عدد المجموعات",
  fieldEstimatedWaste: "القيمة المالية المهدورة (الصفقات)",
  fieldPacketDueBy: "تاريخ استحقاق الحزمة",
  fieldEscalationName: "جهة التصعيد",
  fieldEscalationEmail: "بريد التصعيد",
  fieldDisputePath: "مسار الاعتراض",
  fieldGenerated: "تاريخ الإنشاء",

  yes: "نعم",
  no: "لا",
  emDash: "—",

  ragRed: "أحمر — نسبة التكرار > 5٪",
  ragAmber: "أصفر — نسبة التكرار 2 - 5٪",
  ragGreen: "أخضر — نسبة التكرار ≤ 2٪",

  faq: [
    {
      q: "ما الذي يُعدّ سجلاً مكرراً؟",
      a: "سجلان أو أكثر (عميل محتمل، صفقة، جهة اتصال، أو حساب) طابقها رادار التكرار عبر نطاق البريد الإلكتروني، رقم الهاتف، أو اسم الشركة المُطبَّع بنسبة ثقة تساوي 60٪ أو أعلى. السجلات تحت 60٪ تُصنَّف 'ثقة منخفضة' وتحتاج مراجعة يدوية.",
    },
    {
      q: "لماذا وصلتني هذه الحزمة؟",
      a: "أنت المالك المُسجَّل في زوهو لمجموعة تكرار واحدة على الأقل. تنظيف هذه السجلات يحافظ على دقة التقارير، ويمنع نزاعات العمولات، ويحول دون العمل على العميل ذاته من قبل أكثر من شخص.",
    },
    {
      q: "ما معنى 'دمج في <الاسم>' في عمود الإجراء الموصى به؟",
      a: "<الاسم> هو السجل الأساسي الذي اختاره الرادار (أو مشغّل) ليكون السجل الناجي. افتحه في زوهو، انقل أي قيم حقول فريدة من السجل المكرر إلى الأساسي، ثم نفّذ الدمج في زوهو بحيث يُحذف المكرر وتنتقل المراجع.",
    },
    {
      q: "ما الذي يخبرني به عمود قاعدة البقاء (Survivorship Rule)؟",
      a: "يوضّح مدى ثقة الرادار باختيار السجل الأساسي. مجموعات 'الثقة العالية (≥90٪)' آمنة للدمج بعد فحص سريع للحقول؛ أما 'الثقة المنخفضة (<60٪)' فلا تُدمَج تلقائياً ويجب تصعيدها.",
    },
    {
      q: "على أي أساس يُحسب عمود تاريخ الاستحقاق؟",
      a: "هو اتفاقية مستوى الخدمة (SLA) المشتقة من خطورة المجموعة: ثقة عالية = 7 أيام، متوسطة = 14 يوماً، منخفضة = 30 يوماً. 'تاريخ استحقاق الحزمة' في صفحة الغلاف يستخدم أبكر مجموعاتك.",
    },
    {
      q: "كيف أعترض على صف معيّن؟",
      a: "اتّبع 'مسار الاعتراض' الموجود في صفحة الغلاف لهذا الملف. أرفق معرّف المجموعة ومعرّفات زوهو من صفحة 'خطوات المعالجة' حتى يستطيع فريق جودة البيانات تحديد المجموعة فوراً.",
    },
    {
      q: "ماذا يحدث بعد تنفيذ الإجراءات في زوهو؟",
      a: "تُعيد المزامنة التالية (عادة ليلياً) فحص سجلاتك. تختفي المجموعات المعالجة من لوحة التحكم خلال 24 ساعة. إذا عادت المجموعة للظهور فهذا يعني عادةً أن السجل المكرر أُعيد إنشاؤه من مصدر جديد — صعّد الأمر للجهة المذكورة أعلاه.",
    },
  ],
};

function pickStrings(lang?: PacketLang): PacketStrings {
  return lang === "ar" ? STRINGS_AR : STRINGS_EN;
}

/**
 * Cover sheet: owner-scoped metrics + meta. Two-column key/value layout so
 * a non-technical reader scans it top-to-bottom in seconds.
 *
 * Escalation contact is split across two rows (name + email) — putting
 * `Name <email>` in one cell makes Excel auto-linkify the angle-bracket
 * form and breaks the display in some clients.
 */
function buildCoverSheet(input: PacketBuildInputs) {
  const { owner, settings, now } = input;
  const S = pickStrings(input.lang);
  const due = packetDueDate(input.clusterConfidences, now);
  const generated = (now ?? new Date()).toISOString();
  const ragLabel =
    owner.rag_status === "red"
      ? S.ragRed
      : owner.rag_status === "amber"
        ? S.ragAmber
        : S.ragGreen;

  return {
    name: S.sheetCover,
    rightToLeft: input.lang === "ar",
    columns: [
      { header: S.colField, key: "field", width: 30 },
      { header: S.colValue, key: "value", width: 60 },
    ],
    rows: [
      { field: S.fieldOwner, value: owner.owner_name },
      { field: S.fieldOwnerEmail, value: owner.owner_email || S.emDash },
      { field: S.fieldTotalRecords, value: owner.total_records },
      { field: S.fieldDuplicateRecords, value: owner.duplicate_records },
      { field: S.fieldDuplicateRate, value: `${owner.duplicate_rate}%` },
      { field: S.fieldRagStatus, value: ragLabel },
      { field: S.fieldHighConfidence, value: owner.high_confidence_duplicates },
      { field: S.fieldClustersInvolved, value: owner.clusters_involved },
      { field: S.fieldEstimatedWaste, value: owner.estimated_waste_value },
      { field: S.fieldPacketDueBy, value: due },
      { field: S.fieldEscalationName, value: settings.escalation_contact_name },
      {
        field: S.fieldEscalationEmail,
        value: settings.escalation_contact_email,
      },
      { field: S.fieldDisputePath, value: settings.dispute_path },
      { field: S.fieldGenerated, value: generated },
    ],
  };
}

/**
 * Action Items sheet: identifying record info on the left, 5 playbook
 * columns on the right. Threads playbook state across rows the same way
 * /export-xlsx does so "Merge into <primary>" stays correct.
 */
function buildActionItemsSheet(input: PacketBuildInputs) {
  const S = pickStrings(input.lang);
  const idColumns = [
    { header: S.colClusterId, key: "cluster_id", width: 12 },
    { header: S.colZohoId, key: "zoho_record_id", width: 22 },
    { header: S.colRecordName, key: "record_name", width: 30 },
    { header: S.colType, key: "record_type", width: 12 },
    { header: S.colIsPrimary, key: "is_primary_label", width: 12 },
    { header: S.colDomain, key: "domain", width: 22 },
    { header: S.colEmail, key: "email", width: 28 },
  ];

  const state = emptyPlaybookState();
  const rows: Array<Record<string, unknown>> = [];
  for (const rec of input.records) {
    const cid = Number(rec.cluster_id ?? -1);
    if (cid !== state.cluster_id) startCluster(state, rec);
    const pb = rowPlaybook(rec, state);
    rows.push({
      cluster_id: rec.cluster_id,
      zoho_record_id: rec.zoho_record_id,
      record_name: rec.record_name,
      record_type: rec.record_type,
      is_primary_label: rec.is_primary ? S.yes : S.no,
      domain: rec.domain,
      email: rec.email,
      ...pb,
    });
  }

  return {
    name: S.sheetActionItems,
    rightToLeft: input.lang === "ar",
    columns: [...idColumns, ...PLAYBOOK_XLSX_COLUMNS],
    rows,
  };
}

/**
 * Raw Records sheet: every column the operator might need to investigate
 * the row in Zoho, no playbook columns (so reads cleanly as a data dump).
 */
function buildRawRecordsSheet(input: PacketBuildInputs) {
  const S = pickStrings(input.lang);
  return {
    name: S.sheetRawRecords,
    rightToLeft: input.lang === "ar",
    columns: [
      { header: S.colClusterId, key: "cluster_id", width: 12 },
      { header: S.colZohoId, key: "zoho_record_id", width: 22 },
      { header: S.colType, key: "record_type", width: 12 },
      { header: S.colName, key: "record_name", width: 30 },
      { header: S.colCompany, key: "company_name", width: 30 },
      { header: S.colEmail, key: "email", width: 28 },
      { header: S.colDomain, key: "domain", width: 22 },
      { header: S.colPhone, key: "phone", width: 18 },
      { header: S.colOwner, key: "owner_name", width: 22 },
      { header: S.colStatusStage, key: "status_or_stage", width: 18 },
      { header: S.colValueAmt, key: "deal_value", width: 14 },
      { header: S.colSource, key: "source", width: 18 },
      { header: S.colConfidence, key: "confidence_score", width: 12 },
      { header: S.colCreated, key: "created_str", width: 14 },
      { header: S.colIsPrimary, key: "is_primary_label", width: 12 },
    ],
    rows: input.records.map((r) => ({
      ...r,
      is_primary_label: r.is_primary ? S.yes : S.no,
    })),
  };
}

/**
 * FAQ sheet: 7 standing Q&A entries written for an owner who just received
 * the packet and has never used Duplicate Radar before. Edit these as
 * stakeholder feedback comes in — they're plain strings in STRINGS_EN /
 * STRINGS_AR above.
 */
function buildFaqSheet(input: PacketBuildInputs) {
  const S = pickStrings(input.lang);
  return {
    name: S.sheetFaq,
    rightToLeft: input.lang === "ar",
    columns: [
      { header: S.colN, key: "n", width: 4 },
      { header: S.colQuestion, key: "q", width: 50 },
      { header: S.colAnswer, key: "a", width: 90 },
    ],
    rows: S.faq.map((e, i) => ({ n: i + 1, ...e })),
  };
}

/** Public entry: build all four sheets ready for `streamXlsx`. */
export function buildPacketSheets(input: PacketBuildInputs) {
  return [
    buildCoverSheet(input),
    buildActionItemsSheet(input),
    buildRawRecordsSheet(input),
    buildFaqSheet(input),
  ];
}

/**
 * Filename slug used by both the route response (Content-Disposition) and
 * the dashboard's optimistic local filename. Strips anything that would
 * upset Windows / macOS filesystems while preserving readability. ASCII
 * range only so the client-side fallback regex
 * (dashboard/duplicates.html `downloadOwnerPacket`) agrees with the
 * server-side name for Arabic / non-ASCII owners.
 */
export function packetFilename(ownerName: string): string {
  const slug =
    (ownerName || "owner")
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "owner";
  return `duplicate-radar-packet-${slug}.xlsx`;
}
