import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * The live options menu: the platform's own sections, ranked by what this team
 * has actually asked about over the last 90 days, so the menu evolves without a
 * prompt edit. `unclassified` counts questions that matched no section — a
 * signal for Quality to extend a section's keywords, not something to show a
 * manager.
 */
export const sectionMenuTool = createTool({
  id: "section-menu",

  description:
    "Get the live numbered options menu — the platform's sections, ordered by what the team has actually asked about recently. Call this whenever you need to offer someone a list of what you can report on (for example when a request is vague, like 'what is the status?'). Returns options (key, label, href, asked) in the order to present them, plus unclassified: a count of questions that matched no section, which is a signal for Quality and not for a manager. Read-only.",

  inputSchema: z.object({
    limit: z.number().optional().describe("How many options to return (default 5)"),
  }),

  outputSchema: z.object({
    success: z.boolean(),
    options: z.array(z.record(z.any())),
    unclassified: z.number(),
    error: z.string().optional(),
  }),

  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    try {
      const { getSectionMenu } = await import("../../utils/adamTopicLog");
      const { options, unclassified } = await getSectionMenu(context?.limit ?? 5);
      logger?.info("🧭 [sectionMenuTool] menu served", {
        options: options.length,
        unclassified,
      });
      return { success: true, options, unclassified };
    } catch (e: any) {
      return { success: false, options: [], unclassified: 0, error: e?.message || String(e) };
    }
  },
});
