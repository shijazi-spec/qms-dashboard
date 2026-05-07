/**
 * ISO/IEC 27001:2022 obligation catalogue seed (104 items).
 *
 * Coverage:
 *   - 11 ISMS clauses (sections 4-10 of the main standard)
 *   - 93 Annex A controls organised in 4 themes:
 *       A.5 Organizational Controls   (37 controls)
 *       A.6 People Controls           (8 controls)
 *       A.7 Physical Controls         (14 controls)
 *       A.8 Technological Controls    (34 controls)
 *
 * Source: ISO/IEC 27001:2022 (October 2022). Descriptions are
 * paraphrased summaries — not verbatim ISO text — suitable for the
 * dashboard. Compliance officers can edit any row via the standard
 * obligations UI.
 */

import type { Pool } from "pg";
import { runFrameworkSeed, type ObligationDef } from "./obligationSeedTypes";

export const ISO27001_OBLIGATION_DEFINITIONS: ObligationDef[] = [
  // ──────────────────────────────────────────────────────────────────────
  // Main standard clauses 4-10 (the management system itself)
  // ──────────────────────────────────────────────────────────────────────
  {
    code: "ISO27001-4",
    clause: "Cl. 4",
    domain: "Context of the Organization",
    order: 1,
    title: "Context of the Organization",
    desc: "Determine internal and external issues, interested parties and their requirements, and the scope of the ISMS.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "ISMS / GRC",
    evidence: "Documented ISMS scope, context analysis, stakeholder register.",
  },
  {
    code: "ISO27001-5",
    clause: "Cl. 5",
    domain: "Leadership",
    order: 2,
    title: "Leadership and Commitment",
    desc: "Top management demonstrates leadership for the ISMS, establishes information security policy, assigns roles, responsibilities and authorities.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "Executive Management",
    evidence: "Approved information security policy, RACI / org chart, management review minutes.",
  },
  {
    code: "ISO27001-6",
    clause: "Cl. 6",
    domain: "Planning",
    order: 3,
    title: "Planning — Risks, Opportunities and Objectives",
    desc: "Plan actions to address risks and opportunities, establish information security objectives, and plan changes to the ISMS.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "ISMS / GRC",
    evidence: "Risk assessment methodology, risk register, risk treatment plan, Statement of Applicability, security objectives plan.",
  },
  {
    code: "ISO27001-7",
    clause: "Cl. 7",
    domain: "Support",
    order: 4,
    title: "Support — Resources, Competence, Awareness, Communication, Documented Information",
    desc: "Provide resources, ensure competence, raise awareness, define communication and control documented information for the ISMS.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "continuous",
    priority: "high",
    dept: "ISMS / HR",
    evidence: "Training records, competence matrix, communication plan, document control procedure.",
  },
  {
    code: "ISO27001-8",
    clause: "Cl. 8",
    domain: "Operation",
    order: 5,
    title: "Operation — Operational Planning, Risk Assessment and Treatment",
    desc: "Plan, implement and control processes; perform risk assessments at planned intervals or when significant changes occur; implement risk treatment plan.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "ISMS / IT Security",
    evidence: "Operational procedures, risk assessment reports, risk treatment status.",
  },
  {
    code: "ISO27001-9",
    clause: "Cl. 9",
    domain: "Performance Evaluation",
    order: 6,
    title: "Performance Evaluation — Monitoring, Internal Audit, Management Review",
    desc: "Monitor, measure, analyse and evaluate ISMS performance; conduct internal audits at planned intervals; perform management reviews.",
    type: "mandatory",
    ctrl: "detective",
    freq: "quarterly",
    priority: "critical",
    dept: "Internal Audit / ISMS",
    evidence: "Monitoring KPIs, internal audit programme and reports, management review minutes.",
  },
  {
    code: "ISO27001-10",
    clause: "Cl. 10",
    domain: "Improvement",
    order: 7,
    title: "Improvement — Continual Improvement, Nonconformity and Corrective Action",
    desc: "Continually improve the ISMS; address nonconformities and take corrective action.",
    type: "mandatory",
    ctrl: "corrective",
    freq: "continuous",
    priority: "high",
    dept: "ISMS / Quality",
    evidence: "CAPA register, corrective action records, improvement plan.",
  },
  {
    code: "ISO27001-SOA",
    clause: "Cl. 6.1.3 d)",
    domain: "Planning",
    order: 8,
    title: "Statement of Applicability (SoA)",
    desc: "Produce and maintain a Statement of Applicability that documents the necessary controls, justification for inclusion or exclusion, and implementation status.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "ISMS / GRC",
    evidence: "Approved SoA showing every Annex A control with justification.",
  },
  {
    code: "ISO27001-RTP",
    clause: "Cl. 6.1.3 e)",
    domain: "Planning",
    order: 9,
    title: "Risk Treatment Plan",
    desc: "Formulate, document and approve a risk treatment plan with owners, treatment options and target completion dates.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "critical",
    dept: "ISMS / GRC",
    evidence: "Approved risk treatment plan with owner, deadline and status per risk.",
  },
  {
    code: "ISO27001-OBJ",
    clause: "Cl. 6.2",
    domain: "Planning",
    order: 10,
    title: "Information Security Objectives",
    desc: "Establish measurable information security objectives at relevant functions and levels, with plans to achieve them.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "annual",
    priority: "high",
    dept: "ISMS / Executive",
    evidence: "Documented objectives with KPIs, owners and target dates.",
  },
  {
    code: "ISO27001-DOC",
    clause: "Cl. 7.5",
    domain: "Support",
    order: 11,
    title: "Documented Information Control",
    desc: "Control documented information required by the ISMS — creation, update, distribution, access, retrieval, retention and disposition.",
    type: "mandatory",
    ctrl: "preventive",
    freq: "continuous",
    priority: "high",
    dept: "ISMS / Document Control",
    evidence: "Document control procedure, master list of documents, version control.",
  },

  // ──────────────────────────────────────────────────────────────────────
  // Annex A.5 — Organizational Controls (37)
  // ──────────────────────────────────────────────────────────────────────
  ...A5(),
  // Annex A.6 — People Controls (8)
  ...A6(),
  // Annex A.7 — Physical Controls (14)
  ...A7(),
  // Annex A.8 — Technological Controls (34)
  ...A8(),
];

