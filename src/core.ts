/**
 * Core operations: the zgit_* tool bodies, shared with the /zgit command.
 * Every function takes a {@link ZerogitRuntime} (limits + tokens + workspace)
 * and an AbortSignal, and returns the canonical value the tool schema
 * declares. No Cordis imports here — the core is plain logic over
 * `node:fs`, `node:crypto`, and the forge/http modules.
 * @module dsh-zgit/core
 */

import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { extractArchive, detectArchiveKind, type ArchiveKind } from './archive.ts'
import { RepoSpecError, ZgError } from './errors.ts'
import { createWorkspace, safeDirName } from './fs-util.ts'
import {
  archiveUrlFor,
  fetchCommits,
  fetchCompare,
  fetchDefaultBranch,
  fetchLatestReleaseTag,
  fetchRawFile,
  fetchRefs,
  fetchRelease,
  fetchTree,
  parseRepoSpec,
  requestHeaders,
  resolveCommit,
  resolveRefSmart,
  type SmartResolve,
} from './forge.ts'
import { httpBytes } from './http.ts'
import type {
  CheckoutMeta,
  CloneSummary,
  CompareFile,
  DownloadResult,
  LogEntry,
  ReleaseFetchResult,
  RepoRef,
  StatusResult,
  TreeEntry,
  ZerogitRuntime,
} from './types.ts'

/** Common per-call options. */
export interface CallOptions {
  signal?: AbortSignal
  /**
   * Per-call workspace root override — the calling session's workspace
   * (`exec.agent.session.header.cwd`) when a tool call runs on behalf of an
   * agent. Falls back to the runtime root for agentless callers.
   */
  workspaceRoot?: string
}

/** `zgit_ls_remote` arguments. */
export interface LsRemoteArgs {
  repo: string
  ref?: string
}

/** `zgit_ls_remote` output. */
export interface LsRemoteResult {
  forge: string
  host: string
  owner: string
  repo: string
  defaultBranch: string | undefined
  ref: string | undefined
  resolvedSha: string | undefined
  branches: { name: string; sha: string }[]
  tags: { name: string; sha: string }[]
  latestReleaseTag: string | undefined
}

/** `zgit_clone` arguments. */
export interface CloneArgs {
  repo: string
  ref?: string
  dir?: string
  subdir?: string
  archiveUrl?: string
  archiveKind?: 'tar.gz' | 'zip'
  stripRoot?: boolean
  replace?: boolean
}

/** `zgit_show` arguments. */
export interface ShowArgs {
  repo: string
  path: string
  ref?: string
  saveTo?: string
}

/** `zgit_show` output. */
export interface ShowResult {
  repo: string
  path: string
  ref: string
  sha: string | undefined
  text: string
  truncated: boolean
  binary: boolean
  bytes: number
}

/** `zgit_ls_tree` arguments. */
export interface LsTreeArgs {
  repo: string
  path?: string
  ref?: string
}

/** `zgit_ls_tree` output. */
export interface LsTreeResult {
  repo: string
  ref: string
  sha: string
  prefix: string | undefined
  entries: TreeEntry[]
  truncated: boolean
}

/** `zgit_log` arguments. */
export interface LogArgs {
  repo: string
  ref?: string
  count?: number
}

/** `zgit_log` output. */
export interface LogResult {
  repo: string
  ref: string
  sha: string
  entries: LogEntry[]
}

/** `zgit_diff` arguments. */
export interface DiffArgs {
  repo: string
  base?: string
  head: string
  path?: string
}

/** `zgit_diff` output. */
export interface DiffResult {
  repo: string
  base: string
  head: string
  baseSha?: string
  headSha?: string
  commits: LogEntry[]
  files: CompareFile[]
  totalAdditions: number
  totalDeletions: number
  singleFile?: {
    path: string
    status: string
    patch: string | undefined
    patchTruncated: boolean
  }
}

/** `zgit_status` arguments. */
export interface StatusArgs {
  dir: string
  repo?: string
}

/** `zgit_fetch_release` arguments. */
export interface ReleaseArgs {
  repo: string
  tag?: string
  pattern?: string
  all?: boolean
  dir?: string
}

/** `zgit_download` arguments. */
export interface DownloadArgs {
  url: string
  path?: string
  sha256?: string
}

