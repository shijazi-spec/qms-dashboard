/**
 * PCI DSS v4.0 priority-control seed (78 controls).
 *
 * Source: PCI Security Standards Council, PCI DSS v4.0 (March 2022).
 * Descriptions are paraphrased summaries — not verbatim PCI text — for
 * dashboard display. Compliance officers may edit any seeded row via
 * the standard obligations UI.
 *
 * Coverage strategy: the full PCI DSS v4.0 has 12 requirements with
 * ~251 sub-requirements. This seed covers the 78 sub-requirements most
 * commonly tracked by QSAs as "Priority Approach" items — sufficient
 * for most dashboard and gap-analysis use cases. Organisations that
 * are PCI-assessed should extend the seed to their full SAQ scope.
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
];

function build(
  domain: string,
  startOrder: number,
  rows: Tuple[],
): ObligationDef[] {
  return rows.map((r, idx) => {
    const [sub, title, desc, ctrl, freq, priority] = r;
    return {
      code: `PCI-DSS-${sub}`,
      clause: `Req. ${sub}`,
      domain,
      order: startOrder + idx,
      title,
      desc,
      type: "mandatory",
      ctrl: ctrl ?? "preventive",
      freq: freq ?? "annual",
      priority: priority ?? "high",
      dept: "PCI Security / IT",
      evidence: `Documented control or evidence of operation for ${sub} per QSA expectations.`,
    };
  });
}

export const PCIDSS_OBLIGATION_DEFINITIONS: ObligationDef[] = [
  ...build("Req. 1 — Network Security Controls", 100, [
    ["1.1.1", "NSC processes documented and known", "Maintain documented processes for network security controls (NSC)."],
    ["1.2.1", "Configuration standards for NSC", "Define configuration standards for NSC reviewed at least every 6 months."],
    ["1.2.5", "Approved services and protocols", "All services, protocols and ports are documented, approved and have business justification."],
    ["1.2.6", "Inbound/outbound traffic restricted", "Restrict inbound and outbound traffic to and from the cardholder data environment (CDE)."],
    ["1.3.1", "Inbound CDE traffic limited", "Limit inbound traffic to the CDE to that which is necessary."],
    ["1.3.2", "Outbound CDE traffic limited", "Limit outbound traffic from the CDE to that which is necessary."],
    ["1.4.1", "NSC between trusted and untrusted networks", "Implement NSC between trusted and untrusted networks (e.g., perimeter firewall)."],
    ["1.4.4", "Anti-spoofing measures", "Implement anti-spoofing measures to detect and block forged source IP addresses."],
    ["1.5.1", "Mobile/personal device access controls", "Apply controls to mobile and BYOD devices accessing the CDE."],
  ]),
  ...build("Req. 2 — Secure Configurations", 200, [
    ["2.1.1", "System hardening processes documented", "Maintain documented processes for hardening system components."],
    ["2.2.1", "Configuration standards address vulnerabilities", "Configuration standards address known security vulnerabilities (e.g., CIS, NIST baselines)."],
    ["2.2.2", "Vendor defaults changed", "Change vendor-supplied defaults including passwords before deploying systems on the network.", "preventive", "event_driven", "critical"],
    ["2.2.3", "Primary functions per system", "Each system performs only one primary function or appropriate isolation is in place."],
    ["2.2.6", "System security parameters configured", "System security parameters are configured to prevent misuse."],
    ["2.2.7", "Non-console admin access encrypted", "All non-console administrative access uses strong cryptography."],
    ["2.3.1", "Wireless vendor defaults changed", "Wireless device vendor defaults (keys, SNMP strings, passwords) are changed before deployment."],
  ]),
  ...build("Req. 3 — Protect Stored Account Data", 300, [
    ["3.2.1", "Account data retention policy", "Account data retention/disposal policy keeps data only as long as required and securely deletes when no longer needed.", "preventive", "annual", "critical"],
    ["3.3.1", "Sensitive auth data not stored after authorization", "Do not retain sensitive authentication data (CVV, PIN, magnetic stripe) after authorisation."],
    ["3.4.1", "PAN masked when displayed", "PAN is masked when displayed; full PAN visible only to those with legitimate business need.", "preventive", "continuous", "critical"],
    ["3.5.1", "PAN rendered unreadable when stored", "PAN is rendered unreadable wherever stored (truncation, hashing, tokenisation, strong cryptography)."],
    ["3.6.1", "Cryptographic keys protected", "Cryptographic keys used to protect stored account data are protected against disclosure and misuse."],
    ["3.7.1", "Key management — lifecycle", "Key management policies and procedures cover the full key life-cycle."],
    ["3.7.2", "Key management — strong key generation", "Cryptographic keys are generated using strong cryptography."],
    ["3.7.4", "Key management — key changes", "Cryptographic keys are changed at end of cryptoperiod or upon key compromise."],
  ]),
  ...build("Req. 4 — Protect Cardholder Data in Transit", 400, [
    ["4.2.1", "PAN encryption in transit over open networks", "Strong cryptography and security protocols protect PAN during transmission over open public networks.", "preventive", "continuous", "critical"],
    ["4.2.1.1", "Trusted keys/certificates inventory", "Maintain inventory of trusted keys and certificates."],
    ["4.2.2", "PAN never sent unprotected via end-user messaging", "PAN is never sent via end-user messaging technologies (email, SMS, IM) without strong cryptography."],
  ]),
  ...build("Req. 5 — Anti-Malware", 500, [
    ["5.2.1", "Anti-malware deployed", "Deploy anti-malware on all system components commonly affected by malware."],
    ["5.2.2", "Anti-malware up to date", "Anti-malware definitions/signatures are kept current."],
    ["5.2.3", "Anti-malware monitored", "Anti-malware solutions actively running and monitored; alerts generated."],
    ["5.3.1", "Anti-phishing controls", "Anti-phishing mechanisms in place (technical and procedural)."],
  ]),
  ...build("Req. 6 — Develop & Maintain Secure Systems", 600, [
    ["6.2.1", "Software developed securely", "Bespoke and custom software is developed securely (secure SDLC)."],
    ["6.2.4", "Secure coding training", "Software developers receive training in secure coding."],
    ["6.3.1", "Vulnerabilities identified and prioritised", "Security vulnerabilities are identified and risk-ranked."],
    ["6.3.3", "Security patches installed", "All system components are protected from known vulnerabilities by installing applicable security patches; critical patches within one month."],
    ["6.4.1", "Public-facing web app vulnerabilities reviewed", "Public-facing web applications are reviewed for vulnerabilities at least annually and after material change.", "detective", "annual", "high"],
    ["6.4.3", "Payment-page scripts inventoried", "All payment-page scripts loaded and executed in the consumer's browser are inventoried, justified and have integrity assurance."],
    ["6.5.1", "Changes to systems controlled", "Changes to system components are managed via formal change management."],
    ["6.5.2", "Changes verified before completion", "Upon change completion, all relevant PCI DSS requirements are verified to apply to changed systems."],
    ["6.5.5", "Pre-prod and prod environments separated", "Pre-production environments are separated from production with documented access controls."],
  ]),
  ...build("Req. 7 — Restrict Access by Need-to-Know", 700, [
    ["7.2.1", "Access control model based on roles", "Access control model defines access based on job classification and function."],
    ["7.2.2", "Access assigned by role/function", "Access to system components and cardholder data is assigned based on individual personnel's job classification and function.", "preventive", "continuous", "critical"],
    ["7.2.4", "User access reviewed periodically", "User access reviewed at least every six months.", "detective", "quarterly", "high"],
    ["7.2.5", "Application/system accounts identified", "Application and system accounts and their access privileges are identified and managed."],
  ]),
  ...build("Req. 8 — Identify Users and Authenticate Access", 800, [
    ["8.2.1", "Unique user IDs", "All users assigned a unique ID before allowed access to system components.", "preventive", "continuous", "critical"],
    ["8.2.2", "Group/shared/generic IDs only when necessary", "Group, shared, generic, system or default accounts are used only when necessary."],
    ["8.2.4", "Access removed for terminated users", "Access for terminated users is immediately revoked."],
    ["8.3.1", "Authentication factors required", "All user access requires authentication using at least one factor (password/passphrase, MFA token, biometric)."],
    ["8.3.6", "Strong password requirements", "Passwords/passphrases meet minimum strength requirements (length, complexity)."],
    ["8.3.7", "Password reuse prohibited", "Individuals submitting a new password cannot use any of the last four passwords."],
    ["8.4.1", "MFA for all non-console admin access", "MFA is required for all non-console administrative access into the CDE."],
    ["8.4.2", "MFA for all access into CDE", "MFA is required for all access into the CDE."],
    ["8.5.1", "MFA implemented securely", "MFA systems are configured to prevent bypass and replay; require all factors before access granted."],
  ]),
  ...build("Req. 9 — Restrict Physical Access", 900, [
    ["9.2.1", "Physical access controls in place", "Appropriate facility entry controls limit and monitor physical access to systems in the CDE."],
    ["9.2.2", "Visitor access controls", "Procedures developed to easily distinguish visitors from on-site personnel."],
    ["9.4.1", "Media physically secured", "All media physically secured."],
    ["9.4.5", "Media inventory", "Inventory logs of all electronic media are maintained."],
    ["9.4.6", "Hardcopy materials destroyed", "Hardcopy materials are destroyed when no longer needed for business or legal reasons."],
    ["9.4.7", "Electronic media destroyed", "Electronic media is rendered unrecoverable when no longer needed."],
    ["9.5.1", "POI device protections", "POI devices are protected from tampering and unauthorised substitution."],
  ]),
  ...build("Req. 10 — Logging and Monitoring", 1000, [
    ["10.2.1", "Audit logs enabled for all systems", "Audit logs enabled and active for all system components and cardholder data.", "detective", "continuous", "critical"],
    ["10.2.2", "Audit log content sufficient", "Audit logs include user identification, event type, timestamp, success/failure, origination."],
    ["10.3.1", "Audit log access restricted", "Read access to audit logs limited to those with a job-related need."],
    ["10.3.3", "Audit log files protected from modification", "Audit log files are protected from modification."],
    ["10.4.1", "Audit logs reviewed daily", "All security events / logs of CDE components are reviewed at least daily.", "detective", "daily", "high"],
    ["10.5.1", "Audit logs retained ≥ 12 months", "Audit log history retained for at least 12 months with at least 3 months immediately available for analysis."],
    ["10.6.1", "Time synchronisation in place", "Time synchronisation technology used and time synchronised across all in-scope systems."],
    ["10.7.1", "Failures of critical security control systems detected and reported", "Failures of critical security control systems (firewalls, IDS, anti-malware, log mechanisms) are detected, alerted and addressed promptly."],
  ]),
  ...build("Req. 11 — Test Security of Systems", 1100, [
    ["11.2.1", "Wireless rogue access point detection", "Wireless rogue access points detected and identified."],
    ["11.3.1", "Internal vulnerability scans", "Internal vulnerability scans performed at least quarterly and after significant change.", "detective", "quarterly", "critical"],
    ["11.3.2", "External vulnerability scans by ASV", "External vulnerability scans by an Approved Scanning Vendor (ASV) at least quarterly."],
    ["11.4.1", "Penetration testing methodology", "External and internal penetration testing methodology defined, documented and implemented."],
    ["11.4.2", "Internal pentest annually", "Internal penetration testing performed at least annually and after significant infrastructure change."],
    ["11.4.3", "External pentest annually", "External penetration testing performed at least annually and after significant infrastructure change.", "detective", "annual", "critical"],
    ["11.5.1", "IDS/IPS detect intrusion", "Intrusion-detection/prevention techniques detect or prevent intrusions into the network."],
    ["11.6.1", "Change-and-tamper detection on payment pages", "Change-and-tamper detection mechanism deployed on payment pages."],
  ]),
  ...build("Req. 12 — Information Security Policy & Programme", 1200, [
    ["12.1.1", "Information security policy established", "Information security policy established, approved by management and disseminated.", "preventive", "annual", "critical"],
    ["12.1.2", "Policy reviewed annually", "Information security policy reviewed at least once every 12 months and updated as needed."],
    ["12.3.1", "Targeted risk analysis for PCI", "A targeted risk analysis is performed for each PCI DSS requirement that the entity meets via a customised approach."],
    ["12.5.1", "PCI DSS scope documented", "Scope of PCI DSS documented including all locations and flows of cardholder data."],
    ["12.5.2", "Scope confirmed annually", "PCI DSS scope is documented and confirmed at least once every 12 months and after material change."],
    ["12.6.1", "Security awareness programme", "A formal security awareness programme is implemented to make all personnel aware of the cardholder data security policy."],
    ["12.6.3", "Security awareness training upon hire and annually", "Personnel receive security awareness training upon hire and at least annually."],
    ["12.7.1", "Personnel screening", "Potential personnel are screened prior to hire to minimise risk of attacks from internal sources."],
    ["12.8.1", "Service provider list maintained", "Maintain a list of service providers with which cardholder data is shared."],
    ["12.8.2", "Service provider PCI compliance monitored", "Maintain written agreement with service providers acknowledging their PCI DSS responsibility."],
    ["12.10.1", "Incident response plan documented", "Documented incident response plan addresses PCI-specific scenarios.", "corrective", "annual", "critical"],
    ["12.10.4", "IRT trained at least annually", "IRT personnel are trained at least annually on incident response."],
    ["12.10.5", "Alerts from monitoring systems integrated", "Alerts from intrusion detection/prevention, anti-malware, change-detection and other monitoring systems are integrated into the response process."],
  ]),
];

export async function seedPciDssObligations(pool: Pool): Promise<void> {
  await runFrameworkSeed(
    pool,
    "PCI-DSS",
    PCIDSS_OBLIGATION_DEFINITIONS,
    "PCI DSS v4.0 (priority subset)",
  );
}
