/**
 * SOC 2 Trust Services Criteria (TSC) seed.
 *
 * Source: AICPA Trust Services Criteria (2017, incl. 2022 revised points of
 * focus). Descriptions here are PARAPHRASED SUMMARIES for dashboard display —
 * NOT verbatim AICPA text, which is copyrighted. Same convention as every other
 * framework seed in this directory. Compliance officers may edit any seeded row
 * through the standard obligations UI without breaking the seed.
 *
 * STRUCTURE — the TSC are presented as:
 *   Common Criteria (CC1-CC9)  — required for every SOC 2 report (Security)
 *   A1  Availability           — optional category
 *   C1  Confidentiality        — optional category
 *   PI1 Processing Integrity   — optional category
 *   P1-P8 Privacy              — optional category
 *
 * ORDERING — `order` (→ obligations.section_order) is banded so the Common
 * Criteria come first and the category criteria follow, which is how the TSC
 * document presents them. This matters because section_order is the PRIMARY
 * sort for clause lists: a purely numeric key would put "A1.1" before "CC1.1"
 * alphabetically, which is not how anyone reads SOC 2. See utils/clauseSortKey.ts.
 *
 * Bands: CC1=100, CC2=200 … CC9=900, A1=1000, C1=1100, PI1=1200, P1..P8=1300+.
 */

import type { Pool } from "pg";
import { runFrameworkSeed, type ObligationDef } from "./obligationSeedTypes";

type Tuple = [
  string, // criterion, e.g. "CC6.1"
  string, // title
  string, // paraphrased description
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
    const [crit, title, desc, ctrl, freq, priority] = r;
    return {
      code: `SOC2-${crit}`,
      clause: crit,
      domain,
      order: startOrder + idx,
      title,
      desc,
      type: "mandatory",
      ctrl: ctrl ?? "preventive",
      freq: freq ?? "annual",
      priority: priority ?? "high",
      dept: "GRC / Information Security",
      evidence: `Documented policy, procedure or system record demonstrating that criterion ${crit} operates.`,
    };
  });
}

