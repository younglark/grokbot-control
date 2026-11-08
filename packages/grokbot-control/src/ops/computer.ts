import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import {
  failResult,
  newRequestId,
  okResult,
  type ResultEnvelope,
} from "../dto/result.js";
import { GbcError } from "../errors.js";

export const RESET_CONFIRM = "RESET_COMPUTER";

const RUN_STATE_NAMES: Readonly<Record<number, string>> = {
  0: "unspecified",
  1: "absent",
  2: "hibernated",
  3: "running",
  4: "starting",
};

const MIGRATION_PHASE_NAMES: Readonly<Record<number, string>> = {
  0: "unspecified",
  1: "backing-up",
  2: "creating",
  3: "moving",
  4: "cleaning-up",
  5: "wiping",
  6: "done",
  7: "failed",
};

const MIGRATION_RECONNECT_MS = 3_000;
const MIGRATION_IDLE_MS = 30_000;
const MIGRATION_MAX_ATTEMPTS = 20;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3_600;

export type ComputerState = {
  state: string;
  state_code: number;
  image_update_available?: boolean;
  egress_tunnel_ownership?: boolean;
  image?: { registry_tag?: string; static_snapshot_path?: string };
};

export type ComputerMigrationEvent = {
  phase: string;
  detail: string;
  at_ms: string;
  offset_key: string;
  operation_id: string;
};

export type ComputerResetOpts = {
  confirm?: string;
  hard?: boolean;
  wait?: boolean;
  timeoutSeconds?: number;
  dryRun?: boolean;
  allowWrite?: boolean;
};

export type ComputerResetWait = {
  requested: true;
  completed: boolean;
  status?: "done" | "failed";
  reason?: string;
  last_phase?: string;
  last_detail?: string;
  events: ComputerMigrationEvent[];
};

export type ComputerResetData = {
  started: boolean;
  operation_id: string;
  hard: boolean;
  preserve_data: false;
  tracking: "operation" | "untrackable";
  wait?: ComputerResetWait;
};

type WaitOutcome =
  | { kind: "done" | "failed"; event: ComputerMigrationEvent; events: ComputerMigrationEvent[] }
  | { kind: "timeout" | "canceled" | "watch_failed"; events: ComputerMigrationEvent[]; last?: ComputerMigrationEvent; error?: string };

function phaseName(value: unknown): string {
  if (typeof value === "number") return MIGRATION_PHASE_NAMES[value] ?? `unknown_${value}`;
  const raw = String(value ?? "");
  if (raw === "") return "unspecified";
  if (/^\d+$/.test(raw)) return MIGRATION_PHASE_NAMES[Number(raw)] ?? `unknown_${raw}`;
  return raw
    .toLowerCase()
    .replace(/^sand_box_migration_phase_/, "")
    .replace(/_/g, "-");
}

function mapMigrationEvent(raw: unknown): ComputerMigrationEvent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = (raw ?? {}) as any;
  return {
    phase: phaseName(e.phase),
    detail: String(e.detail ?? ""),
    at_ms: e.atMs == null ? "" : String(e.atMs),
    offset_key: String(e.offsetKey ?? e.offset_key ?? ""),
    operation_id: String(e.operationId ?? e.operation_id ?? ""),
  };
}

function mapComputerState(raw: unknown): ComputerState {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (raw ?? {}) as any;
  const code = Number(r.state ?? 0);
  const stateCode = Number.isFinite(code) ? code : 0;
  const imageUpdate = r.imageUpdateAvailable ?? r.image_update_available;
  const egressOwnership = r.egressTunnelOwnership ?? r.egress_tunnel_ownership;
  const image = r.image
    ? {
        ...(r.image.registryTag ?? r.image.registry_tag
          ? { registry_tag: String(r.image.registryTag ?? r.image.registry_tag) }
          : {}),
        ...(r.image.staticSnapshotPath ?? r.image.static_snapshot_path
          ? {
              static_snapshot_path: String(
                r.image.staticSnapshotPath ?? r.image.static_snapshot_path,
              ),
            }
          : {}),
      }
    : undefined;
  return {
    state: RUN_STATE_NAMES[stateCode] ?? `unknown_${stateCode}`,
    state_code: stateCode,
    ...(imageUpdate === undefined
      ? {}
      : { image_update_available: Boolean(imageUpdate) }),
    ...(egressOwnership === undefined
      ? {}
      : { egress_tunnel_ownership: Boolean(egressOwnership) }),
    ...(image === undefined ? {} : { image }),
  };
}

