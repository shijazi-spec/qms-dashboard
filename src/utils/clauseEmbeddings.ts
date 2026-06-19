/**
 * clauseEmbeddings — retrieve-then-verify shortlisting (benchmark rec #3).
 *
 * The efficient, audit-grade pattern is: don't hand the LLM the whole clause
 * set (it gets "lost in the middle" and costs more) — first SHORTLIST the most
 * semantically similar candidate clauses with embeddings, then let the LLM
 * verify only that short list. This implementation deliberately uses NO
 * pgvector: embeddings are stored as JSON arrays and cosine similarity is
 * computed in-process. At our scale (≤ a few hundred docs × ~600 clauses) that
 * is plenty fast and avoids the deferred-pgvector deploy risk.
 *
 * OFF by default (DOCUMENT_MAPPING_EMBEDDINGS=true to enable) and fully
 * best-effort: any failure (no key, API error) falls back to the caller's
 * original candidate list, so behaviour is unchanged unless explicitly turned on.
 */

import { createHash } from "crypto";
import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import { getOpenAIApiKey, getOpenAIBaseUrl } from "./openaiCredentials";
import { redactSensitiveDeep } from "./eventLogsDatabase";

export const EMBED_MODEL =
  process.env.DOCUMENT_MAPPING_EMBED_MODEL || "text-embedding-3-small";
export const EMBED_SHORTLIST_K =
  Number(process.env.DOCUMENT_MAPPING_EMBED_TOPK) || 12;

export function embeddingsEnabled(): boolean {
  return process.env.DOCUMENT_MAPPING_EMBEDDINGS === "true";
}

