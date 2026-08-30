/**
 * fetchZohoRecords must send `criteria` to Zoho's /search endpoint.
 *
 * THE BUG THIS LOCKS IN (proven live 2026-08-17): criteria was appended to the
 * PLAIN LIST endpoint, where Zoho v2 silently ignores it — no error, just
 * unfiltered rows. GET /api/zoho/activities/Deals/<id> returned byte-identical
 * results for two unrelated deals because its What_Id filter did nothing, and
 * `id:equals:<recordId>` lookups elsewhere returned a DIFFERENT record.
 *
 * The list path must stay untouched: the Duplicate Radar's incremental sync
 * depends on it and on the If-Modified-Since header.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { fetchMock, warn } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

import { fetchZohoRecords } from "../../src/utils/zohoCRM";

/** Captures the URL + headers of the single request the helper issues. */
function lastRequest() {
  const call = fetchMock.mock.calls.at(-1);
  return { url: String(call?.[0] ?? ""), headers: (call?.[1]?.headers ?? {}) as Record<string, string> };
}

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [] }),
    json: async () => ({ data: [] }),
  });
  warn.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.ZOHO_ACCESS_TOKEN = "test-token";
  delete process.env.ZOHO_CLIENT_ID;
  delete process.env.ZOHO_REFRESH_TOKEN;
});

describe("fetchZohoRecords criteria routing", () => {
  it("sends criteria to /search, NOT the list endpoint", async () => {
    await fetchZohoRecords("Tasks", { criteria: "(What_Id:equals:123)" });
    const { url } = lastRequest();
    expect(url).toContain("/crm/v2/Tasks/search?");
    expect(url).toContain("criteria=");
    // The regression: the bare list path silently drops the filter.
    expect(url).not.toMatch(/\/crm\/v2\/Tasks\?/);
  });

  it("leaves the LIST endpoint untouched when there is no criteria", async () => {
    await fetchZohoRecords("Leads", { page: 2, perPage: 200 });
    const { url } = lastRequest();
    expect(url).toContain("/crm/v2/Leads?");
    expect(url).not.toContain("/search");
    expect(url).toContain("page=2");
  });

  it("still sends If-Modified-Since on the list path (incremental sync)", async () => {
    await fetchZohoRecords("Deals", { ifModifiedSince: "2026-08-01T00:00:00Z" });
    const { url, headers } = lastRequest();
    expect(url).toContain("/crm/v2/Deals?");
    // Zoho's documented header format: offset, NO milliseconds. This assertion
    // used to expect the raw `...Z` value passed in — which Zoho cannot parse,
    // so it SILENTLY ignored the header and returned the whole corpus, turning
    // the incremental sync into a full pull every run (2026-08-30).
    expect(headers["If-Modified-Since"]).toBe("2026-08-01T00:00:00+00:00");
  });

  it("normalises a millisecond timestamp to Zoho's header format", async () => {
    // Date.toISOString() — what the sync watermark actually produced.
    await fetchZohoRecords("Deals", { ifModifiedSince: "2026-08-30T14:36:24.442Z" });
    const { headers } = lastRequest();
    expect(headers["If-Modified-Since"]).toBe("2026-08-30T14:36:24+00:00");
  });

  it("drops an unparseable If-Modified-Since instead of sending garbage", async () => {
    await fetchZohoRecords("Deals", { ifModifiedSince: "not-a-date" });
    const { headers } = lastRequest();
    expect(headers["If-Modified-Since"]).toBeUndefined();
  });

  it("does NOT send If-Modified-Since on /search, and warns", async () => {
    await fetchZohoRecords("Calls", {
      criteria: "(Created_Time:greater_than:2026-08-01T00:00:00Z)",
      ifModifiedSince: "2026-08-01T00:00:00Z",
    });
    const { url, headers } = lastRequest();
    expect(url).toContain("/search");
    expect(headers["If-Modified-Since"]).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toMatch(/If-Modified-Since/i);
  });

  it("drops sort params on /search and warns that ordering is undefined", async () => {
    await fetchZohoRecords("Calls", {
      criteria: "(Created_Time:greater_than:2026-08-01T00:00:00Z)",
      sortBy: "Created_Time",
      sortOrder: "desc",
    });
    const { url } = lastRequest();
    expect(url).not.toContain("sort_by");
    expect(url).not.toContain("sort_order");
    expect(warn.mock.calls.flat().join(" ")).toMatch(/sort_by/i);
  });

  it("keeps sort params on the list path", async () => {
    await fetchZohoRecords("Deals", { sortBy: "Modified_Time", sortOrder: "desc" });
    const { url } = lastRequest();
    expect(url).toContain("sort_by=Modified_Time");
    expect(url).toContain("sort_order=desc");
    expect(warn).not.toHaveBeenCalled();
  });

  it("treats a 204 from /search as an empty result, not an error", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      text: async () => "",
      json: async () => ({}),
    });
    const out = await fetchZohoRecords("Tasks", { criteria: "(What_Id:equals:nope)" });
    expect(out).toEqual([]);
  });
});
