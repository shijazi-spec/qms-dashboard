/**
 * Validation of the CS-pipeline overlap classifier against a real-world sample.
 *
 * Run: npx vitest run tests/vitest/duplicateRadarCsOverlap.vitest.test.ts
 *
 * Reads a small sample dataset committed under docs/ as a regression fixture
 * (102 historical CS-pipeline overlap rows pulled from production). Validates
 * that the classifier produces a sensible verdict for every row:
 *
 *   - Active phase (Onboarding / Adoption / Renewal)  →  verdict === 'block'
 *   - Phase = Termination                              →  verdict ∈ {'review','warn'}
 *
 * Does NOT touch the database — purely exercises the pure-function helpers
 * in src/utils/duplicateRadarCsOverlap.ts. The xlsx is a static fixture; if
 * Quality re-snapshots production duplicates, drop a new file in docs/ and
 * point this test at it.
 */
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  classifyCsOverlap,
  detectSector,
  extractCsFieldsFromRawData,
  resetCsOverlapConfigCache,
  type CsOverlapInput,
} from "../../src/utils/duplicateRadarCsOverlap";

/**
 * Convert an Excel serial date to a JS Date.
 * Excel epoch is 1899-12-30 (accounting for the 1900-leap-year bug).
 */
function excelSerialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

interface FixtureRow {
  domain: string;
  company_name: string;
  stage: string;
  arr: number;
  churn_date_serial: number | null;
}

/**
 * Lazy xlsx loader. Uses exceljs if available; otherwise skips this file's
 * tests gracefully (e.g. when running in an environment without exceljs).
 */
async function loadFixture(): Promise<FixtureRow[] | null> {
  // The xlsx may not be in the repo on every machine (it's a real-data
  // snapshot kept in docs/). If absent, the suite skips itself.
  const fixturePath = join(
    process.cwd(),
    "docs",
    "Mawsool Deals - Final Report.xlsx",
  );
  if (!existsSync(fixturePath)) return null;

  let ExcelJS: typeof import("exceljs");
  try {
    ExcelJS = (await import("exceljs")) as any;
  } catch {
    return null; // exceljs not installed in test env; skip
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fixturePath);
  const ws = wb.worksheets[0];
  if (!ws) return null;

  const rows: FixtureRow[] = [];
  let header: string[] = [];
  ws.eachRow((row, rowNum) => {
    const vals = row.values as any[];
    if (rowNum === 1) {
      header = vals.slice(1).map((v) => String(v ?? ""));
      return;
    }
    const lookup = (col: string): any => {
      const idx = header.indexOf(col);
      return idx === -1 ? null : vals[idx + 1];
    };
    const churnRaw = lookup("churn_date");
    let churnSerial: number | null = null;
    if (typeof churnRaw === "number") churnSerial = churnRaw;
    else if (churnRaw instanceof Date)
      churnSerial = Math.floor(churnRaw.getTime() / 86400000) + 25569;

    rows.push({
      domain: String(lookup("domain") ?? "").trim(),
      company_name: String(lookup("company_name") ?? "").trim(),
      stage: String(lookup("stage") ?? "").trim(),
      arr: Number(lookup("arr") ?? 0) || 0,
      churn_date_serial: churnSerial,
    });
  });
  return rows;
}

afterEach(() => resetCsOverlapConfigCache());

describe("detectSector", () => {
  test("gov_type 'Government' → government", () => {
    expect(detectSector({ gov_type: "Government" })).toBe("government");
  });
  test("gov_type 'Private' → private", () => {
    expect(detectSector({ gov_type: "Private" })).toBe("private");
  });
  test("empty gov_type, .gov.sa domain → government", () => {
    expect(detectSector({ gov_type: null, domain: "alriyadh.gov.sa" })).toBe(
      "government",
    );
  });
  test("empty gov_type, .com.sa domain → private", () => {
    expect(detectSector({ gov_type: null, domain: "anb.com.sa" })).toBe(
      "private",
    );
  });
  test("no inputs → null", () => {
    expect(detectSector({})).toBeNull();
  });
});

