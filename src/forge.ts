/**
 * Forge knowledge: repo-spec parsing, endpoint builders, and normalized API
 * calls for GitHub, GitLab, and Gitee (plus archive/raw URL guessing for
 * generic GitHub-style hosts). All responses are normalized into the small
 * value types in `types.ts`; a forge quirk lives here and nowhere else.
 * @module dsh-zgit/forge
 */

import { httpJson, httpText } from './http.ts'
import { HttpError, RepoSpecError, ZgError } from './errors.ts'
import type {
  CompareFile,
  ForgeKind,
  LogEntry,
  RefEntry,
  ReleaseAsset,
  ReleaseInfo,
  RepoRef,
  ResolvedCommit,
  TreeEntry,
  ZerogitRuntime,
} from './types.ts'

/** Known public forge host mapping. */
const FORGE_HOSTS: Record<string, ForgeKind> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'gitee.com': 'gitee',
}

/**
 * Small TTL cache for forge lookups. Unauthenticated GitHub API quota is 60
 * requests/hour per IP — repeated default-branch and ref resolutions across
 * tool calls burn it fast, so identical lookups within a few minutes are
 * served from memory. Best-effort only: entries evict on TTL or size.
 */
class TtlCache {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 256,
  ) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.value
  }

  set(key: string, value: string): void {
    if (this.entries.size >= this.maxEntries) {
      // Evict the oldest entry (Map preserves insertion order).
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs })
  }

  clear(): void {
    this.entries.clear()
  }
}

const defaultBranchCache = new TtlCache(5 * 60_000)
const commitCache = new TtlCache(5 * 60_000)

/** Clear the in-memory forge caches (tests). */
export function clearForgeCaches(): void {
  defaultBranchCache.clear()
  commitCache.clear()
}

/** Whether an error is a forge API rate-limit response (403/429 + message). */
export function isRateLimitError(error: unknown): boolean {
  return error instanceof HttpError
    && (error.status === 403 || error.status === 429)
    && /rate limit/i.test(error.message)
}

/** Actionable hint text for rate-limit errors, or undefined. */
export function rateLimitHint(error: unknown): string | undefined {
  if (!isRateLimitError(error)) return undefined
  return 'forge API rate limit exceeded — configure a token (tokens/tokenEnv) or pass an explicit ref'
}

/** Build an actionable error for a failed default-branch lookup. */
export function branchResolutionError(repo: RepoRef, error: unknown): string {
  const hint = rateLimitHint(error)
  if (hint !== undefined) {
    return `could not determine the default branch of ${repo.owner}/${repo.repo} (${hint})`
  }
  const detail = error instanceof Error ? error.message : String(error)
  return `could not determine the default branch of ${repo.owner}/${repo.repo}: ${detail}`
}

