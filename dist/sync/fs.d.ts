export declare function denied(message: string): never;
export declare function hash(s: string): string;
export declare function component(id: string): string;
/** Default (unlisted) session has empty session_id on the wire (App omits it). */
export declare function sessionComponent(id: string): string;
export declare class Archive {
    readonly root: string;
    constructor(root: string, create?: boolean);
    private directory;
    file(rel: string, parents?: boolean): string;
    read(rel: string, maxBytes?: number): string | undefined;
    json(rel: string): any;
    atomic(rel: string, text: string): void;
    writeJson(rel: string, data: unknown): void;
    syncDir(dir: string): void;
    lock(): () => void;
    stage(): {
        write: (bytes: Uint8Array) => void;
        commit: (target: string) => void;
        discard: () => void;
    };
    /** Binary counterpart of atomic(); never follows symlinks. */
    atomicBytes(rel: string, data: Uint8Array): void;
}
