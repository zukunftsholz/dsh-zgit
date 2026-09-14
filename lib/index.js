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
import z from '@deepseek-ai/schemastery';
import { applyZgitTools } from "./tools.js";
import { runZgitCommand } from "./command.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-zgit';
/** Services required by the plugin. */
export const inject = ['tools', 'systemPrompt'];
export const Config = z.object({
    lsRemote: z.boolean().default(true),
    clone: z.boolean().default(true),
    release: z.boolean().default(true),
    show: z.boolean().default(true),
    lsTree: z.boolean().default(true),
    log: z.boolean().default(true),
    diff: z.boolean().default(true),
    status: z.boolean().default(true),
    download: z.boolean().default(true),
    command: z.boolean().default(true),
    timeoutMs: z.number().default(120_000),
    maxArchiveBytes: z.number().default(512 * 1024 * 1024),
    maxDownloadBytes: z.number().default(1024 * 1024 * 1024),
    maxFileBytes: z.number().default(256 * 1024),
    maxTreeEntries: z.number().default(5_000),
    maxLogCommits: z.number().default(30),
    maxDiffChars: z.number().default(100_000),
    maxExtractedEntries: z.number().default(100_000),
    workspaceRoot: z.string().default(process.cwd()),
    userAgent: z.string().default('dsh-zgit/0.2.1'),
    tokens: z.object({
        github: z.string().default(''),
        gitlab: z.string().default(''),
        gitee: z.string().default(''),
    }).default({ github: '', gitlab: '', gitee: '' }),
    tokenEnv: z.object({
        github: z.string().default(''),
        gitlab: z.string().default(''),
        gitee: z.string().default(''),
    }).default({ github: '', gitlab: '', gitee: '' }),
});
/** The model-facing prompt guidance steering agents toward zgit first. */
const ZGIT_PROMPT_SECTION = {
    name: 'tool:zgit',
    order: 112,
    text: `When you need source code or binary release assets from a git repository (GitHub, GitLab, Gitee, or any archive URL), prefer the zgit_* tools over git:
- zgit_clone — simulated clone: downloads the source archive over plain HTTPS and extracts it into the workspace as a checkout with .zerogit metadata (no git binary, works for any ref).
- zgit_fetch_release — list or download release binaries (latest or a tag) with sha256 verification.
- zgit_show — fetch one raw file at a ref; zgit_ls_tree / zgit_log / zgit_diff / zgit_ls_remote — inspect without downloading.
- zgit_status — check whether a previous zgit checkout fell behind the remote.
- zgit_download — fetch any direct URL (mirrors, toolchains) into the workspace.
zgit targets repository content (archives, releases, raw files) and writes into the workspace; for plain web pages use the built-in web_fetch tool instead. Reach for the real git binary only when you must commit, push, or rewrite history.`,
};
/** Config values must be positive integers where they are limits. */
function assertPositiveInteger(name, value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`dsh-zgit: ${name} must be a positive integer`);
    }
}
/** Resolve a forge token: env var first (by name), then direct config. */
function resolveToken(envName, direct) {
    if (envName !== undefined && envName.length > 0) {
        const fromEnv = process.env[envName];
        if (fromEnv !== undefined && fromEnv.length > 0)
            return fromEnv;
    }
    return direct !== undefined && direct.length > 0 ? direct : undefined;
}
/** Build the runtime the tools and command share. */
function buildRuntime(config) {
    const tokens = {};
    for (const kind of ['github', 'gitlab', 'gitee']) {
        const token = resolveToken(config.tokenEnv[kind], config.tokens[kind]);
        if (token !== undefined)
            tokens[kind] = token;
    }
    return {
        workspaceRoot: config.workspaceRoot,
        userAgent: config.userAgent,
        timeoutMs: config.timeoutMs,
        maxArchiveBytes: config.maxArchiveBytes,
        maxDownloadBytes: config.maxDownloadBytes,
        maxFileBytes: config.maxFileBytes,
        maxTreeEntries: config.maxTreeEntries,
        maxLogCommits: config.maxLogCommits,
        maxDiffChars: config.maxDiffChars,
        maxExtractedEntries: config.maxExtractedEntries,
        tokens,
    };
}
/** Map config toggles to the tool registration set. */
function enabledTools(config) {
    return {
        lsRemote: config.lsRemote,
        clone: config.clone,
        show: config.show,
        lsTree: config.lsTree,
        log: config.log,
        diff: config.diff,
        status: config.status,
        release: config.release,
        download: config.download,
    };
}
/**
 * Register the zgit tools, the prompt guidance, and the `/zgit` command.
 * Tool registrations are effect-scoped, so unloading the plugin removes
 * everything it contributed.
 */
export function apply(ctx, config) {
    const resolved = config;
    for (const key of ['timeoutMs', 'maxArchiveBytes', 'maxDownloadBytes', 'maxFileBytes', 'maxTreeEntries', 'maxLogCommits', 'maxDiffChars', 'maxExtractedEntries']) {
        assertPositiveInteger(key, resolved[key]);
    }
    const runtime = buildRuntime(resolved);
    ctx.systemPrompt.section(ZGIT_PROMPT_SECTION);
    applyZgitTools(ctx, runtime, enabledTools(resolved));
    const commands = ctx.get('commands');
    if (resolved.command && commands !== undefined) {
        // Use the resolved service value: property access (`ctx.commands`) requires
        // an `inject` declaration, which would hard-depend on the command registry
        // in deployments (headless) that omit it.
        commands.register({
            name: 'zgit',
            description: 'Fetch source code and release binaries without git (clone/get/show/ls/log/diff/resolve/status/download)',
            input: { hint: 'clone <repo> [dir] | get <repo> [tag] [pattern] | show <repo> <path> | status <dir> | download <url>' },
            handler: invocation => runZgitCommand(runtime, invocation.rawInput, invocation.signal, invocation.agent.session.header.cwd),
        });
    }
}
// Re-exports for integrators and tests.
export { parseRepoSpec, apiBase, archiveUrlFor, rawUrlFor, fetchDefaultBranch, fetchRefs, resolveCommit, resolveRepoRef, resolveRefSmart, clearForgeCaches, isRateLimitError, rateLimitHint, branchResolutionError, fetchRawFile, fetchTree, fetchCommits, fetchCompare, fetchRelease, fetchLatestReleaseTag } from "./forge.js";
export { extractArchive, detectArchiveKind, sanitizeEntryPath } from "./archive.js";
export { matchGlob, sha256Of, readCheckoutMeta, lossless, cloneSource, showFile, lsTree, log, diff, status, fetchReleaseAssets, download, lsRemote, errorMessage } from "./core.js";
export { tokenize, parseFlags, runZgitCommand } from "./command.js";
export { isPrivateHostname, isPrivateUrl, privateBypass, assertPublicUrl } from "./http.js";
export { createWorkspace, safeDirName } from "./fs-util.js";
//# sourceMappingURL=index.js.map