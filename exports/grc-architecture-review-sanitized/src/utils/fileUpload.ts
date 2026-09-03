import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, statfsSync } from 'fs';
import { join, extname } from 'path';
import { randomBytes } from 'crypto';
import { logger } from './logger';
import { createRedactedPool } from './redactedPool';

const UPLOAD_DIR = join(process.cwd(), 'data', 'documents');

/**
 * Durable store for every attachment on the platform.
 *
 * Keyed by the logical path the owning row already holds, so no owner table
 * needed a schema change to move off the disappearing disk.
 */
const filePool = createRedactedPool({ connectionString: process.env.DATABASE_URL });
let uploadedFilesTableReady: Promise<void> | null = null;
function ensureUploadedFilesTable(): Promise<void> {
  if (!uploadedFilesTableReady) {
    uploadedFilesTableReady = filePool
      .query(`
        CREATE TABLE IF NOT EXISTS uploaded_files (
          file_key VARCHAR(500) PRIMARY KEY,
          module VARCHAR(50),
          file_name VARCHAR(500) NOT NULL,
          file_size INTEGER NOT NULL,
          file_mime_type VARCHAR(100),
          data BYTEA NOT NULL,
          uploaded_at TIMESTAMP DEFAULT NOW()
        )
      `)
      .then(() => undefined)
      .catch((err) => {
        // Reset so the next call retries rather than caching a failure.
        uploadedFilesTableReady = null;
        throw err;
      });
  }
  return uploadedFilesTableReady;
}
const MAX_FILE_SIZE = 25 * 1024 * 1024;

/**
 * Per-extension magic-byte signatures. We trust the file *bytes*, not the
 * client-supplied Content-Type header or the .ext on the filename, because
 * both are attacker-controlled in multipart uploads. A file whose declared
 * extension says ".pdf" but whose leading bytes are `MZ` is a Windows
 * executable being smuggled past the extension allowlist — reject it before
 * it lands in /data/documents, where some downstream consumer (text
 * extractor, viewer, antivirus scanner) may parse it under the wrong
 * assumption and trigger a vuln in that parser.
 *
 * Each signature is matched at offset 0. The OOXML formats (docx/xlsx/pptx)
 * are all ZIP containers and share `PK\x03\x04` — the bytes don't tell us
 * *which* Office format, so we accept all three under the same prefix and
 * lean on the extension allowlist to keep the .doc/.xls/.ppt-era binary
 * formats out.
 */
