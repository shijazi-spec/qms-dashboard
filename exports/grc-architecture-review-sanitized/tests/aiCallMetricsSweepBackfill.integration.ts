/**
 * Task #468 — DB-backed integration test for `redactAiCallMetrics()`.
 *
 * Complements the JS-stub unit test in `tests/aiCallMetricsSweepBackfill.test.ts`
 * (Task #453) by exercising the real SQL against Postgres so SQL-syntax
 * errors, parameter-encoding edge cases, the `previews_redacted_at = NOW()`
 * server-side stamp (Task #467), and BIGSERIAL keyset pagination off-by-ones
 * are caught in CI rather than production.
 *
 * Opt-in via `RUN_AI_METRICS_SWEEP_E2E=1`. CI wires it via
 * `.SourceControlProvider/workflows/ai-metrics-sweep.yml`. Cleanup runs in `finally`;
 * orphan rows can be found via `agent_name LIKE 'ai-metrics-sweep-test-%'`.
 *
 * Run locally:
 *   RUN_AI_METRICS_SWEEP_E2E=1 DATABASE_URL=<REDACTED_DSN> \
 *     npx tsx tests/aiCallMetricsSweepBackfill.integration.ts
 */

import pg from "pg";

import { ensureAiMetricsTable, insertAiCallMetric } from "../src/utils/aiTelemetry";
import { redactAiCallMetrics } from "../src/utils/redactHistoricalLogs";
import { REDACTED_SENTINEL } from "../src/utils/eventLogsDatabase";

if (process.env.RUN_AI_METRICS_SWEEP_E2E !== "1") {
  console.log(
    "[skip] aiCallMetricsSweepBackfill.integration.ts — set " +
      "RUN_AI_METRICS_SWEEP_E2E=1 (with DATABASE_URL pointed at a real " +
      "Postgres) to enable this suite.",
  );
  process.exit(0);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error(
    "❌ DATABASE_URL env var is required for the ai_call_metrics sweep " +
      "integration test.",
  );
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL });

let passed = 0;
let failed = 0;
function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// Shared `agent_name` prefix scopes both seeding and cleanup.
const AGENT_PREFIX = "ai-metrics-sweep-test-";

// One credential per detector family — mirrors the unit-test fixtures.
const SECRET_KEY    = "<REDACTED_TOKEN>";
const SECRET_GH     = "<REDACTED_TOKEN>";
const SECRET_BCRYPT = "<REDACTED_PASSWORD_HASH>";
const SECRET_JWT =
  "<REDACTED_TOKEN>";
const SECRET_AKIA   = "<REDACTED_TOKEN>";

const SAFE_PROMPT      = "Summarise the latest non-conformance for tenant Example Organization-corp";
const SAFE_TOOL_INPUT  = '{"action":"list","limit":10}';
const SAFE_TOOL_OUTPUT = '{"status":"ok","count":3}';

interface SeededRow {
  id: number;
  label: string;
  shouldRedact: boolean;
  forbiddenSubstrings: string[];
  preservedSubstrings: string[];
}

async function cleanup(): Promise<void> {
  await pool
    .query("DELETE FROM ai_call_metrics WHERE agent_name LIKE $1", [
      `${AGENT_PREFIX}%`,
    ])
    .catch(() => undefined);
}

async function fetchRow(id: number): Promise<{
  prompt_preview: string | null;
  tool_input_preview: string | null;
  tool_output_preview: string | null;
  previews_redacted_at: Date | null;
}> {
  const res = await pool.query(
    `SELECT prompt_preview, tool_input_preview, tool_output_preview,
            previews_redacted_at
       FROM ai_call_metrics
      WHERE id = $1`,
    [id],
  );
  if (res.rows.length !== 1) {
    throw new Error(`Expected exactly 1 row for id=${id}, got ${res.rows.length}`);
  }
  return res.rows[0];
}

/**
 * Seed one row via `insertAiCallMetric()`. Passing raw secrets directly
 * into the preview columns reproduces the pre-Task-#109/#276 on-disk
 * shape the sweep exists to clean up.
 */
async function seedRow(args: {
  agentLabel: string;
  promptPreview: string | null;
  toolInputPreview: string | null;
  toolOutputPreview: string | null;
}): Promise<number> {
  const id = await insertAiCallMetric({
    agent_name: `${AGENT_PREFIX}${args.agentLabel}`,
    model: "gpt-4o-mini",
    latency_ms: 10,
    success: true,
    prompt_preview: args.promptPreview ?? undefined,
    tool_input_preview: args.toolInputPreview ?? undefined,
    tool_output_preview: args.toolOutputPreview ?? undefined,
  });
  if (id == null) {
    throw new Error(`insertAiCallMetric returned null for ${args.agentLabel}`);
  }
  return id;
}

