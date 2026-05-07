import { logger } from "./logger";

export interface CitationExtractionResult {
  document_id: number;
  citations_found: number;
  skipped: boolean;
}

export async function runCitationExtraction(
  documentId: number,
): Promise<CitationExtractionResult> {
  logger.warn(
    "[clauseCitationExtractor] stub invoked — citation extraction not yet implemented",
    { documentId },
  );
  return {
    document_id: documentId,
    citations_found: 0,
    skipped: true,
  };
}
