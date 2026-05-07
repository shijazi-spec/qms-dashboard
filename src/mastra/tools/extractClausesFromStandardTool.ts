import { logger } from "../../utils/logger";

export interface ExtractedClauseDraft {
  clause_code: string;
  title: string;
  body: string;
}

export interface ExtractClausesResult {
  draft: ExtractedClauseDraft[];
}

export async function extractClausesForDocument(
  documentId: number,
  regulationId: number,
): Promise<ExtractClausesResult> {
  logger.warn(
    "[extractClausesFromStandardTool] stub invoked — clause extraction not yet implemented",
    { documentId, regulationId },
  );
  return { draft: [] };
}
