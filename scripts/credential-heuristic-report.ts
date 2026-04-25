/**
 * scripts/credential-heuristic-report.ts
 * --------------------------------------------------------------------------
 * One-off REPORT-ONLY scan of historical `ai_pending_actions` and
 * `event_logs` rows to estimate the false-positive / false-negative rate of
 * the credential heuristic added in Task #463 (and its surrounding regex /
 * key-name deny-list layers).
 *
 * The script is strictly read-only: it issues SELECTs, walks the JSON / TEXT
 * leaves, and reports counts of "would have redacted" tokens grouped by
 *   (table, JSON path, detector kind)
 * so a reviewer can:
 *
 *   1. Spot false positives — prose, slugs, IDs that the heuristic would
 *      have redacted but shouldn't have.
 *   2. Spot regex misses — credential-shaped values that the existing
 *      regex layer didn't catch but the heuristic did.
 *   3. Sanity-check that the inline redaction pipeline is working — every
 *      row that already contains REDACTED_SENTINEL is reported separately.
 *
 * To protect the audit trail, the report NEVER prints the raw token. It
 * only emits a "shape" string (length, character classes, Shannon entropy,
 * SHA-256 prefix) so a reviewer can correlate two reports without exposing
 * the secret a second time.
 *
 * Usage
 *   npx tsx scripts/credential-heuristic-report.ts [options]
 *
 * Options
 *   --limit N         Sample size per table (default 1000)
 *   --days N          Only scan rows from the last N days (default 7)
 *   --out PATH        Write the JSON report to PATH (default
 *                     reports/credential-heuristic-<ISO>.json)
 *   --include-shape   Also emit per-hit shape summaries in the JSON output
 *                     (off by default — keeps reports compact). The
 *                     human-readable summary printed to stdout always
 *                     includes shapes for the top-N hits.
 *
 * Environment
 *   DATABASE_URL must point at the database to scan. The script owns its
 *   own dedicated read-only `pg.Pool` (max 2,
 *   application_name='credential-heuristic-report') and intentionally does
 *   NOT import the production pool from `src/utils/eventLogsDatabase.ts`,
 *   because importing that module triggers idempotent but log-noisy
 *   CREATE TABLE / partition DDL on module load — which would violate the
 *   read-only contract of a one-off audit scanner.
 *
 * Exit status
 *   0  Always (this is a report, not a guard). Errors during sampling
 *      are logged and the script continues with whatever it managed to
 *      read.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { Pool } from 'pg';

/* -------------------------------------------------------------------------
 * Heuristic constants — kept LOCAL on purpose
 * -------------------------------------------------------------------------
 * The script must not import `src/utils/eventLogsDatabase.ts`. That module
 * has a top-level side effect (`initializeEventLogsTable()` at line ~1380)
 * which issues `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`
 * / monthly partition DDL on import. Those statements are idempotent in
 * normal operation, but they are still write-intent statements and would
 * break the "strictly read-only" contract this report depends on. Mirror
 * the few constants and heuristic helpers we need from that file so the
 * script can be safely pointed at a production replica without surprising
 * the DBA.
 *
 * If the production heuristic ever changes (entropy floor, length window,
 * strong-special set, alphabet), update the constants below to match
 * `isPasswordLikeToken` / `isHighEntropyToken` in `eventLogsDatabase.ts`
 * and re-run the report so historical buckets stay comparable.
 * -------------------------------------------------------------------------*/

const REDACTED_SENTINEL = '***REDACTED***';

