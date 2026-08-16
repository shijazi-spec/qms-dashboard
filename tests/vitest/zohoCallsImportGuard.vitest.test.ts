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

const { fetchZohoRecords, getZohoConnectionStatus, createCallRecord } =
  vi.hoisted(() => ({
    fetchZohoRecords: vi.fn(),
    getZohoConnectionStatus: vi.fn(),
    createCallRecord: vi.fn(),
  }));

vi.mock("../../src/utils/zohoCRM", () => ({
  fetchZohoRecords,
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
  fetchZohoRecords.mockReset().mockResolvedValue([]);
  createCallRecord.mockReset();
  getZohoConnectionStatus.mockReset();
});

describe("runZohoCallsImport precondition guard", () => {
  it("PROCEEDS when configured but the token cache is cold (the regression)", async () => {
    getZohoConnectionStatus.mockReturnValue(COLD_BUT_CONFIGURED);
    const res = await runZohoCallsImport({ maxRecords: 10 });
    // The fetch must be attempted — getValidAccessToken refreshes on demand.
    expect(fetchZohoRecords).toHaveBeenCalledTimes(1);
    expect(fetchZohoRecords.mock.calls[0][0]).toBe("Calls");
    expect(res.errors).toBe(0);
    expect(res.error_samples.join(" ")).not.toMatch(/not connected/i);
  });

  it("bails when Zoho is NOT configured, without calling Zoho", async () => {
    getZohoConnectionStatus.mockReturnValue({
      ...COLD_BUT_CONFIGURED,
      configured: false,
    });
    const res = await runZohoCallsImport({ maxRecords: 10 });
    expect(fetchZohoRecords).not.toHaveBeenCalled();
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
    expect(fetchZohoRecords).not.toHaveBeenCalled();
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
    expect(fetchZohoRecords).toHaveBeenCalledTimes(1);
  });
});
