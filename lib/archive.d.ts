/**
 * Pure-Node archive extraction: tar.gz (ustar + GNU long names + pax) and zip
 * (central-directory, store + deflate, zip64, CRC32-verified), with traversal
 * and bomb guards. Zero dependencies: `node:zlib` does all compression work.
 * @module dsh-zgit/archive
 */
export type ArchiveKind = 'tar.gz' | 'zip';
/** One normalized archive entry, ready for extraction. */
export interface ArchiveEntry {
    /** Sanitized relative path with '/' separators. */
    path: string;
    kind: 'file' | 'dir';
    /** File content (files only). */
    data?: Uint8Array;
    /** Hardlink target path (hardlinks only). */
    linkTarget?: string;
    /** Symlink target string (symlinks only). */
    symlinkTarget?: string;
}
/** Extraction options. */
export interface ExtractOptions {
    /** Absolute directory to extract into (created as needed). */
    targetDir: string;
    /** Strip the single top-level folder (git-clone-like layout). */
    stripRoot: boolean;
    /** Extract only entries under this repo-relative path prefix. */
    subdir: string | undefined;
    /** Max entries accepted from the archive. */
    maxEntries: number;
    /** Max total uncompressed bytes written. */
    maxTotalBytes: number;
}
/** Extraction outcome. */
export interface ExtractSummary {
    files: number;
    dirs: number;
    totalBytes: number;
    /** Symlink entries skipped (materializing them is unsafe/privileged). */
    symlinksSkipped: string[];
    hardlinksCopied: number;
    /** The stripped top-level folder name, when stripRoot applied. */
    strippedRoot: string | undefined;
}
/** Detect the archive kind from URL/extension or magic bytes. */
export declare function detectArchiveKind(url: string, bytes: Uint8Array): ArchiveKind;
/** Sanitize one archive path: reject traversal, absolutes, and reserved names. */
export declare function sanitizeEntryPath(name: string): string;
/** Extract a tar.gz archive. */
export declare function extractTarGz(bytes: Uint8Array, options: ExtractOptions): Promise<ExtractSummary>;
/** Extract a zip archive (entries read directly from the downloaded bytes). */
export declare function extractZip(bytes: Uint8Array, options: ExtractOptions): Promise<ExtractSummary>;
/** Extract an archive of a detected kind into the target directory. */
export declare function extractArchive(kind: ArchiveKind, bytes: Uint8Array, options: ExtractOptions): Promise<ExtractSummary>;
//# sourceMappingURL=archive.d.ts.map