/** Pure: cosine similarity of two equal-length vectors. Exported for tests. */
export function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function hashText(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

let initialized = false;
export async function initClauseEmbeddingsTable(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS obligation_embeddings (
      obligation_id INTEGER PRIMARY KEY REFERENCES obligations(id) ON DELETE CASCADE,
      embedding     JSONB NOT NULL,
      model         VARCHAR(64),
      dim           INTEGER,
      text_hash     VARCHAR(64),
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  initialized = true;
}

/** Best-effort: embed a single text. Returns null on any failure. */
export async function embedText(text: string): Promise<number[] | null> {
  const key = getOpenAIApiKey();
  if (!key) return null;
  const input = (text || "").slice(0, 8000);
  if (!input.trim()) return null;
  try {
    const base = getOpenAIBaseUrl() || "https://api.openai.com/v1";
    const res = await fetch(`${base}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBED_MODEL, input }),
    });
    if (!res.ok) {
      logger.warn(`[clauseEmbeddings] embed HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    return Array.isArray(vec) ? vec : null;
  } catch (err) {
    logger.warn(`[clauseEmbeddings] embed failed: ${(err as Error).message}`);
    return null;
  }
}

interface ClauseCandidate {
  id: number;
  obligation_code?: string;
  title?: string;
  description?: string | null;
  [k: string]: any;
}

function clauseEmbedText(c: ClauseCandidate): string {
  return [c.obligation_code, c.title, (c.description || "").slice(0, 500)]
    .filter(Boolean)
    .join(" — ");
}

/** Ensure each candidate clause has a current embedding cached; returns id→vector. */
async function ensureClauseEmbeddings(
  candidates: ClauseCandidate[],
): Promise<Map<number, number[]>> {
  await initClauseEmbeddingsTable();
  const ids = candidates.map((c) => c.id);
  const existing = await pool.query(
    `SELECT obligation_id, embedding, text_hash FROM obligation_embeddings WHERE obligation_id = ANY($1::int[])`,
    [ids],
  );
  const byId = new Map<number, { embedding: number[]; text_hash: string }>();
  for (const r of existing.rows) byId.set(r.obligation_id, { embedding: r.embedding, text_hash: r.text_hash });

  const out = new Map<number, number[]>();
  for (const c of candidates) {
    const text = clauseEmbedText(c);
    const h = hashText(text);
    const cached = byId.get(c.id);
    if (cached && cached.text_hash === h && Array.isArray(cached.embedding)) {
      out.set(c.id, cached.embedding);
      continue;
    }
    const vec = await embedText(text);
    if (!vec) continue;
    out.set(c.id, vec);
    try {
      await pool.query(
        `INSERT INTO obligation_embeddings (obligation_id, embedding, model, dim, text_hash)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (obligation_id) DO UPDATE
           SET embedding = EXCLUDED.embedding, model = EXCLUDED.model,
               dim = EXCLUDED.dim, text_hash = EXCLUDED.text_hash, created_at = CURRENT_TIMESTAMP`,
        [
          redactSensitiveDeep(c.id, "obligation_id"),
          JSON.stringify(vec),
          EMBED_MODEL,
          vec.length,
          h,
        ],
      );
    } catch {
      /* best-effort cache write */
    }
  }
  return out;
}

/**
 * Coverage of the embedding cache: how many clauses currently have an embedding
 * row vs the total. Drives the "Build embeddings" status on the dashboard.
 */
export async function embeddingsCoverage(): Promise<{
  total: number;
  embedded: number;
  remaining: number;
  model: string;
  enabled: boolean;
}> {
  await initClauseEmbeddingsTable();
  const t = await pool.query(`SELECT COUNT(*)::int AS n FROM obligations`);
  const e = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM obligation_embeddings oe
       JOIN obligations o ON o.id = oe.obligation_id`,
  );
  const total = t.rows[0]?.n || 0;
  const embedded = e.rows[0]?.n || 0;
  return {
    total,
    embedded,
    remaining: Math.max(0, total - embedded),
    model: EMBED_MODEL,
    enabled: embeddingsEnabled(),
  };
}

/**
 * Pre-warm the embedding cache for clauses that don't have one yet. Batched +
 * bounded-concurrency so the request can't time out; the UI loops until
 * remaining === 0. Runs regardless of the feature flag (so you can build the
 * cache first, then flip DOCUMENT_MAPPING_EMBEDDINGS=true). Needs the OpenAI
 * key — without it every embed fails and `failed` reports the count.
 * Staleness (clause text changed after caching) is still handled lazily by
 * ensureClauseEmbeddings during a real scan; this only fills the gaps.
 */
export async function backfillEmbeddingsBatch(
  opts: { limit?: number; concurrency?: number } = {},
): Promise<{ processed: number; embedded: number; failed: number; remaining: number }> {
  await initClauseEmbeddingsTable();
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const rows = await pool.query(
    `SELECT o.id, o.obligation_code, o.title, o.description
       FROM obligations o
  LEFT JOIN obligation_embeddings oe ON oe.obligation_id = o.id
      WHERE oe.obligation_id IS NULL
   ORDER BY o.id
      LIMIT $1`,
    [limit],
  );
  const queue = rows.rows.slice() as ClauseCandidate[];
  let processed = 0,
    embedded = 0,
    failed = 0;
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, 8));

  async function worker(): Promise<void> {
    for (;;) {
      const c = queue.shift();
      if (!c) return;
      processed++;
      const text = clauseEmbedText(c);
      const vec = await embedText(text);
      if (!vec) {
        failed++;
        continue;
      }
      try {
        await pool.query(
          `INSERT INTO obligation_embeddings (obligation_id, embedding, model, dim, text_hash)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (obligation_id) DO UPDATE
             SET embedding = EXCLUDED.embedding, model = EXCLUDED.model,
                 dim = EXCLUDED.dim, text_hash = EXCLUDED.text_hash, created_at = CURRENT_TIMESTAMP`,
          [
            redactSensitiveDeep(c.id, "obligation_id"),
            JSON.stringify(vec),
            EMBED_MODEL,
            vec.length,
            hashText(text),
          ],
        );
        embedded++;
      } catch {
        failed++;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, () => worker()),
  );
  const rem = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM obligations o
  LEFT JOIN obligation_embeddings oe ON oe.obligation_id = o.id
      WHERE oe.obligation_id IS NULL`,
  );
  return { processed, embedded, failed, remaining: rem.rows[0]?.n || 0 };
}

/**
 * Shortlist the top-K candidate clauses most semantically similar to the
 * document, so the LLM verifier sees a focused list instead of all candidates.
 * Best-effort: on ANY problem (disabled, no embeddings, error) returns the
 * original candidates unchanged — never worse than the current behaviour.
 */
export async function shortlistByEmbedding<T extends ClauseCandidate>(
  documentText: string,
  candidates: T[],
  topK: number = EMBED_SHORTLIST_K,
): Promise<T[]> {
  if (!embeddingsEnabled() || candidates.length <= topK) return candidates;
  try {
    const docVec = await embedText(documentText);
    if (!docVec) return candidates;
    const vecs = await ensureClauseEmbeddings(candidates);
    if (vecs.size === 0) return candidates;
    const scored = candidates.map((c) => {
      const v = vecs.get(c.id);
      return { c, score: v ? cosine(docVec, v) : -1 };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.c);
  } catch (err) {
    logger.warn(`[clauseEmbeddings] shortlist failed: ${(err as Error).message}`);
    return candidates;
  }
}
