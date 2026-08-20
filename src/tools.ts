/**
 * The model-facing zgit_* tools: schemas, canonical values, and renderers over
 * the core operations. Every tool is registered into the global tools layer
 * (host plane), so all agents see them; enablement is per-tool config.
 * @module dsh-zgit/tools
 */

import {
  defineTool,
  type GenericCallView,
  type ParameterSchemaSpec,
  type ToolExecution,
  type ValueSchemaSpec,
} from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ZerogitRuntime } from './types.ts'
import {
  cloneSource,
  diff,
  download,
  fetchReleaseAssets,
  log,
  lossless,
  lsRemote,
  lsTree,
  showFile,
  status,
  type CallOptions,
} from './core.ts'

/** A text content block, structurally compatible with the registry's ContentBlock. */
type TextBlock = { type: 'text'; text: string }

/** Pending-call card: titled by the repo/URL so the UI shows intent. */
function presentCall(title: string, rawInput: unknown): GenericCallView {
  return { card: 'generic', kind: 'other', title, rawInput: JSON.stringify(rawInput) }
}

/** Text block helper. */
function text(content: string): TextBlock[] {
  return [{ type: 'text', text: content }]
}

/** Format bytes human-readably. */
function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

const shortSha = (sha: string): string => sha.slice(0, 12)

/** Schema builders over the author-facing value-schema DSL. */
const str = (description: string, required = false): { type: 'string'; description: string; required?: true } => ({ type: 'string', description, ...(required ? { required: true } : {}) })
const num = (description: string, required = false): { type: 'integer'; description: string; required?: true } => ({ type: 'integer', description, ...(required ? { required: true } : {}) })
const bool = (description: string, required = false): { type: 'boolean'; description: string; required?: true } => ({ type: 'boolean', description, ...(required ? { required: true } : {}) })
const obj = <P extends ParameterSchemaSpec>(properties: P) => ({ type: 'object' as const, additionalProperties: false, properties })
const arr = <I extends ValueSchemaSpec>(items: I) => ({ type: 'array' as const, items })

/** A commit-entry schema (shared by log/status/diff). */
const commitSchema = () => obj({
  sha: str('commit sha', true),
  author: str('author name', true),
  date: str('ISO date', true),
  subject: str('commit subject', true),
})

/**
 * The calling session's workspace — the session header cwd — when this tool
 * call runs on behalf of an agent. Mirroring the filesystem/shell tools,
 * every zgit write resolves inside the CALLING session's workspace (not the
 * server launch dir), so downloads land in the agent's project folder.
 * Returns undefined for agentless callers; the runtime root then applies.
 */
function sessionWorkspace(exec: ToolExecution): string | undefined {
  return exec.agent?.session?.header?.cwd
}

