import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type { SidebarSection } from "../dto/types.js";
import { paginate, validateLimit, validateOffset } from "./limits.js";
import { GbcError } from "../errors.js";
import { mapSection } from "./map.js";

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
    mutate: (sections: SidebarSection[]) => SidebarSection[],
    write?: { dryRun?: boolean; allowWrite?: boolean; verify?: boolean },
  ): Promise<ResultEnvelope<{ sections: SidebarSection[]; verified?: boolean; note: string }>> {
    return this.locked(async () => {
      const request_id = newRequestId();
      try {
        const current = await this.client.getGrokBotUserRuntimeSettings({});
        const baseSections = (current.settings?.sidebarSections?.sections ?? []).map(mapSection);
        const next = mutate(structuredClone(baseSections));
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
          return this.sim(failResult("denied", "need --allow-writes for sidebar write", { request_id }));
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
              }),
            );
          }
          return this.fromErr(err, request_id);
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
              details: { write_sent: writeSent, expected: next },
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
              details: { diff, expected: next, actual: got },
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
        return this.fromErr(e, request_id);
      }
    });
  }

  createSection(name: string, write?: { dryRun?: boolean; allowWrite?: boolean }) {
    return this.patch((sections) => {
      sections.push({ id: crypto.randomUUID(), name, agent_ids: [] });
      return sections;
    }, write);
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

  moveBot(agentId: string, toSectionId: string, write?: { dryRun?: boolean; allowWrite?: boolean }) {
    return this.patch((sections) => {
      for (const s of sections) {
        s.agent_ids = s.agent_ids.filter((id) => id !== agentId);
      }
      const dest = sections.find((s) => s.id === toSectionId);
      if (!dest) throw new GbcError("not_found", `section ${toSectionId} not found`, { exitCode: 5 });
      dest.agent_ids.push(agentId);
      return sections;
    }, write);
  }

  private fromErr(e: unknown, request_id: string): ResultEnvelope<never> {
    const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
    return this.sim(
      failResult(err.code, err.message, {
        outcome: err.outcome,
        retryable: err.retryable,
        hint: err.hint,
        request_id,
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
