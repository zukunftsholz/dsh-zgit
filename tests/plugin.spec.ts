import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as zerogit from '../src/index.ts'
import { setFetchImpl } from '../src/http.ts'
import { buildTarGz } from './helpers/archives.ts'
import { makeGithubFetch } from './helpers/fixture.ts'

describe('dsh-zgit plugin', () => {
  it('exports a namespace-shaped module (name/inject/Config/apply)', () => {
    expect('default' in zerogit).toBe(false)
    expect(zerogit.name).toBe('dsh-zgit')
    expect(zerogit.inject).toEqual(['tools', 'systemPrompt'])
    expect(typeof zerogit.Config).toBe('function') // schemastery schemas are callable validators
    expect(typeof zerogit.apply).toBe('function')
  })

  it('registers all zgit tools into a real Cordis tools registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(zerogit, {})

    const names = ctx.tools.schemas().map(schema => schema.name)
    for (const expected of [
      'zgit_ls_remote', 'zgit_clone', 'zgit_fetch_release', 'zgit_show',
      'zgit_ls_tree', 'zgit_log', 'zgit_diff', 'zgit_status', 'zgit_download',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('honors tool toggles in config', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(zerogit, { clone: false, release: false, command: false })
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('zgit_clone')
    expect(names).not.toContain('zgit_fetch_release')
    expect(names).toContain('zgit_show')
  })

  it('registers the /zgit command when a commands service exists', async () => {
    const ctx = new Context()
    const registered: { name: string; description: string }[] = []
    ctx.provide('commands', {
      register: (definition: { name: string; description: string }) => {
        registered.push(definition)
        return () => undefined
      },
    })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(zerogit, {})
    expect(registered.map(command => command.name)).toContain('zgit')
  })

  it('skips the command when the registry is absent', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(zerogit, {})
    // Mounting with no commands service must not throw; tools still register.
    expect(ctx.tools.schemas().some(schema => schema.name === 'zgit_clone')).toBe(true)
  })

  it('rejects invalid config limits', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(zerogit, { timeoutMs: -5 })).rejects.toThrow(/positive integer/)
  })

  it('unloads cleanly, removing the tools', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(zerogit, {})
    expect(ctx.tools.schemas().some(schema => schema.name === 'zgit_clone')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'zgit_clone')).toBe(false)
  })

  it('writes into the CALLING session workspace through the registry, not the server cwd', async () => {
    const archive = buildTarGz([
      { path: 'tool-main/', kind: 'dir' },
      { path: 'tool-main/README.md', kind: 'file', content: '# tool\n' },
      { path: 'tool-main/src/', kind: 'dir' },
      { path: 'tool-main/src/index.js', kind: 'file', content: 'console.log(1)\n' },
    ])
    setFetchImpl(makeGithubFetch({ defaultBranch: 'main', archiveBytes: archive }))
    const sessionDir = await mkdtemp(join(tmpdir(), 'zgit-plugin-session-'))
    try {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(zerogit, {})

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('zgit-session-cwd'),
        name: 'zgit_clone',
        arguments: { repo: 'acme/tool' },
        agent: { session: { header: { id: 's1', cwd: sessionDir } } } as never,
      })
      expect(result.isError).toBe(false)
      const value = result.value as { targetDir?: string }
      // The fixture serves no commit API data, so the sha is unresolved and the
      // checkout is named after the ref — what matters here is WHERE it landed.
      expect(value.targetDir).toBe('tool@main')
      // The checkout exists inside the session workspace — the plugin must NOT
      // have fallen back to process.cwd() (the server launch dir).
      expect(await readFile(join(sessionDir, 'tool@main/src/index.js'), 'utf8')).toBe('console.log(1)\n')
    } finally {
      await rm(sessionDir, { recursive: true, force: true })
      setFetchImpl(globalThis.fetch.bind(globalThis) as typeof fetch)
    }
  })
})
