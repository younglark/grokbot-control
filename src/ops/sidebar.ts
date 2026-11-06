import type { GrokBotClient } from "../connect/client.js";
import { mapConnectError } from "../connect/client.js";
import { failResult, newRequestId, okResult, type ResultEnvelope } from "../dto/result.js";
import type { SidebarSection } from "../dto/types.js";
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

  async list(): Promise<ResultEnvelope<{ sections: SidebarSection[]; note: string }>> {
    const request_id = newRequestId();
    try {
      const res = await this.client.getGrokBotUserRuntimeSettings({});
      const sections = (res.settings?.sidebarSections?.sections ?? []).map(mapSection);
      return this.sim(
        okResult(
          {
            sections,
            note: "Read of SidebarSections only. Room/TeamGroup are not sidebar.",
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
        await this.client.updateGrokBotUserRuntimeSettings({
          sidebarSections: {
            sections: next.map((s: { id: string; name: string; agent_ids: string[] }) => ({ id: s.id, name: s.name, agentIds: s.agent_ids })),
          },
          sidebarSectionsBase: {
            sections: baseSections.map((s: { id: string; name: string; agent_ids: string[] }) => ({ id: s.id, name: s.name, agentIds: s.agent_ids })),
          },
        });
        let verified = false;
        if (write?.verify !== false) {
          const again = await this.client.getGrokBotUserRuntimeSettings({});
          const got = (again.settings?.sidebarSections?.sections ?? []).map(mapSection);
          verified = JSON.stringify(got) === JSON.stringify(next);
          return this.sim(
            okResult(
              {
                sections: got,
                verified,
                note: "Best-effort base CAS only; not cross-App transactional. Process-local lock held.",
              },
              { request_id },
            ),
          );
        }
        return this.sim(
          okResult(
            {
              sections: next,
              note: "Wrote sections+base; verify skipped",
            },
            { request_id },
          ),
        );
      } catch (e) {
        const err = e instanceof GbcError ? e : mapConnectError(e, request_id);
        if (err.code === "failed_precondition" || /conflict|SidebarSectionsSaveConflict/i.test(err.message)) {
          return this.sim(
            failResult("sidebar_conflict", err.message, {
              request_id,
              hint: "Re-list sidebar, re-apply minimal patch, write again. No strong cross-App guarantee.",
            }),
          );
        }
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
    if (write?.confirm && write.confirm !== sectionId && !write.dryRun) {
      return Promise.resolve(
        this.sim(
          failResult("denied", "delete section requires --confirm=<section_id>", {
            request_id: newRequestId(),
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
