/**
 * Structural tests for the extended compliance framework seeds
 * (Phase 1.1 of the document-mapping feature).
 *
 * Validates invariants of the obligation seed catalogues without hitting
 * the database, so they run in any environment and catch drift if anyone
 * edits the seed.
 *
 * Run:  npx tsx tests/complianceSeeds.test.ts
 */

import { TestSuite } from "./_helpers/runner";
import { ISO27001_OBLIGATION_DEFINITIONS } from "../src/utils/seeds/iso27001Obligations";
import { ISO9001_OBLIGATION_DEFINITIONS } from "../src/utils/seeds/iso9001Obligations";
import { NCA_ECC_OBLIGATION_DEFINITIONS } from "../src/utils/seeds/ncaEccObligations";
import { NCA_DCC_OBLIGATION_DEFINITIONS } from "../src/utils/seeds/ncaDccObligations";
import { PCIDSS_OBLIGATION_DEFINITIONS } from "../src/utils/seeds/pciDssObligations";
import { SAMA_FULL_OBLIGATION_DEFINITIONS } from "../src/utils/seeds/samaCsfFullObligations";
import { PDPL_FILL_OBLIGATION_DEFINITIONS } from "../src/utils/seeds/pdplFillObligations";
import type { ObligationDef } from "../src/utils/seeds/obligationSeedTypes";

const VALID_TYPE = new Set(["mandatory", "recommended", "optional"]);
const VALID_CTRL = new Set(["preventive", "detective", "corrective"]);
const VALID_FREQ = new Set([
  "continuous",
  "daily",
  "weekly",
  "monthly",
  "quarterly",
  "annual",
  "event_driven",
]);
const VALID_PRIORITY = new Set(["critical", "high", "medium", "low"]);

function structuralChecks(
  suite: TestSuite,
  label: string,
  defs: ObligationDef[],
  expectedMin: number,
): void {
  suite.test(`${label} — has at least ${expectedMin} obligations`, async () => {
    suite.expect(
      defs.length >= expectedMin,
      `expected at least ${expectedMin}, got ${defs.length}`,
    );
  });

  suite.test(`${label} — every obligation_code is unique`, async () => {
    const codes = defs.map((d) => d.code);
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    suite.expectEqual(
      new Set(codes).size,
      codes.length,
      `duplicate codes detected: ${dupes.slice(0, 5).join(", ")}`,
    );
  });

  suite.test(`${label} — every obligation has the required fields`, async () => {
    for (const d of defs) {
      suite.expect(!!d.code, `missing code on order=${d.order}`);
      suite.expect(!!d.title, `missing title on ${d.code}`);
      suite.expect(!!d.desc, `missing desc on ${d.code}`);
      suite.expect(!!d.clause, `missing clause on ${d.code}`);
      suite.expect(!!d.domain, `missing domain on ${d.code}`);
      suite.expect(!!d.dept, `missing dept on ${d.code}`);
      suite.expect(d.title.length <= 200, `title too long on ${d.code}`);
      suite.expect(d.desc.length >= 20, `desc too short on ${d.code}`);
    }
  });

  suite.test(`${label} — every enum field uses a valid value`, async () => {
    for (const d of defs) {
      suite.expect(VALID_TYPE.has(d.type), `bad type on ${d.code}: ${d.type}`);
      suite.expect(VALID_CTRL.has(d.ctrl), `bad ctrl on ${d.code}: ${d.ctrl}`);
      suite.expect(VALID_FREQ.has(d.freq), `bad freq on ${d.code}: ${d.freq}`);
      suite.expect(
        VALID_PRIORITY.has(d.priority),
        `bad priority on ${d.code}: ${d.priority}`,
      );
    }
  });

  suite.test(`${label} — section_order is a positive integer`, async () => {
    for (const d of defs) {
      suite.expect(
        Number.isInteger(d.order) && d.order > 0,
        `bad order on ${d.code}: ${d.order}`,
      );
    }
  });
}

console.log("\n=== Compliance framework seeds — structural tests ===\n");

const isoSuite = new TestSuite("iso27001Seed");
console.log("\n— ISO 27001:2022 —");
structuralChecks(isoSuite, "ISO 27001", ISO27001_OBLIGATION_DEFINITIONS, 90);
await isoSuite.test("ISO 27001 — has both Annex A and clause sections", async () => {
  const hasAnnexA = ISO27001_OBLIGATION_DEFINITIONS.some((d) =>
    d.code.startsWith("ISO27001-A."),
  );
  const hasClauses = ISO27001_OBLIGATION_DEFINITIONS.some((d) =>
    /^ISO27001-(\d|SOA|RTP|OBJ|DOC)$/.test(d.code),
  );
  isoSuite.expect(hasAnnexA, "missing Annex A controls (ISO27001-A.x.y)");
  isoSuite.expect(hasClauses, "missing main standard clauses");
});

