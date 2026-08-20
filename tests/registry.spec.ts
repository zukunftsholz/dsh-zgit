/**
 * Registry-boundary regression: every zgit tool must execute through the REAL
 * ToolRuntime and survive its lossless-JSON snapshot even when optional fields
 * are absent. Core-level tests bypass this boundary (they call the functions
 * directly), which is exactly how the "value is not lossless JSON" bug escaped:
 * result objects carried own `undefined`-valued keys (e.g. `latestReleaseTag`,
 * `prefix`, `listed`, `contentType`), which `snapshotJsonValue` rejects.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as zgit from '../src/index.ts'
import { setFetchImpl } from '../src/http.ts'
import { clearForgeCaches } from '../src/forge.ts'
import { buildTarGz } from './helpers/archives.ts'
import { makeGithubFetch } from './helpers/fixture.ts'

const tempRoots: string[] = []

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'zgit-reg-'))
  tempRoots.push(dir)
  return dir
}

let ctx: Context
let workspace: string

beforeEach(async () => {
  workspace = await tempRoot()
  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(zgit, { workspaceRoot: workspace })
})

afterEach(async () => {
  setFetchImpl(globalThis.fetch.bind(globalThis) as typeof fetch)
  clearForgeCaches()
  await Promise.all(tempRoots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Execute one tool through the real registry; fails the test on tool errors. */
async function runTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await ctx.tools.execute({
    callId: CallId(`reg-${name}`),
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
  expect(outcome.isError, outcome.isError ? (outcome as { error: { message: string } }).error.message : '').toBe(false)
  return outcome.value as Record<string, unknown>
}

const archive = buildTarGz([
  { path: 'tool-main/', kind: 'dir' },
  { path: 'tool-main/README.md', kind: 'file', content: '# t\n' },
  { path: 'tool-main/src/', kind: 'dir' },
  { path: 'tool-main/src/index.js', kind: 'file', content: 'x\n' },
])

const fullGithub = makeGithubFetch({
  defaultBranch: 'main',
  branches: [{ name: 'main', commit: { sha: 'a'.repeat(40) } }],
  tags: [{ name: 'v1', commit: { sha: 'b'.repeat(40) } }],
  commits: { main: { sha: 'a'.repeat(40) } },
  commitList: [{ sha: 'a'.repeat(40), commit: { author: { name: 'A', date: '2026-01-01T00:00:00Z' }, message: 'm' } }],
  tree: { truncated: false, tree: [{ path: 'README.md', type: 'blob', size: 4 }] },
  compare: { commits: [], files: [{ filename: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: '@@\n+a\n' }] },
  archiveBytes: archive,
  rawFiles: { 'README.md': '# t\n' },
  releases: {
    latest: {
      tag_name: 'v1',
      assets: [{ name: 'tool.zip', size: 2, browser_download_url: 'https://objects.example/tool.zip' }],
    },
  },
})

/** Any-URL fetch: archive requests get the tar.gz, everything else gets text. */
function anyUrlFetch(): typeof fetch {
  return async url => {
    const target = String(url)
    if (target.includes('/archive/') || target.includes('/tar.gz/')) {
      return new Response(archive, { status: 200, headers: { 'content-type': 'application/gzip' } })
    }
    if (target.includes('tool.zip')) {
      return new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    }
    return new Response('# t\n', { status: 200, headers: { 'content-type': 'text/plain' } })
  }
}

describe('registry lossless-JSON boundary', () => {
  it('zgit_ls_remote succeeds with absent optional fields (no ref, no releases)', async () => {
    setFetchImpl(makeGithubFetch({
      defaultBranch: 'main',
      branches: [{ name: 'main', commit: { sha: 'a'.repeat(40) } }],
      tags: [],
    }))
    const value = await runTool('zgit_ls_remote', { repo: 'acme/tool' })
    expect(value.defaultBranch).toBe('main')
    expect('latestReleaseTag' in value).toBe(false)
    expect('resolvedSha' in value).toBe(false)
  })

  it('zgit_ls_tree succeeds without a path prefix', async () => {
    setFetchImpl(fullGithub)
    const value = await runTool('zgit_ls_tree', { repo: 'acme/tool' })
    expect('prefix' in value).toBe(false)
    expect(Array.isArray(value.entries)).toBe(true)
  })

  it('zgit_show succeeds on a generic host (sha absent)', async () => {
    setFetchImpl(anyUrlFetch())
    const value = await runTool('zgit_show', { repo: 'https://git.example.com/acme/tool@main', path: 'README.md' })
    expect(value.text).toBe('# t\n')
    expect('sha' in value).toBe(false)
  })

  it('zgit_clone succeeds on a generic host (defaultBranch absent, sha unknown)', async () => {
    setFetchImpl(anyUrlFetch())
    const value = await runTool('zgit_clone', { repo: 'https://git.example.com/acme/tool@main', dir: 'gclone' })
    expect(value.sha).toBe('unknown')
    expect(value.shaResolved).toBe(false)
    expect('defaultBranch' in value).toBe(false)
  })

  it('zgit_diff succeeds without a path (singleFile absent), incl. generic hosts', async () => {
    setFetchImpl(fullGithub)
    const value = await runTool('zgit_diff', { repo: 'acme/tool', base: 'main', head: 'v1' })
    expect('singleFile' in value).toBe(false)
    expect(value.totalAdditions).toBe(1)

    setFetchImpl(anyUrlFetch())
    const generic = await runTool('zgit_diff', { repo: 'https://git.example.com/acme/tool', base: 'v1', head: 'v2' })
    expect('baseSha' in generic).toBe(false)
    expect('headSha' in generic).toBe(false)
    expect('singleFile' in generic).toBe(false)
  })

  it('zgit_fetch_release succeeds when downloading (listed absent)', async () => {
    setFetchImpl(async (url, init) => {
      if (String(url).includes('tool.zip')) {
        return new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
      }
      return fullGithub(url, init)
    })
    const value = await runTool('zgit_fetch_release', { repo: 'acme/tool', pattern: '*.zip' })
    expect('listed' in value).toBe(false)
    expect(value.assets).toHaveLength(1)
  })

  it('zgit_status succeeds for a checkout without a subdir (meta.subdir absent)', async () => {
    setFetchImpl(anyUrlFetch())
    await runTool('zgit_clone', { repo: 'https://git.example.com/acme/tool@main', dir: 'st' })
    setFetchImpl(fullGithub)
    const value = await runTool('zgit_status', { dir: 'st' })
    const meta = value.meta as Record<string, unknown>
    expect('subdir' in meta).toBe(false)
    expect('behindBy' in value).toBe(true) // null is lossless and must survive
  })

  it('zgit_download succeeds without a content-type header', async () => {
    setFetchImpl(async () => new Response(new Uint8Array([9, 9]), { status: 200 }))
    const value = await runTool('zgit_download', { url: 'https://mirror.example/tool.bin', path: 'bin/tool.bin' })
    expect('contentType' in value).toBe(false)
    expect(value.size).toBe(2)
  })

  it('zgit_log and zgit_ls_tree pass through the registry', async () => {
    setFetchImpl(fullGithub)
    const logValue = await runTool('zgit_log', { repo: 'acme/tool', count: 1 })
    expect(logValue.entries).toHaveLength(1)
    const remote = await runTool('zgit_ls_remote', { repo: 'acme/tool', ref: 'main' })
    expect(remote.resolvedSha).toBe('a'.repeat(40))
    expect(remote.latestReleaseTag).toBe('v1')
  })
})