const TRIM_LEAD_RE = /^[("'`\[{<,]+/;
const TRIM_TAIL_RE = /[)"'`\]}>,.]+$/;
const STRONG_SPECIAL_CHAR_RE = /[!@#$%^&*()+={}\[\]|\\:;"'<>?~`]/;
const ENTROPY_ALPHABET_RE = /^[A-Za-z0-9+/=_\-]+$/;

/** Raw Shannon entropy in bits/char. Used by the gate AND the per-hit
 *  shape summary (the latter rounds the result for display). */
function shannonEntropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  const len = s.length;
  let h = 0;
  for (const n of counts.values()) {
    const p = n / len;
    h -= p * Math.log2(p);
  }
  return h;
}

function isPasswordLikeToken(token: string): boolean {
  const len = token.length;
  if (len < 12 || len > 80) return false;
  if (!/[A-Z]/.test(token)) return false;
  if (!/[a-z]/.test(token)) return false;
  if (!/\d/.test(token)) return false;
  if (!STRONG_SPECIAL_CHAR_RE.test(token)) return false;
  return true;
}

function isHighEntropyToken(token: string): boolean {
  const len = token.length;
  if (len < 24 || len > 80) return false;
  if (!ENTROPY_ALPHABET_RE.test(token)) return false;
  let classes = 0;
  if (/[A-Z]/.test(token)) classes++;
  if (/[a-z]/.test(token)) classes++;
  if (/\d/.test(token)) classes++;
  if (classes < 3) return false;
  return shannonEntropy(token) >= 4.5;
}

/* -------------------------------------------------------------------------
 * Token-level walker
 * -------------------------------------------------------------------------
 * Mirrors the splitting / trimming logic used inside
 * `redactCredentialLikeTokens` and `detectInString` in
 * `src/utils/eventLogsDatabase.ts`. Kept as a small local copy so the
 * report stays insulated from refactors of those internals — and so this
 * script does not need to import the heavy production module (see the
 * "kept LOCAL on purpose" note above).
 * -------------------------------------------------------------------------*/

type DetectorKind = 'password' | 'entropy';

interface RawHit {
  table: string;
  rowId: string;
  path: string;
  kind: DetectorKind;
  /** Length of the offending token (post-trim). */
  length: number;
  /** Character-class summary, e.g. "ULDS" (upper/lower/digit/special). */
  classes: string;
  /** Shannon entropy bits/char, rounded to 2dp. */
  entropy: number;
  /** First 8 hex chars of SHA-256(token) — lets reviewers correlate without
   *  exposing the value. */
  hashPrefix: string;
}

function classOf(token: string): string {
  let s = '';
  if (/[A-Z]/.test(token)) s += 'U';
  if (/[a-z]/.test(token)) s += 'L';
  if (/\d/.test(token)) s += 'D';
  if (/[^A-Za-z0-9]/.test(token)) s += 'S';
  return s;
}

function shapeFor(token: string, _kind: DetectorKind): Omit<RawHit, 'table' | 'rowId' | 'path' | 'kind'> {
  return {
    length: token.length,
    classes: classOf(token),
    entropy: Math.round(shannonEntropy(token) * 100) / 100,
    hashPrefix: crypto.createHash('sha256').update(token).digest('hex').slice(0, 8),
  };
}

function inspectString(
  value: string,
  table: string,
  rowId: string,
  path: string,
  hits: RawHit[],
  alreadyRedactedFlag: { value: boolean },
): void {
  if (value.length === 0) return;
  if (value.includes(REDACTED_SENTINEL)) alreadyRedactedFlag.value = true;

  for (const rawToken of value.split(/\s+/)) {
    const candidates: string[] = [];
    if (rawToken.length >= 12 && rawToken.length <= 80) candidates.push(rawToken);
    const lead = TRIM_LEAD_RE.exec(rawToken)?.[0] ?? '';
    const tail = TRIM_TAIL_RE.exec(rawToken)?.[0] ?? '';
    if (lead.length > 0 || tail.length > 0) {
      const core = rawToken.slice(lead.length, rawToken.length - tail.length);
      if (core.length >= 12 && core.length <= 80 && core !== rawToken) {
        candidates.push(core);
      }
    }

    for (const token of candidates) {
      // Skip the redaction sentinel — by design it always trips the
      // "many-classes / long-string" filter and would inflate the report.
      if (token.includes(REDACTED_SENTINEL)) continue;

      let kind: DetectorKind | null = null;
      if (isPasswordLikeToken(token)) kind = 'password';
      else if (isHighEntropyToken(token)) kind = 'entropy';
      if (!kind) continue;

      hits.push({
        table,
        rowId,
        path,
        kind,
        ...shapeFor(token, kind),
      });
      // One hit per token only; do not also emit the un-trimmed variant.
      break;
    }
  }
}

function walk(
  value: unknown,
  table: string,
  rowId: string,
  path: string,
  hits: RawHit[],
  alreadyRedactedFlag: { value: boolean },
): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    inspectString(value, table, rowId, path, hits, alreadyRedactedFlag);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], table, rowId, `${path}[${i}]`, hits, alreadyRedactedFlag);
    }
    return;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, table, rowId, `${path}.${key}`, hits, alreadyRedactedFlag);
    }
  }
}

/* -------------------------------------------------------------------------
 * Argument parsing
 * -------------------------------------------------------------------------*/

