/**
 * Controlled-Document Registry seed data.
 *
 * One row per coded document in your WP-* document control set
 * (WP-POL-*, WP-DOC-*, WP-SOP-*, WP-FORM-*, WP-CTL-*). These are seeded
 * into the existing `policies` table on platform boot — idempotent
 * (ON CONFLICT DO NOTHING on policy_number).
 *
 * Why seed at all? Because the HITL AI approval gate references these
 * documents by code ("per WP-SOP-011"). The approval card in chat must be
 * able to resolve that code into a clickable title + version + download
 * link. Seeding puts them in the same table the platform's existing
 * policy governance UI already uses (Policy Governance module at /policies).
 *
 * Once seeded, each row has file_path=null. The Quality Manager can click
 * "Upload" on the policy page to attach the final .docx/PDF — that wires
 * up via the existing POST /api/documents/upload endpoint without any
 * new code.
 *
 * Source of truth for titles: the filename inventory in
 *   PDPL/Ready to Release/Coded & Controlled/{Documents,Policies,SOPs,Forms,Security Controls}
 *
 * To keep a document controlled, update this file AND upload the new
 * version via /api/documents/upload — the policy_versions table captures
 * the version history automatically.
 */

import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export type DocCategory =
  | 'governance' | 'operational' | 'hr' | 'it' | 'compliance' | 'security' | 'quality';

export type DocType =
  | 'policy' | 'sop' | 'procedure' | 'form' | 'guideline' | 'control' | 'document';

interface SeedDoc {
  code: string;           // WP-POL-001
  title: string;
  category: DocCategory;
  documentType: DocType;
  owner: string;          // default owner department or role
}

/**
 * Full inventory of coded & controlled documents (as of doc-control phase).
 * Ordering: policies, docs/guidelines, SOPs, forms, security controls.
 * Owner defaults reflect the likely primary owner (Quality Manager,
 * DPO, CISO/IT Security, HR). Adjust via the Policy Governance UI.
 */
