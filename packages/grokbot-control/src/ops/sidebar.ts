import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type { SidebarSection } from "../dto/types.js";
import { paginate, validateLimit, validateOffset } from "./limits.js";
import { GbcError } from "../errors.js";
import { mapSection } from "./map.js";

/** Returned by a `patch` mutator when the sidebar already holds the desired state. */
export const NO_WRITE: unique symbol = Symbol("sidebar.no_write");

export type IfExists = "reuse";

export type SectionWriteBase = {
  sections: SidebarSection[];
  verified?: boolean;
  note: string;
  /** Only under --dry-run. */
  would?: "create" | "reuse" | "move" | "skip";
};

export type SectionCreateData = SectionWriteBase & {
  section_id: string;
  /** The section as read back (or planned under dry-run). */
  section: SidebarSection | null;
  /** True when an existing same-name section was reused (ifExists: "reuse"); no write sent. */
  existing: boolean;
};

export type SectionMoveData = SectionWriteBase & {
  agent_id: string;
  section_id: string;
  /** True when the agent was already in the target section before this call. */
  existing: boolean;
  /** True when no write was needed (already only in the target section). */
  skipped: boolean;
};

/**
 * SidebarSections via Get/UpdateGrokBotUserRuntimeSettings.
 * Only patches sidebar_sections (+ base). Not a cross-App transaction.
 * Delete section ≠ delete bot. Room is separate (unsupported here).
 */
export class SidebarOps {
  private processLock: Promise<void> = Promise.resolve();

  constructor(
    private client: GrokBotClient,
    private flags: { simulated?: boolean } = {},
  ) {}

  private sim<T>(r: ResultEnvelope<T>) {
    if (this.flags.simulated) r.simulated = true;
    return r;
  }

  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    const prev = this.processLock;
    this.processLock = next;
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async list(opts?: {
    limit?: number;
    offset?: number;
  }): Promise<
    ResultEnvelope<{
      sections: SidebarSection[];
      note: string;
      truncated: boolean;
      next?: string;
      hint?: string;
    }>
  > {
    const request_id = newRequestId();
    try {
      const res = await this.client.getGrokBotUserRuntimeSettings({});
      const all = (res.settings?.sidebarSections?.sections ?? []).map(mapSection);
      const page = paginate<SidebarSection>(all, validateLimit(opts?.limit), validateOffset(opts?.offset));
      return this.sim(
        okResult(
          {
            sections: page.items,
            note: "Read of SidebarSections only. Room/TeamGroup are not sidebar.",
            truncated: page.truncated,
            next: page.next,
            hint: page.hint,
          },
          { request_id },
        ),
      );
    } catch (e) {
      return this.fromErr(e, request_id);
    }
  }

  async patch(
    mutate: (sections: SidebarSection[]) => SidebarSection[] | typeof NO_WRITE,
    write?: { dryRun?: boolean; allowWrite?: boolean; verify?: boolean },
    /** Ids already decided by `mutate` (e.g. new section_id); merged into every failure's error.details. */
    context: Record<string, unknown> = {},
  ): Promise<ResultEnvelope<{ sections: SidebarSection[]; verified?: boolean; note: string }>> {
    return this.locked(async () => {
      const request_id = newRequestId();
      let mutated = false;
      try {
        const current = await this.client.getGrokBotUserRuntimeSettings({});
        const baseSections = (current.settings?.sidebarSections?.sections ?? []).map(mapSection);
        const planned = mutate(structuredClone(baseSections));
        mutated = true;
        if (planned === NO_WRITE) {
          // Desired state already holds: no write RPC (also under --dry-run and without --allow-writes).
          return this.sim(
            okResult(
              {
                sections: baseSections,
                note: "No write needed: the sidebar already matches; UpdateGrokBotUserRuntimeSettings not sent.",
              },
              { request_id, code: write?.dryRun ? "dry_run" : "ok" },
            ),
          );
        }
        const next = planned;
        if (write?.dryRun) {
          return this.sim(
            okResult(
              {
                sections: next,
                note: "dry-run: would UpdateGrokBotUserRuntimeSettings with sections+base only",
              },
              { request_id, code: "dry_run" },
            ),
          );
        }
        if (!write?.allowWrite && process.env.GBT_ALLOW_WRITES !== "1") {
          return this.sim(
            failResult("denied", "need --allow-writes for sidebar write", {
              request_id,
              details: Object.keys(context).length ? { ...context, write_sent: false } : undefined,
            }),
          );
        }
        let writeSent = false;
        try {
          writeSent = true;
          await this.client.updateGrokBotUserRuntimeSettings({
            sidebarSections: { sections: toWire(next) },
            sidebarSectionsBase: { sections: toWire(baseSections) },
          });
        } catch (e) {
          const err = e instanceof GbcError ? e : mapConnectError(e, request_id, { write: true });
          if (err.code === "failed_precondition" || /SidebarSectionsSaveConflict|conflict/i.test(err.message) && err.code !== "unknown") {
            return this.sim(
              failResult("sidebar_conflict", err.message, {
                request_id,
                hint: "Re-list sidebar, re-apply minimal patch, write again. No strong cross-App guarantee.",
                details: { ...context, write_sent: writeSent },
              }),
            );
          }
          return this.fromErr(err, request_id, { ...context, write_sent: writeSent });
        }
        if (write?.verify === false) {
          return this.sim(okResult({ sections: next, note: "Wrote sections+base; verify skipped" }, { request_id }));
        }
        let got: SidebarSection[];
        try {
          const again = await this.client.getGrokBotUserRuntimeSettings({});
          got = (again.settings?.sidebarSections?.sections ?? []).map(mapSection);
        } catch (e) {
          const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
          return this.sim(
            failResult("sidebar_unverified", `write sent but read-back failed: ${err.message}`, {
              request_id,
              outcome: "unknown",
              hint: "Re-run `gbc sidebar list` and compare before retrying.",
              details: { ...context, write_sent: writeSent, expected: next },
            }),
          );
        }
        const diff = diffSections(next, got);
        if (diff.length > 0) {
          return this.sim(
            failResult("sidebar_unverified", "sidebar read-back does not match the intended state", {
              request_id,
              outcome: "unknown",
              hint: "Write may have been dropped or overwritten concurrently. Re-list and re-apply; do not blindly retry.",
              details: { ...context, write_sent: true, diff, expected: next, actual: got },
            }),
          );
        }
        return this.sim(
          okResult(
            {
              sections: got,
              verified: true,
              note: "Verified: section order, names and agent membership match (agent_ids order not compared). Best-effort base CAS only; not cross-App transactional.",
            },
            { request_id },
          ),
        );
      } catch (e) {
        // Errors thrown by `mutate` (not_found / ambiguous_match) carry their own details.
        if (mutated || !(e instanceof GbcError && e.details !== undefined)) {
          return this.fromErr(e, request_id, Object.keys(context).length ? { ...context, write_sent: false } : undefined);
        }
        return this.fromErr(e, request_id);
      }
    });
  }

