import { EXIT, GbcError, mapExitCode } from "../errors.js";
import type { ResultEnvelope } from "../dto/result.js";

export function writeOut(data: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify(data) + "\n");
  } else if (typeof data === "string") {
    process.stdout.write(data + (data.endsWith("\n") ? "" : "\n"));
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  }
}

export function writeErrJson(data: unknown): void {
  process.stderr.write(JSON.stringify(data) + "\n");
}

export function emitResult(r: ResultEnvelope, asJson: boolean): number {
  if (r.ok) {
    writeOut(asJson ? r : r.data ?? r, asJson || true);
    // Always machine-friendly for agents: default JSON on stdout for structured data.
    return EXIT.SUCCESS;
  }
  writeErrJson(r);
  return mapExitCode(r.code, r.outcome, r.retryable);
}

export function usageExit(message: string, hint?: string): never {
  writeErrJson({
    schema_version: "1.0.0",
    ok: false,
    outcome: "known_failure",
    code: "usage",
    retryable: false,
    request_id: crypto.randomUUID(),
    error: { message, hint },
  });
  process.exit(EXIT.USAGE);
}

export function catchToExit(e: unknown, asJson: boolean): number {
  if (e instanceof GbcError) {
    const r = {
      schema_version: "1.0.0",
      ok: false,
      outcome: e.outcome,
      code: e.code,
      retryable: e.retryable,
      request_id: crypto.randomUUID(),
      error: { message: e.message, hint: e.hint, details: e.details },
    };
    writeErrJson(r);
    return e.exitCode;
  }
  writeErrJson({
    schema_version: "1.0.0",
    ok: false,
    outcome: "known_failure",
    code: "error",
    retryable: false,
    request_id: crypto.randomUUID(),
    error: { message: String(e) },
  });
  return EXIT.ERROR;
}
