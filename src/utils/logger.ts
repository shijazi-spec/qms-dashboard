/**
 * Safe structured logger — wraps pino and applies two layers of redaction
 * before writing to stdout, matching the defence-in-depth used in
 * eventLogsDatabase.ts for the audit trail.
 *
 *   Layer 1 — key-based + string-pattern redaction on every payload object
 *             (redactSensitiveDeep: catches `access_token: "…"` AND
 *              `summary: "rotated key sk_live_…"` inside a `note` field).
 *
 *   Layer 2 — regex scrub on the log message string itself
 *             (redactSecretLikeStrings: catches credential-shaped substrings
 *              that a caller interpolated directly into the message, e.g.
 *              logger.error(`token refresh failed: ${rawResponseBody}`)).
 *
 * Usage:
 *   import { logger } from '@/utils/logger';
 *   logger.info('Token refreshed', { userId, expires_in });
 *   logger.error('OAuth failure', { error: err.message, provider });
 *
 * Structured data is passed as optional additional arguments (objects).
 * Multiple objects are merged before redaction; non-object primitives are
 * attached under an `extra` field so they are never silently dropped.
 */

import pino from "pino";
import {
  redactSensitiveDeep,
  redactSecretLikeStrings,
} from "./sensitiveRedaction";

const pinoInstance = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: { colorize: true, ignore: "pid,hostname" },
        }
      : undefined,
});

type LogPayload =
  | Record<string, unknown>
  | Error
  | string
  | number
  | boolean
  | null
  | undefined;

function sanitise(value: LogPayload): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    const obj = {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
    return redactSensitiveDeep(obj);
  }
  if (typeof value === "object") {
    return redactSensitiveDeep(value as Record<string, unknown>);
  }
  return value;
}

function scrubMessage(msg: string): string {
  const result = redactSecretLikeStrings(msg);
  return typeof result === "string" ? result : msg;
}

function mergePayloads(data: LogPayload[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const item of data) {
    if (item === null || item === undefined) continue;
    if (item instanceof Error) {
      const sanitised = sanitise(item) as Record<string, unknown>;
      Object.assign(merged, sanitised);
    } else if (typeof item === "object") {
      Object.assign(merged, sanitise(item));
    } else {
      const extras = (merged.extra as unknown[]) ?? [];
      extras.push(item);
      merged.extra = extras;
    }
  }
  return merged;
}

// In non-production environments (dev + test) we route through console.* so:
//   1. Tests that stub console.error / console.warn (the convention used
//      throughout this codebase pre-Task #356) continue to capture output.
//   2. console.warn / console.error preserve their natural fd-2 (stderr)
//      routing, which the (z7-boot) child-process test asserts against.
//   3. The dev console is uncluttered by the pino-pretty wrapper line noise.
// Only in production do we route through pino so log aggregators see the
// structured JSON stream they expect.
const useConsoleSink = process.env.NODE_ENV !== "production";

export const logger = {
  info(message: string, ...data: LogPayload[]): void {
    const msg = scrubMessage(message);
    const merged = data.length === 0 ? undefined : mergePayloads(data);
    if (useConsoleSink) {
      if (merged) console.log(msg, merged);
      else console.log(msg);
      return;
    }
    if (merged) pinoInstance.info(merged, msg);
    else pinoInstance.info(msg);
  },

  error(message: string, ...data: LogPayload[]): void {
    const msg = scrubMessage(message);
    const merged = data.length === 0 ? undefined : mergePayloads(data);
    if (useConsoleSink) {
      if (merged) console.error(msg, merged);
      else console.error(msg);
      return;
    }
    if (merged) pinoInstance.error(merged, msg);
    else pinoInstance.error(msg);
  },

  warn(message: string, ...data: LogPayload[]): void {
    const msg = scrubMessage(message);
    const merged = data.length === 0 ? undefined : mergePayloads(data);
    if (useConsoleSink) {
      if (merged) console.warn(msg, merged);
      else console.warn(msg);
      return;
    }
    if (merged) pinoInstance.warn(merged, msg);
    else pinoInstance.warn(msg);
  },

  debug(message: string, ...data: LogPayload[]): void {
    const msg = scrubMessage(message);
    const merged = data.length === 0 ? undefined : mergePayloads(data);
    if (useConsoleSink) {
      if (merged) console.debug(msg, merged);
      else console.debug(msg);
      return;
    }
    if (merged) pinoInstance.debug(merged, msg);
    else pinoInstance.debug(msg);
  },
};

export function safeLog(message: string, ...data: LogPayload[]): void {
  logger.info(message, ...data);
}

export {
  sanitise as _sanitiseForTest,
  mergePayloads as _mergePayloadsForTest,
  scrubMessage as _scrubMessageForTest,
};
