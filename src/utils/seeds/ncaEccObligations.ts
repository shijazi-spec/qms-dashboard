/**
 * NCA Essential Cybersecurity Controls (ECC-1:2018) seed (114 controls).
 *
 * Source: National Cybersecurity Authority of Saudi Arabia, ECC-1:2018.
 * Descriptions are paraphrased summaries — not verbatim NCA text — for
 * dashboard display. Compliance officers may edit any seeded row via
 * the standard obligations UI.
 *
 * Domain mapping:
 *   1.x  Cybersecurity Governance         (24 controls)
 *   2.x  Cybersecurity Defence            (50 controls)
 *   3.x  Cybersecurity Resilience          (6 controls)
 *   4.x  Third-Party & Cloud Cybersecurity (10 controls)
 *   5.x  Industrial Control Systems        (24 controls)
 */

import type { Pool } from "pg";
import { runFrameworkSeed, type ObligationDef } from "./obligationSeedTypes";

type Tuple = [
  string, // sub-control code, e.g. "1-1-1"
  string, // title
  string, // description
  ObligationDef["ctrl"]?,
  ObligationDef["freq"]?,
  ObligationDef["priority"]?,
  string?, // department
];

function build(
  domain: string,
  domainPrefix: number,
  startOrder: number,
  rows: Tuple[],
): ObligationDef[] {
  return rows.map((r, idx) => {
    const [sub, title, desc, ctrl, freq, priority, dept] = r;
    return {
      code: `NCA-ECC-${sub}`,
      clause: sub,
      domain,
      order: startOrder + idx,
      title,
      desc,
      type: "mandatory",
      ctrl: ctrl ?? "preventive",
      freq: freq ?? "annual",
      priority: priority ?? "high",
      dept: dept ?? "CISO Office",
      evidence: `Approved policy or procedure addressing ${sub}, evidence of operation.`,
    };
  });
}

const D1 = "1. Cybersecurity Governance";
const D2 = "2. Cybersecurity Defence";
const D3 = "3. Cybersecurity Resilience";
const D4 = "4. Third-Party & Cloud Cybersecurity";
const D5 = "5. Industrial Control Systems";

