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

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-commands'
import { applyZgitTools, type ZgitToolName } from './tools.ts'
import { runZgitCommand } from './command.ts'
import type { ForgeKind, ZerogitRuntime } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-zgit'

/** Services required by the plugin. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config: tool toggles, limits, workspace root, and forge tokens. */
export interface Config {
  /** Register `zgit_ls_remote`. Defaults to true. */
  lsRemote?: boolean
  /** Register `zgit_clone`. Defaults to true. */
  clone?: boolean
  /** Register `zgit_fetch_release`. Defaults to true. */
  release?: boolean
  /** Register `zgit_show`. Defaults to true. */
  show?: boolean
  /** Register `zgit_ls_tree`. Defaults to true. */
  lsTree?: boolean
  /** Register `zgit_log`. Defaults to true. */
  log?: boolean
  /** Register `zgit_diff`. Defaults to true. */
  diff?: boolean
  /** Register `zgit_status`. Defaults to true. */
  status?: boolean
  /** Register `zgit_download`. Defaults to true. */
  download?: boolean
  /** Register the `/zgit` human command. Defaults to true. */
  command?: boolean
  /** Cooperative tool-call timeout budget (ms). Defaults to 120000. */
  timeoutMs?: number
  /** Max source-archive bytes (zgit_clone). Defaults to 512 MiB. */
  maxArchiveBytes?: number
  /** Max generic download bytes. Defaults to 1 GiB. */
  maxDownloadBytes?: number
  /** Max raw-file bytes (zgit_show). Defaults to 256 KiB. */
  maxFileBytes?: number
  /** Max tree entries listed (zgit_ls_tree). Defaults to 5000. */
  maxTreeEntries?: number
  /** Max commits listed (zgit_log / zgit_ls_remote refs). Defaults to 30. */
  maxLogCommits?: number
  /** Max diff characters (zgit_diff). Defaults to 100000. */
  maxDiffChars?: number
  /** Max entries extracted from one archive. Defaults to 100000. */
  maxExtractedEntries?: number
  /** Workspace root for writes from agentless callers and non-agent commands. Defaults to process.cwd(); the calling session's workspace (session header cwd) wins for every tool call and /zgit command on behalf of an agent. */
  workspaceRoot?: string
  /** User-Agent header. Defaults to `dsh-zgit/<version>`. */
  userAgent?: string
  /** Direct forge tokens. */
  tokens?: Partial<Record<ForgeKind, string>>
  /** Environment variable names holding forge tokens (checked before `tokens`). */
  tokenEnv?: Partial<Record<ForgeKind, string>>
}

export const Config: z<Config> = z.object({
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
  userAgent: z.string().default('dsh-zgit/0.2.2'),
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
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

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
}

/** Config values must be positive integers where they are limits. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-zgit: ${name} must be a positive integer`)
  }
}

/** Resolve a forge token: env var first (by name), then direct config. */
function resolveToken(envName: string | undefined, direct: string | undefined): string | undefined {
  if (envName !== undefined && envName.length > 0) {
    const fromEnv = process.env[envName]
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  }
  return direct !== undefined && direct.length > 0 ? direct : undefined
}

/** Build the runtime the tools and command share. */
function buildRuntime(config: ResolvedConfig): ZerogitRuntime {
  const tokens: Partial<Record<ForgeKind, string>> = {}
  for (const kind of ['github', 'gitlab', 'gitee'] as const) {
    const token = resolveToken(config.tokenEnv[kind], config.tokens[kind])
    if (token !== undefined) tokens[kind] = token
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
  }
}

/** Map config toggles to the tool registration set. */
function enabledTools(config: ResolvedConfig): Record<ZgitToolName, boolean> {
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
  }
}

/**
 * Register the zgit tools, the prompt guidance, and the `/zgit` command.
 * Tool registrations are effect-scoped, so unloading the plugin removes
 * everything it contributed.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  for (const key of ['timeoutMs', 'maxArchiveBytes', 'maxDownloadBytes', 'maxFileBytes', 'maxTreeEntries', 'maxLogCommits', 'maxDiffChars', 'maxExtractedEntries'] as const) {
    assertPositiveInteger(key, resolved[key])
  }
  const runtime = buildRuntime(resolved)

  ctx.systemPrompt.section(ZGIT_PROMPT_SECTION)
  applyZgitTools(ctx, runtime, enabledTools(resolved))

  const commands = ctx.get('commands')
  if (resolved.command && commands !== undefined) {
    // Use the resolved service value: property access (`ctx.commands`) requires
    // an `inject` declaration, which would hard-depend on the command registry
    // in deployments (headless) that omit it.
    commands.register({
      name: 'zgit',
      description: 'Fetch source code and release binaries without git (clone/get/show/ls/log/diff/resolve/status/download)',
      input: { hint: 'clone <repo> [dir] | get <repo> [tag] [pattern] | show <repo> <path> | status <dir> | download <url>' },
      handler: invocation => runZgitCommand(runtime, invocation.rawInput, invocation.signal, invocation.agent.session.header.cwd),
    })
  }
}

// Re-exports for integrators and tests.
export { parseRepoSpec, apiBase, archiveUrlFor, rawUrlFor, fetchDefaultBranch, fetchRefs, resolveCommit, resolveRepoRef, resolveRefSmart, clearForgeCaches, isRateLimitError, rateLimitHint, branchResolutionError, type SmartResolve, fetchRawFile, fetchTree, fetchCommits, fetchCompare, fetchRelease, fetchLatestReleaseTag } from './forge.ts'
export { extractArchive, detectArchiveKind, sanitizeEntryPath, type ArchiveKind, type ExtractOptions, type ExtractSummary } from './archive.ts'
export { matchGlob, sha256Of, readCheckoutMeta, lossless, cloneSource, showFile, lsTree, log, diff, status, fetchReleaseAssets, download, lsRemote, errorMessage } from './core.ts'
export { tokenize, parseFlags, runZgitCommand } from './command.ts'
export { isPrivateHostname, isPrivateUrl, privateBypass, assertPublicUrl } from './http.ts'
export { createWorkspace, safeDirName, type Workspace } from './fs-util.ts'
export type { RepoRef, ResolvedCommit, RefEntry, TreeEntry, LogEntry, CompareFile, ReleaseAsset, ReleaseInfo, CloneSummary, CheckoutMeta, StatusResult, DownloadResult, ZerogitRuntime } from './types.ts'
