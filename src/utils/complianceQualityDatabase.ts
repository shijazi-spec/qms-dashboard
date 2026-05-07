import { logger } from "./logger";

export interface PendingJudgementLink {
  obligation_id: number;
  document_id: number;
  applied_by: string;
}

export async function listLinksPendingJudgement(_opts: {
  limit: number;
}): Promise<PendingJudgementLink[]> {
  logger.warn(
    "[complianceQualityDatabase] listLinksPendingJudgement stub — compliance judgement table not yet provisioned",
  );
  return [];
}