function ann(
  code: string,
  clause: string,
  domain: string,
  order: number,
  title: string,
  desc: string,
  ctrl: ObligationDef["ctrl"],
  freq: ObligationDef["freq"],
  priority: ObligationDef["priority"],
  dept: string,
  evidence?: string,
): ObligationDef {
  return {
    code,
    clause,
    domain,
    order,
    title,
    desc,
    type: "mandatory",
    ctrl,
    freq,
    priority,
    dept,
    evidence,
  };
}

function A5(): ObligationDef[] {
  const D = "A.5 Organizational";
  let i = 100;
  return [
    ann("ISO27001-A.5.1", "A.5.1", D, ++i, "Policies for information security", "Define, approve, publish, communicate and review at planned intervals an information security policy and topic-specific policies.", "preventive", "annual", "critical", "CISO Office", "Approved policy with version, review date, communication evidence."),
    ann("ISO27001-A.5.2", "A.5.2", D, ++i, "Information security roles and responsibilities", "Define and allocate information security responsibilities according to organisational needs.", "preventive", "annual", "critical", "ISMS / HR", "RACI matrix, role descriptions, org chart."),
    ann("ISO27001-A.5.3", "A.5.3", D, ++i, "Segregation of duties", "Conflicting duties and conflicting areas of responsibility shall be segregated.", "preventive", "annual", "high", "ISMS / IT", "Documented duties matrix; toxic-combination check."),
    ann("ISO27001-A.5.4", "A.5.4", D, ++i, "Management responsibilities", "Management requires personnel and contractors to apply information security according to policies and procedures.", "preventive", "continuous", "high", "All Managers", "Code of conduct, manager attestations."),
    ann("ISO27001-A.5.5", "A.5.5", D, ++i, "Contact with authorities", "Maintain contact with relevant authorities (regulators, law enforcement, CERT).", "preventive", "annual", "medium", "Legal / CISO", "Contact list with up-to-date numbers; last-tested date."),
    ann("ISO27001-A.5.6", "A.5.6", D, ++i, "Contact with special interest groups", "Maintain contact with special interest groups, security forums and professional associations.", "preventive", "annual", "low", "CISO Office", "Membership records, threat-intel feed list."),
    ann("ISO27001-A.5.7", "A.5.7", D, ++i, "Threat intelligence", "Collect and analyse information related to information security threats; produce actionable intelligence.", "detective", "continuous", "high", "SOC / CTI", "Threat intel feed sources, analyst reports."),
    ann("ISO27001-A.5.8", "A.5.8", D, ++i, "Information security in project management", "Integrate information security into project management.", "preventive", "event_driven", "high", "PMO / CISO", "Security checkpoints in PM lifecycle, sign-off records."),
    ann("ISO27001-A.5.9", "A.5.9", D, ++i, "Inventory of information and other associated assets", "Develop and maintain an inventory of information and other associated assets, including owners.", "preventive", "quarterly", "high", "IT Asset Mgmt", "Asset register with owner, classification, location."),
    ann("ISO27001-A.5.10", "A.5.10", D, ++i, "Acceptable use of information and other associated assets", "Identify, document and implement rules for the acceptable use of assets.", "preventive", "annual", "medium", "ISMS / HR", "Acceptable Use Policy, employee acknowledgements."),
    ann("ISO27001-A.5.11", "A.5.11", D, ++i, "Return of assets", "Personnel and other interested parties return all organisational assets in their possession upon change or termination of their employment, contract or agreement.", "preventive", "event_driven", "medium", "HR / IT", "Termination checklist, returned-assets log."),
    ann("ISO27001-A.5.12", "A.5.12", D, ++i, "Classification of information", "Classify information according to value, criticality and sensitivity.", "preventive", "annual", "high", "Data Owners / ISMS", "Classification scheme, classified asset register."),
    ann("ISO27001-A.5.13", "A.5.13", D, ++i, "Labelling of information", "Develop and implement an appropriate set of procedures for information labelling.", "preventive", "continuous", "medium", "Data Owners", "Labelling procedure, sample labelled documents."),
    ann("ISO27001-A.5.14", "A.5.14", D, ++i, "Information transfer", "Information transfer rules, procedures or agreements shall be in place for all types of transfer.", "preventive", "continuous", "high", "IT Security", "Transfer policy, encryption-in-transit records, NDAs."),
    ann("ISO27001-A.5.15", "A.5.15", D, ++i, "Access control", "Establish and implement rules to control physical and logical access to information and other associated assets based on business and information security requirements.", "preventive", "quarterly", "critical", "IT Security", "Access Control Policy, role-based authorisation matrix."),
    ann("ISO27001-A.5.16", "A.5.16", D, ++i, "Identity management", "Manage the full life cycle of identities.", "preventive", "continuous", "critical", "IAM Team", "Joiner-mover-leaver process, identity register."),
    ann("ISO27001-A.5.17", "A.5.17", D, ++i, "Authentication information", "Allocation and management of authentication information shall be controlled by a management process.", "preventive", "continuous", "critical", "IAM Team", "Password policy, MFA enrolment, secret-vault usage."),
    ann("ISO27001-A.5.18", "A.5.18", D, ++i, "Access rights", "Provision, review, modify and remove access rights to information and other associated assets in accordance with the access control policy.", "detective", "quarterly", "critical", "IT Security", "Quarterly access reviews with owner sign-off."),
    ann("ISO27001-A.5.19", "A.5.19", D, ++i, "Information security in supplier relationships", "Define processes and procedures to manage the information security risks associated with supplier products and services.", "preventive", "annual", "high", "Procurement / GRC", "Supplier risk register, vendor security questionnaire."),
    ann("ISO27001-A.5.20", "A.5.20", D, ++i, "Addressing information security within supplier agreements", "Establish and agree relevant information security requirements with each supplier based on the type of supplier relationship.", "preventive", "annual", "high", "Procurement / Legal", "Supplier contract template with security clauses."),
    ann("ISO27001-A.5.21", "A.5.21", D, ++i, "Managing information security in the ICT supply chain", "Define and implement processes to manage information security risks associated with the ICT products and services supply chain.", "preventive", "annual", "high", "Procurement / IT", "ICT supply-chain risk assessment, SBOM where applicable."),
    ann("ISO27001-A.5.22", "A.5.22", D, ++i, "Monitoring, review and change management of supplier services", "Regularly monitor, review, evaluate and manage change in supplier information security practices and service delivery.", "detective", "annual", "medium", "Vendor Mgmt", "Quarterly supplier review minutes, SLA reports."),
    ann("ISO27001-A.5.23", "A.5.23", D, ++i, "Information security for use of cloud services", "Establish processes for acquisition, use, management and exit from cloud services.", "preventive", "annual", "critical", "IT / Procurement", "Cloud usage register, exit strategy per service, shared-responsibility matrix."),
    ann("ISO27001-A.5.24", "A.5.24", D, ++i, "Information security incident management planning and preparation", "Plan and prepare for managing information security incidents by defining, establishing and communicating processes, roles and responsibilities.", "preventive", "annual", "critical", "CISO / SOC", "Incident response plan, runbooks, IR org chart."),
    ann("ISO27001-A.5.25", "A.5.25", D, ++i, "Assessment and decision on information security events", "Assess information security events and decide whether they should be categorised as information security incidents.", "detective", "continuous", "high", "SOC", "Event triage procedure, incident-vs-event log."),
    ann("ISO27001-A.5.26", "A.5.26", D, ++i, "Response to information security incidents", "Respond to information security incidents in accordance with the documented procedures.", "corrective", "event_driven", "critical", "IRT", "Incident tickets with timeline, post-incident reports."),
    ann("ISO27001-A.5.27", "A.5.27", D, ++i, "Learning from information security incidents", "Use knowledge gained from information security incidents to strengthen and improve the information security controls.", "corrective", "continuous", "high", "CISO Office", "Lessons-learned register, control updates linked to incidents."),
    ann("ISO27001-A.5.28", "A.5.28", D, ++i, "Collection of evidence", "Establish and implement procedures for the identification, collection, acquisition and preservation of information that can serve as evidence.", "detective", "event_driven", "high", "Forensics / Legal", "Forensic procedure, chain-of-custody templates."),
    ann("ISO27001-A.5.29", "A.5.29", D, ++i, "Information security during disruption", "Plan how to maintain information security at an appropriate level during disruption.", "preventive", "annual", "high", "BCM / CISO", "BCP including security controls during disruption."),
    ann("ISO27001-A.5.30", "A.5.30", D, ++i, "ICT readiness for business continuity", "Plan, implement, maintain and test ICT readiness based on business continuity objectives and ICT continuity requirements.", "preventive", "annual", "critical", "IT BCM", "DR plan, RTO/RPO matrix, DR test reports."),
    ann("ISO27001-A.5.31", "A.5.31", D, ++i, "Legal, statutory, regulatory and contractual requirements", "Identify, document and keep up to date all legal, statutory, regulatory and contractual requirements relevant to information security.", "preventive", "quarterly", "critical", "Legal / GRC", "Regulatory obligations register; legal review log."),
    ann("ISO27001-A.5.32", "A.5.32", D, ++i, "Intellectual property rights", "Implement appropriate procedures to protect intellectual property rights.", "preventive", "annual", "medium", "Legal / IT", "IPR policy, software licence inventory."),
    ann("ISO27001-A.5.33", "A.5.33", D, ++i, "Protection of records", "Protect records from loss, destruction, falsification, unauthorised access and unauthorised release.", "preventive", "continuous", "high", "Records Mgmt / IT", "Records retention schedule, archive controls."),
    ann("ISO27001-A.5.34", "A.5.34", D, ++i, "Privacy and protection of PII", "Identify and meet the requirements regarding the preservation of privacy and protection of personally identifiable information (PII).", "preventive", "continuous", "critical", "DPO / Legal", "Privacy policy, ROPA, PIA records."),
    ann("ISO27001-A.5.35", "A.5.35", D, ++i, "Independent review of information security", "Independently review the organisation's approach to managing information security and its implementation at planned intervals.", "detective", "annual", "high", "Internal Audit", "Annual independent ISMS audit report."),
    ann("ISO27001-A.5.36", "A.5.36", D, ++i, "Compliance with policies, rules and standards for information security", "Regularly review compliance of information processing and procedures with the organisation's information security policies, rules and standards.", "detective", "quarterly", "high", "ISMS / Internal Audit", "Compliance review checklist, exception log."),
    ann("ISO27001-A.5.37", "A.5.37", D, ++i, "Documented operating procedures", "Document operating procedures for information processing facilities and make them available to personnel who need them.", "preventive", "continuous", "medium", "IT Operations", "Operations runbook library, version-controlled."),
  ];
}

