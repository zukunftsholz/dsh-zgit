/**
 * Core operations: the zgit_* tool bodies, shared with the /zgit command.
 * Every function takes a {@link ZerogitRuntime} (limits + tokens + workspace)
 * and an AbortSignal, and returns the canonical value the tool schema
 * declares. No Cordis imports here — the core is plain logic over
 * `node:fs`, `node:crypto`, and the forge/http modules.
 * @module dsh-zgit/core
 */
import type { CheckoutMeta, CloneSummary, CompareFile, DownloadResult, LogEntry, ReleaseFetchResult, StatusResult, TreeEntry, ZerogitRuntime } from './types.ts';
/** Common per-call options. */
export interface CallOptions {
    signal?: AbortSignal;
    /**
     * Per-call workspace root override — the calling session's workspace
     * (`exec.agent.session.header.cwd`) when a tool call runs on behalf of an
     * agent. Falls back to the runtime root for agentless callers.
     */
    workspaceRoot?: string;
}
/** `zgit_ls_remote` arguments. */
export interface LsRemoteArgs {
    repo: string;
    ref?: string;
}
/** `zgit_ls_remote` output. */
export interface LsRemoteResult {
    forge: string;
    host: string;
    owner: string;
    repo: string;
    defaultBranch: string | undefined;
    ref: string | undefined;
    resolvedSha: string | undefined;
    branches: {
        name: string;
        sha: string;
    }[];
    tags: {
        name: string;
        sha: string;
    }[];
    latestReleaseTag: string | undefined;
}
/** `zgit_clone` arguments. */
export interface CloneArgs {
    repo: string;
    ref?: string;
    dir?: string;
    subdir?: string;
    archiveUrl?: string;
    archiveKind?: 'tar.gz' | 'zip';
    stripRoot?: boolean;
    replace?: boolean;
}
/** `zgit_show` arguments. */
export interface ShowArgs {
    repo: string;
    path: string;
    ref?: string;
    saveTo?: string;
}
/** `zgit_show` output. */
export interface ShowResult {
    repo: string;
    path: string;
    ref: string;
    sha: string | undefined;
    text: string;
    truncated: boolean;
    binary: boolean;
    bytes: number;
}
/** `zgit_ls_tree` arguments. */
export interface LsTreeArgs {
    repo: string;
    path?: string;
    ref?: string;
}
/** `zgit_ls_tree` output. */
export interface LsTreeResult {
    repo: string;
    ref: string;
    sha: string;
    prefix: string | undefined;
    entries: TreeEntry[];
    truncated: boolean;
}
/** `zgit_log` arguments. */
export interface LogArgs {
    repo: string;
    ref?: string;
    count?: number;
}
/** `zgit_log` output. */
export interface LogResult {
    repo: string;
    ref: string;
    sha: string;
    entries: LogEntry[];
}
/** `zgit_diff` arguments. */
export interface DiffArgs {
    repo: string;
    base?: string;
    head: string;
    path?: string;
}
/** `zgit_diff` output. */
export interface DiffResult {
    repo: string;
    base: string;
    head: string;
    baseSha?: string;
    headSha?: string;
    commits: LogEntry[];
    files: CompareFile[];
    totalAdditions: number;
    totalDeletions: number;
    singleFile?: {
        path: string;
        status: string;
        patch: string | undefined;
        patchTruncated: boolean;
    };
}
/** `zgit_status` arguments. */
export interface StatusArgs {
    dir: string;
    repo?: string;
}
/** `zgit_fetch_release` arguments. */
export interface ReleaseArgs {
    repo: string;
    tag?: string;
    pattern?: string;
    all?: boolean;
    dir?: string;
}
/** `zgit_download` arguments. */
export interface DownloadArgs {
    url: string;
    path?: string;
    sha256?: string;
}
export declare function matchGlob(pattern: string, name: string): boolean;
/** Compute the sha256 hex digest of bytes. */
export declare function sha256Of(bytes: Uint8Array): string;
/** Read `.zerogit/meta.json` from a simulated checkout directory. */
export declare function readCheckoutMeta(dirAbs: string): Promise<CheckoutMeta>;
/** zgit_ls_remote: branches, tags, ref resolution, latest release. */
export declare function lsRemote(runtime: ZerogitRuntime, args: LsRemoteArgs, options?: CallOptions): Promise<LsRemoteResult>;
/** zgit_clone: simulated clone — archive download + extract + .zerogit meta. */
export declare function cloneSource(runtime: ZerogitRuntime, args: CloneArgs, options?: CallOptions): Promise<CloneSummary>;
/** zgit_show: fetch one raw file at a ref. */
export declare function showFile(runtime: ZerogitRuntime, args: ShowArgs, options?: CallOptions): Promise<ShowResult>;
/** zgit_ls_tree: list files at a ref. */
export declare function lsTree(runtime: ZerogitRuntime, args: LsTreeArgs, options?: CallOptions): Promise<LsTreeResult>;
/** zgit_log: recent commits at a ref. */
export declare function log(runtime: ZerogitRuntime, args: LogArgs, options?: CallOptions): Promise<LogResult>;
/** zgit_diff: compare two refs (summary or single-file patch). */
export declare function diff(runtime: ZerogitRuntime, args: DiffArgs, options?: CallOptions): Promise<DiffResult>;
/** zgit_status: check a simulated checkout against the remote. */
export declare function status(runtime: ZerogitRuntime, args: StatusArgs, options?: CallOptions): Promise<StatusResult>;
/** zgit_fetch_release: list or download release assets. */
export declare function fetchReleaseAssets(runtime: ZerogitRuntime, args: ReleaseArgs, options?: CallOptions): Promise<ReleaseFetchResult>;
/** zgit_download: fetch any direct URL into the workspace. */
export declare function download(runtime: ZerogitRuntime, args: DownloadArgs, options?: CallOptions): Promise<DownloadResult>;
/** Small helper to render an error message without the stack. */
export declare function errorMessage(error: unknown): string;
/**
 * Deep-strip `undefined`-valued properties in place so the value survives the
 * tool registry's lossless-JSON snapshot. The registry rejects any own key
 * whose value is `undefined` (`snapshotJsonValue`), so optional fields must be
 * absent, not `undefined`, in the canonical tool output. The values are fresh
 * per call, so in-place mutation is safe.
 */
export declare function lossless<T>(value: T): T;
//# sourceMappingURL=core.d.ts.map