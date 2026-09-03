export const ExampleOrgSalesGovernanceRules = {
  document: {
    name: "ExampleOrg Sales Management Process",
    code: "ExampleOrg_Sales_1.1_01.12.2025",
    version: "1.1",
    effectiveDate: "2025-12-01",
    preparedBy: "Sample User / Quality Manager",
    approvedBy: ["Ziad Abbas / Head of Sales", "Sample User / Head of Operations & Quality", "Osama Harfoush / Chief Commercial Officer"]
  },
  
  dealStages: {
    "New Deal": {
      description: "Qualified lead handed over by SDR, no direct contact yet by Sales",
      maxDuration: null,
      requiredFields: ["Company Name", "Contact Person", "No. of Employees", "Region", "Industry"],
      nextStages: ["Contacted"]
    },
    "Contacted": {
      description: "Sales Agent initiated contact, meeting not yet conducted",
      maxDuration: null,
      requiredFields: ["First Call Activity Logged"],
      nextStages: ["Meeting", "Not Attend Meeting"]
    },
    "Not Attend Meeting": {
      description: "Scheduled meeting did not occur due to client absence",
      maxDuration: 5,
      maxDurationUnit: "business_days",
      requiredFields: ["Not Attend Reason"],
      validReasons: [
        "Sales Agent not attend",
        "Client has an emergency",
        "Client on a vacation",
        "Client no answer",
        "Client postponed",
        "Wrong contact person",
        "Wrong invitation/time scheduled"
      ],
      nextStages: ["Contacted", "Closed Lost"]
    },
    "Meeting": {
      description: "Initial meeting conducted, client interest confirmed, requirements documented",
      maxDuration: 10,
      maxDurationUnit: "business_days",
      requiredFields: ["Meeting Notes", "Client Requirements"],
      nextStages: ["Proposal", "Agreement Sent", "On Hold", "Closed Lost"]
    },
    "Proposal": {
      description: "Commercial offer sent, actively following up for feedback",
      maxDuration: 90,
      maxDurationUnit: "days",
      requiredFields: ["Proposal Document Attached", "Proposal Sent Date"],
      nextStages: ["Agreement Sent", "On Hold", "Closed Lost"]
    },
    "On Hold": {
      description: "Client showed interest but not ready to proceed",
      maxDuration: 180,
      maxDurationUnit: "days",
      requiredFields: ["On Hold Reason"],
      nextStages: ["Proposal", "Agreement Sent", "Closed Lost"]
    },
    "Agreement Sent": {
      description: "Service Agreement sent via Zoho Sign, pending signatures",
      maxDuration: 90,
      maxDurationUnit: "days",
      requiredFields: ["Agreement Document", "Agreement Sent Date"],
      nextStages: ["Agreement Signed", "Closed Lost"]
    },
    "Agreement Signed": {
      description: "All parties signed, ready for CS handover",
      maxDuration: null,
      requiredFields: ["Signed Agreement", "Invoice/Quotation in Zoho Books"],
      nextStages: []
    },
    "Closed Lost": {
      description: "Deal closed without successful outcome",
      maxDuration: null,
      requiredFields: ["Closed Lost Reason"],
      validReasons: [
        "Sales Issue",
        "Sales Issue - Not Interested",
        "Budget Issue",
        "Client Not Responding",
        "Client Rejected Service After Signing",
        "SDR Issue - Client Not Attend Meeting",
        "SDR Issue - Not Interested",
        "SDR Issue - Not Qualified Deal",
        "SDR Issue - Already a Client",
        "SDR Issue - Active Deal with Sales"
      ]
    }
  },
  
  slas: {
    "Contact After SDR Handoff": { value: 1, unit: "business_day", description: "Time between SDR handoff and first client contact" },
    "Proposal Preparation": { value: 2, unit: "business_days", description: "From meeting completion to sending first proposal" },
    "Proposal Validity Update": { value: 30, unit: "days", description: "From proposal expiry to re-issuance" },
    "Agreement Review & Signature": { value: 10, unit: "business_days", description: "From client acceptance to full signature" },
    "Agreement Escalation Window": { value: 5, unit: "business_days", description: "From GRC delay to escalation" },
    "Zoho CRM Activity Logging": { value: 0, unit: "same_day", description: "Log activities same business day" },
    "Follow-Up Compliance": { value: 0, unit: "same_day", description: "Complete follow-ups same business day" },
    "CS Handover Acknowledgment": { value: 1, unit: "business_day", description: "CS acknowledgment after Agreement Signed" },
    "Issue Escalation Window": { value: 4, unit: "hours", description: "Submit escalation notice within 4 hours" }
  },
  
  kpis: {
    individual: [
      { name: "Conversion Rate of SQL", target: "≥25%", calculation: "(Agreements Signed / Meetings) × 100", benchmark: "B2B 20-30%" },
      { name: "Proposal Cycle Time", target: "≤2 Days", calculation: "Proposal Sent Date - Meeting Date", benchmark: "Internal SLA" }
    ],
    process: [
      { name: "Agreement Cycle Time", target: "≤20 Days", calculation: "Agreement Signed Date - Proposal Sent Date", benchmark: "≤30 Days" },
      { name: "Data Accuracy Score", target: "≥95%", calculation: "(Compliant Deals / Sample) × 100", benchmark: "Internal Standard" },
      { name: "Documents Attachment Compliance", target: "≥95%", calculation: "(Deals with Complete Attachments / Total Closed Deals) × 100" },
      { name: "Deal Velocity Index", target: "↑ Trend Quarterly", calculation: "Total Closed Deals / Total Days in Cycle" },
      { name: "Follow-Up Effectiveness Rate", target: "≥95%", calculation: "(On-Time Follow-Ups / Total Follow-Ups) × 100" }
    ],
    governance: [
      { name: "SLA Adherence Rate", target: "≥90%", calculation: "(On-Time Activities / Total Activities) × 100" },
      { name: "Audit Compliance Score", target: "≥85%", calculation: "Average % across checkpoints", benchmark: "Best Practice ≥80%" }
    ]
  },
  
  qualificationCriteria: {
    targetMarket: "KSA",
    minEmployees: 15,
    validRoles: ["HR", "Operations", "Procurement"],
    seniorityLevels: ["Manager", "Director", "Head"],
    exclusions: ["Existing active client", "Blacklisted/disqualified accounts"]
  },
  
  requiredDocuments: {
    proposal: ["Commercial Offer/Quotation"],
    agreement: ["Service Agreement", "Signed Agreement"],
    client: ["CR (Commercial Registration)", "VAT Certificate"],
    optional: ["NDA", "Security Questionnaire"]
  },
  
  escalationRules: [
    { case: "Delay in CRM Update", trigger: "CRM not updated within 24 hours", firstLayer: "Sales TL", secondLayer: "Sales Manager" },
    { case: "Proposal Delay", trigger: "Proposal not sent within 2 business days", firstLayer: "Sales TL", secondLayer: "Sales Manager" },
    { case: "SLA Breach - Follow-up Delay", trigger: "Missed follow-up > 24 hours", firstLayer: "Sales TL", secondLayer: "Sales Manager" },
    { case: "Agreement Stuck > 2 Months", trigger: "No client response for > 2 months", firstLayer: "Sales Manager", secondLayer: "Head of Sales" }
  ],
  
  spotCheckCriteria: [
    "Completeness of Zoho CRM fields",
    "Correct stage movement",
    "Document/attachment accuracy",
    "Follow-up frequency"
  ],
  
  rcaMethod: {
    approach: "5 Whys",
    classification: ["People", "Process", "System", "Client-Side"],
    verificationWindow: 3,
    verificationUnit: "business_days"
  }
};

