/**
 * Unit tests for the CS-overlap auto-CAPA helper.
 *
 * Run: npx vitest run tests/vitest/csOverlapAutoCapa.vitest.test.ts
 *
 * Scope: pure helpers and the env-disabled short-circuit. The DB-touching
 * paths (`autoOpenCapasForBlockClusters` when enabled) are validated
 * manually against the live database; here we only cover the deterministic
 * pieces so we don't need pg connectivity in CI.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  AUTO_CAPA_SOURCE_ID_PREFIX,
  AUTO_CAPA_SOURCE_TYPE,
  autoOpenCapasForBlockClusters,
  clusterSourceId,
} from "../../src/utils/csOverlapAutoCapa";

afterEach(() => {
  delete process.env.AUTO_CAPA_ON_BLOCK_ENABLED;
  delete process.env.AUTO_CAPA_ARR_THRESHOLD_SAR;
});

describe("clusterSourceId", () => {
  test("formats as prefix + cluster id", () => {
    expect(clusterSourceId(42)).toBe(`${AUTO_CAPA_SOURCE_ID_PREFIX}:42`);
  });
});

describe("AUTO_CAPA_SOURCE_TYPE", () => {
  test("is the constant the DB layer keys on for idempotency", () => {
    expect(AUTO_CAPA_SOURCE_TYPE).toBe("cs_overlap_block");
  });
});

describe("autoOpenCapasForBlockClusters — env-disabled short-circuit", () => {
  test("returns enabled=false with zero counts when disabled by env", async () => {
    process.env.AUTO_CAPA_ON_BLOCK_ENABLED = "false";
    const result = await autoOpenCapasForBlockClusters({});
    expect(result.enabled).toBe(false);
    expect(result.created).toBe(0);
    expect(result.candidates).toBe(0);
    expect(result.capa_numbers).toEqual([]);
  });

  test("explicit enabled:false overrides env", async () => {
    process.env.AUTO_CAPA_ON_BLOCK_ENABLED = "true";
    const result = await autoOpenCapasForBlockClusters({ enabled: false });
    expect(result.enabled).toBe(false);
  });

  test("respects env threshold (returns it in summary even when disabled)", async () => {
    process.env.AUTO_CAPA_ON_BLOCK_ENABLED = "false";
    process.env.AUTO_CAPA_ARR_THRESHOLD_SAR = "500000";
    const result = await autoOpenCapasForBlockClusters({});
    expect(result.threshold_sar).toBe(500_000);
  });

  test("explicit thresholdSar overrides env", async () => {
    process.env.AUTO_CAPA_ON_BLOCK_ENABLED = "false";
    process.env.AUTO_CAPA_ARR_THRESHOLD_SAR = "500000";
    const result = await autoOpenCapasForBlockClusters({
      thresholdSar: 250_000,
    });
    expect(result.threshold_sar).toBe(250_000);
  });
});
