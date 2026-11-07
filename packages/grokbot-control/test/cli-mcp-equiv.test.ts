import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTools } from "../src/mcp/tools.js";
import { ControlPlane } from "../src/ops/plane.js";
import { createEmptyMockState, createMockTransport } from "../src/testing/mock-transport.js";
import { staticTokenProvider } from "../src/auth/provider.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runGbc(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", path.join(root, "src/cli/main.ts"), ...args], {
      env: { ...process.env, GBT_MOCK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

describe("CLI process (no TTY)", () => {
  it("bot create --json exits 0 and prints envelope", async () => {
    const r = await runGbc(["--mock", "--json", "--allow-writes", "bot", "create", "--name", "cli-bot", "--description", "d"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.simulated, true);
    assert.ok(j.data.agent_id);
  });

  it("missing args exits 2 usage on stderr JSON", async () => {
    const r = await runGbc(["--mock", "--json", "bot", "create"]);
    assert.equal(r.code, 2);
    const j = JSON.parse(r.stderr);
    assert.equal(j.code, "usage");
  });
});

describe("CLI/MCP parameter equivalence", () => {
  it("create_bot tool matches bot.create SDK", async () => {
    const state = createEmptyMockState();
    const plane = new ControlPlane({
      baseUrl: "mock://",
      transport: createMockTransport(state),
      simulated: true,
      auth: staticTokenProvider({ kind: "cursor", backend: "https://api2.cursor.sh", accessToken: "t" }),
    });
    const tools = buildTools();
    const create = tools.find((t) => t.name === "create_bot")!;
    const viaMcp = await create.handler(plane, {
      name: "m",
      description: "d",
      allow_writes: true,
    });
    assert.equal(viaMcp.ok, true);
    const viaSdk = await plane.bot.get(viaMcp.data!.agent_id);
    assert.equal(viaSdk.ok, true);
  });
});