export const ExampleOrgSDRGovernanceRules = {
  document: {
    name: "ExampleOrg SDR Management Process",
    code: "ExampleOrg_SDR_2.1_04.12.2025",
    version: "2.1",
    effectiveDate: "2025-12-04",
    preparedBy: "Sample User / Quality Manager",
    approvedBy: ["Ziad Abbas / Head of Sales", "Sample User / Head of Operations & Quality"]
  },

  leadStages: {
    "New": {
      description: "Newly entered/imported lead, not yet contacted",
      maxDuration: null,
      requiredFields: ["Company", "First_Name", "Last_Name", "Phone", "Email", "Lead_Source"],
      nextStages: ["Contacting"]
    },
    "Contacting": {
      description: "SDR is actively reaching out",
      maxDuration: 5,
      maxDurationUnit: "business_days",
      requiredFields: ["Outgoing_Call_Result"],
      nextStages: ["Contacted", "Not Qualified", "Junk"]
    },
    "Contacted": {
      description: "Lead responded, initial conversation occurred",
      maxDuration: 3,
      maxDurationUnit: "business_days",
      requiredFields: ["Description", "Tag"],
      nextStages: ["Qualified", "Not Qualified", "On Hold", "Nurturing"]
    },
    "Qualified": {
      description: "Lead meets all qualification criteria, ready for Sales handoff",
      maxDuration: 1,
      maxDurationUnit: "business_days",
      requiredFields: ["No_of_Employees", "Industry", "City", "Designation"],
      qualificationCriteria: { minEmployees: 15, region: "KSA", validRoles: ["HR", "Operations", "Procurement", "Manager", "Director", "Head"] },
      nextStages: ["Converted"]
    },
    "Not Qualified": {
      description: "Lead does not meet criteria or is unresponsive",
      maxDuration: null,
      requiredFields: ["Not_Qualified_Reason"],
      validReasons: ["Not Interested", "Budget Constraints", "Wrong Market/Industry", "Duplicate", "Already a Client", "Competitor", "Spam/Junk"],
      nextStages: []
    },
    "On Hold": {
      description: "Lead expressed interest but timing is not right",
      maxDuration: 90,
      maxDurationUnit: "days",
      requiredFields: ["On_Hold_Reason"],
      nextStages: ["Contacting", "Not Qualified"]
    },
    "Nurturing": {
      description: "Lead requires long-term follow-up",
      maxDuration: 180,
      maxDurationUnit: "days",
      requiredFields: ["Description"],
      nextStages: ["Contacting", "Not Qualified"]
    },
    "Junk": {
      description: "Invalid lead (spam, wrong number, etc.)",
      maxDuration: null,
      requiredFields: [],
      nextStages: []
    },
    "Converted": {
      description: "Successfully converted to Deal + Contact",
      maxDuration: null,
      requiredFields: [],
      nextStages: []
    }
  },

  slas: {
    "Initial Contact Attempt": { value: 2, unit: "hours", description: "Time from lead assignment to first call attempt (inbound)" },
    "Outbound First Call": { value: 4, unit: "hours", description: "Time from lead creation to first outbound call" },
    "Follow-Up After No Answer": { value: 24, unit: "hours", description: "Re-attempt if first call unanswered" },
    "Lead Qualification Decision": { value: 3, unit: "business_days", description: "Max time from first contact to qualification/disqualification" },
    "Handoff to Sales": { value: 1, unit: "business_day", description: "Time from qualification to creating Deal in Sales pipeline" },
    "CRM Update After Call": { value: 0, unit: "same_day", description: "Log call result same business day" },
    "Duplicate Check Before Entry": { value: 0, unit: "immediate", description: "Check for existing lead/contact before creating new record" }
  },

  kpis: {
    individual: [
      { id: "SDR_K1", name: "Calls Per Day", target: 40, unit: "calls", calculation: "Total outbound calls / working days" },
      { id: "SDR_K2", name: "Contact Rate", target: 30, unit: "%", calculation: "(Connected calls / Total calls) × 100" },
      { id: "SDR_K3", name: "Qualification Rate", target: 25, unit: "%", calculation: "(Qualified leads / Total contacted leads) × 100" },
      { id: "SDR_K4", name: "Meetings Booked Per Week", target: 5, unit: "meetings", calculation: "Count of meetings booked per week" },
      { id: "SDR_K5", name: "Show Rate", target: 80, unit: "%", calculation: "(Meetings attended / Meetings booked) × 100" },
      { id: "SDR_K6", name: "Average Speed to Lead", target: 2, unit: "hours", calculation: "Average time from lead creation to first contact attempt" }
    ],
    process: [
      { id: "SDR_K7", name: "Lead-to-Qualified Conversion", target: 20, unit: "%", calculation: "(Qualified / Total new leads) × 100" },
      { id: "SDR_K8", name: "CRM Data Accuracy Score", target: 95, unit: "%", calculation: "(Leads with all required fields / Total leads) × 100" },
      { id: "SDR_K9", name: "Duplicate Rate", target: 2, unit: "% max", calculation: "(Duplicate leads / Total leads) × 100" },
      { id: "SDR_K10", name: "Pipeline Aging", target: 5, unit: "days avg", calculation: "Average days lead stays in Contacting/Contacted stages" },
      { id: "SDR_K11", name: "Follow-Up Compliance", target: 95, unit: "%", calculation: "(On-time follow-ups / Total follow-ups) × 100" }
    ]
  },

  qualificationCriteria: {
    targetMarket: "KSA",
    minEmployees: 15,
    validRoles: ["HR", "Operations", "Procurement"],
    seniorityLevels: ["Manager", "Director", "Head", "VP", "C-Level"],
    exclusions: ["Existing active client", "Blacklisted/disqualified accounts", "Competitor employees"],
    requiredInfo: ["Company Name", "Decision Maker Name", "Phone", "Business Email", "Employee Count", "Industry"]
  },

  escalationRules: [
    { case: "No Contact After 24h (Inbound)", trigger: "Inbound lead not contacted within 24 hours", firstLayer: "SDR TL", secondLayer: "Sales Manager" },
    { case: "CRM Not Updated", trigger: "Call result not logged same day", firstLayer: "SDR TL", secondLayer: "Sales Manager" },
    { case: "High Volume of Junk Leads", trigger: ">15% junk rate from a single source", firstLayer: "SDR TL", secondLayer: "Marketing" },
    { case: "Low Qualification Rate", trigger: "Agent below 15% qualification rate for 2 consecutive weeks", firstLayer: "SDR TL", secondLayer: "Sales Manager" }
  ]
};

