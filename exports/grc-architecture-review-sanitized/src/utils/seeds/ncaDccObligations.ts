/**
 * NCA Data Cybersecurity Controls (DCC-1:2022) seed (108 controls).
 *
 * Source: National Cybersecurity Authority of Saudi Arabia, DCC-1:2022.
 * Descriptions are paraphrased summaries — not verbatim NCA text.
 *
 * DCC supplements ECC with data-specific controls organised across four
 * data-classification levels and the standard NCA domain structure
 * (Governance / Defence / Resilience / Third-Party).
 */

import type { Pool } from "pg";
import { runFrameworkSeed, type ObligationDef } from "./obligationSeedTypes";

type Tuple = [
  string,
  string,
  string,
  ObligationDef["ctrl"]?,
  ObligationDef["freq"]?,
  ObligationDef["priority"]?,
  string?,
];

function build(
  domain: string,
  startOrder: number,
  rows: Tuple[],
): ObligationDef[] {
  return rows.map((r, idx) => {
    const [sub, title, desc, ctrl, freq, priority, dept] = r;
    return {
      code: `NCA-DCC-${sub}`,
      clause: sub,
      domain,
      order: startOrder + idx,
      title,
      desc,
      type: "mandatory",
      ctrl: ctrl ?? "preventive",
      freq: freq ?? "annual",
      priority: priority ?? "high",
      dept: dept ?? "DPO / CISO",
      evidence: `Approved data-protection control implementing ${sub}; evidence of operation.`,
    };
  });
}

const DG = "1. Data Cybersecurity Governance";
const DD = "2. Data Cybersecurity Defence";
const DR = "3. Data Cybersecurity Resilience";
const DT = "4. Third-Party Data Cybersecurity";

