/**
 * Shared value types for the dsh-zgit core.
 * @module dsh-zgit/types
 */

/** Forges with a known public API surface. `generic` keeps archive/raw URL
 * guessing (self-hosted GitHub-style hosts) but no API calls. */
export type ForgeKind = 'github' | 'gitlab' | 'gitee'

/** A parsed repository reference: `owner/repo` on a forge, plus an optional ref. */
export interface RepoRef {
  /** Forge kind when the host is a known public forge, else 'generic'. */
  kind: ForgeKind | 'generic'
  /** Normalized hostname, e.g. `github.com`. */
  host: string
  /** URL scheme when the spec carried one (generic hosts only). */
  scheme: 'http' | 'https'
  /** Repository owner (user or group). */
  owner: string
  /** Repository name, without the `.git` suffix. */
  repo: string
  /** Optional branch / tag / commit reference. */
  ref: string | undefined
}

/** One resolved commit on a forge. */
export interface ResolvedCommit {
  /** Full commit sha. */
  sha: string
  /** The ref string that resolved to it (the default branch when none was given). */
  ref: string
}

/** A normalized branch or tag entry. */
export interface RefEntry {
  name: string
  sha: string
}

/** One file/dir entry in a tree listing. */
export interface TreeEntry {
  path: string
  type: 'blob' | 'tree' | 'submodule'
  size?: number
}

/** One commit in a log listing. */
export interface LogEntry {
  sha: string
  author: string
  date: string
  subject: string
}

/** One changed file in a compare result. */
export interface CompareFile {
  path: string
  status: string
  additions: number
  deletions: number
  /** Unified diff text for the file; may be absent for large files. */
  patch?: string
}

/** A release asset ready to download. */
export interface ReleaseAsset {
  name: string
  /** Asset size in bytes when the forge reports it. */
  size?: number
  /** Direct download URL. */
  url: string
}

/** A normalized release record. */
export interface ReleaseInfo {
  tagName: string
  name?: string
  publishedAt?: string
  assets: ReleaseAsset[]
}

/** Summary of one simulated checkout. */
export interface CloneSummary {
  forge: ForgeKind | 'generic'
  host: string
  owner: string
  repo: string
  ref: string
  sha: string
  /** False when the sha could not be resolved and the ref was used directly. */
  shaResolved: boolean
  defaultBranch: string | undefined
  archiveUrl: string
  archiveKind: 'tar.gz' | 'zip'
  archiveBytes: number
  targetDir: string
  files: number
  dirs: number
  totalBytes: number
  symlinksSkipped: number
  hardlinksCopied: number
  metaPath: string
  fetchedAt: string
  elapsedMs: number
}

/** Content of `.zerogit/meta.json` written for every simulated checkout. */
export interface CheckoutMeta {
  version: 1
  forge: ForgeKind | 'generic'
  host: string
  /** URL scheme (generic hosts only). */
  scheme: 'http' | 'https'
  owner: string
  repo: string
  ref: string
  sha: string
  /** False when the sha could not be resolved (rate limit/offline) and the ref was used directly. */
  shaResolved: boolean
  archiveUrl: string
  archiveKind: 'tar.gz' | 'zip'
  fetchedAt: string
  files: number
  totalBytes: number
  subdir: string | undefined
}

/** Output of a status check on a simulated checkout. */
export interface StatusResult {
  dir: string
  meta: CheckoutMeta
  remoteSha: string
  upToDate: boolean
  /** Commits the remote is ahead; null when the forge could not count them. */
  behindBy: number | null
  newCommits: LogEntry[]
  checkedAt: string
}

/** Downloaded release outcome. */
export interface DownloadedAsset {
  name: string
  size: number
  sha256: string
  path: string
  verified: boolean
}

/** Output of a release fetch. */
export interface ReleaseFetchResult {
  forge: ForgeKind | 'generic'
  owner: string
  repo: string
  tagName: string
  targetDir: string
  assets: DownloadedAsset[]
  /** When only a listing was requested. */
  listed?: ReleaseAsset[]
}

/** Output of `zgit_download`. */
export interface DownloadResult {
  url: string
  path: string
  size: number
  sha256: string
  contentType: string | undefined
}

/** Resolved per-call limits and identity for the core operations. */
export interface ZerogitRuntime {
  /** Fallback workspace root; every write is confined under it unless the call carries a per-call workspace (the calling session's cwd). */
  workspaceRoot: string
  /** User-Agent sent with every request. */
  userAgent: string
  /** Cooperative tool-call timeout budget (ms) attached to every tool. */
  timeoutMs: number
  /** Max archive bytes downloaded (clone). */
  maxArchiveBytes: number
  /** Max generic download bytes. */
  maxDownloadBytes: number
  /** Max raw-file bytes (show). */
  maxFileBytes: number
  /** Max tree entries listed (ls_tree). */
  maxTreeEntries: number
  /** Max commits listed (log / ls_remote refs). */
  maxLogCommits: number
  /** Max compare-output characters (diff). */
  maxDiffChars: number
  /** Max entries extracted from one archive. */
  maxExtractedEntries: number
  /** Forge tokens, resolved from config (env names first). */
  tokens: Partial<Record<ForgeKind, string>>
}