describe("classifyCsOverlap — verdict ladder", () => {
  test("Phase=Onboarding → block", () => {
    const c = classifyCsOverlap({
      phase: "Onboarding",
      gov_type: "Private",
      domain: "example.com",
    });
    expect(c.verdict).toBe("block");
    expect(c.lifecycle_state).toBe("onboarding");
  });

  test("Phase=Adoption → block", () => {
    expect(
      classifyCsOverlap({ phase: "Adoption", gov_type: "Private" }).verdict,
    ).toBe("block");
  });

  test("Phase=Renewal → block", () => {
    expect(
      classifyCsOverlap({ phase: "Renewal", gov_type: "Government" }).verdict,
    ).toBe("block");
  });

  test("Custom active phase → block, lifecycle_state=active_other (no silent renewal-fallback)", () => {
    // If Quality renames the active phase list (e.g. adds "Re-engagement"),
    // the verdict stays BLOCK but lifecycle_state must not be silently
    // misreported as "renewal". A distinct discriminator keeps dashboards
    // and analytics honest.
    const prev = process.env.DUPLICATE_RADAR_CS_ACTIVE_PHASES;
    process.env.DUPLICATE_RADAR_CS_ACTIVE_PHASES =
      "Onboarding,Adoption,Renewal,Re-engagement";
    resetCsOverlapConfigCache();
    try {
      const c = classifyCsOverlap({
        phase: "Re-engagement",
        gov_type: "Private",
      });
      expect(c.verdict).toBe("block");
      expect(c.lifecycle_state).toBe("active_other");
      expect(c.reason).toBe("active_phase:re-engagement");
    } finally {
      if (prev === undefined) delete process.env.DUPLICATE_RADAR_CS_ACTIVE_PHASES;
      else process.env.DUPLICATE_RADAR_CS_ACTIVE_PHASES = prev;
      resetCsOverlapConfigCache();
    }
  });

  test("Phase=Termination, private, churn 60 days ago → review", () => {
    const churnDate = new Date(Date.now() - 60 * 86400 * 1000);
    const c = classifyCsOverlap({
      phase: "Termination",
      gov_type: "Private",
      churn_date: churnDate,
    });
    expect(c.verdict).toBe("review");
    expect(c.lifecycle_state).toBe("termination_recent");
  });

  test("Phase=Termination, private, churn 200 days ago → warn", () => {
    const churnDate = new Date(Date.now() - 200 * 86400 * 1000);
    const c = classifyCsOverlap({
      phase: "Termination",
      gov_type: "Private",
      churn_date: churnDate,
    });
    expect(c.verdict).toBe("warn");
    expect(c.lifecycle_state).toBe("termination_old");
  });

  test("Phase=Termination, gov, churn 200 days ago → review (still in 12mo cool-off)", () => {
    const churnDate = new Date(Date.now() - 200 * 86400 * 1000);
    const c = classifyCsOverlap({
      phase: "Termination",
      gov_type: "Government",
      churn_date: churnDate,
    });
    expect(c.verdict).toBe("review");
  });

  test("Phase=Termination, gov, churn 400 days ago → warn", () => {
    const churnDate = new Date(Date.now() - 400 * 86400 * 1000);
    const c = classifyCsOverlap({
      phase: "Termination",
      gov_type: "Government",
      churn_date: churnDate,
    });
    expect(c.verdict).toBe("warn");
  });

  test("Termination with no churn date → review (conservative)", () => {
    const c = classifyCsOverlap({ phase: "Termination", gov_type: "Private" });
    expect(c.verdict).toBe("review");
  });

  test("Phase=Termination but Renewal_Date > Churn_Date → block (re-engaged)", () => {
    // Customer churned, then came back: Renewal Date is after Churn Date.
    // The deal's Phase is stale (CS Lifecycle Compliance also catches this).
    // The overlap detector should treat the domain as active and block any
    // new lead — matching the renewal-after-churn rule applied in CS
    // Lifecycle Compliance (PR #37).
    const c = classifyCsOverlap({
      phase: "Termination",
      gov_type: "Private",
      churn_date: "2026-03-15",
      renewal_date: "2026-03-16",
    });
    expect(c.verdict).toBe("block");
    expect(c.reason).toBe("re_engaged_renewal_after_churn");
    expect(c.lifecycle_state).toBe("active_other");
  });

  test("Phase=Termination + Renewal_Date BEFORE Churn_Date → falls through to cool-off path", () => {
    // Renewal is historical; churn is the more recent event. Not re-engaged.
    const churnDate = new Date(Date.now() - 60 * 86400 * 1000);
    const renewalDate = new Date(Date.now() - 90 * 86400 * 1000);
    const c = classifyCsOverlap({
      phase: "Termination",
      gov_type: "Private",
      churn_date: churnDate,
      renewal_date: renewalDate,
    });
    expect(c.verdict).toBe("review");
  });

  test("Phase=Termination + Renewal_Date present but no Churn_Date → still review (conservative)", () => {
    // Without a churn date we can't compare; fall through to the
    // termination_no_churn_date path.
    const c = classifyCsOverlap({
      phase: "Termination",
      gov_type: "Private",
      renewal_date: "2026-03-16",
    });
    expect(c.verdict).toBe("review");
  });

  test("Unknown phase → no verdict", () => {
    expect(
      classifyCsOverlap({ phase: "Negotiation", gov_type: "Private" }).verdict,
    ).toBeNull();
  });
});

