/**
 * Guards against the regression class flagged in code review of task #697:
 * if `GET /api/audits/export` (or `/export/estimate`) is registered AFTER
 * the dynamic `GET /api/audits/:id` handler, Hono treats "export" as the
 * :id param and serves audit-detail JSON / 404 instead of the streamed
 * CSV. The toolbar "Export Audits CSV" button would silently break.
 *
 * This test asserts the route table's declaration order so any future
 * refactor that re-shuffles auditRoutes.ts must update this test
 * deliberately.
 */
import { describe, it, expect } from 'vitest';
import { auditRoutes } from '../../src/mastra/routes/auditRoutes';

interface RouteEntry {
  path: string;
  method: string;
}

describe('auditRoutes — literal export segments registered before /:id', () => {
  const getRoutes: RouteEntry[] = (auditRoutes as RouteEntry[]).filter(
    (r) => r.method === 'GET',
  );

  function indexOfPath(path: string): number {
    return getRoutes.findIndex((r) => r.path === path);
  }

  it('declares /api/audits/export', () => {
    expect(indexOfPath('/api/audits/export')).toBeGreaterThanOrEqual(0);
  });

  it('declares /api/audits/export/estimate', () => {
    expect(indexOfPath('/api/audits/export/estimate')).toBeGreaterThanOrEqual(0);
  });

  it('registers /api/audits/export BEFORE /api/audits/:id so it is not shadowed', () => {
    const exportIdx = indexOfPath('/api/audits/export');
    const dynamicIdx = indexOfPath('/api/audits/:id');
    expect(exportIdx).toBeGreaterThanOrEqual(0);
    expect(dynamicIdx).toBeGreaterThanOrEqual(0);
    expect(exportIdx).toBeLessThan(dynamicIdx);
  });

  it('registers /api/audits/export/estimate BEFORE /api/audits/:id so it is not shadowed', () => {
    const estimateIdx = indexOfPath('/api/audits/export/estimate');
    const dynamicIdx = indexOfPath('/api/audits/:id');
    expect(estimateIdx).toBeGreaterThanOrEqual(0);
    expect(dynamicIdx).toBeGreaterThanOrEqual(0);
    expect(estimateIdx).toBeLessThan(dynamicIdx);
  });
});

describe('auditRoutes — /api/audits/export/estimate contract', () => {
  const route = (auditRoutes as RouteEntry[]).find(
    (r) => r.path === '/api/audits/export/estimate' && r.method === 'GET',
  );

  it('exposes a GET handler', () => {
    expect(route).toBeDefined();
  });

  it('runs a parameterized COUNT scoped to the requested ?status= filter', async () => {
    /**
     * The estimate endpoint executes a single SELECT COUNT(*) — no cursor
     * stream — so we can drive it with a minimal fake pg.Pool and assert
     * both the SQL shape (literal `WHERE status = $1`) and the bound
     * parameter without touching a database. This proves the route honours
     * the active status filter end-to-end (the same contract the toolbar
     * button relies on when the user narrows the schedule).
     */
    const seenQueries: Array<{ sql: string; params: unknown[] }> = [];
    const fakePool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
      query: async (sql: string, params: unknown[] = []) => {
        seenQueries.push({ sql, params });
        return { rows: [{ total: 7 }] };
      },
      end: async () => {},
    };

    const pgModule = (await import('pg')) as unknown as {
      default: { Pool: new (...args: unknown[]) => unknown };
    };
    const realPool = pgModule.default.Pool;
    pgModule.default.Pool = function FakePool() {
      return fakePool;
    } as unknown as typeof realPool;

    try {
      const handler = await (route!.createHandler as unknown as () => Promise<
        (c: unknown) => Promise<Response>
      >)();
      const fakeCtx = {
        req: { url: 'http://localhost/api/audits/export/estimate?status=in_progress' },
        json: (obj: unknown, status = 200) =>
          new Response(JSON.stringify(obj), {
            status,
            headers: { 'Content-Type': 'application/json' },
          }),
      };

      const res = await handler(fakeCtx);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: number; format: string };
      expect(body.rows).toBe(7);
      expect(body.format).toBe('csv');

      const countQuery = seenQueries.find((q) => q.sql.includes('COUNT(*)'));
      expect(countQuery).toBeDefined();
      expect(countQuery!.sql).toMatch(/WHERE\s+status\s*=\s*\$1/);
      expect(countQuery!.params).toEqual(['in_progress']);
    } finally {
      pgModule.default.Pool = realPool;
    }
  });

  it('omits the WHERE clause when no ?status= filter is supplied', async () => {
    const seenQueries: Array<{ sql: string; params: unknown[] }> = [];
    const fakePool = {
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
      query: async (sql: string, params: unknown[] = []) => {
        seenQueries.push({ sql, params });
        return { rows: [{ total: 0 }] };
      },
      end: async () => {},
    };
    const pgModule = (await import('pg')) as unknown as {
      default: { Pool: new (...args: unknown[]) => unknown };
    };
    const realPool = pgModule.default.Pool;
    pgModule.default.Pool = function FakePool() {
      return fakePool;
    } as unknown as typeof realPool;
    try {
      const handler = await (route!.createHandler as unknown as () => Promise<
        (c: unknown) => Promise<Response>
      >)();
      await handler({
        req: { url: 'http://localhost/api/audits/export/estimate' },
        json: (obj: unknown, status = 200) =>
          new Response(JSON.stringify(obj), { status }),
      });
      const countQuery = seenQueries.find((q) => q.sql.includes('COUNT(*)'));
      expect(countQuery).toBeDefined();
      expect(countQuery!.sql).not.toMatch(/WHERE/);
      expect(countQuery!.params).toEqual([]);
    } finally {
      pgModule.default.Pool = realPool;
    }
  });
});