function A6(): ObligationDef[] {
  const D = "A.6 People";
  let i = 200;
  return [
    ann("ISO27001-A.6.1", "A.6.1", D, ++i, "Screening", "Conduct background verification checks on all candidates for employment in accordance with applicable laws, regulations and ethics, and proportional to the business requirements.", "preventive", "event_driven", "high", "HR", "Pre-employment screening records."),
    ann("ISO27001-A.6.2", "A.6.2", D, ++i, "Terms and conditions of employment", "Employment contractual agreements state the personnel's and the organisation's responsibilities for information security.", "preventive", "event_driven", "high", "HR / Legal", "Employment contract with security clauses."),
    ann("ISO27001-A.6.3", "A.6.3", D, ++i, "Information security awareness, education and training", "Personnel and relevant interested parties receive appropriate information security awareness, education and training, and regular updates.", "preventive", "continuous", "high", "HR / CISO", "Training records, completion rates, phishing-test results."),
    ann("ISO27001-A.6.4", "A.6.4", D, ++i, "Disciplinary process", "A formal and communicated disciplinary process is in place to take action against personnel and other relevant interested parties who have committed an information security policy violation.", "corrective", "event_driven", "medium", "HR / Legal", "Disciplinary procedure, sanction log."),
    ann("ISO27001-A.6.5", "A.6.5", D, ++i, "Responsibilities after termination or change of employment", "Information security responsibilities and duties that remain valid after termination or change of employment are defined, enforced and communicated to personnel and other interested parties.", "preventive", "event_driven", "medium", "HR", "Termination checklist with NDA reaffirmation."),
    ann("ISO27001-A.6.6", "A.6.6", D, ++i, "Confidentiality or non-disclosure agreements", "Confidentiality or non-disclosure agreements reflecting the organisation's needs for the protection of information are identified, documented, regularly reviewed and signed.", "preventive", "annual", "high", "Legal / HR", "Signed NDAs on file with review date."),
    ann("ISO27001-A.6.7", "A.6.7", D, ++i, "Remote working", "Implement security measures when personnel are working remotely to protect information accessed, processed or stored outside the organisation's premises.", "preventive", "annual", "high", "IT Security", "Remote-work policy, endpoint encryption, VPN/MFA enforcement."),
    ann("ISO27001-A.6.8", "A.6.8", D, ++i, "Information security event reporting", "Provide a mechanism for personnel to report observed or suspected information security events through appropriate channels in a timely manner.", "detective", "continuous", "high", "CISO / SOC", "Reporting hotline / portal, awareness materials, response SLAs."),
  ];
}

