import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { Code, ConnectError } from "@connectrpc/connect";
import type { Interceptor, Transport, UnaryRequest } from "@connectrpc/connect";
import { GrokBotService } from "#proto-gen/GrokBotService";
import type { AuthProvider } from "../auth/types.js";
import { GbcError } from "../errors.js";

/**
 * Generated Connect client. Typed loosely because vendored JS ServiceType
 * lacks full TS generics; runtime methods match GrokBotService.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GrokBotClient = any;

export type ConnectConfig = {
  baseUrl: string;
  auth?: AuthProvider;
  transport?: Transport;
  /** Optional transport decoded-response cap (sync uses 16MiB). */
  readMaxBytes?: number;
};

/**
 * Project read-only unary RPCs eligible for at most one 401 refresh+retry.
 * Writes are never retried. Membership is by Connect method name (PascalCase),
 * never by HTTP verb alone.
 */
export const READ_ONLY_UNARY_METHODS = new Set([
  "ListGrokBotAgents",
  "ListGrokBotAgentStatuses",
  "GetGrokBotUserRuntimeSettings",
  "ListGrokBotAgentSessions",
  "GetGrokBotSendStatus",
  "ListGrokBotAgentTodos",
  "ListGrokBotAgentTasks",
  "ListGrokBotSubagents",
  "ListGrokBotTranscriptEntries",
  "ResolveGrokBotAttachmentReads",
  "PresignSandBoxStoreReads",
]);

function isUnauthenticated(err: unknown): boolean {
  if (err instanceof ConnectError) return err.code === Code.Unauthenticated;
  const anyErr = err as { code?: string | number; name?: string };
  const c = String(anyErr.code ?? "");
  return c === "unauthenticated" || c === "16" || c === String(Code.Unauthenticated);
}

function methodName(req: { method?: { name?: string } }): string {
  return req.method?.name ?? "";
}

function isReadOnlyUnary(req: { stream?: boolean; method?: { name?: string } }): boolean {
  if (req.stream) return false;
  return READ_ONLY_UNARY_METHODS.has(methodName(req));
}


function connectCodeFor(gbc: GbcError): Code {
  switch (gbc.code) {
    case "unauthenticated":
    case "auth":
    case "auth_revoked":
    case "auth_refresh_unconfigured":
    case "auth_refresh_client_mismatch":
      return Code.Unauthenticated;
    case "denied":
    case "permission_denied":
      return Code.PermissionDenied;
    case "auth_refresh_network":
    case "auth_refresh_timeout":
    case "auth_refresh_rate_limited":
    case "auth_refresh_cooldown":
    case "auth_refresh_lock_timeout":
      return Code.Unavailable;
    default:
      return gbc.retryable ? Code.Unavailable : Code.FailedPrecondition;
  }
}

/** Carry GbcError through Connect as `cause` so ops can restore structured codes. */
export function gbcAsConnect(gbc: GbcError): ConnectError {
  return new ConnectError(gbc.message, connectCodeFor(gbc), undefined, undefined, gbc);
}

export function unwrapGbcCause(err: unknown): GbcError | undefined {
  if (err instanceof GbcError) return err;
  if (err instanceof ConnectError && err.cause instanceof GbcError) return err.cause;
  const anyErr = err as { cause?: unknown };
  if (anyErr?.cause instanceof GbcError) return anyErr.cause;
  return undefined;
}

export function createAuthInterceptor(auth: AuthProvider): Interceptor {
  return (next) => async (req) => {
    let token: string | undefined;
    try {
      token = await auth.getAccessToken();
    } catch (e) {
      // Fail locally (request NOT sent). Wrap as ConnectError with GbcError cause so
      // mapConnectError can restore structured codes (Connect may not pass plain Error).
      const gbc =
        e instanceof GbcError
          ? new GbcError(e.code, e.message, {
              retryable: e.retryable,
              outcome: e.outcome,
              hint: e.hint,
              exitCode: e.exitCode,
              details: {
                ...((typeof e.details === "object" && e.details) || {}),
                rpc_dispatched: false,
              },
            })
          : new GbcError("unauthenticated", "credential load/refresh failed (request not sent)", {
              exitCode: 4,
              details: { rpc_dispatched: false },
            });
      throw gbcAsConnect(gbc);
    }
    if (!token) {
      throw gbcAsConnect(
        new GbcError("unauthenticated", "not logged in: run `gbc auth login` (request not sent)", {
          exitCode: 4,
          details: { rpc_dispatched: false },
        }),
      );
    }
    req.header.set("authorization", `Bearer ${token}`);

    try {
      return await next(req);
    } catch (err) {
      if (!isUnauthenticated(err)) throw err;

      // Closest to App Qz recovery: refresh credentials for the *next* request.
      // Never replay writes. Optional: one refresh+retry for whitelisted read-only unary.
      let refreshed = false;
      try {
        await auth.refresh({ force: true });
        refreshed = true;
      } catch {
        /* keep original 401; creds may be cleared on shouldLogout */
      }

      const allowRetry = refreshed && isReadOnlyUnary(req as UnaryRequest);
      if (!allowRetry) throw err;

      let token2: string | undefined;
      try {
        token2 = await auth.getAccessToken();
      } catch {
        throw err;
      }
      if (!token2 || token2 === token) throw err;
      req.header.set("authorization", `Bearer ${token2}`);
      return next(req);
    }
  };
}