const SEED_DOCUMENTS: SeedDoc[] = [
  // ---------- Policies (WP-POL) ----------
  { code: 'WP-POL-001', title: 'Privacy and Personal Data Protection Policy',            category: 'compliance', documentType: 'policy', owner: 'Data Protection Office' },
  { code: 'WP-POL-002', title: 'Access Control Policy',                                   category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-003', title: 'Data Processing Lawfulness Policy',                       category: 'compliance', documentType: 'policy', owner: 'Data Protection Office' },
  { code: 'WP-POL-004', title: 'Privacy Notice – Customers',                              category: 'compliance', documentType: 'policy', owner: 'Data Protection Office' },
  { code: 'WP-POL-005', title: 'Privacy Notice – Employees',                              category: 'hr',         documentType: 'policy', owner: 'Human Resources' },
  { code: 'WP-POL-006', title: 'Information Security Policy',                             category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-007', title: 'Quality Policy',                                          category: 'quality',    documentType: 'policy', owner: 'Quality Management' },
  { code: 'WP-POL-008', title: 'Acceptable Use Policy',                                   category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-009', title: 'Asset Management Policy',                                 category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-010', title: 'Information Security Policy for Supplier Relationships',  category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-011', title: 'Cloud Computing Policy',                                  category: 'it',         documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-012', title: 'IP and Copyright Compliance Policy',                      category: 'compliance', documentType: 'policy', owner: 'Legal' },
  { code: 'WP-POL-013', title: 'Records Retention and Protection Policy',                 category: 'compliance', documentType: 'policy', owner: 'Data Protection Office' },
  { code: 'WP-POL-014', title: 'Teleworking Policy',                                      category: 'hr',         documentType: 'policy', owner: 'Human Resources' },
  { code: 'WP-POL-015', title: 'Physical Security Policy',                                category: 'security',   documentType: 'policy', owner: 'Physical Security' },
  { code: 'WP-POL-016', title: 'Clear Desk Clear Screen Policy',                          category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-017', title: 'Mobile Device Policy',                                    category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-018', title: 'Data Leakage Prevention Policy',                          category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-019', title: 'Backup Policy',                                           category: 'it',         documentType: 'policy', owner: 'IT Operations' },
  { code: 'WP-POL-020', title: 'Availability Management Policy',                          category: 'it',         documentType: 'policy', owner: 'IT Operations' },
  { code: 'WP-POL-021', title: 'Network Security Policy',                                 category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-022', title: 'Cryptographic Policy',                                    category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-023', title: 'Anti-Malware Policy',                                     category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-024', title: 'Technical Vulnerability Management Policy',               category: 'security',   documentType: 'policy', owner: 'IT Security' },
  { code: 'WP-POL-025', title: 'Data Retention and Deletion Policy',                      category: 'compliance', documentType: 'policy', owner: 'Data Protection Office' },
  { code: 'WP-POL-026', title: 'Cookie and Tracking Consent Notice Policy',               category: 'compliance', documentType: 'policy', owner: 'Data Protection Office' },
  { code: 'WP-POL-027', title: 'Human Resources Security Policy',                         category: 'hr',         documentType: 'policy', owner: 'Human Resources' },

  // ---------- Documents / Guidelines (WP-DOC) ----------
  { code: 'WP-DOC-001', title: 'Integrated Quality Manual',                                          category: 'quality',    documentType: 'document',   owner: 'Quality Management' },
  { code: 'WP-DOC-002', title: 'Information Security Roles, Responsibilities and Authorities',      category: 'security',   documentType: 'document',   owner: 'IT Security' },
  { code: 'WP-DOC-003', title: 'Information Security Objectives and Plan',                           category: 'security',   documentType: 'document',   owner: 'IT Security' },
  { code: 'WP-DOC-004', title: 'AI Adoption Guidelines',                                             category: 'governance', documentType: 'guideline',  owner: 'Quality Management' },
  { code: 'WP-DOC-005', title: 'Segregation of Duties Guidelines',                                   category: 'governance', documentType: 'guideline',  owner: 'Quality Management' },
  { code: 'WP-DOC-006', title: 'Information Security Guidelines for Project Management',            category: 'security',   documentType: 'guideline',  owner: 'IT Security' },
  { code: 'WP-DOC-007', title: 'Physical Security Design Standards',                                 category: 'security',   documentType: 'document',   owner: 'Physical Security' },
  { code: 'WP-DOC-008', title: 'Accountability Framework',                                           category: 'governance', documentType: 'document',   owner: 'Quality Management' },
  { code: 'WP-DOC-009', title: 'Data Anonymization and Pseudonymization Guidelines',                 category: 'compliance', documentType: 'guideline',  owner: 'Data Protection Office' },
  { code: 'WP-DOC-010', title: 'Employment Contract Security and Data Protection Guidelines',       category: 'hr',         documentType: 'guideline',  owner: 'Human Resources' },
  { code: 'WP-DOC-011', title: 'Password and Authentication Standard',                               category: 'security',   documentType: 'document',   owner: 'IT Security' },
  { code: 'WP-DOC-012', title: 'Remote Access Standard',                                             category: 'security',   documentType: 'document',   owner: 'IT Security' },
  { code: 'WP-DOC-013', title: 'Secure Systems Engineering Principles',                              category: 'security',   documentType: 'document',   owner: 'IT Security' },
  { code: 'WP-DOC-014', title: 'Data Protection Officer Appointment Letter',                        category: 'compliance', documentType: 'document',   owner: 'Executive' },
  { code: 'WP-DOC-015', title: 'DPIA – Employee Background Screening',                               category: 'hr',         documentType: 'document',   owner: 'Data Protection Office' },
  { code: 'WP-DOC-016', title: 'DPIA – Customer Profiling and Analytics',                            category: 'compliance', documentType: 'document',   owner: 'Data Protection Office' },
  { code: 'WP-DOC-017', title: 'Transfer Risk Assessment – Freshworks',                              category: 'compliance', documentType: 'document',   owner: 'Data Protection Office' },
  { code: 'WP-DOC-018', title: 'Transfer Risk Assessment – Zoho',                                    category: 'compliance', documentType: 'document',   owner: 'Data Protection Office' },
  { code: 'WP-DOC-019', title: 'Transfer Risk Assessment – Five9',                                   category: 'compliance', documentType: 'document',   owner: 'Data Protection Office' },
  { code: 'WP-DOC-020', title: 'Transfer Risk Assessment – Google Analytics',                        category: 'compliance', documentType: 'document',   owner: 'Data Protection Office' },
  { code: 'WP-DOC-021', title: 'IT Privacy Feature Requirements',                                    category: 'it',         documentType: 'document',   owner: 'IT Security' },

  // ---------- SOPs (WP-SOP) ----------
  { code: 'WP-SOP-001', title: 'Consent Lifecycle Management and Withdrawal Process',                category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-002', title: 'Data Lawful Basis Assessment Process',                               category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-003', title: 'Data Subject Rights, Accuracy and Correction Process',               category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-004', title: 'Data Collection Governance and DPIA Process',                       category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-005', title: 'Supplier and Processor Due Diligence and DPA Management Process',   category: 'compliance', documentType: 'sop', owner: 'Procurement' },
  { code: 'WP-SOP-006', title: 'RoPA Management Process',                                            category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-007', title: 'User Access Management Process',                                     category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-008', title: 'Compliance Monitoring and Measurement Process',                     category: 'compliance', documentType: 'sop', owner: 'Quality Management' },
  { code: 'WP-SOP-009', title: 'Nonconformity, Violation and Corrective Action Process',            category: 'quality',    documentType: 'sop', owner: 'Quality Management' },
  { code: 'WP-SOP-010', title: 'Inspection and Regulatory Response Process',                        category: 'compliance', documentType: 'sop', owner: 'Legal' },
  { code: 'WP-SOP-011', title: 'Automated Decision and Processing Process',                         category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-012', title: 'Privacy by Design Process',                                         category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-013', title: 'Data Retention and Secure Destruction Process',                    category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-014', title: 'Data Disclosure and Transfer Process',                             category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-015', title: 'Information Security Incident Response Process',                   category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-016', title: 'Risk Assessment and Treatment Process',                            category: 'governance', documentType: 'sop', owner: 'Risk Management' },
  { code: 'WP-SOP-017', title: 'Information Security Competence Development Process',              category: 'hr',         documentType: 'sop', owner: 'Human Resources' },
  { code: 'WP-SOP-018', title: 'Information Security Communication Program',                       category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-019', title: 'Control of Documented Information Process',                        category: 'quality',    documentType: 'sop', owner: 'Quality Management' },
  { code: 'WP-SOP-020', title: 'Supplier Information Security Evaluation Process',                 category: 'security',   documentType: 'sop', owner: 'Procurement' },
  { code: 'WP-SOP-021', title: 'Management Review Process',                                        category: 'governance', documentType: 'sop', owner: 'Executive' },
  { code: 'WP-SOP-022', title: 'Internal Audit Process',                                           category: 'quality',    documentType: 'sop', owner: 'Quality Management' },
  { code: 'WP-SOP-023', title: 'Asset Handling Process',                                           category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-024', title: 'Information Classification Process',                               category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-025', title: 'Information Transfer Process',                                     category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-026', title: 'Business Continuity Incident Response Process',                    category: 'operational',documentType: 'sop', owner: 'Business Continuity' },
  { code: 'WP-SOP-027', title: 'Regulatory and Contractual Requirements Process',                  category: 'compliance', documentType: 'sop', owner: 'Legal' },
  { code: 'WP-SOP-028', title: 'Threat Intelligence Process',                                      category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-029', title: 'Employee Screening Process',                                       category: 'hr',         documentType: 'sop', owner: 'Human Resources' },
  { code: 'WP-SOP-030', title: 'Employee Disciplinary Process',                                    category: 'hr',         documentType: 'sop', owner: 'Human Resources' },
  { code: 'WP-SOP-031', title: 'Procedure for Working in Secure Areas',                            category: 'security',   documentType: 'sop', owner: 'Physical Security' },
  { code: 'WP-SOP-032', title: 'Removable Media Management Process',                               category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-033', title: 'Taking Assets Offsite Process',                                    category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-034', title: 'Monitoring of IT Systems Process',                                 category: 'it',         documentType: 'sop', owner: 'IT Operations' },
  { code: 'WP-SOP-035', title: 'Change Management Process',                                        category: 'it',         documentType: 'sop', owner: 'IT Operations' },
  { code: 'WP-SOP-036', title: 'Technical Vulnerability Assessment Process',                       category: 'security',   documentType: 'sop', owner: 'IT Security' },
  { code: 'WP-SOP-037', title: 'Data Masking Process',                                             category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-038', title: 'Controller Accountability and SDAIA Registration Process',        category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },
  { code: 'WP-SOP-039', title: 'Personal Data Breach Response Process',                            category: 'compliance', documentType: 'sop', owner: 'Data Protection Office' },

  // ---------- Forms (WP-FORM) — includes the AI Tool Approval Checklist directly relevant to HITL gate ----------
  { code: 'WP-FORM-001', title: 'Statement of Applicability',                                      category: 'compliance', documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-002', title: 'Risk Assessment and Treatment Workbook',                         category: 'governance', documentType: 'form', owner: 'Risk Management' },
  { code: 'WP-FORM-003', title: 'Competence Development Questionnaire',                            category: 'hr',         documentType: 'form', owner: 'Human Resources' },
  { code: 'WP-FORM-004', title: 'Data Processing Addendum (DPA)',                                  category: 'compliance', documentType: 'form', owner: 'Legal' },
  { code: 'WP-FORM-005', title: 'Record of Processing Activities (RoPA) Register',                category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-006', title: 'Data Lawful Basis Assessment Form',                               category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-007', title: 'Data Lawful Basis Decision Matrix',                              category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-008', title: 'Supplier Due Diligence Assessment Form',                         category: 'compliance', documentType: 'form', owner: 'Procurement' },
  { code: 'WP-FORM-009', title: 'Processor Register Template',                                    category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-010', title: 'DPA Checklist',                                                   category: 'compliance', documentType: 'form', owner: 'Legal' },
  { code: 'WP-FORM-011', title: 'Cross-Border Transfer Risk Assessment Template',                 category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-012', title: 'Automated Processing Identification Checklist',                  category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-013', title: 'Automated Decision Risk Assessment Template',                    category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-014', title: 'Access Request Form',                                             category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-015', title: 'Access Review Checklist',                                         category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-016', title: 'User Access List',                                                category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-017', title: 'DSAR Deletion and Compliance Template',                           category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-018', title: 'Business Continuity Test Plan',                                   category: 'operational',documentType: 'form', owner: 'Business Continuity' },
  { code: 'WP-FORM-019', title: 'Business Continuity Test Report',                                 category: 'operational',documentType: 'form', owner: 'Business Continuity' },
  { code: 'WP-FORM-020', title: 'Supplier Information Security Agreement',                         category: 'security',   documentType: 'form', owner: 'Procurement' },
  { code: 'WP-FORM-021', title: 'Acceptance Testing Checklist',                                    category: 'quality',    documentType: 'form', owner: 'Quality Management' },
  { code: 'WP-FORM-022', title: 'Non-Disclosure Agreement',                                        category: 'compliance', documentType: 'form', owner: 'Legal' },
  { code: 'WP-FORM-023', title: 'Cross-Border Transfer Request Form',                              category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-024', title: 'PDPL Self-Assessment Questionnaire',                              category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-025', title: 'Vendor/Third-Party Risk Assessment Tracker',                     category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-026', title: 'Authorities and Specialist Group Contacts Register',             category: 'governance', documentType: 'form', owner: 'Compliance' },
  { code: 'WP-FORM-027', title: 'Cybersecurity & ISMS Compliance Tracker',                        category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-028', title: 'Third-Party Security Controls Assessment',                       category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-029', title: 'Employment Contract Clause Verification Checklist',              category: 'hr',         documentType: 'form', owner: 'Human Resources' },
  { code: 'WP-FORM-030', title: 'Personal Data Breach Notification Template',                     category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-031', title: 'Cross-Border Transfer Register',                                  category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-032', title: 'Training and Awareness Record',                                   category: 'hr',         documentType: 'form', owner: 'Human Resources' },
  { code: 'WP-FORM-033', title: 'Compliance Monitoring Dashboard',                                 category: 'compliance', documentType: 'form', owner: 'Quality Management' },
  { code: 'WP-FORM-034', title: 'Consent Register',                                                category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-035', title: 'DSR Request Register',                                            category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-036', title: 'Personal Data Breach Register',                                   category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-037', title: 'DPIA Register',                                                   category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-038', title: 'Regulatory Disclosure Register',                                  category: 'compliance', documentType: 'form', owner: 'Legal' },
  { code: 'WP-FORM-039', title: 'DPIA Screening Questionnaire',                                    category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-040', title: 'Parental/Guardian Consent Form',                                 category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-041', title: 'Consent Withdrawal Request Form',                                 category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-042', title: 'Privacy Notice Acknowledgment – Employee Form',                   category: 'hr',         documentType: 'form', owner: 'Human Resources' },
  { code: 'WP-FORM-043', title: 'RoPA Attestation and Verification Form',                          category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-044', title: 'AI Tool Approval Checklist',                                      category: 'governance', documentType: 'form', owner: 'Quality Management' },
  { code: 'WP-FORM-045', title: 'Project Security Checkpoint Checklist',                          category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-046', title: 'Physical Security Assessment Checklist',                         category: 'security',   documentType: 'form', owner: 'Physical Security' },
  { code: 'WP-FORM-047', title: 'Segregation of Duties Assessment Form',                          category: 'governance', documentType: 'form', owner: 'Quality Management' },
  { code: 'WP-FORM-048', title: 'Password Policy Compliance Checklist',                           category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-049', title: 'Remote Access Request and Approval Form',                        category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-050', title: 'Secure Design Review Checklist',                                  category: 'security',   documentType: 'form', owner: 'IT Security' },
  { code: 'WP-FORM-051', title: 'Data Anonymization Assessment Form',                              category: 'compliance', documentType: 'form', owner: 'Data Protection Office' },
  { code: 'WP-FORM-052', title: 'Management Review Meeting Pack',                                  category: 'governance', documentType: 'form', owner: 'Executive' },
  { code: 'WP-FORM-053', title: 'Internal Audit Checklist',                                        category: 'quality',    documentType: 'form', owner: 'Quality Management' },
  { code: 'WP-FORM-054', title: 'Employee Privacy Acknowledgment Tracker',                         category: 'hr',         documentType: 'form', owner: 'Human Resources' },

  // ---------- Security Controls (WP-CTL) ----------
  { code: 'WP-CTL-001', title: 'Kaspersky Endpoint Detection and Response',                        category: 'security', documentType: 'control', owner: 'IT Security' },
  { code: 'WP-CTL-002', title: 'Elastic SIEM',                                                     category: 'security', documentType: 'control', owner: 'IT Security' },
  { code: 'WP-CTL-003', title: 'Rapid7 Endpoint Detection and Response',                           category: 'security', documentType: 'control', owner: 'IT Security' },
  { code: 'WP-CTL-004', title: 'Cloudflare Data Loss Prevention',                                  category: 'security', documentType: 'control', owner: 'IT Security' },
  { code: 'WP-CTL-005', title: 'Resecurity Dark Web Monitoring',                                   category: 'security', documentType: 'control', owner: 'IT Security' },
  { code: 'WP-CTL-006', title: 'SonarQube Static Application Security Testing',                    category: 'security', documentType: 'control', owner: 'IT Security' },
];

/**
 * Idempotent seed. Call once at server boot (after initPolicyTables()).
 * Only inserts rows that don't exist; does not overwrite user edits.
 * Returns { inserted, skipped } for logging.
 */
export async function seedControlledDocumentRegistry(): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;

  // Use a single transaction so a failure mid-way doesn't leave us half-seeded.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const doc of SEED_DOCUMENTS) {
      const res = await client.query(
        `INSERT INTO policies (
          policy_number, title, description, category, version, status,
          owner_department, document_type, document_number, created_by
        ) VALUES ($1, $2, $3, $4, '1.0', 'draft', $5, $6, $1, 'ControlledDocSeeder')
        ON CONFLICT (policy_number) DO NOTHING
        RETURNING id`,
        [
          doc.code,
          doc.title,
          `Controlled document (${doc.code}) — pending file upload. ` +
          `Seeded from WalaPlus coded-and-controlled document set. ` +
          `Upload the approved version via the Policy Governance UI.`,
          doc.category,
          doc.owner,
          doc.documentType,
        ]
      );
      if (res.rowCount && res.rowCount > 0) inserted++;
      else skipped++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (inserted > 0) {
    console.log(`[ControlledDocSeeder] Inserted ${inserted} coded documents (${skipped} already present)`);
  } else {
    console.log(`[ControlledDocSeeder] All ${skipped} coded documents already present`);
  }
  return { inserted, skipped };
}

/**
 * Resolves a WP document code to the current policy row. Used by the
 * approval-card UI to build clickable links.
 */
export async function resolveControlledDocument(code: string): Promise<{
  id: number;
  policy_number: string;
  title: string;
  version: string;
  status: string;
  file_path: string | null;
  has_file: boolean;
} | null> {
  const res = await pool.query(
    `SELECT id, policy_number, title, version, status, file_path
       FROM policies
      WHERE policy_number = $1
      LIMIT 1`,
    [code]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return { ...row, has_file: !!row.file_path };
}

/**
 * Batch resolver for a list of codes — used by the approval API to
 * enrich every pending action's compliance refs in one query.
 */
export async function resolveControlledDocuments(codes: string[]): Promise<Record<string, {
  id: number;
  title: string;
  version: string;
  has_file: boolean;
}>> {
  if (codes.length === 0) return {};
  const res = await pool.query(
    `SELECT id, policy_number, title, version, file_path
       FROM policies
      WHERE policy_number = ANY($1)`,
    [codes]
  );
  const out: Record<string, any> = {};
  for (const row of res.rows) {
    out[row.policy_number] = {
      id: row.id,
      title: row.title,
      version: row.version,
      has_file: !!row.file_path,
    };
  }
  return out;
}

export { SEED_DOCUMENTS };
