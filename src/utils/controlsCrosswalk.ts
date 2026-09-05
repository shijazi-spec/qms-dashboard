/**
 * controlsCrosswalk — foundation for the cross-framework control taxonomy
 * ("map once, inherit many"), benchmark rec #2. See [[document-mapping-benchmark]].
 *
 * Model (empty until populated — from the Secure Controls Framework dataset
 * once licensed/obtained, or hand-authored for the priority frameworks):
 *
 *   controls                 — an internal/SCF-style control catalogue (the
 *                              single thing a document maps to ONCE).
 *   control_clause_mappings  — STRM crosswalk: control ↔ a framework clause
 *                              (obligation), with a relationship TYPE and a
 *                              1–10 STRENGTH (per NIST IR 8477 / SCF STRM).
 *                              This is what lets one control satisfy
 *                              equivalent clauses across ISO/PDPL/NCA/PCI/SAMA.
 *
 * The inheritance step (document → control → crosswalk → clauses across every
 * framework) is the populate/use phase that builds on this model.
 *
 * Both tables are declared fully in CREATE (no runtime ALTER) so schema-parity
 * stays clean and the deploy schema-diff never proposes a DROP.
 */

import { sharedPool as pool } from "./sharedPool";
import { redactSensitiveDeep } from "./eventLogsDatabase";

/** STRM relationship types (the five set-theoretic relations; we store the four meaningful ones). */
export type StrmRelationship =
  | "subset_of"
  | "intersects_with"
  | "equal_to"
  | "superset_of";

export const STRM_RELATIONSHIPS: StrmRelationship[] = [
  "subset_of",
  "intersects_with",
  "equal_to",
  "superset_of",
];

export interface Control {
  id?: number;
  control_code: string;
  title: string;
  description?: string | null;
  domain?: string | null;
  source?: string | null; // e.g. 'SCF', 'custom'
}

