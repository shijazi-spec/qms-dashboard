# Certification Milestone Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the Certification Milestone Plan (GRQ-PLAN-2026-01 v3.0) into the QMS so `GRC-KPI-002` measures real milestone on-time delivery instead of document-mapping clause coverage.

**Architecture:** The `certification_milestones` table, the `calcCertMilestoneDelivery` calculator and a data-entry form already exist but were never fed. We extend the table with five columns, seed 16 rows from the plan document, repoint the KPI at the correct calculator, annotate the resulting baseline break, and surface milestones at the top of a renamed `/compliance` page. Calculation math is extracted into pure functions so it is unit-testable without a database.

**Tech Stack:** TypeScript · Hono routes (Mastra) · PostgreSQL (`pg`) · vanilla dashboard HTML/JS · vitest

**Spec:** `docs/superpowers/specs/2026-09-02-certification-milestone-plan-design.md`

## Global Constraints

- **Schema parity is STRICT.** Every `ALTER TABLE ... ADD COLUMN` must also appear in the canonical `CREATE TABLE`. `node scripts/check-schema-parity.mjs --strict` must pass.
- **i18n parity is enforced.** Every new UI string needs the same key in BOTH `dashboard/i18n/en.json` and `dashboard/i18n/ar.json`. `scripts/check-i18n.cjs` fails on key-tree divergence.
- **No inline event handlers** in dashboard HTML — use `data-on-click` / `data-on-change` (enforced by `scripts/check-no-inline-handlers.sh`).
- **Never query a bare `risks` table**; the register is `enterprise_risks`. (Unrelated to this work but a standing repo rule.)
- Tests run with `npx vitest run <path>`; there is no `vitest` npm script.
- Type check with `node node_modules/typescript/bin/tsc` (the repo's local tsc; `npx tsc` resolves to the wrong binary).
- Plan constants: `plan_version = "3.0"`, `source_doc = "GRQ-PLAN-2026-01"`.
- Date convention: month-only labels in the document become **end-of-month** dates. The single explicit date ("By 30 Aug 2026") stays `2026-08-30`.
- Commit after every task.

---

### Task 1: Milestone plan seed data (pure module)

Pure data + a pure validator. No database. This locks the 16 rows before anything consumes them.

**Files:**
- Create: `src/utils/seeds/certificationMilestonePlan.ts`
- Test: `tests/vitest/certificationMilestonePlan.vitest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MilestoneType = "plan" | "framework_target" | "dependency"`
  - `interface PlanMilestoneSeed { milestone_key: string; milestone_type: MilestoneType; certification: string; regulation_code: string | null; milestone_name: string; planned_date: string | null; owner: string; notes: string; }`
  - `const CERTIFICATION_MILESTONE_PLAN: PlanMilestoneSeed[]`
  - `const PLAN_VERSION = "3.0"`, `const SOURCE_DOC = "GRQ-PLAN-2026-01"`

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/certificationMilestonePlan.vitest.test.ts`:

```ts
/**
 * The Certification Milestone Plan seed mirrors GRQ-PLAN-2026-01 v3.0.
 * These assertions are the contract between the Word document and the DB.
 */
import { describe, it, expect } from "vitest";

import {
  CERTIFICATION_MILESTONE_PLAN as PLAN,
  PLAN_VERSION,
  SOURCE_DOC,
} from "../../src/utils/seeds/certificationMilestonePlan";

describe("certification milestone plan seed", () => {
  it("carries the source document provenance", () => {
    expect(PLAN_VERSION).toBe("3.0");
    expect(SOURCE_DOC).toBe("GRQ-PLAN-2026-01");
  });

  it("has 16 rows split 7 plan / 7 framework_target / 2 dependency", () => {
    expect(PLAN).toHaveLength(16);
    const by = (t: string) => PLAN.filter((r) => r.milestone_type === t).length;
    expect(by("plan")).toBe(7);
    expect(by("framework_target")).toBe(7);
    expect(by("dependency")).toBe(2);
  });

  it("has unique milestone keys", () => {
    const keys = PLAN.map((r) => r.milestone_key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every KPI-scoring plan row a planned date", () => {
    for (const r of PLAN.filter((x) => x.milestone_type === "plan")) {
      expect(r.planned_date, r.milestone_key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("leaves SOC 2 dateless — it is named in the intro but absent from the plan table", () => {
    const soc2 = PLAN.find((r) => r.milestone_key === "FT-SOC2")!;
    expect(soc2.milestone_type).toBe("framework_target");
    expect(soc2.planned_date).toBeNull();
  });

  it("splits NCA into ECC and DCC, both due April 2027", () => {
    const nca = PLAN.filter((r) => r.regulation_code?.startsWith("NCA-"));
    expect(nca.map((r) => r.regulation_code).sort()).toEqual(["NCA-DCC", "NCA-ECC"]);
    for (const r of nca) expect(r.planned_date).toBe("2027-04-30");
  });

  it("references only framework codes that exist in the platform", () => {
    const known = new Set([
      "PDPL", "SAMA-CSF", "NCA-ECC", "NCA-DCC",
      "ISO-9001", "ISO-27001", "SOC2", "PCI-DSS", "SACS-002",
    ]);
    for (const r of PLAN) {
      if (r.regulation_code !== null) {
        expect(known.has(r.regulation_code), r.regulation_code!).toBe(true);
      }
    }
  });

  it("honours the document's one explicit date", () => {
    expect(PLAN.find((r) => r.milestone_key === "PLAN-2026-08-DOCS")!.planned_date)
      .toBe("2026-08-30");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/certificationMilestonePlan.vitest.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/seeds/certificationMilestonePlan'`

- [ ] **Step 3: Write the seed module**

Create `src/utils/seeds/certificationMilestonePlan.ts`:

```ts
/**
 * Certification Milestone Plan — GRQ-PLAN-2026-01 v3.0 (24 Aug 2026).
 *
 * Mirrors the approved Word document. Three sections are stored, typed:
 *   - "plan"             §4 The plan            -> the ONLY rows that score GRC-KPI-002
 *   - "framework_target" §2 When we are compliant
 *   - "dependency"       §5 What we need from other departments
 *
 * Month-only labels in the document become end-of-month dates. The single
 * explicit date ("By 30 Aug 2026") is kept verbatim.
 */

export const PLAN_VERSION = "3.0";
export const SOURCE_DOC = "GRQ-PLAN-2026-01";

export type MilestoneType = "plan" | "framework_target" | "dependency";

export interface PlanMilestoneSeed {
  milestone_key: string;
  milestone_type: MilestoneType;
  /** Free-text label shown in the UI. */
  certification: string;
  /** regulations.regulation_code, or null when the row is not framework-specific. */
  regulation_code: string | null;
  milestone_name: string;
  /** ISO date, or null when the plan sets no date. */
  planned_date: string | null;
  owner: string;
  notes: string;
}

export const CERTIFICATION_MILESTONE_PLAN: PlanMilestoneSeed[] = [
  // ── §4 The plan — these drive the KPI ──────────────────────────────────
  {
    milestone_key: "PLAN-2026-08-DOCS",
    milestone_type: "plan",
    certification: "Document Library",
    regulation_code: null,
    milestone_name: "All documents complete; remaining batches released, gaps closed",
    planned_date: "2026-08-30",
    owner: "GRC",
    notes: "Completion of the document library is not compliance on its own.",
  },
  {
    milestone_key: "PLAN-2026-09-APPROVE",
    milestone_type: "plan",
    certification: "Document Library",
    regulation_code: null,
    milestone_name:
      "Library approved and signed; document codes updated; SACS-002 recertification progressed; surveillance audit date confirmed with Bureau Veritas; HyperPay attestation and responsibility matrix obtained",
    planned_date: "2026-09-30",
    owner: "GRC, Alhanouf",
    notes: "Documents must be approved before staff can be trained on them.",
  },
  {
    milestone_key: "PLAN-2026-10-SAQA",
    milestone_type: "plan",
    certification: "PCI DSS",
    regulation_code: "PCI-DSS",
    milestone_name:
      "SAQ A completed, signed and submitted to both acquirers; awareness training delivered and recorded; Technology assembles the evidence pack",
    planned_date: "2026-10-31",
    owner: "GRC, HR, Technology",
    notes: "Training has to land in October so the November audit is worth running.",
  },
  {
    milestone_key: "PLAN-2026-11-AUDIT",
    milestone_type: "plan",
    certification: "ISO 27001 / PDPL",
    regulation_code: "ISO-27001",
    milestone_name:
      "First internal audit against ISO 27001 and PDPL; findings raised and corrective actions opened",
    planned_date: "2026-11-30",
    owner: "GRQ",
    notes: "The audit must happen before the management review.",
  },
  {
    milestone_key: "PLAN-2026-12-MGMTREV",
    milestone_type: "plan",
    certification: "PDPL",
    regulation_code: "PDPL",
    milestone_name:
      "Management review held and minuted; risk assessment refreshed and treatment plan approved",
    planned_date: "2026-12-31",
    owner: "Head of GRQ",
    notes: "PDPL position becomes defensible at this point.",
  },
  {
    milestone_key: "PLAN-2027-01-PENTEST",
    milestone_type: "plan",
    certification: "ISO 27001",
    regulation_code: "ISO-27001",
    milestone_name:
      "Penetration test report filed; readiness check against clauses 9.2 and 9.3",
    planned_date: "2027-01-31",
    owner: "Technology, GRC",
    notes: "",
  },
  {
    milestone_key: "PLAN-2027-02-SURV",
    milestone_type: "plan",
    certification: "ISO 27001",
    regulation_code: "ISO-27001",
    milestone_name: "Surveillance audit by Bureau Veritas; certification maintained",
    planned_date: "2027-02-28",
    owner: "Bureau Veritas",
    notes: "",
  },

  // ── §2 When we can say we are compliant ────────────────────────────────
  {
    milestone_key: "FT-SACS002",
    milestone_type: "framework_target",
    certification: "SACS-002 (Saudi Aramco)",
    regulation_code: "SACS-002",
    milestone_name: "Compliant from September 2026 — recertification completed",
    planned_date: "2026-09-30",
    owner: "GRC",
    notes: "Status now: certificate lapsed 5 Feb 2026.",
  },
  {
    milestone_key: "FT-PCIDSS",
    milestone_type: "framework_target",
    certification: "PCI DSS v4.0.1",
    regulation_code: "PCI-DSS",
    milestone_name:
      "Compliant from October 2026 — SAQ A completed and signed, HyperPay attestation held, submitted to both acquirers",
    planned_date: "2026-10-31",
    owner: "GRC",
    notes:
      "Status now: in scope as a merchant, never validated. SAQ A holds only if HyperPay returns a token, not a card number.",
  },
  {
    milestone_key: "FT-PDPL",
    milestone_type: "framework_target",
    certification: "PDPL",
    regulation_code: "PDPL",
    milestone_name:
      "Compliant from December 2026 — library closed, staff trained, internal audit done, findings closed",
    planned_date: "2026-12-31",
    owner: "GRC",
    notes: "Status now: documents nearly complete.",
  },
  {
    milestone_key: "FT-ISO27001",
    milestone_type: "framework_target",
    certification: "ISO/IEC 27001:2022",
    regulation_code: "ISO-27001",
    milestone_name: "Compliant from February 2027 — surveillance audit passed",
    planned_date: "2027-02-28",
    owner: "GRC",
    notes: "Status now: certified since Feb 2026.",
  },
  {
    milestone_key: "FT-NCA-ECC",
    milestone_type: "framework_target",
    certification: "NCA Essential Cybersecurity Controls",
    regulation_code: "NCA-ECC",
    milestone_name:
      "Compliant from April 2027 — applicable controls written into the documents and self-assessed",
    planned_date: "2027-04-30",
    owner: "GRC",
    notes:
      "Status now: mapped, applicability unconfirmed. The plan lists NCA as one line; the platform splits it into ECC and DCC.",
  },
  {
    milestone_key: "FT-NCA-DCC",
    milestone_type: "framework_target",
    certification: "NCA Data Cybersecurity Controls",
    regulation_code: "NCA-DCC",
    milestone_name:
      "Compliant from April 2027 — applicable controls written into the documents and self-assessed",
    planned_date: "2027-04-30",
    owner: "GRC",
    notes:
      "Status now: mapped, applicability unconfirmed. The plan lists NCA as one line; the platform splits it into ECC and DCC.",
  },
  {
    milestone_key: "FT-SOC2",
    milestone_type: "framework_target",
    certification: "SOC 2",
    regulation_code: "SOC2",
    milestone_name: "Target date not set in plan v3.0",
    planned_date: null,
    owner: "GRC",
    notes:
      "SOC 2 is named in the plan introduction but has no row in the section 2 table. Date to be set in v4.0.",
  },

  // ── §5 What we need from other departments ─────────────────────────────
  {
    milestone_key: "DEP-TECH-ANSWERS",
    milestone_type: "dependency",
    certification: "PCI DSS",
    regulation_code: "PCI-DSS",
    milestone_name:
      "Technology — answers: is the redirect to HyperPay complete without exception, and what identifier does the transaction export actually return?",
    planned_date: "2026-09-30",
    owner: "Technology",
    notes: "These two answers set the PCI position (SAQ A versus a far larger self-assessment).",
  },
  {
    milestone_key: "DEP-TECH-EVIDENCE",
    milestone_type: "dependency",
    certification: "ISO 27001 / PDPL",
    regulation_code: "ISO-27001",
    milestone_name:
      "Technology — evidence: penetration test report, access reviews, log samples, configuration baselines, backup and restore test results, vulnerability scan output, plus a named person responsible for supplying it",
    planned_date: "2026-10-31",
    owner: "Technology",
    notes:
      "GRC produces documents, not evidence. From October every milestone depends on material other departments hold — the largest risk to these dates.",
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/certificationMilestonePlan.vitest.test.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/utils/seeds/certificationMilestonePlan.ts tests/vitest/certificationMilestonePlan.vitest.test.ts
git commit -m "feat(cert): seed data for Certification Milestone Plan v3.0"
```

---

### Task 2: Schema — extend `certification_milestones`, register SACS-002

**Files:**
- Modify: `src/utils/northStarSources.ts` (CREATE TABLE at ~:31, insert column whitelist at ~:151-161)
- Modify: `src/utils/complianceDatabase.ts` (`seedDefaultRegulations`, ~:462-620)

**Interfaces:**
- Consumes: nothing.
- Produces: columns `milestone_type`, `regulation_id`, `milestone_key`, `plan_version`, `source_doc` on `certification_milestones`; a `SACS-002` row in `regulations`.

- [ ] **Step 1: Add the columns to the canonical CREATE TABLE**

In `src/utils/northStarSources.ts`, inside the `CREATE TABLE IF NOT EXISTS certification_milestones (...)` block, add after `status VARCHAR(20) DEFAULT 'planned',`:

```sql
      milestone_type VARCHAR(20) DEFAULT 'plan',
      regulation_id INTEGER,
      milestone_key VARCHAR(100),
      plan_version VARCHAR(20),
      source_doc VARCHAR(50),
```

- [ ] **Step 2: Add the matching idempotent migrations**

Immediately after that `CREATE TABLE` call in the same function, add:

```ts
  // Certification Milestone Plan (GRQ-PLAN-2026-01) support. milestone_type
  // partitions the plan's three sections; only 'plan' rows score GRC-KPI-002.
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS milestone_type VARCHAR(20) DEFAULT 'plan'`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS regulation_id INTEGER`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS milestone_key VARCHAR(100)`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS plan_version VARCHAR(20)`,
  );
  await pool.query(
    `ALTER TABLE certification_milestones ADD COLUMN IF NOT EXISTS source_doc VARCHAR(50)`,
  );
  // Idempotency key for the plan seed.
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_certification_milestones_key
       ON certification_milestones(milestone_key) WHERE milestone_key IS NOT NULL`,
  );
```

- [ ] **Step 3: Allow the new columns through the insert whitelist**

`northStarSources.ts` has a column whitelist for inserts (~:151-161). Add `"milestone_type"`, `"regulation_id"`, `"milestone_key"`, `"plan_version"`, `"source_doc"` to that array so seeded/edited rows are not silently dropped.

- [ ] **Step 4: Register SACS-002**

In `src/utils/complianceDatabase.ts`, add to the `seedDefaultRegulations` list, following the shape of the neighbouring entries exactly:

```ts
    {
      regulation_code: "SACS-002",
      name: "SACS-002 Saudi Aramco Cybersecurity Standard",
      description:
        "Saudi Aramco third-party cybersecurity certification. Tracked for certification milestones; control catalogue not yet sourced.",
      jurisdiction: "saudi",
      category: "cybersecurity",
      issuing_body: "Saudi Aramco",
      status: "active",
      version: "002",
    },
```

- [ ] **Step 5: Verify schema parity and types**

Run: `node scripts/check-schema-parity.mjs --strict`
Expected: `✓ check-schema-parity: ... no drift.`

Run: `node node_modules/typescript/bin/tsc 2>&1 | grep -c "error TS"`
Expected: `0`

- [ ] **Step 6: Commit**

```bash
git add src/utils/northStarSources.ts src/utils/complianceDatabase.ts
git commit -m "feat(cert): certification_milestones plan columns + SACS-002 framework"
```

---

### Task 3: Idempotent seed applier

**Files:**
- Modify: `src/utils/seeds/certificationMilestonePlan.ts` (add pure resolver)
- Modify: `src/utils/northStarSources.ts` (add `seedCertificationMilestonePlan`)
- Test: `tests/vitest/certificationMilestonePlan.vitest.test.ts` (extend)

**Interfaces:**
- Consumes: `CERTIFICATION_MILESTONE_PLAN`, `PLAN_VERSION`, `SOURCE_DOC` (Task 1).
- Produces:
  - `resolveMilestoneRegulationIds(rows: PlanMilestoneSeed[], idByCode: Record<string, number>): Array<PlanMilestoneSeed & { regulation_id: number | null }>`
  - `async seedCertificationMilestonePlan(): Promise<{ inserted: number }>`

- [ ] **Step 1: Write the failing test**

Append to `tests/vitest/certificationMilestonePlan.vitest.test.ts`:

```ts
import { resolveMilestoneRegulationIds } from "../../src/utils/seeds/certificationMilestonePlan";

describe("resolveMilestoneRegulationIds", () => {
  it("maps framework codes to ids and leaves unmatched rows null", () => {
    const rows = [
      { ...PLAN[0], regulation_code: null },
      { ...PLAN[0], milestone_key: "X-ISO", regulation_code: "ISO-27001" },
      { ...PLAN[0], milestone_key: "X-GONE", regulation_code: "NOT-SEEDED" },
    ];
    const out = resolveMilestoneRegulationIds(rows, { "ISO-27001": 6 });
    expect(out[0].regulation_id).toBeNull();
    expect(out[1].regulation_id).toBe(6);
    expect(out[2].regulation_id).toBeNull();
  });

  it("never drops rows", () => {
    const out = resolveMilestoneRegulationIds(PLAN, {});
    expect(out).toHaveLength(PLAN.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/certificationMilestonePlan.vitest.test.ts`
Expected: FAIL — `resolveMilestoneRegulationIds is not a function`

- [ ] **Step 3: Add the pure resolver**

Append to `src/utils/seeds/certificationMilestonePlan.ts`:

```ts
/**
 * Attach regulation ids to seed rows. A code the platform does not have yet
 * resolves to null rather than dropping the row — the milestone still matters
 * even when its framework record is missing.
 */
export function resolveMilestoneRegulationIds(
  rows: PlanMilestoneSeed[],
  idByCode: Record<string, number>,
): Array<PlanMilestoneSeed & { regulation_id: number | null }> {
  return rows.map((r) => ({
    ...r,
    regulation_id:
      r.regulation_code !== null && idByCode[r.regulation_code] !== undefined
        ? idByCode[r.regulation_code]
        : null,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/certificationMilestonePlan.vitest.test.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: Add the DB applier**

In `src/utils/northStarSources.ts`, after `initNorthStarTables` (or the function containing the CREATE TABLE), add:

```ts
import {
  CERTIFICATION_MILESTONE_PLAN,
  PLAN_VERSION,
  SOURCE_DOC,
  resolveMilestoneRegulationIds,
} from "./seeds/certificationMilestonePlan";

/**
 * Seed the approved Certification Milestone Plan. Idempotent: ON CONFLICT on
 * milestone_key DO NOTHING, so redeploys never clobber operator edits
 * (delivered_date, status) made in the UI.
 */
export async function seedCertificationMilestonePlan(): Promise<{ inserted: number }> {
  const regs = await pool.query(
    `SELECT id, regulation_code FROM regulations`,
  );
  const idByCode: Record<string, number> = {};
  for (const r of regs.rows) idByCode[r.regulation_code] = Number(r.id);

  const rows = resolveMilestoneRegulationIds(CERTIFICATION_MILESTONE_PLAN, idByCode);
  let inserted = 0;
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO certification_milestones
         (milestone_key, milestone_type, certification, regulation_id,
          milestone_name, planned_date, status, owner, notes,
          plan_version, source_doc)
       VALUES ($1,$2,$3,$4,$5,$6,'planned',$7,$8,$9,$10)
       ON CONFLICT (milestone_key) DO NOTHING`,
      [
        r.milestone_key,
        r.milestone_type,
        r.certification,
        r.regulation_id,
        r.milestone_name,
        r.planned_date,
        r.owner,
        r.notes,
        PLAN_VERSION,
        SOURCE_DOC,
      ],
    );
    inserted += res.rowCount ?? 0;
  }
  logger.info(`✅ [NorthStar] Certification Milestone Plan seeded (${inserted} new rows)`);
  return { inserted };
}
```

Call `await seedCertificationMilestonePlan();` at the end of the same init function that creates the table.

- [ ] **Step 6: Verify types**

Run: `node node_modules/typescript/bin/tsc 2>&1 | grep -c "error TS"`
Expected: `0`

- [ ] **Step 7: Commit**

```bash
git add src/utils/seeds/certificationMilestonePlan.ts src/utils/northStarSources.ts tests/vitest/certificationMilestonePlan.vitest.test.ts
git commit -m "feat(cert): idempotent seeder for the milestone plan"
```

---

### Task 4: Repoint GRC-KPI-002 at milestone delivery

**Files:**
- Modify: `src/utils/northStarSources.ts` (`calcCertMilestoneDelivery`, ~:256-296)
- Modify: `src/utils/kpiProcessCalc.ts:1463` (`PROCESS_CALCULATORS`)
- Test: `tests/vitest/certMilestoneDelivery.vitest.test.ts`

**Interfaces:**
- Consumes: `milestone_type` column (Task 2).
- Produces: `summarizeMilestoneDelivery(rows: Array<{ planned_date: string; delivered_date: string | null; status: string }>, quarterStart: Date, quarterEnd: Date): { due: number; onTime: number; value: number; dataAvailable: boolean }`

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/certMilestoneDelivery.vitest.test.ts`:

```ts
/**
 * GRC-KPI-002 = on-time delivery of 'plan' milestones due in the quarter.
 * The math is pure so it is testable without a database.
 */
import { describe, it, expect } from "vitest";

import { summarizeMilestoneDelivery } from "../../src/utils/northStarSources";

const Q4_START = new Date("2026-10-01T00:00:00Z");
const Q4_END = new Date("2027-01-01T00:00:00Z");

describe("summarizeMilestoneDelivery", () => {
  it("reports no data when nothing is due in the quarter", () => {
    const r = summarizeMilestoneDelivery(
      [{ planned_date: "2027-02-28", delivered_date: null, status: "planned" }],
      Q4_START, Q4_END,
    );
    expect(r.dataAvailable).toBe(false);
    expect(r.due).toBe(0);
  });

  it("counts a milestone delivered on or before its planned date as on time", () => {
    const r = summarizeMilestoneDelivery(
      [
        { planned_date: "2026-10-31", delivered_date: "2026-10-31", status: "delivered" },
        { planned_date: "2026-11-30", delivered_date: "2026-12-05", status: "delivered" },
      ],
      Q4_START, Q4_END,
    );
    expect(r.due).toBe(2);
    expect(r.onTime).toBe(1);
    expect(r.value).toBe(50);
  });

  it("treats an undelivered past-due milestone as not on time", () => {
    const r = summarizeMilestoneDelivery(
      [{ planned_date: "2026-10-31", delivered_date: null, status: "planned" }],
      Q4_START, Q4_END,
    );
    expect(r.due).toBe(1);
    expect(r.onTime).toBe(0);
    expect(r.value).toBe(0);
  });

  it("excludes cancelled milestones from the denominator", () => {
    const r = summarizeMilestoneDelivery(
      [
        { planned_date: "2026-10-31", delivered_date: "2026-10-01", status: "delivered" },
        { planned_date: "2026-11-30", delivered_date: null, status: "cancelled" },
      ],
      Q4_START, Q4_END,
    );
    expect(r.due).toBe(1);
    expect(r.value).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/certMilestoneDelivery.vitest.test.ts`
Expected: FAIL — `summarizeMilestoneDelivery is not a function`

- [ ] **Step 3: Extract the pure math**

Add to `src/utils/northStarSources.ts`:

```ts
/**
 * Pure on-time-delivery math for GRC-KPI-002. Kept out of SQL so it can be
 * unit-tested. A milestone counts as on time only when it was delivered on or
 * before its planned date; still-undelivered past-due rows count against us.
 */
export function summarizeMilestoneDelivery(
  rows: Array<{ planned_date: string; delivered_date: string | null; status: string }>,
  quarterStart: Date,
  quarterEnd: Date,
): { due: number; onTime: number; value: number; dataAvailable: boolean } {
  const inQuarter = rows.filter((r) => {
    if (r.status === "cancelled" || !r.planned_date) return false;
    const p = new Date(r.planned_date);
    return p >= quarterStart && p < quarterEnd;
  });
  const due = inQuarter.length;
  if (due === 0) return { due: 0, onTime: 0, value: 0, dataAvailable: false };
  const onTime = inQuarter.filter(
    (r) => r.delivered_date !== null && new Date(r.delivered_date) <= new Date(r.planned_date),
  ).length;
  return { due, onTime, value: Math.round((onTime / due) * 1000) / 10, dataAvailable: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/certMilestoneDelivery.vitest.test.ts`
Expected: PASS — 4 tests

- [ ] **Step 5: Use it in `calcCertMilestoneDelivery` and scope to `plan`**

Rewrite the body of `calcCertMilestoneDelivery` to select the raw rows and delegate:

```ts
export async function calcCertMilestoneDelivery() {
  const r = await pool.query(
    `SELECT planned_date, delivered_date, status
       FROM certification_milestones
      WHERE milestone_type = 'plan'
        AND planned_date IS NOT NULL`,
  );
  const now = new Date();
  const qStart = new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1));
  const qEnd = new Date(Date.UTC(qStart.getUTCFullYear(), qStart.getUTCMonth() + 3, 1));
  const s = summarizeMilestoneDelivery(
    r.rows.map((x: any) => ({
      planned_date: String(x.planned_date).slice(0, 10),
      delivered_date: x.delivered_date ? String(x.delivered_date).slice(0, 10) : null,
      status: String(x.status ?? "planned"),
    })),
    qStart, qEnd,
  );
  if (!s.dataAvailable) {
    return { value: 0, dataAvailable: false, reason: "no_certifications_due_this_quarter" };
  }
  return {
    value: s.value,
    dataAvailable: true,
    details: { certifications_due_this_quarter: s.due, achieved_on_time: s.onTime },
  };
}
```

- [ ] **Step 6: Repoint the KPI registration**

In `src/utils/kpiProcessCalc.ts`, change line ~1463 from
`"GRC-KPI-002": calcCertificationMilestones,`
to import and use the milestone calculator:

```ts
import { calcCertMilestoneDelivery } from "./northStarSources";
// ...
  // GRC-KPI-002 measures on-time delivery of Certification Milestone Plan
  // milestones. It previously reported document-mapping clause coverage via
  // calcCertificationMilestones — kept below but no longer wired here, since
  // coverage is a useful metric that is simply not this KPI.
  "GRC-KPI-002": async () => {
    const r = await calcCertMilestoneDelivery();
    return r.dataAvailable
      ? { value: r.value, dataAvailable: true, details: r.details }
      : EMPTY;
  },
```

Leave `calcCertificationMilestones` defined and exported; do not delete it.

- [ ] **Step 7: Verify**

Run: `node node_modules/typescript/bin/tsc 2>&1 | grep -c "error TS"`
Expected: `0`

Run: `npx vitest run tests/vitest/certMilestoneDelivery.vitest.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/utils/northStarSources.ts src/utils/kpiProcessCalc.ts tests/vitest/certMilestoneDelivery.vitest.test.ts
git commit -m "feat(cert): GRC-KPI-002 now measures milestone on-time delivery"
```

---

### Task 5: Reconcile the four KPI definitions

**Files:**
- Modify: `src/utils/finalGrqKpiSeed.ts:72`
- Modify: `src/utils/kpiDatabase.ts:1236` (legacy entry)
- Test: `tests/vitest/grcKpi002Definition.vitest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a single agreed parameterisation of `GRC-KPI-002`.

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/grcKpi002Definition.vitest.test.ts`:

```ts
/**
 * GRC-KPI-002 had four conflicting definitions. The calculator scores per
 * quarter, so quarterly wins over the old "Per Certificate".
 */
import { describe, it, expect } from "vitest";

import { FINAL_GRQ_KPIS } from "../../src/utils/finalGrqKpiSeed";

describe("GRC-KPI-002 definition", () => {
  it("is a quarterly percentage targeting 100", () => {
    const k = FINAL_GRQ_KPIS.find((x: any) => x.code === "GRC-KPI-002")!;
    expect(k.unit).toBe("%");
    expect(k.target).toBe(100);
    expect(k.frequency).toBe("Quarterly");
    expect(k.direction).toBe("higher_is_better");
  });

  it("declares the milestone plan as its data source", () => {
    const k = FINAL_GRQ_KPIS.find((x: any) => x.code === "GRC-KPI-002")!;
    expect(k.data_source).toMatch(/Certification Milestone Plan/i);
  });
});
```

If the seed array is not currently exported, export it (`export const FINAL_GRQ_KPIS = [...]`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/grcKpi002Definition.vitest.test.ts`
Expected: FAIL — `frequency` is `"Per Certificate"`

- [ ] **Step 3: Update the authoritative seed**

In `src/utils/finalGrqKpiSeed.ts:72`, change `frequency: "Per Certificate"` → `frequency: "Quarterly"` and `data_source: "Certification Roadmap"` → `data_source: "Certification Milestone Plan (GRQ-PLAN-2026-01)"`. Leave `target: 100`, `unit: "%"`, `direction`, `weight`, `north_star` unchanged.

- [ ] **Step 4: Align the legacy entry**

In `src/utils/kpiDatabase.ts:1236`, update the superseded `GRQ_SCORECARD_KPIS` entry so it cannot reintroduce drift: `target_value: 100`, `threshold_green: 100`, `threshold_amber: 85`, `threshold_red: 70`, and replace the description/formula with the milestone wording used in `finalGrqKpiSeed`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/vitest/grcKpi002Definition.vitest.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 6: Commit**

```bash
git add src/utils/finalGrqKpiSeed.ts src/utils/kpiDatabase.ts tests/vitest/grcKpi002Definition.vitest.test.ts
git commit -m "fix(kpi): single definition for GRC-KPI-002 (quarterly, target 100%)"
```

---

### Task 6: Baseline-break annotation

Historical `kpi_values` for `GRC-KPI-002` were produced by the coverage calculator. Preserve them and mark the discontinuity.

**Files:**
- Modify: `src/utils/kpiDatabase.ts` (`kpi_definitions` CREATE TABLE + migrations)
- Modify: `src/utils/finalGrqKpiSeed.ts` (set the annotation for GRC-KPI-002)
- Modify: `dashboard/kpis.html` (render the marker)
- Modify: `dashboard/i18n/en.json`, `dashboard/i18n/ar.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `kpi_definitions.methodology_changed_at DATE`, `kpi_definitions.methodology_note TEXT`, surfaced by the KPI API's existing `SELECT *` paths.

- [ ] **Step 1: Add the columns to the canonical CREATE TABLE**

In `src/utils/kpiDatabase.ts`, inside `CREATE TABLE IF NOT EXISTS kpi_definitions (...)`, add:

```sql
      methodology_changed_at DATE,
      methodology_note TEXT,
```

- [ ] **Step 2: Add the matching migrations**

```ts
  // A KPI whose calculation method changed has a discontinuity in its history.
  // We keep every historical value and mark the break instead of deleting.
  await pool.query(
    `ALTER TABLE kpi_definitions ADD COLUMN IF NOT EXISTS methodology_changed_at DATE`,
  );
  await pool.query(
    `ALTER TABLE kpi_definitions ADD COLUMN IF NOT EXISTS methodology_note TEXT`,
  );
```

- [ ] **Step 3: Set the annotation for GRC-KPI-002**

In `src/utils/finalGrqKpiSeed.ts`, after the upsert, add a one-off statement (guarded so operator edits are not overwritten):

```ts
  await pool.query(
    `UPDATE kpi_definitions
        SET methodology_changed_at = DATE '2026-09-02',
            methodology_note = $1
      WHERE kpi_code = 'GRC-KPI-002'
        AND methodology_changed_at IS NULL`,
    [
      "Before 2 Sep 2026 this KPI reported document-mapping clause coverage. " +
        "From that date it reports on-time delivery of Certification Milestone Plan " +
        "(GRQ-PLAN-2026-01 v3.0) milestones. Values either side are not comparable.",
    ],
  );
```

- [ ] **Step 4: Render the break in the trend**

In `dashboard/kpis.html`, where the trend/sparkline for a KPI is rendered, add a marker when `kpi.methodology_changed_at` is present:

```js
// A methodology change means the series before and after are different metrics.
// Show a break so nobody reads the step as progress or regression.
function _methodologyBreakBadge(kpi) {
    if (!kpi.methodology_changed_at) return '';
    const note = kpi.methodology_note || '';
    return `<span class="ml-2 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800"
                  title="${note.replace(/"/g, '&quot;')}"
                  data-testid="kpi-methodology-break">${WalaPlusI18n.t('kpis.methodology_break')}</span>`;
}
```

Call it next to the KPI title in the card and detail renderers.

- [ ] **Step 5: Add the i18n keys**

`dashboard/i18n/en.json` under the `kpis` namespace: `"methodology_break": "Method changed"`.
`dashboard/i18n/ar.json` same key: `"methodology_break": "تغيّرت طريقة الحساب"`.

- [ ] **Step 6: Verify**

Run: `node scripts/check-schema-parity.mjs --strict`
Expected: `no drift.`

Run: `node scripts/check-dashboard-html-js.mjs`
Expected: `parsed cleanly.`

Run: `node scripts/check-i18n.cjs`
Expected: pass

- [ ] **Step 7: Commit**

```bash
git add src/utils/kpiDatabase.ts src/utils/finalGrqKpiSeed.ts dashboard/kpis.html dashboard/i18n/en.json dashboard/i18n/ar.json
git commit -m "feat(kpi): baseline-break annotation for methodology changes"
```

---

### Task 7: Leadership count emitter

**Files:**
- Modify: `src/utils/leadershipKpiFeed.ts` (`calcCertMilestoneCount`, ~:698-716)
- Modify: `src/utils/leadershipPush.ts:38-46`
- Test: `tests/vitest/certMilestoneDelivery.vitest.test.ts` (extend)

**Interfaces:**
- Consumes: `summarizeMilestoneDelivery` (Task 4).
- Produces: `certMilestoneCount(...)` returning the on-time **count**, not a percentage.

- [ ] **Step 1: Write the failing test**

Append to `tests/vitest/certMilestoneDelivery.vitest.test.ts`:

```ts
import { onTimeCountFromSummary } from "../../src/utils/northStarSources";

describe("leadership count derivation", () => {
  it("emits the on-time COUNT, never the percentage", () => {
    const s = { due: 4, onTime: 3, value: 75, dataAvailable: true };
    expect(onTimeCountFromSummary(s)).toBe(3);
  });

  it("emits null when there is no data, so the feed omits rather than sends 0", () => {
    const s = { due: 0, onTime: 0, value: 0, dataAvailable: false };
    expect(onTimeCountFromSummary(s)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/certMilestoneDelivery.vitest.test.ts`
Expected: FAIL — `onTimeCountFromSummary is not a function`

- [ ] **Step 3: Implement**

Add to `src/utils/northStarSources.ts`:

```ts
/**
 * Leadership tracks Certification as a COUNT of certificates (target 2/quarter),
 * while QMS shows a percentage. Emitting the percentage into the count field is
 * what produced the historical "995%". This is the only sanctioned conversion.
 */
export function onTimeCountFromSummary(
  s: { onTime: number; dataAvailable: boolean },
): number | null {
  return s.dataAvailable ? s.onTime : null;
}
```

Wire `calcCertMilestoneCount` in `leadershipKpiFeed.ts` to use it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/certMilestoneDelivery.vitest.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Prepare the push entry, left disabled pending UUID verification**

In `src/utils/leadershipPush.ts`, replace the "deliberately not pushed" comment with the count rationale and add the entry **commented out**, because the prod UUID in the original comment is truncated (`2f11d78d…`) and unverified:

```ts
  // GRC-KPI-002 now emits a COUNT of on-time milestones (see
  // onTimeCountFromSummary), which matches leadership's unit. Re-enable by
  // uncommenting once the full strategyItem UUID is confirmed against the
  // leadership platform — the historical "995%" came from pushing an
  // unverified mapping.
  // { code: "GRC-KPI-002", strategyItemId: "2f11d78d-____-____-____-____________" },
```

- [ ] **Step 6: Verify**

Run: `node node_modules/typescript/bin/tsc 2>&1 | grep -c "error TS"`
Expected: `0`

- [ ] **Step 7: Commit**

```bash
git add src/utils/northStarSources.ts src/utils/leadershipKpiFeed.ts src/utils/leadershipPush.ts tests/vitest/certMilestoneDelivery.vitest.test.ts
git commit -m "feat(cert): leadership count emitter; push staged pending UUID check"
```

---

### Task 8: Rename the sidebar item

**Files:**
- Modify: `dashboard/i18n/en.json` (`nav.items.compliance`, ~:56)
- Modify: `dashboard/i18n/ar.json` (same key, ~:56)
- Modify: `dashboard/js/navigation.js:189` (label fallback), `:1554` (search predicate)

**Interfaces:**
- Consumes: nothing.
- Produces: nav row reading "Certification Milestone"; `id`, `href`, route unchanged.

- [ ] **Step 1: Change the two i18n values**

`en.json` → `"compliance": "Certification Milestone",`
`ar.json` → `"compliance": "معالم الشهادات",`

Change **values only**. Do not rename the key — `scripts/check-i18n.cjs` enforces identical key trees across locales.

- [ ] **Step 2: Update the fallback label**

`dashboard/js/navigation.js:189`:

```js
        { label: 'Certification Milestone', href: '/compliance', icon: 'check-circle', id: 'compliance' },
```

Do **not** change `id` or `href` — active state keys off `item.id === this.currentPage` and `compliance.html:78` calls `WalaPlusNav.init('compliance')`.

- [ ] **Step 3: Add a nav search alias**

At `navigation.js:1554` the filter matches `data-label` only, so typing "compliance" would no longer find this row. Extend the predicate:

```js
                // Renamed rows keep their old name searchable so muscle memory
                // still works (e.g. "compliance" finds "Certification Milestone").
                const NAV_SEARCH_ALIASES = { 'compliance': 'compliance regulatory obligations' };
                const label = item.getAttribute('data-label') || '';
                const id = item.getAttribute('data-nav-id') || '';
                const alias = NAV_SEARCH_ALIASES[id] || '';
                const match = !q || label.includes(q) || alias.includes(q);
```

If `data-nav-id` is not already emitted in `renderRailItem`, add `data-nav-id="${item.id}"` alongside the existing `data-label` attribute.

- [ ] **Step 4: Verify**

Run: `node scripts/check-i18n.cjs`
Expected: pass (key trees identical)

Run: `node scripts/check-dashboard-html-js.mjs`
Expected: `parsed cleanly.`

- [ ] **Step 5: Commit**

```bash
git add dashboard/i18n/en.json dashboard/i18n/ar.json dashboard/js/navigation.js
git commit -m "feat(nav): rename Compliance to Certification Milestone"
```

---

### Task 9: Milestone section on `/compliance`

**Files:**
- Create: `src/mastra/routes/certificationMilestoneRoutes.ts`
- Modify: `src/mastra/index.ts` (register the route)
- Modify: `dashboard/compliance.html` (top section + h1)
- Modify: `dashboard/i18n/en.json`, `dashboard/i18n/ar.json`
- Test: `tests/vitest/certificationMilestoneRoutes.vitest.test.ts`

**Interfaces:**
- Consumes: `certification_milestones` rows (Tasks 2-3).
- Produces: `GET /api/certification-milestones` → `{ plan: Row[], framework_target: Row[], dependency: Row[], plan_version: string, source_doc: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/vitest/certificationMilestoneRoutes.vitest.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { groupMilestonesByType } from "../../src/mastra/routes/certificationMilestoneRoutes";

describe("groupMilestonesByType", () => {
  it("buckets rows into the three plan sections", () => {
    const g = groupMilestonesByType([
      { milestone_key: "a", milestone_type: "plan" },
      { milestone_key: "b", milestone_type: "framework_target" },
      { milestone_key: "c", milestone_type: "dependency" },
      { milestone_key: "d", milestone_type: "plan" },
    ] as any);
    expect(g.plan).toHaveLength(2);
    expect(g.framework_target).toHaveLength(1);
    expect(g.dependency).toHaveLength(1);
  });

  it("always returns all three keys even when empty", () => {
    const g = groupMilestonesByType([]);
    expect(Object.keys(g).sort()).toEqual(["dependency", "framework_target", "plan"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/vitest/certificationMilestoneRoutes.vitest.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the route module**

Create `src/mastra/routes/certificationMilestoneRoutes.ts`:

```ts
import { sharedPool as pool } from "../../utils/sharedPool";
import { PLAN_VERSION, SOURCE_DOC } from "../../utils/seeds/certificationMilestonePlan";

export interface MilestoneRow {
  milestone_key: string;
  milestone_type: "plan" | "framework_target" | "dependency";
  certification: string;
  milestone_name: string;
  planned_date: string | null;
  delivered_date: string | null;
  status: string;
  owner: string;
  notes: string;
  regulation_code: string | null;
}

/** Pure bucketing so the shape is stable even when a section is empty. */
export function groupMilestonesByType(rows: MilestoneRow[]) {
  const out = {
    plan: [] as MilestoneRow[],
    framework_target: [] as MilestoneRow[],
    dependency: [] as MilestoneRow[],
  };
  for (const r of rows) {
    if (r.milestone_type in out) out[r.milestone_type].push(r);
  }
  return out;
}

export const certificationMilestoneRoutes = [
  {
    path: "/api/certification-milestones",
    method: "GET" as const,
    createHandler: async () => async (c: any) => {
      const { requireRole } = await import("../../utils/rbacMiddleware");
      const user = await requireRole(c, [
        "admin", "head_of_operations_quality", "grc_manager",
        "quality_manager", "executive",
      ]);
      if (!user) return c.json({ error: "Insufficient permissions" }, 403);

      const r = await pool.query(
        `SELECT cm.milestone_key, cm.milestone_type, cm.certification,
                cm.milestone_name, cm.planned_date, cm.delivered_date,
                cm.status, cm.owner, cm.notes, reg.regulation_code
           FROM certification_milestones cm
           LEFT JOIN regulations reg ON reg.id = cm.regulation_id
          WHERE cm.milestone_key IS NOT NULL
          ORDER BY cm.planned_date NULLS LAST, cm.milestone_key`,
      );
      return c.json({
        ...groupMilestonesByType(r.rows as MilestoneRow[]),
        plan_version: PLAN_VERSION,
        source_doc: SOURCE_DOC,
      });
    },
  },
];
```

Register it in `src/mastra/index.ts` alongside the other route arrays (import, then spread into the routes list — follow how `complianceRoutes` is imported at ~:59 and spread at ~:318).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/vitest/certificationMilestoneRoutes.vitest.test.ts`
Expected: PASS — 2 tests

- [ ] **Step 5: Add the page section**

In `dashboard/compliance.html`, change the `<h1>` (line ~87) to use a new key `compliance.title_milestones` and insert **above** the existing filter bar a section containing three blocks, each `data-testid`'d:

```html
<section data-testid="section-cert-milestones" class="mb-6 space-y-4">
    <div class="bg-white rounded-lg border border-gray-200 p-4">
        <h2 class="font-semibold text-gray-800" data-i18n="compliance.milestone_timeline">Milestone Timeline</h2>
        <p class="text-xs text-gray-500" id="milestonePlanProvenance"></p>
        <div id="milestoneTimeline" class="mt-3"></div>
    </div>
    <div class="bg-white rounded-lg border border-gray-200 p-4">
        <h2 class="font-semibold text-gray-800" data-i18n="compliance.compliant_from">Compliant From, by Framework</h2>
        <div id="milestoneFrameworks" class="mt-3"></div>
    </div>
    <div class="bg-white rounded-lg border border-amber-200 bg-amber-50 p-4">
        <h2 class="font-semibold text-amber-900" data-i18n="compliance.dependencies">Dependencies &amp; Blockers</h2>
        <div id="milestoneDependencies" class="mt-3"></div>
    </div>
</section>
<h2 class="text-lg font-semibold text-gray-800 mb-2" data-i18n="compliance.framework_section">Framework Compliance &amp; Obligations</h2>
```

Add this inside the page's existing `<script>` block, and call `loadMilestones()` from `reloadAll()` (~:1556) alongside `loadSummary()`. Use `data-on-click` handlers only — inline handlers are blocked by `scripts/check-no-inline-handlers.sh`.

```js
// Certification Milestone Plan (GRQ-PLAN-2026-01). Only 'plan' rows score
// GRC-KPI-002; the other two sections are context, rendered read-only.
function _mStatus(m) {
    if (m.delivered_date) {
        const onTime = new Date(m.delivered_date) <= new Date(m.planned_date);
        return onTime
            ? '<span class="px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700">On time</span>'
            : '<span class="px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700">Late</span>';
    }
    if (!m.planned_date) return '<span class="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">No date</span>';
    const overdue = new Date(m.planned_date) < new Date();
    return overdue
        ? '<span class="px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800">Overdue</span>'
        : '<span class="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">Planned</span>';
}

function _mRow(m) {
    return `<div class="flex items-start gap-3 py-2 border-b border-gray-100 last:border-0">
        <div class="w-24 shrink-0 text-xs text-gray-500">${escapeHtml(m.planned_date || '—')}</div>
        <div class="flex-1">
            <div class="text-sm text-gray-800">${escapeHtml(m.milestone_name)}</div>
            <div class="text-xs text-gray-500">${escapeHtml(m.certification)}${m.owner ? ' · ' + escapeHtml(m.owner) : ''}</div>
        </div>
        <div class="shrink-0">${_mStatus(m)}</div>
    </div>`;
}

async function loadMilestones() {
    try {
        const res = await fetch('/api/certification-milestones');
        if (!res.ok) return;
        const d = await res.json();
        document.getElementById('milestonePlanProvenance').textContent =
            `${d.source_doc} v${d.plan_version}`;
        document.getElementById('milestoneTimeline').innerHTML =
            (d.plan || []).map(_mRow).join('') || '<div class="text-sm text-gray-500">No milestones.</div>';
        document.getElementById('milestoneFrameworks').innerHTML =
            (d.framework_target || []).map(_mRow).join('') || '<div class="text-sm text-gray-500">No framework targets.</div>';
        document.getElementById('milestoneDependencies').innerHTML =
            (d.dependency || []).map(_mRow).join('') || '<div class="text-sm text-gray-500">No open dependencies.</div>';
    } catch (e) {
        console.error('Error loading milestones:', e);
    }
}
```

- [ ] **Step 6: Add the i18n keys (both locales)**

Add under the `compliance` namespace in `dashboard/i18n/en.json`:

```json
    "title_milestones": "Certification Milestones",
    "milestone_timeline": "Milestone Timeline",
    "compliant_from": "Compliant From, by Framework",
    "dependencies": "Dependencies & Blockers",
    "framework_section": "Framework Compliance & Obligations",
```

And the identical keys under `compliance` in `dashboard/i18n/ar.json`:

```json
    "title_milestones": "معالم الشهادات",
    "milestone_timeline": "الجدول الزمني للمعالم",
    "compliant_from": "تاريخ الامتثال حسب الإطار",
    "dependencies": "الاعتماديات والعوائق",
    "framework_section": "الامتثال للأطر والالتزامات",
```

- [ ] **Step 7: Verify**

Run: `node scripts/check-dashboard-html-js.mjs` → `parsed cleanly.`
Run: `node scripts/check-i18n.cjs` → pass
Run: `bash scripts/check-no-inline-handlers.sh` → pass
Run: `node node_modules/typescript/bin/tsc 2>&1 | grep -c "error TS"` → `0`

- [ ] **Step 8: Commit**

```bash
git add src/mastra/routes/certificationMilestoneRoutes.ts src/mastra/index.ts dashboard/compliance.html dashboard/i18n/en.json dashboard/i18n/ar.json tests/vitest/certificationMilestoneRoutes.vitest.test.ts
git commit -m "feat(cert): milestone-first section on the Certification Milestone page"
```

---

### Task 10: Full verification and deploy note

**Files:**
- Create: `docs/deploy-notes/2026-09-02-certification-milestones.md`

- [ ] **Step 1: Run the full guardrail suite**

```bash
node node_modules/typescript/bin/tsc 2>&1 | grep -c "error TS"
node scripts/check-schema-parity.mjs --strict
node scripts/check-i18n.cjs
node scripts/check-dashboard-html-js.mjs
npx vitest run tests/vitest/certificationMilestonePlan.vitest.test.ts tests/vitest/certMilestoneDelivery.vitest.test.ts tests/vitest/grcKpi002Definition.vitest.test.ts tests/vitest/certificationMilestoneRoutes.vitest.test.ts
```

Expected: `0` TS errors; all four checks pass; 15 vitest tests pass.

- [ ] **Step 2: Confirm seed idempotency**

Restart the app twice and confirm `certification_milestones` holds exactly 16 seeded rows (`milestone_key IS NOT NULL`) — not 32.

- [ ] **Step 3: Write the deploy note**

Follow `docs/deploy-notes/2026-07-08-risk-register.md` as the template. It must state: schema auto-migrates via `ALTER … IF NOT EXISTS`; **do not approve any `DROP TABLE`** in the Replit publish diff; the leadership push stays commented until the UUID is confirmed; and that `GRC-KPI-002` will visibly change value with a "Method changed" badge explaining why.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy-notes/2026-09-02-certification-milestones.md
git commit -m "docs: deploy note for certification milestones"
```

---

## Notes for the implementer

- **Do not delete `calcCertificationMilestones`.** It is verified to have exactly one consumer (the registration you are changing), and clause coverage remains a useful metric for a future KPI.
- **SACS-002 will render as a framework card with 0 clauses.** This is expected — its control catalogue is out of scope. Coverage math is guarded against zero (`calculateCoveragePct` returns 0 when `total <= 0`), so it cannot dilute or crash anything.
- **`compliance_assessments` is empty**, which is why the page shows 0% / 668 Not Assessed. Out of scope here; do not "fix" it as a side quest.
- Task 5 changes how Maram's North Star composite is computed (frequency `Per Certificate` → `Quarterly`). Flag it in the deploy note rather than burying it.
