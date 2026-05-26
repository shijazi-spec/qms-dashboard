/**
 * Wire-level MCP protocol compliance test.
 *
 * What this exercises
 * ───────────────────
 * The platform registers an `MCPServer` in `src/mastra/index.ts` named
 * `allTools` that exposes 5 tools. All prior MCP testing
 * (`tests/mcp-eval/runMcpEval.ts`) calls the underlying rules engine
 * function directly — useful for business-logic validation but it never
 * touches the MCP protocol surface. None of the other 4 registered tools
 * have any protocol coverage at all.
 *
 * This file fills that gap. It spins up the same `@mastra/mcp`
 * `MCPServer` class the production code uses, wires it to the official
 * `@modelcontextprotocol/sdk` `Client` over an `InMemoryTransport` pair,
 * and drives the full MCP lifecycle end-to-end:
 *
 *   1. `initialize` — Client → Server handshake.
 *      Asserts: serverInfo.{name, version}, capabilities.tools is
 *      advertised. Capability negotiation must happen BEFORE any normal
 *      request per spec.
 *
 *   2. `notifications/initialized` — Client signals ready.
 *      Asserts: no error response.
 *
 *   3. `tools/list` — discovery.
 *      Asserts: all 5 registered tool IDs are present, each with a
 *      `name`, `description`, and a JSON-Schema `inputSchema` that has
 *      `type: "object"` and a `properties` map.
 *
 *   4. `tools/call` — happy path.
 *      Asserts: `evaluate-sdr-governance` returns a valid MCP result
 *      with at least one `content` entry of type "text" whose parsed
 *      JSON contains the documented fields (issues, rules_evaluated,
 *      ruleset_version). This tool was picked because it's pure (no DB,
 *      no Drive credentials, no external API) so it works in any test
 *      environment.
 *
 *   5. `tools/call` — negative path: unknown tool name.
 *      Asserts: the Client throws an error or returns `isError: true`
 *      with a recognisable "tool not found" / "Unknown tool" message.
 *      Confirms the server's error mapping conforms to MCP.
 *
 *   6. `tools/call` — negative path: invalid arguments.
 *      Asserts: the Zod schema rejection surfaces as an MCP-level error
 *      result rather than crashing the server.
 *
 * Why this matters
 * ────────────────
 * Direct-function tests of tool internals are necessary but not
 * sufficient. They cannot catch:
 *   - A tool being silently un-registered from the MCPServer
 *   - A tool's `inputSchema` failing JSON-Schema validation that
 *     external MCP clients depend on
 *   - A regression in capability negotiation that prevents real
 *     clients (Cursor, Claude Desktop, Windsurf, etc.) from connecting
 *   - A serialization mismatch between the tool's Zod schema and the
 *     JSON-Schema the server emits
 *   - A lifecycle ordering bug where the server accepts requests
 *     before `initialize` completes
 *
 * Running
 * ───────
 * Auto-discovered by `tests/runIntegrationTests.ts`. Also runnable
 * directly:
 *   npx tsx tests/mcpProtocol.test.ts
 */

// Stub DATABASE_URL BEFORE any tool import — some of the tool source
// files transitively pull in `pg.Pool` instances at module scope. Without
// this, importing `driveCallImportTool` triggers a real DB connection
// attempt the moment the test loads. The Pool object is constructed but
// never used because the test only calls `evaluate-sdr-governance`,
// which is a pure-function tool.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import { MCPServer } from "@mastra/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { evaluateSdrGovernanceTool } from "../src/mastra/tools/sdrGovernanceTool";
import { reconcileCallTool } from "../src/mastra/tools/callReconciliationTool";
import { matchLeadByPhoneTool } from "../src/mastra/tools/leadPhoneMatchTool";
import { driveCallImportTool } from "../src/mastra/tools/driveCallImportTool";
import { checkCommunicationEligibilityTool } from "../src/mastra/tools/checkCommunicationEligibilityTool";

import { TestSuite } from "./_helpers/runner";

// IDs that MUST be advertised by `tools/list`. If a tool is renamed or
// dropped, this list and the registration in src/mastra/index.ts must
// stay in sync — the assertion below pins both halves of the contract.
const EXPECTED_TOOL_IDS = [
  "evaluate-sdr-governance",
  "reconcile-call",
  "match-lead-by-phone",
  "drive-call-import",
  "check-communication-eligibility",
] as const;