function A7(): ObligationDef[] {
  const D = "A.7 Physical";
  let i = 300;
  return [
    ann("ISO27001-A.7.1", "A.7.1", D, ++i, "Physical security perimeters", "Define and use security perimeters to protect areas that contain information and other associated assets.", "preventive", "annual", "high", "Facilities / Security", "Site security plan, perimeter inspection logs."),
    ann("ISO27001-A.7.2", "A.7.2", D, ++i, "Physical entry", "Protect secure areas by appropriate entry controls and access points.", "preventive", "continuous", "high", "Facilities / Security", "Access-card system logs, visitor register."),
    ann("ISO27001-A.7.3", "A.7.3", D, ++i, "Securing offices, rooms and facilities", "Design and implement physical security for offices, rooms and facilities.", "preventive", "annual", "medium", "Facilities", "Site walk-through reports."),
    ann("ISO27001-A.7.4", "A.7.4", D, ++i, "Physical security monitoring", "Continuously monitor premises for unauthorised physical access.", "detective", "continuous", "high", "Security Ops", "CCTV / alarm logs, intrusion test reports."),
    ann("ISO27001-A.7.5", "A.7.5", D, ++i, "Protecting against physical and environmental threats", "Design and implement protection against physical and environmental threats such as natural disasters and other intentional or unintentional physical threats to infrastructure.", "preventive", "annual", "high", "Facilities / BCM", "Threat assessment, fire / flood / power protections."),
    ann("ISO27001-A.7.6", "A.7.6", D, ++i, "Working in secure areas", "Design and implement security measures for working in secure areas.", "preventive", "annual", "medium", "Facilities", "Secure-area procedure."),
    ann("ISO27001-A.7.7", "A.7.7", D, ++i, "Clear desk and clear screen", "Define and enforce clear-desk and clear-screen rules for documents and other assets containing information.", "preventive", "continuous", "medium", "All Staff", "Walk-through audit reports, screensaver lock policy."),
    ann("ISO27001-A.7.8", "A.7.8", D, ++i, "Equipment siting and protection", "Site equipment to reduce the risk from physical and environmental threats and opportunities for unauthorised access.", "preventive", "annual", "medium", "IT Operations / Facilities", "Equipment placement plan, environmental controls."),
    ann("ISO27001-A.7.9", "A.7.9", D, ++i, "Security of assets off-premises", "Apply security measures to off-site assets taking into account the different risks of working outside the organisation's premises.", "preventive", "continuous", "medium", "IT Asset Mgmt", "Off-site asset register, encryption requirements."),
    ann("ISO27001-A.7.10", "A.7.10", D, ++i, "Storage media", "Manage storage media through their life cycle of acquisition, use, transportation and disposal in accordance with the classification scheme and handling requirements.", "preventive", "continuous", "high", "IT Asset / Security", "Media inventory, sanitisation procedure, disposal certificates."),
    ann("ISO27001-A.7.11", "A.7.11", D, ++i, "Supporting utilities", "Protect information processing facilities from power failures and other disruptions caused by failures in supporting utilities.", "preventive", "annual", "high", "Facilities", "UPS / generator test logs."),
    ann("ISO27001-A.7.12", "A.7.12", D, ++i, "Cabling security", "Protect cables carrying power or data from interception, interference or damage.", "preventive", "annual", "medium", "Facilities / IT", "Cable layout plan, inspection records."),
    ann("ISO27001-A.7.13", "A.7.13", D, ++i, "Equipment maintenance", "Maintain equipment correctly to ensure availability, integrity and confidentiality of information.", "preventive", "quarterly", "medium", "IT Operations", "Maintenance schedule and logs."),
    ann("ISO27001-A.7.14", "A.7.14", D, ++i, "Secure disposal or re-use of equipment", "Verify items of equipment containing storage media to ensure that any sensitive data and licensed software is removed or securely overwritten before disposal or re-use.", "preventive", "event_driven", "high", "IT Asset", "Disposal certificate, secure-wipe records."),
  ];
}

