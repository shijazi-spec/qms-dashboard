import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getCallImportSourcesCatalog } from "../../utils/callMcpImportSources";

/**
 * MCP tool that returns the canonical catalog of how call records can
 * enter the platform (Five9, bulk upload, Google Drive) plus the
 * CRM-phone-match scope description. Pure read of in-process config —
 * no DB, no external API, no side effects.
 *
 * This was previously only reachable via the REST route
 * `/api/calls/evaluation/import-sources` (see
 * `src/mastra/routes/mcpCallEvaluationRoutes.ts`). Exposing it as an
 * MCP tool means external clients (Cursor, Claude Desktop, internal
 * agents) can discover the import surface through the normal MCP
 * `tools/list` + `tools/call` lifecycle instead of needing a
 * hard-coded HTTP fetch.
 */
export const getCallImportSourcesTool = createTool({
  id: "get-import-sources",
  description:
    "Return the catalog of call-record import channels (Five9, bulk upload, Google Drive) along with the SDR ↔ CRM phone-match scope. Read-only: no platform writes, no external API calls, no DB queries. Useful when an agent needs to explain to an operator how recordings reach QMS or which endpoints to POST to for a given source. The response includes `channels[]` (id / label / status / description / endpoints), `crm_phone_match_scope`, `crm_phone_match_scope_description`, and `sdr_process_scope`.",
  // Catalog reads take no input — the tool returns the full canonical
  // shape. Declared as an empty Zod object so the MCP `tools/list`
  // contract still publishes a valid JSON-Schema (type: object,
  // properties: {}) instead of omitting `inputSchema`, which some
  // external MCP clients treat as a missing-input bug.
  inputSchema: z.object({}),
  outputSchema: z.object({
    crm_phone_match_scope: z.string(),
    crm_phone_match_scope_description: z.string(),
    sdr_process_scope: z.unknown(),
    channels: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        status: z.string(),
        description: z.string(),
        endpoints: z.array(
          z.object({
            method: z.string(),
            path: z.string(),
            notes: z.string().optional(),
          }),
        ),
      }),
    ),
  }),
  execute: async () => {
    return getCallImportSourcesCatalog();
  },
});