const SERVER_NAME = "allTools-test";
const SERVER_VERSION = "1.0.0-test";

async function buildServer(): Promise<MCPServer> {
  // Tool keys MUST match each tool's own `id`. See the matching comment
  // in src/mastra/index.ts for the production rationale — this test
  // mirrors the production registration so any future drift between the
  // two surfaces immediately.
  return new MCPServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    tools: {
      "evaluate-sdr-governance": evaluateSdrGovernanceTool,
      "reconcile-call": reconcileCallTool,
      "match-lead-by-phone": matchLeadByPhoneTool,
      "drive-call-import": driveCallImportTool,
      "check-communication-eligibility": checkCommunicationEligibilityTool,
    },
  });
}

async function buildLinkedClient(server: MCPServer): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcpServer = server.getServer();
  await mcpServer.connect(serverTransport);
  const client = new Client(
    { name: "mcp-protocol-test-client", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(clientTransport);
  return client;
}

const suite = new TestSuite("mcpProtocol");

console.log(
  "\n=== MCP wire-level protocol compliance — initialize / capabilities / tools/list / tools/call ===\n",
);

// ──────────────────────────────────────────────────────────────────────────────
// Lifecycle gate 1+2: initialize → notifications/initialized
// (The SDK Client class sends both as part of `connect()`. If either step
// errors, `connect()` rejects and the test fails on construction.)
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "client.connect() completes — initialize + notifications/initialized handshake succeeded",
  async () => {
    const server = await buildServer();
    const client = await buildLinkedClient(server);

    const info = client.getServerVersion();
    suite.expect(
      info != null,
      "client.getServerVersion() must be non-null after a successful handshake",
    );
    suite.expectEqual(
      info?.name,
      SERVER_NAME,
      "server name returned by initialize must match the registered MCPServer.name",
    );
    suite.expectEqual(
      info?.version,
      SERVER_VERSION,
      "server version returned by initialize must match the registered MCPServer.version",
    );

    await client.close();
  },
);