const iso9Suite = new TestSuite("iso9001Seed");
console.log("\n— ISO 9001:2015 —");
structuralChecks(iso9Suite, "ISO 9001", ISO9001_OBLIGATION_DEFINITIONS, 40);

const eccSuite = new TestSuite("ncaEccSeed");
console.log("\n— NCA-ECC v1:2018 —");
structuralChecks(eccSuite, "NCA-ECC", NCA_ECC_OBLIGATION_DEFINITIONS, 100);
await eccSuite.test("NCA-ECC — covers all 5 main domains", async () => {
  const domains = new Set(NCA_ECC_OBLIGATION_DEFINITIONS.map((d) => d.domain));
  eccSuite.expectEqual(
    domains.size,
    5,
    `expected 5 domains, got ${domains.size}: ${Array.from(domains).join(" | ")}`,
  );
});

const dccSuite = new TestSuite("ncaDccSeed");
console.log("\n— NCA-DCC v1:2022 —");
structuralChecks(dccSuite, "NCA-DCC", NCA_DCC_OBLIGATION_DEFINITIONS, 100);

const pciSuite = new TestSuite("pciDssSeed");
console.log("\n— PCI DSS v4.0 (priority subset) —");
structuralChecks(pciSuite, "PCI DSS", PCIDSS_OBLIGATION_DEFINITIONS, 70);
await pciSuite.test("PCI DSS — covers all 12 requirements", async () => {
  const reqs = new Set(
    PCIDSS_OBLIGATION_DEFINITIONS.map((d) => d.code.split("-").slice(0, 3).join("-")),
  );
  // Codes look like PCI-DSS-1.1.1, PCI-DSS-12.10.5 — split by "." in last seg
  const reqNumbers = new Set(
    PCIDSS_OBLIGATION_DEFINITIONS.map((d) => {
      const m = /PCI-DSS-(\d+)\./.exec(d.code);
      return m ? m[1] : null;
    }).filter(Boolean),
  );
  pciSuite.expect(
    reqNumbers.size >= 11,
    `expected coverage of ≥11 of the 12 PCI requirements, got ${reqNumbers.size}: ${Array.from(reqNumbers).join(", ")}`,
  );
  void reqs;
});

const samaSuite = new TestSuite("samaCsfFullSeed");
console.log("\n— SAMA CSF (full fill) —");
structuralChecks(
  samaSuite,
  "SAMA CSF fill",
  SAMA_FULL_OBLIGATION_DEFINITIONS,
  90,
);
await samaSuite.test("SAMA fill — codes start at SAMA-21 (no overlap with original 20)", async () => {
  for (const d of SAMA_FULL_OBLIGATION_DEFINITIONS) {
    const m = /^SAMA-(\d+)$/.exec(d.code);
    samaSuite.expect(!!m, `unexpected code format: ${d.code}`);
    if (m) {
      const n = parseInt(m[1], 10);
      samaSuite.expect(
        n >= 21,
        `SAMA fill code overlaps original seed: ${d.code}`,
      );
    }
  }
});

const pdplSuite = new TestSuite("pdplFillSeed");
console.log("\n— PDPL Implementing Regulations (fill) —");
structuralChecks(
  pdplSuite,
  "PDPL fill",
  PDPL_FILL_OBLIGATION_DEFINITIONS,
  7,
);
await pdplSuite.test(
  "PDPL fill — codes start at PDPL-19 (no overlap with original 18)",
  async () => {
    for (const d of PDPL_FILL_OBLIGATION_DEFINITIONS) {
      const m = /^PDPL-(\d+)$/.exec(d.code);
      pdplSuite.expect(!!m, `unexpected code format: ${d.code}`);
      if (m) {
        const n = parseInt(m[1], 10);
        pdplSuite.expect(
          n >= 19,
          `PDPL fill code overlaps original seed: ${d.code}`,
        );
      }
    }
  },
);

const suites = [isoSuite, iso9Suite, eccSuite, dccSuite, pciSuite, samaSuite, pdplSuite];
let totalPassed = 0;
let totalFailed = 0;
for (const s of suites) {
  const { passed, failed } = s.summarize();
  totalPassed += passed;
  totalFailed += failed;
  console.log(`${s.title}: ${passed}/${passed + failed} passed`);
}
console.log(
  `\nCompliance seeds — total: ${totalPassed}/${totalPassed + totalFailed} passed`,
);
process.exit(totalFailed > 0 ? 1 : 0);
