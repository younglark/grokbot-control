import type { AuthKind, AuthProvider } from "../auth/types.js";
/** --mock auth that reports logged-out. Used by dashboard unauthenticated tests. */
export declare function loggedOutMockProvider(opts: {
    kind: AuthKind;
    backend: string;
}): AuthProvider;
