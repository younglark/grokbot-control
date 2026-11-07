import { SyncOps } from "../sync/core.js";
import { buildPlane, flag, hasFlag, type CliGlobal } from "./config.js";
import { GbcError } from "../errors.js";
import type { ResultEnvelope } from "../dto/result.js";

/** Sync opts are deliberately strict; an unknown selector must not broaden a pull. */
export async function syncCommand(
  globals: CliGlobal,
  rest: string[],
): Promise<ResultEnvelope> {
  const verb = rest[1];
  if (!["pull", "status", "render", "attachments"].includes(verb))
    throw new GbcError("usage", "sync pull|status|render|attachments required");
  const values = new Set([
    "--dir",
    "--agent-id",
    "--session-id",
    ...(verb === "pull"
      ? [
          "--account-id",
          "--team-id",
          "--max-pages",
          "--max-bytes",
          "--timeout-ms",
        ]
      : []),
    ...(verb === "attachments"
      ? ["--path", "--max-bytes", "--max-file-bytes", "--timeout-ms"]
      : []),
  ]);
  const switches = new Set(verb === "pull" ? ["--ack-unverified-scope"] : []);
  const seen = new Set<string>();
  for (let j = 2; j < rest.length; j++) {
    const k = rest[j].split("=")[0];
    if (seen.has(k) || (!values.has(k) && !switches.has(k)))
      throw new GbcError(
        "usage",
        "unknown/duplicate sync flag (v1 requires one --agent-id; --all not supported)",
      );
    seen.add(k);
    if (values.has(k)) {
      flag(rest, k);
      if (!rest[j].includes("=")) j++;
    } else if (rest[j].includes("="))
      throw new GbcError(
        "usage",
        "acknowledgement is a switch, not a value flag",
      );
  }
  const dir = flag(rest, "--dir"),
    agentId = flag(rest, "--agent-id"),
    sessionId = flag(rest, "--session-id");
  if (!dir)
    throw new GbcError("usage", "sync requires --dir <absolute private root>");
  const local = new SyncOps(
    {},
    globals.mock ? "mock://gbc" : globals.baseUrl,
    globals.mock,
  );
  if (verb === "status") return local.status({ dir, agentId, sessionId });
  if (verb === "render")
    return local.render({ dir, agentId, sessionId, dryRun: globals.dryRun });
  function number(name: string): number | undefined {
    const v = flag(rest, name);
    if (v === undefined) return;
    if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v)))
      throw new GbcError("usage", `${name} requires an integer`);
    return Number(v);
  }
  if (verb === "attachments") {
    const input = {
      dir,
      agentId,
      sessionId,
      path: flag(rest, "--path"),
      dryRun: globals.dryRun,
      maxBytes: number("--max-bytes"),
      maxFileBytes: number("--max-file-bytes"),
      timeoutMs: number("--timeout-ms"),
    };
    return (globals.dryRun ? local : buildPlane(globals).sync).attachments(
      input,
    );
  }
  if (!agentId) throw new GbcError("usage", "sync pull requires --agent-id");
  const input = {
    dir,
    agentId,
    sessionId,
    accountId: flag(rest, "--account-id") ?? "",
    teamId: flag(rest, "--team-id") ?? "",
    acknowledgeUnverifiedScope: hasFlag(rest, "--ack-unverified-scope"),
    dryRun: globals.dryRun,
    maxPages: number("--max-pages"),
    maxBytes: number("--max-bytes"),
    timeoutMs: number("--timeout-ms"),
  };
  return (globals.dryRun ? local : buildPlane(globals).sync).pull(input);
}