export function createGrokBotClient(cfg: ConnectConfig): GrokBotClient {
  const interceptors: Interceptor[] = [];
  if (cfg.auth) interceptors.push(createAuthInterceptor(cfg.auth));
  const transport =
    cfg.transport ??
    createConnectTransport({
      baseUrl: cfg.baseUrl.replace(/\/$/, ""),
      httpVersion: "1.1",
      readMaxBytes: cfg.readMaxBytes,
      interceptors,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createClient(GrokBotService as any, transport);
}

/**
 * Codes that do not prove the server did NOT apply a mutation. For writes these
 * become outcome=unknown / retryable=false / exit 10 (reconcile, never blind-retry).
 */
const WRITE_AMBIGUOUS = new Set(["unavailable", "rpc_error", "internal", "unknown_rpc", "resource_exhausted"]);

export type MapErrorOpts = {
  /** True when the RPC is a mutation (create/update/delete/send/sidebar write/interrupt). */
  write?: boolean;
};

export function mapConnectError(err: unknown, requestId: string, opts?: MapErrorOpts): GbcError {
  const caused = unwrapGbcCause(err);
  if (caused) {
    const details = {
      ...((typeof caused.details === "object" && caused.details) || {}),
      request_id: requestId,
    };
    return new GbcError(caused.code, caused.message, {
      retryable: caused.retryable,
      outcome: caused.outcome,
      hint: caused.hint,
      exitCode: caused.exitCode,
      details,
    });
  }
  const base = mapConnectErrorBase(err, requestId);
  if (opts?.write && WRITE_AMBIGUOUS.has(base.code)) {
    return new GbcError("unknown", `write outcome unknown (${base.code}): ${base.message}`, {
      outcome: "unknown",
      retryable: false,
      exitCode: 10,
      hint: "Server may or may not have applied this write. Reconcile with list/get_send_status/history before any retry; do not blindly resend.",
      details: { request_id: requestId, rpc_code: base.code },
    });
  }
  return base;
}

function mapConnectErrorBase(err: unknown, requestId: string): GbcError {
  const anyErr = err as {
    code?: string | number;
    rawMessage?: string;
    message?: string;
    name?: string;
  };
  const msg = anyErr.rawMessage || anyErr.message || String(err);
  const codeStr = String(anyErr.code ?? "");

  if (
    anyErr.name === "AbortError" ||
    /fetch failed|ECONNRESET|socket hang up|network/i.test(msg)
  ) {
    return new GbcError("unknown", `transport ended without a known outcome: ${msg}`, {
      outcome: "unknown",
      retryable: false,
      exitCode: 10,
      hint: "Do not blindly resend create/send/delete. Reconcile with list/get_send_status/history.",
      details: { request_id: requestId },
    });
  }

  switch (codeStr) {
    case "unauthenticated":
    case "16":
      return new GbcError("unauthenticated", msg, { exitCode: 4, details: { request_id: requestId, rpc_dispatched: true } });
    case "not_found":
    case "5":
      return new GbcError("not_found", msg, { exitCode: 5 });
    case "already_exists":
    case "aborted":
    case "6":
    case "10":
      return new GbcError("conflict", msg, { exitCode: 6 });
    case "permission_denied":
    case "7":
      return new GbcError("permission_denied", msg, { exitCode: 7 });
    case "failed_precondition":
    case "9":
      return new GbcError("failed_precondition", msg, {
        exitCode: 7,
        hint: "May indicate sidebar_sections_base conflict — re-read and retry patch.",
      });
    case "unavailable":
    case "14":
      return new GbcError("unavailable", msg, { retryable: true, exitCode: 8 });
    case "deadline_exceeded":
    case "4":
      return new GbcError("deadline_exceeded", msg, {
        outcome: "unknown",
        retryable: false,
        exitCode: 10,
        hint: "Deadline without response: treat write as unknown; reconcile; do not auto-replay.",
      });
    case "canceled":
    case "1":
      return new GbcError("canceled", msg, {
        outcome: "unknown",
        retryable: false,
        exitCode: 10,
        hint: "Request canceled ≠ InterruptGrokBotAgentRun.",
      });
    case "internal":
    case "13":
      return new GbcError("internal", msg, { exitCode: 9 });
    case "unknown":
    case "2":
      return new GbcError("unknown_rpc", msg, { exitCode: 9 });
    case "resource_exhausted":
    case "8":
      return new GbcError("resource_exhausted", msg, { retryable: true, exitCode: 8 });
    case "invalid_argument":
    case "3":
      return new GbcError("invalid_argument", msg, { exitCode: 2 });
    default:
      return new GbcError("rpc_error", msg, { exitCode: 9, details: { code: codeStr } });
  }
}
