/**
 * runZohoCallsImport's precondition guard.
 *
 * REGRESSION THIS LOCKS IN (observed live 2026-08-17): the guard used to test
 * `conn.connected`, which is `!!cachedAccessToken && !isTokenExpired()` — "a
 * token is already warm IN THIS PROCESS". That is not a statement about
 * whether Zoho is usable: getValidAccessToken() refreshes on demand, so the
 * fetch succeeds from a cold cache on its own.
 *
 * The effect was that the FIRST import after every server restart failed with
 * "Zoho is not connected" while the Duplicate Radar was syncing from Zoho
 * perfectly — and a republish restarts the server, so it fired on exactly the
 * run an operator was most likely to make.
 *
 * The guard now tests `configured`. A cold-but-configured connection must
 * reach the fetch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchAllZohoRecords, getZohoConnectionStatus, createCallRecord } =
  vi.hoisted(() => ({
    fetchAllZohoRecords: vi.fn(),
    getZohoConnectionStatus: vi.fn(),
    createCallRecord: vi.fn(),
  }));

vi.mock("../../src/utils/zohoCRM", () => ({
  fetchAllZohoRecords,
  getZohoConnectionStatus,
}));
vi.mock("../../src/utils/callIntelligenceDb", () => ({ createCallRecord }));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runZohoCallsImport } from "../../src/utils/zohoCallsImport";

/** Base status: OAuth present, token NOT warm — the post-restart state. */
const COLD_BUT_CONFIGURED = {
  configured: true,
  connected: false,
  autoRefresh: true,
  tokenCached: false,
  tokenExpired: true,
  rateLimited: false,
  cooldownMsRemaining: 0,
  message: "",
};

beforeEach(() => {
  fetchAllZohoRecords.mockReset().mockResolvedValue([]);
  createCallRecord.mockReset();
  // Default to the normal state — configured, token not yet warm. Tests that
  // exercise a specific connection state override it. Without a default, a
  // reset-only mock returns undefined and every new test in this file dies on
  // "Cannot read properties of undefined (reading 'configured')".
  getZohoConnectionStatus.mockReset().mockReturnValue(COLD_BUT_CONFIGURED);
});

describe("runZohoCallsImport precondition guard", () => {
  it("PROCEEDS when configured but the token cache is cold (the regression)", async () => {
    getZohoConnectionStatus.mockReturnValue(COLD_BUT_CONFIGURED);
    const res = await runZohoCallsImport({ maxRecords: 10 });
    // The fetch must be attempted — getValidAccessToken refreshes on demand.
    expect(fetchAllZohoRecords).toHaveBeenCalledTimes(1);
    expect(fetchAllZohoRecords.mock.calls[0][0]).toBe("Calls");
    expect(res.errors).toBe(0);
    expect(res.error_samples.join(" ")).not.toMatch(/not connected/i);
  });

  it("bails when Zoho is NOT configured, without calling Zoho", async () => {
    getZohoConnectionStatus.mockReturnValue({
      ...COLD_BUT_CONFIGURED,
      configured: false,
    });
    const res = await runZohoCallsImport({ maxRecords: 10 });
    expect(fetchAllZohoRecords).not.toHaveBeenCalled();
    expect(res.errors).toBe(1);
    expect(res.error_samples[0]).toMatch(/not configured/i);
  });

  it("bails while rate-limited, surfacing the cooldown message", async () => {
    getZohoConnectionStatus.mockReturnValue({
      ...COLD_BUT_CONFIGURED,
      rateLimited: true,
      cooldownMsRemaining: 30000,
      message: "Zoho OAuth is cooling down — ~30s remaining",
    });
    const res = await runZohoCallsImport({ maxRecords: 10 });
    expect(fetchAllZohoRecords).not.toHaveBeenCalled();
    expect(res.errors).toBe(1);
    expect(res.error_samples[0]).toMatch(/cooling down/i);
  });

  it("still proceeds when the token IS warm", async () => {
    getZohoConnectionStatus.mockReturnValue({
      ...COLD_BUT_CONFIGURED,
      connected: true,
      tokenCached: true,
      tokenExpired: false,
    });
    await runZohoCallsImport({ maxRecords: 10 });
    expect(fetchAllZohoRecords).toHaveBeenCalledTimes(1);
  });
});

describe("runZohoCallsImport — pagination", () => {
  it("uses the PAGINATED fetch and forwards maxRecords", async () => {
    // The single-page fetch caps at Zoho's 200-per-page limit, so the import
    // silently stopped at 200 calls no matter what `max` was set to. Measured
    // live 2026-08-17: max=2000 still returned "scanned: 200". It looked like
    // the window worked because each run returned a slightly different 200 as
    // records were modified, so the total crept up and masked the cap.
    await runZohoCallsImport({ maxRecords: 2000 });
    expect(fetchAllZohoRecords).toHaveBeenCalledTimes(1);
    const [module, params] = fetchAllZohoRecords.mock.calls[0];
    expect(module).toBe("Calls");
    expect(params.maxRecords).toBe(2000);
    // perPage would re-impose the single-page cap.
    expect(params.perPage).toBeUndefined();
  });

  it("still windows by If-Modified-Since, never criteria", async () => {
    await runZohoCallsImport({ sinceIso: "2026-07-01T00:00:00Z" });
    const params = fetchAllZohoRecords.mock.calls[0][1];
    expect(params.ifModifiedSince).toBe("2026-07-01T00:00:00Z");
    expect(params.criteria).toBeUndefined();
  });
});
