/**
 * Cross-process CLI auth flow against a LOCAL fake backend (127.0.0.1, trusted via
 * GBT_TRUST_BACKEND=1). Offline: never contacts cursor.com / api2. Not live proof.
 */
import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { GrokBotService } from "#proto-gen/GrokBotService";
import { jwt } from "./jwt-helper.js";

const CLI = path.resolve("dist/cli/main.js");
const ACCESS = jwt(Math.floor(Date.now() / 1000) + 3600);
const REFRESH = "REFRESH-SECRET-xyz";

let server: http.Server;
let base = "";
let pollsUntilReady = 2;
const seenVerifiers: string[] = [];
const seenAuth: string[] = [];

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const e: Record<string, string | undefined> = { ...process.env, ...env };
    delete e.GBT_MOCK;
    delete e.GBT_ALLOW_WRITES;
    delete e.GBT_OAUTH_CLIENT_ID;
    const c = spawn(process.execPath, [CLI, "--json", ...args], { env: e as NodeJS.ProcessEnv });
    let out = "";
    let err = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => resolve({ code, out, err }));
  });
}

before(async () => {
  const connect = connectNodeAdapter({
    routes: (router) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router.service(GrokBotService as any, {
        listGrokBotAgents: (_req: unknown, ctx: { requestHeader: Headers }) => {
          seenAuth.push(ctx.requestHeader.get("authorization") ?? "");
          return { agents: [{ id: "i1", agentId: "a1", name: "bot" }], truncated: false };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
  });
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/auth/poll" && req.method === "GET") {
      seenVerifiers.push(u.searchParams.get("verifier") ?? "");
      if (pollsUntilReady-- > 0) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accessToken: ACCESS, refreshToken: REFRESH }));
      return;
    }
    connect(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

describe("CLI cross-process auth (local fake backend)", () => {
  it("login-begin (proc 1) -> complete (proc 2) -> bot list (proc 3) with Bearer; no secrets printed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-cli-auth-"));
    const env = { GBT_CREDENTIALS_DIR: dir, GBT_TRUST_BACKEND: "1", GBT_WEBSITE_URL: "http://127.0.0.1:9", GBT_BASE_URL: base };
    pollsUntilReady = 2;
    const b = await run(["auth", "login-begin"], env);
    assert.equal(b.code, 0, b.err);
    const url = new URL(JSON.parse(b.out).data.authorization_url);
    assert.equal(url.pathname, "/loginDeepControl");
    const files = fs.readdirSync(dir);
    const pf = files.find((f) => f.startsWith("pending-"))!;
    assert.equal(fs.statSync(path.join(dir, pf)).mode & 0o777, 0o600);
    const verifier = JSON.parse(fs.readFileSync(path.join(dir, pf), "utf8")).verifier as string;

    const c = await run(["auth", "complete", "--timeout", "30"], env);
    assert.equal(c.code, 0, c.err);
    assert.equal(JSON.parse(c.out).data.status, "completed");
    assert.ok(seenVerifiers.includes(verifier));

    const l = await run(["bot", "list"], env);
    assert.equal(l.code, 0, l.err);
    assert.equal(JSON.parse(l.out).data.bots[0].agent_id, "a1");
    assert.equal(seenAuth.at(-1), `Bearer ${ACCESS}`);
    assert.equal(JSON.parse(l.out).simulated, undefined);

    const w = await run(["auth", "whoami"], env);
    assert.equal(JSON.parse(w.out).data.has_token, true);
    for (const r of [b, c, l, w]) {
      for (const s of [verifier, ACCESS, REFRESH]) {
        assert.ok(!r.out.includes(s) && !r.err.includes(s), "secret leaked");
      }
    }
    const lo = await run(["auth", "logout"], env);
    assert.equal(JSON.parse(lo.out).data.removed_credential, true);
    const after = await run(["bot", "list"], env);
    assert.equal(after.code, 4, after.err);
  });

  it("auth login: URL on stderr, result only on stdout; complete timeout -> exit 8 auth_pending", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-cli-auth-"));
    const env = { GBT_CREDENTIALS_DIR: dir, GBT_TRUST_BACKEND: "1", GBT_WEBSITE_URL: "http://127.0.0.1:9", GBT_BASE_URL: base };
    pollsUntilReady = 0;
    const r = await run(["auth", "login", "--timeout", "10"], env);
    assert.equal(r.code, 0, r.err);
    assert.match(r.err, /"event":"open_browser"/);
    assert.ok(!r.out.includes("loginDeepControl"));
    assert.equal(JSON.parse(r.out).data.status, "completed");

    pollsUntilReady = 1000;
    await run(["auth", "login-begin"], env);
    const t = await run(["auth", "complete", "--timeout", "1"], env);
    assert.equal(t.code, 8, t.err);
    assert.match(t.err, /auth_pending/);
    const bad = await run(["auth", "complete", "--timeout", "abc"], env);
    assert.equal(bad.code, 2);
  });

  it("--mock refuses login (no accidental simulated auth); GBT_TRUST_BACKEND=0 refuses local backend", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-cli-auth-"));
    const m = await run(["--mock", "auth", "login-begin"], { GBT_CREDENTIALS_DIR: dir, GBT_MOCK_STATE: path.join(dir, "m.json") });
    assert.equal(m.code, 9);
    const u = await run(["auth", "login-begin"], { GBT_CREDENTIALS_DIR: dir, GBT_TRUST_BACKEND: "0", GBT_BASE_URL: base });
    assert.equal(u.code, 7);
  });
});
