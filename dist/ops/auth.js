import { parseLoginMode, parseRedirectTarget } from "../auth/provider.js";
import { failResult, newRequestId, okResult } from "../dto/result.js";
import { GbcError } from "../errors.js";
export const AUTH_TIMEOUT_MAX_S = 900;
/** Shared CLI/MCP auth operations. Results never contain verifier/access/refresh tokens. */
export class AuthOps {
    auth;
    flags;
    constructor(auth, flags = {}) {
        this.auth = auth;
        this.flags = flags;
    }
    guard() {
        if (!this.auth)
            throw new GbcError("auth", "no auth provider", { exitCode: 4 });
        if (this.flags.simulated) {
            throw new GbcError("unsupported", "auth login/refresh is not available in --mock mode", { exitCode: 9 });
        }
        return this.auth;
    }
    async run(fn) {
        const request_id = newRequestId();
        try {
            return okResult(await fn(this.guard()), { request_id });
        }
        catch (e) {
            const err = e instanceof GbcError ? e : new GbcError("auth", "auth operation failed", { exitCode: 4 });
            return failResult(err.code, err.message, {
                request_id,
                outcome: err.outcome,
                retryable: err.retryable,
                hint: err.hint,
                details: err.details,
            });
        }
    }
    whoami() {
        const request_id = newRequestId();
        if (!this.auth)
            return Promise.resolve(failResult("auth", "no auth provider", { request_id }));
        return this.auth.whoamiLocal().then((w) => ({ ...okResult(w, { request_id }), simulated: this.flags.simulated }));
    }
    begin(opts) {
        let loginMode;
        let redirectTarget;
        try {
            loginMode = parseLoginMode(opts?.loginMode);
            redirectTarget = parseRedirectTarget(opts?.redirectTarget);
        }
        catch (e) {
            const err = e instanceof GbcError ? e : new GbcError("invalid_argument", "invalid login options", { exitCode: 2 });
            return Promise.resolve(failResult(err.code, err.message, { hint: err.hint, details: err.details }));
        }
        return this.run((a) => a.beginLogin({ loginMode, redirectTarget }));
    }
    /** Single poll; pending -> ok:false code auth_pending retryable (safe: read-only poll). */
    async poll() {
        const r = await this.run((a) => a.pollLogin());
        return pendingToFail(r);
    }
    async complete(timeoutSeconds, signal) {
        const t = timeoutSeconds ?? 300;
        if (!Number.isInteger(t) || t < 1 || t > AUTH_TIMEOUT_MAX_S) {
            return failResult("invalid_argument", `timeout must be an integer in 1..${AUTH_TIMEOUT_MAX_S} seconds`, {
                hint: "--timeout=300",
            });
        }
        const r = await this.run((a) => a.completeLogin({ timeoutMs: t * 1000, signal }));
        return pendingToFail(r);
    }
    cancel() {
        return this.run((a) => a.cancelLogin());
    }
    /**
     * Refresh credentials. Without force: may return refreshed:false / reason already_fresh
     * when the token is still outside the 5-minute early window (no network call).
     * With force: always attempts a network refresh (for verification / 401 recovery).
     */
    refresh(opts) {
        return this.run(async (a) => a.refresh({ force: Boolean(opts?.force) }));
    }
    logout() {
        return this.run(async (a) => ({
            ...(await a.logout()),
            note: "Local only: removed this tool's own credential/pending files; server-side session not revoked.",
        }));
    }
}
function pendingToFail(r) {
    const d = r.data;
    if (r.ok && d?.status === "pending") {
        return failResult("auth_pending", d.note ?? "login still pending", {
            request_id: r.request_id,
            retryable: true,
            hint: "Finish sign-in in the browser, then run `gbc auth complete` again.",
            details: { expires_at_ms: d.expires_at_ms },
        });
    }
    return r;
}