export const qualityScorecardConfig = {
  name: "ExampleOrg Sales Quality Scorecard v1.0",
  description: "ISO 9001 + COPC aligned quality evaluation for SaaS sales",
  framework: "ISO 9001 + COPC + SaaS Best Practices",
  
  dimensions: {
    people: {
      weight: 0.25,
      name: "People Score",
      description: "Individual data entry accuracy, discipline & compliance",
      attributes: [
        {
          id: "P1",
          name: "CRM Data Entry Accuracy",
          weight: 0.30,
          description: "All mandatory fields completed correctly with valid data",
          passingCriteria: "100% completion, no placeholder text",
          zohoFields: ["Company_Name", "Contact_Person", "No_of_Employees", "Region", "Industry"],
          severityIfFailed: "high"
        },
        {
          id: "P2",
          name: "Notes Quality",
          weight: 0.20,
          description: "Meeting notes, client objections, and RCA documented clearly",
          passingCriteria: "Notes exist for every stage transition; include date, action, outcome",
          zohoFields: ["Notes"],
          severityIfFailed: "medium"
        },
        {
          id: "P3",
          name: "Follow-up Discipline",
          weight: 0.25,
          description: "Follow-up calls/tasks executed within SLA",
          passingCriteria: "≥95% on-time follow-ups",
          zohoFields: ["Tasks", "Calls"],
          severityIfFailed: "high"
        },
        {
          id: "P4",
          name: "Calendar Synchronization",
          weight: 0.15,
          description: "Google Calendar updated daily, reflects schedule changes",
          passingCriteria: "Calendar matches Zoho meeting activities",
          zohoFields: ["Meeting_Activities"],
          severityIfFailed: "medium"
        },
        {
          id: "P5",
          name: "Escalation Timeliness",
          weight: 0.10,
          description: "Issues escalated within ≤4 hours of detection",
          passingCriteria: "100% adherence to escalation SLA",
          zohoFields: ["Escalation_Notes"],
          severityIfFailed: "critical"
        }
      ]
    },
    
    process: {
      weight: 0.35,
      name: "Process Score",
      description: "SOP adherence, workflow execution, stage management",
      attributes: [
        {
          id: "PR1",
          name: "Stage Progression Accuracy",
          weight: 0.20,
          description: "Deal moves through correct stages per governance doc",
          passingCriteria: "Stages follow: New Deal → Contacted → Meeting → Proposal → Agreement Sent → Signed",
          zohoFields: ["Stage", "Stage_History"],
          severityIfFailed: "high"
        },
        {
          id: "PR2",
          name: "First Contact SLA",
          weight: 0.15,
          description: "Client contacted within 1 business day of SDR handoff",
          passingCriteria: "100% compliance with ≤1 day SLA",
          zohoFields: ["First_Call_Date", "Created_Time"],
          severityIfFailed: "high"
        },
        {
          id: "PR3",
          name: "Proposal Cycle Time",
          weight: 0.20,
          description: "Proposal sent within 2 business days of meeting",
          passingCriteria: "Average ≤2 days",
          zohoFields: ["Proposal_Sent_Date", "Meeting_Date"],
          severityIfFailed: "high"
        },
        {
          id: "PR4",
          name: "Meeting Confirmation Protocol",
          weight: 0.15,
          description: "Pre-meeting confirmation call made (30-60 min for short, 24h for long)",
          passingCriteria: "Evidence of confirmation call logged",
          zohoFields: ["Calls_Before_Meeting"],
          severityIfFailed: "medium"
        },
        {
          id: "PR5",
          name: "Not Attend Meeting Handling",
          weight: 0.10,
          description: "Deals properly moved with correct reason logged",
          passingCriteria: "Reason field populated from approved list",
          zohoFields: ["Not_Attend_Reason"],
          validValues: ["Sales Agent not attend", "Client has an emergency", "Client on a vacation", "Client no answer", "Client postponed", "Wrong contact person", "Wrong invitation/time scheduled"],
          severityIfFailed: "medium"
        },
        {
          id: "PR6",
          name: "Closed Lost Reason Accuracy",
          weight: 0.10,
          description: "Lost deals have valid reason from approved categories",
          passingCriteria: "Reason selected from governance-defined list",
          zohoFields: ["Closed_Lost_Reason"],
          validValues: ["Sales Issue", "Sales Issue - Not Interested", "Budget Issue", "Client Not Responding", "Client Rejected Service After Signing", "SDR Issue - Client Not Attend Meeting", "SDR Issue - Not Interested", "SDR Issue - Not Qualified Deal", "SDR Issue - Already a Client", "SDR Issue - Active Deal with Sales"],
          severityIfFailed: "medium"
        },
        {
          id: "PR7",
          name: "Stage Timeframe Compliance",
          weight: 0.10,
          description: "Deals don't exceed max time per stage",
          passingCriteria: "Meeting ≤10 days, Proposal ≤3 months, Agreement Sent ≤3 months",
          zohoFields: ["Stage_Entry_Date", "Stage"],
          severityIfFailed: "high"
        }
      ]
    },
    
    governance: {
      weight: 0.40,
      name: "Governance Score",
      description: "CRM integrity, SLA adherence, documentation compliance",
      attributes: [
        {
          id: "G1",
          name: "Same-Day CRM Update",
          weight: 0.20,
          description: "All client interactions logged same business day",
          passingCriteria: "100% compliance",
          zohoFields: ["Activity_Timestamp", "Interaction_Date"],
          severityIfFailed: "critical"
        },
        {
          id: "G2",
          name: "Document Attachment Compliance",
          weight: 0.20,
          description: "Required documents attached before CS handover",
          passingCriteria: "≥95% deals have: Proposal, Agreement, CR, VAT Certificate",
          zohoFields: ["Attachments"],
          requiredDocs: ["Proposal", "Agreement", "CR", "VAT Certificate"],
          severityIfFailed: "high"
        },
        {
          id: "G3",
          name: "Qualification Criteria Validation",
          weight: 0.15,
          description: "Deals meet qualification rules (KSA, 15+ employees, decision-maker)",
          passingCriteria: "100% of deals are qualified per Section 7.1.2",
          zohoFields: ["No_of_Employees", "Region", "Contact_Title"],
          validations: { region: "KSA", minEmployees: 15, validTitles: ["Manager", "Director", "Head", "HR"] },
          severityIfFailed: "critical"
        },
        {
          id: "G4",
          name: "Agreement Review SLA",
          weight: 0.15,
          description: "Client acceptance to full signature ≤10 business days",
          passingCriteria: "90% compliance",
          zohoFields: ["Agreement_Sent_Date", "Agreement_Signed_Date"],
          maxDays: 10,
          severityIfFailed: "high"
        },
        {
          id: "G5",
          name: "Handover Completeness",
          weight: 0.15,
          description: "CS handover acknowledged within 1 business day",
          passingCriteria: "100% compliance",
          zohoFields: ["Handover_Activity"],
          severityIfFailed: "high"
        },
        {
          id: "G6",
          name: "Audit Trail Integrity",
          weight: 0.15,
          description: "All stage changes, reassignments, and escalations documented",
          passingCriteria: "Complete audit trail in Notes",
          zohoFields: ["Notes", "History"],
          severityIfFailed: "medium"
        }
      ]
    }
  },
  
  severityMatrix: [
    { range: [90, 100], rating: "Excellent", action: "Recognition; share best practices", color: "#22c55e" },
    { range: [80, 89], rating: "Good", action: "Minor coaching; continue monitoring", color: "#84cc16" },
    { range: [70, 79], rating: "Needs Improvement", action: "Coaching plan required; weekly review", color: "#eab308" },
    { range: [60, 69], rating: "Below Standard", action: "Formal improvement plan; daily monitoring", color: "#f97316" },
    { range: [0, 59], rating: "Critical", action: "Escalate to Sales Manager; immediate intervention", color: "#ef4444" }
  ],
  
  mandatoryFields: {
    deals: ["Deal_Name", "Account_Name", "Deal_Owner", "Stage", "Amount", "Closing_Date", "Contact_Person", "No_of_Employees", "Region", "Industry"],
    tasks: ["Subject", "Due_Date", "Owner", "Related_Deal", "Status", "Priority"],
    contacts: ["First_Name", "Last_Name", "Email", "Phone", "Account_Name", "Title"]
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Attachment audit rules — Deals only.
// Audited stages: "Proposal" and "Agreement Signed" (Agreement Sent is implicitly
// covered by the Signed stage check since the same artifact moves between them).
// Keywords are matched case-insensitively against the file_name. Arabic keywords
// are matched as substrings on the original (non-normalized) filename.
// Edit these arrays to tune what counts as a valid document — no code change needed.
// ─────────────────────────────────────────────────────────────────────────────
export interface AttachmentStageRule {
  keywords: string[];                   // any one keyword in filename = valid
  severityIfMissing: 'critical' | 'high' | 'medium' | 'low';
  severityIfWrongType: 'critical' | 'high' | 'medium' | 'low';
  description: string;
}

export const ExampleOrgAttachmentAuditRules = {
  module: 'Deals' as const,
  stageField: 'Stage',
  // Keys MUST match Zoho Stage values exactly (case-insensitive comparison handled by code).
  stages: {
    'Proposal': {
      keywords: ['proposal', 'offer', 'quotation', 'عرض'],
      severityIfMissing: 'high',
      severityIfWrongType: 'medium',
      description: 'Deals in Proposal stage must have a commercial offer / proposal document attached.',
    },
    'Agreement Signed': {
      keywords: ['agreement', 'contract', 'signed', 'موقع', 'اتفاقية'],
      severityIfMissing: 'critical',
      severityIfWrongType: 'high',
      description: 'Deals in Agreement Signed stage must have a signed agreement / contract document attached.',
    },
  } as Record<string, AttachmentStageRule>,
  // Universal checks — applied to every attachment regardless of stage.
  dangerousExtensions: ['.exe', '.bat', '.scr', '.cmd', '.com', '.pif'],
  // 0-byte files always flagged Critical.
  // Concurrency for fetching attachments per record.
  fetchConcurrency: 6,
};

