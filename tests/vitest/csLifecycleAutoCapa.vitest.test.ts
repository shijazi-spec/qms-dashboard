/**
 * Unit tests for the CS-Lifecycle auto-CAPA helper.
 *
 * Run: npx vitest run tests/vitest/csLifecycleAutoCapa.vitest.test.ts
 *
 * Scope: pure helpers and the env-disabled / empty-severities short-circuits.
 * The DB-touching paths require a live database and are covered by manual
 * integration testing once deployed.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  AUTO_CAPA_LIFECYCLE_SOURCE_ID_PREFIX,
  AUTO_CAPA_LIFECYCLE_SOURCE_TYPE,
  autoOpenCapasForCsLifecycle,
  violationSourceId,
} from "../../src/utils/csLifecycleAutoCapa";

afterEach(() => {
  delete process.env.AUTO_CAPA_LIFECYCLE_ENABLED;
  delete process.env.AUTO_CAPA_LIFECYCLE_SEVERITIES;
  delete process.env.AUTO_CAPA_LIFECYCLE_CODES;
  delete process.env.AUTO_CAPA_GLOBAL_ENABLED;
});

describe("violationSourceId", () => {
  test("formats as prefix:recordId:code", () => {
    expect(violationSourceId(123, "phase_churn_desync")).toBe(
      `${AUTO_CAPA_LIFECYCLE_SOURCE_ID_PREFIX}:123:phase_churn_desync`,
    );
  });
  test("uniqueness — same record, different codes", () => {
    const a = violationSourceId(99, "onboarding_overdue");
    const b = violationSourceId(99, "termination_missing_churn_date");
    expect(a).not.toBe(b);
  });
});

describe("AUTO_CAPA_LIFECYCLE_SOURCE_TYPE", () => {
  test("matches the constant the DB layer keys on for idempotency", () => {
    expect(AUTO_CAPA_LIFECYCLE_SOURCE_TYPE).toBe("cs_lifecycle_violation");
  });
});

describe("autoOpenCapasForCsLifecycle — env-disabled short-circuit", () => {
  test("returns enabled=false with zero counts when disabled by env", async () => {
    process.env.AUTO_CAPA_LIFECYCLE_ENABLED = "false";
    const result = await autoOpenCapasForCsLifecycle({});
    expect(result.enabled).toBe(false);
    expect(result.created).toBe(0);
    expect(result.candidates).toBe(0);
    expect(result.capa_numbers).toEqual([]);
  });

  test("explicit enabled:false overrides env", async () => {
    process.env.AUTO_CAPA_LIFECYCLE_ENABLED = "true";
    const result = await autoOpenCapasForCsLifecycle({ enabled: false });
    expect(result.enabled).toBe(false);
  });

  test("default severities = ['critical']", async () => {
    process.env.AUTO_CAPA_LIFECYCLE_ENABLED = "false";
    const result = await autoOpenCapasForCsLifecycle({});
    expect(result.severities).toEqual(["critical"]);
  });

  test("env can expand severities to critical+warning", async () => {
    process.env.AUTO_CAPA_LIFECYCLE_ENABLED = "false";
    process.env.AUTO_CAPA_LIFECYCLE_SEVERITIES = "critical,warning";
    const result = await autoOpenCapasForCsLifecycle({});
    expect(result.severities).toEqual(["critical", "warning"]);
  });

  test("explicit severities option overrides env", async () => {
    process.env.AUTO_CAPA_LIFECYCLE_ENABLED = "false";
    process.env.AUTO_CAPA_LIFECYCLE_SEVERITIES = "info";
    const result = await autoOpenCapasForCsLifecycle({
      severities: ["critical"],
    });
    expect(result.severities).toEqual(["critical"]);
  });

  test("env codes filter is exposed in result", async () => {
    process.env.AUTO_CAPA_LIFECYCLE_ENABLED = "false";
    process.env.AUTO_CAPA_LIFECYCLE_CODES = "phase_churn_desync";
    const result = await autoOpenCapasForCsLifecycle({});
    expect(result.codes_filter).toEqual(["phase_churn_desync"]);
  });

  test("empty severities list short-circuits even when enabled", async () => {
    // Global switch on so we genuinely exercise the empty-severities branch
    // (not the global kill-switch).
    process.env.AUTO_CAPA_GLOBAL_ENABLED = "true";
    const result = await autoOpenCapasForCsLifecycle({
      enabled: true,
      severities: [],
    });
    expect(result.candidates).toBe(0);
    expect(result.created).toBe(0);
  });

  test("GLOBAL kill-switch off (default) disables auto-CAPA even when opts.enabled=true", async () => {
    // AUTO_CAPA_GLOBAL_ENABLED unset → default false → nothing runs, regardless
    // of opts.enabled or per-feature env. This is the platform-prep freeze.
    process.env.AUTO_CAPA_LIFECYCLE_ENABLED = "true";
    const result = await autoOpenCapasForCsLifecycle({
      enabled: true,
      severities: ["critical"],
    });
    expect(result.enabled).toBe(false);
    expect(result.created).toBe(0);
    expect(result.candidates).toBe(0);
  });
});