  /**
   * Create a section. With `ifExists: "reuse"`, an existing section with exactly the
   * same name is returned instead (existing: true, no write); two or more same-name
   * sections fail with ambiguous_match (exit 6). The default always creates.
   */
  async createSection(
    name: string,
    write?: { dryRun?: boolean; allowWrite?: boolean },
    opts?: { ifExists?: IfExists },
  ): Promise<ResultEnvelope<SectionCreateData>> {
    const bad = checkIfExists(opts?.ifExists);
    if (bad) return this.sim(bad);
    const ctx: Record<string, unknown> = {};
    let existing = false;
    let sectionId = "";
    const r = await this.patch(
      (sections) => {
        if (opts?.ifExists === "reuse") {
          const same = matchSectionsByName(sections, name);
          if (same.length > 1) throw ambiguousSections(name, same);
          if (same.length === 1) {
            existing = true;
            sectionId = same[0]!.id;
            return NO_WRITE;
          }
        }
        sectionId = crypto.randomUUID();
        ctx.section_id = sectionId;
        sections.push({ id: sectionId, name, agent_ids: [] });
        return sections;
      },
      write,
      ctx,
    );
    if (!r.ok) return r as ResultEnvelope<never>;
    const section = r.data!.sections.find((s) => s.id === sectionId) ?? null;
    return {
      ...r,
      data: {
        ...r.data!,
        section_id: sectionId,
        section,
        existing,
        ...(write?.dryRun ? { would: existing ? ("reuse" as const) : ("create" as const) } : {}),
      },
    };
  }

  renameSection(sectionId: string, name: string, write?: { dryRun?: boolean; allowWrite?: boolean }) {
    return this.patch((sections) => {
      const s = sections.find((x) => x.id === sectionId);
      if (!s) throw new GbcError("not_found", `section ${sectionId} not found`, { exitCode: 5 });
      s.name = name;
      return sections;
    }, write);
  }

  deleteSection(sectionId: string, write?: { dryRun?: boolean; allowWrite?: boolean; confirm?: string }) {
    if (!write?.dryRun && write?.confirm !== sectionId) {
      return Promise.resolve(
        this.sim(
          failResult("denied", "delete section requires --confirm=<section_id> matching --section-id", {
            request_id: newRequestId(),
            hint: `gbc sidebar delete --section-id ${sectionId} --confirm=${sectionId} --allow-writes`,
          }),
        ),
      );
    }
    return this.patch((sections) => {
      const next = sections.filter((x) => x.id !== sectionId);
      if (next.length === sections.length) {
        throw new GbcError("not_found", `section ${sectionId} not found`, { exitCode: 5 });
      }
      return next;
    }, write);
  }

