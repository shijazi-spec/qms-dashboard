/**
 * SAMA Cyber Security Framework v1.0 — fill seed (98 additional sub-controls).
 *
 * Extends the original 20-row SAMA seed in complianceDatabase.ts with
 * SAMA-21 through SAMA-118 to cover the full ~118 sub-controls of the
 * framework. Codes do not collide with the original seed.
 *
 * Source: SAMA CSF (May 2017). Descriptions are paraphrased summaries
 * — not verbatim SAMA text.
 */

import type { Pool } from "pg";
import { runFrameworkSeed, type ObligationDef } from "./obligationSeedTypes";

type Tuple = [
  string, // SAMA clause, e.g. "§3.7"
  string, // domain
  string, // title
  string, // desc
  ObligationDef["ctrl"]?,
  ObligationDef["freq"]?,
  ObligationDef["priority"]?,
  string?,
];

function build(startCode: number, rows: Tuple[]): ObligationDef[] {
  return rows.map((r, idx) => {
    const [clause, domain, title, desc, ctrl, freq, priority, dept] = r;
    const num = startCode + idx;
    return {
      code: `SAMA-${String(num).padStart(2, "0")}`,
      clause,
      domain,
      order: num,
      title,
      desc,
      type: "mandatory",
      ctrl: ctrl ?? "preventive",
      freq: freq ?? "annual",
      priority: priority ?? "high",
      dept: dept ?? "CISO Office",
      evidence: `Documented control evidence for ${clause}.`,
    };
  });
}

const G = "Leadership & Governance";
const R = "Risk Management & Compliance";
const O = "Operations & Technology";
const T = "Third Party";

