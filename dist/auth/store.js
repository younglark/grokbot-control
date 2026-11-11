import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { withAdvisoryLock } from "./lock.js";
export function credentialsDir() {
    return process.env.GBT_CREDENTIALS_DIR?.trim() || path.join(os.homedir(), ".gbc");
}
function key(kind, backend) {
    return Buffer.from(`${kind}|${backend}`).toString("base64url");
}
function ensureDir() {
    const dir = credentialsDir();
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    try {
        fs.chmodSync(dir, 0o700);
    }
    catch {
        /* best effort */
    }
    return dir;
}
/** Atomic 0600 JSON write (tmp + rename). */
function writeSecretJson(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}
export function redactCredential(c) {
    return {
        ...c,
        access_token: c.access_token ? "[redacted]" : "",
        refresh_token: c.refresh_token ? "[redacted]" : undefined,
    };
}
export class FileCredentialStore {
    credFile(kind, backend) {
        return path.join(credentialsDir(), `cred-${key(kind, backend)}.json`);
    }
    pendingFile(kind, backend) {
        return path.join(credentialsDir(), `pending-${key(kind, backend)}.json`);
    }
    load(kind, backend) {
        const f = this.credFile(kind, backend);
        if (!fs.existsSync(f))
            return undefined;
        const raw = JSON.parse(fs.readFileSync(f, "utf8"));
        if (raw.kind !== kind || raw.backend !== backend) {
            throw new Error("credential kind/backend mismatch — refusing to use");
        }
        return raw;
    }
    save(cred) {
        ensureDir();
        writeSecretJson(this.credFile(cred.kind, cred.backend), cred);
    }
    /**
     * CAS save: only write when on-disk revision matches expectedRevision (undefined/0 = absent or legacy).
     * Returns false without writing when revision diverged (logout / new login / peer refresh).
     */
    saveIfRevision(cred, expectedRevision) {
        const cur = this.load(cred.kind, cred.backend);
        const curRev = cur?.revision ?? 0;
        const exp = expectedRevision ?? 0;
        if (cur && curRev !== exp)
            return false;
        if (!cur && exp !== 0)
            return false;
        this.save(cred);
        return true;
    }
    clear(kind, backend) {
        const f = this.credFile(kind, backend);
        if (!fs.existsSync(f))
            return false;
        fs.unlinkSync(f);
        return true;
    }
    loadPending(kind, backend) {
        const f = this.pendingFile(kind, backend);
        if (!fs.existsSync(f))
            return undefined;
        const raw = JSON.parse(fs.readFileSync(f, "utf8"));
        if (raw.v !== 1 || raw.kind !== kind || raw.backend !== backend) {
            throw new Error("pending login kind/backend mismatch — refusing to use");
        }
        return raw;
    }
    savePending(p) {
        ensureDir();
        writeSecretJson(this.pendingFile(p.kind, p.backend), p);
    }
    clearPending(kind, backend) {
        const f = this.pendingFile(kind, backend);
        if (!fs.existsSync(f))
            return false;
        fs.unlinkSync(f);
        return true;
    }
}
/** Separate permanent native locks for refresh exchange and short credential mutations. */
export async function withCredentialLock(lockKey, fn, options = 30_000) {
    const lock = path.join(ensureDir(), `refresh-${Buffer.from(lockKey).toString("base64url")}.lock`);
    return withAdvisoryLock(lock, fn, typeof options === "number" ? { waitMs: options } : options);
}
export const withRefreshLock = withCredentialLock;