/** Register every enabled zgit tool on the context. */
export function applyZgitTools(ctx: Context, runtime: ZerogitRuntime, enabled: Record<ZgitToolName, boolean>): void {
  const call = (exec: ToolExecution): CallOptions => {
    const workspaceRoot = sessionWorkspace(exec)
    return workspaceRoot === undefined
      ? { signal: exec.signal }
      : { signal: exec.signal, workspaceRoot }
  }

  if (enabled.lsRemote) {
    ctx.tools.register(defineTool({
      name: 'zgit_ls_remote',
      description: 'List the branches and tags of a git repository and resolve a ref to its commit sha over the forge API — a git ls-remote without git. Accepts owner/repo, owner/repo@ref, or a full URL.',
      parameters: {
        repo: { type: 'string', required: true, description: 'Repository reference, e.g. "deepseek-ai/deepseek-harness" or "https://github.com/deepseek-ai/deepseek-harness@main".' },
        ref: { type: 'string', description: 'Optional branch/tag/commit to resolve to a sha.' },
      },
      output: {
        schema: obj({
          forge: str('forge kind', true),
          host: str('host', true),
          owner: str('owner', true),
          repo: str('repo', true),
          defaultBranch: str('default branch'),
          ref: str('resolved ref'),
          resolvedSha: str('resolved commit sha'),
          branches: arr(obj({ name: str('branch name', true), sha: str('commit sha', true) })),
          tags: arr(obj({ name: str('tag name', true), sha: str('commit sha', true) })),
          latestReleaseTag: str('latest release tag'),
        }),
        render: (_args, value) => text(renderLsRemote(value)),
      },
      timeoutMs: runtime.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return lossless(await lsRemote(runtime, { repo: args.repo, ref: args.ref }, call(exec)))
      },
      presentCall: args => presentCall(args.repo, args),
    }))
  }

  if (enabled.clone) {
    ctx.tools.register(defineTool({
      name: 'zgit_clone',
      description: 'Simulated git clone: download a repository\'s source archive at a ref over plain HTTPS (no git binary) and extract it into the workspace as a "simulated checkout" with .zerogit metadata. Supports GitHub, GitLab, Gitee, and any archive URL.',
      parameters: {
        repo: { type: 'string', required: true, description: 'Repository reference, e.g. "owner/repo@main" or a full https/git/ssh URL.' },
        ref: { type: 'string', description: 'Branch, tag, or commit sha; defaults to the default branch.' },
        dir: { type: 'string', description: 'Target directory under the workspace; defaults to "<repo>@<short-sha>".' },
        subdir: { type: 'string', description: 'Extract only this repo-relative subdirectory (sparse checkout).' },
        archiveUrl: { type: 'string', description: 'Explicit archive URL (tar.gz or zip) instead of the forge-built one; useful for mirrors.' },
        archiveKind: { type: 'string', enum: ['tar.gz', 'zip'], description: 'Archive format when archiveUrl is given and the extension is ambiguous.' },
        stripRoot: { type: 'boolean', description: 'Strip the single top-level archive folder; defaults to true.' },
        replace: { type: 'boolean', description: 'Overwrite an existing zgit checkout at the target directory.' },
      },
      output: {
        schema: obj({
          forge: str('forge kind', true),
          host: str('host', true),
          owner: str('owner', true),
          repo: str('repo', true),
          ref: str('resolved ref', true),
          sha: str('commit sha ("unknown" when unresolved)', true),
          shaResolved: bool('sha resolved via the forge API', true),
          defaultBranch: str('default branch'),
          archiveUrl: str('archive url', true),
          archiveKind: str('archive kind', true),
          archiveBytes: num('archive bytes', true),
          targetDir: str('workspace-relative target directory', true),
          files: num('extracted files', true),
          dirs: num('extracted dirs', true),
          totalBytes: num('extracted bytes', true),
          symlinksSkipped: num('symlinks skipped', true),
          hardlinksCopied: num('hardlinks copied', true),
          metaPath: str('meta file path', true),
          fetchedAt: str('ISO fetched-at', true),
          elapsedMs: num('elapsed ms', true),
        }),
        render: (_args, value) => text(renderClone(value)),
      },
      timeoutMs: runtime.timeoutMs,
      async execute(args, exec) {
        return lossless(await cloneSource(runtime, {
          repo: args.repo,
          ref: args.ref,
          dir: args.dir,
          subdir: args.subdir,
          archiveUrl: args.archiveUrl,
          archiveKind: args.archiveKind,
          stripRoot: args.stripRoot,
          replace: args.replace,
        }, call(exec)))
      },
      presentCall: args => presentCall(args.repo, args),
    }))
  }

  if (enabled.show) {
    ctx.tools.register(defineTool({
      name: 'zgit_show',
      description: 'Fetch one raw file from a repository at a ref over plain HTTPS (git show without git). Optionally save it into the workspace.',
      parameters: {
        repo: { type: 'string', required: true, description: 'Repository reference, e.g. "owner/repo@main".' },
        path: { type: 'string', required: true, description: 'File path inside the repository.' },
        ref: { type: 'string', description: 'Branch, tag, or commit sha; defaults to the default branch.' },
        saveTo: { type: 'string', description: 'Optional workspace path to save the file to.' },
      },
      output: {
        schema: obj({
          repo: str('repo', true),
          path: str('file path', true),
          ref: str('resolved ref', true),
          sha: str('commit sha'),
          text: str('file content', true),
          truncated: bool('content truncated by the cap', true),
          binary: bool('binary content detected', true),
          bytes: num('returned bytes', true),
        }),
        render: (_args, value) => text(renderShow(value)),
      },
      timeoutMs: runtime.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return lossless(await showFile(runtime, { repo: args.repo, path: args.path, ref: args.ref, saveTo: args.saveTo }, call(exec)))
      },
      presentCall: args => presentCall(args.repo, args),
    }))
  }

  if (enabled.lsTree) {
    ctx.tools.register(defineTool({
      name: 'zgit_ls_tree',
      description: 'List the files and directories of a repository at a ref over the forge API (git ls-tree without git), optionally under a path prefix.',
      parameters: {
        repo: { type: 'string', required: true, description: 'Repository reference, e.g. "owner/repo@main".' },
        path: { type: 'string', description: 'Only list entries under this path prefix.' },
        ref: { type: 'string', description: 'Branch, tag, or commit sha; defaults to the default branch.' },
      },
      output: {
        schema: obj({
          repo: str('repo', true),
          ref: str('resolved ref', true),
          sha: str('commit sha', true),
          prefix: str('path prefix'),
          entries: arr(obj({
            path: str('entry path', true),
            type: str('blob|tree|submodule', true),
            size: num('size in bytes'),
          })),
          truncated: bool('listing truncated', true),
        }),
        render: (_args, value) => text(renderLsTree(value)),
      },
      timeoutMs: runtime.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return lossless(await lsTree(runtime, { repo: args.repo, path: args.path, ref: args.ref }, call(exec)))
      },
      presentCall: args => presentCall(args.repo, args),
    }))
  }

  if (enabled.log) {
    ctx.tools.register(defineTool({
      name: 'zgit_log',
      description: 'List the recent commits of a repository at a ref over the forge API (git log without git).',
      parameters: {
        repo: { type: 'string', required: true, description: 'Repository reference, e.g. "owner/repo@main".' },
        ref: { type: 'string', description: 'Branch, tag, or commit sha; defaults to the default branch.' },
        count: { type: 'integer', description: 'Max commits to list (1-50); defaults to the configured cap.' },
      },
      output: {
        schema: obj({
          repo: str('repo', true),
          ref: str('resolved ref', true),
          sha: str('commit sha', true),
          entries: arr(commitSchema()),
        }),
        render: (_args, value) => text(renderLog(value)),
      },
      timeoutMs: runtime.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return lossless(await log(runtime, { repo: args.repo, ref: args.ref, count: args.count }, call(exec)))
      },
      presentCall: args => presentCall(args.repo, args),
    }))
  }

  if (enabled.diff) {
    ctx.tools.register(defineTool({
      name: 'zgit_diff',
      description: 'Compare two refs of a repository over the forge API (git diff without git): a changed-files summary, or the unified diff of one file.',
      parameters: {
        repo: { type: 'string', required: true, description: 'Repository reference, e.g. "owner/repo".' },
        head: { type: 'string', required: true, description: 'The head ref (branch, tag, or sha).' },
        base: { type: 'string', description: 'The base ref; defaults to the default branch.' },
        path: { type: 'string', description: 'Restrict to the unified diff of this single file path.' },
      },
      output: {
        schema: obj({
          repo: str('repo', true),
          base: str('base ref', true),
          head: str('head ref', true),
          baseSha: str('base commit sha'),
          headSha: str('head commit sha'),
          commits: arr(commitSchema()),
          files: arr(obj({
            path: str('file path', true),
            status: str('added|modified|deleted|renamed', true),
            additions: num('added lines', true),
            deletions: num('deleted lines', true),
            patch: str('unified diff text'),
          })),
          totalAdditions: num('total added lines', true),
          totalDeletions: num('total deleted lines', true),
          singleFile: obj({
            path: str('file path', true),
            status: str('change status', true),
            patch: str('unified diff text'),
            patchTruncated: bool('patch truncated by the cap', true),
          }),
        }),
        render: (_args, value) => text(renderDiff(value)),
      },
      timeoutMs: runtime.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return lossless(await diff(runtime, { repo: args.repo, head: args.head, base: args.base, path: args.path }, call(exec)))
      },
      presentCall: args => presentCall(args.repo, args),
    }))
  }

  if (enabled.status) {
    ctx.tools.register(defineTool({
      name: 'zgit_status',
      description: 'Check a previous zgit simulated checkout (a directory with .zerogit/meta.json) against its remote: whether the pinned ref moved and how many new commits exist (git status + fetch check without git).',
      parameters: {
        dir: { type: 'string', required: true, description: 'Directory of the simulated checkout, relative to the workspace.' },
        repo: { type: 'string', description: 'Optional override repository reference; defaults to the one recorded in the checkout meta.' },
      },
      output: {
        schema: obj({
          dir: str('checkout directory', true),
          meta: obj({
            version: num('meta schema version', true),
            forge: str('forge kind', true),
            host: str('host', true),
            scheme: str('url scheme'),
            owner: str('owner', true),
            repo: str('repo', true),
            ref: str('pinned ref', true),
            sha: str('pinned commit sha', true),
            shaResolved: bool('sha was resolved at clone time'),
            archiveUrl: str('archive url', true),
            archiveKind: str('archive kind', true),
            fetchedAt: str('ISO fetched-at', true),
            files: num('extracted files', true),
            totalBytes: num('extracted bytes', true),
            subdir: str('extracted subdir'),
          }),
          remoteSha: str('current remote commit sha', true),
          upToDate: bool('checkout is current', true),
          behindBy: { oneOf: [num('commits the remote is ahead'), { type: 'null' as const }] },
          newCommits: arr(commitSchema()),
          checkedAt: str('ISO checked-at', true),
        }),
        render: (_args, value) => text(renderStatus(value)),
      },
      timeoutMs: runtime.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return lossless(await status(runtime, { dir: args.dir, repo: args.repo }, call(exec)))
      },
      presentCall: args => presentCall(args.dir, args),
    }))
  }

  if (enabled.release) {
    ctx.tools.register(defineTool({
      name: 'zgit_fetch_release',
      description: 'List or download the binary release assets of a repository (GitHub/GitLab/Gitee): latest or a pinned tag, with optional glob asset patterns and sha256 verification — release binaries without a git checkout.',
      parameters: {
        repo: { type: 'string', required: true, description: 'Repository reference, e.g. "owner/repo".' },
        tag: { type: 'string', description: 'Release tag; defaults to the latest release.' },
        pattern: { type: 'string', description: 'Glob pattern to select asset names (e.g. "*.zip", "**/*.sha256"); omit to list assets.' },
        all: { type: 'boolean', description: 'Download every asset of the release.' },
        dir: { type: 'string', description: 'Target directory under the workspace; defaults to "<repo>-release-<tag>".' },
      },
      output: {
        schema: obj({
          forge: str('forge kind', true),
          owner: str('owner', true),
          repo: str('repo', true),
          tagName: str('release tag', true),
          targetDir: str('workspace-relative target directory', true),
          assets: arr(obj({
            name: str('asset name', true),
            size: num('bytes', true),
            sha256: str('sha256 hex', true),
            path: str('workspace-relative path', true),
            verified: bool('checksum verified', true),
          })),
          listed: arr(obj({
            name: str('asset name', true),
            size: num('bytes'),
            url: str('download url', true),
          })),
        }),
        render: (_args, value) => text(renderRelease(value)),
      },
      timeoutMs: runtime.timeoutMs,
      async execute(args, exec) {
        return lossless(await fetchReleaseAssets(runtime, { repo: args.repo, tag: args.tag, pattern: args.pattern, all: args.all, dir: args.dir }, call(exec)))
      },
      presentCall: args => presentCall(args.repo, args),
    }))
  }

  if (enabled.download) {
    ctx.tools.register(defineTool({
      name: 'zgit_download',
      description: 'Download any direct HTTP(S) URL (binary, archive, toolchain) into the workspace with a byte cap and optional sha256 verification — the generic agile fetch for anything a forge API cannot express.',
      parameters: {
        url: { type: 'string', required: true, description: 'The direct download URL.' },
        path: { type: 'string', description: 'Destination path under the workspace; defaults to the URL basename.' },
        sha256: { type: 'string', description: 'Expected sha256 hex digest; the file is rejected on mismatch.' },
      },
      output: {
        schema: obj({
          url: str('download url', true),
          path: str('workspace-relative path', true),
          size: num('bytes', true),
          sha256: str('sha256 hex', true),
          contentType: str('content type'),
        }),
        render: (_args, value) => text(renderDownload(value)),
      },
      timeoutMs: runtime.timeoutMs,
      async execute(args, exec) {
        return lossless(await download(runtime, { url: args.url, path: args.path, sha256: args.sha256 }, call(exec)))
      },
      presentCall: args => presentCall(args.url, args),
    }))
  }
}

