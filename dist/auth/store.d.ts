import { type LockWaitOptions } from "./lock.js";
import type { AuthKind, PendingLogin, StoredCredential } from "./types.js";
export declare function credentialsDir(): string;
export declare function redactCredential(c: StoredCredential): Omit<StoredCredential, "access_token" | "refresh_token"> & {
    access_token: string;
    refresh_token?: string;
};
export declare class FileCredentialStore {
    credFile(kind: AuthKind, backend: string): string;
    pendingFile(kind: AuthKind, backend: string): string;
    load(kind: AuthKind, backend: string): StoredCredential | undefined;
    save(cred: StoredCredential): void;
    /**
     * CAS save: only write when on-disk revision matches expectedRevision (undefined/0 = absent or legacy).
     * Returns false without writing when revision diverged (logout / new login / peer refresh).
     */
    saveIfRevision(cred: StoredCredential, expectedRevision: number | undefined): boolean;
    clear(kind: AuthKind, backend: string): boolean;
    loadPending(kind: AuthKind, backend: string): PendingLogin | undefined;
    savePending(p: PendingLogin): void;
    clearPending(kind: AuthKind, backend: string): boolean;
}
/** Separate permanent native locks for refresh exchange and short credential mutations. */
export declare function withCredentialLock<T>(lockKey: string, fn: () => Promise<T>, options?: number | LockWaitOptions): Promise<T>;
export declare const withRefreshLock: typeof withCredentialLock;
