/**
 * Open a local URL with the platform browser helper.
 * `gbc auth login` only writes an event to stderr and does not actually open a
 * browser; the local dashboard command does this itself.
 */
export declare function openInBrowser(url: string): Promise<{
    ok: boolean;
    error?: string;
}>;
