import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { AuthKind, StoredCredential } from "./types.js";

function defaultDir(): string {
  return process.env.GBT_CREDENTIALS_DIR?.trim() || path.join(os.homedir(), ".gbc");
}

function fileFor(kind: AuthKind, backend: string): string {
  const safe = Buffer.from(`${kind}|${backend}`).toString("base64url");
  return path.join(defaultDir(), `cred-${safe}.json`);
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
  load(kind: AuthKind, backend: string): StoredCredential | undefined {
    const f = fileFor(kind, backend);
    if (!fs.existsSync(f)) return undefined;
    const raw = JSON.parse(fs.readFileSync(f, "utf8")) as StoredCredential;
    if (raw.kind !== kind || raw.backend !== backend) {
      throw new Error("credential kind/backend mismatch — refusing to use");
    }
    return raw;
  }

  save(cred: StoredCredential): void {
    const dir = defaultDir();
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
    const f = fileFor(cred.kind, cred.backend);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cred), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  clear(kind: AuthKind, backend: string): void {
    const f = fileFor(kind, backend);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

/** Cross-process single-flight refresh via lockfile. */
export async function withRefreshLock<T>(backend: string, fn: () => Promise<T>): Promise<T> {
  const dir = defaultDir();
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const lock = path.join(dir, `refresh-${Buffer.from(backend).toString("base64url")}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx");
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
    } catch {
      if (Date.now() - start > 30_000) throw new Error("refresh lock timeout");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
