/**
 * Controlled-document bytes live in the DATABASE, not on the deployment's disk.
 *
 * fileUpload wrote to <cwd>/data/documents. Replit rebuilds that directory from
 * the repo on every publish and `data/` is untracked, so every uploaded
 * document was destroyed at the next deploy while its policies row kept
 * claiming a file. The CS SOP's Open button served
 * {"error":"File not found on disk"} (observed live 2026-08-19) — the worst
 * state for a controlled document, because the register asserts the process is
 * attached and it is not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../src/utils/redactedPool", () => ({
  createRedactedPool: () => ({
    query: (...a: any[]) => query(...a),
    connect: async () => ({ query: (...a: any[]) => query(...a), release: () => {} }),
  }),
}));
vi.mock("../../src/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  savePolicyFile,
  getPolicyFile,
  deletePolicyFile,
  policiesWithFiles,
} from "../../src/utils/policyDatabase";

const lastSql = () => String(query.mock.calls.at(-1)?.[0] ?? "");
const lastParams = () => (query.mock.calls.at(-1)?.[1] ?? []) as any[];

beforeEach(() => query.mockReset().mockResolvedValue({ rows: [] }));

describe("bytes are stored in the database", () => {
  it("writes the buffer into policy_files, not the filesystem", async () => {
    const data = Buffer.from("%PDF-1.7 fake");
    await savePolicyFile(7, { data, fileName: "sop.pdf", fileSize: data.length, mimeType: "application/pdf" });
    expect(lastSql()).toMatch(/INSERT INTO policy_files/i);
    expect(lastParams()).toContain(data);
  });

  it("replaces rather than accumulating on re-upload", async () => {
    await savePolicyFile(7, { data: Buffer.from("v2"), fileName: "sop.pdf", fileSize: 2 });
    // policy_id is the primary key — one file per document. The old behaviour
    // left the previous blob orphaned on disk with every replacement.
    expect(lastSql()).toMatch(/ON CONFLICT \(policy_id\) DO UPDATE/i);
    expect(lastSql()).toMatch(/data=EXCLUDED\.data/);
  });

  it("reads the bytes back for a single policy", async () => {
    query.mockResolvedValue({
      rows: [{ data: Buffer.from("x"), file_name: "sop.pdf", file_size: 1, file_mime_type: "application/pdf" }],
    });
    const f = await getPolicyFile(7);
    expect(f?.file_name).toBe("sop.pdf");
    expect(lastSql()).toMatch(/FROM policy_files WHERE policy_id = \$1/i);
  });

  it("returns null when the document has no file", async () => {
    expect(await getPolicyFile(7)).toBeNull();
  });

  it("detaches a file", async () => {
    await deletePolicyFile(7);
    expect(lastSql()).toMatch(/DELETE FROM policy_files WHERE policy_id = \$1/i);
  });
});

describe("has_file reflects the bytes, never the metadata", () => {
  it("reports only the policies that actually have a file", async () => {
    query.mockResolvedValue({ rows: [{ policy_id: 2 }] });
    const s = await policiesWithFiles([1, 2, 3]);
    // 1 and 3 may still carry file_name and file_size from a deploy that ate
    // their bytes. Only 2 can be opened.
    expect([...s]).toEqual([2]);
  });

  it("does not query at all for an empty id list", async () => {
    const s = await policiesWithFiles([]);
    expect(s.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("never selects the BYTEA column when listing", async () => {
    query.mockResolvedValue({ rows: [{ policy_id: 1 }] });
    await policiesWithFiles([1]);
    // Pulling `data` here would ship every document's megabytes into the
    // Quality Reports SOPs box. That is also why the bytes are a separate
    // table: policies is queried with SELECT * all over the codebase.
    expect(lastSql()).not.toMatch(/\bdata\b/);
    expect(lastSql()).toMatch(/SELECT policy_id/i);
  });
});