function A8(): ObligationDef[] {
  const D = "A.8 Technological";
  let i = 400;
  return [
    ann("ISO27001-A.8.1", "A.8.1", D, ++i, "User end point devices", "Protect information stored on, processed by or accessible via user end point devices.", "preventive", "continuous", "critical", "IT Security", "Endpoint policy, MDM / EPP coverage report."),
    ann("ISO27001-A.8.2", "A.8.2", D, ++i, "Privileged access rights", "Restrict and manage the allocation and use of privileged access rights.", "preventive", "quarterly", "critical", "IAM Team", "PAM tool inventory, privileged-account review."),
    ann("ISO27001-A.8.3", "A.8.3", D, ++i, "Information access restriction", "Restrict access to information and other associated assets in accordance with the established topic-specific policy on access control.", "preventive", "continuous", "critical", "IT Security", "Access reviews, RBAC matrix, exception log."),
    ann("ISO27001-A.8.4", "A.8.4", D, ++i, "Access to source code", "Manage read and write access to source code, development tools and software libraries appropriately.", "preventive", "quarterly", "high", "Engineering / Security", "SCM access list, branch protection rules."),
    ann("ISO27001-A.8.5", "A.8.5", D, ++i, "Secure authentication", "Implement secure authentication technologies and procedures based on information access restrictions and the topic-specific policy on access control.", "preventive", "annual", "critical", "IAM Team", "MFA enforcement report, password vault usage."),
    ann("ISO27001-A.8.6", "A.8.6", D, ++i, "Capacity management", "Monitor and adjust the use of resources in line with current and expected capacity requirements.", "detective", "monthly", "medium", "IT Operations", "Capacity dashboards, growth forecasts."),
    ann("ISO27001-A.8.7", "A.8.7", D, ++i, "Protection against malware", "Implement protection against malware supported by appropriate user awareness.", "preventive", "continuous", "critical", "IT Security", "AV/EDR coverage, last-scan dashboard."),
    ann("ISO27001-A.8.8", "A.8.8", D, ++i, "Management of technical vulnerabilities", "Obtain information about technical vulnerabilities of information systems being used; evaluate exposure; take appropriate measures.", "detective", "monthly", "critical", "IT Security", "Vulnerability scan reports, patching SLA dashboard."),
    ann("ISO27001-A.8.9", "A.8.9", D, ++i, "Configuration management", "Establish, document, implement, monitor and review configurations, including security configurations, of hardware, software, services and networks.", "preventive", "continuous", "high", "IT Operations / Security", "CMDB, baseline standards, drift reports."),
    ann("ISO27001-A.8.10", "A.8.10", D, ++i, "Information deletion", "Delete information stored in information systems, devices or any other storage media when no longer required.", "preventive", "continuous", "high", "Data Owners / IT", "Retention schedule, deletion logs."),
    ann("ISO27001-A.8.11", "A.8.11", D, ++i, "Data masking", "Use data masking in accordance with the topic-specific policy on access control and other related topic-specific policies, and business requirements, taking applicable legislation into consideration.", "preventive", "annual", "high", "Engineering / Data", "Masking rules per environment."),
    ann("ISO27001-A.8.12", "A.8.12", D, ++i, "Data leakage prevention", "Apply data leakage prevention measures to systems, networks and any other devices that process, store or transmit sensitive information.", "preventive", "continuous", "critical", "IT Security", "DLP policy and alert reports."),
    ann("ISO27001-A.8.13", "A.8.13", D, ++i, "Information backup", "Maintain and regularly test backup copies of information, software and systems in accordance with the agreed topic-specific policy on backup.", "preventive", "monthly", "critical", "IT Operations", "Backup policy, restore-test reports."),
    ann("ISO27001-A.8.14", "A.8.14", D, ++i, "Redundancy of information processing facilities", "Implement information processing facilities with redundancy sufficient to meet availability requirements.", "preventive", "annual", "high", "IT Operations", "HA design, failover-test results."),
    ann("ISO27001-A.8.15", "A.8.15", D, ++i, "Logging", "Produce, store, protect and analyse logs that record activities, exceptions, faults and other relevant events.", "detective", "continuous", "critical", "SOC / IT Operations", "Log sources inventory, SIEM ingestion report."),
    ann("ISO27001-A.8.16", "A.8.16", D, ++i, "Monitoring activities", "Monitor networks, systems and applications for anomalous behaviour and take appropriate action to evaluate potential information security incidents.", "detective", "continuous", "critical", "SOC", "Monitoring playbooks, alert KPIs."),
    ann("ISO27001-A.8.17", "A.8.17", D, ++i, "Clock synchronisation", "Synchronise the clocks of information processing systems used by the organisation to approved time sources.", "preventive", "continuous", "low", "IT Operations", "NTP configuration evidence."),
    ann("ISO27001-A.8.18", "A.8.18", D, ++i, "Use of privileged utility programs", "Restrict and tightly control the use of utility programs that may be capable of overriding system and application controls.", "preventive", "quarterly", "high", "IT Security / IAM", "Restricted-tools list, sudo / admin audit logs."),
    ann("ISO27001-A.8.19", "A.8.19", D, ++i, "Installation of software on operational systems", "Implement procedures and measures to securely manage software installation on operational systems.", "preventive", "continuous", "high", "IT Operations / Change Mgmt", "Change tickets, approved software list."),
    ann("ISO27001-A.8.20", "A.8.20", D, ++i, "Networks security", "Secure, manage and control networks and network devices to protect information in systems and applications.", "preventive", "continuous", "high", "Network Security", "Network architecture diagram, change records."),
    ann("ISO27001-A.8.21", "A.8.21", D, ++i, "Security of network services", "Identify and implement security mechanisms, service levels and service requirements of network services.", "preventive", "annual", "medium", "Network / Procurement", "Network service SLAs, security review."),
    ann("ISO27001-A.8.22", "A.8.22", D, ++i, "Segregation of networks", "Segregate groups of information services, users and information systems on the organisation's networks.", "preventive", "annual", "high", "Network Security", "Segmentation diagram, VLAN/firewall rules."),
    ann("ISO27001-A.8.23", "A.8.23", D, ++i, "Web filtering", "Manage access to external websites to reduce exposure to malicious content.", "preventive", "continuous", "medium", "IT Security", "Web-filter policy, blocked-category report."),
    ann("ISO27001-A.8.24", "A.8.24", D, ++i, "Use of cryptography", "Define and implement rules for the effective use of cryptography, including cryptographic key management.", "preventive", "annual", "critical", "IT Security", "Crypto standard, key management procedure."),
    ann("ISO27001-A.8.25", "A.8.25", D, ++i, "Secure development life cycle", "Establish and apply rules for the secure development of software and systems.", "preventive", "continuous", "critical", "Engineering / AppSec", "SDLC policy, security gate evidence."),
    ann("ISO27001-A.8.26", "A.8.26", D, ++i, "Application security requirements", "Identify, specify and approve information security requirements when developing or acquiring applications.", "preventive", "event_driven", "high", "Engineering / AppSec", "Security requirements per project."),
    ann("ISO27001-A.8.27", "A.8.27", D, ++i, "Secure system architecture and engineering principles", "Establish, document and apply principles for engineering secure systems and apply them to any information system development activities.", "preventive", "annual", "high", "Architecture", "Secure-design standards."),
    ann("ISO27001-A.8.28", "A.8.28", D, ++i, "Secure coding", "Apply secure coding principles to software development.", "preventive", "continuous", "high", "Engineering", "Coding standards, SAST findings dashboard."),
    ann("ISO27001-A.8.29", "A.8.29", D, ++i, "Security testing in development and acceptance", "Define and implement security testing processes in the development life cycle.", "detective", "event_driven", "high", "AppSec / QA", "Test plans, DAST/SAST reports."),
    ann("ISO27001-A.8.30", "A.8.30", D, ++i, "Outsourced development", "Direct, monitor and review the activities related to outsourced system development.", "preventive", "annual", "high", "Procurement / Engineering", "Outsourced dev contracts with security clauses."),
    ann("ISO27001-A.8.31", "A.8.31", D, ++i, "Separation of development, test and production environments", "Separate and protect development, test and production environments.", "preventive", "annual", "high", "Engineering / IT Ops", "Environment topology and access controls."),
    ann("ISO27001-A.8.32", "A.8.32", D, ++i, "Change management", "Subject changes to information processing facilities and information systems to change management procedures.", "preventive", "continuous", "high", "Change Mgmt", "Change tickets, CAB minutes."),
    ann("ISO27001-A.8.33", "A.8.33", D, ++i, "Test information", "Select, protect and manage test information appropriately.", "preventive", "continuous", "medium", "Engineering / QA", "Test data policy, sanitisation evidence."),
    ann("ISO27001-A.8.34", "A.8.34", D, ++i, "Protection of information systems during audit testing", "Plan and agree on audit tests and other assurance activities involving assessment of operational systems between the tester and appropriate management.", "preventive", "annual", "medium", "Internal Audit / IT", "Audit ROE, scheduled testing plan."),
  ];
}

export async function seedISO27001Obligations(pool: Pool): Promise<void> {
  await runFrameworkSeed(
    pool,
    "ISO-27001",
    ISO27001_OBLIGATION_DEFINITIONS,
    "ISO 27001:2022",
  );
}
