import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cloneSource,
  diff,
  download,
  fetchReleaseAssets,
  log,
  lsRemote,
  lsTree,
  showFile,
  status,
} from '../src/core.ts'
import { setFetchImpl } from '../src/http.ts'
import { clearForgeCaches } from '../src/forge.ts'
import type { ZerogitRuntime } from '../src/types.ts'
import { buildTarGz } from './helpers/archives.ts'
import { makeGithubFetch } from './helpers/fixture.ts'

const tempDirs: string[] = []
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zgit-core-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  setFetchImpl(globalThis.fetch.bind(globalThis) as typeof fetch)
  clearForgeCaches()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const SHA = 'a'.repeat(40)
const SHA2 = 'b'.repeat(40)

function runtime(workspaceRoot: string, overrides: Partial<ZerogitRuntime> = {}): ZerogitRuntime {
  return {
    workspaceRoot,
    userAgent: 'zgit-test/0.0.0',
    timeoutMs: 30_000,
    maxArchiveBytes: 10 * 1024 * 1024,
    maxDownloadBytes: 10 * 1024 * 1024,
    maxFileBytes: 64 * 1024,
    maxTreeEntries: 100,
    maxLogCommits: 10,
    maxDiffChars: 20_000,
    maxExtractedEntries: 10_000,
    tokens: {},
    ...overrides,
  }
}

const archive = buildTarGz([
  { path: 'tool-main/', kind: 'dir' },
  { path: 'tool-main/README.md', kind: 'file', content: '# tool\n' },
  { path: 'tool-main/src/', kind: 'dir' },
  { path: 'tool-main/src/index.js', kind: 'file', content: 'console.log(1)\n' },
  { path: 'tool-main/pkg.json', kind: 'file', content: '{"name":"tool"}\n' },
])

