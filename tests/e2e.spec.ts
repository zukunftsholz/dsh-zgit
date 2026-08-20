import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cloneSource, download, showFile } from '../src/core.ts'
import { setFetchImpl } from '../src/http.ts'
import type { ZerogitRuntime } from '../src/types.ts'
import { buildTarGz } from './helpers/archives.ts'

const tempDirs: string[] = []
afterEach(async () => {
  setFetchImpl(globalThis.fetch.bind(globalThis) as typeof fetch)
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function runtime(workspaceRoot: string): ZerogitRuntime {
  return {
    workspaceRoot,
    userAgent: 'zgit-e2e/0.0.0',
    timeoutMs: 15_000,
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

/** Start a minimal generic git-host server: /owner/repo/archive/<ref>.tar.gz + raw files. */
async function startFixtureServer(archive: Uint8Array): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const archiveMatch = /^\/acme\/tool\/archive\/([^/]+)\.tar\.gz$/.exec(url)
    if (archiveMatch !== null) {
      if (archiveMatch[1] !== 'main') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('unknown ref')
        return
      }
      res.writeHead(200, { 'content-type': 'application/gzip' })
      res.end(archive)
      return
    }
    const rawMatch = /^\/acme\/tool\/raw\/([^/]+)\/(.+)$/.exec(url)
    if (rawMatch !== null) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(rawMatch[2] === 'README.md' ? '# real http\n' : 'x')
      return
    }
    const bin = /^\/file\.bin$/.exec(url)
    if (bin !== null) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([1, 2, 3, 4]))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, port }
}

describe('end-to-end over real HTTP', () => {
  it('clones from a generic host, shows a raw file, and downloads a binary', async () => {
    const archive = buildTarGz([
      { path: 'tool-main/', kind: 'dir' },
      { path: 'tool-main/README.md', kind: 'file', content: '# t\n' },
      { path: 'tool-main/src/', kind: 'dir' },
      { path: 'tool-main/src/a.js', kind: 'file', content: 'a' },
    ])
    const { server, port } = await startFixtureServer(archive)
    try {
      const base = `http://127.0.0.1:${port}`
      const root = await mkdtemp(join(tmpdir(), 'zgit-e2e-'))
      tempDirs.push(root)
      const rt = runtime(root)

      const cloned = await cloneSource(rt, {
        repo: `${base}/acme/tool`,
        ref: 'main',
        archiveUrl: `${base}/acme/tool/archive/main.tar.gz`,
      })
      expect(cloned.forge).toBe('generic')
      expect(cloned.files).toBe(2)
      expect(await readFile(join(root, cloned.targetDir, 'README.md'), 'utf8')).toBe('# t\n')

      const shown = await showFile(rt, { repo: `${base}/acme/tool`, path: 'README.md', ref: 'main' })
      expect(shown.text).toBe('# real http\n')

      const downloaded = await download(rt, { url: `${base}/file.bin`, path: 'bin/file.bin' })
      expect(downloaded.size).toBe(4)
      expect(await readFile(join(root, 'bin/file.bin'))).toEqual(Buffer.from([1, 2, 3, 4]))
    } finally {
      server.close()
    }
  })

  it('fails loudly on a 404 archive', async () => {
    const { server, port } = await startFixtureServer(new Uint8Array(0))
    try {
      const root = await mkdtemp(join(tmpdir(), 'zgit-e2e-'))
      tempDirs.push(root)
      const rt = runtime(root)
      const base = `http://127.0.0.1:${port}`
      await expect(cloneSource(rt, {
        repo: `${base}/acme/tool`,
        ref: 'missing',
        archiveUrl: `${base}/acme/tool/archive/missing.tar.gz`,
      })).rejects.toThrow(/HTTP 404/)
    } finally {
      server.close()
    }
  })
})
