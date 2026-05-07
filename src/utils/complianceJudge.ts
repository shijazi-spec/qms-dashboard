import { logger } from "./logger";

export interface JudgementVerdict {
  obligation_id: number;
  document_id: number;
  verdict: "supports" | "partial" | "does_not_support" | "skipped";
  confidence: number;
  rationale: string | null;
}

export async function judgeEvidence(
  obligationId: number,
  documentId: number,
  appliedBy: string,
): Promise<JudgementVerdict> {
  logger.warn(
    "[complianceJudge] judgeEvidence stub — compliance judge not yet implemented",
    { obligationId, documentId, appliedBy },
  );
  return {
    obligation_id: obligationId,
    document_id: documentId,
    verdict: "skipped",
    confidence: 0,
    rationale: null,
  };
}