/** Glob match against an asset name (supports `*`, `?`, and `**` directory segments). */
const BACKSLASH = String.fromCharCode(92)
export function matchGlob(pattern: string, name: string): boolean {
  const ESCAPE = new Set(['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', BACKSLASH])
  let regex = ''
  const chars = pattern.split('')
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!
    if (char === '*') {
      if (chars[index + 1] === '*') {
        if (chars[index + 2] === '/') {
          regex += '(?:.*/)?'
          index += 2
        } else {
          regex += '.*'
          index += 1
        }
      } else {
        regex += '[^/]*'
      }
    } else if (char === '?') {
      regex += '[^/]'
    } else {
      regex += ESCAPE.has(char) ? BACKSLASH + char : char
    }
  }
  return new RegExp('^' + regex + '$').test(name)
}

/** Compute the sha256 hex digest of bytes. */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Read `.zerogit/meta.json` from a simulated checkout directory. */
export async function readCheckoutMeta(dirAbs: string): Promise<CheckoutMeta> {
  const metaPath = join(dirAbs, '.zerogit', 'meta.json')
  let raw: string
  try {
    raw = await readFile(metaPath, 'utf8')
  } catch {
    throw new ZgError(`"${dirAbs}" is not a zgit simulated checkout (missing .zerogit/meta.json); clone it first with zgit_clone`)
  }
  try {
    const parsed = JSON.parse(raw) as CheckoutMeta
    if (parsed.version !== 1 || typeof parsed.owner !== 'string' || typeof parsed.repo !== 'string' || typeof parsed.sha !== 'string') {
      throw new Error('malformed meta')
    }
    // Pre-shaResolved checkouts (v0.1.0) always resolved their sha.
    parsed.shaResolved = parsed.shaResolved !== false
    return parsed
  } catch (error: unknown) {
    throw new ZgError(`.zerogit/meta.json in "${dirAbs}" is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** Resolve the forge headers for one repo. */
function headersFor(runtime: ZerogitRuntime, repo: RepoRef): Record<string, string> {
  return requestHeaders(runtime, repo)
}

/** Resolve a ref (defaulting to the default branch) with rate-limit degradation. */
async function resolveRef(runtime: ZerogitRuntime, repo: RepoRef, ref: string | undefined, signal: AbortSignal | undefined, requireSha = false): Promise<SmartResolve> {
  return resolveRefSmart(repo, ref, { signal, headers: headersFor(runtime, repo) }, requireSha)
}

/* ── operations ─────────────────────────────────────────────────────────── */

/** zgit_ls_remote: branches, tags, ref resolution, latest release. */
export async function lsRemote(runtime: ZerogitRuntime, args: LsRemoteArgs, options: CallOptions = {}): Promise<LsRemoteResult> {
  const repo = parseRepoSpec(args.repo)
  if (repo.kind === 'generic') throw new RepoSpecError(`host "${repo.host}" has no known API; cannot list refs`)
  const headers = headersFor(runtime, repo)
  const cap = Math.min(runtime.maxLogCommits, 100)
  const [defaultBranch, refs, latestReleaseTag] = await Promise.all([
    fetchDefaultBranch(repo, { signal: options.signal, headers }).catch(() => undefined),
    fetchRefs(repo, { signal: options.signal, headers }, cap),
    fetchLatestReleaseTag(repo, { signal: options.signal, headers }),
  ])
  let resolvedSha: string | undefined
  if (args.ref !== undefined) {
    const resolved = await resolveCommit(repo, args.ref, { signal: options.signal, headers })
    resolvedSha = resolved.sha
  }
  return {
    forge: repo.kind,
    host: repo.host,
    owner: repo.owner,
    repo: repo.repo,
    defaultBranch,
    ref: args.ref,
    resolvedSha,
    branches: refs.branches,
    tags: refs.tags,
    latestReleaseTag,
  }
}

/** zgit_clone: simulated clone — archive download + extract + .zerogit meta. */
export async function cloneSource(runtime: ZerogitRuntime, args: CloneArgs, options: CallOptions = {}): Promise<CloneSummary> {
  const repo = parseRepoSpec(args.repo)
  const workspace = createWorkspace(options.workspaceRoot ?? runtime.workspaceRoot)
  const signal = options.signal

  const { sha, ref, defaultBranch, shaResolved } = await resolveRef(runtime, repo, args.ref, signal)
  const archiveKind: ArchiveKind = args.archiveKind ?? 'tar.gz'
  // A resolved sha pins the archive exactly; an unresolved one falls back to
  // the ref itself — the archive endpoints accept branch/tag names directly
  // and are not API-rate-limited.
  const archiveUrl = args.archiveUrl ?? archiveUrlFor(repo, shaResolved ? sha : ref, archiveKind)

  const fallbackDir = `${safeDirName(repo.repo)}@${sha === 'unknown' ? safeDirName(ref) : sha.slice(0, 12)}`
  const targetDir = workspace.resolve(args.dir ?? fallbackDir)

  // Refuse to clobber anything that is not a previous zgit checkout.
  const existing = await stat(targetDir).catch(() => undefined)
  if (existing !== undefined) {
    const isZgitCheckout = await stat(join(targetDir, '.zerogit', 'meta.json')).then(() => true).catch(() => false)
    if (args.replace === true) {
      if (!isZgitCheckout && !(await isEmptyDir(targetDir))) {
        throw new ZgError(`refusing to replace "${workspace.display(targetDir)}": it is not a zgit checkout (pass a fresh dir or remove it first)`)
      }
      await rm(targetDir, { recursive: true, force: true })
    } else if (!(await isEmptyDir(targetDir))) {
      throw new ZgError(`target directory "${workspace.display(targetDir)}" already exists; pass replace: true to overwrite a previous zgit checkout or choose another dir`)
    }
  }

  const started = Date.now()
  const { bytes, contentType } = await httpBytes(archiveUrl, {
    signal,
    headers: { 'User-Agent': runtime.userAgent },
    maxBytes: runtime.maxArchiveBytes,
  })
  const kind = detectArchiveKind(archiveUrl, bytes)
  if (contentType !== undefined && contentType.includes('text/html')) {
    // A forge error page served with 200; the extractor would reject it, but
    // report a friendlier message when the payload is clearly HTML.
    const head = new TextDecoder().decode(bytes.slice(0, 256)).toLowerCase()
    if (head.includes('<!doctype html') || head.includes('<html')) {
      throw new ZgError(`archive download returned an HTML page instead of an archive (is "${args.repo}" private or the ref wrong?)`)
    }
  }

  await mkdir(targetDir, { recursive: true })
  const summary = await extractArchive(kind, bytes, {
    targetDir,
    stripRoot: args.stripRoot ?? true,
    subdir: args.subdir,
    maxEntries: runtime.maxExtractedEntries,
    maxTotalBytes: runtime.maxArchiveBytes,
  })

  const meta: CheckoutMeta = {
    version: 1,
    forge: repo.kind,
    host: repo.host,
    scheme: repo.scheme,
    owner: repo.owner,
    repo: repo.repo,
    ref,
    sha,
    shaResolved,
    archiveUrl,
    archiveKind: kind,
    fetchedAt: new Date().toISOString(),
    files: summary.files,
    totalBytes: summary.totalBytes,
    subdir: args.subdir,
  }
  await mkdir(join(targetDir, '.zerogit'), { recursive: true })
  await writeFile(join(targetDir, '.zerogit', 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  await writeFile(join(targetDir, '.zerogit', 'HEAD'), `${sha}\n`, 'utf8')

  return {
    forge: repo.kind,
    host: repo.host,
    owner: repo.owner,
    repo: repo.repo,
    ref,
    sha,
    shaResolved,
    defaultBranch,
    archiveUrl,
    archiveKind: kind,
    archiveBytes: bytes.length,
    targetDir: workspace.display(targetDir),
    files: summary.files,
    dirs: summary.dirs,
    totalBytes: summary.totalBytes,
    symlinksSkipped: summary.symlinksSkipped.length,
    hardlinksCopied: summary.hardlinksCopied,
    metaPath: workspace.display(join(targetDir, '.zerogit', 'meta.json')),
    fetchedAt: meta.fetchedAt,
    elapsedMs: Date.now() - started,
  }
}

async function isEmptyDir(dir: string): Promise<boolean> {
  return (await readdir(dir)).length === 0
}

/** zgit_show: fetch one raw file at a ref. */
export async function showFile(runtime: ZerogitRuntime, args: ShowArgs, options: CallOptions = {}): Promise<ShowResult> {
  const repo = parseRepoSpec(args.repo)
  const { sha, ref } = await resolveRef(runtime, repo, args.ref, options.signal)
  const headers = headersFor(runtime, repo)
  const { text, truncated } = await fetchRawFile(repo, args.path, ref, { signal: options.signal, headers }, runtime.maxFileBytes)
  const probe = text.slice(0, 8192)
  const binary = probe.includes('\0')
  if (!binary && args.saveTo !== undefined) {
    const workspace = createWorkspace(options.workspaceRoot ?? runtime.workspaceRoot)
    const dest = workspace.resolve(args.saveTo)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, text, 'utf8')
  }
  return {
    repo: `${repo.owner}/${repo.repo}`,
    path: args.path,
    ref,
    sha: sha === 'unknown' ? undefined : sha,
    text: binary ? '' : text,
    truncated,
    binary,
    bytes: new TextEncoder().encode(text).byteLength,
  }
}

/** zgit_ls_tree: list files at a ref. */
export async function lsTree(runtime: ZerogitRuntime, args: LsTreeArgs, options: CallOptions = {}): Promise<LsTreeResult> {
  const repo = parseRepoSpec(args.repo)
  const { sha, ref } = await resolveRef(runtime, repo, args.ref, options.signal)
  const { entries, truncated } = await fetchTree(repo, ref, args.path, { signal: options.signal, headers: headersFor(runtime, repo) }, runtime.maxTreeEntries)
  return { repo: `${repo.owner}/${repo.repo}`, ref, sha, prefix: args.path, entries, truncated }
}

/** zgit_log: recent commits at a ref. */
export async function log(runtime: ZerogitRuntime, args: LogArgs, options: CallOptions = {}): Promise<LogResult> {
  const repo = parseRepoSpec(args.repo)
  const { sha, ref } = await resolveRef(runtime, repo, args.ref, options.signal)
  const count = Math.min(Math.max(1, args.count ?? runtime.maxLogCommits), 50)
  const entries = await fetchCommits(repo, ref, count, { signal: options.signal, headers: headersFor(runtime, repo) })
  return { repo: `${repo.owner}/${repo.repo}`, ref, sha, entries }
}

/** zgit_diff: compare two refs (summary or single-file patch). */
export async function diff(runtime: ZerogitRuntime, args: DiffArgs, options: CallOptions = {}): Promise<DiffResult> {
  const repo = parseRepoSpec(args.repo)
  const headers = headersFor(runtime, repo)
  const defaultBranch = repo.kind === 'generic' ? undefined : await fetchDefaultBranch(repo, { signal: options.signal, headers }).catch(() => undefined)
  const base = args.base ?? defaultBranch
  if (base === undefined) throw new RepoSpecError(`no base ref given and the default branch of ${repo.owner}/${repo.repo} could not be determined`)
  const baseResolved = repo.kind === 'generic' ? undefined : await resolveCommit(repo, base, { signal: options.signal, headers }).catch(() => undefined)
  const headResolved = repo.kind === 'generic' ? undefined : await resolveCommit(repo, args.head, { signal: options.signal, headers }).catch(() => undefined)
  const { files, commits } = await fetchCompare(repo, base, args.head, { signal: options.signal, headers }, 200)

  let totalAdditions = 0
  let totalDeletions = 0
  for (const file of files) {
    totalAdditions += file.additions
    totalDeletions += file.deletions
  }

  let singleFile: DiffResult['singleFile']
  if (args.path !== undefined) {
    const match = files.find(file => file.path === args.path)
    if (match === undefined) {
      throw new ZgError(`"${args.path}" did not change between ${base} and ${args.head}`)
    }
    const patch = match.patch
    const patchTruncated = patch !== undefined && patch.length > runtime.maxDiffChars
    singleFile = {
      path: match.path,
      status: match.status,
      patch: patch === undefined ? undefined : patch.slice(0, runtime.maxDiffChars),
      patchTruncated,
    }
  }

  return {
    repo: `${repo.owner}/${repo.repo}`,
    base,
    head: args.head,
    baseSha: baseResolved?.sha,
    headSha: headResolved?.sha,
    commits,
    files,
    totalAdditions,
    totalDeletions,
    singleFile,
  }
}

/** zgit_status: check a simulated checkout against the remote. */
export async function status(runtime: ZerogitRuntime, args: StatusArgs, options: CallOptions = {}): Promise<StatusResult> {
  const workspace = createWorkspace(options.workspaceRoot ?? runtime.workspaceRoot)
  const dirAbs = workspace.resolve(args.dir)
  const meta = await readCheckoutMeta(dirAbs)
  const repo: RepoRef = args.repo !== undefined
    ? parseRepoSpec(args.repo)
    : { kind: meta.forge, host: meta.host, scheme: meta.scheme ?? 'https', owner: meta.owner, repo: meta.repo, ref: meta.ref }
  const headers = headersFor(runtime, repo)
  // Status needs a real remote sha: resolution failures (rate limit/offline)
  // surface with the actionable cause instead of degrading.
  const resolved = await resolveRef(runtime, repo, meta.ref, options.signal, true)
  const localShaKnown = meta.shaResolved !== false && meta.sha !== 'unknown'
  const upToDate = localShaKnown && resolved.sha === meta.sha
  let behindBy: number | null = 0
  let newCommits: LogEntry[] = []
  if (!upToDate && repo.kind !== 'generic' && localShaKnown) {
    const compare = await fetchCompare(repo, meta.sha, resolved.sha, { signal: options.signal, headers }, 20)
      .catch(() => undefined)
    if (compare !== undefined) {
      behindBy = compare.commits.length
      newCommits = compare.commits.slice(0, 10)
    } else {
      behindBy = null
      newCommits = await fetchCommits(repo, resolved.sha, 10, { signal: options.signal, headers }).catch(() => [])
    }
  } else if (!localShaKnown) {
    // The checkout was created without a resolved sha (rate limit at clone
    // time); report the remote head and let the user re-clone to pin it.
    behindBy = null
  }
  return {
    dir: workspace.display(dirAbs),
    meta,
    remoteSha: resolved.sha,
    upToDate,
    behindBy,
    newCommits,
    checkedAt: new Date().toISOString(),
  }
}

/** zgit_fetch_release: list or download release assets. */
export async function fetchReleaseAssets(runtime: ZerogitRuntime, args: ReleaseArgs, options: CallOptions = {}): Promise<ReleaseFetchResult> {
  const repo = parseRepoSpec(args.repo)
  if (repo.kind === 'generic') throw new RepoSpecError(`host "${repo.host}" has no known releases API`)
  const release = await fetchRelease(repo, args.tag, { signal: options.signal, headers: headersFor(runtime, repo) })
  if (release === undefined) {
    throw new ZgError(`no release found for ${repo.owner}/${repo.repo}${args.tag !== undefined ? ` at tag "${args.tag}"` : ''}`)
  }
  if (args.pattern === undefined && args.all !== true) {
    return {
      forge: repo.kind,
      owner: repo.owner,
      repo: repo.repo,
      tagName: release.tagName,
      targetDir: '',
      assets: [],
      listed: release.assets,
    }
  }

  const matching = args.all === true
    ? release.assets
    : release.assets.filter(asset => matchGlob(args.pattern!, asset.name))
  if (matching.length === 0) {
    throw new ZgError(`no asset matches pattern "${args.pattern}" in release ${release.tagName} (${release.assets.length} assets available)`)
  }

  // Create the target directory only after the match set is known, so a
  // failed selection never leaves an empty directory behind.
  const workspace = createWorkspace(options.workspaceRoot ?? runtime.workspaceRoot)
  const targetDir = workspace.resolve(args.dir ?? `${safeDirName(repo.repo)}-release-${safeDirName(release.tagName)}`)
  await mkdir(targetDir, { recursive: true })

  const downloaded: DownloadResult[] = []
  for (const asset of matching) {
    const { bytes } = await httpBytes(asset.url, {
      signal: options.signal,
      headers: { 'User-Agent': runtime.userAgent },
      maxBytes: runtime.maxDownloadBytes,
    })
    const dest = join(targetDir, asset.name)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, bytes)
    downloaded.push({ url: asset.url, path: workspace.display(dest), size: bytes.length, sha256: sha256Of(bytes), contentType: undefined })
  }

  const assets = downloaded.map(item => ({
    name: basename(item.path),
    size: item.size,
    sha256: item.sha256,
    path: item.path,
    verified: false,
  }))

  // Verify checksums when the release ships sha256/sha512 companion files.
  const verified = await verifyReleaseChecksums(targetDir, assets)
  return {
    forge: repo.kind,
    owner: repo.owner,
    repo: repo.repo,
    tagName: release.tagName,
    targetDir: workspace.display(targetDir),
    assets: verified,
  }
}

/** Verify downloaded assets against .sha256/.sha512 companion files, when present. */
async function verifyReleaseChecksums(dirAbs: string, assets: ReleaseFetchResult['assets']): Promise<ReleaseFetchResult['assets']> {
  const out = assets.map(asset => ({ ...asset }))
  const byName = new Map(out.map(asset => [asset.name, asset]))
  for (const asset of out) {
    for (const algorithm of ['sha256', 'sha512'] as const) {
      if (!asset.name.endsWith(`.${algorithm}`)) continue
      const baseName = asset.name.slice(0, -(algorithm.length + 1))
      const base = byName.get(baseName)
      if (base === undefined) continue
      try {
        const content = await readFile(join(dirAbs, asset.name), 'utf8')
        const expected = parseChecksumFile(content, baseName)
        if (expected === undefined) continue
        const actual = createHash(algorithm).update(await readFile(join(dirAbs, baseName))).digest('hex')
        if (actual.toLowerCase() === expected.toLowerCase()) {
          base.verified = true
          asset.verified = true
        }
      } catch {
        // A malformed checksum file is not fatal; report the asset unverified.
      }
    }
  }
  return out
}

/** Extract the hex digest for `fileName` from a checksum file. */
function parseChecksumFile(content: string, fileName: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split(/\s+/)
    const hex = parts[0]
    if (hex === undefined || !/^[0-9a-fA-F]{16,}$/.test(hex)) continue
    const rest = trimmed.slice(hex.length).trim()
    if (rest.length === 0 || rest === fileName || rest.endsWith(`/${fileName}`) || rest.startsWith('*')) {
      if (rest.startsWith('*')) {
        const star = rest.slice(1).replace(/^\.?\//, '')
        if (star === fileName) return hex
        continue
      }
      return hex
    }
  }
  return undefined
}

/** zgit_download: fetch any direct URL into the workspace. */
export async function download(runtime: ZerogitRuntime, args: DownloadArgs, options: CallOptions = {}): Promise<DownloadResult> {
  const workspace = createWorkspace(options.workspaceRoot ?? runtime.workspaceRoot)
  const dest = workspace.resolve(args.path ?? (basename(new URL(args.url).pathname) || 'download.bin'))
  const { bytes, contentType } = await httpBytes(args.url, {
    signal: options.signal,
    headers: { 'User-Agent': runtime.userAgent },
    maxBytes: runtime.maxDownloadBytes,
  })
  const digest = sha256Of(bytes)
  if (args.sha256 !== undefined) {
    const expected = args.sha256.trim().toLowerCase()
    if (digest !== expected) {
      throw new ZgError(`sha256 mismatch for ${args.url}: expected ${expected}, got ${digest} (file not written)`)
    }
  }
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, bytes)
  return { url: args.url, path: workspace.display(dest), size: bytes.length, sha256: digest, contentType }
}

/** Small helper to render an error message without the stack. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Deep-strip `undefined`-valued properties in place so the value survives the
 * tool registry's lossless-JSON snapshot. The registry rejects any own key
 * whose value is `undefined` (`snapshotJsonValue`), so optional fields must be
 * absent, not `undefined`, in the canonical tool output. The values are fresh
 * per call, so in-place mutation is safe.
 */
export function lossless<T>(value: T): T {
  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) walk(item)
      return
    }
    if (current === null || typeof current !== 'object') return
    const record = current as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (record[key] === undefined) {
        delete record[key]
      } else {
        walk(record[key])
      }
    }
  }
  walk(value)
  return value
}
