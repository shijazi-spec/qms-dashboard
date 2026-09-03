import { Inngest } from "inngest";

export const inngest = new Inngest(
  process.env.NODE_ENV === "production"
    ? {
        id: "HostingPlatform-agent-workflow",
        name: "HostingPlatform Agent Workflow System",
      }
    : {
        id: "mastra",
        baseUrl: "<REDACTED_URL>",
        isDev: true,
      },
);