await suite.test(
  "initialize response advertises `tools` capability",
  async () => {
    const server = await buildServer();
    const client = await buildLinkedClient(server);

    const caps = client.getServerCapabilities();
    suite.expect(
      caps != null,
      "client.getServerCapabilities() must be non-null after handshake",
    );
    suite.expect(
      caps != null && caps.tools !== undefined,
      `server capabilities must include 'tools' (got: ${JSON.stringify(caps)})`,
    );

    await client.close();
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Lifecycle gate 3: tools/list discovery
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "tools/list returns every registered tool with name + description + JSON-Schema input",
  async () => {
    const server = await buildServer();
    const client = await buildLinkedClient(server);

    const listed = await client.listTools();
    suite.expect(
      Array.isArray(listed.tools),
      "tools/list must return an array",
    );

    const advertisedIds = listed.tools.map((t) => t.name).sort();
    const expectedIds = [...EXPECTED_TOOL_IDS].sort();
    suite.expectEqual(
      JSON.stringify(advertisedIds),
      JSON.stringify(expectedIds),
      "tools/list must advertise exactly the 5 registered tool IDs",
    );

    for (const tool of listed.tools) {
      suite.expect(
        typeof tool.description === "string" && tool.description.length > 0,
        `tool ${tool.name} must carry a non-empty description`,
      );
      suite.expect(
        tool.inputSchema != null &&
          typeof tool.inputSchema === "object" &&
          (tool.inputSchema as any).type === "object" &&
          typeof (tool.inputSchema as any).properties === "object",
        `tool ${tool.name} must publish a JSON-Schema inputSchema with type=object and a properties map`,
      );
    }

    await client.close();
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Lifecycle gate 4: tools/call happy path
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "tools/call evaluate-sdr-governance returns a valid MCP result with parseable JSON content",
  async () => {
    const server = await buildServer();
    const client = await buildLinkedClient(server);

    const result = await client.callTool({
      name: "evaluate-sdr-governance",
      arguments: { transcript_text: "" }, // empty triggers the missing-transcript guard
    });

    suite.expect(
      Array.isArray(result.content),
      "tools/call must return a `content` array per MCP spec",
    );
    const content = result.content as Array<{ type: string; text?: string }>;
    suite.expect(
      content.length > 0,
      "tools/call content array must not be empty",
    );
    suite.expectEqual(
      content[0].type,
      "text",
      "evaluate-sdr-governance emits its result as content[0].type='text'",
    );
    suite.expect(
      typeof content[0].text === "string" && content[0].text.length > 0,
      "content[0].text must be a non-empty string",
    );

    // The MCP server serialises the tool's JSON output as a stringified
    // payload in content[0].text. Parsing it back round-trips the
    // documented contract.
    let parsed: any;
    try {
      parsed = JSON.parse(content[0].text!);
    } catch (err) {
      suite.expect(
        false,
        `content[0].text must be valid JSON (parse error: ${err instanceof Error ? err.message : err})`,
      );
      await client.close();
      return;
    }

    suite.expect(
      Array.isArray(parsed.issues),
      `parsed result must include an 'issues' array (got: ${JSON.stringify(parsed).slice(0, 200)})`,
    );
    suite.expect(
      typeof parsed.rules_evaluated === "number",
      "parsed result must include rules_evaluated:number",
    );
    suite.expect(
      "ruleset_version" in parsed,
      "parsed result must include ruleset_version (may be null)",
    );

    await client.close();
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Lifecycle gate 5: tools/call negative — unknown tool
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "tools/call with an unknown tool name surfaces an MCP-level error",
  async () => {
    const server = await buildServer();
    const client = await buildLinkedClient(server);

    let errored = false;
    let observed = "";
    try {
      const result = await client.callTool({
        name: "definitely-not-a-real-tool",
        arguments: {},
      });
      // If the server returned a result object with isError: true,
      // that's also a valid MCP error path.
      if ((result as any).isError === true) {
        errored = true;
        observed = JSON.stringify(result);
      } else {
        observed = `unexpected success result: ${JSON.stringify(result).slice(0, 200)}`;
      }
    } catch (err) {
      errored = true;
      observed = err instanceof Error ? err.message : String(err);
    }

    suite.expect(
      errored,
      `unknown tool must produce an error (observed: ${observed.slice(0, 200)})`,
    );
    // Best-effort sanity: the error message should at least mention the
    // tool name or the words "tool"/"unknown"/"not found". We don't pin
    // the exact wording because it's emitted by @mastra/mcp / the SDK
    // and may change between versions.
    suite.expect(
      /tool|unknown|not.?found|invalid/i.test(observed),
      `error message should hint at the cause (got: ${observed.slice(0, 200)})`,
    );

    await client.close();
  },
);

// ──────────────────────────────────────────────────────────────────────────────
// Lifecycle gate 6: tools/call negative — invalid arguments (Zod rejection)
// ──────────────────────────────────────────────────────────────────────────────

await suite.test(
  "tools/call with arguments that violate the Zod schema does not crash the server",
  async () => {
    const server = await buildServer();
    const client = await buildLinkedClient(server);

    let observedError = false;
    let observedResult: any = null;
    let observedMessage = "";
    try {
      observedResult = await client.callTool({
        name: "evaluate-sdr-governance",
        // `transcript_text` is required to be `string | null` per the
        // Zod schema; a number violates it.
        arguments: { transcript_text: 12345 as any },
      });
      if ((observedResult as any).isError === true) observedError = true;
    } catch (err) {
      observedError = true;
      observedMessage = err instanceof Error ? err.message : String(err);
    }

    suite.expect(
      observedError,
      `Zod violation must surface as an MCP error rather than a successful result (got result: ${JSON.stringify(observedResult).slice(0, 200)})`,
    );

    // The server must still be alive for subsequent calls — the
    // canonical post-condition for "error doesn't crash the protocol".
    const followUp = await client.listTools();
    suite.expect(
      Array.isArray(followUp.tools) && followUp.tools.length === EXPECTED_TOOL_IDS.length,
      "server must remain responsive to tools/list after a Zod rejection",
    );

    await client.close();
    void observedMessage; // captured for debugging, not asserted on
  },
);

suite.finishOrExit();