/** Result of a resilient ref resolution (see {@link resolveRefSmart}). */
export interface SmartResolve {
  sha: string
  ref: string
  defaultBranch: string | undefined
  /** False when the sha could not be resolved and the ref is used directly. */
  shaResolved: boolean
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
export async function resolveRefSmart(
  repo: RepoRef,
  ref: string | undefined,
  options: ApiCallOptions,
  requireSha = false,
): Promise<SmartResolve> {
  // An `owner/repo@ref` spec carries its ref on the repo; an explicit tool
  // argument wins over it.
  ref = ref ?? repo.ref
  if (repo.kind === 'generic') {
    if (ref === undefined) {
      throw new RepoSpecError(`no ref given for generic host "${repo.host}"; pass an explicit ref`)
    }
    return { sha: 'unknown', ref, defaultBranch: undefined, shaResolved: false }
  }

  let defaultBranch: string | undefined
  if (ref === undefined) {
    try {
      defaultBranch = await fetchDefaultBranch(repo, options)
    } catch (error) {
      throw new ZgError(branchResolutionError(repo, error), { cause: error })
    }
    if (defaultBranch === undefined) {
      throw new RepoSpecError(`the default branch of ${repo.owner}/${repo.repo} could not be determined`)
    }
    ref = defaultBranch
  } else {
    defaultBranch = defaultBranchCache.get(repoCacheKey(repo))
  }

  try {
    const resolved = await resolveCommit(repo, ref, options)
    return { sha: resolved.sha, ref, defaultBranch, shaResolved: true }
  } catch (error) {
    if (requireSha) {
      const hint = rateLimitHint(error)
      throw hint === undefined
        ? new ZgError(`could not resolve ref "${ref}" on ${repo.owner}/${repo.repo}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        : new ZgError(`could not resolve ref "${ref}" on ${repo.owner}/${repo.repo} (${hint})`, { cause: error })
    }
    return { sha: 'unknown', ref, defaultBranch, shaResolved: false }
  }
}

/** Cache key for one repo. */
function repoCacheKey(repo: RepoRef): string {
  return `${repo.kind}|${repo.owner}/${repo.repo}`
}

/** Guess the forge kind from a hostname; generic for anything else. */
function kindForHost(host: string): ForgeKind | 'generic' {
  return FORGE_HOSTS[host] ?? 'generic'
}

/** Whether a string looks like a plausible repo name component. */
const NAME_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Strip a trailing `.git` suffix from a repo name. */
function stripGitSuffix(name: string): string {
  return name.endsWith('.git') ? name.slice(0, -4) : name
}

/** Split `owner[/sub]/repo[@ref]` style input into parts (last segment is the repo). */
function splitOwnerRepo(input: string): { owner: string; repo: string; ref?: string } | undefined {
  let body = input
  let ref: string | undefined
  const at = body.indexOf('@')
  if (at !== -1) {
    ref = body.slice(at + 1)
    body = body.slice(0, at)
  }
  // Strip any trailing path such as `/tree/<ref>` from a web URL body.
  const treeMarker = body.indexOf('/tree/')
  if (treeMarker !== -1) {
    if (ref === undefined) ref = body.slice(treeMarker + '/tree/'.length)
    body = body.slice(0, treeMarker)
  }
  body = stripGitSuffix(body)
  const segments = body.split('/').filter(segment => segment.length > 0)
  if (segments.length < 2) return undefined
  const repo = segments[segments.length - 1]!
  const owner = segments.slice(0, -1).join('/')
  if (!NAME_COMPONENT.test(repo)) return undefined
  if (owner.split('/').some(part => !NAME_COMPONENT.test(part))) return undefined
  if (ref !== undefined && ref.length === 0) return undefined
  return { owner, repo, ref }
}

/**
 * Parse any accepted repo reference into a {@link RepoRef}:
 * - `owner/repo`, `owner/repo@ref`
 * - `https://host/owner/repo[.git][@ref][/tree/ref]`
 * - `git@host:owner/repo.git[@ref]`, `ssh://git@host/owner/repo.git[@ref]`
 */
export function parseRepoSpec(input: string): RepoRef {
  const spec = input.trim()
  if (spec.length === 0) throw new RepoSpecError('repo reference must not be empty')

  // scp-like: git@host:owner/repo.git
  const scp = /^[^/@\s]+@([^:/\s]+):(.+)$/.exec(spec)
  if (scp !== null) {
    const host = scp[1]!.toLowerCase()
    const parts = splitOwnerRepo(scp[2]!)
    if (parts === undefined) throw new RepoSpecError(`cannot parse scp-style repo reference "${spec}"`)
    return { kind: kindForHost(host), host, scheme: 'https', owner: parts.owner, repo: parts.repo, ref: parts.ref }
  }

  // ssh://[user@]host[:port]/owner/repo.git
  const ssh = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(spec)
  if (ssh !== null) {
    const host = ssh[1]!.toLowerCase()
    const parts = splitOwnerRepo(ssh[2]!)
    if (parts === undefined) throw new RepoSpecError(`cannot parse ssh repo reference "${spec}"`)
    return { kind: kindForHost(host), host, scheme: 'https', owner: parts.owner, repo: parts.repo, ref: parts.ref }
  }

  // http(s)://host/owner/repo...
  const http = /^(https?):\/\/([^/]+)\/(.+)$/.exec(spec)
  if (http !== null) {
    const scheme = http[1] === 'http' ? 'http' : 'https'
    const host = http[2]!.toLowerCase()
    const parts = splitOwnerRepo(http[3]!)
    if (parts === undefined) throw new RepoSpecError(`cannot parse URL repo reference "${spec}"`)
    return { kind: kindForHost(host), host, scheme, owner: parts.owner, repo: parts.repo, ref: parts.ref }
  }

  // bare shorthand: owner/repo[@ref] (GitHub default)
  const parts = splitOwnerRepo(spec)
  if (parts !== undefined) {
    return { kind: 'github', host: 'github.com', scheme: 'https', owner: parts.owner, repo: parts.repo, ref: parts.ref }
  }

  throw new RepoSpecError(
    `cannot parse repo reference "${spec}": use owner/repo, owner/repo@ref, or a full https/git/ssh URL`,
  )
}

/** API base per forge kind. */
export function apiBase(kind: ForgeKind): string {
  switch (kind) {
    case 'github': return 'https://api.github.com'
    case 'gitlab': return 'https://gitlab.com/api/v4'
    case 'gitee': return 'https://gitee.com/api/v5'
  }
}

/** GitLab-style URL-encoded project path. */
function projectPath(r: RepoRef): string {
  return encodeURIComponent(`${r.owner}/${r.repo}`)
}

/** Common headers for one request, including auth when a token is known. */
export function requestHeaders(runtime: ZerogitRuntime, repo: RepoRef): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': runtime.userAgent }
  const token = runtime.tokens[repo.kind as ForgeKind]
  if (token !== undefined && token.length > 0) {
    switch (repo.kind) {
      case 'github':
        headers.Authorization = `Bearer ${token}`
        headers.Accept = 'application/vnd.github+json'
        break
      case 'gitlab':
        headers['PRIVATE-TOKEN'] = token
        break
      case 'gitee':
        headers.Authorization = `token ${token}`
        break
      default:
        break
    }
  }
  return headers
}

interface ApiCallOptions {
  signal?: AbortSignal
  headers: Record<string, string>
}

/** GET a forge API endpoint and normalize the JSON payload. */
async function apiGet(repo: RepoRef, path: string, options: ApiCallOptions, query: Record<string, string> = {}): Promise<unknown> {
  if (repo.kind === 'generic') {
    throw new RepoSpecError(`host "${repo.host}" has no known API; pass an explicit archiveUrl/rawUrl or use zgit_download`)
  }
  const params = new URLSearchParams(query).toString()
  const url = `${apiBase(repo.kind)}${path}${params.length > 0 ? `?${params}` : ''}`
  return httpJson(url, { signal: options.signal, headers: options.headers })
}

/** Normalize a JSON object access without throwing on malformed shapes. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Fetch repo metadata; returns the default branch name when available (cached). */
export async function fetchDefaultBranch(repo: RepoRef, options: ApiCallOptions): Promise<string | undefined> {
  if (repo.kind === 'generic') return undefined
  const key = repoCacheKey(repo)
  const cached = defaultBranchCache.get(key)
  if (cached !== undefined) return cached
  let branch: string | undefined
  if (repo.kind === 'github' || repo.kind === 'gitee') {
    const data = asRecord(await apiGet(repo, `/repos/${repo.owner}/${repo.repo}`, options))
    const candidate = data?.default_branch
    branch = typeof candidate === 'string' ? candidate : undefined
  } else {
    const data = asRecord(await apiGet(repo, `/projects/${projectPath(repo)}`, options))
    const candidate = data?.default_branch
    branch = typeof candidate === 'string' ? candidate : undefined
  }
  if (branch !== undefined) defaultBranchCache.set(key, branch)
  return branch
}

/** List branches and tags (capped) with their commit shas. */
export async function fetchRefs(repo: RepoRef, options: ApiCallOptions, cap: number): Promise<{ branches: RefEntry[]; tags: RefEntry[] }> {
  const readEntries = (value: unknown): RefEntry[] => {
    if (!Array.isArray(value)) return []
    const entries: RefEntry[] = []
    for (const item of value) {
      const record = asRecord(item)
      const name = record?.name
      const commit = asRecord(record?.commit)
      const sha = typeof commit?.sha === 'string' ? commit.sha : typeof commit?.id === 'string' ? commit.id : undefined
      if (typeof name === 'string' && sha !== undefined) entries.push({ name, sha })
      if (entries.length >= cap) break
    }
    return entries
  }
  if (repo.kind === 'github') {
    const base = `/repos/${repo.owner}/${repo.repo}`
    const branches = readEntries(await apiGet(repo, `${base}/branches`, options, { per_page: String(cap) }))
    const tags = readEntries(await apiGet(repo, `${base}/tags`, options, { per_page: String(cap) }))
    return { branches, tags }
  }
  if (repo.kind === 'gitlab') {
    const base = `/projects/${projectPath(repo)}/repository`
    const branches = readEntries(await apiGet(repo, `${base}/branches`, options, { per_page: String(cap) }))
    const tags = readEntries(await apiGet(repo, `${base}/tags`, options, { per_page: String(cap) }))
    return { branches, tags }
  }
  if (repo.kind === 'gitee') {
    const base = `/repos/${repo.owner}/${repo.repo}`
    const branches = readEntries(await apiGet(repo, `${base}/branches`, options, { per_page: String(cap) }))
    const tags = readEntries(await apiGet(repo, `${base}/tags`, options, { per_page: String(cap) }))
    return { branches, tags }
  }
  return { branches: [], tags: [] }
}

/** Resolve any ref (branch/tag/sha) to a commit sha (cached). */
export async function resolveCommit(repo: RepoRef, ref: string, options: ApiCallOptions): Promise<ResolvedCommit> {
  const key = `${repoCacheKey(repo)}|${ref}`
  const cached = commitCache.get(key)
  if (cached !== undefined) return { sha: cached, ref }
  let sha: string | undefined
  if (repo.kind === 'github') {
    const data = asRecord(await apiGet(repo, `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`, options))
    const candidate = data?.sha
    sha = typeof candidate === 'string' ? candidate : undefined
  } else if (repo.kind === 'gitlab') {
    const data = asRecord(await apiGet(repo, `/projects/${projectPath(repo)}/repository/commits/${encodeURIComponent(ref)}`, options))
    const candidate = data?.id
    sha = typeof candidate === 'string' ? candidate : undefined
  } else if (repo.kind === 'gitee') {
    const data = asRecord(await apiGet(repo, `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`, options))
    const candidate = data?.sha
    sha = typeof candidate === 'string' ? candidate : undefined
  } else {
    throw new RepoSpecError(`host "${repo.host}" has no known API; cannot resolve refs`)
  }
  if (sha === undefined) throw new RepoSpecError(`could not resolve ref "${ref}" on ${repo.owner}/${repo.repo}`)
  commitCache.set(key, sha)
  return { sha, ref }
}

/** Resolve the repo's ref (defaulting to the default branch) to a commit sha. */
export async function resolveRepoRef(repo: RepoRef, options: ApiCallOptions): Promise<{ resolved: ResolvedCommit; defaultBranch: string | undefined }> {
  const defaultBranch = repo.kind === 'generic' ? undefined : await fetchDefaultBranch(repo, options).catch(() => undefined)
  const ref = repo.ref ?? defaultBranch
  if (ref === undefined) {
    throw new RepoSpecError(`no ref given and the default branch of ${repo.owner}/${repo.repo} could not be determined`)
  }
  const resolved = await resolveCommit(repo, ref, options)
  return { resolved, defaultBranch }
}

/** Build the source-archive download URL for a repo at an exact sha. */
export function archiveUrlFor(repo: RepoRef, sha: string, kind: 'tar.gz' | 'zip' = 'tar.gz'): string {
  const ext = kind === 'tar.gz' ? 'tar.gz' : 'zip'
  switch (repo.kind) {
    case 'github':
      return `https://codeload.github.com/${repo.owner}/${repo.repo}/${kind === 'zip' ? 'zip' : 'tar.gz'}/${sha}`
    case 'gitlab':
      return `https://gitlab.com/${repo.owner}/${repo.repo}/-/archive/${sha}/${repo.repo}-${sha}.${ext}`
    case 'gitee':
      return `https://gitee.com/${repo.owner}/${repo.repo}/repository/archive/${sha}.${ext}`
    default:
      return `${repo.scheme}://${repo.host}/${repo.owner}/${repo.repo}/archive/${sha}.${ext}`
  }
}

/** Build the raw-file URL for a repo at a ref (GitHub/Gitee/generic path scheme). */
export function rawUrlFor(repo: RepoRef, path: string, ref: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  if (repo.kind === 'github') {
    return `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(ref)}/${encodedPath}`
  }
  if (repo.kind === 'gitee') {
    return `https://gitee.com/${repo.owner}/${repo.repo}/raw/${encodeURIComponent(ref)}/${encodedPath}`
  }
  return `${repo.scheme}://${repo.host}/${repo.owner}/${repo.repo}/raw/${encodeURIComponent(ref)}/${encodedPath}`
}

/** Fetch a raw file through the forge API (GitLab only; others use rawUrlFor). */
export async function fetchRawFile(repo: RepoRef, path: string, ref: string, options: ApiCallOptions, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (repo.kind === 'gitlab') {
    const url = `${apiBase(repo.kind)}/projects/${projectPath(repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`
    const { text, truncated } = await httpText(url, { signal: options.signal, headers: options.headers, maxBytes }, maxBytes)
    return { text, truncated }
  }
  const { text, truncated } = await httpText(rawUrlFor(repo, path, ref), { signal: options.signal, headers: options.headers, maxBytes }, maxBytes)
  return { text, truncated }
}

/** List the tree at a ref, optionally filtered to a path prefix. */
export async function fetchTree(repo: RepoRef, ref: string, prefix: string | undefined, options: ApiCallOptions, cap: number): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const readGitHubLike = (value: unknown): { entries: TreeEntry[]; truncated: boolean } => {
    const record = asRecord(value)
    const raw = record?.tree
    if (!Array.isArray(raw)) return { entries: [], truncated: false }
    const entries: TreeEntry[] = []
    for (const item of raw) {
      const entry = asRecord(item)
      const path = entry?.path
      const type = entry?.type
      if (typeof path !== 'string' || (type !== 'blob' && type !== 'tree' && type !== 'submodule')) continue
      if (prefix !== undefined && path !== prefix && !path.startsWith(`${prefix}/`)) continue
      entries.push({ path, type, size: typeof entry?.size === 'number' ? entry.size : undefined })
      if (entries.length >= cap) return { entries, truncated: true }
    }
    return { entries, truncated: record?.truncated === true }
  }
  if (repo.kind === 'github' || repo.kind === 'gitee') {
    const base = repo.kind === 'github' ? `/repos/${repo.owner}/${repo.repo}` : `/repos/${repo.owner}/${repo.repo}`
    const data = await apiGet(repo, `${base}/git/trees/${encodeURIComponent(ref)}`, options, { recursive: '1' })
    return readGitHubLike(data)
  }
  if (repo.kind === 'gitlab') {
    const base = `/projects/${projectPath(repo)}/repository`
    const entries: TreeEntry[] = []
    let page = 1
    let truncated = false
    for (;;) {
      const data = await apiGet(repo, `${base}/tree`, options, {
        ref: encodeURIComponent(ref),
        recursive: 'true',
        per_page: '100',
        page: String(page),
      })
      if (!Array.isArray(data) || data.length === 0) break
      for (const item of data) {
        const entry = asRecord(item)
        const path = entry?.path
        const type = entry?.type
        if (typeof path !== 'string' || (type !== 'blob' && type !== 'tree' && type !== 'submodule')) continue
        if (prefix !== undefined && path !== prefix && !path.startsWith(`${prefix}/`)) continue
        entries.push({ path, type, size: typeof entry?.size === 'number' ? entry.size : undefined })
        if (entries.length >= cap) {
          truncated = true
          break
        }
      }
      if (truncated || data.length < 100) break
      page += 1
    }
    return { entries, truncated }
  }
  return { entries: [], truncated: false }
}

/** List recent commits at a ref. */
export async function fetchCommits(repo: RepoRef, ref: string, count: number, options: ApiCallOptions): Promise<LogEntry[]> {
  const read = (value: unknown): LogEntry[] => {
    if (!Array.isArray(value)) return []
    const entries: LogEntry[] = []
    for (const item of value) {
      const record = asRecord(item)
      const commit = asRecord(record?.commit)
      const author = asRecord(commit?.author)
      const sha = typeof record?.sha === 'string' ? record.sha : typeof record?.id === 'string' ? record.id : undefined
      const name = typeof author?.name === 'string' ? author.name : typeof record?.author_name === 'string' ? record.author_name : 'unknown'
      const date = typeof author?.date === 'string' ? author.date : typeof record?.authored_date === 'string' ? record.authored_date : ''
      const subject = typeof commit?.message === 'string'
        ? commit.message.split('\n')[0] ?? ''
        : typeof record?.title === 'string' ? record.title : ''
      if (sha === undefined) continue
      entries.push({ sha, author: name, date, subject })
      if (entries.length >= count) break
    }
    return entries
  }
  if (repo.kind === 'github' || repo.kind === 'gitee') {
    const base = `/repos/${repo.owner}/${repo.repo}`
    return read(await apiGet(repo, `${base}/commits`, options, { sha: ref, per_page: String(count) }))
  }
  if (repo.kind === 'gitlab') {
    const base = `/projects/${projectPath(repo)}/repository`
    return read(await apiGet(repo, `${base}/commits`, options, { ref_name: ref, per_page: String(count) }))
  }
  return []
}

/** Compare two refs; returns changed files (with patches when cheap) plus commits. */
export async function fetchCompare(repo: RepoRef, base: string, head: string, options: ApiCallOptions, cap: number): Promise<{ files: CompareFile[]; commits: LogEntry[]; truncated: boolean }> {
  if (repo.kind === 'github' || repo.kind === 'gitee') {
    const basePath = repo.kind === 'github' ? `/repos/${repo.owner}/${repo.repo}` : `/repos/${repo.owner}/${repo.repo}`
    const data = asRecord(await apiGet(repo, `${basePath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, options))
    const rawFiles = Array.isArray(data?.files) ? data.files : []
    const files: CompareFile[] = []
    for (const item of rawFiles) {
      const record = asRecord(item)
      const filename = record?.filename
      if (typeof filename !== 'string') continue
      files.push({
        path: filename,
        status: typeof record?.status === 'string' ? record.status : 'modified',
        additions: typeof record?.additions === 'number' ? record.additions : 0,
        deletions: typeof record?.deletions === 'number' ? record.deletions : 0,
        patch: typeof record?.patch === 'string' ? record.patch : undefined,
      })
      if (files.length >= cap) break
    }
    const commits = typeof data?.commits === 'object' ? readCommitsFrom(data.commits) : []
    return { files, commits: commits.slice(0, cap), truncated: files.length >= cap }
  }
  if (repo.kind === 'gitlab') {
    const basePath = `/projects/${projectPath(repo)}/repository`
    const data = asRecord(await apiGet(repo, `${basePath}/compare`, options, { from: base, to: head }))
    const rawDiffs = Array.isArray(data?.diffs) ? data.diffs : []
    const files: CompareFile[] = []
    for (const item of rawDiffs) {
      const record = asRecord(item)
      const path = typeof record?.new_path === 'string' ? record.new_path : undefined
      if (path === undefined) continue
      const patch = typeof record?.diff === 'string' ? record.diff : undefined
      const additions = patch === undefined ? 0 : [...patch.matchAll(/^\+/gm)].length
      const deletions = patch === undefined ? 0 : [...patch.matchAll(/^-/gm)].length
      files.push({
        path,
        status: record?.deleted_file === true ? 'deleted' : record?.new_file === true ? 'added' : record?.renamed_file === true ? 'renamed' : 'modified',
        additions,
        deletions,
        patch,
      })
      if (files.length >= cap) break
    }
    const commits = typeof data?.commits === 'object' ? readCommitsFrom(data.commits) : []
    return { files, commits: commits.slice(0, cap), truncated: files.length >= cap }
  }
  return { files: [], commits: [], truncated: false }
}

/** Normalize commit payloads shared by compare responses. */
function readCommitsFrom(value: unknown): LogEntry[] {
  if (!Array.isArray(value)) return []
  const entries: LogEntry[] = []
  for (const item of value) {
    const record = asRecord(item)
    const commit = asRecord(record?.commit)
    const author = asRecord(commit?.author)
    const sha = typeof record?.sha === 'string' ? record.sha : typeof record?.id === 'string' ? record.id : undefined
    if (sha === undefined) continue
    entries.push({
      sha,
      author: typeof author?.name === 'string' ? author.name : typeof record?.author_name === 'string' ? record.author_name : 'unknown',
      date: typeof author?.date === 'string' ? author.date : '',
      subject: typeof commit?.message === 'string' ? (commit.message.split('\n')[0] ?? '') : typeof record?.title === 'string' ? record.title : '',
    })
  }
  return entries
}

/** Fetch one release (latest by default) with its assets. Returns undefined when no release exists. */
export async function fetchRelease(repo: RepoRef, tag: string | undefined, options: ApiCallOptions): Promise<ReleaseInfo | undefined> {
  const readGitHubLike = (value: unknown): ReleaseInfo | undefined => {
    const record = asRecord(value)
    const tagName = record?.tag_name
    if (typeof tagName !== 'string') return undefined
    const rawAssets = Array.isArray(record?.assets) ? record.assets : []
    const assets: ReleaseAsset[] = []
    for (const item of rawAssets) {
      const asset = asRecord(item)
      const name = asset?.name
      const url = asset?.browser_download_url
      if (typeof name !== 'string' || typeof url !== 'string') continue
      assets.push({ name, size: typeof asset?.size === 'number' ? asset.size : undefined, url })
    }
    return {
      tagName,
      name: typeof record?.name === 'string' ? record.name : undefined,
      publishedAt: typeof record?.published_at === 'string' ? record.published_at : typeof record?.created_at === 'string' ? record.created_at : undefined,
      assets,
    }
  }
  if (repo.kind === 'github' || repo.kind === 'gitee') {
    const base = repo.kind === 'github' ? `/repos/${repo.owner}/${repo.repo}` : `/repos/${repo.owner}/${repo.repo}`
    const path = tag === undefined ? '/releases/latest' : `/releases/tags/${encodeURIComponent(tag)}`
    return readGitHubLike(await apiGet(repo, `${base}${path}`, options))
  }
  if (repo.kind === 'gitlab') {
    const base = `/projects/${projectPath(repo)}/releases`
    let data: unknown
    if (tag === undefined) {
      const list = await apiGet(repo, base, options, { per_page: '1' })
      data = Array.isArray(list) && list.length > 0 ? list[0] : undefined
    } else {
      data = await apiGet(repo, `${base}/${encodeURIComponent(tag)}`, options)
    }
    const record = asRecord(data)
    const tagName = record?.tag_name
    if (typeof tagName !== 'string') return undefined
    const assetsRecord = asRecord(record?.assets)
    const rawLinks = Array.isArray(assetsRecord?.links) ? assetsRecord.links : []
    const assets: ReleaseAsset[] = []
    for (const item of rawLinks) {
      const link = asRecord(item)
      const name = link?.name
      const url = link?.url
      if (typeof name !== 'string' || typeof url !== 'string') continue
      assets.push({ name, url })
    }
    const rawSources = Array.isArray(assetsRecord?.sources) ? assetsRecord.sources : []
    for (const item of rawSources) {
      const source = asRecord(item)
      const format = source?.format
      const url = source?.url
      if (typeof format === 'string' && typeof url === 'string') assets.push({ name: `source-${format}`, url })
    }
    return {
      tagName,
      name: typeof record?.name === 'string' ? record.name : undefined,
      publishedAt: typeof record?.released_at === 'string' ? record.released_at : undefined,
      assets,
    }
  }
  return undefined
}

/** Fetch the latest release tag, or undefined when the repo has no releases. */
export async function fetchLatestReleaseTag(repo: RepoRef, options: ApiCallOptions): Promise<string | undefined> {
  const release = await fetchRelease(repo, undefined, options).catch(() => undefined)
  return release?.tagName
}
