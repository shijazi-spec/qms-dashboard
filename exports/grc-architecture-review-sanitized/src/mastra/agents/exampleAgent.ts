import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { sharedPostgresStorage } from "../storage";
import { exampleTool } from "../tools/exampleTool";
import { createLLMProvider } from "@ai-sdk/LLMProvider-v5";
import { getLLMProviderApiKey, getLLMProviderBaseUrl } from "../../utils/LLMProviderCredentials";

/**
 * LLM CLIENT CONFIGURATION
 *
 * IMPORTANT: Both approaches require the SAME syntax for HostingPlatform Playground compatibility:
 * - Use AI SDK v4: model, e.g. LLMProvider("gpt-4o-mini")
 * - In workflows: Use agent.generateLegacy()
 * - The HostingPlatform Playground UI always calls the legacy Mastra endpoint.
 * NOTE: You must always keep the API key as an environment variable for safety!
 * ---
 * OPTION 1: HostingPlatform AI Integrations, **only** if user has enabled it via connector.
 *
 * No LLMProvider API key required - charges billed to HostingPlatform credits
 * Automatic key rotation and management
 */
const LLMProvider = createLLMProvider({
  baseURL: getLLMProviderBaseUrl(),
  apiKey: getLLMProviderApiKey(),
});
/*
 * OPTION 2: Standard LLMProvider Setup (Your Own API Key)
 */
// const LLMProvider = createLLMProvider({
//   baseURL: process.env.LLMProvider_BASE_URL || undefined,
//   apiKey: process.env.LLMProvider_API_KEY,
// });

/**
 * Example Mastra Agent
 *
 * MASTRA AGENT GUIDE:
 * - Agents are AI-powered assistants that can use tools and maintain conversation memory
 * - They combine an LLM model with tools and optional memory storage
 * - Agents can be used in workflows
 */

export const exampleAgent = new Agent({
  // Give your agent a descriptive name
  name: "Example Agent",

  /**
   * Instructions define your agent's behavior and personality
   * Be specific about:
   * - What the agent should do
   * - How it should respond
   * - What tools it should use and when
   * - Any constraints or guidelines
   */
  instructions: `
    You are a helpful example agent that demonstrates how to use Mastra agents.

    Your primary function is to process messages using the example tool and explain what you're doing.

    When responding:
    - Always be helpful and educational
    - Explain what tools you're using and why
    - If asked to process a message, use the exampleTool
    - Share the results in a clear, formatted way
    - Add educational comments about how Mastra works when relevant

    Remember: You're teaching developers how to use Mastra by example!
`,

  /**
   * Choose your LLM model
   *
   * MUST use AI SDK v4 syntax for HostingPlatform Playground compatibility.
   * Use LLMProvider.responses("gpt-5") for gpt-5 class models, use LLMProvider("gpt-4o") for gpt-4 class models.
   */
  model: LLMProvider.responses("gpt-5"),

  /**
   * Provide tools that the agent can use
   * Tools must be created with createTool()
   * You can provide multiple tools.
   */
  tools: { exampleTool },

  /**
   * Optional: Add memory to persist conversations.
   * Using PostgreSQL for production-ready persistent storage.
   * Only add memory if the user requests it or it's strongly implied (e.g., a chatbot that needs to remember context).  See Mastra docs for more information.
   */
  memory: new Memory({
    options: {
      threads: {
        generateTitle: true, // Auto-generate conversation titles
      },
      lastMessages: 10, // Example: Keep last 10 messages in context
    },
    storage: sharedPostgresStorage,
  }),

  /**
   * Optional: Configure additional settings
   */
  // maxSteps: 10, // Limit tool usage iterations if needed
  // temperature: 0.9, // Control creativity (0-1)
  // If you need other standard LLM agent features, check the Mastra docs to see if there's a primitive you can use.
});
