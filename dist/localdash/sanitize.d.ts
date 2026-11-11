import type { WhoamiLocal } from "../auth/types.js";
import type { SanitizedWhoami } from "../dto/types.js";
/**
 * Strip credential-adjacent fields before any value is sent to the browser.
 * Tokens, refresh tokens, verifiers, endpoints, session ids, and paths stay out.
 */
export declare function sanitizeWhoami(w: WhoamiLocal): SanitizedWhoami;
/** Return true if a JSON-able payload appears to contain a secret-like string. */
export declare function payloadLooksSecret(value: unknown): boolean;
