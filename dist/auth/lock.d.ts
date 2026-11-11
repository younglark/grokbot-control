/** Backend-neutral contract. Only nonblocking native attempts run on the event loop. */
export interface AdvisoryLockBinding {
    tryLock(fd: number): boolean;
    unlock(fd: number): void;
}
export type LockWaitOptions = {
    waitMs?: number;
    signal?: AbortSignal;
};
/** Permanent independent file. Never truncate, replace or unlink; OS releases on process death.
 * Cancellation is honored only BEFORE exchange starts, never while fn owns the lock.
 * Only local filesystems supported; all credential writers must cooperate.
 */
export declare function withAdvisoryLock<T>(file: string, fn: () => Promise<T>, opts?: LockWaitOptions): Promise<T>;
