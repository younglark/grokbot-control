#!/usr/bin/env node
/**
 * MCP stdio server. stdout is reserved for MCP JSON-RPC frames only.
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildPlane } from "../cli/config.js";
import { failResult } from "../dto/result.js";
import { buildTools, toolAnnotations } from "./tools.js";

const { version: packageVersion } = createRequire(import.meta.url)(
  "../../package.json",
) as { version: string };

const envelopeSchema = z
  .object({
    schema_version: z.string(),
    ok: z.boolean(),
    outcome: z.string(),
    code: z.string(),
    retryable: z.boolean(),
    request_id: z.string(),
    data: z.unknown().optional(),
    error: z
      .object({
        message: z.string(),
        hint: z.string().optional(),
        details: z.unknown().optional(),
      })
      .optional(),
    simulated: z.boolean().optional(),
  })
  .passthrough();

function installToolErrorEnvelope(server: McpServer): void {
  const s = server as unknown as {
    createToolError: (message: string) => unknown;
  };
  s.createToolError = (errorMessage: string) => {
    const usage = /Input validation error/.test(errorMessage);
    const unknown = /Tool .+ not found/.test(errorMessage);
    const hint = usage
      ? "Check required arguments and types; extra properties are rejected. See the tool inputSchema from tools/list."
      : unknown
        ? "Call tools/list and use an exact tool name. Write tools appear only when gbc-mcp is started with GBT_ALLOW_WRITES=1 or --allow-writes."
        : undefined;
    const env = failResult(usage ? "usage" : unknown ? "not_found" : "error", errorMessage, {
      hint,
    });
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(env) }],
      structuredContent: env as unknown as Record<string, unknown>,
    };
  };
}

function blockStdout(): void {
  const block = (...args: unknown[]) => {
    console.error("[gbc-mcp stdout-blocked]", ...args);
  };
  console.log = block;
  console.info = block;
  console.debug = block;
  console.dir = block as typeof console.dir;
}

async function main() {
  const readOnly = process.env.GBT_MCP_READONLY === "1";
  if (process.argv.includes("--allow-writes")) {
    process.env.GBT_ALLOW_WRITES = "1";
  }
  const allowWrites = !readOnly && process.env.GBT_ALLOW_WRITES === "1";
  const mock = process.env.GBT_MOCK === "1" || process.argv.includes("--mock");
  const plane = buildPlane({
    json: true,
    plain: false,
    allowWrites,
    dryRun: false,
    baseUrl: process.env.GBT_BASE_URL || "https://api2.cursor.sh",
    authKind: (process.env.GBT_AUTH_KIND as "cursor" | "xai") || "cursor",
    mock,
    trustBackend: process.env.GBT_TRUST_BACKEND === "1",
  });

  const server = new McpServer({
    name: "grokbot-control",
    version: packageVersion,
  });
  installToolErrorEnvelope(server);

  const tools = buildTools({
    readOnly,
    allowWrites,
    sync: process.env.GBT_SYNC_ROOT
      ? {
          root: process.env.GBT_SYNC_ROOT,
          allowLocalWrites: process.env.GBT_SYNC_ALLOW_LOCAL_WRITES === "1",
          accountId: process.env.GBT_SYNC_ACCOUNT_ID,
          teamId: process.env.GBT_SYNC_TEAM_ID,
          acknowledgeUnverifiedScope:
            process.env.GBT_SYNC_ACK_UNVERIFIED_SCOPE === "1",
        }
      : undefined,
  });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        title: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        outputSchema: envelopeSchema,
        annotations: toolAnnotations(t),
      },
      async (args: Record<string, unknown>) => {
        const parsed = t.inputSchema.safeParse(args);
        if (!parsed.success) {
          const env = failResult("usage", "invalid tool arguments", {
            hint: "Check required arguments and types; extra properties are rejected.",
            details: parsed.error.format(),
          });
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(env) }],
            structuredContent: env as unknown as Record<string, unknown>,
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

  blockStdout();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