const github = makeGithubFetch({
  defaultBranch: 'main',
  branches: [{ name: 'main', commit: { sha: SHA } }, { name: 'dev', commit: { sha: SHA2 } }],
  tags: [{ name: 'v1.0.0', commit: { sha: SHA2 } }],
  commits: {
    main: { sha: SHA, commit: { author: { name: 'Ada', date: '2026-01-02T00:00:00Z' }, message: 'first\n\nbody' } },
    [SHA]: { sha: SHA, commit: { author: { name: 'Ada', date: '2026-01-02T00:00:00Z' }, message: 'first' } },
    [SHA2]: { sha: SHA2, commit: { author: { name: 'Bob', date: '2026-01-03T00:00:00Z' }, message: 'second' } },
  },
  commitList: [
    { sha: SHA2, commit: { author: { name: 'Bob', date: '2026-01-03T00:00:00Z' }, message: 'second\n' } },
    { sha: SHA, commit: { author: { name: 'Ada', date: '2026-01-02T00:00:00Z' }, message: 'first\n' } },
  ],
  tree: {
    truncated: false,
    tree: [
      { path: 'README.md', type: 'blob', size: 10 },
      { path: 'src', type: 'tree' },
      { path: 'src/index.js', type: 'blob', size: 20 },
    ],
  },
  compare: {
    status: 'ahead',
    ahead_by: 1,
    behind_by: 0,
    total_commits: 1,
    commits: [{ sha: SHA2, commit: { author: { name: 'Bob', date: '2026-01-03T00:00:00Z' }, message: 'second' } }],
    files: [
      { filename: 'src/index.js', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1,2 @@\n-old\n+new\n+more\n' },
      { filename: 'README.md', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-# old\n+# new\n' },
    ],
  },
  releases: {
    latest: {
      tag_name: 'v1.0.0',
      name: 'Tool 1.0',
      published_at: '2026-01-01T00:00:00Z',
      assets: [
        { name: 'tool-v1.0.0.zip', size: 100, browser_download_url: 'https://objects.example/tool.zip' },
        { name: 'tool-v1.0.0.zip.sha256', size: 65, browser_download_url: 'https://objects.example/tool.zip.sha256' },
      ],
    },
  },
  archiveBytes: archive,
  rawFiles: { 'src/index.js': 'console.log(1)\n' },
})

describe('lsRemote', () => {
  it('lists refs and resolves a ref', async () => {
    setFetchImpl(github)
    const result = await lsRemote(runtime(await tempRoot()), { repo: 'acme/tool', ref: 'main' })
    expect(result.defaultBranch).toBe('main')
    expect(result.resolvedSha).toBe(SHA)
    expect(result.branches.map(b => b.name)).toEqual(['main', 'dev'])
    expect(result.tags.map(t => t.name)).toEqual(['v1.0.0'])
    expect(result.latestReleaseTag).toBe('v1.0.0')
  })
})

describe('cloneSource', () => {
  it('downloads, extracts, and writes .zerogit meta', async () => {
    setFetchImpl(github)
    const root = await tempRoot()
    const result = await cloneSource(runtime(root), { repo: 'acme/tool' })
    expect(result.sha).toBe(SHA)
    expect(result.ref).toBe('main')
    expect(result.files).toBe(3)
    expect(result.targetDir).toBe('tool@aaaaaaaaaaaa')
    const checkout = join(root, result.targetDir)
    expect(await readFile(join(checkout, 'src/index.js'), 'utf8')).toBe('console.log(1)\n')
    const meta = JSON.parse(await readFile(join(checkout, '.zerogit/meta.json'), 'utf8'))
    expect(meta).toMatchObject({ version: 1, owner: 'acme', repo: 'tool', ref: 'main', sha: SHA, files: 3 })
    expect(await readFile(join(checkout, '.zerogit/HEAD'), 'utf8')).toBe(`${SHA}\n`)
  })

  it('extracts a subdir and refuses to overwrite a foreign directory', async () => {
    setFetchImpl(github)
    const root = await tempRoot()
    const result = await cloneSource(runtime(root), { repo: 'acme/tool', subdir: 'src', dir: 'sparse' })
    expect(result.files).toBe(1)
    expect(await readFile(join(root, 'sparse/src/index.js'), 'utf8')).toBe('console.log(1)\n')

    await expect(cloneSource(runtime(root), { repo: 'acme/tool', dir: 'sparse' })).rejects.toThrow(/already exists/)
    const refreshed = await cloneSource(runtime(root), { repo: 'acme/tool', dir: 'sparse', replace: true })
    expect(refreshed.files).toBe(3)
  })

  it('supports explicit archive URLs (generic host)', async () => {
    setFetchImpl(github)
    const root = await tempRoot()
    const result = await cloneSource(runtime(root), {
      repo: 'https://git.example.com/acme/tool',
      ref: 'main',
      archiveUrl: 'https://codeload.github.com/acme/tool/tar.gz/main',
    })
    expect(result.forge).toBe('generic')
    expect(result.files).toBe(3)
  })
})

describe('status', () => {
  it('reports up to date and behind states', async () => {
    setFetchImpl(github)
    const root = await tempRoot()
    await cloneSource(runtime(root), { repo: 'acme/tool' })
    const fresh = await status(runtime(root), { dir: 'tool@aaaaaaaaaaaa' })
    expect(fresh.upToDate).toBe(true)
    expect(fresh.behindBy).toBe(0)

    // Move the remote forward and re-check (clear the ref-resolution cache
    // so the swap is visible).
    const moved = makeGithubFetch({
      defaultBranch: 'main',
      branches: [{ name: 'main', commit: { sha: SHA2 } }],
      commits: { main: { sha: SHA2, commit: { author: { name: 'Bob', date: '2026-01-03T00:00:00Z' }, message: 'second' } }, [SHA]: { sha: SHA } },
      compare: {
        commits: [{ sha: SHA2, commit: { author: { name: 'Bob', date: '2026-01-03T00:00:00Z' }, message: 'second' } }],
        files: [{ filename: 'src/index.js', status: 'modified', additions: 1, deletions: 0 }],
      },
    })
    clearForgeCaches()
    setFetchImpl(moved)
    const behind = await status(runtime(root), { dir: 'tool@aaaaaaaaaaaa' })
    expect(behind.upToDate).toBe(false)
    expect(behind.behindBy).toBe(1)
    expect(behind.newCommits[0]?.subject).toBe('second')
  })

  it('rejects directories without zgit meta', async () => {
    const root = await tempRoot()
    await expect(status(runtime(root), { dir: 'nope' })).rejects.toThrow(/not a zgit/)
  })
})

describe('showFile', () => {
  it('fetches a raw file at a ref', async () => {
    setFetchImpl(github)
    const root = await tempRoot()
    const result = await showFile(runtime(root), { repo: 'acme/tool', path: 'src/index.js' })
    expect(result.text).toBe('console.log(1)\n')
    expect(result.ref).toBe('main')
    expect(result.sha).toBe(SHA)
    expect(result.binary).toBe(false)
  })

  it('saves to the workspace when asked', async () => {
    setFetchImpl(github)
    const root = await tempRoot()
    await showFile(runtime(root), { repo: 'acme/tool', path: 'src/index.js', saveTo: 'fetched/index.js' })
    expect(await readFile(join(root, 'fetched/index.js'), 'utf8')).toBe('console.log(1)\n')
  })
})

describe('lsTree', () => {
  it('lists entries under a prefix', async () => {
    setFetchImpl(github)
    const result = await lsTree(runtime(await tempRoot()), { repo: 'acme/tool' })
    expect(result.entries.map(e => e.path)).toEqual(['README.md', 'src', 'src/index.js'])
    expect(result.truncated).toBe(false)
  })
})

describe('log', () => {
  it('lists recent commits', async () => {
    setFetchImpl(github)
    const result = await log(runtime(await tempRoot()), { repo: 'acme/tool' })
    expect(result.entries[0]).toMatchObject({ sha: SHA2, author: 'Bob', subject: 'second' })
  })
})

describe('diff', () => {
  it('summarizes a compare', async () => {
    setFetchImpl(github)
    const result = await diff(runtime(await tempRoot()), { repo: 'acme/tool', base: SHA, head: SHA2 })
    expect(result.totalAdditions).toBe(3)
    expect(result.files[0]).toMatchObject({ path: 'src/index.js', status: 'modified' })
  })

  it('returns the single-file patch', async () => {
    setFetchImpl(github)
    const result = await diff(runtime(await tempRoot()), { repo: 'acme/tool', base: SHA, head: SHA2, path: 'src/index.js' })
    expect(result.singleFile?.patch).toContain('+new')
    expect(result.singleFile?.patchTruncated).toBe(false)
  })

  it('errors when the path did not change', async () => {
    setFetchImpl(github)
    await expect(diff(runtime(await tempRoot()), { repo: 'acme/tool', base: SHA, head: SHA2, path: 'nope.txt' })).rejects.toThrow(/did not change/)
  })
})

describe('fetchReleaseAssets', () => {
  it('lists assets without a pattern', async () => {
    setFetchImpl(github)
    const result = await fetchReleaseAssets(runtime(await tempRoot()), { repo: 'acme/tool' })
    expect(result.tagName).toBe('v1.0.0')
    expect(result.listed?.map(a => a.name)).toEqual(['tool-v1.0.0.zip', 'tool-v1.0.0.zip.sha256'])
    expect(result.assets).toEqual([])
  })

  it('downloads matching assets and verifies sha256', async () => {
    const shaSum = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' // sha256 of ""
    const downloads = new Map<string, Uint8Array>([
      ['https://objects.example/tool.zip', new TextEncoder().encode('')],
      ['https://objects.example/tool.zip.sha256', new TextEncoder().encode(`${shaSum}  tool-v1.0.0.zip\n`)],
    ])
    const withAssets = makeGithubFetch({
      defaultBranch: 'main',
      releases: {
        latest: {
          tag_name: 'v1.0.0',
          assets: [
            { name: 'tool-v1.0.0.zip', size: 0, browser_download_url: 'https://objects.example/tool.zip' },
            { name: 'tool-v1.0.0.zip.sha256', size: 65, browser_download_url: 'https://objects.example/tool.zip.sha256' },
          ],
        },
      },
    })
    setFetchImpl(async (url, init) => {
      const bytes = downloads.get(String(url))
      if (bytes !== undefined) {
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
      }
      return withAssets(url, init)
    })
    const root = await tempRoot()
    const result = await fetchReleaseAssets(runtime(root), { repo: 'acme/tool', pattern: '*.zip*' })
    expect(result.assets.length).toBe(2)
    const zipAsset = result.assets.find(a => a.name === 'tool-v1.0.0.zip')
    expect(zipAsset?.verified).toBe(true)
    expect(await readFile(join(root, result.targetDir, 'tool-v1.0.0.zip'), 'utf8')).toBe('')
  })

  it('leaves no directory behind when no asset matches the pattern', async () => {
    setFetchImpl(github)
    const root = await tempRoot()
    await expect(fetchReleaseAssets(runtime(root), { repo: 'acme/tool', pattern: '*.nope' })).rejects.toThrow(/no asset matches/)
    const entries = await import('node:fs/promises').then(fs => fs.readdir(root))
    expect(entries.filter(name => name.includes('release'))).toEqual([])
  })
})

describe('per-call workspace root', () => {
  it('clone lands in the calling session workspace, not the runtime root', async () => {
    setFetchImpl(github)
    const runtimeRoot = await tempRoot()
    const sessionRoot = await tempRoot()
    const result = await cloneSource(runtime(runtimeRoot), { repo: 'acme/tool' }, { workspaceRoot: sessionRoot })
    expect(result.targetDir).toBe('tool@aaaaaaaaaaaa')
    expect(await readFile(join(sessionRoot, 'tool@aaaaaaaaaaaa/src/index.js'), 'utf8')).toBe('console.log(1)\n')
    // Nothing leaked into the runtime root (the old process.cwd() behavior).
    expect(await readdir(runtimeRoot)).toEqual([])
  })

  it('download, showFile saveTo, and status honor the per-call workspace', async () => {
    const bytes = new TextEncoder().encode('hello zerogit')
    setFetchImpl(async (url, init) => {
      const target = String(url)
      if (target === 'https://mirror.example/tool.bin') {
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
      }
      return github(url, init)
    })
    const runtimeRoot = await tempRoot()
    const sessionRoot = await tempRoot()

    const downloaded = await download(runtime(runtimeRoot), { url: 'https://mirror.example/tool.bin', path: 'bin/tool.bin' }, { workspaceRoot: sessionRoot })
    expect(downloaded.path).toBe(join('bin', 'tool.bin'))
    expect(await readFile(join(sessionRoot, 'bin/tool.bin'), 'utf8')).toBe('hello zerogit')

    await showFile(runtime(runtimeRoot), { repo: 'acme/tool', path: 'src/index.js', saveTo: 'fetched/index.js' }, { workspaceRoot: sessionRoot })
    expect(await readFile(join(sessionRoot, 'fetched/index.js'), 'utf8')).toBe('console.log(1)\n')

    await cloneSource(runtime(runtimeRoot), { repo: 'acme/tool', dir: 'co' }, { workspaceRoot: sessionRoot })
    const fresh = await status(runtime(runtimeRoot), { dir: 'co' }, { workspaceRoot: sessionRoot })
    expect(fresh.upToDate).toBe(true)

    expect(await readdir(runtimeRoot)).toEqual([])
  })

  it('a path outside the per-call workspace is still rejected', async () => {
    setFetchImpl(github)
    const runtimeRoot = await tempRoot()
    const sessionRoot = await tempRoot()
    await expect(cloneSource(runtime(runtimeRoot), { repo: 'acme/tool', dir: '../escape' }, { workspaceRoot: sessionRoot }))
      .rejects.toThrow(/outside the workspace/)
  })
})

describe('rate-limit resilience', () => {
  it('clones with an explicit ref when the API is rate limited (degrades to ref)', async () => {
    // API 403s with a rate-limit body; codeload + raw still serve.
    const rateLimited = makeGithubFetch({
      defaultBranch: 'main',
      archiveBytes: buildTarGz([
        { path: 'tool-main/', kind: 'dir' },
        { path: 'tool-main/README.md', kind: 'file', content: '# t\n' },
      ]),
    })
    setFetchImpl(async (url, init) => {
      const target = String(url)
      if (target.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      }
      return rateLimited(url, init)
    })
    const root = await tempRoot()
    const result = await cloneSource(runtime(root), { repo: 'acme/tool@main', dir: 'rate-limited' })
    expect(result.shaResolved).toBe(false)
    expect(result.sha).toBe('unknown')
    expect(await readFile(join(root, 'rate-limited/README.md'), 'utf8')).toBe('# t\n')
    const meta = JSON.parse(await readFile(join(root, 'rate-limited/.zerogit/meta.json'), 'utf8'))
    expect(meta.shaResolved).toBe(false)
  })

  it('surfaces the rate-limit cause when the default branch is required', async () => {
    setFetchImpl(async url => {
      if (String(url).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded for 1.2.3.4.' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      }
      return github(url)
    })
    const root = await tempRoot()
    await expect(lsTree(runtime(root), { repo: 'acme/tool' })).rejects.toThrow(/rate limit.*token/)
  })

  it('status reports an unpinned checkout without comparing shas', async () => {
    // Clone under rate limit (sha unknown), then let the API recover.
    const rateLimited = makeGithubFetch({
      defaultBranch: 'main',
      archiveBytes: buildTarGz([
        { path: 'tool-main/', kind: 'dir' },
        { path: 'tool-main/a.txt', kind: 'file', content: 'a' },
      ]),
    })
    setFetchImpl(async (url, init) => {
      if (String(url).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'content-type': 'application/json' } })
      }
      return rateLimited(url, init)
    })
    const root = await tempRoot()
    await cloneSource(runtime(root), { repo: 'acme/tool@main', dir: 'unpinned' })

    // API recovers: status can resolve the remote sha but must not compare against 'unknown'.
    const recovered = makeGithubFetch({
      defaultBranch: 'main',
      commits: { main: { sha: SHA2 } },
    })
    setFetchImpl(recovered)
    const result = await status(runtime(root), { dir: 'unpinned' })
    expect(result.upToDate).toBe(false)
    expect(result.behindBy).toBe(null)
    expect(result.remoteSha).toBe(SHA2)
  })
})

describe('download', () => {
  it('downloads a URL into the workspace with sha256 verification', async () => {
    const bytes = new TextEncoder().encode('hello zerogit')
    const realDigest = await import('node:crypto').then(c => c.createHash('sha256').update(bytes).digest('hex'))
    setFetchImpl(async url => {
      expect(String(url)).toBe('https://mirror.example/tool.bin')
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    })
    const root = await tempRoot()
    const result = await download(runtime(root), { url: 'https://mirror.example/tool.bin', path: 'bin/tool.bin', sha256: realDigest })
    expect(result.size).toBe(13)
    expect(await readFile(join(root, 'bin/tool.bin'), 'utf8')).toBe('hello zerogit')

    await expect(download(runtime(root), { url: 'https://mirror.example/tool.bin', path: 'bin/bad.bin', sha256: '0'.repeat(64) }))
      .rejects.toThrow(/sha256 mismatch/)
  })
})
