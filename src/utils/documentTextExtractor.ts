import { logger } from "./logger";

export type DocumentExtractionStatus =
  | "extracted"
  | "unsupported"
  | "failed"
  | "missing"
  | "pending";

export interface DocumentExtractionResult {
  status: DocumentExtractionStatus;
  text: string | null;
  hash: string | null;
  stored_chars?: number;
}

export async function extractDocumentText(
  filePath: string,
  mimeType: string,
): Promise<DocumentExtractionResult> {
  logger.warn(
    "[documentTextExtractor] stub invoked — extraction pipeline not yet implemented",
    { filePath, mimeType },
  );
  return {
    status: "unsupported",
    text: null,
    hash: null,
    stored_chars: 0,
  };
}