function validateTimeout(seconds: number | undefined): number {
  if (seconds === undefined) return DEFAULT_TIMEOUT_SECONDS;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
    throw new GbcError(
      "invalid_argument",
      `timeout must be an integer 1..${MAX_TIMEOUT_SECONDS}`,
      { exitCode: 2 },
    );
  }
  return seconds;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GbcError("canceled", "canceled"));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new GbcError("canceled", "canceled")));
    timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function lastOf(events: ComputerMigrationEvent[]): ComputerMigrationEvent | undefined {
  return events.length === 0 ? undefined : events[events.length - 1];
}

export class ComputerOps {
  constructor(
    private client: GrokBotClient,
    private flags: { simulated?: boolean } = {},
  ) {}

  private sim<T>(r: ResultEnvelope<T>): ResultEnvelope<T> {
    if (this.flags.simulated) r.simulated = true;
    return r;
  }

  async state(): Promise<ResultEnvelope<ComputerState>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.getSandBoxRunState({});
      return this.sim(okResult(mapComputerState(res), { request_id }));
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async reset(
    opts: ComputerResetOpts = {},
    signal?: AbortSignal,
  ): Promise<ResultEnvelope<ComputerResetData>> {
    const request_id = newRequestId();
    const hard = Boolean(opts.hard);
    const action = hard ? "ForceRecreateSandBox" : "RecreateSandBox";

    if (opts.dryRun) {
      return this.sim(
        okResult(
          {
            started: false,
            operation_id: "",
            hard,
            preserve_data: false as const,
            tracking: "untrackable" as const,
            ...(opts.wait
              ? {
                  wait: {
                    requested: true as const,
                    completed: false,
                    reason: "dry-run: no RPC",
                    events: [],
                  },
                }
              : {}),
          },
          { request_id, code: "dry_run" },
        ),
      );
    }

    if (opts.confirm !== RESET_CONFIRM) {
      return this.sim(
        failResult("denied", `reset requires --confirm=${RESET_CONFIRM}`, {
          request_id,
          hint: `gbc computer reset --confirm=${RESET_CONFIRM} --allow-writes`,
        }),
      );
    }
    if (!opts.allowWrite && process.env.GBT_ALLOW_WRITES !== "1") {
      return this.sim(
        failResult(
          "denied",
          "refusing computer.reset: pass --allow-writes or GBT_ALLOW_WRITES=1",
          {
            request_id,
            hint: "Reset is destructive and cannot be canceled after it starts.",
          },
        ),
      );
    }

    let timeoutSeconds: number;
    try {
      timeoutSeconds = validateTimeout(opts.timeoutSeconds);
    } catch (e) {
      return this.fromErr(e, request_id);
    }

    try {
      const res = hard
        ? await this.client.forceRecreateSandBox({})
        : await this.client.recreateSandBox({ preserveData: false, force: false });

      if (!res || res.started !== true) {
        const reason = String(res?.reason ?? "");
        return this.sim(
          failResult(
            "failed_precondition",
            reason.length > 0
              ? `computer reset refused: ${reason}`
              : "computer reset refused by the server",
            {
              request_id,
              hint: "The computer is unchanged. Check `gbc computer state` before retrying.",
              details: { action, reason },
            },
          ),
        );
      }

      const operationId = String(res.operationId ?? res.operation_id ?? "");
      const base = {
        started: true as const,
        operation_id: operationId,
        hard,
        preserve_data: false as const,
        tracking: (operationId.length > 0 ? "operation" : "untrackable") as
          | "operation"
          | "untrackable",
      };

      if (!opts.wait) {
        return this.sim(okResult(base, { request_id }));
      }

      if (operationId.length === 0) {
        return this.sim(
          okResult(
            {
              ...base,
              wait: {
                requested: true as const,
                completed: false,
                reason: "operation_id_unavailable",
                events: [],
              },
            },
            { request_id },
          ),
        );
      }

      const result = await this.waitForMigration(
        operationId,
        timeoutSeconds * 1000,
        signal,
      );
      const last = "event" in result ? result.event : result.last;

      if (result.kind === "done") {
        return this.sim(
          okResult(
            {
              ...base,
              wait: {
                requested: true as const,
                completed: true,
                status: "done" as const,
                last_phase: last?.phase,
                last_detail: last?.detail,
                events: result.events,
              },
            },
            { request_id },
          ),
        );
      }

      if (result.kind === "failed") {
        return this.sim(
          failResult(
            "migration_failed",
            last?.detail
              ? `computer reset failed: ${last.detail}`
              : "computer reset migration failed",
            {
              request_id,
              outcome: "known_failure",
              hint: "The computer was recreated or left incomplete; check `gbc computer state`.",
              details: {
                ...base,
                wait: {
                  requested: true,
                  completed: true,
                  status: "failed",
                  last_phase: last?.phase,
                  last_detail: last?.detail,
                  events: result.events,
                },
              },
            },
          ),
        );
      }

      const waitDetails = {
        ...base,
        wait: {
          requested: true,
          completed: false,
          last_phase: last?.phase,
          last_detail: last?.detail,
          events: result.events,
        },
      };

      if (result.kind === "canceled") {
        return this.sim(
          failResult(
            "canceled",
            "stopped waiting for reset progress; the reset may still be running",
            {
              request_id,
              outcome: "unknown",
              hint: "Check `gbc computer state`; do not start another reset while one is running.",
              details: waitDetails,
            },
          ),
        );
      }

      if (result.kind === "timeout") {
        return this.sim(
          failResult(
            "wait_timeout",
            `computer reset still running after ${timeoutSeconds}s`,
            {
              request_id,
              outcome: "unknown",
              hint: "The reset was accepted and may still be running. Check `gbc computer state`; do not start another reset.",
              details: waitDetails,
            },
          ),
        );
      }

      const streamError = "error" in result ? result.error : undefined;
      return this.sim(
        failResult(
          "migration_watch_failed",
          streamError
            ? `computer reset progress stream failed: ${streamError}`
            : "computer reset progress stream failed",
          {
            request_id,
            outcome: "unknown",
            hint: "The reset may still be running. Check `gbc computer state`.",
            details: waitDetails,
          },
        ),
      );
    } catch (e) {
      return this.fromErr(e, request_id, true);
    }
  }

