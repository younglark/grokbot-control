import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { GbcError } from '../errors.js';
let binding;
function nativeBinding() {
    if (binding)
        return binding;
    try {
        if (!['linux', 'darwin', 'win32'].includes(process.platform))
            throw new Error('unsupported platform');
        const loaded = createRequire(import.meta.url)('fs-native-extensions');
        if (typeof loaded.tryLock !== 'function' || typeof loaded.unlock !== 'function')
            throw new Error('invalid binding');
        binding = loaded;
        return loaded;
    }
    catch {
        throw new GbcError('auth_lock_unavailable', 'Native advisory lock unavailable; run npm ci with fs-native-extensions@1.5.3 prebuilds for your OS/architecture. See https://github.com/younglark/grokbot-control/blob/main/docs/control-plane/auth-lock.md for source build instructions. No lease fallback.', { exitCode: 4 });
    }
}
/** Permanent independent file. Never truncate, replace or unlink; OS releases on process death.
 * Cancellation is honored only BEFORE exchange starts, never while fn owns the lock.
 * Only local filesystems supported; all credential writers must cooperate.
 */
export async function withAdvisoryLock(file, fn, opts = {}) {
    const native = nativeBinding();
    const waitMs = opts.waitMs ?? 30000;
    if (!Number.isFinite(waitMs) || waitMs < 0)
        throw new GbcError('invalid_argument', 'invalid lock wait deadline');
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    let held = false;
    try {
        const original = fs.fstatSync(fd);
        if (fs.lstatSync(file).isSymbolicLink() || !original.isFile() || original.nlink !== 1)
            throw new GbcError('auth_lock_path', 'lock must be an independent regular file');
        if (process.platform !== 'win32')
            fs.fchmodSync(fd, 0o600);
        const deadline = performance.now() + waitMs;
        for (;;) {
            if (opts.signal?.aborted)
                throw new GbcError('auth_lock_canceled', 'lock wait canceled; no exchange started', { exitCode: 8, retryable: true, details: { rpc_dispatched: false } });
            try {
                held = native.tryLock(fd);
            }
            catch (e) {
                // libuv Windows ERROR_LOCK_VIOLATION may surface as EBUSY; other failures fail closed.
                if (!['EAGAIN', 'EBUSY'].includes(e.code ?? ''))
                    throw new GbcError('auth_lock_unavailable', 'native lock failed; credentials kept', { exitCode: 4 });
            }
            if (held) {
                const current = fs.lstatSync(file);
                if (current.isSymbolicLink() || original.ino !== current.ino || original.dev !== current.dev)
                    throw new GbcError('auth_lock_path', 'lock path replaced while waiting; refusing exchange');
                return await fn();
            }
            if (performance.now() >= deadline)
                throw new GbcError('auth_refresh_lock_timeout', 'lock wait deadline exceeded; owner left intact', { exitCode: 8, retryable: true, details: { rpc_dispatched: false } });
            await delay(Math.min(25, Math.max(1, deadline - performance.now())));
        }
    }
    finally {
        try {
            if (held)
                native.unlock(fd);
        }
        finally {
            fs.closeSync(fd);
        }
    }
}
