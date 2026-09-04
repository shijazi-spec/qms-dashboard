/**
 * documentChunkEmbeddings — Stage 2 of the Mapping Console search.
 *
 * Stage 1 (full-text, qmsDocsDatabase's GIN index) finds documents that use the
 * clause's WORDS. This module finds documents that satisfy a clause in
 * DIFFERENT words, and — because it retrieves at CHUNK level rather than
 * document level — can point at the passage that does it.
 *
 * That passage is the real prize. `complianceJudge.buildJudgePrompt` slices
 * `extracted_text.slice(0, 8000)`, so every "missing_topic" verdict on the
 * Document Mapping page was formed by reading a cover page and a table of
 * contents. Feeding the judge the chunks that actually relate to the clause,
 * instead of the first 8000 characters, is what makes the verdict about the
 * document rather than about its front matter.
 *
 * Deliberately no pgvector, matching clauseEmbeddings: vectors are JSONB and
 * cosine runs in-process. Chunks outnumber clauses by an order of magnitude, so
 * unlike clauseEmbeddings this module keeps a process-local cache of the vector
 * set and refreshes it only when the corpus fingerprint changes — otherwise
 * every search would re-parse thousands of JSONB arrays.
 *
 * OFF by default. `embeddingsEnabled()` (DOCUMENT_MAPPING_EMBEDDINGS=true)
 * gates every entry point, and every failure path degrades to "no semantic
 * candidates" rather than throwing, so the Console keeps working on Stage 1
 * alone if OpenAI is unreachable.
 */

import { createHash } from "crypto";
import { sharedPool as pool } from "./sharedPool";
import { logger } from "./logger";
import {
  cosine,
  embedText,
  embeddingsEnabled,
  EMBED_MODEL,
} from "./clauseEmbeddings";

/** Target characters per chunk. Roughly a page — big enough to carry a whole
 *  control statement, small enough that the match points somewhere specific. */
export const CHUNK_CHARS = Number(process.env.DOCUMENT_CHUNK_CHARS) || 1200;

/** Overlap between neighbouring chunks, so a control that straddles a boundary
 *  is not sliced in half and lost by both sides. */
export const CHUNK_OVERLAP = Number(process.env.DOCUMENT_CHUNK_OVERLAP) || 200;

/** Chunks retrieved per document when assembling evidence for the judge. */
export const CHUNKS_PER_DOC = Number(process.env.DOCUMENT_CHUNK_TOPK) || 4;

/** Minimum cosine for a chunk to count as related at all. Below this the
 *  "match" is noise, and a noisy passage handed to the judge is worse than
 *  none: it invites a confident verdict about an irrelevant paragraph. */
export const MIN_CHUNK_SIMILARITY = (() => {
  // An empty or malformed env var must not silently become 0, which would
  // disable the floor entirely and let every chunk in the corpus count as a
  // match for every clause.
  const raw = Number(process.env.DOCUMENT_CHUNK_MIN_SIM);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.25;
})();

function hashText(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

/**
 * Pure: split text into overlapping chunks on paragraph/sentence boundaries.
 *
 * Exported for unit testing — this is the part worth pinning down, because a
 * chunker that silently drops the tail of a document produces a system that
 * looks like it works and quietly cannot see the last section of every policy.
 */
export function chunkText(
  text: string,
  size: number = CHUNK_CHARS,
  overlap: number = CHUNK_OVERLAP,
): string[] {
  const clean = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  // Clamp the overlap to half a chunk. Beyond that the window barely advances
  // (an overlap >= size would make `start` stand still and loop forever), and
  // it keeps the progress guarantee below easy to see.
  const ov = Math.max(0, Math.min(overlap, Math.floor(size / 2)));

  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);

    // Prefer to break on a paragraph, then a sentence, then a word — but only
    // if that boundary is in the last quarter of the window, so a document with
    // no newlines cannot collapse every chunk to a sliver.
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const floor = Math.floor(size * 0.75);
      const para = window.lastIndexOf("\n");
      const sentence = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("? "),
        window.lastIndexOf("! "),
      );
      const word = window.lastIndexOf(" ");
      const cut = [para, sentence, word].find((i) => i >= floor);
      if (cut !== undefined && cut > 0) end = start + cut + 1;
    }

    const piece = clean.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;

    // Resume from `end - ov`, never from a fixed stride. A stride can overshoot
    // `end` when the boundary search cuts the window short, and the characters
    // in between are then in NO chunk — a silent hole in the middle of a
    // document that every later search and verdict is blind to.
    //
    // No gap: end - ov <= end. Progress: the boundary search never cuts before
    // 0.75*size, and ov <= 0.5*size, so end - ov >= start + 0.25*size.
    start = Math.max(end - ov, start + 1);
  }
  return out;
}