let initialized = false;
export async function initControlsCrosswalk(): Promise<void> {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS controls (
      id             SERIAL PRIMARY KEY,
      control_code   VARCHAR(100) UNIQUE NOT NULL,
      title          VARCHAR(512) NOT NULL,
      description    TEXT,
      domain         VARCHAR(128),
      source         VARCHAR(64) DEFAULT 'custom',
      -- Effectiveness testing. The retired control_mappings seed carried these
      -- and this table did not, which was the one real gap in adopting the
      -- crosswalk as the single control register: without them the Control
      -- Tower's "Control Effectiveness" panel had nothing to show.
      control_type   VARCHAR(32),
      owner          VARCHAR(200),
      test_frequency VARCHAR(32),
      last_tested_at TIMESTAMP,
      effectiveness_score INTEGER,
      created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Idempotent ALTERs for databases created before the effectiveness columns
  // existed. Each one is mirrored in the CREATE TABLE above; check:schema-parity
  // fails the build if the two ever drift.
  for (const col of [
    "control_type VARCHAR(32)",
    "owner VARCHAR(200)",
    "test_frequency VARCHAR(32)",
    "last_tested_at TIMESTAMP",
    "effectiveness_score INTEGER",
  ]) {
    await pool.query(
      `ALTER TABLE controls ADD COLUMN IF NOT EXISTS ${col}`,
    );
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS control_clause_mappings (
      id                SERIAL PRIMARY KEY,
      control_id        INTEGER NOT NULL REFERENCES controls(id) ON DELETE CASCADE,
      obligation_id     INTEGER NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
      relationship_type VARCHAR(20) NOT NULL DEFAULT 'intersects_with',
      strength          INTEGER NOT NULL DEFAULT 5,
      source            VARCHAR(64) DEFAULT 'custom',
      created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (control_id, obligation_id)
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_control_clause_mappings_obligation
       ON control_clause_mappings (obligation_id)`,
  );
  initialized = true;
}

/** Insert or update a control by its code; returns the control id. */
export async function upsertControl(c: Control): Promise<number> {
  await initControlsCrosswalk();
  const r = await pool.query(
    `INSERT INTO controls (control_code, title, description, domain, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (control_code) DO UPDATE
       SET title = EXCLUDED.title, description = EXCLUDED.description,
           domain = EXCLUDED.domain, source = EXCLUDED.source
     RETURNING id`,
    [
      redactSensitiveDeep(c.control_code, "control_code") as string,
      redactSensitiveDeep(c.title, "title") as string,
      redactSensitiveDeep(c.description ?? null, "description") as string | null,
      redactSensitiveDeep(c.domain ?? null, "domain") as string | null,
      redactSensitiveDeep(c.source ?? "custom", "source") as string,
    ],
  );
  return r.rows[0].id;
}

/** Crosswalk a control to a framework clause with an STRM relationship + strength. */
export async function mapControlToClause(
  controlId: number,
  obligationId: number,
  relationship: StrmRelationship = "intersects_with",
  strength = 5,
  source = "custom",
): Promise<void> {
  await initControlsCrosswalk();
  const rel = STRM_RELATIONSHIPS.includes(relationship) ? relationship : "intersects_with";
  const str = Math.max(1, Math.min(Math.round(strength) || 5, 10));
  await pool.query(
    `INSERT INTO control_clause_mappings
       (control_id, obligation_id, relationship_type, strength, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (control_id, obligation_id) DO UPDATE
       SET relationship_type = EXCLUDED.relationship_type,
           strength = EXCLUDED.strength, source = EXCLUDED.source`,
    [controlId, obligationId, rel, str, redactSensitiveDeep(source, "source") as string],
  );
}

/** All clauses (across every framework) a given control crosswalks to. */
export async function clausesForControl(controlId: number): Promise<any[]> {
  await initControlsCrosswalk();
  const r = await pool.query(
    `SELECT m.obligation_id, m.relationship_type, m.strength,
            o.obligation_code, o.title AS obligation_title,
            reg.regulation_code
       FROM control_clause_mappings m
       JOIN obligations o ON o.id = m.obligation_id
       JOIN regulations reg ON reg.id = o.regulation_id
      WHERE m.control_id = $1
      ORDER BY reg.regulation_code, o.obligation_code`,
    [controlId],
  );
  return r.rows;
}

/** Crosswalk coverage stats — how much of the taxonomy is populated yet. */
/**
 * Controls for the Control Tower's "Control Effectiveness" panel, aliased to
 * the column names that panel already renders (control_id / control_name /
 * source_domain) so adopting this table needed no rewrite of the table markup.
 *
 * clause_count and framework_count are what justify this table replacing the
 * old control_mappings seed: that register was a flat list with no relationship
 * to any clause, so it could never answer the only question worth asking of a
 * control — which obligations does it satisfy, across how many frameworks.
 * A control mapped to nothing is visible here as "0 clauses" rather than
 * looking identical to a well-mapped one.
 */
export async function listControlsWithCoverage(limit = 50): Promise<any[]> {
  await initControlsCrosswalk();
  const r = await pool.query(
    `SELECT c.control_code            AS control_id,
            c.title                   AS control_name,
            c.domain                  AS source_domain,
            c.control_type,
            c.owner,
            c.test_frequency,
            c.last_tested_at,
            c.effectiveness_score,
            c.source,
            COUNT(m.obligation_id)::int              AS clause_count,
            COUNT(DISTINCT o.regulation_id)::int     AS framework_count
       FROM controls c
       LEFT JOIN control_clause_mappings m ON m.control_id = c.id
       LEFT JOIN obligations o             ON o.id = m.obligation_id
      GROUP BY c.id
      ORDER BY clause_count DESC, c.control_code
      LIMIT $1`,
    [limit],
  );
  return r.rows;
}

export async function crosswalkStats(): Promise<{
  controls: number;
  mappings: number;
  clauses_covered: number;
}> {
  await initControlsCrosswalk();
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM controls) AS controls,
       (SELECT COUNT(*)::int FROM control_clause_mappings) AS mappings,
       (SELECT COUNT(DISTINCT obligation_id)::int FROM control_clause_mappings) AS clauses_covered`,
  );
  return r.rows[0];
}
