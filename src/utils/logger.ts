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

import pino from 'pino';
import { redactSensitiveDeep, redactSecretLikeStrings } from './eventLogsDatabase';

const pinoInstance = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } }
      : undefined,
});

type LogPayload = Record<string, unknown> | Error | string | number | boolean | null | undefined;

function sanitise(value: LogPayload): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    const obj = { message: value.message, name: value.name, stack: value.stack };
    return redactSensitiveDeep(obj);
  }
  if (typeof value === 'object') {
    return redactSensitiveDeep(value as Record<string, unknown>);
  }
  return value;
}

function scrubMessage(msg: string): string {
  const result = redactSecretLikeStrings(msg);
  return typeof result === 'string' ? result : msg;
}

function mergePayloads(data: LogPayload[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const item of data) {
    if (item === null || item === undefined) continue;
    if (item instanceof Error) {
      const sanitised = sanitise(item) as Record<string, unknown>;
      Object.assign(merged, sanitised);
    } else if (typeof item === 'object') {
      Object.assign(merged, sanitise(item));
    } else {
      const extras = (merged.extra as unknown[]) ?? [];
      extras.push(item);
      merged.extra = extras;
    }
  }
  return merged;
}

export const logger = {
  info(message: string, ...data: LogPayload[]): void {
    const msg = scrubMessage(message);
    if (data.length === 0) {
      pinoInstance.info(msg);
    } else {
      pinoInstance.info(mergePayloads(data), msg);
    }
  },

  error(message: string, ...data: LogPayload[]): void {
    const msg = scrubMessage(message);
    if (data.length === 0) {
      pinoInstance.error(msg);
    } else {
      pinoInstance.error(mergePayloads(data), msg);
    }
  },

  warn(message: string, ...data: LogPayload[]): void {
    const msg = scrubMessage(message);
    if (data.length === 0) {
      pinoInstance.warn(msg);
    } else {
      pinoInstance.warn(mergePayloads(data), msg);
    }
  },

  debug(message: string, ...data: LogPayload[]): void {
    const msg = scrubMessage(message);
    if (data.length === 0) {
      pinoInstance.debug(msg);
    } else {
      pinoInstance.debug(mergePayloads(data), msg);
    }
  },
};

export function safeLog(message: string, ...data: LogPayload[]): void {
  logger.info(message, ...data);
}

export { sanitise as _sanitiseForTest, mergePayloads as _mergePayloadsForTest, scrubMessage as _scrubMessageForTest };