export const SOC2_OBLIGATION_DEFINITIONS: ObligationDef[] = [
  ...build("CC1 Control Environment", 100, [
    ["CC1.1", "Commitment to integrity and ethical values", "The entity demonstrates a commitment to integrity and ethical values, including a code of conduct that personnel acknowledge."],
    ["CC1.2", "Board independence and oversight", "The board of directors operates independently of management and exercises oversight of internal control."],
    ["CC1.3", "Structures, reporting lines and authority", "Management establishes organisational structures, reporting lines, and appropriate authorities and responsibilities."],
    ["CC1.4", "Commitment to competence", "The entity attracts, develops and retains competent personnel aligned to its objectives."],
    ["CC1.5", "Accountability for internal control", "Individuals are held accountable for their internal control responsibilities."],
  ]),
  ...build("CC2 Communication and Information", 200, [
    ["CC2.1", "Quality information for internal control", "The entity obtains or generates relevant, quality information to support the functioning of internal control.", "detective"],
    ["CC2.2", "Internal communication of responsibilities", "Internal control objectives and responsibilities are communicated internally, including to those responsible for security."],
    ["CC2.3", "External communication", "The entity communicates with external parties about matters affecting internal control, including commitments and system requirements."],
  ]),
  ...build("CC3 Risk Assessment", 300, [
    ["CC3.1", "Objectives specified for risk assessment", "Objectives are specified with sufficient clarity to enable identification and assessment of related risks."],
    ["CC3.2", "Risk identification and analysis", "Risks to the achievement of objectives are identified and analysed as a basis for determining how they should be managed.", "detective"],
    ["CC3.3", "Fraud risk considered", "The potential for fraud is considered when assessing risks to objectives.", "detective"],
    ["CC3.4", "Significant change assessed", "Changes that could significantly affect the system of internal control are identified and assessed.", "detective"],
  ]),
  ...build("CC4 Monitoring Activities", 400, [
    ["CC4.1", "Ongoing and separate evaluations", "Ongoing and/or separate evaluations determine whether internal control components are present and functioning.", "detective"],
    ["CC4.2", "Deficiencies evaluated and communicated", "Internal control deficiencies are evaluated and communicated in a timely manner to those responsible for corrective action.", "corrective"],
  ]),
  ...build("CC5 Control Activities", 500, [
    ["CC5.1", "Control activities selected and developed", "Control activities that contribute to the mitigation of risks to acceptable levels are selected and developed."],
    ["CC5.2", "Technology general controls", "General control activities over technology are selected and developed to support the achievement of objectives."],
    ["CC5.3", "Controls deployed through policy", "Control activities are deployed through policies that establish expectations and procedures that put those policies into action."],
  ]),
  ...build("CC6 Logical and Physical Access", 600, [
    ["CC6.1", "Logical access security architecture", "Logical access security software, infrastructure and architectures are implemented to protect information assets.", "preventive", "continuous", "critical"],
    ["CC6.2", "User registration and de-registration", "Prior to issuing credentials, users are registered and authorised; access is removed when no longer required.", "preventive", "continuous", "critical"],
    ["CC6.3", "Access rights based on least privilege", "Access to information assets is authorised, modified and removed based on roles, responsibilities and least privilege.", "preventive", "quarterly", "critical"],
    ["CC6.4", "Physical access restricted", "Access to physical facilities housing information assets is restricted to authorised personnel."],
    ["CC6.5", "Secure disposal of assets", "Physical and logical protections over assets are removed only after the ability to read data has been eliminated."],
    ["CC6.6", "External threat protection", "Security measures protect against threats from sources outside the system boundary.", "preventive", "continuous", "critical"],
    ["CC6.7", "Restricted transmission and movement of data", "Transmission, movement and removal of information is restricted to authorised users and protected in transit.", "preventive", "continuous", "critical"],
    ["CC6.8", "Malicious software prevention and detection", "Controls prevent or detect and act upon the introduction of unauthorised or malicious software.", "detective", "continuous"],
  ]),
  ...build("CC7 System Operations", 700, [
    ["CC7.1", "Vulnerability detection and configuration monitoring", "Detection and monitoring procedures identify configuration changes and new vulnerabilities.", "detective", "continuous"],
    ["CC7.2", "Anomaly monitoring", "System components are monitored for anomalies indicative of malicious acts, natural disasters and errors.", "detective", "continuous", "critical"],
    ["CC7.3", "Security event evaluation", "Security events are evaluated to determine whether they could or did result in a failure to meet objectives.", "detective"],
    ["CC7.4", "Incident response programme", "Identified security incidents are responded to through a defined incident response programme.", "corrective", "event_driven", "critical"],
    ["CC7.5", "Incident recovery", "The entity identifies, develops and implements activities to recover from identified security incidents.", "corrective", "event_driven"],
  ]),
  ...build("CC8 Change Management", 800, [
    ["CC8.1", "Change authorisation, design and implementation", "Changes to infrastructure, data, software and procedures are authorised, designed, developed, tested, approved and implemented under a change management process.", "preventive", "continuous", "critical"],
  ]),
  ...build("CC9 Risk Mitigation", 900, [
    ["CC9.1", "Business disruption risk mitigation", "The entity identifies, selects and develops risk mitigation activities for risks arising from potential business disruptions."],
    ["CC9.2", "Vendor and business partner risk", "The entity assesses and manages risks associated with vendors and business partners.", "detective"],
  ]),

  ...build("A1 Availability", 1000, [
    ["A1.1", "Capacity management", "Current processing capacity and use are maintained, monitored and evaluated to manage capacity demand and enable additional capacity.", "detective", "monthly"],
    ["A1.2", "Environmental protections and backup", "Environmental protections, software, data backup processes and recovery infrastructure are authorised, designed, developed, implemented, operated and maintained.", "preventive", "continuous", "critical"],
    ["A1.3", "Recovery plan testing", "Recovery plan procedures supporting system recovery are tested.", "detective"],
  ]),
  ...build("C1 Confidentiality", 1100, [
    ["C1.1", "Confidential information identified and maintained", "The entity identifies and maintains confidential information to meet its confidentiality objectives."],
    ["C1.2", "Confidential information disposed of", "Confidential information is disposed of to meet the entity's confidentiality objectives."],
  ]),
  ...build("PI1 Processing Integrity", 1200, [
    ["PI1.1", "Processing information quality communicated", "Information about the objectives and boundaries of the system and the quality of its processing is obtained and communicated."],
    ["PI1.2", "Inputs complete and accurate", "System inputs are processed completely, accurately and timely, and authorised as required.", "detective"],
    ["PI1.3", "Processing complete and accurate", "System processing is complete, valid, accurate, timely and authorised.", "detective"],
    ["PI1.4", "Outputs complete and accurate", "System output is complete, accurate, distributed and retained to meet processing integrity objectives.", "detective"],
    ["PI1.5", "Stored information retained completely", "Stored information is retained completely, accurately and in a timely manner."],
  ]),
  ...build("P Privacy", 1300, [
    ["P1.1", "Privacy notice provided", "The entity provides notice about the collection, use, retention, disclosure and disposal of personal information."],
    ["P2.1", "Choice and consent obtained", "The entity communicates choices available regarding personal information and obtains consent where required."],
    ["P3.1", "Personal information collected consistently with notice", "Personal information is collected consistently with the entity's privacy notice and objectives."],
    ["P3.2", "Explicit consent for sensitive information", "Explicit consent is obtained for sensitive personal information where required."],
    ["P4.1", "Use limited to stated purposes", "Personal information is used consistently with the entity's objectives and the purposes stated in its notice."],
    ["P4.2", "Retention limited", "Personal information is retained only as long as necessary to fulfil the stated purposes."],
    ["P4.3", "Secure disposal of personal information", "Personal information no longer required is disposed of securely."],
    ["P5.1", "Data subject access", "Data subjects are granted access to their personal information for review and update."],
    ["P5.2", "Correction and amendment", "Personal information is corrected, amended or appended on request from data subjects.", "corrective"],
    ["P6.1", "Disclosure with consent", "Personal information is disclosed to third parties only with the consent of the data subject or as required."],
    ["P6.2", "Record of authorised disclosures", "A record of authorised disclosures of personal information is created and retained.", "detective"],
    ["P6.3", "Record of unauthorised disclosures", "A record of detected or reported unauthorised disclosures of personal information is created and retained.", "detective"],
    ["P6.4", "Third-party privacy commitments", "Third parties to whom personal information is transferred are obliged to protect it consistently with the entity's commitments."],
    ["P6.5", "Third-party breach notification", "The entity obtains commitment from third parties to notify it of actual or suspected unauthorised disclosures.", "detective", "event_driven"],
    ["P6.6", "Breach notification to data subjects", "The entity provides notice of breaches and incidents to affected data subjects, regulators and others as required.", "corrective", "event_driven", "critical"],
    ["P6.7", "Accounting of personal information held", "The entity provides data subjects with an accounting of the personal information held and any disclosures made."],
    ["P7.1", "Personal information accurate and complete", "Personal information is accurate, up to date, complete and relevant for the purposes for which it is used.", "detective"],
    ["P8.1", "Privacy complaint and dispute handling", "A process is in place to address privacy-related inquiries, complaints and disputes.", "corrective"],
  ]),
];

export async function seedSoc2Obligations(pool: Pool): Promise<void> {
  await runFrameworkSeed(
    pool,
    "SOC2",
    SOC2_OBLIGATION_DEFINITIONS,
    "SOC 2 Trust Services Criteria",
  );
}