export const NCA_ECC_OBLIGATION_DEFINITIONS: ObligationDef[] = [
  ...build(D1, 1, 100, [
    ["1-1-1", "Cybersecurity Strategy", "Develop, document, approve and publish a cybersecurity strategy aligned with the organisation's strategic objectives and applicable laws.", "preventive", "annual", "critical", "Executive / CISO"],
    ["1-2-1", "Cybersecurity Management Function", "Establish a dedicated cybersecurity function reporting to the head of the organisation, with sufficient authority and resources.", "preventive", "annual", "critical", "Executive"],
    ["1-2-2", "Cybersecurity Steering Committee", "Form a cybersecurity steering committee chaired at executive level to direct, monitor and review the cybersecurity programme.", "preventive", "quarterly", "critical", "Executive"],
    ["1-3-1", "Cybersecurity Policies and Procedures", "Develop, approve, publish and maintain cybersecurity policies and procedures covering all ECC requirements.", "preventive", "annual", "critical", "CISO Office"],
    ["1-3-2", "Cybersecurity Policy Review", "Review cybersecurity policies and procedures at planned intervals or upon significant change.", "detective", "annual", "high"],
    ["1-4-1", "Cybersecurity Roles and Responsibilities", "Document cybersecurity roles, responsibilities and authorities; communicate them across the organisation."],
    ["1-5-1", "Cybersecurity Risk Management", "Implement a risk management methodology covering identification, assessment, treatment and monitoring of cybersecurity risks.", "preventive", "quarterly", "critical", "Risk Mgmt"],
    ["1-5-2", "Cybersecurity Risk Assessment", "Perform cybersecurity risk assessments on assets, projects and changes."],
    ["1-6-1", "Cybersecurity in IT Project Management", "Integrate cybersecurity requirements into project management for new or significantly changed systems.", "preventive", "event_driven", "high", "PMO"],
    ["1-6-2", "Cybersecurity Requirements Acceptance", "Define and obtain documented acceptance of cybersecurity requirements before deployment.", "preventive", "event_driven", "high", "PMO / CISO"],
    ["1-7-1", "Compliance with Cybersecurity Standards & Laws", "Identify and comply with applicable cybersecurity standards, laws and regulations.", "detective", "annual", "critical", "Legal / GRC"],
    ["1-8-1", "Cybersecurity Reviews", "Periodically review the cybersecurity programme implementation and effectiveness.", "detective", "annual", "high", "Internal Audit"],
    ["1-8-2", "Cybersecurity Audit", "Conduct independent cybersecurity audits at least annually.", "detective", "annual", "high", "Internal Audit"],
    ["1-9-1", "Cybersecurity in Human Resources — Pre-Employment", "Define cybersecurity requirements for screening and background checks before employment.", "preventive", "event_driven", "high", "HR"],
    ["1-9-2", "Cybersecurity in HR — During Employment", "Address cybersecurity in employment terms, awareness and access provisioning during employment.", "preventive", "continuous", "high", "HR"],
    ["1-9-3", "Cybersecurity in HR — Termination/Change", "Apply cybersecurity controls upon termination or job change including access removal and asset return.", "preventive", "event_driven", "high", "HR / IT"],
    ["1-10-1", "Cybersecurity Awareness", "Establish a cybersecurity awareness programme for all personnel, contractors and third parties.", "preventive", "continuous", "high", "CISO / HR"],
    ["1-10-2", "Awareness Programme Effectiveness", "Measure and improve effectiveness of the cybersecurity awareness programme."],
    ["1-10-3", "Specialised Training", "Provide specialised cybersecurity training for personnel in cybersecurity roles."],
    ["1-11-1", "Cybersecurity Sourcing", "Define cybersecurity requirements before acquiring products or services."],
    ["1-12-1", "Asset Management — Inventory", "Establish and maintain an inventory of information assets including ownership and classification.", "preventive", "quarterly", "critical", "IT Asset Mgmt"],
    ["1-12-2", "Asset Management — Classification", "Classify and label information assets per business value and sensitivity.", "preventive", "annual", "high"],
    ["1-12-3", "Asset Management — Acceptable Use", "Define acceptable use rules for information assets."],
    ["1-13-1", "Cybersecurity Documentation", "Maintain documented cybersecurity records sufficient to demonstrate compliance."],
  ]),
  ...build(D2, 2, 200, [
    ["2-1-1", "Identity and Access Management — Policy", "Establish and maintain an identity and access management policy.", "preventive", "annual", "critical", "IAM Team"],
    ["2-1-2", "User Identity Lifecycle", "Manage the full user identity life cycle (registration, modification, removal).", "preventive", "continuous", "critical", "IAM Team"],
    ["2-1-3", "Access Provisioning", "Provision access based on least-privilege and need-to-know.", "preventive", "continuous", "critical", "IAM Team"],
    ["2-1-4", "Privileged Access Management", "Restrict and monitor privileged access; use a Privileged Access Management (PAM) solution where applicable.", "preventive", "continuous", "critical", "IAM Team"],
    ["2-1-5", "Authentication", "Enforce strong authentication including MFA for remote and privileged access.", "preventive", "continuous", "critical", "IAM Team"],
    ["2-1-6", "Periodic Access Review", "Review user access rights at planned intervals.", "detective", "quarterly", "critical", "IT Security"],
    ["2-2-1", "Information System and Information Processing Facilities Protection", "Protect systems and facilities from cybersecurity threats."],
    ["2-2-2", "System Hardening", "Apply hardening baselines to systems and devices."],
    ["2-2-3", "Antimalware Protection", "Deploy and maintain antimalware on all endpoints and servers.", "preventive", "continuous", "critical", "IT Security"],
    ["2-2-4", "Patching and Updates", "Apply security updates and patches in a timely manner per documented SLA."],
    ["2-3-1", "Email Protection", "Protect email systems against phishing, spoofing and malicious attachments.", "preventive", "continuous", "critical", "IT Security"],
    ["2-4-1", "Networks Security", "Secure organisation networks via segmentation, firewalls and intrusion prevention."],
    ["2-4-2", "Wireless Network Security", "Protect wireless networks via encryption, segmentation and authentication."],
    ["2-4-3", "Network Filtering", "Filter incoming and outgoing traffic via documented rule-sets."],
    ["2-5-1", "Mobile Devices Security", "Secure mobile devices used for business purposes (MDM, encryption, policy)."],
    ["2-6-1", "Data and Information Protection", "Protect organisational data per its classification."],
    ["2-6-2", "Data Encryption", "Encrypt sensitive data at rest and in transit using approved algorithms.", "preventive", "annual", "critical", "IT Security"],
    ["2-7-1", "Cryptography", "Maintain a cryptography policy covering algorithms, key management and lifecycle."],
    ["2-7-2", "Key Management", "Implement secure key management practices."],
    ["2-8-1", "Backup and Recovery Management", "Maintain secure backups of critical information and systems; test restoration regularly.", "preventive", "monthly", "critical", "IT Operations"],
    ["2-9-1", "Vulnerability Management", "Establish and operate a vulnerability management programme.", "detective", "monthly", "critical", "IT Security"],
    ["2-10-1", "Penetration Testing", "Conduct penetration testing on critical systems at least annually.", "detective", "annual", "high"],
    ["2-11-1", "Cybersecurity Event Logs and Monitoring Management", "Centralise security logs and monitor them 24/7.", "detective", "continuous", "critical", "SOC"],
    ["2-11-2", "Log Retention", "Retain security logs for at least 12 months in tamper-resistant storage."],
    ["2-12-1", "Cybersecurity Incident and Threat Management", "Establish and operate a cybersecurity incident management capability.", "corrective", "event_driven", "critical", "IRT / SOC"],
    ["2-12-2", "Threat Intelligence", "Collect and use cyber threat intelligence to improve detection and response."],
    ["2-12-3", "Incident Reporting to NCA", "Report eligible incidents to the National Cybersecurity Authority within required timelines.", "corrective", "event_driven", "critical", "CISO"],
    ["2-13-1", "Physical Security", "Protect facilities housing IT assets via physical security controls.", "preventive", "annual", "high", "Facilities"],
    ["2-13-2", "Visitor Management", "Manage visitor access via documented procedures and logs."],
    ["2-14-1", "Web Application Security", "Apply security controls to web applications including authentication, input validation and output encoding.", "preventive", "continuous", "high", "AppSec"],
    ["2-14-2", "Web Application Vulnerability Testing", "Perform regular security testing of web applications."],
    ["2-15-1", "Removable Media Security", "Control use of removable media; restrict where business-justified."],
    ["2-15-2", "Media Disposal", "Sanitise or destroy storage media before disposal."],
    ["2-16-1", "Database Security", "Apply security controls to databases including access control, hardening and monitoring."],
    ["2-16-2", "Database Encryption", "Encrypt sensitive databases or columns containing sensitive data."],
    ["2-17-1", "Application Security in Development", "Apply secure development practices to in-house and outsourced development."],
    ["2-17-2", "Code Review", "Perform security code reviews on critical applications before deployment."],
    ["2-18-1", "Change Management", "Subject changes to operational systems to formal change management.", "preventive", "continuous", "high", "Change Mgmt"],
    ["2-19-1", "Cybersecurity in Source Code", "Protect source code repositories with access control and version control."],
    ["2-20-1", "Configuration Management", "Maintain secure configuration baselines for all systems."],
    ["2-21-1", "Secure Disposal of Information Systems", "Securely dispose of information systems and components no longer in use."],
    ["2-22-1", "Information System Acquisition", "Apply cybersecurity requirements when acquiring new information systems."],
    ["2-23-1", "Acceptance Testing", "Perform cybersecurity acceptance testing before production deployment."],
    ["2-24-1", "Outsourced Cybersecurity Services", "Manage cybersecurity controls when services are outsourced."],
    ["2-25-1", "Software Security", "Apply security controls to commercial off-the-shelf software."],
    ["2-26-1", "Storage Security", "Protect data storage systems via access control, encryption and monitoring."],
    ["2-27-1", "Endpoint Protection", "Deploy endpoint protection on all workstations and servers."],
    ["2-28-1", "Server Protection", "Apply hardening, monitoring and access controls to servers."],
    ["2-29-1", "Cybersecurity in Remote Access", "Secure remote access via VPN, MFA and monitoring."],
    ["2-30-1", "DNS Security", "Protect DNS infrastructure from manipulation and unauthorised changes."],
  ]),
  ...build(D3, 3, 300, [
    ["3-1-1", "Business Continuity Management — Cybersecurity", "Integrate cybersecurity into business continuity plans.", "preventive", "annual", "critical", "BCM"],
    ["3-1-2", "Disaster Recovery Plan", "Maintain and test a disaster recovery plan for critical systems.", "preventive", "annual", "critical", "IT BCM"],
    ["3-1-3", "BCP/DR Testing", "Test business continuity and disaster recovery plans at least annually.", "detective", "annual", "high"],
    ["3-1-4", "Critical Service Continuity", "Identify critical services and define continuity requirements per service."],
    ["3-1-5", "Cyber Crisis Management", "Establish and exercise a cyber crisis management capability for major incidents."],
    ["3-1-6", "Cybersecurity in BCP Updates", "Update BCP/DR after material change or post-incident lessons learned."],
  ]),
  ...build(D4, 4, 400, [
    ["4-1-1", "Third-Party Cybersecurity", "Define and apply cybersecurity requirements to third parties.", "preventive", "annual", "critical", "Procurement / GRC"],
    ["4-1-2", "Third-Party Risk Assessment", "Assess cybersecurity risk of each third party before engagement."],
    ["4-1-3", "Third-Party Cybersecurity in Contracts", "Include cybersecurity clauses (right to audit, breach notification, data return) in third-party contracts."],
    ["4-1-4", "Third-Party Performance Monitoring", "Monitor third-party cybersecurity performance during the engagement."],
    ["4-1-5", "Third-Party Termination", "Apply secure termination procedures including data return / destruction."],
    ["4-2-1", "Cloud Computing and Hosting Cybersecurity", "Define and apply cybersecurity requirements when using cloud services."],
    ["4-2-2", "Cloud Data Residency", "Comply with data residency requirements when using cloud services."],
    ["4-2-3", "Cloud Shared Responsibility", "Document and enforce shared-responsibility boundaries with cloud providers."],
    ["4-2-4", "Cloud Exit Strategy", "Maintain an exit strategy for each cloud service in use."],
    ["4-2-5", "Cloud Encryption", "Encrypt sensitive data hosted in the cloud using customer-controlled keys where feasible."],
  ]),
  ...build(D5, 5, 500, [
    ["5-1-1", "ICS Cybersecurity Strategy", "Define a cybersecurity strategy specifically for industrial control systems (ICS).", "preventive", "annual", "critical", "OT Security"],
    ["5-1-2", "ICS Inventory", "Maintain an inventory of all ICS assets."],
    ["5-1-3", "ICS Risk Assessment", "Perform risk assessments for ICS environments."],
    ["5-1-4", "ICS Network Segmentation", "Segment ICS networks from corporate networks."],
    ["5-1-5", "ICS Remote Access", "Restrict and monitor remote access to ICS environments."],
    ["5-1-6", "ICS Patching", "Apply patches to ICS systems via documented and tested process."],
    ["5-1-7", "ICS Backups", "Maintain backups of ICS configurations and software."],
    ["5-1-8", "ICS Change Management", "Apply formal change management to ICS environments."],
    ["5-1-9", "ICS Incident Response", "Maintain ICS-specific incident response procedures."],
    ["5-1-10", "ICS Monitoring", "Monitor ICS environments for cybersecurity events."],
    ["5-1-11", "ICS Vendor Management", "Apply cybersecurity requirements to ICS vendors."],
    ["5-1-12", "ICS Hardening", "Apply hardening baselines to ICS components."],
    ["5-1-13", "ICS Authentication", "Enforce strong authentication for ICS access."],
    ["5-1-14", "ICS Physical Security", "Protect ICS facilities via physical security controls."],
    ["5-1-15", "ICS Awareness Training", "Provide ICS-specific cybersecurity training to relevant personnel."],
    ["5-1-16", "ICS Encryption", "Apply encryption to ICS data where technically feasible."],
    ["5-1-17", "ICS Removable Media", "Strictly control removable media use within ICS environments."],
    ["5-1-18", "ICS Wireless", "Apply additional controls to wireless networks within ICS environments."],
    ["5-1-19", "ICS Logging", "Collect and retain ICS security logs."],
    ["5-1-20", "ICS Cybersecurity Documentation", "Maintain documented ICS cybersecurity records."],
    ["5-1-21", "ICS Configuration Management", "Maintain configuration baselines for ICS components."],
    ["5-1-22", "ICS Penetration Testing", "Where feasible, conduct ICS penetration testing in test environments."],
    ["5-1-23", "ICS Supply Chain Security", "Apply cybersecurity requirements to ICS supply chain."],
    ["5-1-24", "ICS Continuity", "Integrate ICS into BCP/DR planning."],
  ]),
];

export async function seedNcaEccObligations(pool: Pool): Promise<void> {
  await runFrameworkSeed(
    pool,
    "NCA-ECC",
    NCA_ECC_OBLIGATION_DEFINITIONS,
    "NCA-ECC v1:2018",
  );
}
