import { Archive } from "./fs.js";
import { type ObjectReader } from "./decode.js";
import { type FetchFn, type TransferBudget } from "./attachments.js";
import type { Entry } from "./core.js";
export type HydrateStats = {
    needed: number;
    recovered: number;
    decode_failed: number;
    failed: number;
    cached_version: number;
    skipped_deterministic: number;
    version_adopted: number;
    inline_observed: number;
    inline_decode_failed: number;
    omitted_observed: number;
    blob_observed: number;
    requests: number;
    reread_pages: number;
    archive_body_skipped: number;
    network_bytes: number;
    generation_changed: boolean;
};
export declare const hydrationCoverage: (rows: Entry[], readObject?: ObjectReader) => {
    retained_rows: number;
    observed_inline: number;
    observed_omitted: number;
    observed_blob_ref: number;
    hydrated_version_bound: number;
    decoded: number;
    unavailable_or_unsupported: number;
    current_membership: string;
};
export declare function hydrateEntries(rows: Entry[], ctx: {
    archive: Archive;
    fetchImpl: FetchFn;
    call: (method: string, request: any) => Promise<any>;
    maxRequests: number;
    maxBodyBytes: number;
    budget: TransferBudget;
    maxArchiveBytes?: number;
    /** Seqs observed in this pull page set — hydrated before older archive rows. */
    prioritySeqs?: Set<string>;
}): Promise<HydrateStats>;
