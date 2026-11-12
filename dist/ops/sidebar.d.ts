import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { SidebarSection } from "../dto/types.js";
/** Returned by a `patch` mutator when the sidebar already holds the desired state. */
export declare const NO_WRITE: unique symbol;
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
export declare class SidebarOps {
    private client;
    private flags;
    private processLock;
    constructor(client: GrokBotClient, flags?: {
        simulated?: boolean;
    });
    private sim;
    private locked;
    list(opts?: {
        limit?: number;
        offset?: number;
    }): Promise<ResultEnvelope<{
        sections: SidebarSection[];
        note: string;
        truncated: boolean;
        next?: string;
        hint?: string;
    }>>;
    patch(mutate: (sections: SidebarSection[]) => SidebarSection[] | typeof NO_WRITE, write?: {
        dryRun?: boolean;
        allowWrite?: boolean;
        verify?: boolean;
    }, 
    /** Ids already decided by `mutate` (e.g. new section_id); merged into every failure's error.details. */
    context?: Record<string, unknown>): Promise<ResultEnvelope<{
        sections: SidebarSection[];
        verified?: boolean;
        note: string;
    }>>;
    /**
     * Create a section. With `ifExists: "reuse"`, an existing section with exactly the
     * same name is returned instead (existing: true, no write); two or more same-name
     * sections fail with ambiguous_match (exit 6). The default always creates.
     */
    createSection(name: string, write?: {
        dryRun?: boolean;
        allowWrite?: boolean;
    }, opts?: {
        ifExists?: IfExists;
    }): Promise<ResultEnvelope<SectionCreateData>>;
    renameSection(sectionId: string, name: string, write?: {
        dryRun?: boolean;
        allowWrite?: boolean;
    }): Promise<ResultEnvelope<{
        sections: SidebarSection[];
        verified?: boolean;
        note: string;
    }>>;
    deleteSection(sectionId: string, write?: {
        dryRun?: boolean;
        allowWrite?: boolean;
        confirm?: string;
    }): Promise<ResultEnvelope<{
        sections: SidebarSection[];
        verified?: boolean;
        note: string;
    }>>;
    /**
     * Put an agent into a section. When it is already in the target section (and in no
     * other section) nothing is written: skipped/existing true, position kept. Otherwise it
     * is removed from other sections and appended to the target, unless already there
     * (then its position in the target is kept). Target by id, or by exact unique name.
     */
    moveBot(agentId: string, target: string | {
        sectionId?: string;
        sectionName?: string;
    }, write?: {
        dryRun?: boolean;
        allowWrite?: boolean;
    }): Promise<ResultEnvelope<SectionMoveData>>;
    private fromErr;
}
/**
 * Semantic diff: section order (by id) and names are meaningful; agent_ids are
 * compared as a set (in-section ordering changes are not treated as mismatch).
 */
export declare function diffSections(expected: SidebarSection[], actual: SidebarSection[]): string[];
/** Exact, case-sensitive name match (the sidebar has no other name key). */
export declare function matchSectionsByName(sections: SidebarSection[], name: string): SidebarSection[];
export declare function checkIfExists(v: unknown): ResultEnvelope<never> | undefined;
