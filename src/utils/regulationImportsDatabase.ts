import { logger } from "./logger";

export interface RegulationImportDraftRow {
  clause_code?: string;
  title?: string;
  body?: string;
  accepted?: boolean;
  [key: string]: unknown;
}

export async function setImportDraft(
  _importId: number,
  _draft: RegulationImportDraftRow[],
  _status: string,
): Promise<void> {
  logger.warn(
    "[regulationImportsDatabase] setImportDraft stub — regulation imports table not yet provisioned",
  );
}

export async function setImportError(
  _importId: number,
  _error: string,
): Promise<void> {
  logger.warn(
    "[regulationImportsDatabase] setImportError stub — regulation imports table not yet provisioned",
  );
}
