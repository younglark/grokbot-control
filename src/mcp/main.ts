#!/usr/bin/env node
/**
 * MCP stdio server. stdout is reserved for MCP JSON-RPC frames only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildPlane } from "../cli/config.js";
import { buildTools } from "./tools.js";

async function main() {
  const readOnly = process.env.GBT_MCP_READONLY === "1";
  const mock = process.env.GBT_MOCK === "1" || process.argv.includes("--mock");
  const plane = buildPlane({
    json: true,
    allowWrites: process.env.GBT_ALLOW_WRITES === "1",
    dryRun: false,
    baseUrl: process.env.GBT_BASE_URL || "https://api2.cursor.sh",
    authKind: (process.env.GBT_AUTH_KIND as "cursor" | "xai") || "cursor",
    mock,
    trustBackend: process.env.GBT_TRUST_BACKEND === "1",
  });

  const server = new McpServer({
    name: "grokbot-control",
    version: "0.1.0",
  });

  const tools = buildTools({ readOnly });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.name,
        description: t.description,
        inputSchema: t.inputSchema.shape,
        annotations: t.authTool
          ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
          : t.readOnly
          ? { readOnlyHint: true, openWorldHint: true }
          : { readOnlyHint: false, destructiveHint: t.name.includes("delete"), openWorldHint: true },
      },
      async (args: Record<string, unknown>) => {
        const parsed = t.inputSchema.safeParse(args);
        if (!parsed.success) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ code: "usage", error: parsed.error.format() }),
              },
            ],
            structuredContent: {
              schema_version: "1.0.0",
              ok: false,
              outcome: "known_failure",
              code: "usage",
              retryable: false,
              request_id: crypto.randomUUID(),
              error: { message: "invalid tool arguments", details: parsed.error.format() },
            },
          };
        }
        // Tool cancellation ≠ InterruptGrokBotAgentRun
        const result = await t.handler(plane, parsed.data as Record<string, unknown>);
        return {
          isError: !result.ok,
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      },
    );
  }

  console.log = (...args: unknown[]) => {
    console.error("[gbc-mcp stdout-blocked]", ...args);
  };

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
