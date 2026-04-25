/**
 * Lightweight Hono-compatible context stub for unit/integration testing
 * route handlers in isolation (no network, no live server).
 *
 * Returned by makeContext({ ... }), an object that mirrors the small surface
 * area each route handler in src/mastra/routes/*.ts uses:
 *   c.req.header(name)         → string | undefined
 *   c.req.query(name)          → string | undefined
 *   c.req.param(name)          → string | undefined
 *   c.req.json()               → Promise<any>
 *   c.req.url                  → string
 *   c.req.method               → string
 *   c.json(body, status?)      → { status, body, headers } (captured response)
 *   c.header(name, value)      → records response header
 *
 * Used by:
 *   tests/dashboardApiRoutes.test.ts
 *   tests/adminApiRoutes.test.ts
 *   tests/qmsApiRoutes.test.ts
 */

export interface FakeRequestInit {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: unknown;
}

export interface CapturedResponse {
  status: number;
  body: any;
  headers: Record<string, string>;
}

export interface FakeContext {
  req: {
    header: (name: string) => string | undefined;
    query: (name: string) => string | undefined;
    param: (name: string) => string | undefined;
    json: () => Promise<any>;
    url: string;
    method: string;
  };
  json: (body: any, status?: number) => CapturedResponse;
  header: (name: string, value: string, options?: { append?: boolean }) => void;
  text: (body: string, status?: number) => CapturedResponse;
  html: (body: string, status?: number) => CapturedResponse;
  body: (body: any, status?: number) => CapturedResponse;
  redirect: (url: string, status?: number) => CapturedResponse;
  responseHeaders: Record<string, string>;
}

function lowerKeyMap(input: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(input)) out[k.toLowerCase()] = input[k];
  return out;
}

export function makeContext(init: FakeRequestInit = {}): FakeContext {
  const headers = lowerKeyMap(init.headers);
  const query = init.query ?? {};
  const params = init.params ?? {};
  const responseHeaders: Record<string, string> = {};

  const ctx: FakeContext = {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      query: (name: string) => query[name],
      param: (name: string) => params[name],
      json: async () => {
        if (init.body === undefined) {
          throw new SyntaxError("Unexpected end of JSON input");
        }
        return init.body;
      },
      url: init.url ?? "http://localhost:5000/",
      method: init.method ?? "GET",
    },
    json: (body: any, status?: number) => ({
      status: status ?? 200,
      body,
      headers: { ...responseHeaders },
    }),
    text: (body: string, status?: number) => ({
      status: status ?? 200,
      body,
      headers: { ...responseHeaders },
    }),
    html: (body: string, status?: number) => ({
      status: status ?? 200,
      body,
      headers: { ...responseHeaders, "Content-Type": "text/html; charset=utf-8" },
    }),
    body: (body: any, status?: number) => ({
      status: status ?? 200,
      body,
      headers: { ...responseHeaders },
    }),
    redirect: (url: string, status?: number) => {
      responseHeaders["Location"] = url;
      return { status: status ?? 302, body: "", headers: { ...responseHeaders } };
    },
    header: (name: string, value: string, options?: { append?: boolean }) => {
      // Mirror Hono's `c.header(name, value, { append: true })` semantics
      // for headers that may legitimately appear multiple times in a single
      // response (Set-Cookie, Link, etc.). When appending, we join values
      // with ", " so a single string lookup like `headers["Set-Cookie"]`
      // still surfaces every value the handler emitted.
      if (options?.append && responseHeaders[name]) {
        responseHeaders[name] = `${responseHeaders[name]}, ${value}`;
      } else {
        responseHeaders[name] = value;
      }
    },
    responseHeaders,
  };

  return ctx;
}

/**
 * Helper: locate a route definition (path + method) in a list and instantiate
 * its handler by calling createHandler({ mastra }). Returns the inner async
 * handler ready to be called with a FakeContext.
 */
export async function buildHandler(
  routes: Array<{
    path: string;
    method: string;
    createHandler: (deps: any) => any | Promise<any>;
  }>,
  path: string,
  method: string,
  deps: any = { mastra: null },
): Promise<(c: FakeContext) => Promise<CapturedResponse>> {
  const route = routes.find((r) => r.path === path && r.method === method);
  if (!route) {
    throw new Error(`Route not found: ${method} ${path}`);
  }
  const handler = await route.createHandler(deps);
  return handler as (c: FakeContext) => Promise<CapturedResponse>;
}
