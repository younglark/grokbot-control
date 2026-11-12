/**
 * Local `gbc dashboard` CLI tests. Offline / --mock only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHost, parsePort, isLoopbackHost } from "../src/localdash/bind.js";
import { canDrawUsageBar, formatUsagePercent, formatUsagePpm, presentComputer, stateLabel } from "../src/localdash/view.js";
import { mapUsageStatus } from "../src/ops/usage.js";
import { usageFixtureResponse } from "../src/testing/mock-transport.js";
import { GbcError } from "../src/errors.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliSrc = path.join(root, "src/cli/main.ts");
const cliDist = path.join(root, "dist/cli/main.js");

function tmpEnv(extra: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gbc-dash-"));
  return {
    dir,
    env: {
      ...process.env,
      GBT_MOCK: "1",
      GBT_CREDENTIALS_DIR: dir,
      GBT_MOCK_STATE: path.join(dir, "mock-state.json"),
      ...extra,
    } as NodeJS.ProcessEnv,
  };
}

function run(args: string[], env?: NodeJS.ProcessEnv, timeoutMs = 8_000) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", cliSrc, ...args], {
      env: env ?? tmpEnv().env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function start(args: string[], env?: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", cliSrc, ...args], {
    env: env ?? tmpEnv().env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return {
    child,
    output: () => ({ stdout, stderr }),
    waitStdout(pred: (s: string) => boolean, ms = 8_000) {
      return new Promise<string>((resolve, reject) => {
        const startAt = Date.now();
        const tick = () => {
          if (pred(stdout)) return resolve(stdout);
          if (Date.now() - startAt > ms) return reject(new Error(`timeout waiting for stdout: ${stdout}\n${stderr}`));
          setTimeout(tick, 50);
        };
        child.stdout.on("data", tick);
        tick();
      });
    },
    stop(sig: NodeJS.Signals = "SIGTERM") {
      return new Promise<number>((resolve) => {
        child.on("close", (code) => resolve(code ?? 1));
        child.kill(sig);
      });
    },
  };
}

describe("dashboard command flags and special-case parsing", () => {
  it("gbc dashboard and gbc dashboard start are accepted with --json --no-open", async () => {
    for (const args of [
      ["--mock", "--json", "dashboard", "--port", "0", "--no-open"],
      ["--mock", "--json", "dashboard", "start", "--port", "0", "--no-open"],
    ]) {
      const proc = start(args);
      try {
        const out = await proc.waitStdout((s) => s.includes('"url"'));
        const env = JSON.parse(out.trim().split("\n")[0]!);
        assert.equal(env.ok, true, out);
        assert.equal(env.schema_version, "1.0.0");
        assert.match(env.data.url, /^http:\/\/127\.0\.0\.1:\d+\/s\/[^/]+\/$/);
        assert.equal(env.data.bind.host, "127.0.0.1");
        assert.equal(typeof env.data.bind.port, "number");
        assert.equal(env.data.opened, false);
      } finally {
        assert.equal(await proc.stop(), 0);
      }
    }
  });

  it("--plain prints only the URL", async () => {
    const proc = start(["--mock", "--plain", "dashboard", "--port", "0", "--no-open"]);
    try {
      const out = await proc.waitStdout((s) => s.includes("http://"));
      const line = out.trim().split("\n")[0]!;
      assert.match(line, /^http:\/\/127\.0\.0\.1:\d+\/s\/[^/]+\/$/);
      assert.ok(!line.includes("schema_version"));
      assert.ok(!line.includes("{"));
    } finally {
      assert.equal(await proc.stop(), 0);
    }
  });

  it("missing other nouns still fail", async () => {
    const r = await run(["--mock", "--json", "not-a-noun"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing <noun> <verb>/);
  });

  it("unknown dashboard verb fails", async () => {
    const r = await run(["--mock", "--json", "dashboard", "watch"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command: dashboard watch/);
  });

  it("--port/--host/--no-open are command flags, not globals", async () => {
    const r = await run(["--mock", "--json", "--port", "0", "bot", "list"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown flag: --port/);
    const r2 = await run(["--mock", "--json", "bot", "list", "--no-open"]);
    assert.equal(r2.code, 2);
    assert.match(r2.stderr, /unknown flag: --no-open/);
  });

  it("v1 rejects a non-loopback --host", async () => {
    const r = await run(["--mock", "--json", "dashboard", "--host", "0.0.0.0", "--port", "0", "--no-open"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /non-loopback/);
    const r2 = await run(["--mock", "--json", "dashboard", "--host", "192.168.1.5", "--no-open"]);
    assert.equal(r2.code, 2);
  });

  it("--json prints one envelope then stays up; SIGTERM exits 0", async () => {
    const proc = start(["--mock", "--json", "dashboard", "--port", "0", "--no-open"]);
    try {
      const out1 = await proc.waitStdout((s) => s.includes('"url"'));
      const first = out1.trim();
      assert.equal(first.split("\n").filter((l) => l.includes("schema_version")).length, 1);
      await new Promise((r) => setTimeout(r, 400));
      const later = proc.output().stdout.trim();
      assert.equal(later, first, "must not heartbeat to stdout");
    } finally {
      assert.equal(await proc.stop("SIGTERM"), 0);
    }
  });
});

describe("bind helpers", () => {
  it("parseHost allows loopback only", () => {
    assert.equal(parseHost(undefined), "127.0.0.1");
    assert.equal(parseHost("localhost"), "localhost");
    assert.equal(parseHost("::1"), "::1");
    assert.equal(isLoopbackHost("127.0.0.9"), true);
    assert.throws(() => parseHost("10.0.0.1"), (e: unknown) => e instanceof GbcError && e.exitCode === 2);
  });

  it("parsePort allows 0", () => {
    assert.equal(parsePort("0"), 0);
    assert.equal(parsePort("8787"), 8787);
    assert.throws(() => parsePort("nope"), (e: unknown) => e instanceof GbcError);
  });
});

describe("usage and computer presentation", () => {
  it("does not invent usage numbers and will not draw a bar when the included limit is zero", () => {
    const unlimited = mapUsageStatus(usageFixtureResponse("unlimited"));
    assert.equal(unlimited.usage_percent, undefined);
    assert.equal(unlimited.included_limit_zero, true);
    assert.equal(canDrawUsageBar(unlimited), false);
    const near = mapUsageStatus(usageFixtureResponse("near_exhausted"));
    assert.equal(near.usage_percent, 92);
    assert.equal(near.usage_percent_unit, "percent");
    assert.equal(formatUsagePercent(near.usage_percent!), "92%");
    assert.equal(formatUsagePercent(21.781372), "21.78%");
    assert.equal(formatUsagePercent(21.7), "21.7%");
    assert.equal(formatUsagePercent(0.21781372), "0.22%"); // already a percentage; do not * 100
    assert.equal(formatUsagePpm(225439), "22.54%");
    assert.equal(formatUsagePpm(100000), "10%");
    assert.notEqual(formatUsagePpm(225439), "225439%");
    assert.doesNotMatch(near.notes.join("\n"), /usage_percent.*单位尚未/);
    assert.equal(canDrawUsageBar(near), true);
    const enterprise = mapUsageStatus(usageFixtureResponse("enterprise_shared"));
    assert.equal(enterprise.uses_pooled_enterprise_allowance, true);
    assert.ok(enterprise.notes.some((n) => /ppm/i.test(n)));
  });

  it("never treats unknown or stale computer state as green running", () => {
    const missing = presentComputer(undefined, { failed: true });
    assert.equal(missing.tone, "unknown");
    assert.equal(missing.label, "未知");
    assert.notEqual(missing.tone, "running");
    assert.match(missing.note, /不会显示为「运行中」/);
    const stale = presentComputer(
      { state: "running", state_code: 3 },
      { stale: true },
    );
    assert.equal(stale.tone, "unknown");
    assert.equal(stale.label, "未知");
    assert.match(stale.note, /上次记录/);
    const live = presentComputer({ state: "running", state_code: 3 });
    assert.equal(live.tone, "running");
    assert.equal(stateLabel("running"), "运行中（未实时核验）");
    assert.equal(live.live_verified, false);
  });

  it("does not invent or concatenate a billing URL", () => {
    const withUrl = mapUsageStatus({
      ...usageFixtureResponse("normal"),
      unifiedBillingUrl: "https://example.test/billing",
    });
    assert.equal(withUrl.unified_billing_url, "https://example.test/billing");
    const none = mapUsageStatus(usageFixtureResponse("normal"));
    assert.equal(none.unified_billing_url, undefined);
    const junk = mapUsageStatus({ ...usageFixtureResponse("normal"), unifiedBillingUrl: "javascript:alert(1)" });
    assert.equal(junk.unified_billing_url, undefined);
  });
});

describe("built CLI binary (dist/cli/main.js)", () => {
  it("gbc dashboard --json works from the packed CLI", async () => {
    if (!fs.existsSync(cliDist)) {
      assert.fail("dist/cli/main.js missing; rebuild with npm run build -w grokbot-control");
    }
    const { env } = tmpEnv();
    const child = spawn(process.execPath, [cliDist, "--mock", "--json", "dashboard", "--port", "0", "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const started = await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`dist CLI timeout: ${stdout}\n${stderr}`)), 8_000);
      child.stdout.on("data", () => {
        if (stdout.includes('"url"')) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    void started;
    const envl = JSON.parse(stdout.trim().split("\n")[0]!);
    assert.equal(envl.ok, true);
    assert.match(envl.data.url, /\/s\/[^/]+\//);
    const code = await new Promise<number>((resolve) => {
      child.on("close", (c) => resolve(c ?? 1));
      child.kill("SIGTERM");
    });
    assert.equal(code, 0);
  });
});
