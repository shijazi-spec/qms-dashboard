/**
 * docTrackerStream — Server-Sent Events fan-out for the Documentation Tracker.
 *
 * ⚠️ THIS REGISTRY IS PER-INSTANCE. `clients` is module-scoped in-process, so a
 * browser connected to instance A never receives a broadcast originating from an
 * ingest handled by instance B. That is the same latent limitation the Duplicate
 * Radar stream already has, and it is acceptable ONLY because the page treats
 * SSE as an accelerator on top of a 60-second poll, never as the source of
 * truth. Do not build UI that is correct only if an SSE frame arrives.
 *
 * Structure copied from duplicateRadarRoutes: filter-on-enqueue to drop dead
 * controllers, a 15s comment keepalive (unref'd so tests can still exit), and
 * `X-Accel-Buffering: no` because the Replit proxy will otherwise buffer the
 * stream and nothing is delivered until it closes.
 */

import { logger } from "./logger";

interface StreamClient {
  id: string;
  controller: ReadableStreamDefaultController;
}

let clients: StreamClient[] = [];

/**
 * Cap concurrent listeners. This page is designed to be left open all day on a
 * wall display, and the duplicate-radar version it is modelled on has no cap at
 * all — an unbounded registry is a slow memory leak.
 */
export const MAX_SSE_CLIENTS = 50;

export function clientCount(): number {
  return clients.length;
}

/** Fan out one event. Controllers that throw are closed and dropped. */
export function broadcast(event: string, data: unknown): void {
  if (clients.length === 0) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  const encoded = new TextEncoder().encode(msg);
  clients = clients.filter((c) => {
    try {
      c.controller.enqueue(encoded);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Build the SSE response for one subscriber. `initial` is sent immediately as a
 * `connected` event so the page has state without waiting for the first change.
 */
export function createStream(initial: unknown): Response | null {
  if (clients.length >= MAX_SSE_CLIENTS) {
    logger.warn(
      `[DocTracker] SSE client cap reached (${MAX_SSE_CLIENTS}) — refusing new subscriber`,
    );
    return null;
  }
  const id = `dt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let keepAlive: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    start(controller) {
      clients.push({ id, controller });
      try {
        controller.enqueue(
          new TextEncoder().encode(
            `event: connected\ndata: ${JSON.stringify(initial)}\n\n`,
          ),
        );
      } catch {
        /* client vanished between accept and first write */
      }
      keepAlive = setInterval(() => {
        try {
          controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
        } catch {
          clearInterval(keepAlive);
          keepAlive = undefined;
        }
      }, 15000);
      // Let the Node event loop exit even while this interval is pending;
      // cancel() clears it explicitly when the client disconnects.
      keepAlive.unref();
    },
    cancel() {
      clearInterval(keepAlive);
      keepAlive = undefined;
      clients = clients.filter((c) => c.id !== id);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