/* ── renderers ───────────────────────────────────────────────────────────── */

type AnyRecord = Record<string, any>

function renderLsRemote(value: AnyRecord): string {
  const lines = [
    `Refs of ${value.owner}/${value.repo} (${value.forge}, ${value.host})`,
  ]
  if (value.defaultBranch !== undefined) lines.push(`default branch: ${value.defaultBranch}`)
  if (value.resolvedSha !== undefined) lines.push(`${value.ref}: ${value.resolvedSha}`)
  if (value.latestReleaseTag !== undefined) lines.push(`latest release: ${value.latestReleaseTag}`)
  if (value.branches.length > 0) {
    lines.push('', `branches (${value.branches.length}):`)
    for (const branch of value.branches) lines.push(`  ${branch.name.padEnd(28)} ${shortSha(branch.sha)}`)
  }
  if (value.tags.length > 0) {
    lines.push('', `tags (${value.tags.length}):`)
    for (const tag of value.tags) lines.push(`  ${tag.name.padEnd(28)} ${shortSha(tag.sha)}`)
  }
  return lines.join('\n')
}

function renderClone(value: AnyRecord): string {
  const lines = [
    `Simulated clone: ${value.owner}/${value.repo}@${value.ref} → ${value.targetDir}`,
    `commit: ${value.sha}${value.shaResolved ? '' : ' (sha not resolved — ref used directly)'}${value.defaultBranch !== undefined ? ` (default branch: ${value.defaultBranch})` : ''}`,
    `extracted: ${value.files} files, ${value.dirs} dirs, ${fmtBytes(value.totalBytes)}`,
    `archive: ${value.archiveKind}, ${fmtBytes(value.archiveBytes)}, ${value.elapsedMs} ms`,
  ]
  if (value.symlinksSkipped > 0) lines.push(`symlinks skipped (not materialized): ${value.symlinksSkipped}`)
  if (value.hardlinksCopied > 0) lines.push(`hardlinks copied: ${value.hardlinksCopied}`)
  lines.push(`meta: ${value.metaPath}`)
  return lines.join('\n')
}

