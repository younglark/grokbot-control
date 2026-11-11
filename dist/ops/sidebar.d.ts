import type { GrokBotClient } from "../connect/client.js";
import { type ResultEnvelope } from "../dto/result.js";
import type { SidebarSection } from "../dto/types.js";
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
    patch(mutate: (sections: SidebarSection[]) => SidebarSection[], write?: {
        dryRun?: boolean;
        allowWrite?: boolean;
        verify?: boolean;
    }): Promise<ResultEnvelope<{
        sections: SidebarSection[];
        verified?: boolean;
        note: string;
    }>>;
    createSection(name: string, write?: {
        dryRun?: boolean;
        allowWrite?: boolean;
    }): Promise<ResultEnvelope<{
        sections: SidebarSection[];
        verified?: boolean;
        note: string;
    }>>;
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
    moveBot(agentId: string, toSectionId: string, write?: {
        dryRun?: boolean;
        allowWrite?: boolean;
    }): Promise<ResultEnvelope<{
        sections: SidebarSection[];
        verified?: boolean;
        note: string;
    }>>;
    private fromErr;
}
/**
 * Semantic diff: section order (by id) and names are meaningful; agent_ids are
 * compared as a set (in-section ordering changes are not treated as mismatch).
 */
export declare function diffSections(expected: SidebarSection[], actual: SidebarSection[]): string[];
