/**
 * Forge knowledge: repo-spec parsing, endpoint builders, and normalized API
 * calls for GitHub, GitLab, and Gitee (plus archive/raw URL guessing for
 * generic GitHub-style hosts). All responses are normalized into the small
 * value types in `types.ts`; a forge quirk lives here and nowhere else.
 * @module dsh-zgit/forge
 */
import type { CompareFile, ForgeKind, LogEntry, RefEntry, ReleaseInfo, RepoRef, ResolvedCommit, TreeEntry, ZerogitRuntime } from './types.ts';
/** Clear the in-memory forge caches (tests). */
export declare function clearForgeCaches(): void;
/** Whether an error is a forge API rate-limit response (403/429). */
export declare function isRateLimitError(error: unknown): boolean;
/** Actionable hint text for rate-limit errors, or undefined. */
export declare function rateLimitHint(error: unknown): string | undefined;
/** Build an actionable error for a failed default-branch lookup. */
export declare function branchResolutionError(repo: RepoRef, error: unknown): string;
/** Result of a resilient ref resolution (see {@link resolveRefSmart}). */
export interface SmartResolve {
    sha: string;
    ref: string;
    defaultBranch: string | undefined;
    /** False when the sha could not be resolved and the ref is used directly. */
    shaResolved: boolean;
}
/**
 * Resolve a ref with graceful degradation:
 * - An explicit ref never triggers a default-branch API call (only a cached
 *   value is reported); sha resolution is attempted but a rate limit or
 *   network failure degrades to `sha: 'unknown'` — archives and raw files
 *   accept refs directly, so clone/show keep working without the API.
 * - A missing ref requires the default branch (API), and failures surface
 *   with the real cause instead of a generic message.
 * - `requireSha` callers (status) propagate resolution failures instead of
 *   degrading, with the rate-limit hint attached.
 */
export declare function resolveRefSmart(repo: RepoRef, ref: string | undefined, options: ApiCallOptions, requireSha?: boolean): Promise<SmartResolve>;
/**
 * Parse any accepted repo reference into a {@link RepoRef}:
 * - `owner/repo`, `owner/repo@ref`
 * - `https://host/owner/repo[.git][@ref][/tree/ref]`
 * - `git@host:owner/repo.git[@ref]`, `ssh://git@host/owner/repo.git[@ref]`
 */
export declare function parseRepoSpec(input: string): RepoRef;
/** API base per forge kind. */
export declare function apiBase(kind: ForgeKind): string;
/** Common headers for one request, including auth when a token is known. */
export declare function requestHeaders(runtime: ZerogitRuntime, repo: RepoRef): Record<string, string>;
interface ApiCallOptions {
    signal?: AbortSignal;
    headers: Record<string, string>;
}
/** Fetch repo metadata; returns the default branch name when available (cached). */
export declare function fetchDefaultBranch(repo: RepoRef, options: ApiCallOptions): Promise<string | undefined>;
/** List branches and tags (capped) with their commit shas. */
export declare function fetchRefs(repo: RepoRef, options: ApiCallOptions, cap: number): Promise<{
    branches: RefEntry[];
    tags: RefEntry[];
}>;
/** Resolve any ref (branch/tag/sha) to a commit sha (cached). */
export declare function resolveCommit(repo: RepoRef, ref: string, options: ApiCallOptions): Promise<ResolvedCommit>;
/** Resolve the repo's ref (defaulting to the default branch) to a commit sha. */
export declare function resolveRepoRef(repo: RepoRef, options: ApiCallOptions): Promise<{
    resolved: ResolvedCommit;
    defaultBranch: string | undefined;
}>;
/** Build the source-archive download URL for a repo at an exact sha. */
export declare function archiveUrlFor(repo: RepoRef, sha: string, kind?: 'tar.gz' | 'zip'): string;
/** Build the raw-file URL for a repo at a ref (GitHub/Gitee/generic path scheme). */
export declare function rawUrlFor(repo: RepoRef, path: string, ref: string): string;
/** Fetch a raw file through the forge API (GitLab only; others use rawUrlFor). */
export declare function fetchRawFile(repo: RepoRef, path: string, ref: string, options: ApiCallOptions, maxBytes: number): Promise<{
    text: string;
    truncated: boolean;
}>;
/** List the tree at a ref, optionally filtered to a path prefix. */
export declare function fetchTree(repo: RepoRef, ref: string, prefix: string | undefined, options: ApiCallOptions, cap: number): Promise<{
    entries: TreeEntry[];
    truncated: boolean;
}>;
/** List recent commits at a ref. */
export declare function fetchCommits(repo: RepoRef, ref: string, count: number, options: ApiCallOptions): Promise<LogEntry[]>;
/** Compare two refs; returns changed files (with patches when cheap) plus commits. */
export declare function fetchCompare(repo: RepoRef, base: string, head: string, options: ApiCallOptions, cap: number): Promise<{
    files: CompareFile[];
    commits: LogEntry[];
    truncated: boolean;
}>;
/** Fetch one release (latest by default) with its assets. Returns undefined when no release exists. */
export declare function fetchRelease(repo: RepoRef, tag: string | undefined, options: ApiCallOptions): Promise<ReleaseInfo | undefined>;
/** Fetch the latest release tag, or undefined when the repo has no releases. */
export declare function fetchLatestReleaseTag(repo: RepoRef, options: ApiCallOptions): Promise<string | undefined>;
export {};
//# sourceMappingURL=forge.d.ts.map