  private async waitForMigration(
    operationId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitOutcome> {
    const events: ComputerMigrationEvent[] = [];
    const deadline = Date.now() + timeoutMs;
    let fromOffsetKey = "";
    let failures = 0;
    let lastError: unknown;

    while (true) {
      if (signal?.aborted) return { kind: "canceled", events, last: lastOf(events) };
      if (Date.now() >= deadline) return { kind: "timeout", events, last: lastOf(events) };
      if (failures >= MIGRATION_MAX_ATTEMPTS) {
        return {
          kind: "watch_failed",
          events,
          last: lastOf(events),
          error:
            lastError instanceof Error
              ? lastError.message
              : lastError === undefined
                ? "too many stream attempts"
                : String(lastError),
        };
      }

      const attempt = new AbortController();
      const onAbort = () => attempt.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        const remaining = Math.max(1, Math.min(MIGRATION_IDLE_MS, deadline - Date.now()));
        idleTimer = setTimeout(() => attempt.abort(), remaining);
      };
      armIdle();

      let failed = false;
      try {
        for await (const raw of this.client.watchSandBoxMigration(
          { fromOffsetKey, includeFinished: true },
          { signal: attempt.signal },
        )) {
          armIdle();
          const event = mapMigrationEvent(raw);
          if (event.offset_key.length > 0) fromOffsetKey = event.offset_key;
          if (event.operation_id !== operationId) continue;
          events.push(event);
          if (event.phase === "done") return { kind: "done", event, events };
          if (event.phase === "failed") return { kind: "failed", event, events };
        }
      } catch (e) {
        failed = true;
        lastError = e;
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        signal?.removeEventListener("abort", onAbort);
      }

      if (signal?.aborted) return { kind: "canceled", events, last: lastOf(events) };
      if (Date.now() >= deadline) return { kind: "timeout", events, last: lastOf(events) };
      if (failed) failures += 1;

      try {
        await delay(MIGRATION_RECONNECT_MS, signal);
      } catch {
        return { kind: "canceled", events, last: lastOf(events) };
      }
    }
  }

  private fromErr(
    e: unknown,
    request_id: string,
    write = false,
  ): ResultEnvelope<never> {
    const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write });
    return this.sim(
      failResult(err.code, err.message, {
        outcome: err.outcome,
        retryable: err.retryable,
        hint: err.hint,
        request_id,
        details: err.details,
      }),
    );
  }
}