function renderShow(value: AnyRecord): string {
  const head = `=== ${value.path} @ ${value.ref}${value.sha !== undefined ? ` (${value.sha})` : ''} ===`
  if (value.binary) {
    return `${head}\n[binary file, ${fmtBytes(value.bytes)}; use zgit_download or zgit_clone to fetch it]`
  }
  const body = value.text
  return `${head}\n${body}${value.truncated ? '\n\n(truncated: the file is larger than the configured cap)' : ''}`
}

function renderLsTree(value: AnyRecord): string {
  const lines = [`Tree of ${value.repo} @ ${value.ref} (${value.sha.slice(0, 12)})${value.prefix !== undefined ? ` under "${value.prefix}"` : ''}:`]
  for (const entry of value.entries) {
    const kind = entry.type === 'blob' ? 'blob' : entry.type === 'tree' ? 'dir ' : 'mod '
    const size = entry.size !== undefined ? String(entry.size).padStart(9) : '         '
    lines.push(`  ${kind} ${size}  ${entry.path}`)
  }
  if (value.truncated) lines.push(`(listing truncated at ${value.entries.length} entries)`)
  return lines.join('\n')
}

function renderLog(value: AnyRecord): string {
  const lines = [`Log of ${value.repo} @ ${value.ref} (${value.sha.slice(0, 12)}):`]
  for (const entry of value.entries) {
    lines.push(`  ${shortSha(entry.sha)}  ${entry.date.slice(0, 10)}  ${entry.author}  ${entry.subject}`)
  }
  return lines.join('\n')
}

