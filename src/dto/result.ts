/** Stable CLI/MCP envelope. schema_version only increases; fields only add. */
export const SCHEMA_VERSION = "1.0.0" as const;

export type Outcome = "known_success" | "known_failure" | "unknown";

export type ResultEnvelope<T = unknown> = {
  schema_version: typeof SCHEMA_VERSION;
  ok: boolean;
  outcome: Outcome;
  code: string;
  retryable: boolean;
  request_id: string;
  data?: T;
  error?: { message: string; hint?: string; details?: unknown };
  /** When true, response came from explicit mock/sim transport — never claim live. */
  simulated?: boolean;
};

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function okResult<T>(
  data: T,
  opts?: { request_id?: string; simulated?: boolean; code?: string },
): ResultEnvelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    outcome: "known_success",
    code: opts?.code ?? "ok",
    retryable: false,
    request_id: opts?.request_id ?? newRequestId(),
    data,
    simulated: opts?.simulated,
  };
}

export function failResult(
  code: string,
  message: string,
  opts?: {
    outcome?: Outcome;
    retryable?: boolean;
    hint?: string;
    request_id?: string;
    details?: unknown;
    simulated?: boolean;
  },
): ResultEnvelope<never> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    outcome: opts?.outcome ?? "known_failure",
    code,
    retryable: opts?.retryable ?? false,
    request_id: opts?.request_id ?? newRequestId(),
    error: { message, hint: opts?.hint, details: opts?.details },
    simulated: opts?.simulated,
  };
}
