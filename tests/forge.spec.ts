import { describe, expect, it } from 'vitest'
import { archiveUrlFor, parseRepoSpec, rawUrlFor } from '../src/forge.ts'
import { matchGlob } from '../src/core.ts'
import { tokenize, parseFlags } from '../src/command.ts'

describe('parseRepoSpec', () => {
  it('parses bare owner/repo shorthand as GitHub', () => {
    expect(parseRepoSpec('deepseek-ai/deepseek-harness')).toEqual({
      kind: 'github', host: 'github.com', scheme: 'https', owner: 'deepseek-ai', repo: 'deepseek-harness', ref: undefined,
    })
  })

  it('parses owner/repo@ref', () => {
    expect(parseRepoSpec('octocat/Hello-World@v1.2.3')).toMatchObject({ owner: 'octocat', repo: 'Hello-World', ref: 'v1.2.3' })
  })

  it('parses full https URLs with .git suffix', () => {
    expect(parseRepoSpec('https://github.com/octocat/Hello-World.git')).toMatchObject({ kind: 'github', owner: 'octocat', repo: 'Hello-World', ref: undefined })
  })

  it('parses https URLs with @ref and /tree/ref', () => {
    expect(parseRepoSpec('https://github.com/octocat/Hello-World@main')).toMatchObject({ repo: 'Hello-World', ref: 'main' })
    expect(parseRepoSpec('https://github.com/octocat/Hello-World/tree/feature/x')).toMatchObject({ repo: 'Hello-World', ref: 'feature/x' })
  })

  it('parses scp-like git@ URLs', () => {
    expect(parseRepoSpec('git@github.com:octocat/Hello-World.git')).toMatchObject({ kind: 'github', owner: 'octocat', repo: 'Hello-World' })
  })

  it('parses ssh:// URLs with nested groups', () => {
    expect(parseRepoSpec('ssh://git@gitlab.com/group/sub/repo.git')).toMatchObject({ kind: 'gitlab', owner: 'group/sub', repo: 'repo' })
    expect(parseRepoSpec('https://gitlab.com/group/sub/repo')).toMatchObject({ kind: 'gitlab', owner: 'group/sub', repo: 'repo' })
  })

  it('detects gitlab and gitee hosts', () => {
    expect(parseRepoSpec('https://gitlab.com/gnome/gimp')).toMatchObject({ kind: 'gitlab', host: 'gitlab.com', owner: 'gnome', repo: 'gimp' })
    expect(parseRepoSpec('https://gitee.com/mirrors/redis')).toMatchObject({ kind: 'gitee', host: 'gitee.com', owner: 'mirrors', repo: 'redis' })
  })

  it('marks unknown hosts generic', () => {
    expect(parseRepoSpec('https://git.example.com/team/tool')).toMatchObject({ kind: 'generic', host: 'git.example.com', owner: 'team', repo: 'tool' })
  })

  it('rejects garbage', () => {
    expect(() => parseRepoSpec('')).toThrow()
    expect(() => parseRepoSpec('not-a-repo')).toThrow()
    expect(() => parseRepoSpec('https://github.com/only-owner')).toThrow()
  })
})

describe('URL builders', () => {
  it('builds codeload archive URLs per forge', () => {
    expect(archiveUrlFor(parseRepoSpec('octocat/Hello-World'), 'abc123')).toBe('https://codeload.github.com/octocat/Hello-World/tar.gz/abc123')
    expect(archiveUrlFor(parseRepoSpec('https://gitlab.com/gnome/gimp'), 'abc123')).toBe('https://gitlab.com/gnome/gimp/-/archive/abc123/gimp-abc123.tar.gz')
    expect(archiveUrlFor(parseRepoSpec('https://gitee.com/mirrors/redis'), 'abc123')).toBe('https://gitee.com/mirrors/redis/repository/archive/abc123.tar.gz')
  })

  it('builds raw URLs', () => {
    expect(rawUrlFor(parseRepoSpec('octocat/Hello-World'), 'src/main.c', 'main'))
      .toBe('https://raw.githubusercontent.com/octocat/Hello-World/main/src/main.c')
    expect(rawUrlFor(parseRepoSpec('https://gitee.com/mirrors/redis'), 'src/a b.c', 'main'))
      .toBe('https://gitee.com/mirrors/redis/raw/main/src/a%20b.c')
  })
})

describe('matchGlob', () => {
  it('matches * ? and ** patterns', () => {
    expect(matchGlob('*.zip', 'app-v1.zip')).toBe(true)
    expect(matchGlob('*.zip', 'app-v1.tar.gz')).toBe(false)
    expect(matchGlob('app-?.zip', 'app-1.zip')).toBe(true)
    expect(matchGlob('app-?.zip', 'app-12.zip')).toBe(false)
    expect(matchGlob('**/*.sha256', 'checksums/app.sha256')).toBe(true)
    expect(matchGlob('*.sha256', 'checksums/app.sha256')).toBe(false)
    expect(matchGlob('app-1.0.*', 'app-1.0.0.zip')).toBe(true)
  })
})

describe('command tokenizer', () => {
  it('splits tokens honoring quotes', () => {
    expect(tokenize('clone owner/repo "my dir" --replace')).toEqual(['clone', 'owner/repo', 'my dir', '--replace'])
    expect(tokenize('')).toEqual([])
  })

  it('parses flags and positionals', () => {
    expect(parseFlags(['clone', 'owner/repo', '--subdir', 'src', '--replace'])).toEqual({
      flags: { subdir: 'src', replace: true },
      positionals: ['clone', 'owner/repo'],
    })
  })
})
