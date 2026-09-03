/**
 * migrate-documents-to-namespaced-paths.ts
 * --------------------------------------------------------------------------
 * Backfill for the /data/documents/ module-namespacing change introduced
 * alongside src/utils/fileUpload.ts::getUploadedFileForModule. Existing
 * production rows still reference blobs at the legacy flat path
 *
 *   /data/documents/<timestamp>_<hash>.<ext>
 *
 * which means a download endpoint in module X has no way to prove a blob
 * really belongs to it (everything lives in the same directory). This script
 * relocates each legacy blob into the correct module subdirectory
 *
 *   /data/documents/<module>/<timestamp>_<hash>.<ext>
 *
 * and updates the owning row(s) to match. Once the migration is clean across
 * all environments, flip `allowLegacy: true` to `false` in the
 * getUploadedFileForModule call sites (policyRoutes, qmsDocsRoutes,
 * complianceRoutes) to remove the legacy fallback entirely.
 *
 * Usage:
 *   npx tsx scripts/migrate-documents-to-namespaced-paths.ts            # dry-run
 *   npx tsx scripts/migrate-documents-to-namespaced-paths.ts --apply    # perform the move
 *
 * Safety properties:
 *   - Idempotent: rows already pointing into a namespaced subdir are skipped.
 *   - File first, DB second: the blob is copied (NOT moved) into the new
 *     location, the DB rows are updated, and only then is the legacy copy
 *     unlinked. A failure between copy and unlink leaves a harmless orphan
 *     under the old path instead of a row that points at nothing.
 *   - Multi-row aware: a single blob may be referenced by more than one row
 *     (policies + policy_versions both store file_path). All matching rows
 *     are updated in a single transaction.
 *   - Refuses to touch a row whose blob is missing on disk: the migration
 *     will not silently delete file_path on missing files — investigate
 *     and resolve those manually.
 */