const MAGIC_BYTES: Record<string, Uint8Array[]> = {
  '.pdf': [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], // %PDF-
  '.docx': [new Uint8Array([0x50, 0x4b, 0x03, 0x04])],       // PK\x03\x04 (ZIP)
  '.xlsx': [new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
  '.pptx': [new Uint8Array([0x50, 0x4b, 0x03, 0x04])],
  '.png':  [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  '.jpg':  [new Uint8Array([0xff, 0xd8, 0xff])],
  '.jpeg': [new Uint8Array([0xff, 0xd8, 0xff])],
};

function bufferStartsWith(buffer: Buffer, sig: Uint8Array): boolean {
  if (buffer.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buffer[i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Returns true when `buffer` begins with one of the known magic-byte
 * signatures for `ext`. Returns false for unknown extensions so callers
 * fail closed.
 */
function magicBytesMatchExtension(buffer: Buffer, ext: string): boolean {
  const sigs = MAGIC_BYTES[ext];
  if (!sigs) return false;
  return sigs.some(sig => bufferStartsWith(buffer, sig));
}

// Minimum free disk space required before writing any uploaded file (200 MB).
const MIN_FREE_BYTES = 200 * 1024 * 1024;

/**
 * Returns the number of free bytes available in the upload directory, or null
 * if the check is unsupported on this platform.  Fail-open: callers must
 * treat null as "unknown" and decide whether to proceed.
 */
function getFreeDiskBytes(): number | null {
  try {
    const stats = statfsSync(UPLOAD_DIR);
    return stats.bfree * stats.bsize;
  } catch {
    return null;
  }
}

/**
 * Throws if the upload directory has less than MIN_FREE_BYTES + fileSize free.
 * Skips the check silently when statfs is unavailable.
 */
function assertDiskSpace(fileSize: number): void {
  const free = getFreeDiskBytes();
  if (free === null) return;
  if (free < MIN_FREE_BYTES + fileSize) {
    throw new Error(
      `Insufficient disk space: ${Math.round(free / 1024 / 1024)} MB free, ` +
      `need at least ${Math.round((MIN_FREE_BYTES + fileSize) / 1024 / 1024)} MB`,
    );
  }
}

const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
};

function ensureUploadDir(subdir?: string): void {
  const dir = subdir ? join(UPLOAD_DIR, subdir) : UPLOAD_DIR;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Module namespaces recognised by saveUploadedFile / getUploadedFileForModule.
 * Adding a new one is a deliberate change — every download route that reads
 * blobs for that module must call getUploadedFileForModule with the matching
 * namespace, or the cross-module isolation is silently lost.
 *
 * Namespace strings end up as a path segment under /data/documents/, so they
 * must be filesystem-safe (lowercase, no separators, no `..`). Enforced below
 * in assertValidModuleNamespace().
 */
export type UploadModuleNamespace =
  | 'policies'
  | 'qms-docs'
  | 'compliance'
  | 'call-evidence'
  | 'audits';

function assertValidModuleNamespace(ns: string): void {
  if (!/^[a-z][a-z0-9-]{1,32}$/.test(ns)) {
    throw new Error(`Invalid upload module namespace: ${ns}`);
  }
}

export function validateFile(fileName: string, fileSize: number, mimeType: string, buffer?: Buffer): { valid: boolean; error?: string } {
  if (fileSize > MAX_FILE_SIZE) {
    return { valid: false, error: `File size exceeds maximum of 25MB` };
  }

  const ext = extname(fileName).toLowerCase();
  const allowedExts = Object.values(ALLOWED_MIME_TYPES).flat();
  if (!allowedExts.includes(ext)) {
    return { valid: false, error: `File type ${ext} is not allowed. Allowed: PDF, DOCX, XLSX, PPTX, PNG, JPG` };
  }

  // When a buffer is supplied (the upload route already read the bytes
  // into memory), confirm the leading bytes actually match the claimed
  // extension. Skip when no buffer is available so legacy callers that
  // pre-validate before reading the body keep working — saveUploadedFile
  // re-checks unconditionally below.
  if (buffer && !magicBytesMatchExtension(buffer, ext)) {
    return { valid: false, error: `File contents do not match declared type ${ext}` };
  }

  return { valid: true };
}

export async function saveUploadedFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  moduleNamespace?: UploadModuleNamespace,
): Promise<{ filePath: string; fileName: string; fileSize: number; mimeType: string }> {
  assertDiskSpace(buffer.length);

  const ext = extname(originalName).toLowerCase();
  // Hard-fail on bytes/extension mismatch even when the caller did not
  // pre-validate. saveUploadedFile is the single bottleneck for every
  // attachment write, so this guard cannot be skipped by a careless route.
  if (!magicBytesMatchExtension(buffer, ext)) {
    throw new Error(`Refusing to save: file contents do not match extension ${ext}`);
  }
  const uniqueName = `${Date.now()}_${randomBytes(8).toString('hex')}${ext}`;

  // When moduleNamespace is supplied, write into /data/documents/{ns}/ so a
  // download handler can later prove the blob belongs to its module by
  // checking the path prefix. Callers that pre-date the namespaced layout
  // (or that don't yet know their module) fall back to the legacy flat
  // /data/documents/ directory; getUploadedFileForModule still serves those
  // when `allowLegacy: true` is passed.
  let filePath: string;
  let relPath: string;
  if (moduleNamespace) {
    assertValidModuleNamespace(moduleNamespace);
    ensureUploadDir(moduleNamespace);
    filePath = join(UPLOAD_DIR, moduleNamespace, uniqueName);
    relPath = `/data/documents/${moduleNamespace}/${uniqueName}`;
  } else {
    ensureUploadDir();
    filePath = join(UPLOAD_DIR, uniqueName);
    relPath = `/data/documents/${uniqueName}`;
  }

  // Bytes go to the DATABASE, keyed by the same logical path the owner row
  // stores. Replit rebuilds the deployment directory from the repo on every
  // publish and `data/` is untracked, so a disk write is deleted at the next
  // deploy while the owning row keeps pointing at it — the Customer Success
  // SOP served "File not found on disk" that way (2026-08-19). Every module
  // that attaches evidence goes through this function, so fixing it here fixes
  // compliance, obligation documents, QMS documents and the doc tracker at
  // once rather than four times.
  //
  // `filePath` is now a KEY, not a filesystem location. It keeps the
  // /data/documents/{ns}/ shape because the module-scoping guard in
  // getUploadedFileForModule reads that prefix to prove a blob belongs to the
  // module asking for it — that check is security, not path handling.
  await ensureUploadedFilesTable();
  await filePool.query(
    `INSERT INTO uploaded_files (file_key, module, file_name, file_size, file_mime_type, data)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (file_key) DO UPDATE SET
       module=EXCLUDED.module, file_name=EXCLUDED.file_name,
       file_size=EXCLUDED.file_size, file_mime_type=EXCLUDED.file_mime_type,
       data=EXCLUDED.data`,
    [relPath, moduleNamespace ?? null, originalName, buffer.length, mimeType, buffer],
  );
  void filePath; // retained above only to keep the namespace assertions honest

  return {
    filePath: relPath,
    fileName: originalName,
    fileSize: buffer.length,
    mimeType,
  };
}

/** Read a stored blob by its key, or null. Disk is the legacy fallback. */
async function readStoredFile(
  fileKey: string,
): Promise<{ buffer: Buffer; fileName: string } | null> {
  try {
    await ensureUploadedFilesTable();
    const r = await filePool.query(
      `SELECT data, file_name FROM uploaded_files WHERE file_key = $1`,
      [fileKey],
    );
    if (r.rows[0]) {
      return { buffer: r.rows[0].data as Buffer, fileName: String(r.rows[0].file_name) };
    }
  } catch (err) {
    logger.error('[fileUpload] DB read failed; falling back to disk', {
      fileKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Legacy rows written before the move, on a deployment that still has them.
  const fullPath = join(UPLOAD_DIR, fileKey.replace('/data/documents/', ''));
  if (!existsSync(fullPath)) return null;
  return { buffer: readFileSync(fullPath), fileName: fileKey.split('/').pop() || 'file' };
}

/**
 * Legacy reader — accepts any path under /data/documents/. Retained so
 * background scripts (migrations, sweepers) and any handler that hasn't
 * been namespaced yet keep working. **Do not call from a module-scoped
 * download route**: it returns a blob no matter which module saved it, so
 * a download endpoint that takes a caller-controlled `filePath` could be
 * pivoted into reading another module's attachments. Use
 * getUploadedFileForModule(...) from download routes instead.
 */
export async function getUploadedFile(
  relativePath: string,
): Promise<{ buffer: Buffer; fileName: string } | null> {
  const normalizedPath = relativePath.replace(/\.\./g, '').replace(/\/\//g, '/');
  if (!normalizedPath.startsWith('/data/documents/')) return null;
  return readStoredFile(normalizedPath);
}

/**
 * Module-scoped reader for download routes. Returns the blob only if its
 * stored path is under /data/documents/{moduleNamespace}/. With
 * `allowLegacy: true`, also accepts the un-namespaced legacy path
 * /data/documents/{file} for rows written before the namespaced layout
 * existed; new code should leave `allowLegacy` off so any cross-module path
 * lookup is rejected outright.
 *
 * Pairs with saveUploadedFile(..., moduleNamespace) — the two together
 * enforce that a download endpoint in module X cannot return module Y's
 * attachments, even if an attacker manages to write Y's file_path into
 * one of X's database rows.
 */
export async function getUploadedFileForModule(
  relativePath: string,
  moduleNamespace: UploadModuleNamespace,
  opts?: { allowLegacy?: boolean },
): Promise<{ buffer: Buffer; fileName: string } | null> {
  assertValidModuleNamespace(moduleNamespace);
  const normalizedPath = relativePath.replace(/\.\./g, '').replace(/\/\//g, '/');
  const namespacedPrefix = `/data/documents/${moduleNamespace}/`;
  const legacyPrefix = '/data/documents/';

  const inNamespace = normalizedPath.startsWith(namespacedPrefix);
  // Legacy match = `/data/documents/<file>` with NO additional `/` between
  // `documents/` and the filename (otherwise it would be inside *some*
  // module's namespace, and we must reject if that namespace isn't ours).
  const tail = inNamespace ? null : normalizedPath.slice(legacyPrefix.length);
  const isLegacyFlatPath =
    !inNamespace &&
    normalizedPath.startsWith(legacyPrefix) &&
    tail !== null &&
    tail.length > 0 &&
    !tail.includes('/');

  if (!inNamespace && !(isLegacyFlatPath && opts?.allowLegacy)) {
    return null;
  }

  // The prefix checks above are the module-scoping guard and still apply —
  // only the storage moved.
  return readStoredFile(normalizedPath);
}

export async function deleteUploadedFile(relativePath: string): Promise<boolean> {
  let fullPath: string | null = null;
  try {
    const normalizedPath = relativePath.replace(/\.\./g, '').replace(/\/\//g, '/');
    if (!normalizedPath.startsWith('/data/documents/')) return false;
    await ensureUploadedFilesTable();
    const r = await filePool.query(`DELETE FROM uploaded_files WHERE file_key = $1`, [
      normalizedPath,
    ]);
    let removed = (r.rowCount || 0) > 0;
    // Also clear any legacy blob still on this deployment's disk.
    fullPath = join(UPLOAD_DIR, normalizedPath.replace('/data/documents/', ''));
    if (existsSync(fullPath)) {
      unlinkSync(fullPath);
      removed = true;
    }
    return removed;
  } catch (err) {
    // Surface the failure so an orphaned blob in /data/documents is visible
    // to ops instead of silently filling the volume over time. Callers that
    // checked the return value will still see `false`; callers that ignored
    // it (the common case — see policyRoutes replacement flow) now leave
    // a trail in the structured log + system_events for a sweeper to act on.
    logger.error('[fileUpload] failed to delete uploaded blob', {
      relativePath,
      fullPath,
      error: err instanceof Error ? err.message : String(err),
    });
    // Best-effort: fire-and-forget a system_event so the orphan shows up in
    // the security/observability dashboards alongside other infra warnings.
    // Loaded lazily to avoid a top-level cycle with the database module.
    import('./database')
      .then(({ logSystemEvent }) =>
        logSystemEvent({
          event_type: 'upload_blob_delete_failed',
          event_category: 'security',
          description: `Failed to delete uploaded blob ${relativePath}`,
          severity: 'warning',
          source: 'fileUpload',
          metadata: {
            relative_path: relativePath,
            full_path: fullPath,
            error: err instanceof Error ? err.message : String(err),
          },
        }),
      )
      .catch(() => { /* swallow — never let observability break the caller */ });
    return false;
  }
}
