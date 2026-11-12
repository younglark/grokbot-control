import { GbcError } from "../errors.js";
/** --mock auth that reports logged-out. Used by dashboard unauthenticated tests. */
export function loggedOutMockProvider(opts) {
    return {
        kind: opts.kind,
        backend: opts.backend,
        async getAccessToken() {
            return undefined;
        },
        beginLogin: async () => {
            throw new GbcError("unsupported", "logged-out mock has no login flow", { exitCode: 9 });
        },
        pollLogin: async () => {
            throw new GbcError("unsupported", "logged-out mock has no login flow", { exitCode: 9 });
        },
        completeLogin: async () => {
            throw new GbcError("unsupported", "logged-out mock has no login flow", { exitCode: 9 });
        },
        async cancelLogin() {
            return { had_pending: false };
        },
        refresh: async () => {
            throw new GbcError("unsupported", "logged-out mock cannot refresh", { exitCode: 9 });
        },
        async logout() {
            return { removed_credential: false, removed_pending: false };
        },
        async whoamiLocal() {
            return {
                kind: opts.kind,
                backend: opts.backend,
                has_token: false,
                refresh_configured: false,
                pending_login: false,
                client_id_bound: false,
                disk_refresh: false,
                static_token: false,
            };
        },
    };
}