import { existsSync, copyFileSync, unlinkSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import pg from 'pg';

const { Pool } = pg;

interface MigrationTarget {
  /** Human-readable label for logs. */
  label: string;
  /** Table whose path column we own (the "primary" row driving the move). */
  table: string;
  /** Column that stores the on-disk relative path. */
  column: string;
  /** Module namespace the blob belongs to. Must match an UploadModuleNamespace. */
  moduleNamespace: string;
  /**
   * Secondary tables that *reference* the same path and must be rewritten in
   * lock-step when the primary row moves (e.g. policy_versions snapshots the
   * policies.file_path at version creation time). Each entry uses the same
   * column-name convention as the primary table.
   */
  secondaryReferences?: Array<{ table: string; column: string }>;
}

const TARGETS: MigrationTarget[] = [
  {
    label: 'policies',
    table: 'policies',
    column: 'file_path',
    moduleNamespace: 'policies',
    secondaryReferences: [{ table: 'policy_versions', column: 'file_path' }],
  },
  {
    label: 'qms-docs',
    table: 'qms_uploaded_documents',
    column: 'file_path',
    moduleNamespace: 'qms-docs',
  },
  {
    label: 'compliance regulations',
    table: 'regulations',
    column: 'document_path',
    moduleNamespace: 'compliance',
  },
];

const UPLOAD_DIR = join(process.cwd(), 'data', 'documents');
const LEGACY_PREFIX = '/data/documents/';

/**
 * Returns true for paths shaped like `/data/documents/<file>` with no
 * additional `/` after the prefix. Anything already inside a module subdir
 * (e.g. `/data/documents/policies/foo.pdf`) is not legacy and must be left
 * alone.
 */
function isLegacyFlatPath(p: string): boolean {
  if (!p.startsWith(LEGACY_PREFIX)) return false;
  const tail = p.slice(LEGACY_PREFIX.length);
  return tail.length > 0 && !tail.includes('/');
}

function legacyOnDiskPath(p: string): string {
  return join(UPLOAD_DIR, p.replace(LEGACY_PREFIX, ''));
}

function namespacedRelPath(p: string, ns: string): string {
  const tail = p.slice(LEGACY_PREFIX.length);
  return `${LEGACY_PREFIX}${ns}/${tail}`;
}

function namespacedOnDiskPath(p: string, ns: string): string {
  const tail = p.slice(LEGACY_PREFIX.length);
  return join(UPLOAD_DIR, ns, tail);
}

async function migrateTarget(
  pool: InstanceType<typeof Pool>,
  target: MigrationTarget,
  apply: boolean,
): Promise<{ scanned: number; moved: number; skipped: number; missing: number; errors: number }> {
  const stats = { scanned: 0, moved: 0, skipped: 0, missing: 0, errors: 0 };

  const res = await pool.query(
    `SELECT DISTINCT ${target.column} AS path
       FROM ${target.table}
      WHERE ${target.column} IS NOT NULL
        AND ${target.column} LIKE '/data/documents/%'`,
  );

  for (const row of res.rows) {
    const oldPath: string = row.path;
    stats.scanned += 1;

    if (!isLegacyFlatPath(oldPath)) {
      stats.skipped += 1;
      continue;
    }

    const oldDisk = legacyOnDiskPath(oldPath);
    if (!existsSync(oldDisk)) {
      console.warn(
        `[${target.label}] missing on disk: ${oldPath} — refusing to update DB row; investigate manually.`,
      );
      stats.missing += 1;
      continue;
    }

    const newPath = namespacedRelPath(oldPath, target.moduleNamespace);
    const newDisk = namespacedOnDiskPath(oldPath, target.moduleNamespace);

    if (!apply) {
      console.log(
        `[${target.label}] DRY-RUN would move ${oldPath} -> ${newPath} (${statSync(oldDisk).size} bytes)`,
      );
      stats.moved += 1;
      continue;
    }

    try {
      // 1. Copy the blob into the new location. We intentionally copy
      //    instead of rename so that if the DB UPDATE fails the legacy
      //    copy is still in place and the row keeps resolving.
      mkdirSync(dirname(newDisk), { recursive: true });
      if (!existsSync(newDisk)) {
        copyFileSync(oldDisk, newDisk);
      }

      // 2. Update the primary row(s) and every secondary reference in a
      //    single transaction so a partial state can't leak rows that
      //    point at the old path while others point at the new one.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE ${target.table}
              SET ${target.column} = $1
            WHERE ${target.column} = $2`,
          [newPath, oldPath],
        );
        for (const ref of target.secondaryReferences ?? []) {
          await client.query(
            `UPDATE ${ref.table}
                SET ${ref.column} = $1
              WHERE ${ref.column} = $2`,
            [newPath, oldPath],
          );
        }
        await client.query('COMMIT');
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw txErr;
      } finally {
        client.release();
      }

      // 3. Drop the legacy copy. Failure here leaves a harmless orphan
      //    (DB already points at the new location) so we log but do not
      //    roll back.
      try {
        unlinkSync(oldDisk);
      } catch (unlinkErr) {
        console.warn(
          `[${target.label}] copied + DB updated but failed to unlink legacy blob ${oldDisk}:`,
          unlinkErr,
        );
      }

      console.log(`[${target.label}] moved ${oldPath} -> ${newPath}`);
      stats.moved += 1;
    } catch (err) {
      console.error(`[${target.label}] FAILED for ${oldPath}:`, err);
      stats.errors += 1;
    }
  }

  return stats;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set — aborting.');
    process.exit(1);
  }

  console.log(
    apply
      ? '==> APPLY mode: blobs will be copied + DB rows updated + legacy blobs unlinked.'
      : '==> DRY-RUN mode (default). Pass --apply to perform the migration.',
  );

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    let grandTotal = { scanned: 0, moved: 0, skipped: 0, missing: 0, errors: 0 };
    for (const target of TARGETS) {
      console.log(`\n--- ${target.label} ---`);
      const stats = await migrateTarget(pool, target, apply);
      console.log(
        `[${target.label}] scanned=${stats.scanned} moved=${stats.moved} skipped=${stats.skipped} missing=${stats.missing} errors=${stats.errors}`,
      );
      grandTotal.scanned += stats.scanned;
      grandTotal.moved += stats.moved;
      grandTotal.skipped += stats.skipped;
      grandTotal.missing += stats.missing;
      grandTotal.errors += stats.errors;
    }

    console.log('\n=== Totals ===');
    console.log(grandTotal);

    if (grandTotal.errors > 0) {
      console.error('\nOne or more rows failed to migrate. Investigate and re-run.');
      process.exit(2);
    }
    if (grandTotal.missing > 0) {
      console.warn(
        '\nSome legacy paths had no blob on disk and were left untouched. ' +
          'Resolve those (restore from backup, or null the column) before flipping allowLegacy off.',
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
