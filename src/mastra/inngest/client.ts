import { Inngest } from "inngest";

export const inngest = new Inngest(
  process.env.NODE_ENV === "production"
    ? {
        id: "replit-agent-workflow",
        name: "Replit Agent Workflow System",
      }
    : {
        id: "mastra",
        baseUrl: "http://localhost:3000",
        isDev: true,
      },
);
