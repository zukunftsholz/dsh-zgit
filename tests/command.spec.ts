import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runZgitCommand } from '../src/command.ts'
import { setFetchImpl } from '../src/http.ts'
import { clearForgeCaches } from '../src/forge.ts'
import type { ZerogitRuntime } from '../src/types.ts'
import { buildTarGz } from './helpers/archives.ts'
import { makeGithubFetch } from './helpers/fixture.ts'

const tempDirs: string[] = []
afterEach(async () => {
  setFetchImpl(globalThis.fetch.bind(globalThis) as typeof fetch)
  clearForgeCaches()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const SHA = 'a'.repeat(40)

function runtime(workspaceRoot: string): ZerogitRuntime {
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
  }
}

const github = makeGithubFetch({
  defaultBranch: 'main',
  branches: [{ name: 'main', commit: { sha: SHA } }],
  tags: [],
  commits: { main: { sha: SHA } },
  commitList: [{ sha: SHA, commit: { author: { name: 'Ada', date: '2026-01-02T00:00:00Z' }, message: 'first' } }],
  tree: { truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 4 }] },
  archiveBytes: buildTarGz([
    { path: 'tool-main/', kind: 'dir' },
    { path: 'tool-main/README.md', kind: 'file', content: '# t\n' },
  ]),
  rawFiles: { 'README.md': '# t\n' },
})

describe('/zgit command', () => {
  it('prints help', async () => {
    const result = await runZgitCommand(runtime(await mkdir()), '', undefined)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('usage: /zgit')
  })

  it('resolves a repo', async () => {
    setFetchImpl(github)
    const result = await runZgitCommand(runtime(await mkdir()), 'resolve acme/tool main', undefined)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('acme/tool')
      expect(result.text).toContain(SHA)
    }
  })

  it('clones into the workspace', async () => {
    setFetchImpl(github)
    const root = await mkdir()
    const result = await runZgitCommand(runtime(root), 'clone acme/tool', undefined)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('cloned acme/tool@main')
  })

  it('treats the first clone positional as the target dir, not a ref', async () => {
    setFetchImpl(github)
    const root = await mkdir()
    const result = await runZgitCommand(runtime(root), 'clone acme/tool target-dir', undefined)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('→ target-dir')
      expect(result.text).toContain('@main') // the ref came from the repo spec
    }
  })

  it('clones at a repo-spec ref under API rate limiting', async () => {
    // API 403s; codeload still serves. The @ref must drive the archive URL.
    const rateLimited = makeGithubFetch({
      defaultBranch: 'main',
      archiveBytes: buildTarGz([
        { path: 'tool-main/', kind: 'dir' },
        { path: 'tool-main/README.md', kind: 'file', content: '# t\n' },
      ]),
    })
    setFetchImpl(async (url, init) => {
      if (String(url).startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: { 'content-type': 'application/json' } })
      }
      return rateLimited(url, init)
    })
    const root = await mkdir()
    const result = await runZgitCommand(runtime(root), 'clone acme/tool@main rl-dir', undefined)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.text).toContain('cloned acme/tool@main')
      expect(result.text).toContain('unknown')
    }
  })

  it('shows a file', async () => {
    setFetchImpl(github)
    const result = await runZgitCommand(runtime(await mkdir()), 'show acme/tool README.md', undefined)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('# t')
  })

  it('reports errors as kind error', async () => {
    const result = await runZgitCommand(runtime(await mkdir()), 'frobnicate x', undefined)
    expect(result.kind).toBe('error')
  })

  it('rejects missing arguments', async () => {
    const result = await runZgitCommand(runtime(await mkdir()), 'clone', undefined)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') expect(result.text).toContain('requires')
  })

  it('lists tree entries', async () => {
    setFetchImpl(github)
    const result = await runZgitCommand(runtime(await mkdir()), 'ls acme/tool', undefined)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') expect(result.text).toContain('README.md')
  })
})

async function mkdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zgit-cmd-'))
  tempDirs.push(dir)
  return dir
}