async function main(): Promise<void> {
  console.log("\n[ai_call_metrics] Verifying redactAiCallMetrics() against real Postgres");

  // Drop leftovers from a previous crashed run so seed counts stay stable.
  await cleanup();
  await ensureAiMetricsTable();

  let seeded: SeededRow[] = [];

  try {
    // One row per credential family + a clean control + an already-redacted row.
    const idSk = await seedRow({
      agentLabel: "sk",
      promptPreview: `${SAFE_PROMPT} (rotated key=${SECRET_KEY})`,
      toolInputPreview: null,
      toolOutputPreview: null,
    });
    seeded.push({
      id: idSk,
      label: "sk-… in prompt_preview",
      shouldRedact: true,
      forbiddenSubstrings: [SECRET_KEY],
      preservedSubstrings: ["Summarise the latest non-conformance"],
    });

    const idGhBcryptAkia = await seedRow({
      agentLabel: "gh-bcrypt-akia",
      promptPreview: SAFE_PROMPT,
      toolInputPreview: `${SAFE_TOOL_INPUT} gh=${SECRET_GH}`,
      toolOutputPreview: `legacy_hash=${SECRET_BCRYPT}; aws=${SECRET_AKIA}`,
    });
    seeded.push({
      id: idGhBcryptAkia,
      label: "ghp_… + bcrypt + AKIA across input/output previews",
      shouldRedact: true,
      forbiddenSubstrings: [SECRET_GH, SECRET_BCRYPT, "$2b$12$", SECRET_AKIA],
      preservedSubstrings: ['"action":"list"'],
    });

    const idJwt = await seedRow({
      agentLabel: "jwt",
      promptPreview: `bearer ${SECRET_JWT}`,
      toolInputPreview: SAFE_TOOL_INPUT,
      toolOutputPreview: SAFE_TOOL_OUTPUT,
    });
    seeded.push({
      id: idJwt,
      label: "JWT in prompt_preview (clean tool input/output)",
      shouldRedact: true,
      forbiddenSubstrings: [SECRET_JWT],
      preservedSubstrings: [],
    });

    const idClean = await seedRow({
      agentLabel: "clean-control",
      promptPreview: SAFE_PROMPT,
      toolInputPreview: SAFE_TOOL_INPUT,
      toolOutputPreview: SAFE_TOOL_OUTPUT,
    });
    seeded.push({
      id: idClean,
      label: "clean control — must NOT be touched",
      shouldRedact: false,
      forbiddenSubstrings: [],
      preservedSubstrings: [SAFE_PROMPT, SAFE_TOOL_INPUT, SAFE_TOOL_OUTPUT],
    });

    const idAlreadyRedacted = await seedRow({
      agentLabel: "already-redacted",
      // Avoid `key=***REDACTED***` — the PII regex would re-rewrite that
      // to `[REDACTED]`, breaking byte-identity (still safe, but not
      // useful for the idempotency assertion below).
      promptPreview: `Rotate API token (was ${REDACTED_SENTINEL})`,
      toolInputPreview: `legacy hash ${REDACTED_SENTINEL}`,
      toolOutputPreview: null,
    });
    seeded.push({
      id: idAlreadyRedacted,
      label: "already-redacted — must be byte-identical and not re-stamped",
      shouldRedact: false,
      forbiddenSubstrings: [],
      preservedSubstrings: [REDACTED_SENTINEL],
    });

    const seededIds = seeded.map((r) => r.id).sort((a, b) => a - b);
    console.log(`  • Seeded ${seeded.length} rows (ids ${seededIds.join(", ")})`);

    // Scope the sweep to the seeded rows by injecting an `agent_name LIKE`
    // filter into the SELECT, so per-column counters stay deterministic
    // regardless of other rows in the host DB. UPDATE is passed through
    // unchanged so we exercise the production SQL — including the
    // `previews_redacted_at = NOW()` stamp from Task #467.
    const scopedClient = {
      query: async (sql: string, params: ReadonlyArray<unknown> = []) => {
        const queryParams: unknown[] = Array.from(params);
        if (/^\s*SELECT\s+id,\s*prompt_preview/i.test(sql)) {
          const scopedSql = sql.replace(
            /WHERE id > \$1\s+ORDER BY id ASC\s+LIMIT \$2/i,
            "WHERE id > $1 AND agent_name LIKE $3 ORDER BY id ASC LIMIT $2",
          );
          return pool.query(scopedSql, [...queryParams, `${AGENT_PREFIX}%`]);
        }
        return pool.query(sql, queryParams);
      },
    };

    const result1 = await redactAiCallMetrics(scopedClient);
    console.log(`  • Pass 1 result: ${JSON.stringify(result1)}`);

    assert(result1.scanned === seeded.length, `pass 1 scanned ${seeded.length} seeded rows (got ${result1.scanned})`);
    assert(
      result1.promptPreviewChanged === 2,
      `pass 1 prompt_preview rewritten on the 2 leaky rows (got ${result1.promptPreviewChanged})`,
    );
    assert(
      result1.toolInputPreviewChanged === 1,
      `pass 1 tool_input_preview rewritten on the 1 leaky row (got ${result1.toolInputPreviewChanged})`,
    );
    assert(
      result1.toolOutputPreviewChanged === 1,
      `pass 1 tool_output_preview rewritten on the 1 leaky row (got ${result1.toolOutputPreviewChanged})`,
    );
    assert(
      result1.rowsUpdated === 3,
      `pass 1 total rows updated = 3 (got ${result1.rowsUpdated})`,
    );

    // Per-row checks — fetch back from Postgres so we're inspecting what
    // actually landed in storage, not just what the sweep returned.
    for (const seededRow of seeded) {
      const row = await fetchRow(seededRow.id);
      const previews = [
        row.prompt_preview,
        row.tool_input_preview,
        row.tool_output_preview,
      ];

      for (const forbidden of seededRow.forbiddenSubstrings) {
        const stillLeaks = previews.some(
          (p) => typeof p === "string" && p.includes(forbidden),
        );
        assert(
          !stillLeaks,
          `[${seededRow.label}] no preview column still contains ${forbidden.slice(0, 24)}…`,
        );
      }
      for (const preserved of seededRow.preservedSubstrings) {
        const stillThere = previews.some(
          (p) => typeof p === "string" && p.includes(preserved),
        );
        assert(
          stillThere,
          `[${seededRow.label}] surrounding non-secret context preserved (${preserved.slice(0, 24)}…)`,
        );
      }

      if (seededRow.shouldRedact) {
        assert(
          row.previews_redacted_at instanceof Date,
          `[${seededRow.label}] previews_redacted_at breadcrumb stamped by NOW()`,
        );
      } else {
        assert(
          row.previews_redacted_at === null,
          `[${seededRow.label}] previews_redacted_at remains NULL — sweep didn't touch the row`,
        );
      }
    }

    // Pass 2 — idempotency: must be a no-op end-to-end.
    const result2 = await redactAiCallMetrics(scopedClient);
    console.log(`  • Pass 2 result: ${JSON.stringify(result2)}`);

    assert(result2.scanned === seeded.length, `pass 2 still scans all ${seeded.length} rows`);
    assert(
      result2.rowsUpdated === 0,
      `pass 2 updates 0 rows (got ${result2.rowsUpdated}) — sweep is idempotent end-to-end`,
    );
    assert(
      result2.promptPreviewChanged === 0 &&
        result2.toolInputPreviewChanged === 0 &&
        result2.toolOutputPreviewChanged === 0,
      "pass 2 reports zero per-column changes",
    );

    // The pass-1 `previews_redacted_at` stamps must survive pass 2 unchanged.
    for (const seededRow of seeded) {
      if (!seededRow.shouldRedact) continue;
      const row = await fetchRow(seededRow.id);
      assert(
        row.previews_redacted_at instanceof Date,
        `[${seededRow.label}] previews_redacted_at still set after pass 2 (no re-stamp)`,
      );
    }

    // BIGSERIAL keyset probe: batchSize=1 forces a cursor advance per row.
    const paginationResult = await redactAiCallMetrics(scopedClient, 1);
    assert(
      paginationResult.scanned === seeded.length,
      `pagination (batchSize=1) scanned all ${seeded.length} rows across cursor advances ` +
        `(got ${paginationResult.scanned})`,
    );
    assert(
      paginationResult.rowsUpdated === 0,
      `pagination (batchSize=1) updates 0 rows on already-clean dataset ` +
        `(got ${paginationResult.rowsUpdated})`,
    );
  } finally {
    console.log("  • cleaning up seeded rows…");
    await cleanup();
    await pool.end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("aiCallMetricsSweepBackfill.integration crashed:", err);
  cleanup()
    .catch(() => undefined)
    .finally(() => {
      void pool.end().catch(() => undefined);
      process.exit(1);
    });
});
