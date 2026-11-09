/**
 * requestedSandboxPolicy evaluation for Linux local-exec (Kc D:106557, Ud/ol D:20797–20834).
 * Without the sandbox helper binary, any non-insecure_none policy throws SandboxUnsupportedError
 * with the original message; the shell stream / background spawn paths turn that into
 * sandboxUnsupported frames (E_ D:131119–131136, $3 D:110775–110790).
 * Darwin-only helper mechanisms (HKt, uze) are not ported — original no-ops them off darwin.
 */

export type InternalSandboxPolicy =
  | { type: "insecure_none"; allowlistEscalated?: boolean; enableSharedBuildCache?: boolean; debugOutputDir?: string; captureDenies?: boolean }
  | { type: "workspace_readwrite"; [k: string]: unknown }
  | { type: "workspace_readonly"; [k: string]: unknown };

/** Proto / JSON type names as emitted by ExecServerMessage.toJson(). */
const TYPE_MAP: Record<string, InternalSandboxPolicy["type"]> = {
  INSECURE_NONE: "insecure_none",
  TYPE_INSECURE_NONE: "insecure_none",
  UNSPECIFIED: "insecure_none",
  TYPE_UNSPECIFIED: "insecure_none",
  WORKSPACE_READWRITE: "workspace_readwrite",
  TYPE_WORKSPACE_READWRITE: "workspace_readwrite",
  WORKSPACE_READONLY: "workspace_readonly",
  TYPE_WORKSPACE_READONLY: "workspace_readonly",
  insecure_none: "insecure_none",
  workspace_readwrite: "workspace_readwrite",
  workspace_readonly: "workspace_readonly",
  "0": "insecure_none",
  "1": "insecure_none",
  "2": "workspace_readwrite",
  "3": "workspace_readonly",
};

/** D:Kc 106557 — convert wire SandboxPolicy to internal shape. Unknown → insecure_none. */
export function Kc(t: { type?: unknown } | null | undefined): InternalSandboxPolicy {
  if (!t) return { type: "insecure_none" };
  const raw = t.type;
  const key = typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
  const mapped = TYPE_MAP[key] ?? "insecure_none";
  if (mapped === "insecure_none") {
    return {
      type: "insecure_none",
      allowlistEscalated: (t as { allowlistEscalated?: boolean }).allowlistEscalated,
      enableSharedBuildCache: (t as { enableSharedBuildCache?: boolean }).enableSharedBuildCache,
      debugOutputDir: (t as { debugOutputDir?: string }).debugOutputDir,
      captureDenies: (t as { captureDenies?: boolean }).captureDenies,
    };
  }
  // Spread first so our mapped `type` wins over the wire enum name (TYPE_*).
  return { ...(t as object), type: mapped };
}

export class SandboxUnsupportedError extends Error {
  // D:ol 20827–20834
  reason?: string;
  constructor(message: string, reason?: string) {
    super(message);
    this.name = "SandboxUnsupportedError";
    this.reason = reason;
  }
}

/** Cached helper support (D:wze / ja). We do not ship the helper → false after first check. */
let helperSupported: boolean | null = null;
let helperReason: string | null = null;

/**
 * D:wze 20533 — sandbox helper available?
 * Linux without the helper binary: Eze fails → reason "Binary check failed", returns false.
 * We match that path (no binary in this package). Override via SAND_SANDBOX_HELPER_SUPPORTED=1 for tests only.
 */
export function isSandboxHelperSupported(): boolean {
  if (helperSupported !== null) return helperSupported;
  const env = (process.env.SAND_SANDBOX_HELPER_SUPPORTED ?? "").trim().toLowerCase();
  if (env === "1" || env === "true" || env === "on") {
    helperSupported = true; helperReason = null; return true;
  }
  // Binary not packaged with this daemon → same as Eze failure.
  helperReason = "Binary check failed";
  helperSupported = false;
  return false;
}

/** D:kk 20747 */
export function sandboxHelperReason(): string | null { return helperReason; }

/**
 * D:Ud 20797 — when policy is not insecure_none and helper unsupported, throw ol with exact text.
 * Does not invoke the darwin-only sandbox spawn path.
 */
export function assertSandboxSupported(policy: InternalSandboxPolicy): void {
  if (policy.type === "insecure_none") return;
  if (isSandboxHelperSupported()) {
    // Helper present: we still do not implement workspace_* isolation here; treat as unsupported
    // with an explicit reason so callers never silently run unsandboxed under a non-none policy.
    throw new SandboxUnsupportedError(
      `Sandbox policy '${policy.type}' is not supported on this system. Ensure the sandbox helper binary is available, or use 'insecure_none'. Reason: helper present but workspace isolation not implemented`,
      "helper present but workspace isolation not implemented",
    );
  }
  const s = sandboxHelperReason();
  throw new SandboxUnsupportedError(
    `Sandbox policy '${policy.type}' is not supported on this system. Ensure the sandbox helper binary is available, or use 'insecure_none'. Reason: ${s || "unknown"}`,
    s ?? undefined,
  );
}

/** Wire enum / JSON name for start.sandboxPolicy (we always announce INSECURE_NONE when running). */
export function sandboxPolicyTypeLabel(policy: InternalSandboxPolicy): string {
  return policy.type;
}