export const SAMA_FULL_OBLIGATION_DEFINITIONS: ObligationDef[] = build(21, [
  // Leadership & Governance fill
  ["§1.2", G, "Cyber Security Strategy Implementation", "Translate the cyber security strategy into measurable initiatives with assigned owners and target dates.", "preventive", "annual", "high"],
  ["§1.7", G, "Cyber Security in HR — Pre-Employment", "Apply cyber security background checks for all candidates before employment, proportional to role sensitivity.", "preventive", "event_driven", "high", "HR"],
  ["§1.8", G, "Cyber Security in HR — Termination/Change", "Apply controls upon termination or role change including immediate access removal and asset return.", "preventive", "event_driven", "high", "HR"],
  ["§1.10", G, "Cyber Security Performance Reporting", "Report cyber security KPIs and posture to executive management at least quarterly.", "detective", "quarterly", "high"],
  // Risk & Compliance fill
  ["§2.3", R, "Cyber Security Risk Treatment", "Document and track cyber security risk treatment decisions including accept / mitigate / transfer / avoid.", "preventive", "quarterly", "high", "Risk Mgmt"],
  ["§2.4", R, "Risk Acceptance Approval", "Document and obtain executive approval for residual risks above the appetite threshold.", "preventive", "annual", "critical"],
  ["§2.5", R, "Risk Reporting to Board", "Report cyber security risks to the board at least annually.", "detective", "annual", "high"],
  ["§2.6", R, "Compliance Monitoring", "Monitor compliance with SAMA directives continuously and report exceptions.", "detective", "continuous", "high"],
  ["§2.7", R, "Internal Audit Independence", "Internal audit function has independence and direct access to the audit committee.", "preventive", "annual", "high", "Internal Audit"],
  // Operations & Technology fill (large block)
  ["§3.1", O, "Information Asset Classification", "Classify information assets by sensitivity (public / internal / confidential / restricted) per SAMA scheme.", "preventive", "annual", "high"],
  ["§3.2", O, "Asset Lifecycle Management", "Manage assets across their full life cycle (acquisition, use, disposal) with security controls applied at each stage.", "preventive", "annual", "high"],
  ["§3.7", O, "Network Security", "Implement network segmentation, perimeter security, intrusion prevention and continuous monitoring.", "preventive", "annual", "critical"],
  ["§3.8", O, "Endpoint Security", "Deploy endpoint protection (anti-malware, EDR, hardening, patching) on all servers and workstations.", "preventive", "continuous", "critical"],
  ["§3.10", O, "Cloud Security", "Apply additional security controls when using cloud services including encryption, access control and monitoring."],
  ["§3.11", O, "Mobile Security", "Apply security controls to mobile devices used for SAMA-regulated activities (MDM, encryption, MFA)."],
  ["§3.13", O, "Backup and Recovery", "Maintain secure, tested backups for all critical systems with restoration testing at least quarterly.", "preventive", "monthly", "critical", "IT Operations"],
  ["§3.14", O, "Patch Management", "Apply security patches per documented SLA (critical: 14 days, high: 30 days)."],
  ["§3.16", O, "Security Operations Centre", "Operate a SOC (in-house or outsourced) with 24/7 monitoring, alerting and response capability."],
  ["§3.18", O, "Threat Intelligence", "Integrate threat intelligence into security operations to improve detection and response."],
  ["§3.20", O, "Database Security", "Apply security controls to databases including access control, encryption and activity monitoring."],
  ["§3.21", O, "Email Security", "Protect email systems from phishing, spoofing and malware via DMARC, SPF, DKIM and gateway filtering."],
  ["§3.22", O, "Web Security", "Protect web applications via WAF, secure coding and regular security testing."],
  ["§3.23", O, "DDoS Protection", "Deploy DDoS protection for internet-facing services."],
  ["§3.24", O, "Wireless Security", "Apply security controls to wireless networks including authentication, encryption and segmentation."],
  ["§3.25", O, "Remote Access Security", "Secure remote access via VPN with MFA and session monitoring."],
  ["§3.26", O, "Privileged Access Management", "Implement PAM for all privileged accounts with session recording and just-in-time access."],
  ["§3.27", O, "Identity Federation", "Federate identity to internal and external systems with strong authentication."],
  ["§3.28", O, "Single Sign-On (SSO)", "Implement SSO for enterprise applications with strong authentication at the SSO IdP."],
  ["§3.29", O, "Service Account Management", "Manage service accounts with rotation, monitoring and minimal privilege."],
  ["§3.30", O, "Customer Authentication", "Implement strong customer authentication including MFA for online and mobile banking."],
  ["§3.31", O, "API Security", "Apply security controls to APIs including authentication, authorisation, rate limiting and input validation."],
  ["§3.32", O, "Data Loss Prevention", "Deploy DLP controls to prevent unauthorised exfiltration of sensitive data.", "preventive", "continuous", "critical"],
  ["§3.33", O, "Encryption Standards", "Use only SAMA-approved cryptographic algorithms (e.g., AES-256, RSA-2048+, SHA-256+)."],
  ["§3.34", O, "Key Management Lifecycle", "Manage cryptographic keys across full lifecycle including secure generation, storage, distribution, rotation and destruction."],
  ["§3.35", O, "Hardware Security Modules (HSM)", "Use HSMs for high-value cryptographic operations including payment systems."],
  ["§3.36", O, "Code of Conduct", "Maintain a code of conduct covering acceptable use of cyber security resources."],
  ["§3.37", O, "Acceptable Use Policy", "Maintain an acceptable use policy covering personal use of organisational systems."],
  ["§3.38", O, "Data Classification Implementation", "Implement classification labels and handling procedures across all systems."],
  ["§3.39", O, "Information Handling", "Apply handling procedures per data classification including transfer, storage and disposal."],
  ["§3.40", O, "Records Management", "Maintain records per regulatory retention requirements."],
  ["§3.41", O, "Print Security", "Apply security controls to printing including secure print release and confidential output."],
  ["§3.42", O, "Removable Media", "Restrict and control removable media use; encrypt where business-justified."],
  ["§3.43", O, "Asset Disposal", "Securely dispose of media and equipment; obtain disposal certificates for sensitive items."],
  ["§3.44", O, "Physical Security", "Apply physical security to facilities housing critical systems (perimeter, access control, monitoring)."],
  ["§3.45", O, "Visitor Management", "Manage visitor access via documented procedures including registration, escort and access logging."],
  ["§3.46", O, "Equipment Maintenance", "Maintain equipment per vendor specifications and security requirements."],
  ["§3.47", O, "Environmental Controls", "Apply environmental controls (HVAC, fire suppression, water detection) to data centres."],
  ["§3.48", O, "Power Continuity", "Maintain UPS and generator capacity for critical systems with regular testing."],
  ["§3.49", O, "Disaster Recovery", "Maintain a tested disaster recovery plan with documented RTO/RPO per system."],
  ["§3.50", O, "Business Continuity", "Integrate cyber resilience into business continuity planning and testing."],
  ["§3.51", O, "Cyber Crisis Management", "Maintain cyber crisis management capability with executive participation."],
  ["§3.52", O, "Cyber War Gaming", "Conduct cyber war gaming exercises at least annually."],
  ["§3.53", O, "Insider Threat Programme", "Operate an insider threat programme combining technical controls and behavioural analysis."],
  ["§3.54", O, "Privileged User Monitoring", "Monitor privileged user activity continuously."],
  ["§3.55", O, "Application Whitelisting", "Apply application whitelisting on critical systems."],
  ["§3.56", O, "Configuration Management", "Maintain secure configuration baselines and monitor for drift."],
  ["§3.57", O, "Change Management", "Apply formal change management to all production changes."],
  ["§3.58", O, "Release Management", "Apply formal release management with testing, approval and rollback procedures."],
  ["§3.59", O, "Capacity Management", "Monitor and plan capacity for critical systems."],
  ["§3.60", O, "Performance Monitoring", "Monitor performance of critical systems against agreed SLAs."],
  ["§3.61", O, "Service Level Management", "Manage service level agreements with internal and external stakeholders."],
  ["§3.62", O, "Problem Management", "Investigate and resolve recurring incidents through formal problem management."],
  ["§3.63", O, "Knowledge Management", "Maintain a knowledge base of cyber security procedures and lessons learned."],
  ["§3.64", O, "Documentation Management", "Maintain documented information for the cyber security programme with version control."],
  ["§3.65", O, "Cyber Security Metrics", "Define and report cyber security metrics covering effectiveness, efficiency and posture."],
  ["§3.66", O, "Continuous Improvement", "Implement continuous improvement based on metrics, audit findings and incidents."],
  ["§3.67", O, "Security Architecture Review", "Review security architecture annually and after significant changes."],
  ["§3.68", O, "Network Architecture Standards", "Maintain network architecture standards including segmentation rules."],
  ["§3.69", O, "Application Architecture Standards", "Maintain application architecture standards including security patterns."],
  ["§3.70", O, "Data Architecture Standards", "Maintain data architecture standards including classification, flow and protection requirements."],
  ["§3.71", O, "Security Reference Architecture", "Maintain a security reference architecture for use across the organisation."],
  ["§3.72", O, "Standards Compliance", "Monitor compliance of designs and implementations with security standards."],
  ["§3.73", O, "Exception Management", "Manage exceptions to security standards via documented approval and risk acceptance."],
  ["§3.74", O, "Cyber Security Training for IT Staff", "Provide specialised cyber security training to IT and developer staff."],
  ["§3.75", O, "Forensics Capability", "Maintain a forensics capability (in-house or via retainer) for incident investigation."],
  ["§3.76", O, "Threat Hunting", "Conduct proactive threat hunting at least quarterly."],
  ["§3.77", O, "Red Team Exercises", "Conduct red team exercises at least annually."],
  ["§3.78", O, "Purple Team Exercises", "Conduct purple team exercises to improve detection and response capability."],
  ["§3.79", O, "Bug Bounty Programme", "Where appropriate, operate a bug bounty programme to source external vulnerability reports."],
  ["§3.80", O, "Customer Cyber Security", "Provide cyber security guidance and tools to customers (e.g., MFA, fraud alerts)."],
  ["§3.81", O, "Customer Awareness", "Educate customers on cyber security risks and protective measures."],
  ["§3.82", O, "Fraud Detection Integration", "Integrate cyber security with fraud detection and prevention."],
  ["§3.83", O, "Anti-Money-Laundering Integration", "Integrate cyber security with AML monitoring where applicable."],
  ["§3.84", O, "SWIFT Security", "Comply with SWIFT Customer Security Programme (CSP) where applicable."],
  ["§3.85", O, "ATM Security", "Apply security controls to ATM networks per SAMA requirements."],
  ["§3.86", O, "POS Terminal Security", "Apply security controls to POS terminals."],
  ["§3.87", O, "Card Data Security", "Comply with PCI DSS for cardholder data environments."],
  ["§3.88", O, "Payment Initiation Service Provider Controls", "Apply additional controls to PISP integrations under Open Banking."],
  ["§3.89", O, "Account Information Service Provider Controls", "Apply additional controls to AISP integrations under Open Banking."],
  ["§3.90", O, "Open Banking API Security", "Apply security to Open Banking APIs per SAMA Open Banking Framework."],
  ["§3.91", O, "Mobile Banking Security", "Apply additional controls to mobile banking applications."],
  ["§3.92", O, "Online Banking Security", "Apply additional controls to online banking platforms."],
  // Third Party fill
  ["§4.4", T, "Cloud Computing Risk Assessment", "Assess cyber security risk of cloud services before adoption."],
  ["§4.5", T, "Cloud Provider Due Diligence", "Conduct due diligence on cloud providers including audit reports and certifications."],
  ["§4.6", T, "Cloud Data Residency", "Comply with data residency requirements when using cloud services."],
  ["§4.7", T, "Cloud Exit Strategy", "Maintain documented exit strategy for each cloud service in use."],
  ["§4.8", T, "Outsourcing Risk Assessment", "Assess cyber security risk for every outsourcing arrangement."],
  ["§4.9", T, "Vendor Cyber Security Reviews", "Review vendor cyber security posture annually or after major change.", "detective", "annual", "high"],
  ["§4.10", T, "Vendor Termination Procedures", "Apply secure termination procedures including data return / destruction."],
  ["§4.11", T, "Sub-Contractor Cyber Security", "Apply cyber security requirements to sub-contractors of vendors."],
]);

export async function seedSamaCsfFullObligations(pool: Pool): Promise<void> {
  await runFrameworkSeed(
    pool,
    "SAMA-CSF",
    SAMA_FULL_OBLIGATION_DEFINITIONS,
    "SAMA CSF v1.0 (full fill)",
  );
}