export const NCA_DCC_OBLIGATION_DEFINITIONS: ObligationDef[] = [
  // ─── 1. Governance (16) ───
  ...build(DG, 100, [
    ["1-1-1", "Data Cybersecurity Strategy", "Develop a strategy for protecting data across its lifecycle aligned with business objectives.", "preventive", "annual", "critical"],
    ["1-1-2", "Data Cybersecurity Policy", "Approve and publish a data-cybersecurity policy covering classification, handling, retention and disposal."],
    ["1-1-3", "Data Inventory", "Maintain an inventory of all data assets including type, owner and classification.", "preventive", "quarterly", "critical"],
    ["1-1-4", "Data Classification Scheme", "Define and apply a data classification scheme (e.g., Public / Internal / Confidential / Top Secret).", "preventive", "annual", "critical"],
    ["1-1-5", "Data Owner Designation", "Designate data owners and data custodians for each data set."],
    ["1-1-6", "Data Cybersecurity Roles", "Document data-cybersecurity roles and responsibilities."],
    ["1-1-7", "Data Risk Management", "Apply cybersecurity risk management to data assets."],
    ["1-1-8", "Data Lifecycle Management", "Define and apply policies covering data creation, use, sharing, archival and disposal."],
    ["1-1-9", "Data Cybersecurity Awareness", "Provide data-cybersecurity awareness training to all personnel handling data."],
    ["1-1-10", "Data Cybersecurity in Project Management", "Consider data cybersecurity in projects involving data."],
    ["1-1-11", "Compliance with Data Laws and Regulations", "Comply with applicable data privacy and cybersecurity laws (PDPL, regulator-specific).", "detective", "annual", "critical", "Legal / DPO"],
    ["1-1-12", "Cross-Border Data Transfer", "Apply controls and obtain approvals (where required) for cross-border data transfers."],
    ["1-1-13", "Data Cybersecurity Reviews", "Periodically review data cybersecurity programme effectiveness.", "detective", "annual", "high"],
    ["1-1-14", "Data Cybersecurity Audit", "Conduct independent audits of data cybersecurity controls.", "detective", "annual", "high", "Internal Audit"],
    ["1-1-15", "Data Cybersecurity Documentation", "Maintain documented evidence of data cybersecurity programme operation."],
    ["1-1-16", "Data Subject Rights Handling", "Establish processes to handle data subject rights requests within regulatory timelines."],
  ]),
  // ─── 2. Defence (57) ───
  ...build(DD, 200, [
    ["2-1-1", "Data Access Control Policy", "Define and apply access control policy specific to data assets.", "preventive", "annual", "critical"],
    ["2-1-2", "Data Access Provisioning", "Provision data access on least-privilege and need-to-know basis."],
    ["2-1-3", "Data Access Reviews", "Review data access rights at planned intervals.", "detective", "quarterly", "critical"],
    ["2-1-4", "Privileged Data Access", "Restrict and monitor privileged access to sensitive data."],
    ["2-1-5", "Data Authentication", "Enforce strong authentication (incl. MFA) for accessing sensitive data."],
    ["2-1-6", "Data Authorisation", "Enforce role-based authorisation for data access."],
    ["2-1-7", "Service Account Data Access", "Apply additional controls to service accounts with data access."],
    ["2-2-1", "Data Encryption — At Rest", "Encrypt sensitive data at rest using approved algorithms and keys.", "preventive", "annual", "critical"],
    ["2-2-2", "Data Encryption — In Transit", "Encrypt sensitive data in transit using approved protocols (e.g., TLS 1.2+).", "preventive", "continuous", "critical"],
    ["2-2-3", "Data Encryption — In Use", "Where technically feasible, protect sensitive data in use (e.g., confidential computing)."],
    ["2-2-4", "Cryptographic Key Management for Data", "Implement secure key management for data encryption keys."],
    ["2-2-5", "Customer-Controlled Encryption Keys", "Where applicable, support customer-controlled encryption keys for hosted data."],
    ["2-3-1", "Data Masking and Tokenisation", "Apply masking or tokenisation to sensitive data in non-production and analytics environments.", "preventive", "annual", "high"],
    ["2-3-2", "Data Anonymisation", "Anonymise data when used for analytics, research or sharing where possible."],
    ["2-3-3", "Data Pseudonymisation", "Apply pseudonymisation to sensitive data where appropriate."],
    ["2-4-1", "Data Loss Prevention", "Deploy DLP controls to prevent unauthorised data exfiltration.", "preventive", "continuous", "critical"],
    ["2-4-2", "DLP Monitoring", "Monitor DLP alerts and take corrective action."],
    ["2-4-3", "DLP for Email", "Apply DLP to outbound email."],
    ["2-4-4", "DLP for Endpoint", "Apply DLP to endpoint devices."],
    ["2-4-5", "DLP for Cloud Storage", "Apply DLP to cloud storage and SaaS platforms."],
    ["2-5-1", "Data Backup and Restore", "Maintain backups of critical data with regular restore testing.", "preventive", "monthly", "critical", "IT Operations"],
    ["2-5-2", "Backup Encryption", "Encrypt backups containing sensitive data."],
    ["2-5-3", "Backup Access Control", "Restrict access to backup systems and data."],
    ["2-5-4", "Off-Site Backup Storage", "Maintain off-site or geographically diverse backup copies."],
    ["2-5-5", "Backup Retention", "Define and enforce retention periods for backups based on data classification."],
    ["2-6-1", "Data Logging", "Log access and modifications to sensitive data.", "detective", "continuous", "critical", "SOC"],
    ["2-6-2", "Data Activity Monitoring", "Monitor sensitive data activity for anomalies."],
    ["2-6-3", "Data Access Audit Trail", "Maintain a tamper-resistant audit trail of data access events."],
    ["2-7-1", "Data Storage Security", "Apply security controls to data storage systems."],
    ["2-7-2", "Storage Hardening", "Apply hardening baselines to storage devices."],
    ["2-7-3", "Storage Access Control", "Restrict access to storage management interfaces."],
    ["2-8-1", "Database Security", "Apply security controls to databases handling sensitive data."],
    ["2-8-2", "Database Activity Monitoring", "Monitor database activity for unauthorised access or anomalies."],
    ["2-8-3", "Database Encryption", "Encrypt sensitive database columns or full databases."],
    ["2-9-1", "Removable Media Restriction", "Restrict use of removable media for sensitive data."],
    ["2-9-2", "Removable Media Encryption", "Encrypt removable media containing sensitive data."],
    ["2-9-3", "Removable Media Disposal", "Securely sanitise or destroy removable media before disposal."],
    ["2-10-1", "Data Sharing Controls", "Apply controls when sharing data with internal or external parties."],
    ["2-10-2", "Data Sharing Agreements", "Document data sharing agreements with required protections."],
    ["2-10-3", "Cross-Border Transfer Controls", "Apply additional controls and obtain regulatory approvals for cross-border transfers."],
    ["2-11-1", "Data Sanitisation", "Sanitise data when no longer needed per retention schedule."],
    ["2-11-2", "Secure Data Disposal", "Securely dispose of data and storage media."],
    ["2-11-3", "Disposal Certificates", "Obtain and retain disposal certificates for sensitive media."],
    ["2-12-1", "Personal Data Protection", "Apply PDPL-aligned controls to personal data."],
    ["2-12-2", "PII Inventory", "Maintain an inventory of personally identifiable information (PII) processing."],
    ["2-12-3", "PII Lawful Basis", "Document lawful basis for each PII processing activity."],
    ["2-12-4", "Data Subject Consent Management", "Maintain consent management records where consent is the lawful basis."],
    ["2-13-1", "Sensitive Data Identification", "Use automated discovery to identify sensitive data across systems."],
    ["2-13-2", "Sensitive Data Tagging", "Tag sensitive data for downstream control enforcement."],
    ["2-14-1", "Test Data Management", "Manage test data securely; avoid using production sensitive data in test environments."],
    ["2-14-2", "Test Environment Segregation", "Segregate test environments from production with documented data flow controls."],
    ["2-15-1", "Print and Output Security", "Apply security controls to printing and physical outputs of sensitive data."],
    ["2-15-2", "Document Secure Destruction", "Securely destroy printed sensitive documents per retention schedule."],
    ["2-16-1", "Data Cybersecurity in Mobile Devices", "Apply data protection controls to mobile devices accessing sensitive data."],
    ["2-16-2", "Mobile Device Encryption", "Enforce device encryption on mobile devices accessing sensitive data."],
    ["2-17-1", "Data Cybersecurity in Email", "Apply data protection to email systems handling sensitive data."],
    ["2-17-2", "Email Encryption", "Encrypt email containing sensitive data."],
    ["2-18-1", "Data Cybersecurity in Web Applications", "Apply data protection in web applications processing sensitive data."],
  ]),
  // ─── 3. Resilience (5) ───
  ...build(DR, 300, [
    ["3-1-1", "Data Recovery Plans", "Maintain recovery plans for sensitive data sets including RPO/RTO targets.", "preventive", "annual", "critical", "BCM"],
    ["3-1-2", "Data Recovery Testing", "Test data recovery procedures at planned intervals.", "detective", "annual", "high"],
    ["3-1-3", "Data Resilience Architecture", "Design data systems for resilience including replication and failover."],
    ["3-1-4", "Data in Crisis Management", "Include data protection in crisis management planning."],
    ["3-1-5", "Data Continuity Reviews", "Review data resilience after material change or incident."],
  ]),
  // ─── 4. Third-Party (30) ───
  ...build(DT, 400, [
    ["4-1-1", "Third-Party Data Cybersecurity Requirements", "Define cybersecurity requirements for third parties processing organisational data.", "preventive", "annual", "critical", "Procurement / DPO"],
    ["4-1-2", "Third-Party Data Risk Assessment", "Assess data cybersecurity risk of each third party."],
    ["4-1-3", "Third-Party Data Processing Agreement", "Maintain data processing agreements with third parties."],
    ["4-1-4", "Third-Party Data Audit Rights", "Retain right to audit third-party data cybersecurity controls."],
    ["4-1-5", "Third-Party Breach Notification", "Require third parties to notify the organisation of data breaches within agreed timelines."],
    ["4-1-6", "Third-Party Data Return / Destruction", "Require data return or secure destruction at termination."],
    ["4-1-7", "Third-Party Sub-Processor Approval", "Require approval of sub-processors handling organisational data."],
    ["4-1-8", "Third-Party Cross-Border Transfer Controls", "Apply controls when third parties transfer data across borders."],
    ["4-1-9", "Third-Party Data Cybersecurity Monitoring", "Monitor third-party data cybersecurity performance."],
    ["4-1-10", "Third-Party Data Cybersecurity Reviews", "Periodically review third-party data cybersecurity controls."],
    ["4-2-1", "Cloud Data Cybersecurity Requirements", "Define cybersecurity requirements for cloud services processing data.", "preventive", "annual", "critical"],
    ["4-2-2", "Cloud Data Residency", "Ensure cloud-hosted data complies with residency requirements."],
    ["4-2-3", "Cloud Shared Responsibility", "Document and enforce shared-responsibility model with cloud provider."],
    ["4-2-4", "Cloud Encryption", "Encrypt data hosted in cloud."],
    ["4-2-5", "Cloud Customer Keys", "Use customer-managed encryption keys for cloud-hosted sensitive data where feasible."],
    ["4-2-6", "Cloud Data Access Logging", "Log data access events from cloud-hosted systems."],
    ["4-2-7", "Cloud Data Backup", "Maintain backups of cloud-hosted data with documented restore procedures."],
    ["4-2-8", "Cloud Data Exit Strategy", "Maintain exit strategy including data export and destruction."],
    ["4-2-9", "Cloud Vendor Lock-In Mitigation", "Mitigate vendor lock-in for critical cloud-hosted data."],
    ["4-2-10", "SaaS Data Protection", "Apply data protection controls to SaaS applications."],
    ["4-2-11", "Cloud Storage Security", "Apply security controls to cloud storage."],
    ["4-2-12", "Cloud Database Security", "Apply security controls to cloud-hosted databases."],
    ["4-2-13", "Cloud Data Discovery", "Use cloud security posture management or equivalent to discover sensitive data in cloud."],
    ["4-2-14", "Cloud DLP", "Apply DLP controls to cloud platforms."],
    ["4-2-15", "Cloud Identity Federation", "Federate identity to cloud platforms with strong authentication."],
    ["4-2-16", "Cloud Privileged Access", "Restrict and monitor privileged access in cloud platforms."],
    ["4-2-17", "Cloud Activity Monitoring", "Monitor cloud activity for anomalies and unauthorised data access."],
    ["4-2-18", "Cloud Compliance Reporting", "Use cloud-provider compliance attestations as part of cloud cybersecurity assurance."],
    ["4-2-19", "Cloud Incident Response Coordination", "Coordinate incident response with cloud providers."],
    ["4-2-20", "Cloud Configuration Drift Monitoring", "Monitor cloud configuration drift from approved baselines."],
  ]),
];

export async function seedNcaDccObligations(pool: Pool): Promise<void> {
  await runFrameworkSeed(
    pool,
    "NCA-DCC",
    NCA_DCC_OBLIGATION_DEFINITIONS,
    "NCA-DCC v1:2022",
  );
}
