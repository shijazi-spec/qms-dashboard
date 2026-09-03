/**
 * Derive a UNIQUE Inngest function id for an Hono API route registered via
 * `registerApiRoute()`.
 *
 * The id MUST be unique per route *path*. Several routes can legitimately share
 * a first path segment — e.g. `/webhooks/ChatProvider/action`,
 * `/webhooks/ChatProvider/consultant-rating`, and `/webhooks/telegram/action` all start
 * with `webhooks`. Deriving the id from only that first segment produced
 * duplicate `api-webhooks` ids, which makes `inngest.serve()` throw
 * "Duplicate function ID" at boot and exits the process before the HTTP port
 * opens (visible only as a deploy healthcheck 500). Derive the id from the full
 * path instead so every distinct route gets a distinct id.
 *
 * NOTE: this is intentionally separate from the Inngest *event* name, which
 * stays keyed on the first path segment so connectors registered via
 * `createWebhook` (e.g. `/linear/webhook` -> `event/api.webhooks.linear.action`)
 * keep matching their emitted events.
 */
export function apiRouteFunctionId(path: string): string {
  const routeSlug =
    path.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  return `api-${routeSlug}`;
}