describe("extractCsFieldsFromRawData — normalised key fallback", () => {
  test("matches Company_Domain via exact key", () => {
    const out = extractCsFieldsFromRawData({
      Phase: "Adoption",
      Company_Domain: "emdadnajed.com",
    });
    expect(out.company_domain).toBe("emdadnajed.com");
  });

  test("matches a casing/separator variant via normalisation", () => {
    // Tenant uses an unexpected casing/separator that none of the explicit
    // defaults match — normalised lookup should still find it.
    const out = extractCsFieldsFromRawData({
      Phase: "Adoption",
      "COMPANYDOMAIN": "thenizerksa.com",
    });
    expect(out.company_domain).toBe("thenizerksa.com");
  });

  test("matches a hyphenated/space-separated variant via normalisation", () => {
    const out = extractCsFieldsFromRawData({
      Phase: "Adoption",
      "company-domain": "unitedinv.co",
    });
    expect(out.company_domain).toBe("unitedinv.co");
  });

  test("extracts Renewal_Date alongside Churn_Date", () => {
    const out = extractCsFieldsFromRawData({
      Phase: "Adoption",
      Churn_Date: "2026-03-15",
      Renewal_Date: "2026-03-16",
    });
    expect(out.renewal_date).toBe("2026-03-16");
    expect(out.churn_date).toBe("2026-03-15");
  });

  test("returns null company_domain when raw_data has no domain-like key", () => {
    const out = extractCsFieldsFromRawData({
      Phase: "Adoption",
    });
    expect(out.company_domain).toBeNull();
  });
});

describe("real-world fixture (docs/Mawsool Deals - Final Report.xlsx)", () => {
  let rows: FixtureRow[] | null = null;

  beforeAll(async () => {
    rows = await loadFixture();
  });

  test("fixture loads with expected schema", () => {
    if (!rows) {
      // eslint-disable-next-line no-console
      console.warn("[duplicateRadarCsOverlap] fixture not found — skipping");
      return;
    }
    expect(rows.length).toBeGreaterThan(50);
    expect(rows.length).toBeLessThan(200);
    const stages = new Set(rows.map((r) => r.stage));
    expect(stages.has("Onboarding")).toBe(true);
    expect(stages.has("Adoption")).toBe(true);
    expect(stages.has("Renewal")).toBe(true);
    expect(stages.has("Termination")).toBe(true);
  });

  test("every active-phase row classifies as BLOCK", () => {
    if (!rows) return;
    const active = rows.filter((r) =>
      ["Onboarding", "Adoption", "Renewal"].includes(r.stage),
    );
    expect(active.length).toBeGreaterThan(0);

    for (const r of active) {
      const input: CsOverlapInput = {
        phase: r.stage,
        domain: r.domain,
      };
      const c = classifyCsOverlap(input);
      expect(c.verdict, `row ${r.domain} (${r.stage})`).toBe("block");
    }
  });

  test("every termination row classifies as REVIEW or WARN (never BLOCK)", () => {
    if (!rows) return;
    const term = rows.filter((r) => r.stage === "Termination");
    expect(term.length).toBeGreaterThan(0);

    for (const r of term) {
      const churnDate = r.churn_date_serial
        ? excelSerialToDate(r.churn_date_serial)
        : null;
      const input: CsOverlapInput = {
        phase: r.stage,
        domain: r.domain,
        churn_date: churnDate,
      };
      const c = classifyCsOverlap(input);
      expect(["review", "warn"], `row ${r.domain}`).toContain(c.verdict);
    }
  });

  test("government-domain churn uses 12-month cool-off", () => {
    if (!rows) return;
    // Find a .gov.sa termination row where the churn is between 180 and 365 days
    // ago. Such a row should be REVIEW under gov rules (would have been WARN under
    // private rules), proving the sector logic is active.
    const candidate = rows.find((r) => {
      if (r.stage !== "Termination") return false;
      if (!r.domain.endsWith(".gov.sa")) return false;
      if (!r.churn_date_serial) return false;
      const days = Math.floor(
        (Date.now() - excelSerialToDate(r.churn_date_serial).getTime()) /
          (1000 * 60 * 60 * 24),
      );
      return days > 180 && days < 365;
    });
    if (!candidate) {
      // eslint-disable-next-line no-console
      console.warn(
        "[duplicateRadarCsOverlap] no gov-domain row in 180-365 day window",
      );
      return;
    }
    const c = classifyCsOverlap({
      phase: candidate.stage,
      domain: candidate.domain,
      churn_date: excelSerialToDate(candidate.churn_date_serial!),
    });
    expect(c.sector).toBe("government");
    expect(c.verdict).toBe("review");
  });
});