function renderDiff(value: AnyRecord): string {
  if (value.singleFile !== undefined) {
    const file = value.singleFile
    const lines = [`Diff of ${file.path} (${file.status}) — ${value.base} → ${value.head}`]
    if (file.patch !== undefined) lines.push(file.patch)
    else lines.push('[no unified patch available for this file (binary or too large)]')
    if (file.patchTruncated) lines.push('\n(patch truncated to the configured character cap)')
    return lines.join('\n')
  }
  const lines = [
    `Diff summary ${value.repo}: ${value.base} → ${value.head} — ${value.commits.length} commits, ${value.files.length} files changed, +${value.totalAdditions} −${value.totalDeletions}`,
  ]
  for (const file of value.files) {
    lines.push(`  ${file.status.padEnd(10)} +${file.additions} −${file.deletions}  ${file.path}`)
  }
  return lines.join('\n')
}

function renderStatus(value: AnyRecord): string {
  const meta = value.meta
  const lines = [
    `${value.dir}: simulated checkout of ${meta.owner}/${meta.repo} @ ${meta.ref} (${meta.sha.slice(0, 12)}, fetched ${meta.fetchedAt.slice(0, 10)})`,
  ]
  if (value.upToDate) {
    lines.push('up to date with the remote')
  } else if (meta.sha === 'unknown' || meta.shaResolved === false) {
    lines.push(`local commit was not pinned at clone time; remote head is ${value.remoteSha.slice(0, 12)}`)
    lines.push('re-clone with zgit_clone (replace: true) to pin the commit')
  } else {
    const behind = value.behindBy === null ? '?' : String(value.behindBy)
    lines.push(`remote moved: ${behind} new commit${value.behindBy === 1 ? '' : 's'} (remote head ${value.remoteSha.slice(0, 12)})`)
    for (const commit of value.newCommits) {
      lines.push(`  ${shortSha(commit.sha)}  ${commit.date.slice(0, 10)}  ${commit.author}  ${commit.subject}`)
    }
    lines.push('re-clone with zgit_clone (replace: true) to refresh')
  }
  lines.push(`checked ${value.checkedAt}`)
  return lines.join('\n')
}

