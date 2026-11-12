/**
 * Strip credential-adjacent fields before any value is sent to the browser.
 * Tokens, refresh tokens, verifiers, endpoints, session ids, and paths stay out.
 */
export function sanitizeWhoami(w) {
    return {
        kind: w.kind,
        ...(w.account_label ? { account_label: w.account_label } : {}),
        logged_in: Boolean(w.has_token),
        ...(w.login_kind ? { login_kind: w.login_kind } : {}),
        pending_login: Boolean(w.pending_login),
        static_token: Boolean(w.static_token),
    };
}
const SECRETISH = /access[_-]?token|refresh[_-]?token|verifier|authorization:\s*bearer|client_secret|sand-secrets|credentials_dir|~\/\.gbc/i;
/** Return true if a JSON-able payload appears to contain a secret-like string. */
export function payloadLooksSecret(value) {
    try {
        return SECRETISH.test(JSON.stringify(value));
    }
    catch {
        return false;
    }
}
