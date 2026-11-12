import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, } from "../dto/result.js";
import { GbcError } from "../errors.js";
export const RESET_CONFIRM = "RESET_COMPUTER";
const RUN_STATE_NAMES = {
    0: "unspecified",
    1: "absent",
    2: "hibernated",
    3: "running",
    4: "starting",
};
const MIGRATION_PHASE_NAMES = {
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
const WAKE_DEFAULT_TIMEOUT_SECONDS = 120;
const WAKE_POLL_MS = 3_000;
const RUN_STATE_ABSENT = 1;
const RUN_STATE_HIBERNATED = 2;
const RUN_STATE_RUNNING = 3;
const RUN_STATE_STARTING = 4;
const WAKE_EVIDENCE = "static_inference_not_live_verified";
const WAKE_NOTE = "computer wake is a static inference from the official App (EnsureSandBox with an empty request), not live-verified; waking may incur compute charges.";
function phaseName(value) {
    if (typeof value === "number")
        return MIGRATION_PHASE_NAMES[value] ?? `unknown_${value}`;
    const raw = String(value ?? "");
    if (raw === "")
        return "unspecified";
    if (/^\d+$/.test(raw))
        return MIGRATION_PHASE_NAMES[Number(raw)] ?? `unknown_${raw}`;
    return raw
        .toLowerCase()
        .replace(/^sand_box_migration_phase_/, "")
        .replace(/_/g, "-");
}
function mapMigrationEvent(raw) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = (raw ?? {});
    return {
        phase: phaseName(e.phase),
        detail: String(e.detail ?? ""),
        at_ms: e.atMs == null ? "" : String(e.atMs),
        offset_key: String(e.offsetKey ?? e.offset_key ?? ""),
        operation_id: String(e.operationId ?? e.operation_id ?? ""),
    };
}
function mapComputerState(raw) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (raw ?? {});
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
                    static_snapshot_path: String(r.image.staticSnapshotPath ?? r.image.static_snapshot_path),
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
/** Whitelist mapper for EnsureSandBoxResponse. Never spread or log the raw response. */
function mapEnsureRunState(raw) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = (raw ?? {});
    const code = Number(r.runState ?? r.run_state ?? 0);
    const stateCode = Number.isFinite(code) ? code : 0;
    const imageUpdate = r.imageUpdateAvailable ?? r.image_update_available;
    return {
        state: RUN_STATE_NAMES[stateCode] ?? `unknown_${stateCode}`,
        state_code: stateCode,
        ...(imageUpdate === undefined
            ? {}
            : { image_update_available: Boolean(imageUpdate) }),
    };
}
function validateTimeout(seconds, fallback = DEFAULT_TIMEOUT_SECONDS) {
    if (seconds === undefined)
        return fallback;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
        throw new GbcError("invalid_argument", `timeout must be an integer 1..${MAX_TIMEOUT_SECONDS}`, { exitCode: 2 });
    }
    return seconds;
}
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new GbcError("canceled", "canceled"));
            return;
        }
        let settled = false;
        let timer;
        const finish = (fn) => {
            if (settled)
                return;
            settled = true;
            if (timer !== undefined)
                clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            fn();
        };
        const onAbort = () => finish(() => reject(new GbcError("canceled", "canceled")));
        timer = setTimeout(() => finish(resolve), ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
function lastOf(events) {
    return events.length === 0 ? undefined : events[events.length - 1];
}
export class ComputerOps {
    client;
    flags;
    constructor(client, flags = {}) {
        this.client = client;
        this.flags = flags;
    }
    sim(r) {
        if (this.flags.simulated)
            r.simulated = true;
        return r;
    }
    async state() {
        const request_id = newRequestId();
        try {
            const res = await this.client.getSandBoxRunState({});
            return this.sim(okResult(mapComputerState(res), { request_id }));
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
    }
    async reset(opts = {}, signal) {
        const request_id = newRequestId();
        const hard = Boolean(opts.hard);
        const action = hard ? "ForceRecreateSandBox" : "RecreateSandBox";
        if (opts.dryRun) {
            return this.sim(okResult({
                started: false,
                operation_id: "",
                hard,
                preserve_data: false,
                tracking: "untrackable",
                ...(opts.wait
                    ? {
                        wait: {
                            requested: true,
                            completed: false,
                            reason: "dry-run: no RPC",
                            events: [],
                        },
                    }
                    : {}),
            }, { request_id, code: "dry_run" }));
        }
        if (opts.confirm !== RESET_CONFIRM) {
            return this.sim(failResult("denied", `reset requires --confirm=${RESET_CONFIRM}`, {
                request_id,
                hint: `gbc computer reset --confirm=${RESET_CONFIRM} --allow-writes`,
            }));
        }
        if (!opts.allowWrite && process.env.GBT_ALLOW_WRITES !== "1") {
            return this.sim(failResult("denied", "refusing computer.reset: pass --allow-writes or GBT_ALLOW_WRITES=1", {
                request_id,
                hint: "Reset is destructive and cannot be canceled after it starts.",
            }));
        }
        let timeoutSeconds;
        try {
            timeoutSeconds = validateTimeout(opts.timeoutSeconds);
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
        try {
            const res = hard
                ? await this.client.forceRecreateSandBox({})
                : await this.client.recreateSandBox({ preserveData: false, force: false });
            if (!res || res.started !== true) {
                const reason = String(res?.reason ?? "");
                return this.sim(failResult("failed_precondition", reason.length > 0
                    ? `computer reset refused: ${reason}`
                    : "computer reset refused by the server", {
                    request_id,
                    hint: "The computer is unchanged. Check `gbc computer state` before retrying.",
                    details: { action, reason },
                }));
            }
            const operationId = String(res.operationId ?? res.operation_id ?? "");
            const base = {
                started: true,
                operation_id: operationId,
                hard,
                preserve_data: false,
                tracking: (operationId.length > 0 ? "operation" : "untrackable"),
            };
            if (!opts.wait) {
                return this.sim(okResult(base, { request_id }));
            }
            if (operationId.length === 0) {
                return this.sim(okResult({
                    ...base,
                    wait: {
                        requested: true,
                        completed: false,
                        reason: "operation_id_unavailable",
                        events: [],
                    },
                }, { request_id }));
            }
            const result = await this.waitForMigration(operationId, timeoutSeconds * 1000, signal);
            const last = "event" in result ? result.event : result.last;
            if (result.kind === "done") {
                return this.sim(okResult({
                    ...base,
                    wait: {
                        requested: true,
                        completed: true,
                        status: "done",
                        last_phase: last?.phase,
                        last_detail: last?.detail,
                        events: result.events,
                    },
                }, { request_id }));
            }
            if (result.kind === "failed") {
                return this.sim(failResult("migration_failed", last?.detail
                    ? `computer reset failed: ${last.detail}`
                    : "computer reset migration failed", {
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
                }));
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
                return this.sim(failResult("canceled", "stopped waiting for reset progress; the reset may still be running", {
                    request_id,
                    outcome: "unknown",
                    hint: "Check `gbc computer state`; do not start another reset while one is running.",
                    details: waitDetails,
                }));
            }
            if (result.kind === "timeout") {
                return this.sim(failResult("wait_timeout", `computer reset still running after ${timeoutSeconds}s`, {
                    request_id,
                    outcome: "unknown",
                    hint: "The reset was accepted and may still be running. Check `gbc computer state`; do not start another reset.",
                    details: waitDetails,
                }));
            }
            const streamError = "error" in result ? result.error : undefined;
            return this.sim(failResult("migration_watch_failed", streamError
                ? `computer reset progress stream failed: ${streamError}`
                : "computer reset progress stream failed", {
                request_id,
                outcome: "unknown",
                hint: "The reset may still be running. Check `gbc computer state`.",
                details: waitDetails,
            }));
        }
        catch (e) {
            return this.fromErr(e, request_id, true);
        }
    }
    /**
     * Non-destructive wake of the shared computer (issue #5).
     *
     * Evidence (docs/protocol/computer-wake-0.79.4.md): the official App wakes a
     * hibernated computer through `connect()` -> `EnsureSandBox({})` with neither
     * `wake` nor `supports_asleep_box` set; `wake:false` / `supports_asleep_box:true`
     * are the App's non-waking probes. The App's optional `x-sand-box-park` header
     * is driven by App feature gates and is NOT sent here. Not live-verified.
     *
     * Never calls RecreateSandBox / ForceRecreateSandBox / EnsureSandBoxWindow, and
     * never copies credentials or URLs from EnsureSandBoxResponse.
     */
    async wake(opts = {}, signal) {
        const request_id = newRequestId();
        const wait = Boolean(opts.wait);
        if (!opts.dryRun && !opts.allowWrite && process.env.GBT_ALLOW_WRITES !== "1") {
            return this.sim(failResult("denied", "refusing computer.wake: pass --allow-writes or GBT_ALLOW_WRITES=1", {
                request_id,
                hint: `Preview with \`gbc computer wake --dry-run\`. ${WAKE_NOTE}`,
            }));
        }
        let timeoutSeconds;
        try {
            timeoutSeconds = validateTimeout(opts.timeoutSeconds, WAKE_DEFAULT_TIMEOUT_SECONDS);
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
        const pollMs = Math.max(1, opts.pollIntervalMs ?? WAKE_POLL_MS);
        let before;
        try {
            before = mapComputerState(await this.client.getSandBoxRunState({}));
        }
        catch (e) {
            return this.fromErr(e, request_id);
        }
        const base = {
            rpc: "EnsureSandBox",
            request: {},
            before,
            evidence: WAKE_EVIDENCE,
        };
        const wakeable = before.state_code === RUN_STATE_HIBERNATED;
        const skip = before.state_code === RUN_STATE_RUNNING
            ? "already_running"
            : before.state_code === RUN_STATE_STARTING
                ? "already_starting"
                : undefined;
        if (opts.dryRun) {
            return this.sim(okResult({
                ...base,
                action: wakeable
                    ? "would_wake"
                    : skip !== undefined
                        ? "would_skip"
                        : "would_refuse",
                write_sent: false,
                running: before.state_code === RUN_STATE_RUNNING,
            }, { request_id, code: "dry_run" }));
        }
        if (!wakeable && skip === undefined) {
            return this.sim(failResult("failed_precondition", `computer is ${before.state}; wake only applies to a hibernated computer`, {
                request_id,
                hint: before.state_code === RUN_STATE_ABSENT
                    ? "No computer exists. Wake will not create one; EnsureSandBox on an absent computer may provision a new one."
                    : "Check `gbc computer state` and retry once it reports hibernated.",
                details: { ...base, write_sent: false },
            }));
        }
        if (skip === "already_running") {
            return this.sim(okResult({ ...base, action: skip, write_sent: false, after: before, running: true }, { request_id, code: "already_running" }));
        }
        let ensure;
        if (wakeable) {
            try {
                // Exactly what the App's connect() sends: an empty EnsureSandBoxRequest.
                const res = await this.client.ensureSandBox({});
                ensure = mapEnsureRunState(res);
            }
            catch (e) {
                return this.fromErr(e, request_id, true);
            }
        }
        const action = wakeable ? "wake" : "already_starting";
        const written = {
            ...base,
            action,
            write_sent: wakeable,
            ...(ensure === undefined ? {} : { ensure_response: ensure }),
        };
        const deadline = Date.now() + timeoutSeconds * 1000;
        let polls = 0;
        let after;
        let canceled = false;
        let readError;
        while (true) {
            try {
                after = mapComputerState(await this.client.getSandBoxRunState({}));
                readError = undefined;
            }
            catch (e) {
                readError = e;
            }
            polls += 1;
            if (after?.state_code === RUN_STATE_RUNNING && readError === undefined)
                break;
            if (!wait || Date.now() + pollMs > deadline)
                break;
            try {
                await delay(pollMs, signal);
            }
            catch {
                canceled = true;
                break;
            }
        }
        const waitInfo = wait
            ? {
                wait: {
                    requested: true,
                    completed: after?.state_code === RUN_STATE_RUNNING && readError === undefined,
                    polls,
                    timeout_seconds: timeoutSeconds,
                },
            }
            : {};
        const running = readError === undefined && after?.state_code === RUN_STATE_RUNNING;
        const data = {
            ...written,
            ...(after === undefined ? {} : { after }),
            running,
            ...waitInfo,
        };
        if (running) {
            return this.sim(okResult(data, { request_id, code: wakeable ? "ok" : "already_starting" }));
        }
        if (!wait &&
            !canceled &&
            readError === undefined &&
            after?.state_code === RUN_STATE_STARTING) {
            // Accepted and starting; caller did not ask to wait.
            return this.sim(okResult(data, { request_id, code: "starting" }));
        }
        const why = canceled
            ? "stopped waiting"
            : readError !== undefined
                ? "read-back failed"
                : wait
                    ? `still ${after?.state ?? "unknown"} after ${timeoutSeconds}s`
                    : `read-back shows ${after?.state ?? "unknown"}`;
        return this.sim(failResult("wake_unverified", `computer wake not confirmed: ${why}`, {
            request_id,
            outcome: "unknown",
            hint: wakeable
                ? "EnsureSandBox was sent; the computer may still be waking. Check `gbc computer state` before retrying. Do not reset."
                : "The computer was already starting; check `gbc computer state`.",
            details: data,
        }));
    }
    async waitForMigration(operationId, timeoutMs, signal) {
        const events = [];
        const deadline = Date.now() + timeoutMs;
        let fromOffsetKey = "";
        let failures = 0;
        let lastError;
        while (true) {
            if (signal?.aborted)
                return { kind: "canceled", events, last: lastOf(events) };
            if (Date.now() >= deadline)
                return { kind: "timeout", events, last: lastOf(events) };
            if (failures >= MIGRATION_MAX_ATTEMPTS) {
                return {
                    kind: "watch_failed",
                    events,
                    last: lastOf(events),
                    error: lastError instanceof Error
                        ? lastError.message
                        : lastError === undefined
                            ? "too many stream attempts"
                            : String(lastError),
                };
            }
            const attempt = new AbortController();
            const onAbort = () => attempt.abort();
            signal?.addEventListener("abort", onAbort, { once: true });
            let idleTimer;
            const armIdle = () => {
                if (idleTimer !== undefined)
                    clearTimeout(idleTimer);
                const remaining = Math.max(1, Math.min(MIGRATION_IDLE_MS, deadline - Date.now()));
                idleTimer = setTimeout(() => attempt.abort(), remaining);
            };
            armIdle();
            let failed = false;
            try {
                for await (const raw of this.client.watchSandBoxMigration({ fromOffsetKey, includeFinished: true }, { signal: attempt.signal })) {
                    armIdle();
                    const event = mapMigrationEvent(raw);
                    if (event.offset_key.length > 0)
                        fromOffsetKey = event.offset_key;
                    if (event.operation_id !== operationId)
                        continue;
                    events.push(event);
                    if (event.phase === "done")
                        return { kind: "done", event, events };
                    if (event.phase === "failed")
                        return { kind: "failed", event, events };
                }
            }
            catch (e) {
                failed = true;
                lastError = e;
            }
            finally {
                if (idleTimer !== undefined)
                    clearTimeout(idleTimer);
                signal?.removeEventListener("abort", onAbort);
            }
            if (signal?.aborted)
                return { kind: "canceled", events, last: lastOf(events) };
            if (Date.now() >= deadline)
                return { kind: "timeout", events, last: lastOf(events) };
            if (failed)
                failures += 1;
            try {
                await delay(MIGRATION_RECONNECT_MS, signal);
            }
            catch {
                return { kind: "canceled", events, last: lastOf(events) };
            }
        }
    }
    fromErr(e, request_id, write = false) {
        const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write });
        return this.sim(failResult(err.code, err.message, {
            outcome: err.outcome,
            retryable: err.retryable,
            hint: err.hint,
            request_id,
            details: err.details,
        }));
    }
}
