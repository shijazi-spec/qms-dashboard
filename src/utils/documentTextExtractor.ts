/**
 * Document text-extraction helper (Phase 2.1).
 *
 * Reads the binary file pointed to by `qms_uploaded_documents.file_path`
 * and returns plain text suitable for LLM consumption. Supports:
 *
 *   - .pdf            via `pdf-parse`            (NPM dep)
 *   - .docx           via `mammoth`              (NPM dep)
 *   - .xlsx           via `exceljs`              (already in repo)
 *   - .txt / .md      via fs.readFile (utf-8)
 *
 * Returns one of these statuses:
 *
 *   - `extracted`   text successfully read; full text returned
 *   - `unsupported` mime / extension we don't know how to read
 *   - `failed`      we tried but the parser threw (corrupt file, etc.)
 *   - `skipped`     extraction was deliberately skipped (e.g. file > 25MB)
 *
 * Calls are guarded with try/catch + `await import(...)` so the caller
 * never crashes the boot process if a parser dependency hasn't been
 * installed yet (the row simply gets marked `unsupported` and the
 * compliance UI degrades gracefully).
 *
 * Output is truncated to `MAX_CHARS` to keep DB rows manageable. Full
 * SHA-256 of the raw file is returned so the caller can persist it for
 * change-detection (re-extract if hash changed).
 */

import { promises as fs } from "fs";
import { createHash } from "crypto";
import { extname, basename } from "path";
import { logger } from "./logger";

export type ExtractionStatus =
  | "extracted"
  | "unsupported"
  | "failed"
  | "skipped";

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string | null;
  hash: string | null;
  /** Optional, useful for diagnostics / unit tests. */
  reason?: string;
  /** Effective length stored in DB after truncation. */
  stored_chars?: number;
}

/** Max characters retained in `extracted_text`. Aligned with plan. */
export const MAX_CHARS = 50_000;

/** Files larger than this are not attempted (returns `skipped`). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB

/**
 * Whitelist of (extension, parser) pairs. `parser` is invoked with the
 * raw Buffer and must return a string of plain text.
 */
type Parser = (buf: Buffer) => Promise<string>;

const PARSERS: Record<string, Parser> = {
  ".pdf": parsePdf,
  ".docx": parseDocx,
  ".xlsx": parseXlsx,
  ".txt": parseText,
  ".md": parseText,
  ".markdown": parseText,
  ".log": parseText,
  ".csv": parseText,
};

/**
 * Best-guess of an extension based on the original filename, falling
 * back to mime sniffing for the common types we recognise.
 */
export function detectExtension(filePath: string, mime?: string | null): string {
  const ext = extname(filePath).toLowerCase();
  if (ext) return ext;
  if (!mime) return "";
  const m = mime.toLowerCase();
  if (m.includes("pdf")) return ".pdf";
  if (m.includes("word") || m.includes("officedocument.wordprocessingml")) return ".docx";
  if (m.includes("spreadsheet") || m.includes("officedocument.spreadsheetml")) return ".xlsx";
  if (m.includes("text/")) return ".txt";
  return "";
}

/**
 * Main entry point — given a file path on disk, return text + status.
 *
 * Never throws. Errors are converted into `failed` status with `reason`
 * set so the caller can store both for later debugging.
 */
export async function extractDocumentText(
  filePath: string,
  mimeType?: string | null,
): Promise<ExtractionResult> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    return {
      status: "failed",
      text: null,
      hash: null,
      reason: `cannot stat file: ${(err as Error).message}`,
    };
  }
  if (!stat.isFile()) {
    return { status: "failed", text: null, hash: null, reason: "not a file" };
  }
  if (stat.size > MAX_FILE_BYTES) {
    return {
      status: "skipped",
      text: null,
      hash: null,
      reason: `file too large (${stat.size} bytes > ${MAX_FILE_BYTES})`,
    };
  }

  const ext = detectExtension(filePath, mimeType);
  const parser = ext ? PARSERS[ext] : undefined;
  if (!parser) {
    return {
      status: "unsupported",
      text: null,
      hash: null,
      reason: `unsupported extension/mime (${ext || "none"} / ${mimeType || "none"})`,
    };
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(filePath);
  } catch (err) {
    return {
      status: "failed",
      text: null,
      hash: null,
      reason: `cannot read file: ${(err as Error).message}`,
    };
  }

  const hash = createHash("sha256").update(buf).digest("hex");

  let text: string;
  try {
    text = await parser(buf);
  } catch (err) {
    logger.warn(
      `⚠️ [DocExtractor] Parser failed for ${basename(filePath)}: ${(err as Error).message}`,
    );
    return {
      status: "failed",
      text: null,
      hash,
      reason: `parser threw: ${(err as Error).message}`,
    };
  }

  const cleaned = (text || "").replace(/\u0000/g, "").trim();
  const truncated = cleaned.slice(0, MAX_CHARS);
  return {
    status: "extracted",
    text: truncated,
    hash,
    stored_chars: truncated.length,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Parsers
// ──────────────────────────────────────────────────────────────────────

async function parseText(buf: Buffer): Promise<string> {
  // Attempt UTF-8 first; fall back to latin1 if first attempt looks broken.
  const utf8 = buf.toString("utf8");
  if (!utf8.includes("\uFFFD")) return utf8;
  return buf.toString("latin1");
}

async function parsePdf(buf: Buffer): Promise<string> {
  // pdf-parse is a CommonJS module; dynamic import keeps it optional so
  // a missing install doesn't crash the boot. The require-style default
  // export shape varies by Node version, hence the destructure dance.
  let pdfParse: any;
  try {
    const mod: any = await import("pdf-parse");
    pdfParse = mod.default || mod;
  } catch (err) {
    throw new Error(
      `pdf-parse not installed. Run \`npm install pdf-parse\`. (${(err as Error).message})`,
    );
  }
  const out = await pdfParse(buf, { max: 200 });
  return typeof out?.text === "string" ? out.text : "";
}

async function parseDocx(buf: Buffer): Promise<string> {
  let mammoth: any;
  try {
    mammoth = await import("mammoth");
  } catch (err) {
    throw new Error(
      `mammoth not installed. Run \`npm install mammoth\`. (${(err as Error).message})`,
    );
  }
  const fn = mammoth.extractRawText || mammoth.default?.extractRawText;
  if (!fn) throw new Error("mammoth.extractRawText not available");
  const out = await fn({ buffer: buf });
  return typeof out?.value === "string" ? out.value : "";
}

async function parseXlsx(buf: Buffer): Promise<string> {
  // exceljs is already a dep (used by export endpoints), so this is safe.
  let ExcelJS: any;
  try {
    ExcelJS = (await import("exceljs")).default;
  } catch (err) {
    throw new Error(
      `exceljs not installed. (${(err as Error).message})`,
    );
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const lines: string[] = [];
  wb.eachSheet((sheet: any) => {
    lines.push(`# Sheet: ${sheet.name}`);
    sheet.eachRow((row: any) => {
      const values = (row.values as any[]) || [];
      const cells = values
        .slice(1) // exceljs leaves index 0 unused
        .map((v: any) => {
          if (v == null) return "";
          if (typeof v === "object" && "richText" in v) {
            return (v.richText as any[]).map((rt) => rt.text || "").join("");
          }
          if (typeof v === "object" && "text" in v) return String(v.text);
          if (v instanceof Date) return v.toISOString();
          return String(v);
        })
        .join("\t");
      if (cells.trim()) lines.push(cells);
    });
  });
  return lines.join("\n");
}