let initialized = false;
export async function initDocumentChunkTable(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS document_chunk_embeddings (
      id          SERIAL PRIMARY KEY,
      document_id INTEGER NOT NULL REFERENCES qms_uploaded_documents(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      chunk_text  TEXT NOT NULL,
      embedding   JSONB NOT NULL,
      model       VARCHAR(64),
      dim         INTEGER,
      doc_hash    VARCHAR(64),
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (document_id, chunk_index)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_document_chunk_embeddings_doc
       ON document_chunk_embeddings (document_id)`,
  );
  initialized = true;
}

/**
 * Embed one document's chunks, replacing any stale set.
 *
 * `doc_hash` is the SHA-256 of the whole extracted body: if the document is
 * re-uploaded and re-extracted, every chunk's hash goes stale together and the
 * set is rebuilt as a unit. Per-chunk hashing would let a half-old, half-new
 * mixture survive an edit that shifts text across boundaries.
 */
export async function embedDocumentChunks(
  documentId: number,
): Promise<{ chunks: number; skipped: boolean; reason?: string }> {
  if (!embeddingsEnabled()) return { chunks: 0, skipped: true, reason: "disabled" };
  await initDocumentChunkTable();

  const res = await pool.query(
    `SELECT extracted_text FROM qms_uploaded_documents
      WHERE id = $1
        AND COALESCE(extraction_status, '') <> 'placeholder'`,
    [documentId],
  );
  const text = res.rows[0]?.extracted_text;
  if (!text || String(text).trim().length < 50) {
    return { chunks: 0, skipped: true, reason: "no_text" };
  }

  const docHash = hashText(String(text));
  const have = await pool.query(
    `SELECT COUNT(*)::int AS n FROM document_chunk_embeddings
      WHERE document_id = $1 AND doc_hash = $2`,
    [documentId, docHash],
  );
  if ((have.rows[0]?.n ?? 0) > 0) {
    return { chunks: have.rows[0].n, skipped: true, reason: "current" };
  }

  const pieces = chunkText(String(text));
  if (pieces.length === 0) return { chunks: 0, skipped: true, reason: "no_text" };

  const vectors: Array<{ i: number; piece: string; vec: number[] }> = [];
  for (let i = 0; i < pieces.length; i++) {
    const vec = await embedText(pieces[i]);
    // A partial embed is worse than none: the document would look searched
    // while being invisible from its third chunk on. Bail and leave the old
    // set in place for the next attempt.
    if (!vec) {
      logger.warn(
        `[documentChunkEmbeddings] embed failed for doc ${documentId} chunk ${i}; leaving existing set untouched`,
      );
      return { chunks: 0, skipped: true, reason: "embed_failed" };
    }
    vectors.push({ i, piece: pieces[i], vec });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM document_chunk_embeddings WHERE document_id = $1`,
      [documentId],
    );
    for (const v of vectors) {
      await client.query(
        `INSERT INTO document_chunk_embeddings
           (document_id, chunk_index, chunk_text, embedding, model, dim, doc_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          documentId,
          v.i,
          v.piece,
          JSON.stringify(v.vec),
          EMBED_MODEL,
          v.vec.length,
          docHash,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    logger.warn(
      `[documentChunkEmbeddings] persist failed for doc ${documentId}: ${(err as Error).message}`,
    );
    return { chunks: 0, skipped: true, reason: "persist_failed" };
  } finally {
    client.release();
  }

  invalidateCache();
  return { chunks: vectors.length, skipped: false };
}

/**
 * Embed the next few documents that have no current chunk set. Bounded on
 * purpose: 14 modules share one OpenAI key on this deployment, so this runs a
 * handful at a time from the housekeeping loop rather than embedding the whole
 * corpus in one burst.
 */
export async function backfillDocumentChunks(
  maxDocs = 5,
): Promise<{ processed: number; chunks: number }> {
  if (!embeddingsEnabled()) return { processed: 0, chunks: 0 };
  await initDocumentChunkTable();

  const res = await pool.query(
    `SELECT d.id
       FROM qms_uploaded_documents d
       LEFT JOIN document_chunk_embeddings c
              ON c.document_id = d.id
             -- convert_to(), not ::bytea: PostgreSQL has no text->bytea cast,
             -- and this must produce the same digest as Node's
             -- createHash('sha256').update(text), which hashes UTF-8 bytes.
             AND c.doc_hash = encode(sha256(convert_to(d.extracted_text, 'UTF8')), 'hex')
      WHERE COALESCE(d.extraction_status, '') <> 'placeholder'
        AND d.extracted_text IS NOT NULL
        AND length(d.extracted_text) >= 50
        AND c.id IS NULL
      GROUP BY d.id
      ORDER BY d.id
      LIMIT $1`,
    [maxDocs],
  );

  let processed = 0;
  let chunks = 0;
  for (const row of res.rows) {
    const r = await embedDocumentChunks(row.id);
    if (!r.skipped) {
      processed += 1;
      chunks += r.chunks;
    }
  }
  if (processed > 0) {
    logger.info(
      `[documentChunkEmbeddings] backfilled ${processed} document(s), ${chunks} chunk(s)`,
    );
  }
  return { processed, chunks };
}

export async function chunkCoverage(): Promise<{
  documents_with_text: number;
  documents_embedded: number;
  chunks: number;
}> {
  await initDocumentChunkTable();
  const res = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM qms_uploaded_documents
         WHERE COALESCE(extraction_status,'') <> 'placeholder'
           AND extracted_text IS NOT NULL AND extracted_text <> '') AS documents_with_text,
       (SELECT COUNT(DISTINCT document_id)::int FROM document_chunk_embeddings) AS documents_embedded,
       (SELECT COUNT(*)::int FROM document_chunk_embeddings) AS chunks`,
  );
  return res.rows[0];
}

// ── vector cache ────────────────────────────────────────────────────────────
// Parsing every chunk's JSONB array on every search is the expensive part, and
// the corpus changes far less often than it is searched. The fingerprint is
// (row count, max id, max created_at): any insert, delete or rebuild moves at
// least one of them, so a stale cache cannot survive a corpus change.

interface CachedChunk {
  document_id: number;
  chunk_index: number;
  chunk_text: string;
  embedding: number[];
}

let cache: { fingerprint: string; rows: CachedChunk[] } | null = null;

export function invalidateCache(): void {
  cache = null;
}

async function loadChunks(): Promise<CachedChunk[]> {
  await initDocumentChunkTable();
  const fp = await pool.query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(MAX(id), 0) AS max_id,
            COALESCE(MAX(created_at), TIMESTAMP 'epoch') AS max_created
       FROM document_chunk_embeddings`,
  );
  const f = fp.rows[0];
  const fingerprint = `${f.n}:${f.max_id}:${new Date(f.max_created).getTime()}`;
  if (cache && cache.fingerprint === fingerprint) return cache.rows;

  const res = await pool.query(
    `SELECT document_id, chunk_index, chunk_text, embedding
       FROM document_chunk_embeddings`,
  );
  const rows: CachedChunk[] = res.rows.map((r: any) => ({
    document_id: r.document_id,
    chunk_index: r.chunk_index,
    chunk_text: r.chunk_text,
    embedding: Array.isArray(r.embedding) ? r.embedding : [],
  }));
  cache = { fingerprint, rows };
  logger.info(`[documentChunkEmbeddings] vector cache loaded: ${rows.length} chunk(s)`);
  return rows;
}

export interface ChunkHit {
  chunk_index: number;
  chunk_text: string;
  similarity: number;
}

export interface SemanticDocumentHit {
  document_id: number;
  best_similarity: number;
  chunks: ChunkHit[];
}

/**
 * Rank documents by the best-matching passage each one contains.
 *
 * Scoring by the single best chunk, not the document average, is deliberate: a
 * 60-page manual that satisfies a clause in one precise paragraph is a correct
 * answer, and averaging over its other 59 pages would bury it beneath a short
 * document that is vaguely on-topic throughout.
 */
export async function semanticDocumentCandidates(
  clauseText: string,
  opts: { limit?: number; documentIds?: number[] } = {},
): Promise<SemanticDocumentHit[]> {
  if (!embeddingsEnabled()) return [];
  const query = String(clauseText || "").trim();
  if (!query) return [];

  const qvec = await embedText(query);
  if (!qvec) return [];

  let rows: CachedChunk[];
  try {
    rows = await loadChunks();
  } catch (err) {
    logger.warn(
      `[documentChunkEmbeddings] chunk load failed: ${(err as Error).message}`,
    );
    return [];
  }
  if (rows.length === 0) return [];

  const allow = opts.documentIds?.length ? new Set(opts.documentIds) : null;
  const byDoc = new Map<number, ChunkHit[]>();
  for (const r of rows) {
    if (allow && !allow.has(r.document_id)) continue;
    const sim = cosine(qvec, r.embedding);
    if (sim < MIN_CHUNK_SIMILARITY) continue;
    const list = byDoc.get(r.document_id) || [];
    list.push({
      chunk_index: r.chunk_index,
      chunk_text: r.chunk_text,
      similarity: sim,
    });
    byDoc.set(r.document_id, list);
  }

  const out: SemanticDocumentHit[] = [];
  for (const [document_id, hits] of byDoc) {
    hits.sort((a, b) => b.similarity - a.similarity);
    out.push({
      document_id,
      best_similarity: hits[0].similarity,
      chunks: hits.slice(0, CHUNKS_PER_DOC),
    });
  }
  out.sort((a, b) => b.best_similarity - a.best_similarity);
  return out.slice(0, opts.limit ?? 10);
}

/**
 * The passages of ONE document most related to a clause, concatenated for the
 * judge. Returns null when there is nothing usable, so callers can fall back to
 * the old first-8000-characters behaviour rather than judging on an empty
 * string — which the model would happily call a gap.
 */
export async function relevantExcerptFor(
  clauseText: string,
  documentId: number,
  maxChars = 8000,
): Promise<{ text: string; chunks: ChunkHit[] } | null> {
  const hits = await semanticDocumentCandidates(clauseText, {
    limit: 1,
    documentIds: [documentId],
  });
  const doc = hits[0];
  if (!doc || doc.chunks.length === 0) return null;

  const parts: string[] = [];
  let used = 0;
  for (const c of doc.chunks) {
    if (used + c.chunk_text.length > maxChars) break;
    parts.push(c.chunk_text);
    used += c.chunk_text.length;
  }
  if (parts.length === 0) return null;
  return { text: parts.join("\n\n[...]\n\n"), chunks: doc.chunks };
}