interface CliArgs {
  limit: number;
  days: number;
  out: string;
  includeShape: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    limit: 1000,
    days: 7,
    out: '',
    includeShape: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') args.limit = Math.max(1, parseInt(argv[++i] ?? '1000', 10));
    else if (a === '--days') args.days = Math.max(1, parseInt(argv[++i] ?? '7', 10));
    else if (a === '--out') args.out = argv[++i] ?? '';
    else if (a === '--include-shape') args.includeShape = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: npx tsx scripts/credential-heuristic-report.ts [--limit N] [--days N] [--out PATH] [--include-shape]`);
      process.exit(0);
    }
  }
  if (!args.out) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    args.out = path.join('reports', `credential-heuristic-${stamp}.json`);
  }
  return args;
}

/* -------------------------------------------------------------------------
 * Sampling
 * -------------------------------------------------------------------------*/

interface SampledRow {
  table: string;
  rowId: string;
  // Each entry is a (top-level path, value) pair so the walker can label
  // the source column in the resulting hit paths.
  payload: Array<{ path: string; value: unknown }>;
}

async function sampleAiPendingActions(pool: Pool, limit: number, days: number): Promise<SampledRow[]> {
  const rows: SampledRow[] = [];
  try {
    const res = await pool.query(
      `SELECT id, payload, payload_preview, execution_result
         FROM ai_pending_actions
        WHERE created_at >= NOW() - ($1 || ' days')::interval
        ORDER BY created_at DESC
        LIMIT $2`,
      [String(days), limit],
    );
    for (const row of res.rows) {
      rows.push({
        table: 'ai_pending_actions',
        rowId: String(row.id),
        payload: [
          { path: 'payload', value: row.payload },
          { path: 'payload_preview', value: row.payload_preview },
          { path: 'execution_result', value: row.execution_result },
        ],
      });
    }
  } catch (err) {
    console.warn(`[report] ai_pending_actions sample failed: ${(err as Error).message}`);
  }
  return rows;
}

async function sampleEventLogs(pool: Pool, limit: number, days: number): Promise<SampledRow[]> {
  const rows: SampledRow[] = [];
  try {
    const res = await pool.query(
      `SELECT id, description, old_value, new_value
         FROM event_logs
        WHERE timestamp >= NOW() - ($1 || ' days')::interval
        ORDER BY timestamp DESC
        LIMIT $2`,
      [String(days), limit],
    );
    for (const row of res.rows) {
      rows.push({
        table: 'event_logs',
        rowId: String(row.id),
        payload: [
          { path: 'description', value: row.description },
          { path: 'old_value', value: row.old_value },
          { path: 'new_value', value: row.new_value },
        ],
      });
    }
  } catch (err) {
    console.warn(`[report] event_logs sample failed: ${(err as Error).message}`);
  }
  return rows;
}

/* -------------------------------------------------------------------------
 * Aggregation + output
 * -------------------------------------------------------------------------*/

interface BucketSummary {
  table: string;
  fieldPath: string;
  kind: DetectorKind;
  count: number;
  uniqueRowCount: number;
  uniqueTokenCount: number;
  /** Min/max length / entropy seen — gives the reviewer thresholds at a
   *  glance to decide whether to widen / tighten. */
  minLength: number;
  maxLength: number;
  minEntropy: number;
  maxEntropy: number;
  /** Up to 5 representative hashPrefix samples for follow-up correlation. */
  exampleHashPrefixes: string[];
}

interface Report {
  generatedAt: string;
  args: CliArgs;
  rowCounts: Record<string, number>;
  rowsWithExistingRedaction: Record<string, number>;
  totalHits: number;
  hitsByKind: Record<DetectorKind, number>;
  buckets: BucketSummary[];
  hits?: RawHit[];
}

function summarise(hits: RawHit[]): BucketSummary[] {
  const map = new Map<string, BucketSummary & {
    rows: Set<string>;
    tokens: Set<string>;
  }>();
  for (const h of hits) {
    const key = `${h.table}|${h.path}|${h.kind}`;
    let b = map.get(key);
    if (!b) {
      b = {
        table: h.table,
        fieldPath: h.path,
        kind: h.kind,
        count: 0,
        uniqueRowCount: 0,
        uniqueTokenCount: 0,
        minLength: h.length,
        maxLength: h.length,
        minEntropy: h.entropy,
        maxEntropy: h.entropy,
        exampleHashPrefixes: [],
        rows: new Set(),
        tokens: new Set(),
      };
      map.set(key, b);
    }
    b.count++;
    b.rows.add(h.rowId);
    b.tokens.add(h.hashPrefix);
    b.minLength = Math.min(b.minLength, h.length);
    b.maxLength = Math.max(b.maxLength, h.length);
    b.minEntropy = Math.min(b.minEntropy, h.entropy);
    b.maxEntropy = Math.max(b.maxEntropy, h.entropy);
    if (b.exampleHashPrefixes.length < 5 && !b.exampleHashPrefixes.includes(h.hashPrefix)) {
      b.exampleHashPrefixes.push(h.hashPrefix);
    }
  }
  return Array.from(map.values())
    .map((b) => {
      b.uniqueRowCount = b.rows.size;
      b.uniqueTokenCount = b.tokens.size;
      const { rows: _r, tokens: _t, ...summary } = b;
      return summary as BucketSummary;
    })
    .sort((a, b) => b.count - a.count);
}

function printHumanSummary(report: Report): void {
  const banner = '─'.repeat(72);
  console.log(banner);
  console.log('Credential heuristic report');
  console.log(banner);
  console.log(`generated:   ${report.generatedAt}`);
  console.log(`args:        limit=${report.args.limit}  days=${report.args.days}`);
  for (const [table, count] of Object.entries(report.rowCounts)) {
    const redacted = report.rowsWithExistingRedaction[table] ?? 0;
    console.log(`${table.padEnd(22)} sampled ${String(count).padStart(5)} rows  (${redacted} already contain REDACTED_SENTINEL)`);
  }
  console.log('');
  console.log(`Heuristic hits: ${report.totalHits}  (password=${report.hitsByKind.password}, entropy=${report.hitsByKind.entropy})`);
  console.log('');
  if (report.buckets.length === 0) {
    console.log('No heuristic hits found — heuristic produced zero "would-have-redacted" tokens on the sampled window.');
    return;
  }
  console.log('Top buckets (table | field path | kind | count | rows | uniq-tokens | len min-max | H min-max):');
  for (const b of report.buckets.slice(0, 30)) {
    console.log(
      `  ${b.table.padEnd(20)}  ${b.fieldPath.padEnd(38)}  ${b.kind.padEnd(8)}  ${String(b.count).padStart(4)}  ${String(b.uniqueRowCount).padStart(4)}  ${String(b.uniqueTokenCount).padStart(4)}  ${String(b.minLength).padStart(2)}-${String(b.maxLength).padStart(2)}  ${b.minEntropy.toFixed(2)}-${b.maxEntropy.toFixed(2)}  e.g. ${b.exampleHashPrefixes.slice(0, 3).join(',')}`,
    );
  }
  console.log('');
  console.log('Reviewer guidance:');
  console.log('  - For each bucket, look up the row by id and inspect the cited field path.');
  console.log('  - Tokens are referenced by SHA-256 hash prefix only; the raw value is NEVER printed.');
  console.log('  - If a bucket is dominated by prose / slugs / IDs, the heuristic is over-aggressive');
  console.log('    on that field — consider tightening (entropy floor, length window, classes).');
  console.log('  - If a bucket contains real credential-shaped values that the regex layer missed,');
  console.log('    add a regression fixture in tests/aiApprovalRedaction.test.ts.');
}

/* -------------------------------------------------------------------------
 * Main
 * -------------------------------------------------------------------------*/

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[report] sampling up to ${args.limit} rows per table from the last ${args.days} day(s)…`);

  if (!process.env.DATABASE_URL) {
    console.error('[report] DATABASE_URL is not set — cannot connect to the database.');
    process.exit(2);
  }

  // Dedicated read-only Pool with a small connection cap. Importing
  // `src/utils/eventLogsDatabase.ts` would re-use its shared pool but
  // would also trigger `initializeEventLogsTable()` on module load
  // (CREATE TABLE / CREATE INDEX / partition DDL) — that violates the
  // strictly read-only contract this script depends on, especially
  // when the operator points it at a production replica. Owning a
  // local pool keeps the script's blast radius to SELECTs only.
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    application_name: 'credential-heuristic-report',
  });

  let aiRows: SampledRow[] = [];
  let evRows: SampledRow[] = [];
  try {
    [aiRows, evRows] = await Promise.all([
      sampleAiPendingActions(pool, args.limit, args.days),
      sampleEventLogs(pool, args.limit, args.days),
    ]);
  } finally {
    await pool.end().catch(() => undefined);
  }

  const allRows = [...aiRows, ...evRows];
  const hits: RawHit[] = [];
  const rowsWithExistingRedaction: Record<string, number> = {};

  for (const row of allRows) {
    const flag = { value: false };
    for (const { path: topPath, value } of row.payload) {
      walk(value, row.table, row.rowId, topPath, hits, flag);
    }
    if (flag.value) {
      rowsWithExistingRedaction[row.table] = (rowsWithExistingRedaction[row.table] ?? 0) + 1;
    }
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    args,
    rowCounts: {
      ai_pending_actions: aiRows.length,
      event_logs: evRows.length,
    },
    rowsWithExistingRedaction,
    totalHits: hits.length,
    hitsByKind: {
      password: hits.filter((h) => h.kind === 'password').length,
      entropy: hits.filter((h) => h.kind === 'entropy').length,
    },
    buckets: summarise(hits),
  };
  if (args.includeShape) report.hits = hits;

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(`[report] wrote ${args.out}`);
  printHumanSummary(report);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[report] fatal:', err);
    process.exit(1);
  });
