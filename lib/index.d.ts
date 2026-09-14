/**
 * dsh-zgit — "zero-git" plugin for the DeepSeek Harness.
 *
 * When you need source code or binary releases from a git host, the first
 * thought is not `git clone` but a plain-HTTPS fetch: source archives
 * (codeload-style tar.gz/zip) extracted into a *simulated checkout* with
 * `.zerogit` metadata, release assets with sha256 verification, raw-file
 * peeks, tree/log/diff over the forge APIs, and a generic direct download.
 * No git binary, no clone, no runtime dependencies.
 *
 * The bundle patch mounts this plugin on the host plane; its tools register
 * into the global tools layer, visible to every agent, and the `/zgit`
 * command joins the human command plane when the deployment mounts
 * `@deepseek-ai/dsh-commands`.
 * @module dsh-zgit
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { ForgeKind } from './types.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "dsh-zgit";
/** Services required by the plugin. */
export declare const inject: string[];
/** Plugin config: tool toggles, limits, workspace root, and forge tokens. */
export interface Config {
    /** Register `zgit_ls_remote`. Defaults to true. */
    lsRemote?: boolean;
    /** Register `zgit_clone`. Defaults to true. */
    clone?: boolean;
    /** Register `zgit_fetch_release`. Defaults to true. */
    release?: boolean;
    /** Register `zgit_show`. Defaults to true. */
    show?: boolean;
    /** Register `zgit_ls_tree`. Defaults to true. */
    lsTree?: boolean;
    /** Register `zgit_log`. Defaults to true. */
    log?: boolean;
    /** Register `zgit_diff`. Defaults to true. */
    diff?: boolean;
    /** Register `zgit_status`. Defaults to true. */
    status?: boolean;
    /** Register `zgit_download`. Defaults to true. */
    download?: boolean;
    /** Register the `/zgit` human command. Defaults to true. */
    command?: boolean;
    /** Cooperative tool-call timeout budget (ms). Defaults to 120000. */
    timeoutMs?: number;
    /** Max source-archive bytes (zgit_clone). Defaults to 512 MiB. */
    maxArchiveBytes?: number;
    /** Max generic download bytes. Defaults to 1 GiB. */
    maxDownloadBytes?: number;
    /** Max raw-file bytes (zgit_show). Defaults to 256 KiB. */
    maxFileBytes?: number;
    /** Max tree entries listed (zgit_ls_tree). Defaults to 5000. */
    maxTreeEntries?: number;
    /** Max commits listed (zgit_log / zgit_ls_remote refs). Defaults to 30. */
    maxLogCommits?: number;
    /** Max diff characters (zgit_diff). Defaults to 100000. */
    maxDiffChars?: number;
    /** Max entries extracted from one archive. Defaults to 100000. */
    maxExtractedEntries?: number;
    /** Workspace root for writes from agentless callers and non-agent commands. Defaults to process.cwd(); the calling session's workspace (session header cwd) wins for every tool call and /zgit command on behalf of an agent. */
    workspaceRoot?: string;
    /** User-Agent header. Defaults to `dsh-zgit/<version>`. */
    userAgent?: string;
    /** Direct forge tokens. */
    tokens?: Partial<Record<ForgeKind, string>>;
    /** Environment variable names holding forge tokens (checked before `tokens`). */
    tokenEnv?: Partial<Record<ForgeKind, string>>;
}
export declare const Config: z<Config>;
/**
 * Register the zgit tools, the prompt guidance, and the `/zgit` command.
 * Tool registrations are effect-scoped, so unloading the plugin removes
 * everything it contributed.
 */
export declare function apply(ctx: Context, config: Config): void;
export { parseRepoSpec, apiBase, archiveUrlFor, rawUrlFor, fetchDefaultBranch, fetchRefs, resolveCommit, resolveRepoRef, resolveRefSmart, clearForgeCaches, isRateLimitError, rateLimitHint, branchResolutionError, type SmartResolve, fetchRawFile, fetchTree, fetchCommits, fetchCompare, fetchRelease, fetchLatestReleaseTag } from './forge.ts';
export { extractArchive, detectArchiveKind, sanitizeEntryPath, type ArchiveKind, type ExtractOptions, type ExtractSummary } from './archive.ts';
export { matchGlob, sha256Of, readCheckoutMeta, lossless, cloneSource, showFile, lsTree, log, diff, status, fetchReleaseAssets, download, lsRemote, errorMessage } from './core.ts';
export { tokenize, parseFlags, runZgitCommand } from './command.ts';
export { isPrivateHostname, isPrivateUrl, privateBypass, assertPublicUrl } from './http.ts';
export { createWorkspace, safeDirName, type Workspace } from './fs-util.ts';
export type { RepoRef, ResolvedCommit, RefEntry, TreeEntry, LogEntry, CompareFile, ReleaseAsset, ReleaseInfo, CloneSummary, CheckoutMeta, StatusResult, DownloadResult, ZerogitRuntime } from './types.ts';
//# sourceMappingURL=index.d.ts.map