/**
 * ISO 9001:2015 Quality Management System seed (50 clauses).
 *
 * Source: ISO 9001:2015. Descriptions are paraphrased summaries — not
 * verbatim ISO text — for dashboard display. Compliance officers may
 * edit any seeded row via the standard obligations UI.
 *
 * Coverage: clauses 4-10 broken down to the most-audited sub-clauses.
 */

import type { Pool } from "pg";
import { runFrameworkSeed, type ObligationDef } from "./obligationSeedTypes";

type Tuple = [
  string, // sub-clause, e.g. "4.1"
  string, // title
  string, // description
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
      code: `ISO9001-${sub}`,
      clause: `Cl. ${sub}`,
      domain,
      order: startOrder + idx,
      title,
      desc,
      type: "mandatory",
      ctrl: ctrl ?? "preventive",
      freq: freq ?? "annual",
      priority: priority ?? "high",
      dept: "Quality / Management",
      evidence: `Documented procedure or record showing implementation of clause ${sub}.`,
    };
  });
}

export const ISO9001_OBLIGATION_DEFINITIONS: ObligationDef[] = [
  ...build("4. Context of the Organization", 100, [
    ["4.1", "Understanding the organization and its context", "Determine external and internal issues relevant to the QMS purpose and strategic direction."],
    ["4.2", "Understanding the needs and expectations of interested parties", "Determine interested parties and their relevant requirements."],
    ["4.3", "Determining the scope of the QMS", "Define the boundaries and applicability of the QMS as documented information."],
    ["4.4.1", "QMS and its processes", "Establish, implement, maintain and continually improve a QMS including the processes needed and their interactions."],
    ["4.4.2", "Documented information for QMS processes", "Maintain documented information to support process operation and retain documented information to provide confidence the processes are carried out as planned."],
  ]),
  ...build("5. Leadership", 200, [
    ["5.1.1", "Leadership and commitment — General", "Top management demonstrates leadership and commitment with respect to the QMS."],
    ["5.1.2", "Customer focus", "Top management ensures customer and applicable statutory and regulatory requirements are determined, understood and consistently met."],
    ["5.2.1", "Establishing the quality policy", "Top management establishes, reviews and maintains a quality policy.", "preventive", "annual", "critical"],
    ["5.2.2", "Communicating the quality policy", "Quality policy is documented information, communicated, understood and applied."],
    ["5.3", "Organizational roles, responsibilities and authorities", "Top management assigns, communicates and understands responsibilities and authorities for relevant roles.", "preventive", "annual", "critical"],
  ]),
  ...build("6. Planning", 300, [
    ["6.1.1", "Actions to address risks and opportunities — Planning", "Determine risks and opportunities to give assurance the QMS can achieve intended results."],
    ["6.1.2", "Actions to address risks and opportunities — Implementation", "Plan actions to address these risks and opportunities and integrate them into QMS processes."],
    ["6.2.1", "Quality objectives at relevant functions", "Establish quality objectives at relevant functions, levels and processes needed for the QMS.", "preventive", "annual", "high"],
    ["6.2.2", "Plans to achieve quality objectives", "Plan how to achieve quality objectives (what, who, when, how, evaluated)."],
    ["6.3", "Planning of changes", "When the need for change to the QMS is determined, the change is carried out in a planned manner."],
  ]),
  ...build("7. Support", 400, [
    ["7.1.1", "Resources — General", "Determine and provide resources needed for the QMS."],
    ["7.1.2", "People", "Determine and provide persons necessary for QMS effectiveness and process operation."],
    ["7.1.3", "Infrastructure", "Provide and maintain infrastructure necessary for process operation and conformity of products and services."],
    ["7.1.4", "Environment for the operation of processes", "Provide a suitable environment for process operation."],
    ["7.1.5.1", "Monitoring and measuring resources — General", "Provide resources to ensure valid and reliable monitoring/measuring results."],
    ["7.1.5.2", "Measurement traceability", "Where measurement traceability is required, calibrate or verify measurement equipment at specified intervals.", "detective", "quarterly", "high"],
    ["7.1.6", "Organizational knowledge", "Determine, maintain and make available the knowledge necessary for the operation of processes."],
    ["7.2", "Competence", "Determine necessary competence; ensure competence; retain documented information as evidence.", "preventive", "annual", "high"],
    ["7.3", "Awareness", "Persons doing work under the organisation's control are aware of the quality policy, objectives, contribution and implications of nonconformity."],
    ["7.4", "Communication", "Determine internal and external communications relevant to the QMS."],
    ["7.5.1", "Documented information — General", "QMS includes documented information required by the standard and necessary for QMS effectiveness."],
    ["7.5.2", "Creating and updating documented information", "Ensure appropriate identification, format, review and approval of documented information."],
    ["7.5.3", "Control of documented information", "Documented information is controlled to ensure availability, suitability, protection."],
  ]),
  ...build("8. Operation", 500, [
    ["8.1", "Operational planning and control", "Plan, implement and control the processes needed to meet requirements for the provision of products and services.", "preventive", "continuous", "high"],
    ["8.2.1", "Customer communication", "Communications with customers including product/service info, contracts, feedback, complaints, contingency."],
    ["8.2.2", "Determining requirements for products and services", "Determine requirements including any not stated by customer but necessary for use, statutory/regulatory, and additional requirements."],
    ["8.2.3", "Review of requirements for products and services", "Review requirements before commitment to supply."],
    ["8.2.4", "Changes to requirements for products and services", "Amend documented information when requirements change; ensure relevant persons are aware."],
    ["8.3", "Design and development of products and services", "Establish, implement and maintain a design-and-development process appropriate to ensure subsequent provision of products and services.", "preventive", "event_driven", "high"],
    ["8.4.1", "Control of externally provided processes, products and services — General", "Ensure externally provided processes, products and services conform to requirements."],
    ["8.4.2", "Type and extent of control", "Determine controls applied to external providers and their outputs."],
    ["8.4.3", "Information for external providers", "Communicate requirements to external providers."],
    ["8.5.1", "Control of production and service provision", "Implement production and service provision under controlled conditions."],
    ["8.5.2", "Identification and traceability", "Use suitable means to identify outputs and traceability where required."],
    ["8.5.3", "Property belonging to customers or external providers", "Exercise care with property belonging to customers or external providers."],
    ["8.5.4", "Preservation", "Preserve outputs during production and service provision to maintain conformity."],
    ["8.5.5", "Post-delivery activities", "Meet requirements for post-delivery activities associated with products and services."],
    ["8.5.6", "Control of changes", "Review and control changes for production or service provision to maintain conformity."],
    ["8.6", "Release of products and services", "Implement planned arrangements at appropriate stages to verify product/service requirements have been met.", "detective", "continuous", "high"],
    ["8.7", "Control of nonconforming outputs", "Identify and control outputs that do not conform to requirements to prevent unintended use or delivery.", "corrective", "continuous", "critical"],
  ]),
  ...build("9. Performance Evaluation", 600, [
    ["9.1.1", "Monitoring, measurement, analysis and evaluation — General", "Determine what needs monitoring/measuring, methods, when, and when results are analysed."],
    ["9.1.2", "Customer satisfaction", "Monitor customers' perceptions of the degree to which their needs and expectations have been fulfilled.", "detective", "quarterly", "high"],
    ["9.1.3", "Analysis and evaluation", "Analyse and evaluate appropriate data and information arising from monitoring and measurement."],
    ["9.2", "Internal audit", "Conduct internal audits at planned intervals to determine if the QMS conforms to requirements.", "detective", "annual", "critical"],
    ["9.3", "Management review", "Top management reviews the QMS at planned intervals to ensure its continuing suitability, adequacy, effectiveness and alignment.", "detective", "annual", "critical"],
  ]),
  ...build("10. Improvement", 700, [
    ["10.1", "Improvement — General", "Determine and select opportunities for improvement and implement actions to meet customer requirements and enhance customer satisfaction."],
    ["10.2", "Nonconformity and corrective action", "React to nonconformity, take action to control and correct, evaluate the need for action to eliminate the cause(s).", "corrective", "continuous", "critical"],
    ["10.3", "Continual improvement", "Continually improve the suitability, adequacy and effectiveness of the QMS."],
  ]),
];

export async function seedISO9001Obligations(pool: Pool): Promise<void> {
  await runFrameworkSeed(
    pool,
    "ISO-9001",
    ISO9001_OBLIGATION_DEFINITIONS,
    "ISO 9001:2015",
  );
}
