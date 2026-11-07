import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AuthKind, PendingLogin, StoredCredential } from "./types.js";

export function credentialsDir(): string {
  return process.env.GBT_CREDENTIALS_DIR?.trim() || path.join(os.homedir(), ".gbc");
}

function key(kind: AuthKind, backend: string): string {
  return Buffer.from(`${kind}|${backend}`).toString("base64url");
}

function ensureDir(): string {
  const dir = credentialsDir();
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  return dir;
}

/** Atomic 0600 JSON write (tmp + rename). */
function writeSecretJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

export function redactCredential(c: StoredCredential): Omit<StoredCredential, "access_token" | "refresh_token"> & {
  access_token: string;
  refresh_token?: string;
} {
  return {
    ...c,
    access_token: c.access_token ? "[redacted]" : "",
    refresh_token: c.refresh_token ? "[redacted]" : undefined,
  };
}

export class FileCredentialStore {
  credFile(kind: AuthKind, backend: string): string {
    return path.join(credentialsDir(), `cred-${key(kind, backend)}.json`);
  }
  pendingFile(kind: AuthKind, backend: string): string {
    return path.join(credentialsDir(), `pending-${key(kind, backend)}.json`);
  }

  load(kind: AuthKind, backend: string): StoredCredential | undefined {
    const f = this.credFile(kind, backend);
    if (!fs.existsSync(f)) return undefined;
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as StoredCredential;
    if (raw.kind !== kind || raw.backend !== backend) {
      throw new Error("credential kind/backend mismatch — refusing to use");
    }
    return raw;
  }

  save(cred: StoredCredential): void {
    ensureDir();
    writeSecretJson(this.credFile(cred.kind, cred.backend), cred);
  }

  clear(kind: AuthKind, backend: string): boolean {
    const f = this.credFile(kind, backend);
    if (!fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    return true;
  }

  loadPending(kind: AuthKind, backend: string): PendingLogin | undefined {
    const f = this.pendingFile(kind, backend);
    if (!fs.existsSync(f)) return undefined;
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as PendingLogin;
    if (raw.v !== 1 || raw.kind !== kind || raw.backend !== backend) {
      throw new Error("pending login kind/backend mismatch — refusing to use");
    }
    return raw;
  }

  savePending(p: PendingLogin): void {
    ensureDir();
    writeSecretJson(this.pendingFile(p.kind, p.backend), p);
  }

  clearPending(kind: AuthKind, backend: string): boolean {
    const f = this.pendingFile(kind, backend);
    if (!fs.existsSync(f)) return false;
    fs.unlinkSync(f);
    return true;
  }
}

const STALE_LOCK_MS = 60_000;

/** Cross-process single-flight refresh via O_EXCL lockfile (stale locks > 60s are broken). */
export async function withRefreshLock<T>(backend: string, fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  const dir = ensureDir();
  const lock = path.join(dir, `refresh-${Buffer.from(backend).toString("base64url")}.lock`);
  const start = Date.now();
  for (;;) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch {
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > waitMs) throw new Error("refresh lock timeout");
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    try {
      return await fn();
    } finally {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
  }
}