function renderRelease(value: AnyRecord): string {
  if (value.listed !== undefined && value.listed.length > 0) {
    const lines = [`Release ${value.owner}/${value.repo} @ ${value.tagName} — ${value.listed.length} assets:`]
    for (const asset of value.listed) {
      lines.push(`  ${(asset.name ?? '').padEnd(40)} ${asset.size !== undefined ? fmtBytes(asset.size).padStart(10) : '        '}  ${asset.url}`)
    }
    lines.push('download with zgit_fetch_release (pattern or all: true)')
    return lines.join('\n')
  }
  const lines = [`Downloaded release ${value.owner}/${value.repo} @ ${value.tagName} → ${value.targetDir}:`]
  for (const asset of value.assets) {
    lines.push(`  ${asset.name.padEnd(40)} ${fmtBytes(asset.size).padStart(10)}  sha256 ${asset.sha256.slice(0, 16)}…  ${asset.verified ? 'verified' : 'unverified'}`)
  }
  return lines.join('\n')
}

function renderDownload(value: AnyRecord): string {
  return `Downloaded ${value.url} → ${value.path} (${fmtBytes(value.size)}, sha256 ${value.sha256})`
}

/** Tool enablement keys. */
export type ZgitToolName = 'lsRemote' | 'clone' | 'show' | 'lsTree' | 'log' | 'diff' | 'status' | 'release' | 'download'
