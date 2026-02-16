import { db } from "./db";
import { documents, audits, nonConformances, capas } from "@shared/schema";
import { log } from "./logger";

export async function seedDatabase() {
  const existingDocs = await db.select().from(documents);
  if (existingDocs.length > 0) {
    log("Database already seeded, skipping");
    return;
  }

  log("Seeding database with sample data...");

  await db.insert(documents).values([
    {
      title: "Quality Policy Manual",
      documentNumber: "DOC-001",
      revision: "3.2",
      status: "approved",
      category: "Policy",
      owner: "Sarah Mitchell",
      description: "Organization-wide quality policy defining quality objectives and management commitment",
    },
    {
      title: "Incoming Inspection Procedure",
      documentNumber: "DOC-002",
      revision: "2.1",
      status: "approved",
      category: "SOP",
      owner: "James Rodriguez",
      description: "Standard operating procedure for inspecting incoming raw materials and components",
    },
    {
      title: "Corrective Action Process",
      documentNumber: "DOC-003",
      revision: "1.5",
      status: "in-review",
      category: "SOP",
      owner: "Emily Chen",
      description: "Process for identifying, documenting, and resolving corrective actions",
    },
    {
      title: "Calibration Work Instruction",
      documentNumber: "DOC-004",
      revision: "4.0",
      status: "approved",
      category: "Work Instruction",
      owner: "Michael Davis",
      description: "Step-by-step instructions for calibrating measurement equipment",
    },
    {
      title: "Supplier Qualification Form",
      documentNumber: "DOC-005",
      revision: "1.0",
      status: "draft",
      category: "Form",
      owner: "Lisa Park",
      description: "Form template for qualifying and approving new suppliers",
    },
  ]);

  await db.insert(audits).values([
    {
      title: "ISO 9001 Surveillance Audit",
      auditNumber: "AUD-001",
      type: "external",
      status: "completed",
      auditor: "TUV Rheinland",
      department: "Quality",
      scheduledDate: new Date("2026-01-15"),
      completedDate: new Date("2026-01-16"),
      findings: 2,
      description: "Annual surveillance audit by certification body",
    },
    {
      title: "Production Floor Internal Audit",
      auditNumber: "AUD-002",
      type: "internal",
      status: "completed",
      auditor: "Emily Chen",
      department: "Production",
      scheduledDate: new Date("2026-01-28"),
      completedDate: new Date("2026-01-29"),
      findings: 3,
      description: "Quarterly internal audit of production area processes",
    },
    {
      title: "Warehouse Process Audit",
      auditNumber: "AUD-003",
      type: "internal",
      status: "planned",
      auditor: "James Rodriguez",
      department: "Logistics",
      scheduledDate: new Date("2026-03-10"),
      findings: 0,
      description: "Audit of warehouse storage and handling procedures",
    },
    {
      title: "Supplier Site Audit - Apex Materials",
      auditNumber: "AUD-004",
      type: "supplier",
      status: "planned",
      auditor: "Lisa Park",
      department: "Procurement",
      scheduledDate: new Date("2026-04-05"),
      findings: 0,
      description: "On-site audit of key raw material supplier",
    },
  ]);

  await db.insert(nonConformances).values([
    {
      title: "Dimensional out-of-spec on Part A-204",
      ncNumber: "NC-001",
      severity: "major",
      status: "open",
      source: "inspection",
      department: "Production",
      assignedTo: "James Rodriguez",
      description: "Batch 2026-B12 parts measured 0.3mm over tolerance on outer diameter",
      rootCause: "Tool wear on CNC lathe #3",
    },
    {
      title: "Missing traceability labels on incoming stock",
      ncNumber: "NC-002",
      severity: "minor",
      status: "under-investigation",
      source: "audit",
      department: "Logistics",
      assignedTo: "Michael Davis",
      description: "Three pallets of raw material received without proper traceability labels",
    },
    {
      title: "Customer complaint - coating defect",
      ncNumber: "NC-003",
      severity: "critical",
      status: "open",
      source: "customer-complaint",
      department: "Quality",
      assignedTo: "Sarah Mitchell",
      description: "Customer reported flaking surface coating on delivered units, lot 2026-L08",
      dueDate: new Date("2026-03-01"),
    },
    {
      title: "Calibration overdue on torque wrench",
      ncNumber: "NC-004",
      severity: "minor",
      status: "closed",
      source: "internal-report",
      department: "Maintenance",
      assignedTo: "Emily Chen",
      description: "Torque wrench TW-12 found to be 2 weeks past calibration due date",
      rootCause: "Calibration schedule not updated after equipment relocation",
    },
  ]);

  await db.insert(capas).values([
    {
      title: "Implement tool wear monitoring system",
      capaNumber: "CAPA-001",
      type: "corrective",
      status: "in-progress",
      priority: "high",
      assignedTo: "James Rodriguez",
      department: "Production",
      description: "Install automated tool wear monitoring on CNC machines to prevent out-of-spec parts",
      ncReference: "NC-001",
      dueDate: new Date("2026-03-15"),
    },
    {
      title: "Revise receiving inspection checklist",
      capaNumber: "CAPA-002",
      type: "preventive",
      status: "open",
      priority: "medium",
      assignedTo: "Michael Davis",
      department: "Logistics",
      description: "Update receiving inspection checklist to include mandatory traceability label verification",
      ncReference: "NC-002",
      dueDate: new Date("2026-03-01"),
    },
    {
      title: "Coating process parameter review",
      capaNumber: "CAPA-003",
      type: "corrective",
      status: "open",
      priority: "high",
      assignedTo: "Sarah Mitchell",
      department: "Quality",
      description: "Conduct thorough review of coating process parameters and environmental controls",
      ncReference: "NC-003",
      dueDate: new Date("2026-02-28"),
    },
    {
      title: "Calibration tracking system upgrade",
      capaNumber: "CAPA-004",
      type: "preventive",
      status: "closed",
      priority: "low",
      assignedTo: "Emily Chen",
      department: "Maintenance",
      description: "Upgrade calibration tracking to include automated email reminders 30 days before due date",
      ncReference: "NC-004",
    },
  ]);

  log("Database seeded successfully");
}