  /**
   * Put an agent into a section. When it is already in the target section (and in no
   * other section) nothing is written: skipped/existing true, position kept. Otherwise it
   * is removed from other sections and appended to the target, unless already there
   * (then its position in the target is kept). Target by id, or by exact unique name.
   */
  async moveBot(
    agentId: string,
    target: string | { sectionId?: string; sectionName?: string },
    write?: { dryRun?: boolean; allowWrite?: boolean },
  ): Promise<ResultEnvelope<SectionMoveData>> {
    const t = typeof target === "string" ? { sectionId: target } : target;
    if (!t.sectionId === !t.sectionName) {
      return this.sim(
        failResult("usage", "sidebar move needs exactly one of section_id / section_name", {
          request_id: newRequestId(),
          hint: "gbc sidebar move --agent-id <id> --section-id <sid>  or  --section-name <name>",
        }),
      );
    }
    let existing = false;
    let skipped = false;
    let destId = t.sectionId ?? "";
    const ctx: Record<string, unknown> = { agent_id: agentId };
    const r = await this.patch(
      (sections) => {
        let dest: SidebarSection | undefined;
        if (t.sectionName !== undefined) {
          const same = matchSectionsByName(sections, t.sectionName);
          if (same.length > 1) throw ambiguousSections(t.sectionName, same);
          dest = same[0];
          if (!dest) {
            throw new GbcError("not_found", `section named "${t.sectionName}" not found`, {
              exitCode: 5,
              details: { agent_id: agentId, section_name: t.sectionName, write_sent: false },
            });
          }
        } else {
          dest = sections.find((s) => s.id === t.sectionId);
          if (!dest) {
            throw new GbcError("not_found", `section ${t.sectionId} not found`, {
              exitCode: 5,
              details: { agent_id: agentId, section_id: t.sectionId, write_sent: false },
            });
          }
        }
        destId = dest.id;
        ctx.section_id = dest.id;
        existing = dest.agent_ids.includes(agentId);
        const elsewhere = sections.some((s) => s.id !== dest!.id && s.agent_ids.includes(agentId));
        skipped = existing && !elsewhere;
        if (skipped) return NO_WRITE;
        for (const s of sections) {
          if (s.id !== dest.id) s.agent_ids = s.agent_ids.filter((id) => id !== agentId);
        }
        if (!existing) dest.agent_ids.push(agentId);
        return sections;
      },
      write,
      ctx,
    );
    if (!r.ok) return r as ResultEnvelope<never>;
    return {
      ...r,
      data: {
        ...r.data!,
        agent_id: agentId,
        section_id: destId,
        existing,
        skipped,
        ...(write?.dryRun ? { would: skipped ? ("skip" as const) : ("move" as const) } : {}),
      },
    };
  }

  private fromErr(e: unknown, request_id: string, extra?: Record<string, unknown>): ResultEnvelope<never> {
    const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
    const details =
      extra === undefined
        ? err.details
        : { ...(isRecord(err.details) ? err.details : err.details === undefined ? {} : { cause: err.details }), ...extra };
    return this.sim(
      failResult(err.code, err.message, {
        outcome: err.outcome,
        retryable: err.retryable,
        hint: err.hint,
        request_id,
        details,
      }),
    );
  }
}

function toWire(sections: SidebarSection[]) {
  return sections.map((s) => ({ id: s.id, name: s.name, agentIds: s.agent_ids }));
}

/**
 * Semantic diff: section order (by id) and names are meaningful; agent_ids are
 * compared as a set (in-section ordering changes are not treated as mismatch).
 */
export function diffSections(expected: SidebarSection[], actual: SidebarSection[]): string[] {
  const out: string[] = [];
  const eIds = expected.map((s) => s.id);
  const aIds = actual.map((s) => s.id);
  if (eIds.join("\u0000") !== aIds.join("\u0000")) {
    out.push(`section order/ids differ: expected [${eIds.join(",")}] got [${aIds.join(",")}]`);
  }
  const byId = new Map(actual.map((s) => [s.id, s]));
  for (const e of expected) {
    const a = byId.get(e.id);
    if (!a) continue;
    if (a.name !== e.name) out.push(`section ${e.id} name: expected "${e.name}" got "${a.name}"`);
    const want = new Set(e.agent_ids);
    const have = new Set(a.agent_ids);
    const missing = [...want].filter((x) => !have.has(x));
    const extra = [...have].filter((x) => !want.has(x));
    if (missing.length || extra.length) {
      out.push(`section ${e.id} agents: missing [${missing.join(",")}] extra [${extra.join(",")}]`);
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Exact, case-sensitive name match (the sidebar has no other name key). */
export function matchSectionsByName(sections: SidebarSection[], name: string): SidebarSection[] {
  return sections.filter((s) => s.name === name);
}

function ambiguousSections(name: string, same: SidebarSection[]): GbcError {
  return new GbcError("ambiguous_match", `${same.length} sidebar sections are named "${name}"; refusing to guess`, {
    exitCode: 6,
    hint: "Pass --section-id, or rename/delete the duplicates first (gbc sidebar list).",
    details: {
      name,
      write_sent: false,
      candidates: same.map((s) => ({ section_id: s.id, name: s.name, agent_ids: s.agent_ids })),
    },
  });
}

export function checkIfExists(v: unknown): ResultEnvelope<never> | undefined {
  if (v === undefined || v === "reuse") return undefined;
  return failResult("usage", `unsupported if-exists value: ${String(v)}`, {
    request_id: newRequestId(),
    hint: "Only --if-exists=reuse is supported; omit it to always create.",
  });
}
